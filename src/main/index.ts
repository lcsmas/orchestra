import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'node:path';
import fixPath from 'fix-path';

// Desktop launchers (file manager, app grid, .desktop files) start Electron
// without sourcing the user's shell rc, so PATH is the bare login PATH and
// agent binaries like `claude`, `codex`, `nvim` aren't found. Run this before
// anything spawns a child process — asks the user's login shell for its PATH
// and copies it onto process.env.PATH. No-ops when launched from a terminal.
fixPath();
import { store } from './store';
import {
  detectDefaultBranch,
  detectRemoteUrl,
  getDiff,
  isGitRepo,
  commitAll,
  pushBranch,
  createPullRequest,
  findPullRequest,
  listBranches,
  getDiffStats,
} from './git';
import type { Workspace } from '../shared/types';
import {
  archiveWorkspace,
  createWorkspace,
  deleteWorkspace,
  ensureRoot,
  ensureWorkspacePort,
  installOrchestraHooks,
  openInEditor,
  renameWorkspaceBranch,
  runSetupScript,
  switchWorkspaceBranch,
  unarchiveWorkspace,
} from './workspaces';
import { buildScriptEnv, readScriptLog, setupLogPath } from './scripts';
import type { RepoScripts } from '../shared/types';
import {
  resizePty,
  startPty,
  stopAll,
  stopPty,
  writePty,
  readScrollback,
  clearScrollback,
  isRunning,
} from './pty';
import { startHooksServer, stopHooksServer } from './hooks-server';
import { detectAndUpdateMergeState } from './activity';
import type { CreateWorkspaceInput } from '../shared/types';

let mainWindow: BrowserWindow | null = null;

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// Silence Linux/Wayland GPU vsync probe warnings.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

// Expose Chrome DevTools Protocol in dev so chrome-devtools-mcp can attach.
if (VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

async function createMainWindow() {
  await store.load();
  await ensureRoot();
  // Hook server must be ready before any PTY spawns: spawned claude inherits
  // ORCHESTRA_SOCK from the env we'll set on the pty.spawn call, and that
  // value is read from getHookSocketPath() which only returns non-null after
  // listen() resolves.
  // Re-attach branch-name watchers for all non-archived workspaces — Claude
  // may have dropped the suggestion file while Orchestra was closed.
  // Deferred until after mainWindow is created.

  // Drop the default Electron menu (File/Edit/View/Window/Help). We don't ship
  // any custom menu commands; the strip just eats vertical space.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Orchestra',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  await startHooksServer(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openUrlExternally(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (url === current) return;
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
    void openUrlExternally(url);
  });

  if (VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

}

function getMainWindow(): BrowserWindow {
  if (!mainWindow) throw new Error('main window not ready');
  return mainWindow;
}

// ---------- IPC ----------

// Only allow http(s) URLs out to the OS. Other schemes are ignored to avoid
// opening arbitrary things (file://, javascript:, etc.) from PTY output.
function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function openUrlExternally(url: string): Promise<void> {
  if (!isSafeHttpUrl(url)) return;
  await shell.openExternal(url);
}

ipcMain.handle('app:openExternal', async (_e, url: string) => {
  await openUrlExternally(url);
});

ipcMain.handle('repos:list', async () => {
  // Lazy-backfill `remoteUrl` for any repo added before that field existed,
  // or whose origin URL changed since it was first mapped. Best-effort —
  // missing origin / unknown URL shape just leaves remoteUrl undefined.
  for (const r of store.repos) {
    if (r.remoteUrl) continue;
    const url = await detectRemoteUrl(r.path).catch(() => undefined);
    if (url) await store.updateRepo(r.path, { remoteUrl: url });
  }
  return store.repos;
});

ipcMain.handle('repos:add', async (_e, absPath: string) => {
  if (!(await isGitRepo(absPath))) throw new Error(`${absPath} is not a git repo`);
  const defaultBranch = await detectDefaultBranch(absPath);
  const remoteUrl = await detectRemoteUrl(absPath).catch(() => undefined);
  return store.addRepo({
    path: absPath,
    name: path.basename(absPath),
    defaultBranch,
    remoteUrl,
  });
});

ipcMain.handle('repos:remove', async (_e, absPath: string) => {
  await store.removeRepo(absPath);
});

ipcMain.handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('workspaces:list', () => store.workspaces);

ipcMain.handle('workspaces:create', async (_e, input: CreateWorkspaceInput) => {
  return createWorkspace(input, getMainWindow());
});

ipcMain.handle('workspaces:archive', async (_e, id: string) => {
  await archiveWorkspace(id, getMainWindow());
});

ipcMain.handle('workspaces:unarchive', async (_e, id: string) => {
  await unarchiveWorkspace(id, getMainWindow());
});

ipcMain.handle('workspaces:delete', async (_e, id: string) => {
  await deleteWorkspace(id, getMainWindow());
});

