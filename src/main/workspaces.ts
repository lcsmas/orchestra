import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rm, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { store } from './store';
import {
  createWorktree,
  detectDefaultBranch,
  detectRemoteUrl,
  getCurrentBranch,
  isGitRepo,
  listBranches,
  listWorktreePaths,
  removeWorktree,
  renameWorktreeBranch,
  switchWorktreeBranch,
} from './git';
import { isRunning, stopPty, clearScrollback, startPty, writePty, readScrollback } from './pty';
import { buildScriptEnv, runOneShot, setupLogPath, archiveLogPath } from './scripts';
import { log } from './logger';
import type { CreateWorkspaceInput, RepoEntry, Workspace, WorkspaceStatus } from '../shared/types';

const ORCHESTRA_ROOT = path.join(os.homedir(), '.orchestra', 'worktrees');
// Scratch sessions live OUTSIDE the worktrees root so the orphan-pruner (which
// reconciles ORCHESTRA_ROOT against git's worktree registry) and the `du` size
// pass never touch them — neither is git-backed.
const SCRATCH_ROOT = path.join(os.homedir(), '.orchestra', 'scratch');

const execFileP = promisify(execFile);

/**
 * Apparent on-disk size of every workspace's worktree, keyed by workspace id
 * (bytes). Computed with a SINGLE `du` pass over the whole worktrees root —
 * `--max-depth=1` reports each immediate child dir, so one process + one warm
 * page cache covers all worktrees, versus spawning `du` per workspace.
 *
 * NOTE: `du` reports apparent size. On btrfs (the typical setup) worktrees
 * share `node_modules` via reflinked extents, so summing these does NOT equal
 * reclaimable space — most of it is shared. This is a "how big does this look"
 * number, not "how much you'd get back by deleting it".
 *
 * Off the hot stats poll by design: a cold pass over GiB-scale trees takes
 * seconds. Callers refresh on load and on a slow (30s) interval, not on the
 * 8s stats tick — warm-cache passes are cheap but a cold one is not.
 */
export async function getWorktreeSizes(): Promise<Record<string, number>> {
  let out = '';
  try {
    // `-s` conflicts with `--max-depth`, so list children with `-k` (KiB).
    ({ stdout: out } = await execFileP('du', ['-k', '--max-depth=1', ORCHESTRA_ROOT]));
  } catch (e) {
    // `du` exits non-zero if an entry vanishes mid-scan but still prints the
    // rest on stdout — salvage whatever it managed to emit.
    out = (e as { stdout?: string }).stdout ?? '';
  }
  // Parse "<KiB>\t<absolute path>" lines into a path → bytes map. The root's
  // own total line is present too but is simply never matched to a worktree.
  const byPath = new Map<string, number>();
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const kib = Number(line.slice(0, tab));
    if (!Number.isFinite(kib)) continue;
    byPath.set(line.slice(tab + 1), kib * 1024);
  }
  const sizes: Record<string, number> = {};
  for (const ws of store.workspaces) {
    const bytes = byPath.get(ws.worktreePath);
    if (bytes != null) sizes[ws.id] = bytes;
  }
  return sizes;
}

const ADJECTIVES = [
  'brave', 'calm', 'clever', 'cosmic', 'crimson', 'curious', 'daring', 'electric',
  'fuzzy', 'gentle', 'golden', 'happy', 'humble', 'jolly', 'lucky', 'lunar',
  'merry', 'nimble', 'noble', 'quiet', 'radiant', 'rapid', 'silent', 'silver',
  'solar', 'spicy', 'stellar', 'sunny', 'swift', 'tidy', 'vivid', 'witty',
];
const NOUNS = [
  'otter', 'falcon', 'badger', 'heron', 'fox', 'panda', 'koala', 'lynx',
  'raven', 'sparrow', 'orca', 'beetle', 'moth', 'cedar', 'maple', 'willow',
  'pine', 'aspen', 'ember', 'comet', 'nebula', 'quasar', 'river', 'canyon',
  'harbor', 'meadow', 'forest', 'valley', 'breeze', 'spark', 'horizon', 'summit',
];

function randomBranchName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

export async function ensureRoot() {
  if (!existsSync(ORCHESTRA_ROOT)) await mkdir(ORCHESTRA_ROOT, { recursive: true });
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  window: BrowserWindow,
): Promise<Workspace> {
  await ensureRoot();
  const id = randomUUID();
  const repoName = path.basename(input.repoPath);
  const repo = store.repos.find((r) => r.path === input.repoPath);
  const baseBranch = input.baseBranch || repo?.defaultBranch || 'main';
  const branch = randomBranchName();
  const agent = input.agent ?? 'claude';
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const worktreePath = path.join(ORCHESTRA_ROOT, `${repoName}-${safeBranch}-${id.slice(0, 8)}`);

  log.info(`creating workspace ${branch} (repo=${repoName} base=${baseBranch})`);
  await createWorktree(input.repoPath, branch, baseBranch, worktreePath);
  await installOrchestraHooks(worktreePath);

  // Allocate a port up-front so it survives setup-script failure (the worktree
  // stays around on failure; we want the same port across retries).
  const port = store.allocatePort();
  const setupScript = store.getRepoScripts(input.repoPath).setup;

  const ws: Workspace = {
    id,
    name: `${repoName} · ${branch}`,
    repoPath: input.repoPath,
    worktreePath,
    branch,
    baseBranch,
    createdAt: Date.now(),
    status: 'idle',
    agent,
    lastTask: input.task,
    branchManuallySet: false,
    port,
    setupStatus: setupScript ? 'pending' : 'ok',
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);

  // Fire setup script asynchronously — don't block the create call. Renderer
  // sees `setupStatus: 'pending'` immediately and watches workspace:update for
  // the running → ok/failed transition.
  if (setupScript) {
    void runSetupScript(id, window).catch((e) => {
      /* runSetupScript already persists `failed`; just leave a trace. */
      log.warn(`setup script failed for ${branch}`, e);
    });
  }

  // Do NOT spawn the agent PTY here. The renderer's TerminalView will invoke
  // `pty:start` once the terminal container has real dimensions, so the agent
  // is spawned at the correct cols/rows instead of a fixed default that would
  // mis-wrap its opening TUI frames. The `lastTask` stored on the workspace
  // is piped in from the pty:start handler on the first-ever spawn.
  return ws;
}

/**
 * Create a scratch session: a throwaway, non-git working directory under
 * `~/.orchestra/scratch` with Claude Code's hooks installed, ready to spawn an
 * agent in. There is no repo, branch, worktree, diff, merge, or PR — just a
 * plain directory the agent works in. Used when the user wants to start coding
 * something without first wiring up a git repo.
 *
 * Reuses the same infrastructure as a normal workspace from the PTY-spawn point
 * on (the renderer's `pty:start` doesn't care whether the cwd is a git worktree).
 * `repoPath`/`baseBranch` are deliberately empty. `branchManuallySet` starts
 * false so the agent gets the auto-rename nudge and relabels the session to
 * reflect the work — same as a git workspace, except the "rename" is a pure
 * display relabel (see `renameWorkspaceBranch`'s scratch branch) since there's
 * no git branch behind it.
 */
export async function createScratchWorkspace(window: BrowserWindow): Promise<Workspace> {
  if (!existsSync(SCRATCH_ROOT)) await mkdir(SCRATCH_ROOT, { recursive: true });
  const id = randomUUID();
  const label = randomBranchName();
  const worktreePath = path.join(SCRATCH_ROOT, `scratch-${label}-${id.slice(0, 8)}`);

  log.info(`creating scratch session ${label} (${id})`);
  await mkdir(worktreePath, { recursive: true });
  await installOrchestraHooks(worktreePath);

  const port = store.allocatePort();
  const ws: Workspace = {
    id,
    name: `scratch · ${label}`,
    kind: 'scratch',
    repoPath: '',
    worktreePath,
    branch: label,
    baseBranch: '',
    createdAt: Date.now(),
    status: 'idle',
    agent: 'claude',
    // Leave unlocked so ORCHESTRA_BRANCH_AUTO=1 and the rename nudge fires: the
    // agent relabels the scratch session once the work scope is clear, then the
    // /rename handler locks it (and drops the .branch-renamed sentinel).
    branchManuallySet: false,
    port,
    // No repo → no setup script can be configured, so a scratch session is
    // never "pending" setup.
    setupStatus: 'ok',
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);
  return ws;
}

