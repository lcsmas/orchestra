import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, appendFile, readdir, stat, open, rename, copyFile } from 'node:fs/promises';
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
import { expandConfigDir, planAccountMigration } from '../shared/accounts';
import { syncAccountInheritance } from './account-inherit';
import { refreshAccountsNow } from './account-usage';
import { buildScriptEnv, runOneShot, setupLogPath, archiveLogPath } from './scripts';
import { log } from './logger';
import { forgetWorkspaceProbes } from './activity';
import type { CreateWorkspaceInput, RepoEntry, Workspace, WorkspaceStatus } from '../shared/types';
import { isScratchLike, SANDBOX_WORKSPACE_DIR } from '../shared/types';

const ORCHESTRA_ROOT = path.join(os.homedir(), '.orchestra', 'worktrees');
// Scratch sessions live OUTSIDE the worktrees root so the orphan-pruner (which
// reconciles ORCHESTRA_ROOT against git's worktree registry) and the `du` size
// pass never touch them — neither is git-backed.
const SCRATCH_ROOT = path.join(os.homedir(), '.orchestra', 'scratch');

const execFileP = promisify(execFile);

/** Resolve the extra environment variables an agent PTY should get for a
 * workspace, from its source repo. The repo's assigned account
 * (`repo.accountId`) supplies a `CLAUDE_CONFIG_DIR`, injected so the spawned
 * `claude` logs in as that account (Claude Code reads & refreshes the OAuth
 * token in that dir). A missing/empty/dangling account, or a dir whose
 * template expands to nothing, injects nothing — the agent falls back to
 * Orchestra's default login.
 *
 * Returns `{}` when the repo has no account. */
function resolveRepoAgentEnv(ws: Workspace): Record<string, string> {
  const repo = store.repos.find((r) => r.path === ws.repoPath);
  const configDir = workspaceAccountConfigDir(ws, repo);
  return configDir ? { CLAUDE_CONFIG_DIR: configDir } : {};
}

/** The expanded `CLAUDE_CONFIG_DIR` for the account a workspace logs in as, or
 * '' when there is none (→ Orchestra's default login). Driven SOLELY by the
 * workspace's PINNED `accountId` (snapshotted at creation), never the repo's
 * current account: Claude Code keeps a workspace's conversation inside the dir
 * it was born in, so reassigning the repo's account must not redirect an
 * existing workspace to a different dir (that yields "No conversation found to
 * continue"). A workspace created before pinning has no `accountId`, so it
 * correctly resolves to '' → the default `~/.claude`, which is exactly where
 * its conversation already lives. Pure path expansion — no secret involved.
 * Exported for the sandbox import (it packs this dir's login/config into the
 * payload so the container agent runs as the same account). */
export function workspaceAccountConfigDir(ws: Workspace, _repo: RepoEntry | undefined): string {
  if (!ws.accountId) return '';
  const account = store.accounts.find((a) => a.id === ws.accountId);
  if (!account) return '';
  return expandConfigDir(account.configDir, os.homedir(), process.env);
}

/** Token count at/above which a `claude --continue` resume is treated as
 * "heavy" — i.e. Claude Code will show its compaction menu and a typed task
 * could blow past it into a full-context resume. Set below CC's own ~140k
 * trigger so we never miss a session that will prompt. Env-overridable for
 * tuning without a rebuild. */
const HEAVY_RESUME_TOKEN_THRESHOLD = (() => {
  const n = Number(process.env.ORCHESTRA_HEAVY_RESUME_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();

/** Claude Code stores each conversation under
 * `<configDir>/projects/<mangled-cwd>/<sessionId>.jsonl`, where the cwd is
 * mangled by replacing every non-alphanumeric character with '-'. */
function mangleProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Token count of the session that `claude --continue` will resume for this
 * workspace, or `null` if it can't be determined (→ caller treats as non-heavy
 * and does nothing — fail OPEN, never block a normal resume).
 *
 * `--continue` resumes the most-recently-modified transcript `.jsonl` in the
 * workspace's project dir (under its PINNED account config dir, NOT always
 * `~/.claude`). The count is the last assistant message's usage; trailing
 * `system`/summary lines can follow it, so we scan backwards. Files reach 10MB+,
 * so we tail-read the last chunk rather than loading the whole file. */
async function newestResumeTokenCount(ws: Workspace): Promise<number | null> {
  try {
    const base = workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
    const dir = path.join(base, 'projects', mangleProjectDir(ws.worktreePath));
    let entries: string[];
    try {
      entries = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null; // no project dir yet (fresh) → not heavy
    }
    if (entries.length === 0) return null;
    // newest by mtime = what `--continue` resumes
    let newest: { file: string; mtime: number } | null = null;
    for (const f of entries) {
      try {
        const s = await stat(path.join(dir, f));
        if (!newest || s.mtimeMs > newest.mtime) newest = { file: f, mtime: s.mtimeMs };
      } catch {
        /* skip unreadable */
      }
    }
    if (!newest) return null;
    const fp = path.join(dir, newest.file);
    const fh = await open(fp, 'r');
    try {
      const { size } = await fh.stat();
      // Read up to the last 512KB — enough to contain the final assistant turn
      // in any normal transcript without loading a multi-MB file.
      const chunk = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(chunk);
      await fh.read(buf, 0, chunk, size - chunk);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line || line[0] !== '{') continue;
        let e: unknown;
        try {
          e = JSON.parse(line);
        } catch {
          continue; // a partial first line from the chunk boundary
        }
        const obj = e as { type?: string; message?: { usage?: Record<string, number> } };
        const u = obj?.message?.usage;
        if (obj?.type === 'assistant' && u) {
          return (
            (u.input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0)
          );
        }
      }
      return null; // final assistant turn not in the tail → fail open
    } finally {
      await fh.close();
    }
  } catch (err) {
    log.warn(`heavy-resume detection failed for ${ws.id}`, err);
    return null; // fail open
  }
}

/** Absolute path of the readiness sentinel for a workspace's agent. Orchestra
 * passes this path to the spawned `claude` as $ORCHESTRA_READY_FILE; a
 * SessionStart hook (HOOK_SESSION_START_READY_CMD) touches it the instant the
 * TUI is live. The injector waits for this file to appear before typing the
 * opening prompt, replacing a fragile fixed delay that dropped the submit
 * keystroke on concurrent spawns (two TUIs booting at once, one timer firing
 * before its input was ready). Keyed by workspace id, which is unique and
 * known on both sides without needing claude's own --session-id. */
function readyFilePath(workspaceId: string): string {
  return path.join(os.tmpdir(), `orchestra-ready-${workspaceId}`);
}

/** Poll for the readiness sentinel up to `timeoutMs`. Resolves true once the
 * file exists (TUI is up and accepting keystrokes), false on timeout so the
 * caller can fall back to the old fixed delay rather than hang forever. The
 * sentinel is removed before the agent starts (see startPty call sites), so a
 * stale file from a prior run can't short-circuit the wait. */
