import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { log } from './logger';
import { store } from './store';
import {
  classifyHttpError,
  expandConfigDir,
  isExpired,
  parseCredentials,
  parseUsageResponse,
  resolveWorkspaceAccountId,
  type AccountUsageStatus,
  type RawUsageResponse,
} from '../shared/accounts';
import type { Account, WorkspaceAccount } from '../shared/types';

// Per-account usage poller, config-dir model. Each configured account is a
// Claude Code config directory with its own `.credentials.json`; we read the
// OAuth access token straight out of that file (the same token Claude Code uses
// and auto-refreshes), call Anthropic's `/api/oauth/usage` with the headers
// Claude Code sends, and cache the result >=180s per account. The token never
// leaves this module — the renderer only sees an account's id/label and usage
// numbers (see AccountUsageStatus).

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The OAuth-app beta header Claude Code sends; the endpoint 404s without it.
const OAUTH_BETA = 'oauth-2025-04-20';

// Hard floor on how often we hit the endpoint per account (the requirement is
// >=180s). A given account's token is fetched at most once per this window.
const CACHE_MS = 180_000;
// How often the loop wakes to refetch stale accounts — well under CACHE_MS so a
// newly-added/just-logged-in account gets its first fetch promptly, but each
// account is still gated by its own cache age.
const POLL_MS = 30_000;

function userAgent(): string {
  // Without a Claude-Code-shaped User-Agent the endpoint aggressively rate
  // limits (429). Mirror Claude Code's format using Orchestra's version.
  let version = '0.0.0';
  try {
    version = app.getVersion();
  } catch {
    /* app unavailable in odd contexts */
  }
  return `claude-code/${version}`;
}

/** Absolute, expanded config dir for an account (or '' if its template is
 *  empty). */
export function accountConfigDir(account: Account): string {
  return expandConfigDir(account.configDir, os.homedir(), process.env);
}

/** Read the OAuth token from an account's `<configDir>/.credentials.json`.
 *  Returns a tagged result so the caller can surface 'no-dir' vs
 *  'not-logged-in' precisely. */
function readAccountCreds(
  account: Account,
): { dir: string; token: string; expiresAt?: number } | { dir: string; error: 'no-dir' | 'not-logged-in' } {
  const dir = accountConfigDir(account);
  if (!dir) return { dir: '', error: 'no-dir' };
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8');
  } catch {
    // No credentials file: either the dir doesn't exist or it was never
    // logged in. Distinguish so the badge can say the right thing.
    return { dir, error: fs.existsSync(dir) ? 'not-logged-in' : 'no-dir' };
  }
  const creds = parseCredentials(raw);
  if (!creds) return { dir, error: 'not-logged-in' };
  return { dir, token: creds.accessToken, expiresAt: creds.expiresAt };
}

/** The OAuth access token currently in a config dir's `.credentials.json`, or
 *  '' if none/unreadable. Used to snapshot pre-login state and detect when a
 *  login writes a (new) token. */