export async function archiveWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  log.info(`archiving workspace ${ws.branch} (${id})`);
  // Soft archive: stop the agent but keep the workspace record (flagged
  // archived), the worktree, and the scrollback log. The sidebar hides
  // archived workspaces from the main list and surfaces them under a
  // dedicated Archived section where they can be restored or hard-deleted.
  stopPty(id);
  stopPty(`${id}:run`);
  stopPty(`${id}:nvim`);
  const updated: Workspace = {
    ...ws,
    archived: true,
    archivedAt: Date.now(),
    status: 'stopped',
  };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
}

export async function unarchiveWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  const updated: Workspace = {
    ...ws,
    archived: false,
    archivedAt: undefined,
    status: 'idle',
  };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
}

export async function deleteWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  log.info(`deleting workspace ${ws.branch} (${id}) worktree=${ws.worktreePath}`);
  // Hard delete: stop agent, run user's archive script (best-effort), remove
  // the git worktree from disk, drop the scrollback log, and remove the store
  // record. Archive script runs BEFORE worktree removal so it can still see
  // the files / cwd.
  stopPty(id);
  stopPty(`${id}:run`);
  stopPty(`${id}:nvim`);

  // Scratch sessions are a plain directory with no git worktree and no repo
  // (hence no archive script). Tear the directory down directly — confined to
  // SCRATCH_ROOT so a corrupt path can't `rm` outside our own dir — and drop the
  // record. The git-worktree path below would no-op anyway (removeWorktree on a
  // non-worktree throws and is swallowed), but this also skips the dead archive-
  // script lookup and makes the intent explicit.
  if (ws.kind === 'scratch') {
    clearScrollback(id);
    await clearInbox(id);
    if (ws.worktreePath.startsWith(SCRATCH_ROOT + path.sep) && existsSync(ws.worktreePath)) {
      try {
        await rm(ws.worktreePath, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    await store.removeWorkspace(id);
    window.webContents.send('workspace:removed', id);
    return;
  }

  const archiveScript = store.getRepoScripts(ws.repoPath).archive;
  if (archiveScript && existsSync(ws.worktreePath)) {
    try {
      await runOneShot({
        script: archiveScript,
        cwd: ws.worktreePath,
        env: buildScriptEnv(ws),
        logFile: archiveLogPath(id),
      });
    } catch {
      /* best-effort — never block deletion */
    }
  }

  clearScrollback(id);
  await clearInbox(id);
  try {
    await removeWorktree(ws.repoPath, ws.worktreePath);
  } catch {
    /* best-effort */
  }
  await store.removeWorkspace(id);
  window.webContents.send('workspace:removed', id);
}

/** Reconcile the store against git's worktree registry and drop any workspace
 *  whose worktree was deleted out-of-band — `git worktree remove`, a manual
 *  `rm`, or a post-merge cleanup. Each orchestra workspace owns exactly one
 *  git worktree; once git no longer tracks that path the workspace is dead:
 *  its terminal, diff, and merge views all operate on a directory that is no
 *  longer a working tree, so the row just lingers showing a ~12 KB husk (the
 *  injected `.claude`/`.orchestra` dirs survive `git worktree remove`) with no
 *  working actions. We remove those records on startup so they stop showing.
 *
 *  False-positive guards:
 *   - Skip a repo entirely if its `repoPath` is missing or its worktree list
 *     can't be read. A temporarily-unmounted drive must never nuke records.
 *   - Husk cleanup is confined to paths under ORCHESTRA_ROOT, so even a
 *     corrupt `worktreePath` can't trigger an `rm` outside our own dir. */
export async function pruneOrphanedWorkspaces(window: BrowserWindow): Promise<void> {
  // Read each repo's worktree list once, not per workspace.
  const byRepo = new Map<string, Workspace[]>();
  for (const ws of store.workspaces) {
    const list = byRepo.get(ws.repoPath) ?? [];
    list.push(ws);
    byRepo.set(ws.repoPath, list);
  }

  for (const [repoPath, list] of byRepo) {
    if (!existsSync(repoPath)) continue; // repo gone/unmounted — can't verify
    let tracked: Set<string>;
    try {
      tracked = new Set(await listWorktreePaths(repoPath));
    } catch {
      continue; // unreadable — skip the whole repo to be safe
    }

    for (const ws of list) {
      if (tracked.has(ws.worktreePath)) continue; // still a live worktree

      // Orphaned: git no longer tracks this worktree. Tear the record down.
      stopPty(ws.id);
      stopPty(`${ws.id}:run`);
      stopPty(`${ws.id}:nvim`);
      clearScrollback(ws.id);

      // Remove the leftover husk (gitignored .claude/.orchestra survive a
      // `git worktree remove`). Hard-confined to ORCHESTRA_ROOT.
      if (
        ws.worktreePath.startsWith(ORCHESTRA_ROOT + path.sep) &&
        existsSync(ws.worktreePath)
      ) {
        try {
          await rm(ws.worktreePath, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }

      await store.removeWorkspace(ws.id);
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('workspace:removed', ws.id);
      }
    }
  }
}

/** Run (or re-run) the repo's setup script for a workspace. Persists
 * `setupStatus` transitions through `running` → `ok`|`failed` so the UI can
 * show progress. Safe to call when no setup script is configured (no-op). */
export async function runSetupScript(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  const script = store.getRepoScripts(ws.repoPath).setup;
  if (!script) {
    if (ws.setupStatus !== 'ok') {
      const updated: Workspace = { ...ws, setupStatus: 'ok', setupError: undefined };
      await store.upsertWorkspace(updated);
      window.webContents.send('workspace:update', updated);
    }
    return;
  }
  if (!existsSync(ws.worktreePath)) return;

  const running: Workspace = { ...ws, setupStatus: 'running', setupError: undefined };
  await store.upsertWorkspace(running);
  window.webContents.send('workspace:update', running);

  const result = await runOneShot({
    script,
    cwd: ws.worktreePath,
    env: buildScriptEnv(ws),
    logFile: setupLogPath(id),
  });

  // Re-read in case other state mutated mid-run (rare — setup runs early in a
  // workspace's life — but `branchManuallySet` etc. could land in between).
  const fresh = store.getWorkspace(id);
  if (!fresh) return;
  const done: Workspace = {
    ...fresh,
    setupStatus: result.exitCode === 0 ? 'ok' : 'failed',
    setupError:
      result.exitCode === 0
        ? undefined
        : result.lastStderrLine || `exit ${result.exitCode}`,
  };
  await store.upsertWorkspace(done);
  window.webContents.send('workspace:update', done);
}

/** Re-allocate a port for an existing workspace that doesn't have one yet
 * (legacy workspaces created before scripts existed). Idempotent. */
export async function ensureWorkspacePort(
  id: string,
  window: BrowserWindow,
): Promise<Workspace | undefined> {
  const ws = store.getWorkspace(id);
  if (!ws || typeof ws.port === 'number') return ws;
  const updated: Workspace = { ...ws, port: store.allocatePort() };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
  return updated;
}

// ---------- Branch rename ----------

/** Rename the branch on a workspace. The worktree dir stays put and the
 * agent keeps running — `git branch -m` is purely a ref rename, so HEAD,
 * CWD, and open files are unaffected. The agent's TUI banner may show a
 * stale branch name until it next repaints, but that's cosmetic.
 * `manual` is true when the rename came from a user action (typing in the
 * UI) or from the agent itself; both lock the branch via `branchManuallySet`
 * so the auto-rename instruction stops firing on subsequent sessions. */
export async function renameWorkspaceBranch(
  id: string,
  rawNewBranch: string,
  opts: { manual: boolean },
  window: BrowserWindow,
): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  const newBranch = sanitizeBranchName(rawNewBranch);
  if (!newBranch) throw new Error('invalid branch name');
  // A scratch session has no git branch — its "branch" is just a display label.
  // Relabel it in place (no `git branch -m`, no name collisions to dodge). A
  // manual relabel (UI edit or the agent's auto-rename call) locks the branch
  // via branchManuallySet, same as a git workspace, so the rename nudge stops
  // firing on the next pty spawn.
  if (ws.kind === 'scratch') {
    if (newBranch === ws.branch) {
      if (opts.manual && !ws.branchManuallySet) {
        const locked = { ...ws, branchManuallySet: true };
        await store.upsertWorkspace(locked);
        window.webContents.send('workspace:update', locked);
        return locked;
      }
      return ws;
    }
    const updated: Workspace = {
      ...ws,
      branch: newBranch,
      name: `scratch · ${newBranch}`,
      branchManuallySet: opts.manual || ws.branchManuallySet,
    };
    await store.upsertWorkspace(updated);
    window.webContents.send('workspace:update', updated);
    return updated;
  }
  // The stored branch can drift from the worktree's real HEAD — renamed out of
  // band, or a background-spawned workspace the stats-poll reconciler hasn't
  // visited yet. `git branch -m <old> <new>` fails outright when <old> no
  // longer exists, so rename FROM the live branch and fall back to the stored
  // name only when HEAD is detached/unreadable.
  const liveBranch = (await getCurrentBranch(ws.worktreePath)) || ws.branch;
  if (newBranch === liveBranch) {
    if (opts.manual && !ws.branchManuallySet) {
      const updated = { ...ws, branch: liveBranch, branchManuallySet: true };
      await store.upsertWorkspace(updated);
      window.webContents.send('workspace:update', updated);
      return updated;
    }
    return ws;
  }
  const repoName = path.basename(ws.repoPath);
  await renameWorktreeBranch(ws.worktreePath, liveBranch, newBranch);

  const updated: Workspace = {
    ...ws,
    branch: newBranch,
    name: `${repoName} · ${newBranch}`,
    branchManuallySet: opts.manual || ws.branchManuallySet,
  };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
  return updated;
}

export interface RenameResult {
  ok: boolean;
  branch?: string;
  error?: string;
}

/** Handle a rename request coming from the agent via the hooks-server socket.
 * Locks the branch after a successful rename so the SessionStart instruction
 * stops firing (one rename per workspace lifetime). Returns a structured
 * result so the agent's socket call can tell success from refusal — the old
 * always-`{}` reply left agents guessing and falling back to `git branch -m`. */
export async function dispatchRenameRequest(
  id: string,
  rawNewBranch: string,
  window: BrowserWindow,
): Promise<RenameResult> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return { ok: false, error: 'unknown workspace' };
  if (ws.branchManuallySet) return { ok: false, error: 'branch already set manually' };
  try {
    // A scratch session has no branch namespace to dedupe against, so skip the
    // freeBranchName collision pass and relabel straight through. renameWork-
    // spaceBranch locks branchManuallySet; we also drop a sentinel so the
    // in-session rename nudge self-disables before the next pty restart.
    if (ws.kind === 'scratch') {
      const target = sanitizeBranchName(rawNewBranch);
      if (!target) return { ok: false, error: 'invalid branch name' };
      const updated = await renameWorkspaceBranch(id, target, { manual: true }, window);
      await markBranchRenamed(ws.worktreePath);
      return { ok: true, branch: updated.branch };
    }
    // Suffix against the live branch (not the possibly-stale stored name) so a
    // name that collides with an existing branch still lands, and so a request
    // matching the worktree's real current branch is treated as a no-op rather
    // than getting needlessly suffixed.
    const live = (await getCurrentBranch(ws.worktreePath)) || ws.branch;
    const target = await freeBranchName(ws.repoPath, sanitizeBranchName(rawNewBranch), live);
    if (!target) return { ok: false, error: 'invalid branch name' };
    const updated = await renameWorkspaceBranch(id, target, { manual: true }, window);
    return { ok: true, branch: updated.branch };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'rename failed' };
  }
}