async function waitForAgentReady(readyFile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

/** Remove a workspace's readiness sentinel — best-effort. Called before start
 * (clear any stale file) and after the prompt is submitted (tidy up). */
async function clearReadyFile(workspaceId: string): Promise<void> {
  try {
    await rm(readyFilePath(workspaceId), { force: true });
  } catch {
    /* best-effort */
  }
}

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
// In-flight `du` scan, if any. A cold pass takes seconds; without this guard a
// burst of size refreshes (e.g. many workspaces added/removed in quick
// succession) could stack several overlapping full-tree scans, each thrashing
// the disk and starving everything else. Concurrent callers share one scan.
let sizesInFlight: Promise<Record<string, number>> | null = null;

export function getWorktreeSizes(): Promise<Record<string, number>> {
  if (sizesInFlight) return sizesInFlight;
  sizesInFlight = computeWorktreeSizes().finally(() => {
    sizesInFlight = null;
  });
  return sizesInFlight;
}

async function computeWorktreeSizes(): Promise<Record<string, number>> {
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
    // Pin the repo's currently-assigned account at creation. The agent's
    // conversation will live in that account's CLAUDE_CONFIG_DIR, so the
    // workspace must keep using it even if the repo's account changes later.
    ...(store.repos.find((r) => r.path === input.repoPath)?.accountId
      ? { accountId: store.repos.find((r) => r.path === input.repoPath)!.accountId }
      : {}),
    // Record the spawning orchestrator only when it still exists — a stale id
    // would render a child orphaned under a phantom parent in the sidebar.
    ...(input.parentId && store.getWorkspace(input.parentId)
      ? { parentId: input.parentId }
      : {}),
    port,
    setupStatus: setupScript ? 'pending' : 'ok',
    // Persist where the agent runs. Absent input → local (field left unset, the
    // default everywhere). Only a sandbox host is recorded explicitly.
    ...(input.host && input.host.kind !== 'local' ? { host: input.host } : {}),
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);
  // Push the workspace→account map right away — otherwise the new workspace's
  // account badge and usage bars read "default" until the next 30s poll tick,
  // even though the pin above is already in place.
  void refreshAccountsNow(window).catch(() => {});

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
/** Standing brief for an orchestrator session, injected on first launch as a
 * `--append-system-prompt` (silently — never a typed user turn, so the prompt
 * box stays clean). It frames the agent's job as delegation — every workspace
 * it spawns over the `/spawn` socket records this session as its `parentId`, so
 * the children nest under it in the sidebar. Kept short on purpose: the
 * spawn/peers/message command reference is already injected by the
 * session-start hooks. */
const ORCHESTRATOR_BRIEF =
  "You are an orchestrator. Your job is to coordinate work across other agents rather than edit code yourself. " +
  "Break the user's goal into independent pieces and delegate each to a fresh worktree+agent using the /spawn socket command shown above. " +
  'You have no repo of your own, so every /spawn MUST include an explicit "repoPath" naming a repo orchestra already knows about (and optionally a "baseBranch"). ' +
  'Track the agents you spawn with /peers, read their progress with /read, and follow up with /message. ' +
  "Follow-up work in an area a child agent already owns goes back to THAT child via /message — never take it over yourself, however small. " +
  'Start by asking the user what they want orchestrated and which repo(s) the work belongs in.';

/** Create a non-git session under `~/.orchestra/scratch`. `kind` selects the
 * flavour: `'scratch'` is a blank throwaway; `'orchestrator'` is the same shell
 * but its agent is seeded with {@link ORCHESTRATOR_BRIEF} so it delegates. */
async function createScratchLikeWorkspace(
  kind: 'scratch' | 'orchestrator',
  window: BrowserWindow,
): Promise<Workspace> {
  if (!existsSync(SCRATCH_ROOT)) await mkdir(SCRATCH_ROOT, { recursive: true });
  const id = randomUUID();
  const label = randomBranchName();
  const prefix = kind === 'orchestrator' ? 'orchestrator' : 'scratch';
  const worktreePath = path.join(SCRATCH_ROOT, `${prefix}-${label}-${id.slice(0, 8)}`);

  log.info(`creating ${kind} session ${label} (${id})`);
  await mkdir(worktreePath, { recursive: true });
  await installOrchestraHooks(worktreePath);
  // Sentinel for the orchestrator-instruction hook, so the standing delegation
  // reminder fires from the very first prompt (the env var lands at pty start).
  if (kind === 'orchestrator') await markOrchestratorWorktree(worktreePath);

  const port = store.allocatePort();
  const ws: Workspace = {
    id,
    name: `${prefix} · ${label}`,
    kind,
    repoPath: '',
    worktreePath,
    branch: label,
    baseBranch: '',
    createdAt: Date.now(),
    status: 'idle',
    agent: 'claude',
    // An orchestrator's brief is injected silently as an appended system prompt
    // by startAgentPty — NOT as a typed `lastTask` turn — so the session opens
    // with a clean prompt instead of a wall of pasted instructions.
    // Leave unlocked so ORCHESTRA_BRANCH_AUTO=1 and the rename nudge fires: the
    // agent relabels the session early, then refines the name once the work
    // scope is clear; after those two progressive auto-renames the nudge retires
    // (tracked via autoRenameCount + the .branch-renamed sentinel).
    branchManuallySet: false,
    port,
    // No repo → no setup script can be configured, so it is never "pending".
    setupStatus: 'ok',
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);
  // Same prompt map push as createWorkspace: without it the session's account
  // badge sits on stale data until the next poll tick.
  void refreshAccountsNow(window).catch(() => {});
  return ws;
}

export function createScratchWorkspace(window: BrowserWindow): Promise<Workspace> {
  return createScratchLikeWorkspace('scratch', window);
}

export function createOrchestratorWorkspace(window: BrowserWindow): Promise<Workspace> {
  return createScratchLikeWorkspace('orchestrator', window);
}

export async function archiveWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  forgetWorkspaceProbes(id);
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

/** Tear down everything a delete owns EXCEPT the store record and the renderer
 *  broadcast: stop PTYs, run the archive script, remove the worktree/dir, drop
 *  scrollback + inbox. Split out so bulk delete can reap N worktrees and then
 *  do a SINGLE store write + a SINGLE broadcast, instead of paying a full
 *  serialized store.json rewrite and a renderer re-render per workspace. */
async function teardownWorkspace(ws: Workspace): Promise<void> {
  const id = ws.id;
  forgetWorkspaceProbes(id);
  log.info(`deleting workspace ${ws.branch} (${id}) worktree=${ws.worktreePath}`);
  // Hard delete: stop agent, run user's archive script (best-effort), remove
  // the git worktree from disk, drop the scrollback log. Archive script runs
  // BEFORE worktree removal so it can still see the files / cwd.
  stopPty(id);
  stopPty(`${id}:run`);
  stopPty(`${id}:nvim`);

  // Scratch sessions are a plain directory with no git worktree and no repo
  // (hence no archive script). Tear the directory down directly — confined to
  // SCRATCH_ROOT so a corrupt path can't `rm` outside our own dir. The
  // git-worktree path below would no-op anyway (removeWorktree on a
  // non-worktree throws and is swallowed), but this also skips the dead archive-
  // script lookup and makes the intent explicit. Orchestrators are scratch
  // sessions under the hood, so they tear down the same way.
  if (isScratchLike(ws)) {
    clearScrollback(id);
    await clearInbox(id);
    if (ws.worktreePath.startsWith(SCRATCH_ROOT + path.sep) && existsSync(ws.worktreePath)) {
      try {
        await rm(ws.worktreePath, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return;
  }

  // Sandbox-hosted: the checkout lives in the container (the local worktree
  // was retired at import time). There is nothing local to archive-script or
  // remove; the container keeps its copy — deleting the record only detaches
  // this Orchestra from it.
  if (ws.host?.kind === 'sandbox') {
    clearScrollback(id);
    await clearInbox(id);
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
}

export async function deleteWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  await teardownWorkspace(ws);
  await store.removeWorkspace(id);
  window.webContents.send('workspace:removed', id);
}

/** Bulk hard-delete. Reaps every worktree/dir up front (archive scripts and
 *  `git worktree remove` run per workspace, sequentially so disk I/O stays
 *  gentle), then collapses the bookkeeping into ONE store write and ONE
 *  renderer broadcast. Deleting N one-by-one otherwise cost N full serialized
 *  store.json rewrites and 2N renderer re-renders — the source of the app-wide
 *  jam when clearing dozens of archived workspaces at once. `onProgress` fires
 *  after each teardown so the UI can advance its bar. */
export async function deleteWorkspaces(
  ids: string[],
  window: BrowserWindow,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const targets = ids.map((id) => store.getWorkspace(id)).filter((w): w is Workspace => !!w);
  const removed: string[] = [];
  let done = 0;
  for (const ws of targets) {
    await teardownWorkspace(ws);
    removed.push(ws.id);
    onProgress?.(++done, targets.length);
  }
  if (removed.length === 0) return;
  await store.removeWorkspaces(removed);
  window.webContents.send('workspaces:removed', removed);
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

  // Read every repo's worktree list concurrently — one `git worktree list`
  // subprocess per repo, all in flight at once rather than serialized on the
  // boot path (this runs before first paint). A repo that's gone/unmounted or
  // unreadable resolves to null and is skipped wholesale (never nuke records
  // we can't verify).
  const trackedByRepo = new Map<string, Set<string>>();
  await Promise.all(
    [...byRepo.keys()].map(async (repoPath) => {
      if (!existsSync(repoPath)) return; // repo gone/unmounted — can't verify
      try {
        trackedByRepo.set(repoPath, new Set(await listWorktreePaths(repoPath)));
      } catch {
        /* unreadable — skip the whole repo to be safe */
      }
    }),
  );

  for (const [repoPath, list] of byRepo) {
    const tracked = trackedByRepo.get(repoPath);
    if (!tracked) continue; // repo gone/unmounted/unreadable — skip safely

    for (const ws of list) {
      // Sandbox-hosted workspaces own no local worktree (it was retired by the
      // import) — the checkout lives in the container, so the local registry
      // never tracks it. Never prune these.
      if (ws.host?.kind === 'sandbox') continue;
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

/** The agent may auto-rename its own branch this many times before the nudge
 * self-retires: once for an early provisional name, once to refine it after the
 * work is well-defined. See {@link Workspace.autoRenameCount}. */
export const MAX_AUTO_RENAMES = 2;

/** Whether orchestra should still nudge the agent to auto-rename this workspace.
 * True only while a human hasn't pinned the name AND the agent hasn't used up
 * its two progressive auto-renames. This is the single source of truth for the
 * `ORCHESTRA_BRANCH_AUTO` env flag and for `dispatchRenameRequest`'s decision to
 * bump the counter (vs. treat the rename as an on-demand, user-asked one). */
export function autoRenameActive(ws: Workspace): boolean {
  return !ws.branchManuallySet && (ws.autoRenameCount ?? 0) < MAX_AUTO_RENAMES;
}

/** Rename the branch on a workspace. The worktree dir stays put and the
 * agent keeps running — `git branch -m` is purely a ref rename, so HEAD,
 * CWD, and open files are unaffected. The agent's TUI banner may show a
 * stale branch name until it next repaints, but that's cosmetic.
 *
 * `manual` marks a *human*-driven rename (typing in the sidebar UI, an
 * out-of-band branch change): it sets `branchManuallySet` and hard-stops the
 * nudge. An agent renaming itself via the socket passes `manual:false` and
 * instead bumps `autoRenameCount` in `dispatchRenameRequest`, so it can keep
 * progressively refining its own name up to {@link MAX_AUTO_RENAMES}. */
export async function renameWorkspaceBranch(
  id: string,
  rawNewBranch: string,
  opts: { manual: boolean; bumpAutoCount?: boolean },
  window: BrowserWindow,
): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  const newBranch = sanitizeBranchName(rawNewBranch);
  if (!newBranch) throw new Error('invalid branch name');
  // Fields that change how the rename nudge behaves next time. A human rename
  // (`manual`) pins the branch via branchManuallySet and stops the nudge for
  // good. An agent auto-rename (`bumpAutoCount`) instead advances the
  // progressive-rename counter, so the agent keeps getting nudged until it has
  // used up its MAX_AUTO_RENAMES refinements. The two are mutually exclusive in
  // practice (manual renames come from the UI; auto from the socket).
  const gateFields = {
    branchManuallySet: opts.manual || ws.branchManuallySet,
    ...(opts.bumpAutoCount ? { autoRenameCount: (ws.autoRenameCount ?? 0) + 1 } : {}),
  };
  // A scratch session has no git branch — its "branch" is just a display label.
  // Relabel it in place (no `git branch -m`, no name collisions to dodge).
  // Orchestrators relabel the same way.
  if (isScratchLike(ws)) {
    if (newBranch === ws.branch) {
      // No name change, but a manual/auto action may still need to advance the
      // gate (e.g. a UI relabel to the same name, or an idempotent auto-rename).
      if ((opts.manual && !ws.branchManuallySet) || opts.bumpAutoCount) {
        const updated = { ...ws, ...gateFields };
        await store.upsertWorkspace(updated);
        window.webContents.send('workspace:update', updated);
        return updated;
      }
      return ws;
    }
    const updated: Workspace = {
      ...ws,
      branch: newBranch,
      name: `scratch · ${newBranch}`,
      ...gateFields,
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
    if ((opts.manual && !ws.branchManuallySet) || opts.bumpAutoCount) {
      const updated = { ...ws, branch: liveBranch, ...gateFields };
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
    ...gateFields,
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
 *
 * Unlike a UI rename this never pins `branchManuallySet`; instead each agent
 * rename advances `autoRenameCount` while the progressive-rename nudge is still
 * active, giving the agent two staged auto-renames (early provisional name →
 * refined name once the work is well-defined) before the nudge retires. Renames
 * are *never* refused for being "already set": once the nudge has retired the
 * agent can still rename on demand (e.g. the user explicitly asks) — it just
 * stops being prompted to. Returns a structured result so the agent's socket
 * call can tell success from failure. */
export async function dispatchRenameRequest(
  id: string,
  rawNewBranch: string,
  window: BrowserWindow,
): Promise<RenameResult> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return { ok: false, error: 'unknown workspace' };
  // Only count this rename against the progressive-rename budget while the nudge
  // is still active. An on-demand rename after the budget is spent (or after a
  // human pinned the name) still lands, but doesn't advance the counter.
  const bumpAutoCount = autoRenameActive(ws);
  try {
    let updated: Workspace;
    // A scratch session has no branch namespace to dedupe against, so skip the
    // freeBranchName collision pass and relabel straight through.
    if (isScratchLike(ws)) {
      const target = sanitizeBranchName(rawNewBranch);
      if (!target) return { ok: false, error: 'invalid branch name' };
      updated = await renameWorkspaceBranch(id, target, { manual: false, bumpAutoCount }, window);
    } else {
      // Suffix against the live branch (not the possibly-stale stored name) so a
      // name that collides with an existing branch still lands, and so a request
      // matching the worktree's real current branch is treated as a no-op rather
      // than getting needlessly suffixed.
      const live = (await getCurrentBranch(ws.worktreePath)) || ws.branch;
      const target = await freeBranchName(ws.repoPath, sanitizeBranchName(rawNewBranch), live);
      if (!target) return { ok: false, error: 'invalid branch name' };
      updated = await renameWorkspaceBranch(id, target, { manual: false, bumpAutoCount }, window);
    }
    // Record the new auto-rename count in a worktree sentinel so the in-session
    // nudge picks up the fresh stage immediately — before the next pty restart
    // refreshes ORCHESTRA_AUTO_RENAME_COUNT in the env. The hook reads this to
    // pick stage-appropriate wording and to self-disable once the budget is
    // spent. Only meaningful for counted (auto) renames.
    if (bumpAutoCount) await writeRenameProgress(ws.worktreePath, updated.autoRenameCount ?? 0);
    return { ok: true, branch: updated.branch };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'rename failed' };
  }
}

/** Record how many times the agent has auto-renamed, in a worktree sentinel the
 * rename-instruction hook reads. Fresher than the per-pty env var, so the nudge
 * advances to the next stage (or self-disables) the instant a rename lands —
 * without waiting for a pty restart. The file body is the current count; the
 * hook self-disables once it reaches MAX_AUTO_RENAMES. Works for scratch (no git
 * branch to diff) and git worktrees alike. Best-effort: a write failure just
 * means the nudge falls back to the (slightly stale) env count. */
async function writeRenameProgress(worktreePath: string, count: number): Promise<void> {
  try {
    await writeFile(path.join(worktreePath, '.orchestra', '.branch-renamed'), String(count));
  } catch {
    /* best-effort */
  }
}

/** Mark a worktree as belonging to an orchestrator, in a sentinel the
 * orchestrator-instruction hook reads. Same fresher-than-env pattern as
 * `.branch-renamed`: written at creation AND the instant a scratch session is
 * promoted mid-session, so the standing delegation reminder starts firing on
 * the very next prompt — before any pty restart refreshes ORCHESTRA_KIND in
 * the env. Best-effort: on write failure the hook falls back to the env var,
 * which catches up on the next pty start. */
async function markOrchestratorWorktree(worktreePath: string): Promise<void> {
  try {
    await mkdir(path.join(worktreePath, '.orchestra'), { recursive: true });
    await writeFile(path.join(worktreePath, '.orchestra', '.orchestrator'), '1');
  } catch {
    /* best-effort */
  }
}

// Default geometry for an agent PTY spawned headless (no visible terminal yet).
// The renderer re-fits to the real pane size the first time the user opens the
// workspace; until then the agent just needs a sane width to render its TUI.
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 32;

// How long to wait for an agent's SessionStart readiness sentinel before giving
// up and submitting the opening prompt anyway. Generous — a cold `claude` boot
// can take several seconds, and waiting costs nothing once the sentinel lands.
const READY_TIMEOUT_MS = 15_000;
// Fallback delay used only when the sentinel never appears (e.g. a session not
// started by orchestra, or a hook that failed to fire). Matches the proven
// fixed-timer value the readiness signal replaces.
const READY_FALLBACK_MS = 1_200;
// Gap between writing the prompt text and the submit carriage return. A newline
// in the same chunk reads as a pasted newline (never submits), so it must be a
// separate write — and far enough behind the text that the TUI has committed
// the paste to its input buffer first.
const SUBMIT_CR_DELAY_MS = 150;
// Submit confirmation: after sending '\r' we watch the workspace status, which
// flips off `idle` the instant the agent's UserPromptSubmit hook fires. If it
// hasn't flipped within this window the '\r' was dropped (a real failure mode
// when several agents spawn at once and the main loop is saturated) — so we
// re-send. Poll interval and max attempts bound the retry.
const SUBMIT_CONFIRM_MS = 2_500;
const SUBMIT_POLL_MS = 100;
const SUBMIT_MAX_ATTEMPTS = 4;

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
  const readyFile = readyFilePath(id);
  // Drop any stale sentinel from a prior run before the agent starts, so the
  // wait below can't be short-circuited by an old file.
  await clearReadyFile(id);
  const extraEnv: Record<string, string> = {
    // Per-repo env first so Orchestra's own vars below always take precedence.
    ...resolveRepoAgentEnv(ws),
    ORCHESTRA_BRANCH: ws.branch,
    ORCHESTRA_BRANCH_AUTO: autoRenameActive(ws) ? '1' : '0',
    ORCHESTRA_AUTO_RENAME_COUNT: String(ws.autoRenameCount ?? 0),
    ORCHESTRA_KIND: ws.kind ?? 'worktree',
    ORCHESTRA_READY_FILE: readyFile,
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
  // Submit the opening prompt once the TUI is actually live — signalled by the
  // SessionStart readiness sentinel rather than a fixed delay — then confirm the
  // submit '\r' actually registered and resend it if not. The old path was
  // fire-and-forget: under concurrent spawns the saturated main loop could drop
  // the submit keystroke (text present in the box, never sent — exactly the
  // "third agent didn't start" symptom), with nothing to catch it. Now the task
  // text lands on readiness, and the '\r' is retried until the agent's own
  // UserPromptSubmit hook flips the status off `idle`.
  void submitTaskWhenReady(id, task, readyFile, window);
}

/** Submit `task` into a freshly-started agent's TUI once it signals readiness,
 * then flip `hasInput`. Waits for the readiness sentinel (deterministic), and
 * only if it never appears falls back to the proven fixed delay. The two-write
 * submit (text, then a SEPARATE '\r' a beat later) is unchanged: a trailing
 * newline in the same chunk is treated by Claude's TUI as a pasted newline and
 * never submits. */
async function submitTaskWhenReady(
  id: string,
  task: string,
  readyFile: string,
  window: BrowserWindow,
): Promise<void> {
  const ready = await waitForAgentReady(readyFile, READY_TIMEOUT_MS);
  if (!ready) {
    log.warn(`agent ${id} readiness sentinel timed out — falling back to fixed delay`);
    await new Promise((r) => setTimeout(r, READY_FALLBACK_MS));
  }
  // The PTY may have died (agent quit, workspace deleted) while we waited.
  if (!isRunning(id)) {
    await clearReadyFile(id);
    return;
  }
  // Type the prompt once, then submit with a confirmed, retrying carriage
  // return. The text itself reliably lands once the readiness sentinel is up;
  // it's the submit '\r' that used to get dropped under concurrent spawns, so
  // only the '\r' is retried (re-typing the task would duplicate it in the
  // input). We treat "status left idle" as proof the submit registered.
  writePty(id, task);
  await new Promise((r) => setTimeout(r, SUBMIT_CR_DELAY_MS));
  let submitted = false;
  for (let attempt = 0; attempt < SUBMIT_MAX_ATTEMPTS; attempt++) {
    if (!isRunning(id)) break;
    writePty(id, '\r');
    if (await waitForSubmitConfirmed(id, SUBMIT_CONFIRM_MS)) {
      submitted = true;
      break;
    }
    log.warn(`agent ${id} submit '\\r' not confirmed (attempt ${attempt + 1}) — resending`);
  }
  if (!submitted) {
    log.warn(`agent ${id} opening prompt may not have submitted after ${SUBMIT_MAX_ATTEMPTS} attempts`);
  }
  await clearReadyFile(id);
  const fresh = store.getWorkspace(id);
  if (fresh && !fresh.hasInput) {
    const updated: Workspace = { ...fresh, hasInput: true };
    void store.upsertWorkspace(updated).then(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('workspace:update', updated);
      }
    });
  }
}

/** Wait until the agent's status leaves `idle` — set by its own
 * UserPromptSubmit hook (`submit` → `running`) the instant it accepts the
 * prompt. This is the authoritative "the '\r' registered" signal: a dropped
 * submit keystroke leaves the status at `idle`, so the caller knows to resend.
 * Resolves true on the transition, false on timeout. */
async function waitForSubmitConfirmed(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = store.getWorkspace(id)?.status;
    // Anything other than idle means the prompt was accepted and the turn
    // started (running), already produced output (waiting), or errored — all of
    // which prove the '\r' landed. A vanished workspace also ends the wait.
    if (!status || status !== 'idle') return true;
    await new Promise((r) => setTimeout(r, SUBMIT_POLL_MS));
  }
  return false;
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
    detached?: boolean;
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
    // Inherit the caller's repo — but a scratch/orchestrator caller has none
    // (repoPath is ''), so it must always name the target repo explicitly.
    repoPath = store.getWorkspace(input.from)?.repoPath || undefined;
  }
  if (!repoPath)
    return {
      ok: false,
      error:
        'no repo: pass an explicit repoPath (an orchestrator/scratch session has no repo of its own to inherit)',
    };
  try {
    // `detached` skips only the parent nesting — `from` above still drives
    // repo inheritance, so a detached spawn need not name --repo explicitly.
    const ws = await createWorkspace(
      {
        repoPath,
        baseBranch: input.baseBranch,
        task,
        agent: input.agent,
        parentId: input.detached ? undefined : input.from,
      },
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

/** Un-register a repo by absolute path and broadcast the refreshed list. Refuses
 * if any workspace (active or archived) still belongs to the repo — those must be
 * deleted first so we never leave orphan worktrees pointing at a forgotten repo.
 * Idempotent: removing an unknown path is a no-op that still re-broadcasts. */
export async function removeRepoByPath(absPath: string, window: BrowserWindow): Promise<void> {
  const attached = store.workspaces.filter((w) => w.repoPath === absPath);
  if (attached.length > 0) {
    throw new Error(
      `repo still has ${attached.length} workspace${attached.length === 1 ? '' : 's'} — delete them first`,
    );
  }
  await store.removeRepo(absPath);
  window.webContents.send('repos:update', store.repos);
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

// ---------- Promote scratch → orchestrator ----------

export interface PromoteResult {
  ok: boolean;
  id?: string;
  branch?: string;
  kind?: Workspace['kind'];
  error?: string;
}

/** Socket entry point for `/promote`. Turns a plain `'scratch'` session into an
 * `'orchestrator'` in place: the record keeps its id, worktree, branch label and
 * already-running agent — only its `kind` (and the display-name prefix) change.
 * That single flip moves it into the sidebar's "Orchestrators" section and makes
 * every worktree it subsequently spawns nest beneath it (children carry its id
 * as `parentId`). Idempotent — re-promoting an orchestrator is a no-op success.
 * Only a scratch session qualifies: a git worktree has a repo/branch/diff and
 * can't be repurposed as a repo-less coordinator. Never throws; answers `{ ok }`. */
export async function dispatchPromoteRequest(
  input: { id?: string },
  window: BrowserWindow,
): Promise<PromoteResult> {
  const id = input.id?.trim();
  if (!id) return { ok: false, error: 'missing id' };
  const ws = store.getWorkspace(id);
  if (!ws) return { ok: false, error: `unknown workspace: ${id}` };
  // Already an orchestrator — succeed idempotently so a double-invoke (or the
  // skill re-firing) doesn't error.
  if (ws.kind === 'orchestrator') return { ok: true, id, branch: ws.branch, kind: 'orchestrator' };
  if (ws.kind !== 'scratch') {
    return {
      ok: false,
      error: 'only a scratch session can be promoted to an orchestrator (a git worktree has a repo and branch)',
    };
  }
  try {
    // Swap the display-name prefix `scratch · ` → `orchestrator · ` to match how
    // createScratchLikeWorkspace builds the name. The worktree directory keeps
    // its `scratch-` prefix — a live agent runs there, so renaming the path
    // mid-session is needless risk; only the record's kind/name move.
    const name = ws.name.startsWith('scratch · ')
      ? `orchestrator · ${ws.name.slice('scratch · '.length)}`
      : ws.name;
    const updated: Workspace = { ...ws, kind: 'orchestrator', name };
    await store.upsertWorkspace(updated);
    // The promoting agent's pty was spawned with ORCHESTRA_KIND=scratch, so the
    // sentinel is what makes the standing delegation reminder kick in on its
    // very next prompt — no pty restart required.
    await markOrchestratorWorktree(ws.worktreePath);
    window.webContents.send('workspace:update', updated);
    log.info(`promoted scratch ${ws.branch} (${id}) to orchestrator`);
    return { ok: true, id, branch: updated.branch, kind: 'orchestrator' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'promote failed' };
  }
}

// ---------- Re-parent (attach / detach) ----------

export interface AttachResult {
  ok: boolean;
  id?: string;
  /** The new parent after the call: an orchestrator id on attach, `null` on detach. */
  parentId?: string | null;
  branch?: string;
  error?: string;
}

/** Socket entry point for `/attach`. Re-parents an EXISTING workspace so it nests
 * under an orchestrator in the sidebar, or detaches it back to its own repo
 * section. This is the after-the-fact counterpart to `/spawn`, which sets
 * `parentId` only at creation: an `id` WITH a `parentId` attaches; an `id` with
 * no/empty `parentId` detaches.
 *
 * Attach guards: the child must exist; the parent must exist AND be an
 * orchestrator (only the sidebar's orchestrator section renders an arbitrary
 * child subtree — parenting under anything else would bury the child in a branch
 * that never renders); and a workspace can't be its own parent. Orchestrators
 * never carry a `parentId` of their own (they're always tree roots), so an
 * orchestrator-only parent rule also makes any deeper cycle impossible — the
 * self-check is the only one needed. Idempotent. Never throws; answers `{ ok }`. */
export async function dispatchAttachRequest(
  input: { id?: string; parentId?: string | null },
  window: BrowserWindow,
): Promise<AttachResult> {
  const id = input.id?.trim();
  if (!id) return { ok: false, error: 'missing id' };
  const ws = store.getWorkspace(id);
  if (!ws) return { ok: false, error: `unknown workspace: ${id}` };

  const rawParent = typeof input.parentId === 'string' ? input.parentId.trim() : '';

  // Detach: no parent given → clear `parentId`. A dangling parent (deleted
  // orchestrator) still clears here; only an already-rootless workspace is a
  // pure no-op success.
  if (!rawParent) {
    if (ws.parentId === undefined) return { ok: true, id, parentId: null, branch: ws.branch };
    const updated: Workspace = { ...ws, parentId: undefined };
    await store.upsertWorkspace(updated);
    window.webContents.send('workspace:update', updated);
    log.info(`detached ${ws.branch} (${id}) from its parent`);
    return { ok: true, id, parentId: null, branch: ws.branch };
  }

  if (rawParent === id) return { ok: false, error: 'a workspace cannot be its own parent' };
  const parent = store.getWorkspace(rawParent);
  if (!parent) return { ok: false, error: `unknown parent workspace: ${rawParent}` };
  if (parent.kind !== 'orchestrator') {
    return {
      ok: false,
      error: 'parent must be an orchestrator (promote a scratch session into one first)',
    };
  }
  // Idempotent re-attach to the same parent.
  if (ws.parentId === rawParent) return { ok: true, id, parentId: rawParent, branch: ws.branch };

  const updated: Workspace = { ...ws, parentId: rawParent };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
  log.info(`attached ${ws.branch} (${id}) under orchestrator ${parent.branch} (${rawParent})`);
  return { ok: true, id, parentId: rawParent, branch: ws.branch };
}

// ---------- Migrate a workspace to a different account ----------

export interface MigrateAccountResult {
  ok: boolean;
  id?: string;
  branch?: string;
  /** The account id the workspace is now pinned to, or null for default login. */
  accountId?: string | null;
  /** True when the agent was running and was auto-resumed after the move. */
  resumed?: boolean;
  error?: string;
}

/** Default PTY geometry for an agent auto-resumed after an account migration.
 * Mirrors the startup-resume geometry (RESUME_COLS/ROWS): the renderer re-fits
 * the moment the user opens the tab, so this only governs unseen TUI wrapping. */
const MIGRATE_RESUME_COLS = 80;
const MIGRATE_RESUME_ROWS = 24;

/** Move a workspace's Claude Code conversation transcripts from one account's
 * config dir to another's, so `claude --continue` still resolves the session
 * after the pin changes. Claude keys the session off the worktree cwd
 * (`projects/<mangled-cwd>/*.jsonl`), which never changes, so relocating those
 * files under `dstConfigDir` is what preserves continuity. Best-effort per file;
 * a genuine fs error propagates so a half-move surfaces instead of silently
 * losing history. A missing source project dir is fine (nothing recorded yet).
 * No-ops when src and dst resolve to the same dir. */
async function moveWorkspaceTranscripts(
  worktreePath: string,
  srcConfigDir: string,
  dstConfigDir: string,
): Promise<void> {
  if (srcConfigDir === dstConfigDir) return;
  const mangled = mangleProjectDir(worktreePath);
  const srcDir = path.join(srcConfigDir, 'projects', mangled);
  const dstDir = path.join(dstConfigDir, 'projects', mangled);
  let entries: string[];
  try {
    entries = await readdir(srcDir);
  } catch {
    return; // no project dir under the source account → nothing to move
  }
  if (entries.length === 0) return;
  await mkdir(dstDir, { recursive: true });
  for (const name of entries) {
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    try {
      await rename(from, to);
    } catch (err) {
      // Cross-device rename (EXDEV) — the two config dirs live on different
      // filesystems. Fall back to copy + unlink so the move still completes.
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
        await copyFile(from, to);
        await rm(from, { force: true });
      } else {
        throw err;
      }
    }
  }
  // Drop the now-empty source project dir (best-effort — leftover files, e.g. a
  // concurrently-written transcript, just leave it in place).
  await rm(srcDir, { recursive: true, force: true }).catch(() => undefined);
}

/** Socket/IPC entry point for migrating a workspace to a different account (or
 * back to the default login with a null/empty `accountId`). Per the pinning
 * model, this must relocate the conversation, not just re-label: stop the agent
 * if it's running, move its transcripts into the target account's config dir,
 * re-pin `accountId`, sync the target account's inherited config, and — if the
 * agent was running — resume it with `--continue` under the new account.
 *
 * Works for git workspaces AND scratch/orchestrator sessions (their pin drives
 * CLAUDE_CONFIG_DIR the same way; a never-run session simply has no transcript
 * to move). Refuses only an archived workspace. A no-op success when already on
 * the target account. Never throws; answers `{ ok }`. */
export async function dispatchMigrateAccountRequest(
  input: { id?: string; accountId?: string | null },
  window: BrowserWindow,
): Promise<MigrateAccountResult> {
  const id = input.id?.trim();
  if (!id) return { ok: false, error: 'missing id' };
  const ws = store.getWorkspace(id);
  if (!ws) return { ok: false, error: `unknown workspace: ${id}` };
  if (ws.archived) return { ok: false, error: 'cannot migrate an archived workspace' };
  // Scratch/orchestrator sessions are migratable too: they have no repo to
  // snapshot an account from at creation, but the pin (`ws.accountId`) drives
  // their CLAUDE_CONFIG_DIR just like a git workspace, and their conversation
  // lives at `<configDir>/projects/<mangled-scratch-path>/*.jsonl` — so the same
  // stop → move-transcript → re-pin → resume flow applies unchanged.

  // Resolve the target account and decide whether a move is even needed. A
  // null/empty accountId clears the pin → default login. Shared pure logic so
  // the decision is unit-tested (accounts.test.ts) rather than living inline.
  const knownAccountIds = new Set(store.accounts.map((a) => a.id));
  const plan = planAccountMigration(ws.accountId, input.accountId, knownAccountIds);
  if (plan.kind === 'error') return { ok: false, error: plan.error };
  const targetAccountId = plan.targetAccountId;
  if (plan.kind === 'noop') {
    // Already on the target (both a real id or both default login) — no-op.
    return { ok: true, id, branch: ws.branch, accountId: targetAccountId ?? null, resumed: false };
  }
  const currentAccountId = ws.accountId ?? undefined;

  // Resolve source and destination config dirs. A workspace on the default
  // login (no pin) reads/writes its session under `~/.claude`; the same holds
  // for the destination when clearing the pin.
  const defaultDir = path.join(os.homedir(), '.claude');
  const srcConfigDir = workspaceAccountConfigDir(ws, undefined) || defaultDir;
  const targetAccount = targetAccountId
    ? store.accounts.find((a) => a.id === targetAccountId)
    : undefined;
  const dstConfigDir = targetAccount
    ? expandConfigDir(targetAccount.configDir, os.homedir(), process.env) || defaultDir
    : defaultDir;

  try {
    const wasRunning = isRunning(id);
    if (wasRunning) stopPty(id);

    // Move the conversation before re-pinning so a failure leaves the workspace
    // on its original account (with its history intact) rather than pinned to an
    // account whose config dir has no transcript.
    await moveWorkspaceTranscripts(ws.worktreePath, srcConfigDir, dstConfigDir);

    const updated: Workspace = { ...ws };
    if (targetAccountId) updated.accountId = targetAccountId;
    else delete updated.accountId;
    await store.upsertWorkspace(updated);
    window.webContents.send('workspace:update', updated);
    // Re-broadcast the workspace→account map here rather than only in the IPC
    // handler: the socket route (`orchestra migrate-account`) reaches this
    // function too, and without the push its badge lags until the next poll.
    void refreshAccountsNow(window).catch(() => {});

    // Materialize the target account's inherited global config into its login
    // dir so a non-resumed workspace is ready for its next manual launch (the
    // resume path below also does this, but a stopped workspace won't hit it).
    if (targetAccount) {
      await syncAccountInheritance(targetAccount).catch((err) =>
        log.warn(`account-inherit: migrate-time sync failed for ${id}`, err),
      );
    }

    log.info(
      `migrated ${ws.branch} (${id}) from account ${currentAccountId ?? 'default'} to ${targetAccountId ?? 'default'}`,
    );

    // Resume only if the agent was live when we stepped in — a workspace that
    // was idle stays idle (the user/agent resumes it when ready), matching the
    // "auto-stop → migrate → resume" contract without force-waking a cold one.
    let resumed = false;
    if (wasRunning) {
      try {
        await startAgentPty(updated, MIGRATE_RESUME_COLS, MIGRATE_RESUME_ROWS, window);
        resumed = true;
      } catch (err) {
        log.warn(`migrate: resume failed for ${id}`, err);
      }
    }

    return { ok: true, id, branch: ws.branch, accountId: targetAccountId ?? null, resumed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'migrate failed' };
  }
}

export interface AccountsListResult {
  ok: boolean;
  accounts?: Array<{ id: string; label: string; configDir: string }>;
  error?: string;
}

/** Socket entry point for `/accounts`: a read-only list of the configured
 * accounts (id + label + config-dir template — never a token) so a CLI or LLM
 * caller can discover the account id to pass to `/migrateAccount`. */
export function dispatchAccountsListRequest(): AccountsListResult {
  const accounts = store.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    configDir: a.configDir,
  }));
  return { ok: true, accounts };
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
  return `[message from agent '${fromBranch}' (${fromId})]\n${text}\n\nReply with: orchestra message ${fromId} "<reply>"`;
}

/** Wake a stopped agent and hand it `prompt` as a live turn. Resumes the prior
 * conversation with `--continue` when the workspace has run before (mirrors the
 * renderer's resume path) so the woken agent keeps its context; otherwise it
 * starts fresh and the prompt becomes its opening turn. Safe against the
 * renderer's later `pty:start`, which early-returns on `isRunning`. Returns
 * false when the agent can't be woken (missing / archived / already running) so
 * the caller can fall back. Throws only if the PTY spawn itself fails.
 * Exported for the prompt-queue flusher, which delivers usage-limit-parked
 * prompts through the exact same live-or-wake path as peer messages. */
export async function wakeAgentWithPrompt(
  id: string,
  prompt: string,
  window: BrowserWindow,
): Promise<boolean> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || isRunning(id)) return false;
  const resuming = ws.hasInput === true;
  const readyFile = readyFilePath(id);
  await clearReadyFile(id);
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
    extraEnv: {
      // Per-repo env first so Orchestra's own vars below always take precedence.
      ...resolveRepoAgentEnv(ws),
      ORCHESTRA_BRANCH: ws.branch,
      ORCHESTRA_BRANCH_AUTO: autoRenameActive(ws) ? '1' : '0',
      ORCHESTRA_AUTO_RENAME_COUNT: String(ws.autoRenameCount ?? 0),
      ORCHESTRA_KIND: ws.kind ?? 'worktree',
      ORCHESTRA_READY_FILE: readyFile,
    },
  });
  // Submit the message once the TUI signals readiness (sentinel), not on a
  // fixed delay — same concurrency fix as the headless spawn path. submitTask-
  // WhenReady handles the wait, fallback, two-write submit, and dead-PTY guard;
  // hasInput is flipped here since this turn is always a real submitted prompt.
  void submitTaskWhenReady(id, prompt, readyFile, window);
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
// SessionStart, whose payload `source` distinguishes startup/resume from
// clear/compact — the two moments the persisted context-size badge goes stale
// (compaction/clearing rewrites the context without any turn-end hook firing).
const HOOK_ACTIVITY_SESSION_CMD = activityHookCmd('session');

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

// The spawn / comms / repo-routes capabilities are no longer advertised by
// SessionStart hooks. They moved to Claude Code project skills
// (orchestra-spawn / orchestra-comms / orchestra-repos), so only each skill's
// one-sentence description loads up front and the full CLI reference loads on
// demand — instead of ~1k tokens of prose re-billed as transcript every turn.

// Peer-gated comms reminder, fired on every UserPromptSubmit (the script
// self-silences when no sibling agents exist), so the comms capability is never
// missed once a peer actually shows up — not just at the context-free start.
// Now a single line pointing at the `orchestra-comms` skill, not the full
// command block (that lives in the skill body).
const HOOK_COMMS_RESURFACE_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/comms-resurface.sh"; [ -f "$f" ] && bash "$f" || true';

// Drains any queued peer messages into context. Runs on SessionStart AND every
// UserPromptSubmit so a message that landed in the inbox while the agent was
// between turns surfaces promptly (the script self-clears the file once read).
const HOOK_INBOX_DELIVER_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/inbox-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

// Standing delegation reminder for orchestrator sessions, fired on
// SessionStart ONLY (the script self-silences on non-orchestrator workspaces).
// SessionStart covers startup, resume, clear AND post-compaction — exactly the
// moments where the one-time --append-system-prompt brief (or the promote
// skill's role text) gets summarized away and an orchestrator starts doing
// child-sized work itself. Deliberately NOT wired to UserPromptSubmit: a
// per-turn injection accumulates one copy per turn in the transcript and is
// re-billed as input on every later turn — the same compounding tax that
// pushed the capability prose into skills. Hard enforcement between
// SessionStarts is the zero-token orchestrator-guard PreToolUse hook below.
const HOOK_ORCHESTRATOR_INSTRUCTION_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/orchestrator-instruction.sh"; [ -f "$f" ] && bash "$f" || true';

// Hard enforcement of the orchestrator contract: a PreToolUse hook on the
// file-editing tools that DENIES the call (exit 2 → the agent sees the stderr
// and must change course) when an orchestrator edits files belonging to
// another workspace. Unlike an injected reminder this costs zero tokens until
// the agent actually drifts, and the deny message re-teaches delegation at
// the exact moment of the violation — the cheapest, most effective channel.
const HOOK_ORCHESTRATOR_GUARD_CMD =
  'f="${ORCHESTRA_WORKTREE:-.}/.orchestra/orchestrator-guard.sh"; [ -f "$f" ] && bash "$f" || true';

// Tools the orchestrator guard intercepts: the file-mutation tools only
// (MultiEdit is retired but kept for older Claude Code versions). Everything
// else — including Bash, which the orchestrator needs for the `orchestra`
// CLI — stays unguarded.
const ORCHESTRATOR_GUARD_MATCHER = 'Edit|MultiEdit|Write|NotebookEdit';

// Touches the readiness sentinel the instant the TUI fires SessionStart, so the
// task injector knows the prompt box is live and can submit deterministically
// instead of guessing with a fixed delay. $ORCHESTRA_READY_FILE is set per-PTY
// by orchestra; the guard makes it a no-op when absent (e.g. a session not
// started by orchestra). `: >` truncates/creates the file atomically.
const HOOK_SESSION_START_READY_CMD =
  '[ -n "${ORCHESTRA_READY_FILE:-}" ] && : > "$ORCHESTRA_READY_FILE" || true';

const RENAME_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Nudges the agent to progressively rename its
# auto-generated branch, in two stages:
#   stage 0 → push HARD for an early provisional name on the very first prompt.
#   stage 1 → once the work is well-defined, push to REFINE the name to match.
# After the second rename the nudge retires (further renames are on-demand only,
# e.g. when the user explicitly asks). Runs on SessionStart AND every
# UserPromptSubmit so the nudge re-surfaces the moment the work scope sharpens.
#
# Gated on ORCHESTRA_BRANCH_AUTO=1 (orchestra sets it only while a human hasn't
# pinned the name and auto-renames remain). The live stage comes from the
# .branch-renamed sentinel (written by the /rename handler, fresher than the
# per-pty env) when present, else ORCHESTRA_AUTO_RENAME_COUNT — so the wording
# advances and the nudge self-disables the instant a rename lands, before any
# pty restart.
[ "\${ORCHESTRA_BRANCH_AUTO:-0}" = "1" ] || exit 0
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
sentinel="\${ORCHESTRA_WORKTREE:-.}/.orchestra/.branch-renamed"
count="\${ORCHESTRA_AUTO_RENAME_COUNT:-0}"
if [ -f "\$sentinel" ]; then
  s="\$(cat "\$sentinel" 2>/dev/null)"
  case "\$s" in ''|*[!0-9]*) : ;; *) count="\$s" ;; esac
