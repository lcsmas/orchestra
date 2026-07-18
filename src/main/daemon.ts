// The headless Orchestra backend ("orchestra daemon", docs/gtk4-port-plan.md
// §1.2): boots every existing subsystem WITHOUT a BrowserWindow and serves the
// ui-rpc socket as its only UI surface. External frontends (the GTK app,
// tests) attach over that socket and get the same store, PTYs, hooks server,
// pollers and events pipeline the Electron app hosts — two faces, one state.
//
// Runs under BOTH the Electron runtime (`Orchestra.AppImage daemon`) and plain
// Node (`node dist-electron/daemon.js` — dev). The platform seam makes that
// possible: this entry installs the headless implementation, so nothing in the
// module graph ever require()s 'electron' (which the daemon vite config marks
// external — a stray import would crash a plain-Node boot immediately, which
// is exactly the regression signal we want).
//
// Boot order mirrors index.ts's createMainWindow minus the window/renderer:
// shell-env merge → platform + logger → backend lock → store → hooks server →
// events spool → ui-rpc server → pollers/schedulers → repo sync.

import { shellEnvSync } from 'shell-env';

// Same launcher-environment repair as the Electron entry (see index.ts): a
// desktop- or service-launched daemon inherits a bare environment, and agent
// PTYs need the user's PATH + rc-exported secrets. Strip npm_* lifecycle vars
// first so `nvm use` in run scripts keeps working.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('npm_')) delete process.env[key];
}
try {
  Object.assign(process.env, shellEnvSync());
} catch {
  /* shell-env falls back internally */
}

import { initPlatform, orchestraHome } from './platform';
import { createHeadlessPlatform } from './platform/headless';

// The seam must be live before ANY subsystem import touches paths/logging.
// (Imports are hoisted above this statement, but nothing reads the platform at
// module-load time — store/logger resolve lazily by design.)
initPlatform(createHeadlessPlatform());

import { platform } from './platform';
import { store } from './store';
import { ensureRoot, pruneOrphanedWorkspaces } from './workspaces';
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
import { apiHandlers } from './api-handlers';
import { startUiRpcServer, type UiRpcServer } from './ui-rpc';
import { acquireBackendLock, releaseBackendLock } from './backend-lock';
import { initLogger, log } from './logger';

let uiRpcServer: UiRpcServer | null = null;
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('daemon shutting down');
  stopAll();
  stopEventsSpool();
  stopHooksServer();
  stopUsagePolling();
  stopAccountUsagePolling();
  stopPromptQueueFlusher();
  stopSelfTuneScheduler();
  closeAllSandboxConnections();
  const finish = () => {
    releaseBackendLock();
    process.exit(code);
  };
  if (uiRpcServer) {
    void uiRpcServer.close().then(finish, finish);
    uiRpcServer = null;
  } else {
    finish();
  }
}

async function main(): Promise<void> {
  initLogger();

  // One backend per ORCHESTRA_HOME — the Electron app and this daemon share
  // the lockfile, so they can never wipe each other's events spool or race
  // store.json (docs/gtk4-port-plan.md §1.1).
  const lock = acquireBackendLock('daemon');
  if (!lock.ok) {
    const msg = `an orchestra ${lock.holder.kind} backend (pid ${lock.holder.pid}) already owns ${orchestraHome()} — refusing to start a second backend`;
    log.error(msg);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }

  await store.load();
  await seedAccountInheritDefaults().catch((err) =>
    log.warn('account-inherit: seeding failed', err),
  );
  void syncAllAccountsInheritance();
  await ensureRoot();

  // Agent-facing CLI shim before anything can spawn a PTY (same ordering
  // constraint as index.ts), then the user-facing shim.
  installAgentCliShim();
  installCliShim();

  // Hook server before any PTY spawn (ORCHESTRA_SOCK must resolve), then the
  // spool tailer. The spool's drain gate generalizes through the seam: it
  // consumes only while ≥1 ui-rpc client is attached (there is no renderer
  // window here), so events wait replayable on disk until a UI can apply them.
  await startHooksServer();
  startEventsSpool();

  uiRpcServer = await startUiRpcServer({
    handlers: apiHandlers,
    appVersion: platform.getAppVersion(),
    backendKind: 'daemon',
  });

  startUsagePolling();
  startAccountUsagePolling();
  startPromptQueueFlusher();
  startSelfTuneScheduler();
  startSandboxAutoBackup();

  await pruneOrphanedWorkspaces().catch((e) => log.warn('pruneOrphanedWorkspaces failed', e));
  primeLocalSyncStates()
    .catch((e) => log.warn('primeLocalSyncStates failed', e))
    .then(() => syncAllRepos())
    .catch((e) => log.warn('syncAllRepos failed', e));

  log.info(
    `orchestra daemon ready — home=${orchestraHome()} ui-rpc=${uiRpcServer.socketPath} version=${platform.getAppVersion()}`,
  );
  // Also announce on stdout so `node daemon.js` users see the attach point.
  process.stdout.write(`orchestra daemon ready (ui-rpc: ${uiRpcServer.socketPath})\n`);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

void main().catch((e) => {
  log.error('daemon startup failed', e);
  process.stderr.write(`daemon startup failed: ${e instanceof Error ? e.message : String(e)}\n`);
  shutdown(1);
});
