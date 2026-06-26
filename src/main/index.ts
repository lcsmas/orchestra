import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { shellEnvSync } from 'shell-env';

// ---------------------------------------------------------------- CLI mode ---
// The same binary doubles as the `orchestra` CLI: `Orchestra.AppImage cli …`
// (and the ~/.local/bin/orchestra shim the GUI installs) routes here. When a
// leading `cli` token is present among the user args we run the CLI against the
// *already-running* app's unix socket and exit — never opening a window,
// running the ozone relaunch, or merging the shell env (none of which the CLI
// needs, and the relaunch would fork a second GUI). The flag is computed first
// and every GUI-only top-level side-effect below is guarded by it. argv layout:
// packaged = [exec, ...userArgs]; dev (`electron .`) = [electron, '.', ...args].
const ORCHESTRA_CLI_MODE = (() => {
  const argv = process.argv.slice(1);
  const start = argv[0] === '.' ? 1 : 0;
  return argv[start] === 'cli';
})();

if (ORCHESTRA_CLI_MODE) {
  const argv = process.argv.slice(1);
  const start = argv[0] === '.' ? 1 : 0;
  // Dynamic import so the GUI path never loads the CLI module. runCli() prints
  // and exits the process itself (0 on success, 1 via fail()).
  void import('../cli')
    .then(({ runCli }) => runCli(argv.slice(start + 1)))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

// Ozone platform selection. Chromium picks its windowing backend BEFORE this
// script runs, so app.commandLine.appendSwitch('ozone-platform'/'ozone-
// platform-hint', …) is too late to move the browser process off XWayland.
// Worse, appendSwitch('ozone-platform', 'wayland') still propagates the flag
// to the GPU/renderer children, which then target a Wayland surface the
// browser never presents — that mismatch was the actual "white screen on
// Wayland" bug (2d6cbdf), not a driver problem; native Wayland renders fine
// here once selected early (verified on Asahi Fedora + sway, Electron 33).
// And staying on XWayland is what makes HiDPI blurry: the compositor upscales
// X11 buffers on scaled outputs.
// The only channel that reaches Chromium early enough from inside the app is
// ELECTRON_OZONE_PLATFORM_HINT in the parent environment — so decide which
// platform we want, and if the hint inherited at launch disagrees, relaunch
// once with the hint exported. The hint value must be the explicit 'wayland',
// not 'auto': 'auto' resolves to x11 when XDG_SESSION_TYPE is unset (e.g. a
// compositor started from a tty). ORCHESTRA_OZONE=x11|wayland overrides.
// This must run BEFORE the shellEnvSync merge below: the user's rc may export
// ELECTRON_OZONE_PLATFORM_HINT (making us think the hint was present at
// launch when Chromium never saw it), and the decision must reflect the real
// launch-time environment, which for GUI launches has no rc additions.
if (!ORCHESTRA_CLI_MODE && process.platform === 'linux') {
  const override = process.env.ORCHESTRA_OZONE;
  const want =
    override === 'x11' || override === 'wayland'
      ? override
      : process.env.WAYLAND_DISPLAY
        ? 'wayland'
        : 'x11';
  const hint = process.env.ELECTRON_OZONE_PLATFORM_HINT;
  // x11 is also the no-hint default, so only relaunch to force it when a
  // conflicting hint (e.g. exported from the user's shell rc) would win.
  const needsRelaunch = want === 'wayland' ? hint !== 'wayland' : hint === 'wayland';
  if (needsRelaunch && !process.env.ORCHESTRA_OZONE_RELAUNCHED) {
    process.env.ORCHESTRA_OZONE_RELAUNCHED = '1';
    process.env.ELECTRON_OZONE_PLATFORM_HINT = want;
    try {
      if (process.env.APPIMAGE) {
        // app.relaunch() can't be used here: its relauncher is forked from
        // this process and execs only after we exit — by which point the
        // AppImage's FUSE mount is gone and the relauncher dies (verified:
        // the new instance never appears). Spawn the replacement AppImage
        // ourselves while the mount is still alive, then exit. The brief
        // two-instance overlap is safe — we exit before `ready`, so this
        // instance never opened a window or touched the store.
        spawn(process.env.APPIMAGE, [], {
          detached: true,
          stdio: 'ignore',
          env: process.env as NodeJS.ProcessEnv,
        }).unref();
      } else {
        app.relaunch();
      }
      app.exit(0);
    } catch {
      // Spawning failed — carry on in this process; worst case is XWayland.
    }
  }
}

// Desktop launchers (file manager, app grid, .desktop files, rofi/combi) start
// Electron without sourcing the user's shell rc, so the process inherits only
// the bare graphical-session environment: PATH lacks agent binaries like
// `claude`/`nvim`, AND exported secrets (e.g. MCP DB creds sourced from
// ~/.zshrc) are missing. Since the agent pty execs `claude` directly (no shell,
// see startPty), whatever is absent here never reaches the agent's MCP servers.
// Capture the full login+interactive shell environment once, before anything
// spawns a child process, and merge it onto process.env. shell-env runs
// `$SHELL -ilc env` (sourcing .zshrc), strips ANSI, and returns every export;
// it no-ops to process.env on Windows or shell failure, and is effectively a
// no-op when launched from a terminal (the env is already present). This
// supersedes fix-path, which only ever repaired PATH and discarded the rest.
// Launching via `npm run dev` / `npm start` injects npm_* lifecycle vars
// (npm_config_prefix, npm_package_*, …) into our environment. They propagate to
// every child we spawn — agent PTYs and the run/setup/archive scripts — and
// npm_config_prefix in particular makes nvm refuse to switch Node ("nvm is not
// compatible with the npm_config_prefix environment variable"), silently
// breaking run scripts that call `nvm use`. Strip them *before* capturing the
// shell env below, so the shell-env child (which inherits our env) and every
// process we later spawn see the clean environment a real GUI launch gets. A
// user who genuinely exports an npm_* var from their rc gets it back via the
// shellEnvSync merge, since that runs after this and re-sources their rc.
if (!ORCHESTRA_CLI_MODE) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('npm_')) delete process.env[key];
  }
  try {
    Object.assign(process.env, shellEnvSync());
  } catch {
    // shell-env already falls back internally; ignore any unexpected failure.
  }
}
import { store } from './store';
import {
  detectRemoteUrl,
  getDiff,
  findPullRequest,
  listBranches,
  getDiffStats,
} from './git';
import { verifyLinearIssue } from './linear';
import { getEnvStatus } from './env-status';
import type { Workspace } from '../shared/types';
import {
  addRepoByPath,
  removeRepoByPath,
  archiveWorkspace,
  createWorkspace,
  createScratchWorkspace,
  createOrchestratorWorkspace,
  deleteWorkspace,
  ensureRoot,
  ensureWorkspacePort,
  getWorktreeSizes,
  pruneOrphanedWorkspaces,
  renameWorkspaceBranch,
  resumeRunningWorkspaces,
  runSetupScript,
  startAgentPty,
  switchWorkspaceBranch,
  unarchiveWorkspace,
} from './workspaces';
import { buildScriptEnv, loginShellArgv, readScriptLog, setupLogPath } from './scripts';
import type { RepoScripts } from '../shared/types';
import {
  resizePty,
  startPty,
  stopAll,
  stopPty,
  writePty,
  readScrollback,
  isRunning,
} from './pty';
import { startHooksServer, stopHooksServer } from './hooks-server';
import { installCliShim } from './cli-shim';
import { startEventsSpool, stopEventsSpool } from './events-spool';
import { startUsagePolling, stopUsagePolling, getLastUsage } from './usage';
import {
  detectAndUpdateBranchName,
  detectAndUpdateMergeState,
  detectAndUpdateReleaseState,
} from './activity';
import {
  primeLocalSyncStates,
  snapshotSyncStates,
  syncAllRepos,
  syncOneRepo,
} from './repo-sync';
import type { CreateWorkspaceInput } from '../shared/types';
import { initLogger, log, revealLogs, getLogFile } from './logger';

