import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { store } from './store';
import {
  detectDefaultBranch,
  getDiff,
  isGitRepo,
  commitAll,
  pushBranch,
  createPullRequest,
  findPullRequest,
  listBranches,
  switchWorktreeBranch,
  getDiffStats,
  isWorktreeDirty,
  mergeIntoBase,
} from './git';
import type { Workspace } from '../shared/types';
import {
  archiveWorkspace,
  createWorkspace,
  deleteWorkspace,
  ensureRoot,
  openInEditor,
  unarchiveWorkspace,
} from './workspaces';
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
import { clearActivity, noteData, notePtyStart, noteSubmit } from './activity';
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
  const ok = await openViaOS(url);
  if (!ok) await shell.openExternal(url);
}

function openViaOS(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Use the OS-level "open" command so the URL is handed to the user's
    // default browser, which reuses its existing running instance (most
    // recent Chrome window gets a new tab, rather than spawning a new
    // Chrome process that might miss the singleton).
    const [cmd, args]: [string, string[]] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', url]]
          : ['xdg-open', [url]];
    const child = execFile(cmd, args, { detached: true }, (err) => {
      if (err) resolve(false);
    });
    child.unref();
    setTimeout(() => resolve(true), 120);
  });
}

ipcMain.handle('app:openExternal', async (_e, url: string) => {
  await openUrlExternally(url);
});

ipcMain.handle('repos:list', () => store.repos);

ipcMain.handle('repos:add', async (_e, absPath: string) => {
  if (!(await isGitRepo(absPath))) throw new Error(`${absPath} is not a git repo`);
  const defaultBranch = await detectDefaultBranch(absPath);
  return store.addRepo({ path: absPath, name: path.basename(absPath), defaultBranch });
});

ipcMain.handle('repos:remove', async (_e, absPath: string) => {
  await store.removeRepo(absPath);
});

ipcMain.handle('dialog:confirm', async (_e, message: string, detail?: string) => {
  const res = await dialog.showMessageBox(getMainWindow(), {
    type: 'question',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    message,
    detail,
  });
  return res.response === 1;
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
  await startPty({
    id,
    cwd: ws.worktreePath,
    command: ws.agent === 'claude' ? 'claude' : 'codex',
    args: ws.agent === 'claude' ? claudeArgs : codexArgs,
    cols,
    rows,
    window: getMainWindow(),
    onAgentData: (wsId, data) => noteData(wsId, data, getMainWindow()),
    onAgentPid: (wsId, pid) => notePtyStart(wsId, pid),
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
      noteSubmit(id, getMainWindow());
    }, 1200);
  }
});

ipcMain.handle('pty:write', async (_e, id: string, data: string) => {
  // Flip hasInput the first time the user actually submits something (Enter
  // key / carriage return). This is what gates `claude --continue` on the
  // next PTY start, so we avoid "No conversation found" when the log is
  // only startup TUI noise.
  const submitted = data.includes('\r') || data.includes('\n');
  if (submitted) {
    const ws = store.getWorkspace(id);
    if (ws && !ws.hasInput) {
      const updated = { ...ws, hasInput: true };
      await store.upsertWorkspace(updated);
      getMainWindow().webContents.send('workspace:update', updated);
    }
    noteSubmit(id, getMainWindow());
  }
  return writePty(id, data);
});
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  resizePty(id, cols, rows),
);
ipcMain.handle('pty:stop', (_e, id: string) => {
  clearActivity(id);
  return stopPty(id);
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

ipcMain.handle('git:merge', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');

  if (await isWorktreeDirty(ws.worktreePath)) {
    const prompt =
      'There are uncommitted changes in this worktree. Please review them, then commit ALL pending changes with a clear message and push the branch. After you finish, the user will click Merge again.';
    writePty(id, prompt);
    setTimeout(() => writePty(id, '\r'), 80);
    return {
      status: 'pending-commit' as const,
      message:
        'Worktree has uncommitted changes — asked the agent to commit them. Click Merge again once the commit lands.',
    };
  }

  const { pushed, pushError } = await mergeIntoBase({
    repoPath: ws.repoPath,
    branch: ws.branch,
    baseBranch: ws.baseBranch,
  });

  const updated: Workspace = { ...ws, mergedAt: Date.now() };
  await store.upsertWorkspace(updated);
  getMainWindow().webContents.send('workspace:update', updated);

  return { status: 'merged' as const, pushed, pushError };
});

ipcMain.handle('git:switchBranch', async (_e, id: string, branch: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.branch === branch) return ws;
  await switchWorktreeBranch(ws.worktreePath, branch);
  const updated: Workspace = { ...ws, branch };
  await store.upsertWorkspace(updated);
  getMainWindow().webContents.send('workspace:update', updated);
  return updated;
});

// ---------- Lifecycle ----------

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  stopAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
