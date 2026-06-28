import { app, BrowserWindow } from 'electron';
import { log } from './logger';
import { store } from './store';
import { expandRepoEnv } from './repo-env';
import {
  OAUTH_TOKEN_ENV,
  classifyHttpError,
  expandToken,
  matchWorkspaceAccount,
  parseUsageResponse,
  type AccountUsageStatus,
  type RawUsageResponse,
} from '../shared/accounts';
import type { WorkspaceAccount } from '../shared/types';

// Per-account usage poller. For each configured account it expands the account's
// token template against Orchestra's own env, fetches Anthropic's
// `/api/oauth/usage` with the headers Claude Code itself sends, and caches the
// result for >=180s per account so we never hammer the (aggressively
// rate-limited) endpoint. The parsed, renderer-safe status is broadcast to the
// renderer; the token never leaves this module.
//
// SECURITY: tokens are expanded transiently here and used only as the bearer.
// They are never logged, persisted, or sent to the renderer — the renderer only
// ever sees an account's id/label and its usage numbers (see AccountUsageStatus).

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The OAuth-app beta header Claude Code sends; the endpoint 404s without it.
const OAUTH_BETA = 'oauth-2025-04-20';

// Hard floor on how often we hit the endpoint per token. The requirement is
// >=180s; we cache for exactly this and only refetch a token whose cache is
// older. The poll loop runs more often than this only to pick up newly-added
// accounts, but a given token is never fetched more than once per window.
const CACHE_MS = 180_000;
// How often the loop wakes to consider refetching stale accounts. Well under
// CACHE_MS so a freshly-added account gets its first fetch promptly, but each
// individual token is still gated by its own cache age.
const POLL_MS = 30_000;

function userAgent(): string {
  // Without a Claude-Code-shaped User-Agent the endpoint aggressively rate
  // limits us (429). Mirror Claude Code's format using Orchestra's version.
  let version = '0.0.0';
  try {
    version = app.getVersion();
  } catch {
    // app may be unavailable in odd contexts; fall back to a static version.
  }
  return `claude-code/${version}`;
}

interface CacheEntry {
  status: AccountUsageStatus;
  /** The expanded token this status was fetched for. If an account's token
   *  template later resolves to a different value (e.g. the env var changed),
   *  the cache is invalidated so we don't show stale usage for the wrong token. */
  token: string;
}

// accountId -> last status + the token it was fetched against.
const cache = new Map<string, CacheEntry>();

/** Expanded token for every account whose template currently resolves to a
 *  non-empty value, keyed by account id. Accounts with no usable token are
 *  absent. Computed fresh from process.env each call (the env can change). */
function resolveAccountTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const acc of store.accounts) {
    const token = expandToken(acc.token, process.env);
    if (token) out.set(acc.id, token);
  }
  return out;
}

function noToken(accountId: string, fetchedAt: number): AccountUsageStatus {
  return {
    accountId,
    ok: false,
    data: null,
    errorKind: 'no-token',
    errorMessage: 'no token configured',
    fetchedAt,
  };
}