/** Drop a sentinel in the scratch worktree so the rename-instruction hook
 * stops nudging mid-session (it has no git branch to diff against the original
 * auto name). Best-effort: a write failure just means one more harmless nudge. */
async function markBranchRenamed(worktreePath: string): Promise<void> {
  try {
    await writeFile(path.join(worktreePath, '.orchestra', '.branch-renamed'), '');
  } catch {
    /* best-effort */
  }
}

// Default geometry for an agent PTY spawned headless (no visible terminal yet).
// The renderer re-fits to the real pane size the first time the user opens the
// workspace; until then the agent just needs a sane width to render its TUI.
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 32;

/** Spawn a freshly-created workspace's agent straight from the main process,
 * without waiting for the renderer's TerminalView to become visible. The
 * renderer only kicks `pty:start` once a pane has real dimensions, so a
 * workspace created in the background would otherwise sit idle until clicked.
 * The agent-driven /spawn flow wants the delegated worktree working *now*, so
 * we start it here and inject its task.
 *
 * Safe against the renderer's later `pty:start`: that handler early-returns on
 * `isRunning(id)` (just resizing to the real geometry), so there's no
 * double-spawn. We also flip `hasInput` after injecting the task so that if the
 * agent's process later exits and the user reopens the pane, the renderer
 * resumes with `--continue` instead of re-injecting the task into a fresh run. */
async function startWorkspaceAgentHeadless(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || isRunning(id)) return;
  const extraEnv: Record<string, string> = {
    ORCHESTRA_BRANCH: ws.branch,
    ORCHESTRA_BRANCH_AUTO: ws.branchManuallySet ? '0' : '1',
  };
  await startPty({
    id,
    cwd: ws.worktreePath,
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    cols: HEADLESS_COLS,
    rows: HEADLESS_ROWS,
    window,
    workspaceId: id,
    extraEnv,
  });
  if (!ws.lastTask) return;
  const task = ws.lastTask;
  // Mirror the renderer-spawn timing: give the TUI a moment to initialize
  // before typing the opening prompt, or the first keystrokes get eaten.
  setTimeout(() => {
    // Type the prompt, then send a carriage return as a SEPARATE keystroke a
    // beat later — same trick the renderer uses (App.tsx). A trailing newline
    // written in the same chunk is treated by Claude's TUI as a pasted newline,
    // so the task lands in the input box but is never submitted.
    writePty(id, task);
    setTimeout(() => writePty(id, '\r'), 80);
    const fresh = store.getWorkspace(id);
    if (fresh && !fresh.hasInput) {
      const updated: Workspace = { ...fresh, hasInput: true };
      void store.upsertWorkspace(updated).then(() => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('workspace:update', updated);
        }
      });
    }
  }, 1200);
}

export interface SpawnResult {
  ok: boolean;
  id?: string;
  branch?: string;
  error?: string;
}

/** Handle a spawn request from an agent via the hooks-server socket: create a
 * brand-new worktree+workspace and hand its agent an opening instruction, then
 * start it headless so it works autonomously. `from` is the caller's
 * workspace id (its ORCHESTRA_WS_ID) — when no explicit `repoPath` is given we
 * inherit the caller's repo. An explicit `repoPath` must be a repo orchestra
 * already knows about; an unknown path is refused. Returns a structured result
 * so the spawning agent learns the new workspace id/branch (or why it failed)
 * instead of an opaque `{}`. */
export async function dispatchSpawnRequest(
  input: {
    from?: string;
    repoPath?: string;
    baseBranch?: string;
    task: string;
    agent?: 'claude';
  },
  window: BrowserWindow,
): Promise<SpawnResult> {
  const task = input.task.trim();
  if (!task) return { ok: false, error: 'empty task' };
  let repoPath = input.repoPath?.trim() || undefined;
  if (repoPath) {
    // Only repos the user has already added — never let an agent point a new
    // worktree at an arbitrary filesystem path.
    if (!store.repos.some((r) => r.path === repoPath)) return { ok: false, error: 'unknown repoPath' };
  } else if (input.from) {
    repoPath = store.getWorkspace(input.from)?.repoPath;
  }
  if (!repoPath) return { ok: false, error: 'no repo: pass repoPath or call from a workspace' };
  try {
    const ws = await createWorkspace(
      { repoPath, baseBranch: input.baseBranch, task, agent: input.agent },
      window,
    );
    await startWorkspaceAgentHeadless(ws.id, window);
    return { ok: true, id: ws.id, branch: ws.branch };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'spawn failed' };
  }
}

// ---------- Add repo ----------
//
// Adding a repo can come from two places: the renderer (IPC `repos:add`) or an
// agent/CLI over the unix socket (`/addRepo`). Both funnel through
// `addRepoByPath` so the validation, persistence, and — crucially — the
// `repos:update` broadcast happen identically. Repos historically had no live
// push event (the renderer only re-fetched right after it added one itself), so
// a socket-side add would not have shown up until restart; the broadcast closes
// that gap for every code path.

export interface AddRepoResult {
  ok: boolean;
  repo?: RepoEntry;
  error?: string;
}

/** Validate, persist, and register a git repo by absolute path, then broadcast
 * the refreshed repo list to the renderer so the UI updates immediately.
 * Idempotent: re-adding an existing path returns the existing entry. */
