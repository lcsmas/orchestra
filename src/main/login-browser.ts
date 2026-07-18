import { BrowserWindow, Menu, clipboard, session, shell } from 'electron';

// Per-account OAuth browser windows for the interactive account login.
//
// The whole point of a configured account is to be a DIFFERENT Claude login,
// but the OAuth half of `claude /login` used to open in the system browser —
// whose one claude.ai cookie jar is already authenticated as the user's main
// account, so "log in account B" silently authorized account A again. Instead,
// each account gets an Electron BrowserWindow bound to its own persistent
// session partition (`persist:claude-login-<id>`): an isolated cookie jar per
// account, so signing in as B can't reuse A's browser session, and a later
// re-login of B lands on B's remembered session.
//
// URLs reach here from two directions, both funneled through
// login-url.ts's dispatchLoginUrlRequest (the Electron-free router) via the
// platform seam: the login PTY's xdg-open/open PATH shim (via `orchestra
// login-url` → the /loginUrl socket route) intercepting claude's automatic
// browser-open, and the login modal's link handler for the printed fallback
// URL. Non-Claude URLs fall through to the system browser before reaching
// this module. This file is Electron-only — imported solely by the electron
// platform implementation and index.ts, never by the daemon bundle.

const windows = new Map<string, BrowserWindow>();

/** The session partition holding an account's isolated claude.ai cookie jar.
 *  `persist:` so a re-login months later still lands on the right session. */
function partitionFor(accountId: string): string {
  return `persist:claude-login-${accountId}`;
}

/** Strip the Electron/Orchestra tokens from the partition's user agent so the
 *  window reads as plain Chrome. Google (a common claude.ai sign-in method)
 *  rejects OAuth from anything it classifies as an embedded webview by UA;
 *  a full Chromium with a normal UA passes. */
function normalizeUserAgent(ses: Electron.Session): void {
  const ua = ses.getUserAgent().replace(/\s(?:Electron|Orchestra)\/\S+/gi, '');
  ses.setUserAgent(ua);
}

/** Right-click escape hatches: the embedded window is the default, but the
 *  user can always bail to the system browser (e.g. if an IdP misbehaves). */
function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', () => {
    const url = win.webContents.getURL();
    Menu.buildFromTemplate([
      { label: 'Back', enabled: win.webContents.navigationHistory.canGoBack(), click: () => win.webContents.navigationHistory.goBack() },
      { label: 'Reload', click: () => win.webContents.reload() },
      { type: 'separator' },
      { label: 'Copy URL', click: () => clipboard.writeText(url) },
      { label: 'Open in system browser', click: () => void shell.openExternal(url) },
    ]).popup({ window: win });
  });
}

/** Open (or refocus) the OAuth window for `accountId` and navigate it to
 *  `url`. One window per account; a second URL while it's open re-navigates. */
export function openLoginBrowser(accountId: string, url: string, label?: string): void {
  const existing = windows.get(accountId);
  if (existing && !existing.isDestroyed()) {
    void existing.loadURL(url);
    existing.focus();
    return;
  }
  const ses = session.fromPartition(partitionFor(accountId));
  normalizeUserAgent(ses);
  const win = new BrowserWindow({
    width: 560,
    height: 760,
    title: label ? `Log in — ${label}` : 'Log in',
    autoHideMenuBar: true,
    webPreferences: {
      partition: partitionFor(accountId),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Keep our title (the page would overwrite it with its own on each nav).
  win.on('page-title-updated', (e) => e.preventDefault());
  // IdP popups (e.g. "Continue with Google") inherit the partition; anything
  // non-web goes to the OS instead.
  win.webContents.setWindowOpenHandler(({ url: child }) => {
    if (child.startsWith('https:') || child.startsWith('http:')) return { action: 'allow' };
    void shell.openExternal(child);
    return { action: 'deny' };
  });
  attachContextMenu(win);
  win.on('closed', () => {
    if (windows.get(accountId) === win) windows.delete(accountId);
  });
  windows.set(accountId, win);
  void win.loadURL(url);
}

/** Close an account's OAuth window if open — called when the login watcher
 *  detects the token landed, and when the login PTY is stopped. */
export function closeLoginBrowser(accountId: string): void {
  const win = windows.get(accountId);
  windows.delete(accountId);
  if (win && !win.isDestroyed()) win.close();
}