async function fetchOne(accountId: string, token: string, fetchedAt: number): Promise<AccountUsageStatus> {
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
      // Read the body only to let classifyHttpError look at it; never log or
      // forward it (could be large / contain identifiers).
      const body = await res.text().catch(() => '');
      const { kind, message } = classifyHttpError(res.status, body);
      // 429s are expected when several agents share a token; don't flood the log.
      if (kind === 'error') log.warn(`account usage fetch HTTP ${res.status}`);
      return { accountId, ok: false, data: null, errorKind: kind, errorMessage: message, fetchedAt };
    }
    const json = (await res.json()) as RawUsageResponse;
    const data = parseUsageResponse(json);
    if (!data) {
      return { accountId, ok: false, data: null, errorKind: 'error', errorMessage: 'unexpected response', fetchedAt };
    }
    return { accountId, ok: true, data, errorKind: null, errorMessage: null, fetchedAt };
  } catch (err) {
    // Don't include `err` verbatim in the message we forward (keep the UI clean
    // and avoid any chance of leaking request detail); log it for diagnostics.
    log.warn('account usage fetch failed', err);
    return { accountId, ok: false, data: null, errorKind: 'error', errorMessage: 'network error', fetchedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure each account has a status no older than CACHE_MS, fetching only the
 *  stale ones. Returns the full per-account status map and whether anything
 *  changed (so the caller can decide whether to broadcast). */
async function refreshStale(now: number): Promise<{ byId: Record<string, AccountUsageStatus>; changed: boolean }> {
  const tokens = resolveAccountTokens();
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

  const toFetch: Array<{ id: string; token: string }> = [];
  for (const acc of accounts) {
    const token = tokens.get(acc.id);
    if (!token) {
      // No usable token — surface 'no-token' immediately, no network call.
      const prev = cache.get(acc.id);
      if (!prev || prev.status.errorKind !== 'no-token') {
        cache.set(acc.id, { status: noToken(acc.id, now), token: '' });
        changed = true;
      }
      continue;
    }
    const prev = cache.get(acc.id);
    const fresh = prev && prev.token === token && now - prev.status.fetchedAt < CACHE_MS;
    if (!fresh) toFetch.push({ id: acc.id, token });
  }

  if (toFetch.length > 0) {
    const results = await Promise.all(toFetch.map(({ id, token }) => fetchOne(id, token, now)));
    for (let i = 0; i < results.length; i++) {
      cache.set(toFetch[i].id, { status: results[i], token: toFetch[i].token });
    }
    changed = true;
  }

  const byId: Record<string, AccountUsageStatus> = {};
  for (const [id, entry] of cache) byId[id] = entry.status;
  return { byId, changed };
}

/** Snapshot of every account's current usage status, keyed by id. Whatever is
 *  cached right now — does not trigger a fetch. */
export function snapshotAccountUsage(): Record<string, AccountUsageStatus> {
  const byId: Record<string, AccountUsageStatus> = {};
  for (const [id, entry] of cache) byId[id] = entry.status;
  return byId;
}

/** Current cached usage status for one account, or null if never fetched. */
export function getAccountUsage(accountId: string): AccountUsageStatus | null {
  return cache.get(accountId)?.status ?? null;
}

/** Compute which account each non-archived workspace logs in as, by matching
 *  the workspace's resolved CLAUDE_CODE_OAUTH_TOKEN against the configured
 *  accounts' resolved tokens. Returns identity only (id + label) — never a
 *  token. A workspace with no token override or no matching account falls back
 *  to a 'default login' label with a null account id. */
export function computeWorkspaceAccounts(): Record<string, WorkspaceAccount> {
  const tokens = resolveAccountTokens();
  const labelById = new Map(store.accounts.map((a) => [a.id, a.label] as const));
  const out: Record<string, WorkspaceAccount> = {};
  for (const ws of store.workspaces) {
    if (ws.archived) continue;
    const repo = store.repos.find((r) => r.path === ws.repoPath);
    const wsToken = expandRepoEnv(repo?.env, process.env)[OAUTH_TOKEN_ENV];
    const accountId = matchWorkspaceAccount(wsToken, tokens);
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
  // deleted since the last tick gets (or loses) its badge without needing an
  // accounts/env edit to trigger it. This is pure local work (no network).
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
  // Push the initial workspace→account map and kick off the first usage poll.
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

/** Called when accounts or repo env change so the renderer's mapping and usage
 *  refresh promptly without waiting for the next poll tick. Recomputes the
 *  workspace→account map, invalidates cache for any account whose token changed
 *  (handled inside refreshStale via the token comparison), and broadcasts. */
export async function refreshAccountsNow(window: BrowserWindow): Promise<void> {
  broadcastWorkspaceAccounts(window);
  const { byId } = await refreshStale(Date.now());
  broadcastUsage(window, byId);
}
