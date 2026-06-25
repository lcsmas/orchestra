import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { log } from './logger';
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

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
}

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

function parseSnapshot(raw: RawUsage, fetchedAt: number): UsageSnapshot | null {
  const five = raw.five_hour;
  const seven = raw.seven_day;
  if (!five || !seven) return null;
  const num = (v: number | null | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    fiveHour: { utilization: num(five.utilization), resetsAt: five.resets_at ?? '' },
    sevenDay: { utilization: num(seven.utilization), resetsAt: seven.resets_at ?? '' },
    fetchedAt,
  };
}

let lastSnapshot: UsageSnapshot | null = null;

export function getLastUsage(): UsageSnapshot | null {
  return lastSnapshot;
}

async function fetchUsage(fetchedAt: number): Promise<UsageSnapshot | null> {
  const creds = readOAuth();
  if (!creds) return null;
  // The token may be expired; a slightly stale-by-a-minute check is fine since
  // the server is the real authority — but if it's clearly expired, skip the
  // round-trip to avoid a guaranteed 401.
  if (creds.expiresAt && creds.expiresAt < fetchedAt - 60_000) return null;

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
      // 401 = token expired/refreshed out from under us; the next agent run will
      // refresh it and the following poll will succeed. Not worth logging loudly.
      if (res.status !== 401) log.warn(`usage fetch HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as RawUsage;
    return parseSnapshot(json, fetchedAt);
  } catch (err) {
    log.warn('usage fetch failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

// Refresh cadence. The windows move slowly (5h / 7d), so a 60s poll is plenty
// live while keeping the request volume trivial.
const POLL_MS = 60_000;

async function poll(window: BrowserWindow): Promise<void> {
  // Stamp the fetch time in the main process rather than the renderer so the
  // "as of" instant is when we actually queried, not when the IPC landed.
  const snap = await fetchUsage(Date.now());
  if (!snap) return;
  lastSnapshot = snap;
  if (!window.isDestroyed()) window.webContents.send('usage:update', snap);
}

export function startUsagePolling(window: BrowserWindow): void {
  if (timer) return;
  void poll(window);
  timer = setInterval(() => void poll(window), POLL_MS);
}

export function stopUsagePolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
