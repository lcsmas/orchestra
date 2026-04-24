import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { BrowserWindow, shell } from 'electron';
import { execFile } from 'node:child_process';
import { store } from './store';
import { createWorktree, removeWorktree, renameWorktreeBranch } from './git';
import { stopPty, clearScrollback } from './pty';
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
  const branch = input.branch || randomBranchName();
  const agent = input.agent ?? 'claude';
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const worktreePath = path.join(ORCHESTRA_ROOT, `${repoName}-${safeBranch}-${id.slice(0, 8)}`);

  await createWorktree(input.repoPath, branch, baseBranch, worktreePath);
  // If the user passed an explicit branch name, lock it against auto-rename.
  const manuallySet = Boolean(input.branch);
  await installBranchSuggestionHint(worktreePath, agent);

  const ws: Workspace = {
    id,
    name: `${repoName} · ${branch}`,
    repoPath: input.repoPath,
    worktreePath,
    branch,
    baseBranch,
    createdAt: Date.now(),
    status: 'waiting',
    agent,
    lastTask: input.task,
    branchManuallySet: manuallySet,
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

/** Rename the branch (and move the worktree dir to match) for a workspace.
 * `manual` is true when the user typed the name themselves — it sets the
 * `branchManuallySet` latch so Claude's auto-rename stops firing.
 * Returns the updated workspace. */
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
  const newWorktreePath = path.join(
    ORCHESTRA_ROOT,
    `${repoName}-${newBranch}-${ws.id.slice(0, 8)}`,
  );
  // Stop watcher during the move — the directory vanishes mid-rename.
  stopBranchNameWatcher(ws.id);
  await renameWorktreeBranch(ws.worktreePath, newWorktreePath, ws.branch, newBranch);

  const updated: Workspace = {
    ...ws,
    branch: newBranch,
    worktreePath: newWorktreePath,
    name: `${repoName} · ${newBranch}`,
    branchManuallySet: opts.manual || ws.branchManuallySet,
  };
  await store.upsertWorkspace(updated);
  window.webContents.send('workspace:update', updated);
  startBranchNameWatcher(updated, window);
  return updated;
}

function sanitizeBranchName(raw: string): string {
  // Keep the same allow-list used when creating worktree paths.
  return raw.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._/-]/g, '').slice(0, 80);
}

// ---------- Claude/Codex suggestion file watcher ----------
//
// Orchestra asks the agent (via a CLAUDE.md instruction we inject on create)
// to write a proposed branch name to `<worktree>/.orchestra/branch-name`. We
// watch for that file; when it appears and the user hasn't already locked a
// name, we rename the branch + worktree to match.

const watchers = new Map<string, FSWatcher>();

async function installBranchSuggestionHint(
  worktreePath: string,
  agent: 'claude' | 'codex',
): Promise<void> {
  const hint = `

## Orchestra: proposing a branch name

This workspace was created with an auto-generated branch name. Once you
understand what the user is building (usually within the first couple of
exchanges), write a short kebab-case branch name that describes the work
to \`.orchestra/branch-name\` in this worktree. Example:

    mkdir -p .orchestra && printf '%s\\n' 'add-oauth-login' > .orchestra/branch-name

Keep it concise (3–5 words), lowercase, hyphen-separated. Orchestra will
rename the git branch and worktree dir automatically — but only until the
user renames it themselves, at which point Orchestra ignores further writes.
`;
  try {
    const dir = path.join(worktreePath, '.orchestra');
    await mkdir(dir, { recursive: true });
    const gitignore = path.join(dir, '.gitignore');
    if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');
    const claudeFile = path.join(
      worktreePath,
      agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md',
    );
    const existing = existsSync(claudeFile) ? await readFile(claudeFile, 'utf8') : '';
    if (!existing.includes('Orchestra: proposing a branch name')) {
      await appendFile(claudeFile, (existing ? '' : '# Agent notes\n') + hint);
    }
  } catch {
    /* best-effort — instructions help but aren't required */
  }
}

export function startBranchNameWatcher(ws: Workspace, window: BrowserWindow): void {
  stopBranchNameWatcher(ws.id);
  if (ws.branchManuallySet) return;
  const dir = path.join(ws.worktreePath, '.orchestra');
  try {
    if (!existsSync(dir)) return;
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== 'branch-name') return;
      void handleBranchSuggestion(ws.id, window);
    });
    watchers.set(ws.id, watcher);
    // Fire once immediately in case the file was created before we attached.
    void handleBranchSuggestion(ws.id, window);
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

let pending = new Map<string, NodeJS.Timeout>();
async function handleBranchSuggestion(id: string, window: BrowserWindow): Promise<void> {
  // Debounce: the agent may write + truncate + write again. Coalesce to one
  // rename per 400 ms quiet window.
  const existing = pending.get(id);
  if (existing) clearTimeout(existing);
  pending.set(
    id,
    setTimeout(async () => {
      pending.delete(id);
      const ws = store.getWorkspace(id);
      if (!ws || ws.archived || ws.branchManuallySet) return;
      const file = path.join(ws.worktreePath, '.orchestra', 'branch-name');
      let suggested = '';
      try {
        suggested = (await readFile(file, 'utf8')).trim();
      } catch {
        return;
      }
      if (!suggested) return;
      const sanitized = sanitizeBranchName(suggested);
      if (!sanitized || sanitized === ws.branch) return;
      try {
        await renameWorkspaceBranch(id, sanitized, { manual: false }, window);
      } catch {
        /* ignore — user may have just manually renamed, branch conflict, etc. */
      }
    }, 400),
  );
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
