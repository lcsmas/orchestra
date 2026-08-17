import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, clipboard, session, shell } from 'electron';
import {
  CHROMIUM_CANDIDATES,
  chromiumLoginArgv,
  isLaunchableUrl,
  loginProfileDirName,
} from '../shared/login-chromium';
import { orchestraHome } from './platform';
import { log } from './logger';

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
// platform implementation and index.ts.

const windows = new Map<string, BrowserWindow>();

// ---------- Per-account Chromium profile (preferred surface) ----------
//
// See src/shared/login-chromium.ts for why a real browser beats the embedded
// window: Electron cannot run an MV3 extension's service worker, so password
// managers are inert inside a BrowserWindow. A dedicated `--user-data-dir`
// gives the same cookie-jar isolation *and* the user's real extensions.

/** Chromium child processes we launched, per account, so a login can be closed
 *  the same way the BrowserWindow path is. */
const browsers = new Map<string, ReturnType<typeof spawn>>();

/** Resolve a Chromium-family binary, or null if none is installed. Probing
 *  PATH ourselves (rather than trusting a bare name to `spawn`) is deliberate:
 *  on Fedora `chromium` is a shell alias with no executable behind it, so
 *  spawning it fails with ENOENT at runtime — after we have already committed
 *  to this path and closed off the fallback. */
function findChromium(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of CHROMIUM_CANDIDATES) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here; keep looking */
      }
    }
  }
  return null;
}

/** Launch the account's dedicated Chromium profile at `url`.
 *  Returns false when Chromium is unavailable or the spawn fails, so the
 *  caller can fall back to the embedded window rather than stranding the
 *  login with nothing on screen. */
function openLoginChromium(accountId: string, url: string): boolean {
  if (!isLaunchableUrl(url)) return false;
  const bin = findChromium();
  if (!bin) {
    log.info('login-browser: no Chromium found, using embedded window');
    return false;
  }
  const profileDir = path.join(orchestraHome(), 'login-profiles', loginProfileDirName(accountId));
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    // An existing profile for this account means a browser may already be up;
    // Chromium's own singleton handles that, routing the URL to that instance.
    const child = spawn(bin, chromiumLoginArgv(profileDir, url), {
      detached: true,
      stdio: 'ignore',
    });
    // Without this the child would keep the app alive on quit.
    child.unref();
    child.on('error', (e) => log.warn(`login-browser: Chromium spawn failed: ${String(e)}`));
    browsers.set(accountId, child);
    log.info(`login-browser: opened Chromium profile for account ${accountId} (${bin})`);
    return true;
  } catch (e) {
    log.warn(`login-browser: could not launch Chromium: ${String(e)}`);
    return false;
  }
}

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

/** Open the account's OAuth surface at `url`.
 *
 *  Prefers a real Chromium bound to a per-account `--user-data-dir`: same
 *  cookie-jar isolation as the embedded window, but the user's password
 *  manager actually works there (an MV3 extension's service worker cannot run
 *  inside Electron). Falls back to the embedded BrowserWindow when no
 *  Chromium-family browser is installed. */
export function openLoginBrowser(accountId: string, url: string, label?: string): void {
  if (openLoginChromium(accountId, url)) return;
  openLoginWindow(accountId, url, label);
}

/** The embedded fallback: one window per account, bound to that account's
 *  persistent session partition. A second URL while it's open re-navigates. */
function openLoginWindow(accountId: string, url: string, label?: string): void {
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

  // The Chromium path: kill the profile's browser so a finished login doesn't
  // leave a stray window. `detached: true` put the child in its own process
  // group, so signal the GROUP (-pid) — signalling just the pid leaves the
  // renderer/zygote children of that group alive and the window on screen.
  const child = browsers.get(accountId);
  browsers.delete(accountId);
  if (child?.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Group already gone (user closed the browser themselves) — or the pid
      // was reaped between the check and here. Nothing to clean up.
    }
  }
}