export async function addRepoByPath(absPath: string, window: BrowserWindow): Promise<RepoEntry> {
  if (!(await isGitRepo(absPath))) throw new Error(`${absPath} is not a git repo`);
  const defaultBranch = await detectDefaultBranch(absPath);
  const remoteUrl = await detectRemoteUrl(absPath).catch(() => undefined);
  const repo = await store.addRepo({
    path: absPath,
    name: path.basename(absPath),
    defaultBranch,
    remoteUrl,
  });
  // Push the full list so the renderer can replace its state wholesale — same
  // shape as `repos:list`, so no merge logic is needed on the other side.
  window.webContents.send('repos:update', store.repos);
  return repo;
}

/** Socket entry point for `/addRepo`. Mirrors `dispatchSpawnRequest`: never
 * throws, always answers with an `{ ok }` envelope the caller can branch on. */
export async function dispatchAddRepoRequest(
  input: { path?: string },
  window: BrowserWindow,
): Promise<AddRepoResult> {
  const raw = input.path?.trim();
  if (!raw) return { ok: false, error: 'missing path' };
  if (!path.isAbsolute(raw)) return { ok: false, error: 'path must be absolute' };
  try {
    const repo = await addRepoByPath(raw, window);
    return { ok: true, repo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'add repo failed' };
  }
}

// ---------- Delete workspace ----------

export interface DeleteWorkspaceResult {
  ok: boolean;
  id?: string;
  branch?: string;
  error?: string;
}

/** Socket entry point for `/deleteWorkspace`. Hard-deletes a workspace the same
 * way the renderer's `workspaces:delete` IPC does — stop the agent, run the
 * archive script, remove the git worktree, drop the store record, and emit
 * `workspace:removed` so the UI updates live. Never throws; answers `{ ok }`.
 * Unknown ids fail loudly here (rather than silently no-op like
 * `deleteWorkspace`) so a CLI caller gets feedback on a bad id. */
export async function dispatchDeleteWorkspaceRequest(
  input: { id?: string },
  window: BrowserWindow,
): Promise<DeleteWorkspaceResult> {
  const id = input.id?.trim();
  if (!id) return { ok: false, error: 'missing id' };
  const ws = store.getWorkspace(id);
  if (!ws) return { ok: false, error: `unknown workspace: ${id}` };
  try {
    const branch = ws.branch;
    await deleteWorkspace(id, window);
    return { ok: true, id, branch };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'delete failed' };
  }
}

// ---------- Inter-agent communication ----------
//
// Agents already reach the main process over the same unix socket they use for
// /spawn and /rename. These three routes let a running agent (a) discover the
// other live agents, (b) read a peer's terminal transcript, and (c) hand a peer
// a prompt. Delivery of a message is "live" when the target PTY is running (we
// type it straight into the peer's Claude TUI, exactly like the spawn task
// injection) and falls back to a durable per-workspace inbox file otherwise,
// which the peer drains into context on its next SessionStart.

const INBOX_ROOT = path.join(os.homedir(), '.orchestra', 'inbox');

function inboxPathFor(id: string): string {
  return path.join(INBOX_ROOT, `${id}.txt`);
}

// Strip ANSI/VT escape sequences (CSI, OSC, single-char escapes) so a peer
// reading another agent's scrollback gets plain text instead of raw terminal
// control bytes. Deliberately broad — a read is informational, not byte-exact.
// Built from \u001b/\u009b string escapes so no raw control bytes live in source.
const ANSI_RE = new RegExp(
  // OSC: ESC ] ... terminated by BEL or ST (ESC \\)
  '[\\u001b\\u009b]\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)' +
    // CSI and other escape sequences
    '|[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><]',
  'g',
);

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '');
}

export interface PeerInfo {
  id: string;
  branch: string;
  repo: string;
  status: WorkspaceStatus;
  running: boolean;
  lastTask?: string;
}

export interface PeersResult {
  ok: boolean;
  peers?: PeerInfo[];
  error?: string;
}

/** List the other live workspaces so an agent can discover who to talk to.
 * Excludes the caller (`from`) and any archived workspace. */
export function dispatchPeersRequest(input: { from?: string }): PeersResult {
  const peers: PeerInfo[] = store.workspaces
    .filter((w) => !w.archived && w.id !== input.from)
    .map((w) => ({
      id: w.id,
      branch: w.branch,
      repo: path.basename(w.repoPath),
      status: w.status,
      running: isRunning(w.id),
      lastTask: w.lastTask ? w.lastTask.slice(0, 200) : undefined,
    }));
  return { ok: true, peers };
}

export interface ReadResult {
  ok: boolean;
  branch?: string;
  transcript?: string;
  error?: string;
}

// Cap how much of a peer's transcript a single read returns. The scrollback log
// is itself capped at 2 MB; we tail the last N lines after stripping ANSI.
const READ_DEFAULT_LINES = 80;
const READ_MAX_LINES = 400;

/** Return the tail of a peer agent's terminal transcript, ANSI-stripped. */
export function dispatchReadRequest(input: { id: string; lines?: number }): ReadResult {
  const ws = store.getWorkspace(input.id);
  if (!ws || ws.archived) return { ok: false, error: 'unknown workspace' };
  const want = Math.max(1, Math.min(input.lines ?? READ_DEFAULT_LINES, READ_MAX_LINES));
  const cleaned = stripAnsi(readScrollback(input.id));
  // Drop trailing blank lines (TUI repaints leave a tail of them) so `lines`
  // counts real content, then tail the last N and collapse blank runs.
  const lines = cleaned.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const tail = lines.slice(-want).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: true, branch: ws.branch, transcript: tail };
}

export interface MessageResult {
  ok: boolean;
  // 'live' — target was running, typed straight into its TUI.
  // 'started' — target was stopped, we woke it and handed it the message.
  // 'inbox' — fallback when waking failed; drained on the target's next session.
  delivery?: 'live' | 'started' | 'inbox';
  branch?: string;
  error?: string;
}

const MESSAGE_MAX_CHARS = 8000;

function formatPeerMessage(fromBranch: string, fromId: string, text: string): string {
  return `[message from agent '${fromBranch}' (${fromId})]\n${text}\n\nReply via the orchestra socket: curl -s --unix-socket "$ORCHESTRA_SOCK" --data-binary '{"from":"'$ORCHESTRA_WS_ID'","to":"${fromId}","text":"<reply>"}' http://x/message`;
}

/** Wake a stopped agent and hand it `prompt` as a live turn. Resumes the prior
 * conversation with `--continue` when the workspace has run before (mirrors the
 * renderer's resume path) so the woken agent keeps its context; otherwise it
 * starts fresh and the prompt becomes its opening turn. Safe against the
 * renderer's later `pty:start`, which early-returns on `isRunning`. Returns
 * false when the agent can't be woken (missing / archived / already running) so
 * the caller can fall back. Throws only if the PTY spawn itself fails. */
async function wakeAgentWithPrompt(
  id: string,
  prompt: string,
  window: BrowserWindow,
): Promise<boolean> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || isRunning(id)) return false;
  const resuming = ws.hasInput === true;
  await startPty({
    id,
    cwd: ws.worktreePath,
    command: 'claude',
    args: resuming
      ? ['--continue', '--dangerously-skip-permissions']
      : ['--dangerously-skip-permissions'],
    cols: HEADLESS_COLS,
    rows: HEADLESS_ROWS,
    window,
    workspaceId: id,
    extraEnv: { ORCHESTRA_BRANCH: ws.branch, ORCHESTRA_BRANCH_AUTO: ws.branchManuallySet ? '0' : '1' },
  });
  // Give the TUI a beat to initialize, then type the message and submit it as a
  // SEPARATE carriage return — identical timing to the spawn/headless task
  // inject (a trailing newline in the same chunk reads as a pasted line).
  const task = prompt;
  setTimeout(() => {
    writePty(id, task);
    setTimeout(() => writePty(id, '\r'), 80);
  }, 1500);
  if (!ws.hasInput) {
    const updated: Workspace = { ...ws, hasInput: true };
    void store.upsertWorkspace(updated).then(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('workspace:update', updated);
      }
    });
  }
  return true;
}

/** Deliver a prompt from one agent to another. If the target's PTY is running
 * the message is typed straight into its Claude TUI (live). If the target is
 * stopped we WAKE it — start its agent (resuming prior context) and hand it the
 * message as a live turn — so a delegated peer acts on the message right away.
 * Only if waking fails do we fall back to the durable inbox file, which the
 * target drains into context on its next SessionStart. */