let mainWindow: BrowserWindow | null = null;

// Wrap ipcMain.handle so any error thrown by a handler is logged with its
// channel before being re-thrown back to the renderer. Without this, a failing
// IPC call surfaces only as a rejected promise in the renderer with no
// main-process trace — exactly the kind of bug that's impossible to diagnose
// from a desktop-launched build.
type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;
function handle(channel: string, fn: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      log.error(`ipc ${channel} failed`, err);
      throw err;
    }
  });
}

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

// Expose Chrome DevTools Protocol in dev so chrome-devtools-mcp can attach.
// Port is overridable via ORCHESTRA_DEBUG_PORT so a second instance can be
// inspected without colliding with an already-running one already holding 9222.
if (VITE_DEV_SERVER_URL || process.env.ORCHESTRA_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ORCHESTRA_DEBUG_PORT || '9222');
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
  // Primary activity path: tail the durable per-workspace hook event spools.
  startEventsSpool(mainWindow);
  // Poll the signed-in account's rolling 5h/7d usage windows for the sidebar bars.
  startUsagePolling(mainWindow);

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

  // Drop workspaces whose worktree was deleted out-of-band BEFORE the renderer
  // fetches the list, so stale "ghost" rows (a ~12 KB husk, no working actions)
  // never appear. Cheap (one `git worktree list` per repo); guarded against
  // pruning when a repo is merely unmounted. Best-effort — never block startup.
  await pruneOrphanedWorkspaces(mainWindow).catch((e) => log.warn('pruneOrphanedWorkspaces failed', e));

  if (VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Capture the non-null window: the awaits above widen the `mainWindow` let
  // back to `BrowserWindow | null` (TS can't prove a concurrent reset didn't
  // happen across the async gap), and the background dispatches below pass it
  // by value rather than member-accessing it through the `?.` guard.
  const win = mainWindow;

  // Resume agents that were running when Orchestra last exited: relaunch
  // `claude --continue` headlessly so the work picks back up across a restart
  // rather than sitting idle until the user re-opens the tab. Runs after the
  // renderer has loaded (so its pty:data / workspace:update listeners are wired
  // and it reconnects cleanly when the user opens a resumed tab) and after the
  // orphan prune (so we never try to resume a workspace whose worktree is gone
  // and about to be dropped). Best-effort — never block startup on it.
  void resumeRunningWorkspaces(win).catch((e) =>
    log.warn('resumeRunningWorkspaces failed', e),
  );

  // Base-branch sync: prime local state immediately (no network) so the
  // sidebar paints with whatever the on-disk refs say, then kick a real
  // fetch in the background. Prime must complete before sync starts —
  // otherwise the prime's late `syncing:false, syncedAt:0` event races
  // ahead of sync completion and clobbers the success state. Subsequent
  // fetches are driven by window focus.
  primeLocalSyncStates(win)
    .catch((e) => log.warn('primeLocalSyncStates failed', e))
    .then(() => syncAllRepos(win))
    .catch((e) => log.warn('syncAllRepos failed', e));
  mainWindow.on('focus', () => {
    if (!mainWindow) return;
    void syncAllRepos(mainWindow).catch((e) => log.warn('syncAllRepos (focus) failed', e));
  });
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

handle('app:openExternal', async (_e, url: string) => {
  await openUrlExternally(url);
});

handle('app:version', () => app.getVersion());

// Optional-setup status (e.g. Linear API key present?). The renderer reads this
// on load and on a slow poll to surface a small "needs setup" notice.
handle('app:envStatus', () => getEnvStatus());

// Last fetched usage snapshot (or null before the first successful poll). The
// renderer reads this once on mount; subsequent updates arrive via `usage:update`.
handle('usage:get', () => getLastUsage());

// ---------- Diagnostic logs ----------

handle('logs:reveal', async () => {
  await revealLogs();
});

handle('logs:path', () => getLogFile());

// Forward renderer-side logs/errors into the same file so a single artifact
// captures both processes. Level is clamped to the known set; anything else is
// treated as info.
handle('logs:write', (_e, level: string, message: string, meta?: unknown) => {
  const fn =
    level === 'error'
      ? log.error
      : level === 'warn'
        ? log.warn
        : level === 'debug'
          ? log.debug
          : log.info;
  fn(`[renderer] ${message}`, meta);
});

handle('repos:list', async () => {
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

handle('repos:add', async (_e, absPath: string) => {
  return addRepoByPath(absPath, getMainWindow());
});

handle('repos:remove', async (_e, absPath: string) => {
  await removeRepoByPath(absPath, getMainWindow());
});

handle('repos:listSyncStates', () => snapshotSyncStates());

handle('repos:syncBase', async (_e, repoPath: string) => {
  await syncOneRepo(repoPath, getMainWindow());
});

handle('repos:reorder', async (_e, orderedPaths: string[]) => {
  await store.reorderRepos(orderedPaths);
});

handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

handle('workspaces:list', () => store.workspaces);

handle('workspaces:reorder', async (_e, orderedIds: string[]) => {
  await store.reorderWorkspaces(orderedIds);
});

handle('workspaces:create', async (_e, input: CreateWorkspaceInput) => {
  return createWorkspace(input, getMainWindow());
});

handle('workspaces:createScratch', async () => {
  return createScratchWorkspace(getMainWindow());
});

handle('workspaces:createOrchestrator', async () => {
  return createOrchestratorWorkspace(getMainWindow());
});

handle('workspaces:archive', async (_e, id: string) => {
  await archiveWorkspace(id, getMainWindow());
});

handle('workspaces:unarchive', async (_e, id: string) => {
  await unarchiveWorkspace(id, getMainWindow());
});

handle('workspaces:delete', async (_e, id: string) => {
  await deleteWorkspace(id, getMainWindow());
});

handle('workspaces:markSeen', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'waiting') return;
  const updated: Workspace = { ...ws, status: 'idle' };
  await store.upsertWorkspace(updated);
  getMainWindow().webContents.send('workspace:update', updated);
});

handle('pty:start', async (_e, id: string, cols: number, rows: number) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (isRunning(id)) {
    // Renderer remounted (HMR / reload) but the PTY is still alive. The fresh
    // xterm canvas is blank and Claude has no reason to repaint on
    // their own, so bounce the size to force a SIGWINCH-driven redraw.
    resizePty(id, Math.max(20, cols - 1), Math.max(5, rows));
    setTimeout(() => resizePty(id, cols, rows), 40);
    return;
  }
  // Spawn the agent PTY. The resume gate (`claude --continue` only when the
  // user has actually submitted a prompt — ws.hasInput), hook install, and env
  // setup all live in startAgentPty so the startup resume path stays identical.
  const resuming = ws.hasInput === true;
  await startAgentPty(ws, cols, rows, getMainWindow());
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

handle('pty:write', async (_e, id: string, data: string) => {
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
handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
  resizePty(id, cols, rows),
);

// Clipboard image paste. xterm.js + the renderer's `navigator.clipboard` only
// pipes text to the PTY, so a pasted screenshot is dropped on the floor.
// Claude Code has no stdin protocol for images, but it auto-attaches any
// absolute image path that arrives via a bracketed paste. The renderer reads
// the image bytes off the clipboard (same focused-document context that makes
// text paste work — `clipboard.readImage()` in the main process can't, since
// Wayland gates clipboard reads on surface focus the main process lacks) and
// hands them here to spill to a temp file; we return the path to inject.
handle('clipboard:saveImage', async (_e, mime: string, bytes: Uint8Array) => {
  if (!bytes || bytes.byteLength === 0) return null;
  const ext =
    mime === 'image/jpeg'
      ? 'jpg'
      : mime === 'image/gif'
        ? 'gif'
        : mime === 'image/webp'
          ? 'webp'
          : 'png';
  const dir = path.join(os.tmpdir(), 'orchestra-paste');
  await fs.promises.mkdir(dir, { recursive: true });
  // Prune stale spills so the temp dir doesn't grow unbounded. Best-effort —
  // a file Claude is mid-read on is days younger than the cutoff anyway.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of await fs.promises.readdir(dir)) {
      const fp = path.join(dir, name);
      const st = await fs.promises.stat(fp).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.promises.unlink(fp).catch(() => {});
    }
  } catch {
    // ignore prune failures
  }
  const file = path.join(dir, `paste-${Date.now()}-${process.pid}.${ext}`);
  await fs.promises.writeFile(file, Buffer.from(bytes));
  return file;
});
handle('agent:restart', (_e, id: string) => {
  // Mirror the branch-switch path: stop the agent PTY here (the renderer's
  // xterm doesn't get torn down — it just resets) and tell the renderer to
  // spawn a fresh PTY. `pty:start` will pick `claude --continue` since
  // ws.hasInput is true, so the conversation resumes against the new
  // process — which is what makes MCP/settings.json edits take effect.
  if (!isRunning(id)) return;
  stopPty(id);
  getMainWindow().webContents.send('pty:restart', id);
});

handle('git:diff', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.kind === 'scratch') return []; // non-git dir — no diff against a base
  return getDiff(ws.worktreePath, ws.baseBranch);
});

