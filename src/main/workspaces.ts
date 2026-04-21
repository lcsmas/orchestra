import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BrowserWindow, shell } from 'electron';
import { execFile } from 'node:child_process';
import { store } from './store';
import { createWorktree, removeWorktree } from './git';
import { startPty, stopPty, writePty } from './pty';
import type { CreateWorkspaceInput, Workspace } from '../shared/types';

const ORCHESTRA_ROOT = path.join(os.homedir(), '.orchestra', 'worktrees');

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
  const safeBranch = input.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const worktreePath = path.join(ORCHESTRA_ROOT, `${repoName}-${safeBranch}-${id.slice(0, 8)}`);

  await createWorktree(input.repoPath, input.branch, input.baseBranch, worktreePath);

  const ws: Workspace = {
    id,
    name: `${repoName} · ${input.branch}`,
    repoPath: input.repoPath,
    worktreePath,
    branch: input.branch,
    baseBranch: input.baseBranch,
    createdAt: Date.now(),
    status: 'running',
    agent: input.agent,
    lastTask: input.task,
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);

  // Spawn the agent in a pty. We pipe the task (if any) as the first input.
  const command = input.agent === 'claude' ? 'claude' : 'codex';
  await startPty({
    id,
    cwd: worktreePath,
    command,
    args: [],
    cols: 120,
    rows: 32,
    window,
  });
  if (input.task) {
    setTimeout(() => {
      writePty(id, input.task + '\n');
    }, 1200);
  }
  return ws;
}

export async function archiveWorkspace(id: string, window: BrowserWindow): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws) return;
  stopPty(id);
  try {
    await removeWorktree(ws.repoPath, ws.worktreePath);
  } catch {
    /* best-effort */
  }
  await store.removeWorkspace(id);
  window.webContents.send('workspace:removed', id);
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