fi
# Budget spent → retire the nudge mid-session (belt-and-braces; the env gate
# also flips off on the next pty restart).
[ "\$count" -ge ${MAX_AUTO_RENAMES} ] 2>/dev/null && exit 0
if [ "\$count" -ge 1 ]; then
cat <<EOF
[orchestra] The work for this workspace should now be coming into focus. Its branch is '\${ORCHESTRA_BRANCH:-unknown}', named early before the task was fully defined. Now that the work to implement is well-defined, REFINE the branch name to match it precisely. Run this exact command (do NOT use 'git branch -m'):

  orchestra rename "\\\$ORCHESTRA_WS_ID" "<refined-branch-name>"

On success it prints "Renamed to <final-name>". Pick a short kebab-case name (3-6 words) reflecting the concrete task, e.g. fix-checkout-double-charge, add-stripe-webhook-retry. This is the final auto-rename — after it, only rename again if the user explicitly asks.
EOF
else
cat <<EOF
[orchestra] This workspace is on the auto-generated branch '\${ORCHESTRA_BRANCH:-unknown}'. Rename it NOW, on this very first prompt, to a provisional name reflecting your best current understanding of the work — do not wait until the task is fully specified. You'll get one more chance to refine the name once the work is well-defined. Run this exact command (do NOT use 'git branch -m'):

  orchestra rename "\\\$ORCHESTRA_WS_ID" "<new-branch-name>"