handle('git:stats', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  // Scratch sessions aren't git-backed: no diff stats, and none of the merge /
  // branch reconciliation below applies.
  if (ws.kind === 'scratch') return { additions: 0, deletions: 0, files: 0 };
  // Piggyback merge/unpushed state refresh on the renderer's 8s stats poll.
  // Cheap (two `rev-list --count` calls), and keeps the ↑N badge live even
  // when the agent isn't running — which is exactly when the user finishes
  // a commit and wants to see "ready to push".
  void detectAndUpdateMergeState(id, getMainWindow()).catch(() => {});
  // Same cadence: catch branches renamed outside orchestra (a terminal's
  // `git branch -m`, an editor's VCS UI) so the stored branch name doesn't
  // drift from what's actually checked out. One `rev-parse` per workspace.
  void detectAndUpdateBranchName(id, getMainWindow()).catch(() => {});
  return getDiffStats(ws.worktreePath, ws.baseBranch);
});

handle('workspaces:sizes', () => getWorktreeSizes());

handle('git:findPR', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  if (ws.kind === 'scratch') return { all: [], open: null, latest: null, mergedCount: 0 };
  // Piggyback release detection on the PR poll: same gh-based, 12s + on-focus
  // cadence, and never on the hot stats poll. Short-circuits before any gh
  // call unless the branch is merged-but-not-yet-released, so it's nearly free.
  void detectAndUpdateReleaseState(id, getMainWindow()).catch(() => {});
  return findPullRequest(ws.repoPath, ws.branch);
});

