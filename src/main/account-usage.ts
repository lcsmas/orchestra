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
  type AccountUsageStatus,
  type RawUsageResponse,
} from '../shared/accounts';
import type { Account, RepoEntry, WorkspaceAccount } from '../shared/types';

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
    // 401 round-trip. The next agent run in that dir refreshes it.
    if (isExpired(creds.expiresAt, now)) {
      const prev = cache.get(acc.id);
      if (!prev || prev.status.errorKind !== 'not-logged-in') {
        cache.set(acc.id, { status: fail(acc.id, 'not-logged-in', 'token expired', now), dir: creds.dir });
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

/** Compute which account each non-archived workspace logs in as, from its
 *  repo's `accountId`. Identity only (id + label) — never a path or token. A
 *  workspace whose repo has no (live) account — including every scratch/
 *  orchestrator session — falls back to a 'default login' label. */
export function computeWorkspaceAccounts(): Record<string, WorkspaceAccount> {
  const labelById = new Map(store.accounts.map((a) => [a.id, a.label] as const));
  const out: Record<string, WorkspaceAccount> = {};
  for (const ws of store.workspaces) {
    if (ws.archived) continue;
    const repo: RepoEntry | undefined = store.repos.find((r) => r.path === ws.repoPath);
    const accountId = repo?.accountId && labelById.has(repo.accountId) ? repo.accountId : null;
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