On success it prints "Renamed to <final-name>" (orchestra renames the real git branch for you — do NOT also run 'git branch -m'); on failure it prints an error. Pick a short kebab-case name (3-6 words), e.g. fix-checkout-typo, add-stripe-webhook-retry, route-demande-accessoire. Name it the moment you can — an approximate name now beats a perfect name later.
EOF
fi
`;

// ---------- Capability skills ----------
//
// Orchestra's standing capabilities — spawn a parallel agent, talk to peers,
// register repos / delete workspaces — used to be advertised in full prose
// (with embedded curl payloads) on every SessionStart. That text then lived in
// the conversation transcript and was reprocessed as INPUT on every subsequent
// turn, so a ~1k-token one-time fact silently became a per-turn tax that grows
// with conversation length.
//
// They are now packaged as Claude Code project skills under
// `<worktree>/.claude/skills/<name>/SKILL.md`. Only each skill's `description`
// (a single tight sentence, ~30 tokens) is ever loaded up front; the full body
// — including the exact `orchestra <subcommand>` invocation — loads only when
// the agent actually invokes the skill. The advertisement shrinks ~30x and the
// bodies cost nothing until used. Skills are auto-discovered from
// `.claude/skills/` with no settings.json registration; left model-invocable
// (default) so the agent pulls them when a task calls for delegation /
// coordination, and `/orchestra-spawn` etc. also work as manual commands.
//
// The bodies invoke the `orchestra` CLI rather than raw `curl --unix-socket`,
// so the IPC interface is uniform with the rename hook and human terminal use.
// The CLI resolves in the agent shell because main/pty.ts prepends the
// orchestra-owned bin dir (installAgentCliShim) to PATH, and it reads
// $ORCHESTRA_SOCK / $ORCHESTRA_WS_ID from the env to find the socket + identity.

const SPAWN_SKILL = `---
name: orchestra-spawn
description: Delegate independent work to a NEW parallel agent in a fresh git worktree. Use when the user asks to parallelize, delegate, or fan out a self-contained task that does not depend on the current uncommitted changes.
---

