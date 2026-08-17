// Pure (Electron-free) helpers for the per-account Chromium login profile.
//
// The account login used to run in an Electron BrowserWindow bound to a
// per-account session partition. That gave isolation but NOT password-manager
// autofill: Electron's Chromium cannot run a Manifest V3 extension's service
// worker (measured on Electron 33 / Chromium 33 against 1Password 8.12 — the
// extension loads, then `chrome.action` / `offscreen` / `privacy` / `windows`
// are all missing, the worker throws on startup and never registers, so the
// extension is inert while still *looking* installed).
//
// The insight that unblocks it: per-account isolation was never a *browser*
// requirement, it is a *cookie jar* requirement — the only reason the system
// browser is wrong is that its jar already holds the user's MAIN account
// session. A real Chromium launched against a dedicated `--user-data-dir` has
// its own jar (verified: a fresh profile carries no `sessionKey`, while the
// user's Default profile does), and being real Chromium it runs the user's
// real extensions. So each account gets its own persistent Chromium profile.
//
// Kept dependency-free so it is unit-testable without booting Electron.

/** Chromium binaries we try, in order. `chromium-browser` is the real binary
 *  on Fedora (`chromium` there is a shell alias, not an executable — resolving
 *  it via a PATH lookup finds nothing, which is why the list is explicit). */
export const CHROMIUM_CANDIDATES = [
  'chromium-browser',
  'chromium',
  'google-chrome-stable',
  'google-chrome',
  'brave-browser',
  'microsoft-edge',
] as const;

/** Directory name holding an account's dedicated Chromium profile. Account ids
 *  are uuids, but sanitize anyway: this becomes a filesystem path, and a `..`
 *  or separator in it would escape the profiles root. */
export function loginProfileDirName(accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `login-${safe || 'unknown'}`;
}

/** Argv for launching `url` in an isolated Chromium profile.
 *
 *  `--user-data-dir` (NOT `--profile-directory`) is what actually separates the
 *  cookie jar: `--profile-directory` names a profile *inside* the default user
 *  data dir, so it shares the singleton process and would just open a tab in
 *  the user's already-running browser — inheriting the main account's session
 *  and defeating the whole point. A distinct user-data-dir gets its own
 *  process, its own jar, and its own extension state. */
export function chromiumLoginArgv(profileDir: string, url: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    // First-run UX noise would sit on top of the login page.
    '--no-first-run',
    '--no-default-browser-check',
    // Keep this profile out of the user's default-browser plumbing.
    '--disable-features=ChromeWhatsNewUI',
    url,
  ];
}

/** Whether `url` is safe to hand to a browser launch. Guards against argv
 *  injection: a leading `-` would be parsed as a Chromium FLAG rather than a
 *  URL, letting a crafted auth URL smuggle switches into the command line. */
export function isLaunchableUrl(url: string): boolean {
  if (url.startsWith('-')) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