ipcMain.handle('workspaces:openInEditor', async (_e, id: string, editor: 'code' | 'cursor') => {
  await openInEditor(id, editor);
});

ipcMain.handle('workspaces:markSeen', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'waiting') return;
  const updated: Workspace = { ...ws, status: 'idle' };
  await store.upsertWorkspace(updated);
  getMainWindow().webContents.send('workspace:update', updated);
});

ipcMain.handle('pty:start', async (_e, id: string, cols: number, rows: number) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (isRunning(id)) {
    // Renderer remounted (HMR / reload) but the PTY is still alive. The fresh
    // xterm canvas is blank and Claude/Codex have no reason to repaint on
    // their own, so bounce the size to force a SIGWINCH-driven redraw.
    resizePty(id, Math.max(20, cols - 1), Math.max(5, rows));
    setTimeout(() => resizePty(id, cols, rows), 40);
    return;
  }
  // Resume only if the user has actually submitted something. A scrollback log
  // exists even when the agent just printed its startup TUI, so using it as
  // the resume signal causes `claude --continue` to fail with "No conversation
  // found to continue". The renderer flips ws.hasInput once the user presses
  // Enter at least once.
  const resuming = ws.hasInput === true;
  const claudeArgs = resuming
    ? ['--continue', '--dangerously-skip-permissions']
    : ['--dangerously-skip-permissions'];
  const codexArgs = resuming ? ['resume', '--last'] : [];
  // Idempotent: upgrades workspaces created before the activity hook landed.
  await installOrchestraHooks(ws.worktreePath, ws.agent);
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
    id,
    cwd: ws.worktreePath,
    command: ws.agent === 'claude' ? 'claude' : 'codex',
    args: ws.agent === 'claude' ? claudeArgs : codexArgs,
    cols,
    rows,
    window: getMainWindow(),
    workspaceId: id,
    extraEnv,
  });
  // Preserve the `waiting` yellow dot across restarts: if the previous session
  // ended with an unread "agent finished" state, the dot stays until the user
  // actually reads it (via markSeen from setActive). Only clear stale
  // `running` state left over from a prior crash.
  if (ws.status === 'running') {
    const updated: Workspace = { ...ws, status: 'idle' };
    await store.upsertWorkspace(updated);
    getMainWindow().webContents.send('workspace:update', updated);
  }
  // First-ever spawn: pipe the initial task (if any) into the agent once it
  // has had a moment to initialize its TUI.
  if (!resuming && ws.lastTask) {
    const task = ws.lastTask;
    setTimeout(() => {
      writePty(id, task + '\n');
      // Status flips to running once Claude fires its UserPromptSubmit hook.
    }, 1200);
  }
});

ipcMain.handle('pty:write', async (_e, id: string, data: string) => {
  // Flip hasInput the first time the user actually submits something (Enter
  // key / carriage return). This is what gates `claude --continue` on the
  // next PTY start, so we avoid "No conversation found" when the log is
  // only startup TUI noise. Activity status itself flips from Claude's own
  // UserPromptSubmit hook, not from this handler.
  const submitted = data.includes('\r') || data.includes('\n');
  if (submitted) {
    const ws = store.getWorkspace(id);
    if (ws && !ws.hasInput) {
      const updated = { ...ws, hasInput: true };
      await store.upsertWorkspace(updated);
      getMainWindow().webContents.send('workspace:update', updated);
    }
  }
  return writePty(id, data);
});
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  resizePty(id, cols, rows),
);
ipcMain.handle('pty:stop', (_e, id: string) => {
  return stopPty(id);
});
ipcMain.handle('agent:restart', (_e, id: string) => {
  // Mirror the branch-switch path: stop the agent PTY here (the renderer's
  // xterm doesn't get torn down — it just resets) and tell the renderer to
  // spawn a fresh PTY. `pty:start` will pick `claude --continue` since
  // ws.hasInput is true, so the conversation resumes against the new
  // process — which is what makes MCP/settings.json edits take effect.
  if (!isRunning(id)) return;
  stopPty(id);
  getMainWindow().webContents.send('pty:restart', id);
});
ipcMain.handle('pty:scrollback', (_e, id: string) => readScrollback(id));
ipcMain.handle('pty:clearScrollback', (_e, id: string) => clearScrollback(id));

ipcMain.handle('git:diff', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  return getDiff(ws.worktreePath, ws.baseBranch);
});

ipcMain.handle('git:stats', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  // Piggyback merge/unpushed state refresh on the renderer's 8s stats poll.
  // Cheap (two `rev-list --count` calls), and keeps the ↑N badge live even
  // when the agent isn't running — which is exactly when the user finishes
  // a commit and wants to see "ready to push".
  void detectAndUpdateMergeState(id, getMainWindow()).catch(() => {});
  return getDiffStats(ws.worktreePath, ws.baseBranch);
});

ipcMain.handle('git:commit', async (_e, id: string, message: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  await commitAll(ws.worktreePath, message);
});