# Spawn a parallel agent

You can start a brand-new agent in its own git worktree, on a fresh branch cut
from the base branch. It begins working immediately and shares none of this
conversation's context, so the task must be a complete, standalone instruction.

Use this only for work that does NOT depend on your current uncommitted changes
— the new worktree is cut from the base branch and will not see them. Only spawn
when the user asks you to parallelize or delegate; do not do it unprompted.

Run this exact command (the \`orchestra\` CLI reads \$ORCHESTRA_SOCK /
\$ORCHESTRA_WS_ID from your env, and nests the new worktree under you):

\`\`\`bash
orchestra spawn --task "<full self-contained instructions for the new agent>"
\`\`\`

On success it prints \`Spawned <workspace-id> on branch <branch>\` once the
worktree exists and its agent has started; otherwise it prints an error and
exits non-zero.

Optional flags:
- \`--repo <abs path of another repo already added to orchestra>\` — spawn in a different repo.
- \`--base <branch>\` — cut the new branch from a specific base.
- \`--detached\` — create the workspace with NO parent, so it appears as its own
  top-level section grouped under its repo instead of nesting under you.
  Default to nesting (no flag). Pass \`--detached\` only when the user's request
  implies the new workspace is not yours to track — they asked for an
  "independent", "standalone", or "separate top-level" workspace. If genuinely
  ambiguous, ask.
`;

const COMMS_SKILL = `---
name: orchestra-comms
description: Coordinate with the OTHER agents running in sibling Orchestra workspaces — list them, read a peer's transcript, or send a peer a prompt. Use when the user asks you to coordinate agents, or to follow up on work you delegated to a spawned agent.
---

# Talk to sibling agents

Other agents may be running in sibling workspaces. You can discover them, read
what they have been doing, and hand one a prompt. Three \`orchestra\` CLI
commands (each reads \$ORCHESTRA_SOCK / \$ORCHESTRA_WS_ID from your env, so they
already know who you are). Keep any message self-contained — the peer does not
share your conversation.

## 1. List the other agents

\`\`\`bash
orchestra peers
\`\`\`

Prints a table of \`id  branch  repo  status\` (yourself excluded), or
\`No peer workspaces.\` when you are alone.

## 2. Read a peer's recent transcript

\`\`\`bash
orchestra read <peer-id>
\`\`\`

Prints the peer's branch then its last ~80 lines of transcript. Pass
\`--lines <n>\` (max 400) for more.

## 3. Send a peer a prompt

\`\`\`bash
orchestra message <peer-id> <your message...>
\`\`\`

Prints \`Delivered (live).\` if the peer was running, or \`Delivered (started).\`
if it was stopped and got woken to handle it now. The peer sees the message came
from you and can reply back to your workspace.
`;

const REPO_ROUTES_SKILL = `---
name: orchestra-repos
description: Manage Orchestra repos and workspaces over the socket — register a git repo so it becomes a spawn target, or hard-delete a workspace. Use when the user asks to add/register a repo to Orchestra or to delete a workspace.
---

# Manage repos and workspaces

Two \`orchestra\` CLI commands let you change what Orchestra tracks (each reads
\$ORCHESTRA_SOCK from your env).

## Register a git repo

Makes it appear in the app and become a spawn target. Pass an ABSOLUTE path (the
CLI resolves relative paths against your cwd):

\`\`\`bash
orchestra add-repo <absolute repo path>
\`\`\`

Prints \`Added repo <name> (<defaultBranch>) at <path>\` and the app's repo list
refreshes live; it errors if the path isn't a git repo.

## Delete a workspace

Stops its agent, runs its archive script, removes the git worktree + branch, and
drops it from the app. **Destructive and irreversible** — only do this when the
user explicitly asks to delete a workspace. The \`--yes\` flag is required (the
CLI refuses to delete without it):

\`\`\`bash
orchestra delete <workspace-id> --yes
\`\`\`

Prints \`Deleted workspace <id> (<branch>)\`, or errors with \`unknown workspace:
<id>\`.
`;

const PROMOTE_SKILL = `---
name: orchestra-promote
description: Promote THIS scratch session into an orchestrator — a coordinator that delegates work to child agents it spawns instead of editing code itself. Use when the user wants this repo-less scratch session to start orchestrating parallel agents.
---

# Promote this scratch session to an orchestrator

This applies ONLY to a **scratch** session (no repo, no branch). Promoting flips
it to an *orchestrator*: the app moves it into the sidebar's "Orchestrators"
section and nests every worktree you later spawn beneath it, so a whole fleet of
child agents is visible at a glance under this session.

Run this exact command (the \`orchestra\` CLI reads \$ORCHESTRA_SOCK /
\$ORCHESTRA_WS_ID from your env, so it promotes THIS session):

\`\`\`bash
orchestra promote "\$ORCHESTRA_WS_ID"
\`\`\`

Prints \`Promoted <id> (<branch>) to orchestrator\` on success (an
already-promoted session also succeeds), or errors — e.g. if this is a git
worktree, which can't be an orchestrator.

Once promoted, adopt the orchestrator role for the rest of this session:

${ORCHESTRATOR_BRIEF}

Use the \`orchestra-spawn\` skill for each \`/spawn\`, and \`orchestra-comms\` to
track and follow up with the agents you spawn.
`;

const ATTACH_SKILL = `---
name: orchestra-attach
description: Nest an EXISTING workspace under an orchestrator (or detach it back out). Use to pull a repo branch you did NOT spawn — one you or another agent created earlier — under this orchestrator so it groups beneath it in the sidebar.
---

# Attach / detach a workspace to an orchestrator

An orchestrator already groups the worktrees it spawns beneath itself. You can
ALSO pull an existing workspace — one that wasn't spawned by this orchestrator —
under it after the fact, or pop one back out to its own repo section. Both use
the \`orchestra\` CLI (reads \$ORCHESTRA_SOCK from your env).

The parent MUST be an orchestrator. If you don't have one yet, promote a scratch
session first with the \`orchestra-promote\` skill. Use \`orchestra-comms\`
(\`orchestra peers\`) to discover the ids of existing workspaces.

## Attach a workspace under an orchestrator

\`\`\`bash
orchestra attach <workspace-id> <orchestrator-id>
\`\`\`

Prints \`Attached <id> under orchestrator <parentId>\` and the sidebar re-nests it
live; it errors if an id is unknown, the parent isn't an orchestrator, or you
tried to parent a workspace under itself.

## Detach a workspace (back to its own section)

\`\`\`bash
orchestra detach <workspace-id>
\`\`\`

Prints \`Detached <id>\`.
`;

const RENAME_SKILL = `---
name: orchestra-rename
description: Rename THIS workspace's auto-generated git branch to a meaningful name. Use as soon as the work the conversation is about becomes clear, so the branch reflects the actual task.
---

# Rename this workspace's branch

A fresh Orchestra workspace starts on an auto-generated branch name (e.g.
\`radiant-fox\`). Rename it to a short kebab-case name (3-6 words) that reflects
the actual work, the moment that work is clear. Orchestra renames the real git
branch for you — do NOT run \`git branch -m\` yourself.

Run this exact command (the \`orchestra\` CLI reads \$ORCHESTRA_SOCK /
\$ORCHESTRA_WS_ID from your env, so it renames THIS workspace):

\`\`\`bash
orchestra rename "\$ORCHESTRA_WS_ID" "<new-branch-name>"
\`\`\`

Prints \`Renamed to <final-name>\` on success, or an error if the name was refused
(e.g. already taken). Examples: fix-checkout-typo, add-stripe-webhook-retry,
route-demande-accessoire.
`;

const MIGRATE_ACCOUNT_SKILL = `---
name: orchestra-migrate-account
description: Migrate an EXISTING Orchestra workspace to a different Claude account (login), or back to the default login. Use when the user wants a workspace's agent to run under another account — e.g. "move next-api to the mc login".
---

# Migrate a workspace to another account

Each Orchestra workspace runs its Claude agent under a pinned account (a separate
Claude Code config dir / login). This skill moves an EXISTING workspace to a
different account: Orchestra stops the agent, relocates its conversation into the
target account's config dir, re-pins it, and resumes the agent where it left off
(so \`claude --continue\` keeps working). It works for git workspaces as well as
scratch and orchestrator sessions.

## 1. Find the account id and the workspace id

List the configured accounts to get the target account's \`id\`:

\`\`\`bash
orchestra accounts
\`\`\`

Prints a table of \`id  label  configDir\`, or a note that none are configured
(everything is on the default login). Use \`orchestra peers\` (the
\`orchestra-comms\` skill) to find a workspace id if you don't have it.

## 2. Migrate the workspace

\`\`\`bash
orchestra migrate-account <workspace-id> <account-id>
\`\`\`

Prints \`Migrated <id> to <label> (resumed)\` on success — \`(resumed)\` appears
when the agent was running and was auto-resumed. To move a workspace back to the
default login instead, pass \`--default\`:

\`\`\`bash
orchestra migrate-account <workspace-id> --default
\`\`\`

Errors with \`unknown account: <id>\` or \`unknown workspace: <id>\` on a bad id,
or \`cannot migrate an archived workspace\` for an archived one.
`;

// Peer-gated, one-line re-surface of the comms capability on every
// UserPromptSubmit. The `orchestra-comms` skill's description is always in
// context, but skill descriptions are easy to overlook mid-conversation — so
// this fires a single terse pointer the moment a sibling agent actually exists,
// landing the capability in attention exactly when it becomes relevant. It
// stays SILENT while the agent is alone (no spam in solo sessions). The full
// command reference lives in the skill body, not here, so this costs ~1 line
// even when it does fire. It live-queries /peers and counts the peer entries
// with pure bash (no jq) — a query failure or empty list is a no-op.
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
echo "[orchestra] \$n other agent(s) are running in sibling workspaces. Use the \\\`orchestra-comms\\\` skill to list them, read a peer's transcript, or send one a prompt — when the user asks you to coordinate agents or to follow up on delegated work."
exit 0
`;

// Standing role reminder for orchestrator sessions. The orchestrator brief is
// injected once as an appended system prompt (and, on mid-session promotion,
// only ever existed as skill text inside the transcript) — both get summarized
// away by context compaction, after which the orchestrator starts editing code
// and "just handling" follow-ups itself instead of driving its children. This
// hook re-injects a compact version of the contract on every SessionStart —
// which fires on startup, resume, clear AND post-compaction, i.e. exactly when
// the role text was lost — so it survives indefinitely at a cost of one
// injection per context reset rather than one per turn.
// Gated two ways, mirroring the rename nudge's env+sentinel design: the
// ORCHESTRA_KIND env var (set per-pty at spawn — covers every orchestrator,
// including ones created before the sentinel existed) OR the .orchestrator
// worktree sentinel (written at creation and the instant /promote lands, so a
// just-promoted session picks the reminder up mid-session, before any pty
// restart refreshes its env).
const ORCHESTRATOR_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Re-asserts the orchestrator delegation contract
# on SessionStart (startup / resume / clear / post-compaction) so it survives
# context compaction. Self-silences unless this workspace is an orchestrator
# (env var from pty spawn, or the sentinel written when the session was
# created as / promoted to an orchestrator).
sentinel="\${ORCHESTRA_WORKTREE:-.}/.orchestra/.orchestrator"
[ "\${ORCHESTRA_KIND:-}" = "orchestrator" ] || [ -f "\$sentinel" ] || exit 0
cat <<'EOF'
[orchestra] Standing role reminder — you are an ORCHESTRATOR. You coordinate child agents; you do not implement. Do NOT edit code, fix bugs, or take over follow-up work yourself — not even a "quick" fix, and regardless of what earlier (possibly compacted-away) context said: delegate it. Route work in an area a child agent already owns back to THAT child (orchestra-comms skill: \`orchestra message <id> "<task>"\`); spawn a NEW agent for independent work (orchestra-spawn skill). Reserve your own turns for planning, delegating, tracking children (\`orchestra peers\`, \`orchestra read <id>\`), reviewing their results, and reporting to the user.
EOF
exit 0
`;

// Hard-enforcement companion to the reminder above, wired as a PreToolUse
// hook on the file-mutation tools (ORCHESTRATOR_GUARD_MATCHER). An
// orchestrator legitimately writes inside its own scratch worktree (plans,
// notes, handoffs) — what it must never do is edit files that belong to a
// CHILD workspace instead of delegating. So the guard denies (exit 2, stderr
// fed back to the agent) only when the target path is another workspace's
// worktree or scratch dir under ~/.orchestra, and allows everything else.
// Precision over reach: an allow-list approach (own worktree + tmp) would
// false-positive on memory writes, scratchpads, etc., and every false block
// teaches the agent to distrust the guard. Fail-open on any parse miss —
// enforcement is best-effort, never a brick.
const ORCHESTRATOR_GUARD_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Blocks an orchestrator from editing another
# workspace's files (it must delegate instead). No-op on non-orchestrator
# workspaces and outside orchestra.
sentinel="\${ORCHESTRA_WORKTREE:-.}/.orchestra/.orchestrator"
[ "\${ORCHESTRA_KIND:-}" = "orchestrator" ] || [ -f "\$sentinel" ] || exit 0

# Claude Code delivers the tool call as JSON on stdin; pull tool_input's
# file_path out with pure bash parameter expansion (no jq), same technique as
# orchestra-hook.sh. A parse miss yields an empty path → allow (fail-open).
input="\$(cat 2>/dev/null || true)"
fp=""
rest="\${input#*\\"file_path\\":}"
if [ "\$rest" != "\$input" ]; then
  rest="\${rest#*\\"}"
  fp="\${rest%%\\"*}"