export async function dispatchMessageRequest(
  input: {
    from?: string;
    to: string;
    text: string;
  },
  window: BrowserWindow,
): Promise<MessageResult> {
  const text = input.text.trim().slice(0, MESSAGE_MAX_CHARS);
  if (!text) return { ok: false, error: 'empty text' };
  const target = store.getWorkspace(input.to);
  if (!target || target.archived) return { ok: false, error: 'unknown target workspace' };
  if (input.to === input.from) return { ok: false, error: 'cannot message yourself' };

  const fromWs = input.from ? store.getWorkspace(input.from) : undefined;
  const fromBranch = fromWs?.branch ?? 'external';
  const fromId = input.from ?? 'external';
  // Normalize newlines: a bare \r submits Claude's TUI prematurely, so keep
  // only \n inside the body and let the explicit carriage return below submit.
  const body = formatPeerMessage(fromBranch, fromId, text).replace(/\r/g, '');

  if (isRunning(input.to)) {
    // Type the message, then a SEPARATE carriage return a beat later — same
    // trick startWorkspaceAgentHeadless uses so the TUI submits it as one turn
    // instead of treating the trailing newline as a pasted line.
    writePty(input.to, body);
    setTimeout(() => writePty(input.to, '\r'), 80);
    return { ok: true, delivery: 'live', branch: target.branch };
  }

  // Target stopped — wake it and deliver the message as its next turn.
  try {
    if (await wakeAgentWithPrompt(input.to, body, window)) {
      // Insurance: if the woken agent exits almost immediately (e.g. a resume
      // with --continue that finds no session and bails), the live inject was
      // lost. Park it so the next successful start still delivers it. A healthy
      // woken agent keeps running, so this is a no-op in the normal case.
      const to = input.to;
      setTimeout(() => {
        if (!isRunning(to)) void queueInbox(to, body);
      }, 5000);
      return { ok: true, delivery: 'started', branch: target.branch };
    }
  } catch (e) {
    log.warn(`wake-on-message failed for ${input.to}`, e);
  }

  // Couldn't even start the agent — park the message. The inbox hook prints +
  // clears this file the next time the target agent starts a session.
  if (await queueInbox(input.to, body)) {
    return { ok: true, delivery: 'inbox', branch: target.branch };
  }
  return { ok: false, error: 'inbox write failed' };
}

/** Append a formatted message block to a workspace's inbox file. Returns false
 * on write failure. The inbox SessionStart/UserPromptSubmit hook prints + clears
 * this file on the target's next session. */
async function queueInbox(id: string, body: string): Promise<boolean> {
  try {
    await mkdir(INBOX_ROOT, { recursive: true });
    const block = `\n========================================\n${body}\n========================================\n`;
    await appendFile(inboxPathFor(id), block, 'utf8');
    return true;
  } catch (e) {
    log.warn(`inbox write failed for ${id}`, e);
    return false;
  }
}

/** Remove a workspace's queued inbox on hard delete so a recycled id can't
 * inherit stale messages. Best-effort. */
