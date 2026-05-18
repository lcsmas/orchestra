import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BrowserWindow, shell } from 'electron';
import { execFile } from 'node:child_process';
import { store } from './store';
import {
  createWorktree,
  removeWorktree,
  renameWorktreeBranch,
  switchWorktreeBranch,
} from './git';
import { isRunning, stopPty, clearScrollback } from './pty';
import { buildScriptEnv, runOneShot, setupLogPath, archiveLogPath } from './scripts';
import type { CreateWorkspaceInput, Workspace } from '../shared/types';

const ORCHESTRA_ROOT = path.join(os.homedir(), '.orchestra', 'worktrees');

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

  await createWorktree(input.repoPath, branch, baseBranch, worktreePath);
  await installOrchestraHooks(worktreePath, agent);

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
    void runSetupScript(id, window).catch(() => {
      /* runSetupScript already persists `failed`; nothing to do here. */
    });
  }

  // Do NOT spawn the agent PTY here. The renderer's TerminalView will invoke
  // `pty:start` once the terminal container has real dimensions, so the agent
  // is spawned at the correct cols/rows instead of a fixed default that would
  // mis-wrap its opening TUI frames. The `lastTask` stored on the workspace
  // is piped in from the pty:start handler on the first-ever spawn.
  return ws;
}

export async function archiveWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
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
  // Hard delete: stop agent, run user's archive script (best-effort), remove
  // the git worktree from disk, drop the scrollback log, and remove the store
  // record. Archive script runs BEFORE worktree removal so it can still see
  // the files / cwd.
  stopPty(id);
  stopPty(`${id}:run`);
  stopPty(`${id}:nvim`);

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
  try {
    await removeWorktree(ws.repoPath, ws.worktreePath);
  } catch {
    /* best-effort */
  }
  await store.removeWorkspace(id);
  window.webContents.send('workspace:removed', id);
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
  if (newBranch === ws.branch) {
    if (opts.manual && !ws.branchManuallySet) {
      const updated = { ...ws, branchManuallySet: true };
      await store.upsertWorkspace(updated);
      window.webContents.send('workspace:update', updated);
      return updated;
    }
    return ws;
  }
  const repoName = path.basename(ws.repoPath);
  await renameWorktreeBranch(ws.worktreePath, ws.branch, newBranch);

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

/** Handle a rename request coming from the agent via the hooks-server socket.
 * Locks the branch after a successful rename so the SessionStart instruction
 * stops firing (one rename per workspace lifetime). Silent no-op if the
 * branch is already user-set or the requested name is invalid — the agent
 * doesn't get error feedback from the socket call, so we just refuse. */
export async function dispatchRenameRequest(
  id: string,
  rawNewBranch: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.branchManuallySet) return;
  try {
    await renameWorkspaceBranch(id, rawNewBranch, { manual: true }, window);
  } catch {
    /* invalid name, branch conflict — silently ignore */
  }
}

function sanitizeBranchName(raw: string): string {
  // Keep the same allow-list used when creating worktree paths.
  return raw.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._/-]/g, '').slice(0, 80);
}

/** Switch the workspace to an existing branch. The worktree dir stays put —
 * branch is just a property. Stops any running agent/nvim so they respawn
 * against the new branch's files (any in-memory state from the old branch
 * would be stale), then emits `pty:restart`. */
export async function switchWorkspaceBranch(
  id: string,
  branch: string,
  window: BrowserWindow,
): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.branch === branch) return ws;
  const nvimId = `${id}:nvim`;
  const restartAgent = isRunning(id);
  const restartNvim = isRunning(nvimId);
  stopPty(id);
  stopPty(nvimId);
  clearScrollback(id);

  await switchWorktreeBranch(ws.worktreePath, branch);

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
// 2. Activity tracking. UserPromptSubmit + Stop + Notification hooks POST
//    `{id, event}` to the orchestra hooks-server's Unix socket so workspace
//    status flips running ↔ waiting from Claude's own lifecycle events. Hook
//    commands are env-guarded with `[ -n "$ORCHESTRA_SOCK" ]` so they're a
//    silent no-op when claude is run outside orchestra.
//
// Codex has no equivalent hook system, so its workspaces keep their
// auto-generated random branch names and rely on the agent process exit for
// status (currently unimplemented for codex).

const HOOK_ACTIVITY_SUBMIT_CMD =
  '[ -n "$ORCHESTRA_SOCK" ] && curl -s --max-time 1 --unix-socket "$ORCHESTRA_SOCK" -d \'{"id":"\'"$ORCHESTRA_WS_ID"\'","event":"submit"}\' http://x/event > /dev/null 2>&1 || true';