function tokenInDir(dir: string): string {
  try {
    const creds = parseCredentials(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    return creds?.accessToken ?? '';
  } catch {
    return '';
  }
}

/** Watch a config dir for an interactive `claude /login` completing. `claude
 *  /login` does not exit on success — it drops into a normal session — and
 *  Claude Code exposes no completion signal, so the robust cross-version
 *  approach is to watch the dir until a (new) OAuth token lands in
 *  `.credentials.json`, then fire `onLoggedIn` once. Uses fs.watch with a slow
 *  poll fallback (fs.watch is unreliable on some platforms / for atomic
 *  rename-into-place writes). Returns a disposer that stops watching.
 *
 *  `baselineToken` is the token present before login started; we only fire when
 *  the on-disk token is non-empty AND differs from it, so a re-login (token
 *  rotates) is detected too, and a stale pre-existing token doesn't false-fire. */
function watchForLogin(dir: string, baselineToken: string, onLoggedIn: () => void): () => void {
  let done = false;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const check = () => {
    if (done) return;
    const token = tokenInDir(dir);
    if (token && token !== baselineToken) {
      done = true;
      stop();
      onLoggedIn();
    }
  };

  const stop = () => {
    if (fsWatcher) {
      fsWatcher.close();
      fsWatcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  try {
    // Watch the directory (not the file): the file may not exist yet, and
    // Claude Code writes it via a temp-file + rename, which fires events on the
    // directory entry rather than a watched file path.
    fsWatcher = fs.watch(dir, { persistent: false }, (_evt, name) => {
      if (!name || name === '.credentials.json' || String(name).startsWith('.credentials')) check();
    });
  } catch {
    // dir missing or fs.watch unsupported — the poll below covers it.
  }
  // Poll fallback: cheap (read one small file every 1.5s) and bounded by the
  // disposer, which the modal calls on close / on the PTY exit.
  pollTimer = setInterval(check, 1500);
  // One immediate check in case the token already changed between spawn and
  // watcher setup.
  check();
  return stop;
}

interface CacheEntry {
  status: AccountUsageStatus;
  /** The config dir this status was fetched for. If an account's dir later
   *  resolves differently, the cache is invalidated. */
  dir: string;
}

// accountId -> last status + the dir it was fetched against.
const cache = new Map<string, CacheEntry>();

function fail(
  accountId: string,
  errorKind: AccountUsageStatus['errorKind'],
  errorMessage: string,
  fetchedAt: number,
): AccountUsageStatus {
  return { accountId, ok: false, data: null, errorKind, errorMessage, fetchedAt };
}

async function fetchUsage(accountId: string, token: string, fetchedAt: number): Promise<AccountUsageStatus> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'User-Agent': userAgent(),
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const { kind, message } = classifyHttpError(res.status, body);
      if (kind === 'error') log.warn(`account usage fetch HTTP ${res.status}`);
      return fail(accountId, kind, message, fetchedAt);
    }
    const json = (await res.json()) as RawUsageResponse;
    const data = parseUsageResponse(json);
    if (!data) return fail(accountId, 'error', 'unexpected response', fetchedAt);
    return { accountId, ok: true, data, errorKind: null, errorMessage: null, fetchedAt };
  } catch (err) {
    log.warn('account usage fetch failed', err);
    return fail(accountId, 'error', 'network error', fetchedAt);
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure each account has a status no older than CACHE_MS, doing network work
 *  only for accounts whose token is present and whose cache is stale. Returns
 *  the full per-account status map and whether anything changed. */
async function refreshStale(now: number): Promise<{ byId: Record<string, AccountUsageStatus>; changed: boolean }> {
  const accounts = store.accounts;
  let changed = false;

  // Drop cache entries for accounts that no longer exist.
  const liveIds = new Set(accounts.map((a) => a.id));
  for (const id of Array.from(cache.keys())) {
    if (!liveIds.has(id)) {
      cache.delete(id);
      changed = true;
    }
  }

  const toFetch: Array<{ id: string; token: string; dir: string }> = [];
  for (const acc of accounts) {
    const creds = readAccountCreds(acc);
    if ('error' in creds) {
      const msg = creds.error === 'no-dir' ? 'config dir not found' : 'not logged in';
      const prev = cache.get(acc.id);
      if (!prev || prev.status.errorKind !== creds.error) {
        cache.set(acc.id, { status: fail(acc.id, creds.error, msg, now), dir: creds.dir });
        changed = true;
      }
      continue;
    }
    // Clearly-expired token → surface 'not logged in' rather than a guaranteed
    // 401 round-trip. The next agent run in that dir refreshes it. Keep the last
    // good usage data (if any) so the badge/bars still show the cached
    // consumption — only the `expired` flag changes how it's labelled.
    if (isExpired(creds.expiresAt, now)) {
      const prev = cache.get(acc.id);
      const lastData = prev?.dir === creds.dir ? prev.status.data : null;
      if (!prev || !prev.status.expired || prev.status.data !== lastData) {
        cache.set(acc.id, {
          status: {
            accountId: acc.id,
            ok: false,
            data: lastData,
            errorKind: 'not-logged-in',
            errorMessage: 'token expired',
            fetchedAt: lastData ? prev!.status.fetchedAt : now,
            expired: true,
          },
          dir: creds.dir,
        });
        changed = true;
      }
      continue;
    }
    const prev = cache.get(acc.id);
    const fresh = prev && prev.dir === creds.dir && prev.status.ok && now - prev.status.fetchedAt < CACHE_MS;
    if (!fresh) toFetch.push({ id: acc.id, token: creds.token, dir: creds.dir });
  }

  if (toFetch.length > 0) {
    const results = await Promise.all(toFetch.map((t) => fetchUsage(t.id, t.token, now)));
    for (let i = 0; i < results.length; i++) {
      cache.set(toFetch[i].id, { status: results[i], dir: toFetch[i].dir });
    }
    changed = true;
  }

  return { byId: snapshotAccountUsage(), changed };
}

/** Snapshot of every account's current cached usage status, keyed by id. */
export function snapshotAccountUsage(): Record<string, AccountUsageStatus> {
  const byId: Record<string, AccountUsageStatus> = {};
  for (const [id, entry] of cache) byId[id] = entry.status;
  return byId;
}

/** Current cached usage status for one account, or null if never fetched. */
export function getAccountUsage(accountId: string): AccountUsageStatus | null {
  return cache.get(accountId)?.status ?? null;
}

// One active login watcher per account id, so a second loginStart (or a stop)
// replaces/cancels the first cleanly.
const loginWatchers = new Map<string, () => void>();

/** Arm a watcher that fires `onLoggedIn` once an interactive login writes a
 *  fresh OAuth token into `account`'s config dir. Cancels any prior watcher for
 *  the same account. Returns immediately; call {@link cancelLoginWatch} to stop
 *  (the modal does this on close, and we auto-stop after firing). */
export function armLoginWatch(account: Account, onLoggedIn: () => void): void {
  cancelLoginWatch(account.id);
  const dir = accountConfigDir(account);
  if (!dir) return;
  const baseline = tokenInDir(dir);
  const stop = watchForLogin(dir, baseline, () => {
    loginWatchers.delete(account.id);
    onLoggedIn();
  });
  loginWatchers.set(account.id, stop);
}

/** Stop watching an account's config dir for login completion, if armed. */
export function cancelLoginWatch(accountId: string): void {
  const stop = loginWatchers.get(accountId);
  if (stop) {
    stop();
    loginWatchers.delete(accountId);
  }
}

/** Compute which account each non-archived workspace logs in as, from its
 *  repo's `accountId`. Identity only (id + label) — never a path or token. A
 *  workspace whose repo has no (live) account — including every scratch/
 *  orchestrator session — falls back to a 'default login' label. */
export function computeWorkspaceAccounts(): Record<string, WorkspaceAccount> {
  const labelById = new Map(store.accounts.map((a) => [a.id, a.label] as const));
  const knownIds = new Set(labelById.keys());
  const out: Record<string, WorkspaceAccount> = {};
  for (const ws of store.workspaces) {
    if (ws.archived) continue;
    // Driven solely by the workspace's PINNED account — the one its agent
    // actually logs in as (see workspaceAccountConfigDir). A workspace with no
    // pin (scratch/orchestrator, or created before pinning) shows default login.
    const accountId = resolveWorkspaceAccountId(ws.accountId, knownIds);
    out[ws.id] = {
      workspaceId: ws.id,
      accountId,
      label: accountId ? labelById.get(accountId) ?? 'account' : 'default login',
    };
  }
  return out;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function broadcastWorkspaceAccounts(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send('accounts:workspaceAccounts', computeWorkspaceAccounts());
}

function broadcastUsage(window: BrowserWindow, byId: Record<string, AccountUsageStatus>): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send('accounts:usageUpdate', byId);
}

async function poll(window: BrowserWindow): Promise<void> {
  // Recompute the workspace→account map each tick so a workspace created or
  // deleted since the last tick gets (or loses) its badge. Pure local work.
  broadcastWorkspaceAccounts(window);
  const { byId, changed } = await refreshStale(Date.now());
  if (changed) broadcastUsage(window, byId);
}

function schedule(window: BrowserWindow): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void poll(window).finally(() => schedule(window));
  }, POLL_MS);
}

export function startAccountUsagePolling(window: BrowserWindow): void {
  if (!stopped) return;
  stopped = false;
  broadcastWorkspaceAccounts(window);
  void poll(window).finally(() => schedule(window));
}

export function stopAccountUsagePolling(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Called when accounts or repo→account assignments change so the renderer's
 *  mapping and usage refresh promptly without waiting for the next poll tick. */
export async function refreshAccountsNow(window: BrowserWindow): Promise<void> {
  broadcastWorkspaceAccounts(window);
  const { byId } = await refreshStale(Date.now());
  broadcastUsage(window, byId);
}
