import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import path from 'node:path';
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

// ORCHESTRA_HOME relocates ALL of this instance's mutable state — userData
// (store.json, login dirs) and, via getEventsDir(), the activity event spool
// dir — under one root. Set it for a dev build (`vite` → `electron .`) so dev
// and a packaged app run fully isolated: separate stores, separate spools, and
// separate single-instance locks (the lock is keyed by userData). MUST run
// before `import { store }` below — the store resolves userData lazily but
// well before anything else moves it. A no-op when unset (the packaged
// default). The CLI path returned above never reaches here.
if (!ORCHESTRA_CLI_MODE && process.env.ORCHESTRA_HOME) {
  app.setPath('userData', path.join(process.env.ORCHESTRA_HOME, 'userData'));
}
import { initPlatform } from './platform';
import { createElectronPlatform } from './platform/electron';
import { store } from './store';
import {
  ensureRoot,
  pruneOrphanedWorkspaces,
} from './workspaces';
import { stopAll } from './pty';
import { startHooksServer, stopHooksServer } from './hooks-server';
import { installCliShim, installAgentCliShim } from './cli-shim';
import { startEventsSpool, stopEventsSpool } from './events-spool';
import { startUsagePolling, stopUsagePolling } from './usage';
import { startAccountUsagePolling, stopAccountUsagePolling } from './account-usage';
import { seedAccountInheritDefaults, syncAllAccountsInheritance } from './account-inherit';
import { closeAllSandboxConnections } from './transport/sandbox-manager';
import { startSandboxAutoBackup } from './sandbox-import';
import { primeLocalSyncStates, syncAllRepos } from './repo-sync';
import { startPromptQueueFlusher, stopPromptQueueFlusher } from './prompt-queue';
import { startSelfTuneScheduler, stopSelfTuneScheduler } from './self-tune';
import { apiHandlers, METHOD_IPC_CHANNELS, openUrlExternally } from './api-handlers';
import { probeDependencies } from './deps';
import { startUiRpcServer, type UiRpcServer } from './ui-rpc';
import { acquireBackendLock, releaseBackendLock } from './backend-lock';
import { initLogger, log } from './logger';

let mainWindow: BrowserWindow | null = null;
let uiRpcServer: UiRpcServer | null = null;

// The platform seam (src/main/platform/): every subsystem broadcasts, opens
// URLs, reads app paths, etc. through it instead of touching Electron. The
// Electron implementation targets the main window via this live accessor —
// installed at module scope so it is in place before the first store access.
initPlatform(createElectronPlatform(() => mainWindow));

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
  // Electron ≥ rejects CDP websocket handshakes whose Origin isn't allowlisted
  // (403), so chrome-devtools-mcp / any external inspector can't attach without
  // this. Dev-only, gated by the same condition as the port above.
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