ipcMain.handle('git:push', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  await pushBranch(ws.worktreePath, ws.branch);
});

ipcMain.handle('git:pr', async (_e, id: string, title: string, body: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  return createPullRequest(ws.worktreePath, title, body, ws.baseBranch);
});

ipcMain.handle('git:findPR', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  return findPullRequest(ws.worktreePath, ws.branch);
});

ipcMain.handle('git:listBranches', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  return listBranches(ws.repoPath);
});

ipcMain.handle('nvim:start', async (_e, id: string, cols: number, rows: number) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  const nvimId = `${id}:nvim`;
  if (isRunning(nvimId)) {
    // Renderer remounted — nudge a repaint.
    resizePty(nvimId, Math.max(20, cols - 1), Math.max(5, rows));
    setTimeout(() => resizePty(nvimId, cols, rows), 40);
    return;
  }
  await startPty({
    id: nvimId,
    cwd: ws.worktreePath,
    command: 'nvim',
    args: ['.'],
    cols,
    rows,
    window: getMainWindow(),
  });
});

ipcMain.handle('nvim:stop', async (_e, id: string) => {
  stopPty(`${id}:nvim`);
});

ipcMain.handle(
  'workspaces:renameBranch',
  async (_e, id: string, newBranch: string) => {
    return renameWorkspaceBranch(id, newBranch, { manual: true }, getMainWindow());
  },
);

ipcMain.handle('git:merge', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');

  // Hand the merge off to the agent: it has full context of the work it just
  // did and writes its own commit messages along the way. The agent runs
  // inside the worktree (whose HEAD is the feature branch); to update the
  // base branch it must operate on the main repo via `git -C <repoPath>`
  // since the worktree's HEAD is pinned.
  const prompt =
    `Please merge this branch into \`${ws.baseBranch}\` and push.\n\n` +
    `- Feature branch: \`${ws.branch}\` (current worktree HEAD)\n` +
    `- Base branch: \`${ws.baseBranch}\`\n` +
    `- Main repo path: \`${ws.repoPath}\`\n\n` +
    `If there are uncommitted changes, commit them first with a clear message. ` +
    `Then run the merge against the main repo (use \`git -C "${ws.repoPath}" ...\` so the worktree HEAD stays put), ` +
    `and \`git push\` the base branch. ` +
    `Tell me when it's done or if anything goes wrong.`;

  writePty(id, prompt);
  setTimeout(() => writePty(id, '\r'), 80);

  return { status: 'requested' as const };
});

ipcMain.handle('git:switchBranch', async (_e, id: string, branch: string) => {
  return switchWorkspaceBranch(id, branch, getMainWindow());
});

// ---------- Repo scripts (setup / run / archive) ----------

ipcMain.handle('repos:getScripts', (_e, repoPath: string) => {
  return store.getRepoScripts(repoPath);
});

ipcMain.handle('repos:setScripts', async (_e, repoPath: string, scripts: RepoScripts) => {
  return store.setRepoScripts(repoPath, scripts);
});

ipcMain.handle('scripts:retrySetup', async (_e, id: string) => {
  await runSetupScript(id, getMainWindow());
});

ipcMain.handle('scripts:readSetupLog', (_e, id: string) => {
  return readScriptLog(setupLogPath(id));
});

ipcMain.handle('scripts:runStart', async (_e, id: string, cols: number, rows: number) => {
  const ws0 = store.getWorkspace(id);
  if (!ws0) throw new Error('workspace not found');
  const script = store.getRepoScripts(ws0.repoPath).run;
  if (!script) throw new Error('no run script configured for this repo');
  // Lazy port allocation for legacy workspaces created before scripts existed.
  const ws = (await ensureWorkspacePort(id, getMainWindow())) ?? ws0;
  const runId = `${id}:run`;
  if (isRunning(runId)) {
    resizePty(runId, Math.max(20, cols - 1), Math.max(5, rows));
    setTimeout(() => resizePty(runId, cols, rows), 40);
    return;
  }
  await startPty({
    id: runId,
    cwd: ws.worktreePath,
    command: 'bash',
    args: ['-lc', script],
    cols,
    rows,
    window: getMainWindow(),
    // Run pty inherits ORCHESTRA_* via the env passed at spawn time. node-pty's
    // env is overridden, not merged, so we pass the full block. The agent
    // hook env (ORCHESTRA_SOCK, ORCHESTRA_WS_ID) is intentionally absent —
    // the run script isn't an agent.
    extraEnv: buildScriptEnv(ws),
  });
});

ipcMain.handle('scripts:runStop', (_e, id: string) => {
  stopPty(`${id}:run`);
});

ipcMain.handle('scripts:runScrollback', (_e, id: string) => {
  return readScrollback(`${id}:run`);
});

// ---------- Lifecycle ----------

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  stopAll();
  stopHooksServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopAll();
  stopHooksServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
