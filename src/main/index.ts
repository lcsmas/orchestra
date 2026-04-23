import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { store } from './store';
import { detectDefaultBranch, getDiff, isGitRepo, commitAll, pushBranch, createPullRequest } from './git';
import { archiveWorkspace, createWorkspace, ensureRoot, openInEditor } from './workspaces';
import { resizePty, startPty, stopAll, stopPty, writePty, readScrollback, clearScrollback } from './pty';
import type { CreateWorkspaceInput } from '../shared/types';

let mainWindow: BrowserWindow | null = null;

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// Silence Linux/Wayland GPU vsync probe warnings.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

async function createMainWindow() {
  await store.load();
  await ensureRoot();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Orchestra',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function getMainWindow(): BrowserWindow {
  if (!mainWindow) throw new Error('main window not ready');
  return mainWindow;
}

// ---------- IPC ----------

ipcMain.handle('repos:list', () => store.repos);

ipcMain.handle('repos:add', async (_e, absPath: string) => {
  if (!(await isGitRepo(absPath))) throw new Error(`${absPath} is not a git repo`);
  const defaultBranch = await detectDefaultBranch(absPath);
  return store.addRepo({ path: absPath, name: path.basename(absPath), defaultBranch });
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

ipcMain.handle('workspaces:openInEditor', async (_e, id: string, editor: 'code' | 'cursor') => {
  await openInEditor(id, editor);
});

ipcMain.handle('pty:start', async (_e, id: string, cols: number, rows: number) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  await startPty({
    id,
    cwd: ws.worktreePath,
    command: ws.agent === 'claude' ? 'claude' : 'codex',
    args: ws.agent === 'claude' ? ['--dangerously-skip-permissions'] : [],
    cols,
    rows,
    window: getMainWindow(),
  });
});

ipcMain.handle('pty:write', (_e, id: string, data: string) => writePty(id, data));
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  resizePty(id, cols, rows),
);
ipcMain.handle('pty:stop', (_e, id: string) => stopPty(id));
ipcMain.handle('pty:scrollback', (_e, id: string) => readScrollback(id));
ipcMain.handle('pty:clearScrollback', (_e, id: string) => clearScrollback(id));

ipcMain.handle('git:diff', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  return getDiff(ws.worktreePath, ws.baseBranch);
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
