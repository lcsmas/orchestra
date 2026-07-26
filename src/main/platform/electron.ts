import { app, safeStorage, shell, BrowserWindow, Notification } from 'electron';
import path from 'node:path';
import { type OrchestraPlatform, type UiNotification } from './index';
import { closeLoginBrowser, openLoginBrowser } from '../login-browser';

// The Electron implementation of the platform seam, aimed at the real main
// window.

/** The old pty.ts / activity.ts guard, verbatim: a window that is destroyed or
 *  whose webContents is mid-teardown cannot receive sends. */
function canSend(win: BrowserWindow | null): win is BrowserWindow {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
}

/** Build the Electron-mode platform. `getWindow` is a live accessor (not a
 *  captured value) because the main window is created after boot and can in
 *  principle be recreated; every call re-reads it. */
export function createElectronPlatform(getWindow: () => BrowserWindow | null): OrchestraPlatform {
  return {
    kind: 'electron',

    broadcast(channel, ...args) {
      const win = getWindow();
      if (canSend(win)) win.webContents.send(channel, ...args);
    },

    broadcastPtyData(id, data) {
      const win = getWindow();
      // Preserve pty.ts's retention contract exactly: while the window can't
      // receive, report undelivered so the caller keeps its buffer — a
      // renderer rebuild must never lose bytes (that permanently desyncs
      // xterm from the child's diff-render model).
      if (!canSend(win)) return false;
      win.webContents.send('pty:data', id, data);
      return true;
    },

    canBroadcast() {
      return canSend(getWindow());
    },

    isFocused() {
      const win = getWindow();
      return !!win && !win.isDestroyed() && win.isFocused();
    },

    hasAttachedUi() {
      return canSend(getWindow());
    },

    notify(n: UiNotification) {
      // Native Electron notification with click-to-focus — unchanged. Errors
      // are swallowed exactly as before (notifications unsupported).
      try {
        const toast = new Notification({ title: n.title, body: n.body, silent: true });
        toast.on('click', () => {
          const win = getWindow();
          if (win && !win.isDestroyed()) {
            win.show();
            win.focus();
          }
          this.broadcast('workspace:focus', n.wsId);
        });
        toast.show();
      } catch {
        /* notifications unsupported on this platform */
      }
    },

    async openExternal(url) {
      await shell.openExternal(url);
    },

    showItemInFolder(p) {
      shell.showItemInFolder(p);
    },

    openPath(p) {
      return shell.openPath(p);
    },

    openAccountLoginUrl(accountId, url, label) {
      openLoginBrowser(accountId, url, label);
    },

    closeAccountLogin(accountId) {
      closeLoginBrowser(accountId);
    },

    getUserDataDir() {
      return app.getPath('userData');
    },

    getLogsDir() {
      // app.getPath('logs') is only valid after `ready`; fall back to
      // userData/logs if called earlier so logger init never throws.
      try {
        return app.getPath('logs');
      } catch {
        return path.join(app.getPath('userData'), 'logs');
      }
    },

    getAppVersion() {
      return app.getVersion();
    },

    getAppMetrics() {
      // getAppMetrics measures CPU since ITS last call, which matches the
      // Resources page's own tick cadence. workingSetSize is KiB.
      return app.getAppMetrics().map((m) => ({
        type: m.type,
        pid: m.pid,
        cpuPct: m.cpu?.percentCPUUsage ?? 0,
        memBytes: (m.memory?.workingSetSize ?? 0) * 1024,
      }));
    },

    isEncryptionAvailable() {
      return safeStorage.isEncryptionAvailable();
    },

    encryptString(plain) {
      return safeStorage.encryptString(plain);
    },

    decryptString(cipher) {
      return safeStorage.decryptString(cipher);
    },
  };
}