fi
[ -n "\$fp" ] || exit 0
# Only judge absolute paths; a relative path resolves against an unknown cwd.
case "\$fp" in /*) : ;; *) exit 0 ;; esac
# The orchestrator's own worktree is always fine (notes, plans, handoffs).
own="\${ORCHESTRA_WORKTREE:-}"
if [ -n "\$own" ]; then
  case "\$fp" in "\$own"|"\$own"/*) exit 0 ;; esac
fi
# Another workspace's files → block and point back at delegation.
case "\$fp" in
  "\$HOME/.orchestra/worktrees/"*|"\$HOME/.orchestra/scratch/"*|"\$HOME/.orchestra-dev/worktrees/"*|"\$HOME/.orchestra-dev/scratch/"*)
    echo "[orchestra] BLOCKED: you are an ORCHESTRATOR and '\$fp' belongs to another workspace. Never edit a child's files directly — delegate: send the change to the child agent that owns that worktree (\\\`orchestra message <id> \\"<task>\\"\\\`, see orchestra-comms skill) or spawn a new agent for it (orchestra-spawn skill)." >&2
    exit 2
    ;;
esac
exit 0
`;

// Drains queued peer messages into the agent's context, then clears them. The
// main process writes pre-formatted message blocks (which already name the
// sender and show the reply command) into this file; the hook just prints and
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
//
// Every line carries a per-workspace MONOTONIC sequence number so the reader
// can apply events exactly once and in order: it skips any line whose seq it
// has already consumed (a duplicate inotify/poll race no longer re-fires the
// "finished" chime) and it can detect a gap rather than silently reorder. The
// counter lives in a sibling `<wsid>.seq` file bumped under `flock`, so the
// pretool/posttool/stop hooks that can fire microseconds apart each get a
// distinct, strictly-increasing value. If flock is unavailable we degrade to
// seq=0 on every line and the reader treats 0 as "unsequenced" — apply always,
// no dedup — i.e. exactly the old behavior, never worse.
const ORCHESTRA_HOOK_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Do not edit — rewritten on every workspace start.
dir="\${ORCHESTRA_EVENTS_DIR:-\$HOME/.orchestra/events}"
[ -n "\${ORCHESTRA_WS_ID:-}" ] || exit 0
event="\${1:-}"
[ -n "\$event" ] || exit 0

# Claude Code delivers the hook's event payload as JSON on stdin. We read it
# once (when present) and pull two values out with pure bash parameter
# expansion — no jq dependency: the active tool name (for the per-tool label)
# and the transcript path (so orchestra can compute the session's context size
# in TypeScript rather than parsing JSONL here, which would be fragile).
tool=""
transcript=""
case "\$event" in
  pretool|posttool|stop|notify|session)
    payload="\$(cat)"
    case "\$payload" in
      *'"tool_name"'*)
        rest="\${payload#*'"tool_name"'}"
        rest="\${rest#*:}"
        rest="\${rest#*'"'}"
        tool="\${rest%%'"'*}"
        ;;
    esac
    # SessionStart carries no tool; reuse the tool slot for its "source"
    # (startup|resume|clear|compact) so orchestra can tell a context-resetting
    # clear/compact apart from a plain startup without a new line format.
    if [ "\$event" = "session" ]; then
      case "\$payload" in
        *'"source"'*)
          rest="\${payload#*'"source"'}"
          rest="\${rest#*:}"
          rest="\${rest#*'"'}"
          tool="\${rest%%'"'*}"
          ;;
      esac
    fi
    case "\$payload" in
      *'"transcript_path"'*)
        rest="\${payload#*'"transcript_path"'}"
        rest="\${rest#*:}"
        rest="\${rest#*'"'}"
        transcript="\${rest%%'"'*}"
        ;;
    esac
    ;;
esac

mkdir -p "\$dir" 2>/dev/null || true
spool="\$dir/\$ORCHESTRA_WS_ID.jsonl"
seqf="\$dir/\$ORCHESTRA_WS_ID.seq"

# Atomically allocate the next sequence number. flock serializes concurrent
# hook processes so two events can't claim the same seq; the read-bump-write
# runs while holding an exclusive lock on the counter file's own fd. A missing
# flock leaves seq=0 — the reader applies unsequenced lines unconditionally, so
# we never block the agent or lose an event over it.
seq=0
if command -v flock >/dev/null 2>&1; then
  exec 9>>"\$seqf"
  if flock -w 2 9; then
    cur="\$(cat "\$seqf" 2>/dev/null)"
    case "\$cur" in ''|*[!0-9]*) cur=0 ;; esac
    seq=\$((cur + 1))
    printf '%s' "\$seq" >"\$seqf"
  fi
  exec 9>&-
fi

# JSON-escape the transcript path's two structurally-significant characters
# (backslash, then double-quote) so an unusual path can't corrupt the line the
# reader JSON.parses. Tool names are identifiers and need no escaping.
transcript="\${transcript//\\\\/\\\\\\\\}"
transcript="\${transcript//\\"/\\\\\\"}"

printf '{"seq":%s,"event":"%s","tool":"%s","transcript":"%s"}\\n' "\$seq" "\$event" "\$tool" "\$transcript" >> "\$spool"
exit 0
`;

function upsertHookCommand(list: unknown[], command: string): void {
  const present = list.some((entry) => {
    const inner = (entry as { hooks?: Array<{ command?: string }> })?.hooks ?? [];
    return inner.some((h) => h?.command === command);
  });
  if (!present) list.push({ hooks: [{ type: 'command', command }] });
}

/** Like {@link upsertHookCommand} but scopes the hook to specific tools via a
 * Claude Code `matcher` (e.g. `'Edit|Write'` on PreToolUse). Presence is keyed
 * on the command alone, so reinstalls never duplicate the entry — but that
 * also means changing the matcher later requires evicting the old entry
 * (removeHookCommand) before upserting. */