async function clearInbox(id: string): Promise<void> {
  try {
    await rm(inboxPathFor(id), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Return a branch name not already taken in the repo. `desired` is returned
 * as-is when free (or when it equals the workspace's own current branch, which
 * is a no-op rather than a collision); otherwise a numeric suffix is appended
 * (-2, -3, …). Empty string if `desired` is empty or no slot is found. */
async function freeBranchName(repoPath: string, desired: string, current: string): Promise<string> {
  if (!desired) return '';
  const existing = new Set(await listBranches(repoPath));
  existing.delete(current);
  if (!existing.has(desired)) return desired;
  for (let n = 2; n < 100; n++) {
    const candidate = `${desired}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return '';
}

function sanitizeBranchName(raw: string): string {
  // Keep the same allow-list used when creating worktree paths.
  return raw.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._/-]/g, '').slice(0, 80);
}

/** Switch the workspace to an existing branch. The worktree dir stays put —
 * branch is just a property. On success, stops any running agent/nvim so they
 * respawn against the new branch's files (any in-memory state from the old
 * branch would be stale), then emits `pty:restart`. */
export async function switchWorkspaceBranch(
  id: string,
  branch: string,
  window: BrowserWindow,
): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.branch === branch) return ws;

  // Run the git switch FIRST, while the agent/nvim PTYs are still alive. If it
  // fails — e.g. the branch is already checked out in another worktree, or the
  // working tree would be clobbered — we throw without tearing anything down,
  // so the live session keeps running and the BranchPicker surfaces the error.
  // Stopping the PTYs before a switch that might fail leaves the pane attached
  // to a dead process with no restart, which silently bricks terminal input.
  await switchWorktreeBranch(ws.worktreePath, branch);

  // Switch landed — now recycle the PTYs so they respawn against the new branch.
  const nvimId = `${id}:nvim`;
  const restartAgent = isRunning(id);
  const restartNvim = isRunning(nvimId);
  stopPty(id);
  stopPty(nvimId);
  clearScrollback(id);

  const repoName = path.basename(ws.repoPath);
  const updated: Workspace = {
    ...ws,
    branch,
    name: `${repoName} · ${branch}`,
    hasInput: false,
    // The user explicitly chose this branch — never auto-rename it, even if
    // the workspace was still in its initial "awaiting first prompt" state.
    branchManuallySet: true,
  };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
  if (restartAgent) window.webContents.send('pty:restart', id);
  if (restartNvim) window.webContents.send('pty:restart', nvimId);
  return updated;
}

// ---------- Per-workspace Claude Code hooks ----------
//
// Two responsibilities live in the same `<worktree>/.claude/settings.local.json`:
//
// 1. Agent-driven branch rename. A SessionStart hook injects an instruction
//    telling the agent to rename the branch via the orchestra socket once it
//    understands the work. The hook gates on `ORCHESTRA_BRANCH_AUTO=1`, which
//    main only sets when `branchManuallySet === false` — so the instruction
//    stops appearing after the first successful rename (or after the user
//    types a name in the UI).
//
// 2. Activity tracking. UserPromptSubmit + Stop + Notification + PreToolUse +
//    PostToolUse hooks each append one JSON line to a durable per-workspace
//    spool file (via `.orchestra/orchestra-hook.sh`) that orchestra tails, so
//    workspace status flips running ↔ waiting from Claude's own lifecycle
//    events. A local append is atomic and never blocks, which is why this
//    replaced the old `curl --max-time 1` socket POST that silently dropped
//    events whenever orchestra's event loop was busy. The helper self-gates on
//    $ORCHESTRA_WS_ID so it's a no-op when claude is run outside orchestra.
//

// All five activity hooks delegate to the same installed helper, passing the
// event name as $1. The `-f` guard + `|| true` make a genuinely-missing script
// (claude run outside a worktree orchestra manages) a silent no-op rather than
// a hook error, mirroring the rename/spawn hooks.
function activityHookCmd(event: string): string {
  return (
    'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/orchestra-hook.sh"; ' +
    `[ -f "$f" ] && bash "$f" ${event} || true`
  );
}

const HOOK_ACTIVITY_SUBMIT_CMD = activityHookCmd('submit');
const HOOK_ACTIVITY_STOP_CMD = activityHookCmd('stop');
const HOOK_ACTIVITY_NOTIFY_CMD = activityHookCmd('notify');
const HOOK_ACTIVITY_PRETOOL_CMD = activityHookCmd('pretool');
const HOOK_ACTIVITY_POSTTOOL_CMD = activityHookCmd('posttool');

// SessionStart hook delegates to a small shell script we drop into the
// worktree. Inlining the multi-line instruction in a single JSON-encoded
// hook command requires brutal quote-escaping, and a script file is far
// easier to read and modify. Resolved against $ORCHESTRA_WORKTREE (the
// absolute worktree root, set on the pty env) rather than a relative path, so
// it still works after the agent `cd`s into a subdirectory — the relative form
// raised "No such file or directory" on every prompt once cwd left the root.
// The -f guard + `|| true` make a genuinely-missing script a silent no-op
// instead of a hook error.
const HOOK_SESSION_START_RENAME_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/rename-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

// Same delegation pattern as the rename hook (script file, resolved via the
// absolute worktree root). Advertises the agent-spawn capability once per
// session.
const HOOK_SESSION_START_SPAWN_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/spawn-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

// Advertises the inter-agent comms capability (peers/read/message) once per
// session, same delegation pattern as the spawn hook.
const HOOK_SESSION_START_COMMS_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/comms-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

// Advertises the add-repo / delete-workspace socket routes once per session,
// same delegation pattern as the spawn/comms hooks.
const HOOK_SESSION_START_REPO_ROUTES_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/repo-routes-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

// Peer-gated comms reminder, fired on every UserPromptSubmit (the script
// self-silences when no sibling agents exist), so the comms capability is never
// missed once a peer actually shows up — not just at the context-free start.
const HOOK_COMMS_RESURFACE_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/comms-resurface.sh"; [ -f "$f" ] && bash "$f" || true';

// Condensed spawn reminder, fired on every UserPromptSubmit. Spawning is
// relevant even with zero peers (it's how you create them), so unlike the
// comms re-surface this is ungated — but it prints a single line, not the full
// curl block (that's shown at SessionStart), to keep the per-turn cost minimal
// while ensuring the capability is never forgotten mid-conversation.
const HOOK_SPAWN_RESURFACE_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/spawn-resurface.sh"; [ -f "$f" ] && bash "$f" || true';

// Drains any queued peer messages into context. Runs on SessionStart AND every
// UserPromptSubmit so a message that landed in the inbox while the agent was
// between turns surfaces promptly (the script self-clears the file once read).
const HOOK_INBOX_DELIVER_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/inbox-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

const RENAME_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Prints the rename instruction into the agent's
# session context while the workspace is still on its auto-generated branch.
# Runs on SessionStart AND on every UserPromptSubmit, so the nudge re-surfaces
# the moment the work scope is clear — not just once at startup before any
# context exists (the original SessionStart-only fire was routinely missed:
# the agent is told to defer until it understands the work, but by then no
# further SessionStart event re-shows the note). The instruction now pushes for
# renaming from the very first substantive prompt rather than deferring.
# Gated on ORCHESTRA_BRANCH_AUTO=1 (orchestra only sets it while the branch
# has not been renamed by the user or agent) AND a live check that the current
# git branch still equals the original auto name — so it self-disables the
# instant a rename lands, even before the next pty restart clears the env.
[ "\${ORCHESTRA_BRANCH_AUTO:-0}" = "1" ] || exit 0
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
# Self-disable the instant a rename lands, even before the next pty restart
# clears ORCHESTRA_BRANCH_AUTO. For a real git worktree the live branch no
# longer matches the original auto name; for a scratch session (no git) the
# /rename handler drops a sentinel file instead, since there's no branch to
# diff. Either signal stops the nudge mid-session.
[ -f "\${ORCHESTRA_WORKTREE:-.}/.orchestra/.branch-renamed" ] && exit 0
current="\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "\$current" ] && [ "\$current" != "\${ORCHESTRA_BRANCH:-}" ] && exit 0
cat <<EOF
[orchestra] This workspace is on the auto-generated branch '\${ORCHESTRA_BRANCH:-unknown}'. Rename the branch as soon as the work this conversation is about becomes clear — including on the very first prompt. Only defer if the prompt is purely exploratory with no identifiable task yet. Run this exact command (do NOT use 'git branch -m'):

  curl -s --max-time 5 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"id\\\\":\\\\"\\\$ORCHESTRA_WS_ID\\\\",\\\\"branch\\\\":\\\\"<new-branch-name>\\\\"}" http://x/rename

The reply is JSON: {"ok":true,"branch":"<final-name>"} on success (orchestra renames the real git branch for you — do NOT also run 'git branch -m'), or {"ok":false,"error":"..."} if it refused. Pick a short kebab-case name (3-6 words) that reflects the actual work, e.g. fix-checkout-typo, add-stripe-webhook-retry, route-demande-accessoire. Don't wait for a later turn — name it the moment you can.
EOF
`;

// Advertised to every Claude session on SessionStart (ungated, unlike the
// rename nudge — spawning is a standing capability, not a one-time chore). The
// heredoc is unquoted so the curl line prints with literal `$ORCHESTRA_SOCK`/
// `$ORCHESTRA_WS_ID` for the agent to run as-is; the same `\$` / `\\"`
// escaping as the rename script keeps the JSON intact through the heredoc. The
// $ORCHESTRA_SOCK guard makes it a no-op outside orchestra.
const SPAWN_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Tells the agent it can spin up a fresh parallel
# worktree (new branch off the base branch) with its own autonomous agent.
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
cat <<EOF
[orchestra] You can delegate independent work to a NEW parallel worktree that gets its own agent. The new agent starts immediately and works on its own in a fresh branch cut from the base branch — so use this only for work that does NOT depend on your current uncommitted changes (the new worktree will not see them). Run this exact command:

  curl -s --max-time 20 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"from\\\\":\\\\"\\\$ORCHESTRA_WS_ID\\\\",\\\\"task\\\\":\\\\"<full self-contained instructions for the new agent>\\\\"}" http://x/spawn

The reply is JSON: {"ok":true,"id":"<workspace-id>","branch":"<branch>"} once the new worktree exists and its agent has started, or {"ok":false,"error":"..."} on failure. The "task" is the new agent's opening prompt — write it as a complete, standalone instruction (it shares none of this conversation's context). By default the worktree is created in THIS repo off its base branch. Optional JSON fields: "repoPath":"<abs path of another repo already added to orchestra>", "baseBranch":"<branch>". Only spawn when the user asks you to parallelize or delegate work — do not do it unprompted.
EOF
`;

// Advertised on SessionStart (ungated like the spawn hook — talking to peers is
// a standing capability). Tells the agent how to list other live agents, read a
// peer's transcript, and hand a peer a prompt. Same `\$` / `\\"` escaping as the
// spawn script so the curl lines print with literal $ORCHESTRA_SOCK /
// $ORCHESTRA_WS_ID for the agent to run as-is.
const COMMS_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Tells the agent it can talk to the OTHER agents
# running in sibling workspaces — discover them, read their work, prompt them.
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
cat <<EOF
[orchestra] You can communicate with the OTHER agents running in sibling workspaces. Three commands, all over the orchestra socket:

  1. List the other agents (their workspace id, branch, repo, status):
       curl -s --max-time 10 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"from\\\\":\\\\"\\\$ORCHESTRA_WS_ID\\\\"}" http://x/peers
     Reply: {"ok":true,"peers":[{"id":"...","branch":"...","repo":"...","status":"running|waiting|idle","running":true}]}

  2. Read a peer's recent terminal transcript (to see what it has been doing):
       curl -s --max-time 10 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"from\\\\":\\\\"\\\$ORCHESTRA_WS_ID\\\\",\\\\"id\\\\":\\\\"<peer-id>\\\\"}" http://x/read
     Reply: {"ok":true,"branch":"...","transcript":"<last ~80 lines, plain text>"}. Optional "lines":<n> (max 400).

  3. Send a prompt to a peer (it lands as a new turn in that agent's session):
       curl -s --max-time 10 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"from\\\\":\\\\"\\\$ORCHESTRA_WS_ID\\\\",\\\\"to\\\\":\\\\"<peer-id>\\\\",\\\\"text\\\\":\\\\"<your message>\\\\"}" http://x/message
     Reply: {"ok":true,"delivery":"live"} if the peer was running, or "started" if the peer was stopped and got woken to handle it now. The peer sees who the message is from and can reply back to your workspace id.

Use these to coordinate: ask a peer a question, hand off a sub-result, or check on delegated work. Keep messages self-contained — the peer does not share your conversation. Only do this when the user asks you to coordinate agents, or when you spawned a peer and need to follow up with it.
EOF
`;

// Advertised on SessionStart (ungated like spawn/comms — managing repos and
// workspaces is a standing capability). Tells the agent it can register a new
// repo with orchestra (which makes it spawnable via repoPath) and hard-delete a
// workspace. Same `\$` / `\\"` escaping as the spawn/comms scripts so the curl
// lines print with literal $ORCHESTRA_SOCK / $ORCHESTRA_WS_ID for the agent.
const REPO_ROUTES_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Tells the agent it can add a repo to orchestra
# and delete a workspace, over the same socket as spawn/peers.
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
cat <<EOF
[orchestra] You can also manage repos and workspaces over the orchestra socket:

  1. Register a git repo with orchestra (so it appears in the app and can be a spawn target). Pass an ABSOLUTE path:
       curl -s --max-time 10 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"path\\\\":\\\\"<absolute repo path>\\\\"}" http://x/addRepo
     Reply: {"ok":true,"repo":{"path":"...","name":"...","defaultBranch":"..."}} — the app's repo list refreshes live. {"ok":false,"error":"..."} if the path isn't an absolute git repo.

  2. Delete a workspace (stops its agent, runs its archive script, removes the git worktree + branch, drops it from the app):
       curl -s --max-time 15 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"id\\\\":\\\\"<workspace-id>\\\\"}" http://x/deleteWorkspace
     Reply: {"ok":true,"id":"...","branch":"..."} or {"ok":false,"error":"unknown workspace: <id>"}. Destructive and irreversible — only do this when the user explicitly asks to delete a workspace.