const HOOK_ACTIVITY_STOP_CMD =
  '[ -n "$ORCHESTRA_SOCK" ] && curl -s --max-time 1 --unix-socket "$ORCHESTRA_SOCK" -d \'{"id":"\'"$ORCHESTRA_WS_ID"\'","event":"stop"}\' http://x/event > /dev/null 2>&1 || true';

const HOOK_ACTIVITY_NOTIFY_CMD =
  '[ -n "$ORCHESTRA_SOCK" ] && curl -s --max-time 1 --unix-socket "$ORCHESTRA_SOCK" -d \'{"id":"\'"$ORCHESTRA_WS_ID"\'","event":"notify"}\' http://x/event > /dev/null 2>&1 || true';

// SessionStart hook delegates to a small shell script we drop into the
// worktree. Inlining the multi-line instruction in a single JSON-encoded
// hook command requires brutal quote-escaping, and a script file is far
// easier to read and modify. Path is relative to the agent's cwd (worktree).
const HOOK_SESSION_START_RENAME_CMD = 'bash .orchestra/rename-instruction.sh';

const RENAME_INSTRUCTION_SCRIPT = `#!/usr/bin/env bash
# Auto-installed by orchestra. Prints a one-time rename instruction into the
# agent's session context when the workspace is still on its auto-generated
# branch. Gated on ORCHESTRA_BRANCH_AUTO=1, which orchestra only sets when
# the branch has not yet been renamed by the user or the agent.
[ "\${ORCHESTRA_BRANCH_AUTO:-0}" = "1" ] || exit 0
[ -n "\${ORCHESTRA_SOCK:-}" ] || exit 0
cat <<EOF
[orchestra] This workspace is on the auto-generated branch '\${ORCHESTRA_BRANCH:-unknown}'. Once you understand the specific work this conversation is about, rename the branch by running this exact command (do NOT use 'git branch -m'):

  curl -s --max-time 2 --unix-socket "\\\$ORCHESTRA_SOCK" --data-binary "{\\\\"id\\\\":\\\\"\\\$ORCHESTRA_WS_ID\\\\",\\\\"branch\\\\":\\\\"<new-branch-name>\\\\"}" http://x/rename

Pick a short kebab-case name (3-6 words) that reflects the actual work, e.g. fix-checkout-typo, add-stripe-webhook-retry, route-demande-accessoire. Do this proactively the moment the scope is clear — not on the first prompt if the prompt is exploratory.
EOF
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

export async function installOrchestraHooks(
  worktreePath: string,
  agent: 'claude' | 'codex',
): Promise<void> {
  if (agent !== 'claude') return;
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

    // Evict the legacy first-prompt.json writer from any pre-upgrade workspace
    // so prompts no longer get dumped to disk after this hook system landed.
    let submitList = ((hooks.UserPromptSubmit as unknown[]) ??= []);
    submitList = removeHookCommand(submitList, (cmd) => cmd.includes('.orchestra/first-prompt.json'));
    upsertHookCommand(submitList, HOOK_ACTIVITY_SUBMIT_CMD);
    hooks.UserPromptSubmit = submitList;

    const stopList = ((hooks.Stop as unknown[]) ??= []);
    upsertHookCommand(stopList, HOOK_ACTIVITY_STOP_CMD);
    hooks.Stop = stopList;

    // Claude's Notification hook fires when the agent needs the user's
    // attention — most commonly the 60s-idle "waiting for your input"
    // reminder, occasionally a tool-permission prompt (rare with
    // --dangerously-skip-permissions but possible). Drives a louder OS
    // notification than the gentle Stop chime.
    const notifyList = ((hooks.Notification as unknown[]) ??= []);
    upsertHookCommand(notifyList, HOOK_ACTIVITY_NOTIFY_CMD);
    hooks.Notification = notifyList;

    const sessionStartList = ((hooks.SessionStart as unknown[]) ??= []);
    upsertHookCommand(sessionStartList, HOOK_SESSION_START_RENAME_CMD);
    hooks.SessionStart = sessionStartList;

    settings.hooks = hooks;
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  } catch {
    /* best-effort */
  }
}

export async function openInEditor(id: string, editor: 'code' | 'cursor'): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  try {
    execFile(editor, [ws.worktreePath], (err) => {
      if (err) shell.openPath(ws.worktreePath);
    });
  } catch {
    shell.openPath(ws.worktreePath);
  }
}
