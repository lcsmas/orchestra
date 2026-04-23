import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BrowserWindow, shell } from 'electron';
import { execFile } from 'node:child_process';
import { store } from './store';
import { createWorktree, removeWorktree } from './git';
import { startPty, stopPty, writePty, clearScrollback } from './pty';
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
  const repo = store.repos.find((r) => r.path === input.repoPath);
  const baseBranch = input.baseBranch || repo?.defaultBranch || 'main';
  const branch = input.branch || `orchestra/${id.slice(0, 8)}`;
  const agent = input.agent ?? 'claude';
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const worktreePath = path.join(ORCHESTRA_ROOT, `${repoName}-${safeBranch}-${id.slice(0, 8)}`);

  await createWorktree(input.repoPath, branch, baseBranch, worktreePath);

  const ws: Workspace = {
    id,
    name: `${repoName} · ${branch}`,
    repoPath: input.repoPath,
    worktreePath,
    branch,
    baseBranch,
    createdAt: Date.now(),
    status: 'running',
    agent,
    lastTask: input.task,
  };
  await store.upsertWorkspace(ws);
  window.webContents.send('workspace:update', ws);

  // Spawn the agent in a pty. We pipe the task (if any) as the first input.
  const command = agent === 'claude' ? 'claude' : 'codex';
  const args = agent === 'claude' ? ['--dangerously-skip-permissions'] : [];
  await startPty({
    id,
    cwd: worktreePath,
    command,
    args,
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
  clearScrollback(id);
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