(Outside an orchestra workspace, the same actions are available as 'orchestra add-repo <path>' and 'orchestra delete <id> --yes' once the app has been launched once.)
EOF
`;

// Peer-gated re-surface of the comms capability, fired on every
// UserPromptSubmit. The full COMMS_INSTRUCTION_SCRIPT prints once at
// SessionStart (before any work context exists, so it's routinely forgotten by
// the time a sibling actually matters). This variant instead stays SILENT while
// the agent is alone and re-surfaces a condensed reminder the moment a sibling
// agent exists — so the capability lands in context exactly when it's relevant,
// without spamming solo sessions. It live-queries /peers and counts the peer
// entries with pure bash (no jq) — a query failure or empty list is a no-op.
const COMMS_RESURFACE_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Re-surfaces the inter-agent comms reminder on
# each prompt, but ONLY when sibling agents currently exist.
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
[ -n "\${ORCHESTRA_WS_ID:-}" ] || exit 0
resp="\$(curl -s --max-time 5 --unix-socket "\$ORCHESTRA_SOCK" --data-binary "{\\"from\\":\\"\$ORCHESTRA_WS_ID\\"}" http://x/peers 2>/dev/null)"
# Count peer objects by their "id" keys; bash-only, no jq dependency. Strip up
# to the "peers": key (NOT including the "[", which is a glob metachar in some
# shells' pattern expansion); the "id"-key count below is unaffected by it.
rest="\${resp#*\\"peers\\":}"
[ "\$rest" = "\$resp" ] && exit 0
n=0
tmp="\$rest"
while [ "\$tmp" != "\${tmp#*\\"id\\":}" ]; do
  n=\$((n + 1))
  tmp="\${tmp#*\\"id\\":}"
done
[ "\$n" -gt 0 ] || exit 0
cat <<EOF
[orchestra] \$n other agent(s) are running in sibling workspaces right now. You can coordinate with them over the orchestra socket: list them (http://x/peers), read a peer's transcript (http://x/read), or send a peer a prompt (http://x/message). The full command reference was printed at session start. Use this when the user asks you to coordinate agents, or to follow up on work you delegated.
EOF
exit 0
`;

// Condensed spawn reminder for every UserPromptSubmit. The full spawn reference
// (with the curl payload) prints once at SessionStart; this just keeps the
// capability top-of-mind on later turns with a single line, so a delegation
// opportunity that arises mid-conversation isn't missed. Ungated (spawning is
// useful even with no peers yet), but deliberately terse to stay cheap.
const SPAWN_RESURFACE_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. One-line spawn-capability reminder per prompt.
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
echo "[orchestra] Reminder: you can delegate independent work to a fresh parallel worktree+agent via http://x/spawn (full command shown at session start). Use it when the user asks you to parallelize or delegate."
exit 0
`;

// Drains queued peer messages into the agent's context, then clears them. The
// main process writes pre-formatted message blocks (which already name the
// sender and show the reply curl) into this file; the hook just prints and
// removes it. Self-gated on \$ORCHESTRA_WS_ID so it's a no-op outside orchestra,
// and on a non-empty file so it adds nothing when there's no mail.
const INBOX_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Delivers messages other agents sent to this one
# while it was not running. Reads + clears \$HOME/.orchestra/inbox/<wsid>.txt.
[ -n "\${ORCHESTRA_WS_ID:-}" ] || exit 0
f="\${HOME}/.orchestra/inbox/\${ORCHESTRA_WS_ID}.txt"
[ -s "\$f" ] || exit 0
echo "[orchestra] You have message(s) from other agents:"
cat "\$f"
rm -f "\$f"
exit 0
`;

// Durable activity-event writer, dropped into every managed worktree and
// invoked by the five activity hooks. Appends one JSON line per event to the
// per-workspace spool file orchestra tails (events-spool.ts). A local append
// is atomic and sub-millisecond — it can't be dropped the way the old
// `curl --max-time 1` POST was, and it never blocks the agent on orchestra.
// For pre/posttool it mines the active tool name out of the hook's stdin JSON
// using pure bash parameter expansion (no jq/sed backrefs to keep it portable
// and dependency-free); a parse miss just yields an empty tool, never an error.
const ORCHESTRA_HOOK_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Do not edit — rewritten on every workspace start.
dir="\${ORCHESTRA_EVENTS_DIR:-\$HOME/.orchestra/events}"
[ -n "\${ORCHESTRA_WS_ID:-}" ] || exit 0
event="\${1:-}"
[ -n "\$event" ] || exit 0

tool=""
case "\$event" in
  pretool|posttool)
    payload="\$(cat)"
    case "\$payload" in
      *'"tool_name"'*)
        rest="\${payload#*'"tool_name"'}"
        rest="\${rest#*:}"
        rest="\${rest#*'"'}"
        tool="\${rest%%'"'*}"
        ;;
    esac
    ;;
esac

