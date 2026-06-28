import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHttpError,
  expandConfigDir,
  isExpired,
  resolveWorkspaceAccountId,
  parseCredentials,
  parseUsageResponse,
  type RawUsageResponse,
} from './accounts.ts';

// Pins the config-dir-based account-usage logic: config-dir path expansion
// (~/${VAR}), reading the OAuth token out of a .credentials.json, expiry
// skipping, parsing the real /api/oauth/usage shape (null windows, 403/429),
// and matching a workspace to its account by the repo's explicit accountId.

// ---- expandConfigDir ---------------------------------------------------------

test('expandConfigDir expands a leading ~ to home', () => {
  assert.equal(expandConfigDir('~/.claude-work', '/home/u', {}), '/home/u/.claude-work');
});

test('expandConfigDir expands a bare ~ to home', () => {
  assert.equal(expandConfigDir('~', '/home/u', {}), '/home/u');
});

test('expandConfigDir does NOT touch ~ that is not a path segment', () => {
  // `~foo` is a username-home form we don't support — leave it literal.
  assert.equal(expandConfigDir('~foo/bar', '/home/u', {}), '~foo/bar');
});

test('expandConfigDir resolves ${VAR} and $VAR', () => {
  assert.equal(expandConfigDir('${BASE}/acct', '/h', { BASE: '/data' }), '/data/acct');
  assert.equal(expandConfigDir('$BASE/acct', '/h', { BASE: '/data' }), '/data/acct');
});

test('expandConfigDir trims and treats empty as no dir', () => {
  assert.equal(expandConfigDir('   ', '/h', {}), '');
  assert.equal(expandConfigDir(undefined, '/h', {}), '');
  assert.equal(expandConfigDir('  ~/x  ', '/home/u', {}), '/home/u/x');
});

test('expandConfigDir leaves an absolute literal path unchanged', () => {
  assert.equal(expandConfigDir('/opt/claude-a', '/home/u', {}), '/opt/claude-a');
});

// ---- parseCredentials --------------------------------------------------------

test('parseCredentials reads the OAuth access token', () => {
  const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', expiresAt: 123 } });
  assert.deepEqual(parseCredentials(raw), { accessToken: 'sk-ant-oat01-x', expiresAt: 123 });
});

test('parseCredentials returns null when there is no OAuth token (e.g. API-key login)', () => {
  assert.equal(parseCredentials(JSON.stringify({ apiKey: 'sk-ant-...' })), null);
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: {} })), null);
});

test('parseCredentials returns null for missing / malformed input', () => {
  assert.equal(parseCredentials(null), null);
  assert.equal(parseCredentials(undefined), null);
  assert.equal(parseCredentials(''), null);
  assert.equal(parseCredentials('{not json'), null);
});

// ---- isExpired ---------------------------------------------------------------

test('isExpired is true only when clearly past expiry (60s grace)', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now - 120_000, now), true); // 2m ago → expired
  assert.equal(isExpired(now - 30_000, now), false); // within grace
  assert.equal(isExpired(now + 60_000, now), false); // future
  assert.equal(isExpired(undefined, now), false); // unknown → not skipped
});

// ---- parseUsageResponse ------------------------------------------------------

test('parseUsageResponse parses the verified real shape', () => {
  const raw: RawUsageResponse = {
    five_hour: { utilization: 38, resets_at: '2026-06-29T18:00:00Z' },
    seven_day: { utilization: 28, resets_at: '2026-07-02T00:00:00Z' },
    extra_usage: { is_enabled: true, utilization: 12 },
  };
  assert.deepEqual(parseUsageResponse(raw), {
    fiveHour: { utilization: 38, resetsAt: '2026-06-29T18:00:00Z' },
    sevenDay: { utilization: 28, resetsAt: '2026-07-02T00:00:00Z' },
    extraUtilization: 12,
  });
});

test('parseUsageResponse tolerates a null window (reads 0%, no reset)', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: 50, resets_at: '2026-06-29T18:00:00Z' },
    seven_day: null,
  });
  assert.equal(out?.fiveHour.utilization, 50);
  assert.deepEqual(out?.sevenDay, { utilization: 0, resetsAt: '' });
});

test('parseUsageResponse tolerates null utilization / resets_at', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: 10, resets_at: 'x' },
  });
  assert.deepEqual(out?.fiveHour, { utilization: 0, resetsAt: '' });
});

test('parseUsageResponse ignores extra_usage when disabled or null', () => {
  const base = { five_hour: { utilization: 5 }, seven_day: { utilization: 5 } };
  assert.equal(parseUsageResponse({ ...base, extra_usage: { is_enabled: false, utilization: 99 } })?.extraUtilization, null);
  assert.equal(parseUsageResponse({ ...base, extra_usage: { is_enabled: true, utilization: null } })?.extraUtilization, null);
});

test('parseUsageResponse returns null for a non-usage body', () => {
  assert.equal(parseUsageResponse({ error: { type: 'permission_error' } } as RawUsageResponse), null);
  assert.equal(parseUsageResponse(null), null);
});

test('parseUsageResponse tolerates unknown keys', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: 1, resets_at: 'a' },
    seven_day: { utilization: 2, resets_at: 'b' },
    seven_day_opus: { utilization: 3 },
    spend: { percent: 0 },
  } as RawUsageResponse);
  assert.equal(out?.fiveHour.utilization, 1);
});

// ---- classifyHttpError -------------------------------------------------------

test('classifyHttpError maps 403→no-scope, 429→rate-limited, else→error', () => {
  assert.equal(classifyHttpError(403).kind, 'no-scope');
  assert.equal(classifyHttpError(429).kind, 'rate-limited');
  const e = classifyHttpError(500, '<html>secret</html>');
  assert.equal(e.kind, 'error');
  assert.equal(e.message, 'HTTP 500');
  assert.doesNotMatch(e.message, /secret/);
});

// ---- resolveWorkspaceAccountId (pinning) -------------------------------------

test('resolveWorkspaceAccountId returns the pinned id when it is a known account', () => {
  assert.equal(resolveWorkspaceAccountId('acc-b', new Set(['acc-a', 'acc-b'])), 'acc-b');
});

test('resolveWorkspaceAccountId returns null for an unpinned workspace (→ default login)', () => {
  // Scratch/orchestrator, or a workspace created before pinning existed — it
  // must NOT adopt the repo's current account (its conversation lives in the
  // dir it ran under, i.e. the default ~/.claude).
  assert.equal(resolveWorkspaceAccountId(undefined, new Set(['acc-a'])), null);
  assert.equal(resolveWorkspaceAccountId('', new Set(['acc-a'])), null);
});

test('resolveWorkspaceAccountId returns null for a pin to a deleted account', () => {
  assert.equal(resolveWorkspaceAccountId('acc-gone', new Set(['acc-a'])), null);
});

test('resolveWorkspaceAccountId keeps the pin even after the repo would point elsewhere', () => {
  // The repo may now be assigned acc-b, but a workspace pinned to acc-a stays
  // on acc-a — the whole point of pinning (no "No conversation found").
  assert.equal(resolveWorkspaceAccountId('acc-a', new Set(['acc-a', 'acc-b'])), 'acc-a');
});