handle('linear:verify', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  // Scratch sessions have no git branch encoding an issue; skip the CLI spawn.
  if (ws.kind === 'scratch') return null;
  return verifyLinearIssue(ws.branch);
});

handle('git:listBranches', async (_e, id: string) => {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('workspace not found');
  return listBranches(ws.repoPath);
});

handle('nvim:start', async (_e, id: string, cols: number, rows: number) => {
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

ipcMain.handle(
  'workspaces:renameBranch',
  async (_e, id: string, newBranch: string) => {
    return renameWorkspaceBranch(id, newBranch, { manual: true }, getMainWindow());
  },
);

handle('git:merge', async (_e, id: string) => {
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

handle('git:switchBranch', async (_e, id: string, branch: string) => {
  return switchWorkspaceBranch(id, branch, getMainWindow());
});

// ---------- Repo scripts (setup / run / archive) ----------

handle('repos:getScripts', (_e, repoPath: string) => {
  return store.getRepoScripts(repoPath);
});

handle('repos:setScripts', async (_e, repoPath: string, scripts: RepoScripts) => {
  return store.setRepoScripts(repoPath, scripts);
});

handle('scripts:retrySetup', async (_e, id: string) => {
  await runSetupScript(id, getMainWindow());
});

handle('scripts:readSetupLog', (_e, id: string) => {
  return readScriptLog(setupLogPath(id));
});

handle('scripts:runStart', async (_e, id: string, cols: number, rows: number) => {
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
  const { command, args } = loginShellArgv(script);
  await startPty({
    id: runId,
    cwd: ws.worktreePath,
    command,
    args,
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

handle('scripts:runStop', (_e, id: string) => {
  stopPty(`${id}:run`);
});

handle('scripts:runScrollback', (_e, id: string) => {
  return readScrollback(`${id}:run`);
});

// ---------- Dependency Check ----------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    await pExecFile('command', ['-v', cmd], { shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

async function checkDependencies(): Promise<void> {
  // Probe all three in parallel rather than three serial subshell spawns. This
  // is on the boot path (before the window), so the difference is real wall
  // time the user waits at a blank screen.
  const [hasGit, hasGh, hasClaude] = await Promise.all([
    checkCommand('git'),
    checkCommand('gh'),
    checkCommand('claude'),
  ]);
  const missing: { name: string; desc: string; install: string }[] = [];

  if (!hasGit) {
    missing.push({
      name: 'git',
      desc: 'Git version control',
      install: 'Fedora: sudo dnf install git\nUbuntu: sudo apt install git',
    });
  }

  if (!hasGh) {
    missing.push({
      name: 'gh',
      desc: 'GitHub CLI (for PR creation)',
      install: 'Fedora: sudo dnf install gh\nUbuntu: sudo apt install gh\nOr: https://cli.github.com/',
    });
  }

  if (!hasClaude) {
    missing.push({
      name: 'claude',
      desc: 'Claude Code CLI',
      install: 'npm install -g @anthropic-ai/claude-code\nOr: https://docs.anthropic.com/claude-code',
    });
  }

  if (missing.length > 0) {
    const message = missing
      .map((m) => `❌ ${m.name}\n   ${m.desc}\n   Install:\n   ${m.install}`)
      .join('\n\n');

    await dialog.showMessageBox({
      type: 'warning',
      title: 'Missing Dependencies',
      message: 'Orchestra requires the following tools:',
      detail: message,
      buttons: ['Continue Anyway', 'Quit'],
      defaultId: 1,
    }).then(({ response }) => {
      if (response === 1) {
        app.quit();
      }
    });
  }
}

// ---------- Lifecycle ----------
// In CLI mode the GUI lifecycle is never wired up — the dynamic import at the
// top of this module handles the command and exits the process.

if (!ORCHESTRA_CLI_MODE) {
  app.whenReady().then(async () => {
    initLogger();
    try {
      // Dependency probing spawns subshells; don't make the user wait at a
      // blank screen for it. Run it concurrently with window creation — the
      // only thing it does is pop a warning dialog when a tool is missing,
      // which is fine to surface a beat after the window opens.
      void checkDependencies().catch((e) => log.warn('checkDependencies failed', e));
      await createMainWindow();
      installCliShim();
      log.info('main window ready');
    } catch (e) {
      log.error('startup failed', e);
      throw e;
    }
  });

  app.on('window-all-closed', () => {
    log.info('window-all-closed — shutting down');
    stopAll();
    stopEventsSpool();
    stopHooksServer();
    stopUsagePolling();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopAll();
    stopEventsSpool();
    stopHooksServer();
    stopUsagePolling();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}
