// Minimal `electron` stub for the R2 harness ONLY. The scenario under test is
// pure main-process logic (consume()'s finally + the store write); none of
// these surfaces is exercised. Anything actually needed by the path under test
// must NOT be stubbed away silently — the harness asserts the observable in the
// STORE, so a stub that swallowed the write would show up as a failed arm.
const noop = () => {};
export const app = {
  getPath: () => '/tmp/r2-userdata', whenReady: async () => {}, on: noop, once: noop,
  isReady: () => true, getVersion: () => '0.0.0-r2', getName: () => 'orchestra',
  setPath: noop, quit: noop, relaunch: noop, setLoginItemSettings: noop,
  requestSingleInstanceLock: () => true, disableHardwareAcceleration: noop,
  commandLine: { appendSwitch: noop },
};
export class BrowserWindow { static getAllWindows() { return []; } constructor() {} on() {} }
export class WebContentsView { constructor() {} }
export const Menu = { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop };
export const MenuItem = class {};
export const ipcMain = { on: noop, once: noop, handle: noop, removeHandler: noop };
export const clipboard = { writeText: noop, readText: () => '' };
export const session = { fromPartition: () => ({ setPermissionRequestHandler: noop, webRequest: { onBeforeSendHeaders: noop } }), defaultSession: { setPermissionRequestHandler: noop } };
export const shell = { openExternal: async () => {}, showItemInFolder: noop, openPath: async () => '' };
export const dialog = { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: noop };
export class Notification { constructor() {} show() {} on() {} static isSupported() { return false; } }
export const nativeTheme = { on: noop, shouldUseDarkColors: true };
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) };
export const webContents = { getAllWebContents: () => [] };
export const globalShortcut = { register: () => false, unregisterAll: noop };
export const powerMonitor = { on: noop };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1600, height: 1000 } }), getAllDisplays: () => [] };
export const Tray = class { constructor() {} setToolTip() {} setContextMenu() {} on() {} };
export const autoUpdater = { on: noop, checkForUpdates: async () => null, setFeedURL: noop };
export default { app, BrowserWindow, WebContentsView, Menu, MenuItem, ipcMain, clipboard, session, shell, dialog, Notification, nativeTheme, nativeImage, webContents, globalShortcut, powerMonitor, screen, Tray, autoUpdater };