async function createMainWindow() {
  await store.load();
  // Seed default inheritance for any account that has none, then materialize
  // every account's selection into its login dir (symlinks + MCP merge) so an
  // alternate login starts with the user's global config in place. Best-effort:
  // never block startup on it.
  await seedAccountInheritDefaults().catch((err) =>
    log.warn('account-inherit: seeding failed', err),
  );
  void syncAllAccountsInheritance();
  await ensureRoot();

  // Drop the default Electron menu (File/Edit/View/Window/Help). We don't ship
  // any custom menu commands; the strip just eats vertical space.
  Menu.setApplicationMenu(null);

  // Window/taskbar icon (Linux WMs read it from the window, not the package).
  // Lives in dist/ (vite copies public/); absent in dev before a first build.
  const windowIcon = path.join(__dirname, '../dist/icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Orchestra',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    ...(fs.existsSync(windowIcon) ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // Hook server must be ready before any PTY spawns: spawned claude inherits
  // ORCHESTRA_SOCK from the env set on the pty.spawn call, and that value is
  // read from getHookSocketPath() which only returns non-null after listen().
  await startHooksServer();
  // Primary activity path: tail the durable per-workspace hook event spools.
  startEventsSpool();
  // Serve the ui-rpc socket so external frontends (the GTK app, tests) can
  // attach to THIS running app as their backend — same store, same PTYs, two
  // faces one state (docs/ui-rpc-protocol.md). Failure is non-fatal: the
  // Electron UI is fully functional without it.
  try {
    uiRpcServer = await startUiRpcServer({
      handlers: apiHandlers,
      appVersion: app.getVersion(),
      backendKind: 'electron',
    });
  } catch (e) {
    log.warn('ui-rpc server failed to start (external frontends unavailable)', e);
  }
  // Poll the signed-in account's rolling 5h/7d usage windows for the sidebar bars.
  startUsagePolling();
  // Poll each *configured* account's usage for the per-workspace badges.
  startAccountUsagePolling();
  // Deliver usage-limit-parked prompts once their account's window resets.
  startPromptQueueFlusher();
  // Monthly Insights & Improvements: auto-run the self-tune pipeline once per
  // calendar month (checked shortly after startup and every ~6h).
  startSelfTuneScheduler();
  // Periodic fail-safe snapshots of every sandbox-hosted workspace — the
  // container is the only copy of unpushed work, so a dead sandbox must cost
  // at most one backup interval.
  startSandboxAutoBackup();

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

  // Renderer crash recovery. A dead renderer otherwise leaves Chromium's white
  // "sad tab" page in the window until the user quits and relaunches by hand —
  // and the renderer is the process most likely to die: every opened workspace
  // keeps a 10k-line xterm (plus WebGL canvas) mounted for scrollback, so a
  // long session with many workspaces can push it past Chromium's per-process
  // memory limits. Everything the renderer holds is rebuildable from main
  // (store hydration, PTY scrollback replay, live event resubscription), so a
  // reload restores a working UI in place — agents keep running throughout;
  // pty.ts already retains undeliverable output while the window can't
  // receive. Guard against a crash loop (e.g. reload → restore same state →
  // OOM again): after 3 crashes in 60s, stop reloading and leave the sad page.
  let rendererCrashes: number[] = [];
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    rendererCrashes = rendererCrashes.filter((t) => now - t < 60_000);
    rendererCrashes.push(now);
    log.error(
      `renderer process gone: reason=${details.reason} exitCode=${details.exitCode} (crash ${rendererCrashes.length} in the last 60s)`,
    );
    if (rendererCrashes.length > 3) {
      log.error('renderer crash loop — giving up on auto-reload; restart Orchestra manually');
      return;
    }
    // Small delay so a system-wide event (OOM killer sweep, GPU reset) settles
    // before we ask Chromium to spin up a fresh renderer.
    setTimeout(() => {
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        log.info('reloading renderer after crash');
        w.webContents.reload();
      }
    }, 1000);
  });

  // Drop workspaces whose worktree was deleted out-of-band BEFORE the renderer
  // fetches the list, so stale "ghost" rows (a ~12 KB husk, no working actions)
  // never appear. Cheap (one `git worktree list` per repo); guarded against
  // pruning when a repo is merely unmounted. Best-effort — never block startup.
  await pruneOrphanedWorkspaces().catch((e) => log.warn('pruneOrphanedWorkspaces failed', e));

  if (VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Agents that were running when Orchestra last exited are NOT relaunched
  // here. Startup used to resume every one of them headlessly, which meant a
  // restart with many live workspaces immediately spawned that many `claude
  // --continue` processes, each reloading a full session. Instead the agent
  // starts the first time the user opens the workspace: TerminalView only
  // spawns its PTY once the tab is actually visible (fit dimensions gate),
  // and `pty:start` → startAgentPty picks `--continue` from ws.hasInput, so
  // the conversation still picks up where it left off — just on demand.

  // Base-branch sync: prime local state immediately (no network) so the
  // sidebar paints with whatever the on-disk refs say, then kick a real
  // fetch in the background. Prime must complete before sync starts —
  // otherwise the prime's late `syncing:false, syncedAt:0` event races
  // ahead of sync completion and clobbers the success state. Subsequent
  // fetches are driven by window focus.
  primeLocalSyncStates()
    .catch((e) => log.warn('primeLocalSyncStates failed', e))
    .then(() => syncAllRepos())
    .catch((e) => log.warn('syncAllRepos failed', e));
  mainWindow.on('focus', () => {
    void syncAllRepos().catch((e) => log.warn('syncAllRepos (focus) failed', e));
  });
}

function getMainWindow(): BrowserWindow {
  if (!mainWindow) throw new Error('main window not ready');
  return mainWindow;
}

// ---------- IPC ----------
//
// Every request/response handler lives in the shared table
// (src/main/api-handlers.ts), keyed by OrchestraAPI member name; here it is
// wired MECHANICALLY to its historical ipcMain channel, so the renderer and
// preload are untouched by the extraction. The ui-rpc server dispatches into
// the very same table — one behavior, two transports, zero drift.

for (const [method, channel] of Object.entries(METHOD_IPC_CHANNELS)) {
  const handler = apiHandlers[method as keyof typeof apiHandlers] as (
    ...args: unknown[]
  ) => unknown;
  handle(channel, (_e, ...args) => handler(...args));
}

// Frontend-local by design (docs/ui-rpc-protocol.md §4): the native directory
// picker needs a host window, so it is NOT part of the shared table — the GTK
// frontend implements its own (GtkFileDialog).
handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Special: workspaces:deleteProgress used to be sent to the invoking window
// from the deleteMany handler; the shared table now broadcasts it through the
// platform seam, which reaches this window identically.

// ---------- Dependency Check ----------

