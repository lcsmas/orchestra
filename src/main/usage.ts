import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { log } from './logger';
import { parseUsageResponse, type RawUsageResponse } from '../shared/accounts';
import type { UsageSnapshot } from '../shared/types';

// Reads the signed-in Claude account's rolling usage limits and broadcasts them
// to the renderer for the sidebar progress bars.
//
// The data comes from Anthropic's OAuth usage endpoint — the very same source
// Claude Code's own `/usage` view reads. We authenticate with the OAuth access
// token Claude Code persists in `~/.claude/.credentials.json`; orchestra never
// mints or refreshes that token itself, it just rides along on whatever Claude
// Code last wrote (the token is refreshed whenever an agent runs). If the token
// is missing or expired we simply skip the poll and leave the last good
// snapshot in place.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The OAuth-app beta header Claude Code sends; the endpoint 404s without it.
const OAUTH_BETA = 'oauth-2025-04-20';

function credentialsPath(): string {
  // CLAUDE_CONFIG_DIR overrides the default ~/.claude location (Claude Code
  // honours it too), so respect it for users who relocate their config.
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

interface OAuthCreds {
  accessToken: string;
  expiresAt?: number;
}

function readOAuth(): OAuthCreds | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    // Missing file / not logged in via OAuth (e.g. raw ANTHROPIC_API_KEY users).
    return null;
  }
}

// Delegate to the shared parser (src/shared/accounts.ts) so the default login
// reads `extra_usage` identically to the per-account poller — including an
// enabled-but-null pool as 0% — then stamp the fetch time. Keeps one source of
// truth for what the usage endpoint means.
function parseSnapshot(raw: RawUsageResponse, fetchedAt: number): UsageSnapshot | null {
  const data = parseUsageResponse(raw);
  if (!data) return null;
  return {
    fiveHour: data.fiveHour,
    sevenDay: data.sevenDay,
    extraUtilization: data.extraUtilization,
    fable: data.fable,
    fetchedAt,
  };
}

let lastSnapshot: UsageSnapshot | null = null;
let loadedFromDisk = false;

// Persist the last good snapshot so the sidebar bars show immediately on the
// next launch instead of staying hidden until the first successful poll lands
// (the poll can be delayed for minutes when the usage endpoint is rate-limiting
// us — see the 429 backoff below). The cached snapshot is the same one Claude
// Code's `/usage` reads; a few-minutes-stale value at startup is fine since the
// windows move slowly and the first successful poll overwrites it.
function snapshotPath(): string {
  return path.join(app.getPath('userData'), 'orchestra', 'usage.json');
}

function loadPersisted(): UsageSnapshot | null {
  try {
    const raw = fs.readFileSync(snapshotPath(), 'utf8');
    const parsed = JSON.parse(raw) as UsageSnapshot;
    // Guard against a hand-edited / corrupt file: require the shape we render.
    if (!parsed?.fiveHour || !parsed?.sevenDay) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(snap: UsageSnapshot): void {
  try {
    const file = snapshotPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snap), 'utf8');
  } catch (err) {
    // Persistence is best-effort — losing it just means the bars hide until the
    // first successful poll next launch, the pre-existing behaviour.
    log.warn('usage snapshot persist failed', err);
  }
}

export function getLastUsage(): UsageSnapshot | null {
  // Lazily hydrate from disk the first time the renderer asks, so a fresh
  // session shows the previous run's bars right away.
  if (!lastSnapshot && !loadedFromDisk) {
    loadedFromDisk = true;
    lastSnapshot = loadPersisted();
  }
  return lastSnapshot;
}

// Outcome of one fetch attempt. `snapshot` carries data on success; `rateLimited`
// tells the poller to back off so we stop piling onto an endpoint that's already
// throttling us (common when several agents share one account's OAuth token).
interface FetchResult {
  snapshot: UsageSnapshot | null;
  rateLimited: boolean;
}

const SKIP: FetchResult = { snapshot: null, rateLimited: false };

async function fetchUsage(fetchedAt: number): Promise<FetchResult> {
  const creds = readOAuth();
  if (!creds) return SKIP;
  // The token may be expired; a slightly stale-by-a-minute check is fine since
  // the server is the real authority — but if it's clearly expired, skip the
  // round-trip to avoid a guaranteed 401.
  if (creds.expiresAt && creds.expiresAt < fetchedAt - 60_000) return SKIP;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 429 = the endpoint is rate-limiting our polls (e.g. many agents on one
      // account). Don't log — a streak of these would flood the log — and tell
      // the poller to back off instead of hammering at the steady cadence.
      if (res.status === 429) return { snapshot: null, rateLimited: true };
      // 401 = token expired/refreshed out from under us; the next agent run will
      // refresh it and the following poll will succeed. Not worth logging loudly.
      if (res.status !== 401) log.warn(`usage fetch HTTP ${res.status}`);
      return SKIP;
    }
    const json = (await res.json()) as RawUsageResponse;
    return { snapshot: parseSnapshot(json, fetchedAt), rateLimited: false };
  } catch (err) {
    log.warn('usage fetch failed', err);
    return SKIP;
  } finally {
    clearTimeout(timer);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
// Consecutive rate-limited polls — drives exponential backoff so we ease off an
// endpoint that's already throttling us instead of polling into the wall.
let rateLimitStreak = 0;

// Steady refresh cadence. The windows move slowly (5h / 7d), so a 60s poll is
// plenty live while keeping the request volume trivial.
const POLL_MS = 60_000;
// On repeated 429s, back off exponentially from the base cadence up to a cap.
// 60s → 2m → 4m → 8m → 10m (cap), then hold at 10m until a poll succeeds.
const BACKOFF_CAP_MS = 600_000;

function nextDelay(): number {
  if (rateLimitStreak === 0) return POLL_MS;
  const backed = POLL_MS * 2 ** rateLimitStreak;
  return Math.min(backed, BACKOFF_CAP_MS);
}

async function poll(window: BrowserWindow): Promise<void> {
  // Stamp the fetch time in the main process rather than the renderer so the
  // "as of" instant is when we actually queried, not when the IPC landed.
  const { snapshot, rateLimited } = await fetchUsage(Date.now());
  if (rateLimited) {
    rateLimitStreak++;
  } else if (snapshot) {
    rateLimitStreak = 0;
    lastSnapshot = snapshot;
    persist(snapshot);
    if (!window.isDestroyed()) window.webContents.send('usage:update', snapshot);
  }
  // A skip (no creds / expired / non-429 error) neither advances nor resets the
  // backoff — we just retry at the current cadence.
}

function schedule(window: BrowserWindow): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void poll(window).finally(() => schedule(window));
  }, nextDelay());
}

export function startUsagePolling(window: BrowserWindow): void {
  if (!stopped) return;
  stopped = false;
  rateLimitStreak = 0;
  // Fire once immediately, then self-schedule the next poll with backoff.
  void poll(window).finally(() => schedule(window));
}

export function stopUsagePolling(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
