import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  anyUiClientFocused,
  sinkEvent,
  sinkPtyData,
  uiClientCount,
  type OrchestraPlatform,
} from './index.ts';

// The headless (plain-Node / daemon) implementation of the platform seam.
// No Electron import anywhere in this file's graph — that is what lets
// dist-electron/daemon.js run under a bare `node`. Where the Electron
// implementation talks to a window, this one talks only to attached ui-rpc
// clients; where Electron owns a UI surface (dialogs, the OAuth window),
// the plan's touchpoint table says "frontend-side", so this side just emits
// the corresponding event or no-ops.
//
// Imports carry explicit `.ts` extensions so the module (and everything it
// pulls in) also resolves under Node's type-stripping test runner.

/** Mirror of Electron's per-platform userData default, so a daemon with no
 *  ORCHESTRA_HOME override reads THE SAME store.json the packaged app does
 *  (app name "orchestra"). Linux: $XDG_CONFIG_HOME|~/.config; macOS:
 *  ~/Library/Application Support; Windows: %APPDATA%. */
function defaultUserDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'orchestra');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'orchestra');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'orchestra');
}

/** Read the backend version out of package.json. The bundle lands at
 *  dist-electron/daemon.js (repo root one level up); under the test runner
 *  the module lives at src/main/platform/ (root three levels up) — walk up
 *  until the orchestra package.json appears. Resolved once. */
function readPackageVersion(): string {
  // __dirname exists in the CJS vite bundle; under the ESM test runner fall
  // back to cwd (tests run from the repo root).
  let dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (parsed.name === 'orchestra' && parsed.version) return parsed.version;
    } catch {
      /* keep climbing */
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}

/** Fire-and-forget `xdg-open` (Linux) / `open` (macOS) — the daemon's stand-in
 *  for Electron's shell helpers. Detached so a slow handler never blocks us. */
function xdgOpen(target: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* no opener available — a headless box; nothing sensible to do */
  }
}

/** Build the headless-mode platform. */
export function createHeadlessPlatform(): OrchestraPlatform {
  let version: string | null = null;
  // getAppMetrics parity: Electron reports CPU since the previous call, so we
  // delta process.cpuUsage() against the last sample the same way.
  let prevCpu = process.cpuUsage();
  let prevAt = Date.now();

  return {
    kind: 'daemon',

    broadcast(channel, ...args) {
      sinkEvent(channel, args);
    },

    broadcastPtyData(id, data) {
      // No Electron renderer to protect from a drop: clients replay
      // scrollback on attach, so delivery is always "done" here.
      sinkPtyData(id, data);
      return true;
    },

    canBroadcast() {
      return true;
    },

    isFocused() {
      return anyUiClientFocused();
    },

    hasAttachedUi() {
      return uiClientCount() > 0;
    },

    notify(n) {
      // Native notifications are frontend-side in daemon mode: emit the
      // ui:notify event and let the attached client post its own.
      sinkEvent('ui:notify', [n]);
    },

    async openExternal(url) {
      xdgOpen(url);
    },

    showItemInFolder(p) {
      // No file-manager "select this file" API without a desktop toolkit —
      // opening the containing directory is the honest equivalent.
      xdgOpen(path.dirname(p));
    },

    async openPath(p) {
      xdgOpen(p);
      return '';
    },

    openAccountLoginUrl(accountId, url) {
      // The OAuth window is frontend-side (GTK WebKit view): forward the
      // gated URL as the spec's accountsLoginUrl event.
      sinkEvent('accounts:loginUrl', [{ accountId, url }]);
    },

    closeAccountLogin() {
      // Frontend-owned window; onAccountLoginDone tells the client to close.
    },

    getUserDataDir() {
      if (process.env.ORCHESTRA_HOME) return path.join(process.env.ORCHESTRA_HOME, 'userData');
      return defaultUserDataDir();
    },

    getLogsDir() {
      // Electron's Linux logs dir is userData/logs — mirror it so app and
      // daemon write the same diagnostic files.
      return path.join(this.getUserDataDir(), 'logs');
    },

    getAppVersion() {
      if (version === null) version = readPackageVersion();
      return version;
    },

    getAppMetrics() {
      const now = Date.now();
      const cpu = process.cpuUsage(prevCpu); // µs since the previous sample
      const elapsedMs = Math.max(1, now - prevAt);
      prevCpu = process.cpuUsage();
      prevAt = now;
      const cpuPct = ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100;
      return [
        {
          type: 'daemon',
          pid: process.pid,
          cpuPct,
          memBytes: process.memoryUsage.rss(),
        },
      ];
    },

    isEncryptionAvailable() {
      // No OS-keyring bridge without Electron: secrets.ts falls back to its
      // documented 0600-plaintext path.
      return false;
    },

    encryptString(): Buffer {
      throw new Error('safeStorage unavailable in headless mode');
    },

    decryptString(): string {
      throw new Error('safeStorage unavailable in headless mode');
    },
  };
}