async function checkDependencies(): Promise<void> {
  // Same probe the ui-rpc `deps:status` method serves; here it feeds the
  // Electron-native warning dialog.
  const status = await probeDependencies();
  if (status.messages.length > 0) {
    await dialog
      .showMessageBox({
        type: 'warning',
        title: 'Missing Dependencies',
        message: 'Orchestra requires the following tools:',
        detail: status.messages.join('\n\n'),
        buttons: ['Continue Anyway', 'Quit'],
        defaultId: 1,
      })
      .then(({ response }) => {
        if (response === 1) {
          app.quit();
        }
      });
  }
}

// ---------- Lifecycle ----------
// In CLI mode the GUI lifecycle is never wired up — the dynamic import at the
// top of this module handles the command and exits the process.

function shutdownSubsystems(): void {
  stopAll();
  stopEventsSpool();
  stopHooksServer();
  stopUsagePolling();
  stopAccountUsagePolling();
  stopPromptQueueFlusher();
  stopSelfTuneScheduler();
  closeAllSandboxConnections();
  if (uiRpcServer) {
    void uiRpcServer.close().catch(() => {});
    uiRpcServer = null;
  }
  releaseBackendLock();
}

if (!ORCHESTRA_CLI_MODE) {
  // Single-instance guard. Two GUI instances would share the same global event
  // spool dir (~/.orchestra/events) and the same store.json (both keyed off a
  // fixed userData), and each one wipes the events dir on startup and tails
  // every spool. A second launch landing on a live agent's spool resets its
  // `.seq` counter under the first instance's cursor, so the next `stop` arrives
  // with seq=1, is treated as an already-seen duplicate, and is dropped — the
  // status dot then sticks on its last `running`/`idle` value. Refuse to run a
  // second instance: hand our argv to the primary (which focuses its window)
  // and quit before `ready`, so we never open a window or touch shared state.
  //
  // Keyed by userData, so a dev build pointed at a separate userData (and thus a
  // separate events dir) via ORCHESTRA_HOME can still run alongside a packaged
  // app — they take different locks. The CLI path returned above never reaches
  // here; it talks to the running app over the socket and must not take a lock.
  if (!app.requestSingleInstanceLock()) {
    // We lost the race: a primary instance already holds the lock and will get
    // our launch via its `second-instance` handler (focusing its window). Exit
    // immediately — `app.exit(0)`, not `app.quit()` — so the lifecycle wiring
    // below never runs and we never reach `ready`, touch the shared store, or
    // wipe the events dir. Mirrors the ozone-relaunch bail above.
    log.info('another Orchestra instance is already running — focusing it and exiting');
    app.exit(0);
  }

  // Backend lock: the Electron single-instance lock only fences app-vs-app.
  // The HEADLESS DAEMON (src/main/daemon.ts) is an equal backend over the
  // same ORCHESTRA_HOME — the same events-spool wipe hazard applies — so both
  // take this shared lockfile (liveness = pid probe). Refuse to run while a
  // daemon owns the home.
  const lock = acquireBackendLock('electron');
  if (!lock.ok) {
    log.info(
      `an orchestra ${lock.holder.kind} backend (pid ${lock.holder.pid}) already owns this ORCHESTRA_HOME — exiting`,
    );
    dialog.showErrorBox(
      'Orchestra backend already running',
      `An Orchestra ${lock.holder.kind === 'daemon' ? 'daemon' : 'app'} (pid ${lock.holder.pid}) is already running for this data directory.\n\nStop it first, then relaunch Orchestra.`,
    );
    app.exit(1);
  }

  app.on('second-instance', () => {
    // A second launch was attempted against this (primary) instance; surface
    // the existing window instead of opening another.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Diagnostics for helper-process deaths (GPU, utility, …). Nothing to
  // recover here — Chromium respawns these itself — but the log line is the
  // only breadcrumb tying a later renderer crash or blank canvas to, say, a
  // GPU process reset that happened seconds earlier.
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    log.warn(
      `child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${details.name ? ` name=${details.name}` : ''}`,
    );
  });

  app.whenReady().then(async () => {
    initLogger();
    try {
      // Dependency probing spawns subshells; don't make the user wait at a
      // blank screen for it. Run it concurrently with window creation — the
      // only thing it does is pop a warning dialog when a tool is missing,
      // which is fine to surface a beat after the window opens.
      void checkDependencies().catch((e) => log.warn('checkDependencies failed', e));
      // Agent-facing shim: written to a dir we prepend to every agent PTY's
      // PATH (see main/pty.ts), so the CLI the injected skills/hooks call
      // resolves regardless of the user's login PATH or platform. MUST run
      // before createMainWindow(), after which the renderer can start agent
      // PTYs at any moment — otherwise an early agent could get the PATH
      // entry before the shim file exists and fall through to the raw
      // binary (which launches the GUI on a bare `orchestra <subcmd>`).
      installAgentCliShim();
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
    shutdownSubsystems();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    shutdownSubsystems();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}