function upsertMatcherHookCommand(list: unknown[], matcher: string, command: string): void {
  const present = list.some((entry) => {
    const inner = (entry as { hooks?: Array<{ command?: string }> })?.hooks ?? [];
    return inner.some((h) => h?.command === command);
  });
  if (!present) list.push({ matcher, hooks: [{ type: 'command', command }] });
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
  // Heavy-resume gate: if `claude --continue` is about to reload a large
  // session, Claude Code shows its compaction menu — but a typed task would
  // proceed the FULL resume and drain the usage pool. Flag the workspace so
  // the `pty:write` handler suppresses submit keystrokes until the user
  // consciously drives CC's menu (a nav key clears it). Fail-open: detection
  // returning null leaves the flag unset, so normal resumes are untouched.
  if (resuming) {
    const tokens = await newestResumeTokenCount(ws);
    if (tokens != null && tokens >= HEAVY_RESUME_TOKEN_THRESHOLD) {
      ws = { ...ws, heavyResumePending: true };
      await store.upsertWorkspace(ws);
      if (!window.isDestroyed()) window.webContents.send('workspace:update', ws);
      log.info(`heavy-resume gate armed for ${ws.id}: ~${tokens} tokens`);
      // Safety auto-disarm: if our (deliberately low) threshold flagged a
      // session that CC does NOT actually prompt for, submits must not be
      // blocked forever. Clear the flag after a grace period; by then the menu
      // (if any) has been answered, or there was none. The nav-key path in
      // pty:write disarms sooner when the user does engage the menu.
      const gateId = ws.id;
      setTimeout(() => {
        const cur = store.getWorkspace(gateId);
        if (cur?.heavyResumePending) {
          const cleared = { ...cur, heavyResumePending: false };
          void store.upsertWorkspace(cleared);
          if (!window.isDestroyed()) window.webContents.send('workspace:update', cleared);
        }
      }, 90_000);
    } else if (ws.heavyResumePending) {
      // Clear a stale flag left over from a prior heavy resume that is no
      // longer heavy (e.g. the session was compacted/cleared since).
      ws = { ...ws, heavyResumePending: false };
      await store.upsertWorkspace(ws);
      if (!window.isDestroyed()) window.webContents.send('workspace:update', ws);
    }
  }
  // An orchestrator's standing brief shapes its behaviour without ever showing
  // up as a typed user turn: inject it as an appended system prompt on the
  // first launch only. On resume, Claude Code restores the original session's
  // system prompt, so re-appending would duplicate it. Durable enforcement of
  // the role (surviving compaction, resume, and mid-session promotion) is the
  // orchestrator-instruction hook, re-fired on every prompt — this one-time
  // brief is just the richer onboarding.
  if (!resuming && ws.kind === 'orchestrator') {
    claudeArgs.push('--append-system-prompt', ORCHESTRATOR_BRIEF);
  }
  // Hook installation writes into the worktree's .claude/. For a local
  // workspace that's this machine's worktree; for a sandbox workspace the
  // worktree lives in the container, so the hooks are installed sandbox-side
  // (baked/installed when the workspace is provisioned there), not from here.
  const remote = ws.host?.kind === 'sandbox';
  // Idempotent: upgrades workspaces created before the activity hook landed.
  if (!remote) await installOrchestraHooks(ws.worktreePath);
  // Materialize the pinned account's inherited global config into its login dir
  // right before spawn, so the agent sees the user's settings/skills/MCP. Pinned
  // account only (resolveRepoAgentEnv uses the same pin for CLAUDE_CONFIG_DIR).
  if (ws.accountId) {
    const account = store.accounts.find((a) => a.id === ws.accountId);
    if (account) {
      await syncAccountInheritance(account).catch((err) =>
        log.warn(`account-inherit: spawn-time sync failed for ${ws.id}`, err),
      );
    }
  }
  // Expose the current branch and auto-rename gate to hooks. The SessionStart
  // hook reads ORCHESTRA_BRANCH_AUTO=1 to decide whether to inject the
  // rename-instruction context, and ORCHESTRA_AUTO_RENAME_COUNT to pick the
  // stage-appropriate wording. The gate stays on while a human hasn't pinned
  // the name and the agent has auto-renames left (see `autoRenameActive`), so
  // the instruction keeps re-surfacing across the two progressive renames and
  // clears on the next pty:start once the budget is spent.
  const extraEnv: Record<string, string> = {
    // Per-repo env first so Orchestra's own vars below always take precedence.
    ...resolveRepoAgentEnv(ws),
    ORCHESTRA_BRANCH: ws.branch,
    ORCHESTRA_BRANCH_AUTO: autoRenameActive(ws) ? '1' : '0',
    ORCHESTRA_AUTO_RENAME_COUNT: String(ws.autoRenameCount ?? 0),
    // Read by the orchestrator-instruction hook (with the .orchestrator
    // sentinel as the mid-session-promotion fallback) to gate the standing
    // delegation reminder to orchestrator sessions only.
    ORCHESTRA_KIND: ws.kind ?? 'worktree',
  };
  // A pinned account's CLAUDE_CONFIG_DIR is a HOST path; shipped to a sandbox
  // it points at nothing and would shadow the container's seeded ~/.claude
  // (leaving the agent logged out). The import already packed the account's
  // login/config INTO that ~/.claude, so remote agents always use the default
  // location.
  if (remote) delete extraEnv.CLAUDE_CONFIG_DIR;
  await startPty({
    id: ws.id,
    // The sandbox mounts the worktree at the fixed /workspace path (the
    // Dockerfile's WORKDIR); Claude keys its session by cwd, so this must match
    // across runs. Local spawns use the real worktree path on this machine.
    cwd: remote ? SANDBOX_WORKSPACE_DIR : ws.worktreePath,
    command: 'claude',
    args: claudeArgs,
    cols,
    rows,
    window,
    workspaceId: ws.id,
    extraEnv,
    host: ws.host,
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
  // Resume agents concurrently rather than one-at-a-time. Each spawn awaits a
  // full hook install + node-pty fork; serialized, N previously-running
  // workspaces stacked their spawn latencies on the startup path. They're fully
  // independent and already per-workspace isolated, so fan them out.
  await Promise.all(
    ids.map(async (id) => {
      const ws = store.getWorkspace(id);
      if (!ws || ws.archived) return;
      if (isRunning(id)) return; // already live (shouldn't happen this early)
      if (!existsSync(ws.worktreePath)) {
        log.warn(`resume skipped: worktree missing id=${id} path=${ws.worktreePath}`);
        return;
      }
      try {
        await startAgentPty(ws, RESUME_COLS, RESUME_ROWS, window);
        log.info(`resumed agent id=${id} branch=${ws.branch}`);
      } catch (e) {
        log.warn(`resume failed id=${id}`, e);
      }
    }),
  );
}

// Version sentinel for the hook bundle: a hash over every script body and
// every hook command the installer writes. When this matches the stamp a
// workspace already carries, installOrchestraHooks short-circuits — turning the
// ~17-syscall-per-spawn install into a single readFile. Any edit to the scripts
// or commands below changes the digest and forces exactly one reinstall.
const HOOKS_VERSION = createHash('sha256')
  .update(
    [
      RENAME_INSTRUCTION_SCRIPT,
      ORCHESTRA_HOOK_SCRIPT,
      COMMS_RESURFACE_SCRIPT,
      INBOX_INSTRUCTION_SCRIPT,
      ORCHESTRATOR_INSTRUCTION_SCRIPT,
      ORCHESTRATOR_GUARD_SCRIPT,
      SPAWN_SKILL,
      COMMS_SKILL,
      REPO_ROUTES_SKILL,
      PROMOTE_SKILL,
      ATTACH_SKILL,
      RENAME_SKILL,
      MIGRATE_ACCOUNT_SKILL,
      HOOK_ACTIVITY_SUBMIT_CMD,
      HOOK_ACTIVITY_STOP_CMD,
      HOOK_ACTIVITY_NOTIFY_CMD,
      HOOK_ACTIVITY_PRETOOL_CMD,
      HOOK_ACTIVITY_POSTTOOL_CMD,
      HOOK_ACTIVITY_SESSION_CMD,
      HOOK_SESSION_START_READY_CMD,
      HOOK_SESSION_START_RENAME_CMD,
      HOOK_COMMS_RESURFACE_CMD,
      HOOK_INBOX_DELIVER_CMD,
      HOOK_ORCHESTRATOR_INSTRUCTION_CMD,
      HOOK_ORCHESTRATOR_GUARD_CMD,
      ORCHESTRATOR_GUARD_MATCHER,
    ].join(' '),
  )
  .digest('hex');

export async function installOrchestraHooks(
  worktreePath: string,
): Promise<void> {
  try {
    const dir = path.join(worktreePath, '.orchestra');
    await mkdir(dir, { recursive: true });
    const gitignore = path.join(dir, '.gitignore');
    if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');

    // The script bodies are compile-time constants, identical for every
    // workspace, so re-writing all 8 files + merging settings.json on every
    // single spawn/resume is pure waste. Stamp a version sentinel (a hash of
    // the whole hook bundle) into .orchestra/ and skip the entire install when
    // it already matches — the common case for an existing workspace. Any edit
    // to the scripts or hook commands changes the hash and forces one rewrite.
    const stamp = path.join(dir, '.hooks-version');
    if (existsSync(stamp)) {
      try {
        if ((await readFile(stamp, 'utf8')).trim() === HOOKS_VERSION) return;
      } catch {
        /* unreadable stamp — fall through and reinstall */
      }
    }

    // Idempotent: rewrite the scripts every (real) install so updates to the
    // instruction text propagate to existing workspaces. Write all 8 in
    // parallel with the executable mode baked in — dropping the 8 separate
    // chmod round-trips that doubled the syscall count here.
    const w = (name: string, body: string) =>
      writeFile(path.join(dir, name), body, { mode: 0o755 });
    await Promise.all([
      w('rename-instruction.sh', RENAME_INSTRUCTION_SCRIPT),
      w('orchestra-hook.sh', ORCHESTRA_HOOK_SCRIPT),
      w('comms-resurface.sh', COMMS_RESURFACE_SCRIPT),
      w('inbox-instruction.sh', INBOX_INSTRUCTION_SCRIPT),
      w('orchestrator-instruction.sh', ORCHESTRATOR_INSTRUCTION_SCRIPT),
      w('orchestrator-guard.sh', ORCHESTRATOR_GUARD_SCRIPT),
    ]);

    // Evict the per-session capability instruction scripts + the ungated spawn
    // resurface — superseded by the capability skills below. Best-effort: a
    // missing file is fine (fresh workspace or already cleaned).
    await Promise.all(
      ['spawn-instruction.sh', 'comms-instruction.sh', 'repo-routes-instruction.sh', 'spawn-resurface.sh'].map(
        (f) => rm(path.join(dir, f), { force: true }),
      ),
    );

    // Capability skills. Each lands at <worktree>/.claude/skills/<name>/SKILL.md
    // and is auto-discovered by Claude Code — only the one-line description
    // loads up front; the body (with the exact CLI invocation) loads on demand.
    const skillsDir = path.join(worktreePath, '.claude', 'skills');
    const writeSkill = async (name: string, body: string) => {
      const d = path.join(skillsDir, name);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, 'SKILL.md'), body);
    };
    await Promise.all([
      writeSkill('orchestra-spawn', SPAWN_SKILL),
      writeSkill('orchestra-comms', COMMS_SKILL),
      writeSkill('orchestra-repos', REPO_ROUTES_SKILL),
      writeSkill('orchestra-promote', PROMOTE_SKILL),
      writeSkill('orchestra-attach', ATTACH_SKILL),
      writeSkill('orchestra-rename', RENAME_SKILL),
      writeSkill('orchestra-migrate-account', MIGRATE_ACCOUNT_SKILL),
    ]);

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

    // Evict the retired capability hooks from any pre-upgrade workspace: the
    // three full-prose SessionStart instruction scripts and the ungated
    // per-turn spawn resurface, all superseded by the capability skills. Their
    // .sh files are removed above; this drops their hook wiring so they stop
    // firing on already-installed worktrees.
    const isRetiredCapabilityCmd = (cmd: string) =>
      cmd.includes('.orchestra/spawn-instruction.sh') ||
      cmd.includes('.orchestra/comms-instruction.sh') ||
      cmd.includes('.orchestra/repo-routes-instruction.sh') ||
      cmd.includes('.orchestra/spawn-resurface.sh');

    // Evict the legacy first-prompt.json writer from any pre-upgrade workspace
    // so prompts no longer get dumped to disk after this hook system landed.
    let submitList = ((hooks.UserPromptSubmit as unknown[]) ??= []);
    submitList = removeHookCommand(submitList, (cmd) => cmd.includes('.orchestra/first-prompt.json'));
    submitList = removeHookCommand(submitList, isStaleRenameCmd);
    submitList = removeHookCommand(submitList, isLegacyActivityCurl);
    submitList = removeHookCommand(submitList, isRetiredCapabilityCmd);
    upsertHookCommand(submitList, HOOK_ACTIVITY_SUBMIT_CMD);
    // Re-surface the branch-rename nudge on every prompt while still on the
    // auto branch (the script self-gates), so the agent gets reminded once the
    // work scope is clear — not only at the context-free SessionStart.
    upsertHookCommand(submitList, HOOK_SESSION_START_RENAME_CMD);
    // Re-surface the comms capability each turn, but only when a sibling agent
    // actually exists (the script self-silences otherwise). Spawn no longer has
    // a per-turn reminder: its skill description is always in context, and an
    // ungated every-turn line was pure compounding cost in solo sessions.
    upsertHookCommand(submitList, HOOK_COMMS_RESURFACE_CMD);
    // Surface any queued peer messages right before the agent's next turn.
    upsertHookCommand(submitList, HOOK_INBOX_DELIVER_CMD);
    // The orchestrator reminder is deliberately NOT on UserPromptSubmit (a
    // per-turn injection compounds in the transcript); it lives on
    // SessionStart, and the PreToolUse guard enforces between resets. Evict
    // the per-turn wiring from any workspace that got it from a dev build.
    submitList = removeHookCommand(submitList, (cmd) =>
      cmd.includes('.orchestra/orchestrator-instruction.sh'),
    );
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
    // Orchestrator hard-guard: deny file edits that reach into another
    // workspace (the script self-silences on non-orchestrator workspaces).
    // Zero token cost until it fires, unlike an injected reminder.
    upsertMatcherHookCommand(preToolList, ORCHESTRATOR_GUARD_MATCHER, HOOK_ORCHESTRATOR_GUARD_CMD);
    hooks.PreToolUse = preToolList;

    const postToolList = ((hooks.PostToolUse as unknown[]) ??= []);
    upsertHookCommand(postToolList, HOOK_ACTIVITY_POSTTOOL_CMD);
    hooks.PostToolUse = postToolList;

    let sessionStartList = ((hooks.SessionStart as unknown[]) ??= []);
    sessionStartList = removeHookCommand(sessionStartList, isStaleRenameCmd);
    // Evict the retired full-prose capability advertisements (now skills).
    sessionStartList = removeHookCommand(sessionStartList, isRetiredCapabilityCmd);
    // Readiness sentinel first, so the "TUI is live" signal fires as early as
    // possible in the SessionStart fan-out rather than after the instruction
    // prints.
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_READY_CMD);
    // Activity spool line for session starts: a clear/compact source resets
    // the context-size badge that would otherwise stay stale until turn-end.
    upsertHookCommand(sessionStartList, HOOK_ACTIVITY_SESSION_CMD);
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_RENAME_CMD);
    upsertHookCommand(sessionStartList, HOOK_INBOX_DELIVER_CMD);
    upsertHookCommand(sessionStartList, HOOK_ORCHESTRATOR_INSTRUCTION_CMD);
    hooks.SessionStart = sessionStartList;

    settings.hooks = hooks;
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));

    // Record the installed bundle version last, so a crash mid-install leaves
    // a missing/stale stamp and the next spawn redoes the work.
    await writeFile(path.join(worktreePath, '.orchestra', '.hooks-version'), HOOKS_VERSION).catch(
      () => {},
    );
  } catch {
    /* best-effort */
  }
}