mkdir -p "\$dir" 2>/dev/null || true
printf '{"event":"%s","tool":"%s"}\\n' "\$event" "\$tool" >> "\$dir/\$ORCHESTRA_WS_ID.jsonl"
exit 0
`;

function upsertHookCommand(list: unknown[], command: string): void {
  const present = list.some((entry) => {
    const inner = (entry as { hooks?: Array<{ command?: string }> })?.hooks ?? [];
    return inner.some((h) => h?.command === command);
  });
  if (!present) list.push({ hooks: [{ type: 'command', command }] });
}

/** Drop any hook entry whose command matches the predicate. Used to evict
 * legacy hook commands installed by older orchestra versions. */
function removeHookCommand(list: unknown[], match: (cmd: string) => boolean): unknown[] {
  return list.filter((entry) => {
    const inner = (entry as { hooks?: Array<{ command?: string }> })?.hooks ?? [];
    return !inner.some((h) => typeof h?.command === 'string' && match(h.command));
  });
}

/** Spawn the Claude agent PTY for a workspace. Shared by the renderer-driven
 *  `pty:start` IPC handler and the startup resume path so both build the same
 *  env, install hooks, and pick `--continue` identically. Caller is responsible
 *  for the already-running guard (`isRunning(id)`) — this just spawns.
 *
 *  `resuming` gates `claude --continue`: only true once the user has actually
 *  submitted at least one prompt (`ws.hasInput`), since `--continue` fails with
 *  "No conversation found to continue" against a session that only ever printed
 *  its startup TUI. */
export async function startAgentPty(
  ws: Workspace,
  cols: number,
  rows: number,
  window: BrowserWindow,
): Promise<void> {
  const resuming = ws.hasInput === true;
  const claudeArgs = resuming
    ? ['--continue', '--dangerously-skip-permissions']
    : ['--dangerously-skip-permissions'];
  // Idempotent: upgrades workspaces created before the activity hook landed.
  await installOrchestraHooks(ws.worktreePath);
  // Expose the current branch and auto-rename gate to hooks. The SessionStart
  // hook reads ORCHESTRA_BRANCH_AUTO=1 to decide whether to inject the
  // rename-instruction context — flipping `branchManuallySet` true (after a
  // user or agent rename) clears the env on the next pty:start, so the
  // instruction stops appearing.
  const extraEnv: Record<string, string> = {
    ORCHESTRA_BRANCH: ws.branch,
    ORCHESTRA_BRANCH_AUTO: ws.branchManuallySet ? '0' : '1',
  };
  await startPty({
    id: ws.id,
    cwd: ws.worktreePath,
    command: 'claude',
    args: claudeArgs,
    cols,
    rows,
    window,
    workspaceId: ws.id,
    extraEnv,
  });
}

// Default PTY size for an agent resumed at startup, before any xterm has
// mounted to measure real dimensions. The renderer re-fits (ptyResize) the
// moment the user opens the tab, so this only governs how Claude's TUI wraps
// while it runs unseen — 80×24 is the universal terminal fallback.
const RESUME_COLS = 80;
const RESUME_ROWS = 24;

/** Relaunch the agent for every workspace that was `running` when Orchestra
 *  last exited. Brings the conversation back live (`claude --continue`) so work
 *  resumes after a restart instead of the workspace sitting idle until the user
 *  re-opens it. Each PTY is spawned headlessly — output streams to the durable
 *  on-disk log and a buffer exactly as it does for a backgrounded tab, and the
 *  renderer reconnects (the `isRunning` branch in `pty:start`) when the user
 *  later opens it. Status is driven by the resumed agent's real hook events, so
 *  a workspace that comes back waiting-for-input correctly shows `waiting`, not
 *  a fake `running`. Best-effort and per-workspace isolated: a worktree that
 *  vanished or a spawn that throws is logged and skipped, never fatal. */
export async function resumeRunningWorkspaces(window: BrowserWindow): Promise<void> {
  const ids = store.takeResumeCandidates();
  for (const id of ids) {
    const ws = store.getWorkspace(id);
    if (!ws || ws.archived) continue;
    if (isRunning(id)) continue; // already live (shouldn't happen this early)
    if (!existsSync(ws.worktreePath)) {
      log.warn(`resume skipped: worktree missing id=${id} path=${ws.worktreePath}`);
      continue;
    }
    try {
      await startAgentPty(ws, RESUME_COLS, RESUME_ROWS, window);
      log.info(`resumed agent id=${id} branch=${ws.branch}`);
    } catch (e) {
      log.warn(`resume failed id=${id}`, e);
    }
  }
}

export async function installOrchestraHooks(
  worktreePath: string,
): Promise<void> {
  try {
    const dir = path.join(worktreePath, '.orchestra');
    await mkdir(dir, { recursive: true });
    const gitignore = path.join(dir, '.gitignore');
    if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');

    // Idempotent: rewrite the script every install so updates to the
    // instruction text propagate to existing workspaces on next pty:start.
    const renameScript = path.join(dir, 'rename-instruction.sh');
    await writeFile(renameScript, RENAME_INSTRUCTION_SCRIPT);
    try {
      await chmod(renameScript, 0o755);
    } catch {
      /* best-effort */
    }

    const spawnScript = path.join(dir, 'spawn-instruction.sh');
    await writeFile(spawnScript, SPAWN_INSTRUCTION_SCRIPT);
    try {
      await chmod(spawnScript, 0o755);
    } catch {
      /* best-effort */
    }

    const hookScript = path.join(dir, 'orchestra-hook.sh');
    await writeFile(hookScript, ORCHESTRA_HOOK_SCRIPT);
    try {
      await chmod(hookScript, 0o755);
    } catch {
      /* best-effort */
    }

    const commsScript = path.join(dir, 'comms-instruction.sh');
    await writeFile(commsScript, COMMS_INSTRUCTION_SCRIPT);
    try {
      await chmod(commsScript, 0o755);
    } catch {
      /* best-effort */
    }

    const repoRoutesScript = path.join(dir, 'repo-routes-instruction.sh');
    await writeFile(repoRoutesScript, REPO_ROUTES_INSTRUCTION_SCRIPT);
    try {
      await chmod(repoRoutesScript, 0o755);
    } catch {
      /* best-effort */
    }

    const commsResurfaceScript = path.join(dir, 'comms-resurface.sh');
    await writeFile(commsResurfaceScript, COMMS_RESURFACE_SCRIPT);
    try {
      await chmod(commsResurfaceScript, 0o755);
    } catch {
      /* best-effort */
    }

    const spawnResurfaceScript = path.join(dir, 'spawn-resurface.sh');
    await writeFile(spawnResurfaceScript, SPAWN_RESURFACE_SCRIPT);
    try {
      await chmod(spawnResurfaceScript, 0o755);
    } catch {
      /* best-effort */
    }

    const inboxScript = path.join(dir, 'inbox-instruction.sh');
    await writeFile(inboxScript, INBOX_INSTRUCTION_SCRIPT);
    try {
      await chmod(inboxScript, 0o755);
    } catch {
      /* best-effort */
    }

    const settingsDir = path.join(worktreePath, '.claude');
    await mkdir(settingsDir, { recursive: true });
    const settingsFile = path.join(settingsDir, 'settings.local.json');
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsFile)) {
      try {
        settings = JSON.parse(await readFile(settingsFile, 'utf8'));
      } catch {
        settings = {};
      }
    }
    const hooks = ((settings.hooks as Record<string, unknown>) ??= {});

    // Pre-upgrade workspaces carry the old relative rename command
    // (`bash .orchestra/rename-instruction.sh`), which errored once the agent
    // cd'd out of the worktree root. Evict it (any rename command lacking the
    // new $ORCHESTRA_WORKTREE resolution) before re-upserting the fixed one, or
    // both would run and the stale one would keep erroring.
    const isStaleRenameCmd = (cmd: string) =>
      cmd.includes('.orchestra/rename-instruction.sh') && !cmd.includes('ORCHESTRA_WORKTREE');

    // Evict the legacy `curl … http://x/event` activity POSTs from any
    // pre-upgrade workspace — they're superseded by the durable spool helper,
    // and leaving both wired would double-report every event.
    const isLegacyActivityCurl = (cmd: string) => cmd.includes('http://x/event');

    // Evict the legacy first-prompt.json writer from any pre-upgrade workspace
    // so prompts no longer get dumped to disk after this hook system landed.
    let submitList = ((hooks.UserPromptSubmit as unknown[]) ??= []);
    submitList = removeHookCommand(submitList, (cmd) => cmd.includes('.orchestra/first-prompt.json'));
    submitList = removeHookCommand(submitList, isStaleRenameCmd);
    submitList = removeHookCommand(submitList, isLegacyActivityCurl);
    upsertHookCommand(submitList, HOOK_ACTIVITY_SUBMIT_CMD);
    // Re-surface the branch-rename nudge on every prompt while still on the
    // auto branch (the script self-gates), so the agent gets reminded once the
    // work scope is clear — not only at the context-free SessionStart.
    upsertHookCommand(submitList, HOOK_SESSION_START_RENAME_CMD);
    // Re-surface the spawn + comms capabilities each turn so they're never
    // missed mid-conversation: spawn is a terse always-on reminder, comms
    // self-silences unless a sibling agent currently exists.
    upsertHookCommand(submitList, HOOK_SPAWN_RESURFACE_CMD);
    upsertHookCommand(submitList, HOOK_COMMS_RESURFACE_CMD);
    // Surface any queued peer messages right before the agent's next turn.
    upsertHookCommand(submitList, HOOK_INBOX_DELIVER_CMD);
    hooks.UserPromptSubmit = submitList;

    let stopList = ((hooks.Stop as unknown[]) ??= []);
    stopList = removeHookCommand(stopList, isLegacyActivityCurl);
    upsertHookCommand(stopList, HOOK_ACTIVITY_STOP_CMD);
    hooks.Stop = stopList;

    // Claude's Notification hook fires when the agent needs the user's
    // attention — most commonly the 60s-idle "waiting for your input"
    // reminder, occasionally a tool-permission prompt (rare with
    // --dangerously-skip-permissions but possible). Drives a louder OS
    // notification than the gentle Stop chime.
    let notifyList = ((hooks.Notification as unknown[]) ??= []);
    notifyList = removeHookCommand(notifyList, isLegacyActivityCurl);
    upsertHookCommand(notifyList, HOOK_ACTIVITY_NOTIFY_CMD);
    hooks.Notification = notifyList;

    // Per-tool granularity: PreToolUse surfaces which tool the agent is about
    // to run (Bash, Edit, …) and PostToolUse clears it. Status stays `running`
    // throughout — these only drive the ephemeral active-tool label.
    const preToolList = ((hooks.PreToolUse as unknown[]) ??= []);
    upsertHookCommand(preToolList, HOOK_ACTIVITY_PRETOOL_CMD);
    hooks.PreToolUse = preToolList;

    const postToolList = ((hooks.PostToolUse as unknown[]) ??= []);
    upsertHookCommand(postToolList, HOOK_ACTIVITY_POSTTOOL_CMD);
    hooks.PostToolUse = postToolList;

    let sessionStartList = ((hooks.SessionStart as unknown[]) ??= []);
    sessionStartList = removeHookCommand(sessionStartList, isStaleRenameCmd);
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_RENAME_CMD);
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_SPAWN_CMD);
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_COMMS_CMD);
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_REPO_ROUTES_CMD);
    upsertHookCommand(sessionStartList, HOOK_INBOX_DELIVER_CMD);
    hooks.SessionStart = sessionStartList;

    settings.hooks = hooks;
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  } catch {
    /* best-effort */
  }
}
