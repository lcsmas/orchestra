import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, watch, type FSWatcher } from 'node:fs';
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
import { clearActivity } from './activity';
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
  await installFirstPromptHook(worktreePath, agent);

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
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);
  startBranchNameWatcher(ws, window);

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
  stopPty(`${id}:nvim`);
  clearActivity(id);
  stopBranchNameWatcher(id);
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
  startBranchNameWatcher(updated, window);
}

export async function deleteWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  // Hard delete: stop agent, remove the git worktree from disk, drop the
  // scrollback log, and remove the store record.
  stopPty(id);
  stopPty(`${id}:nvim`);
  clearActivity(id);
  stopBranchNameWatcher(id);
  clearScrollback(id);
  try {
    await removeWorktree(ws.repoPath, ws.worktreePath);
  } catch {
    /* best-effort */
  }
  await store.removeWorkspace(id);
  window.webContents.send('workspace:removed', id);
}

// ---------- Branch rename ----------

/** Rename the branch on a workspace. The worktree dir stays put — branch is
 * just a property of the workspace, not its identity. `manual` is true when
 * the user typed the name themselves and sets the `branchManuallySet` latch
 * so the agent's auto-rename suggestion stops firing. Stops any running
 * agent/nvim and emits `pty:restart` so they respawn against the renamed
 * branch (HEAD is the same commit, but their internal state is reset). */
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
  const nvimId = `${id}:nvim`;
  const restartAgent = isRunning(id);
  const restartNvim = isRunning(nvimId);
  stopBranchNameWatcher(ws.id);
  stopPty(id);
  stopPty(nvimId);
  await renameWorktreeBranch(ws.worktreePath, ws.branch, newBranch);

  const updated: Workspace = {
    ...ws,
    branch: newBranch,
    name: `${repoName} · ${newBranch}`,
    branchManuallySet: opts.manual || ws.branchManuallySet,
  };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
  startBranchNameWatcher(updated, window);
  if (restartAgent) window.webContents.send('pty:restart', id);
  if (restartNvim) window.webContents.send('pty:restart', nvimId);
  return updated;
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
  clearActivity(id);
  clearScrollback(id);
  stopBranchNameWatcher(id);

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
  startBranchNameWatcher(updated, window);
  if (restartAgent) window.webContents.send('pty:restart', id);
  if (restartNvim) window.webContents.send('pty:restart', nvimId);
  return updated;
}

// ---------- First-prompt branch rename ----------
//
// On workspace creation we install a Claude `UserPromptSubmit` hook into
// `<worktree>/.claude/settings.local.json`. The hook dumps the prompt JSON
// into `<worktree>/.orchestra/first-prompt.json` exactly once (subsequent
// prompts short-circuit because the file already exists). A watcher in the
// main process picks that up, runs `claude -p` headlessly to suggest a
// kebab-case branch name from the user's message, and renames the branch +
// worktree. After the rename we lock the branch (`branchManuallySet=true`)
// so this fires at most once per workspace lifetime. Codex has no equivalent
// hook so its workspaces keep their auto-generated random names.

const HOOK_COMMAND =
  "sh -c '[ -f .orchestra/first-prompt.json ] && exit 0; mkdir -p .orchestra && cat > .orchestra/first-prompt.json'";

const watchers = new Map<string, FSWatcher>();

async function installFirstPromptHook(
  worktreePath: string,
  agent: 'claude' | 'codex',
): Promise<void> {
  if (agent !== 'claude') return;
  try {
    const dir = path.join(worktreePath, '.orchestra');
    await mkdir(dir, { recursive: true });
    const gitignore = path.join(dir, '.gitignore');
    if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');

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
    const list = ((hooks.UserPromptSubmit as unknown[]) ??= []);
    const alreadyInstalled = list.some((entry) => {
      const inner = (entry as { hooks?: Array<{ command?: string }> })?.hooks ?? [];
      return inner.some((h) => h?.command === HOOK_COMMAND);
    });
    if (!alreadyInstalled) {
      list.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
    }
    hooks.UserPromptSubmit = list;
    settings.hooks = hooks;
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  } catch {
    /* best-effort */
  }
}

export function startBranchNameWatcher(ws: Workspace, window: BrowserWindow): void {
  stopBranchNameWatcher(ws.id);
  if (ws.branchManuallySet) return;
  if (ws.agent !== 'claude') return;
  const dir = path.join(ws.worktreePath, '.orchestra');
  try {
    if (!existsSync(dir)) return;
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== 'first-prompt.json') return;
      void handleFirstPrompt(ws.id, window);
    });
    watchers.set(ws.id, watcher);
    // Fire once in case the file appeared before we attached.
    void handleFirstPrompt(ws.id, window);
  } catch {
    /* watcher is best-effort */
  }
}

export function stopBranchNameWatcher(id: string): void {
  const w = watchers.get(id);
  if (!w) return;
  try {
    w.close();
  } catch {
    /* noop */
  }
  watchers.delete(id);
}

const pending = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

async function handleFirstPrompt(id: string, window: BrowserWindow): Promise<void> {
  // Debounce: the hook writes via `cat >` which may emit multiple change
  // events. Coalesce to one read per 200 ms quiet window.
  const existing = pending.get(id);
  if (existing) clearTimeout(existing);
  pending.set(
    id,
    setTimeout(async () => {
      pending.delete(id);
      if (inFlight.has(id)) return;
      const ws = store.getWorkspace(id);
      if (!ws || ws.archived || ws.branchManuallySet) return;
      const file = path.join(ws.worktreePath, '.orchestra', 'first-prompt.json');
      let prompt = '';
      try {
        const raw = (await readFile(file, 'utf8')).trim();
        const json = JSON.parse(raw) as { prompt?: unknown };
        prompt = String(json.prompt ?? '').trim();
      } catch {
        return;
      }
      if (!prompt) return;
      inFlight.add(id);
      try {
        const suggested = await suggestBranchName(prompt);
        if (!suggested) return;
        const sanitized = sanitizeBranchName(suggested);
        if (!sanitized || sanitized === ws.branch) return;
        const fresh = store.getWorkspace(id);
        if (!fresh || fresh.branchManuallySet) return;
        // Lock the branch after auto-rename so this fires at most once.
        await renameWorkspaceBranch(id, sanitized, { manual: true }, window);
      } catch {
        /* ignore — branch conflict, user already renamed, claude unavailable */
      } finally {
        inFlight.delete(id);
        try {
          await unlink(file);
        } catch {
          /* noop */
        }
      }
    }, 200),
  );
}

function suggestBranchName(userMessage: string): Promise<string | null> {
  return new Promise((resolve) => {
    const promptText = `Suggest a short kebab-case git branch name (3-5 words, lowercase, hyphen-separated) that describes the work the user is asking for. Output ONLY the branch name on a single line. No quotes, no commentary.\n\nUser request:\n${userMessage}`;
    execFile(
      'claude',
      ['-p', promptText],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const last = stdout
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        resolve(last || null);
      },
    );
  });
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
