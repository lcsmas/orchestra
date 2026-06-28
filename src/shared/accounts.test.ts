import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHttpError,
  expandToken,
  matchWorkspaceAccount,
  parseUsageResponse,
  type RawUsageResponse,
} from './accounts.ts';

// These tests pin the security-sensitive and error-handling behaviour of the
// account-usage feature: token expansion (no expanded secret ever produced from
// an unset var), parsing the real `/api/oauth/usage` shape (including null
// windows and the 403/429 error paths), and matching a workspace to its account
// by exact resolved-token equality.

// ---- expandToken -------------------------------------------------------------

test('expandToken resolves ${VAR} from source', () => {
  assert.equal(expandToken('${CLAUDE_TOKEN_A}', { CLAUDE_TOKEN_A: 'sk-ant-oat01-x' }), 'sk-ant-oat01-x');
});

test('expandToken resolves bare $VAR too', () => {
  assert.equal(expandToken('$TOK', { TOK: 'abc' }), 'abc');
});

test('expandToken yields empty string for an unset reference (no token)', () => {
  assert.equal(expandToken('${MISSING}', {}), '');
});

test('expandToken yields empty string for a blank reference', () => {
  assert.equal(expandToken('${X}', { X: '' }), '');
});

test('expandToken passes a literal through unchanged', () => {
  assert.equal(expandToken('sk-ant-literal', {}), 'sk-ant-literal');
});

test('expandToken on undefined/empty template is empty', () => {
  assert.equal(expandToken(undefined, { X: 'y' }), '');
  assert.equal(expandToken('', { X: 'y' }), '');
});

// ---- parseUsageResponse ------------------------------------------------------

test('parseUsageResponse parses the verified real shape', () => {
  const raw: RawUsageResponse = {
    five_hour: { utilization: 38, resets_at: '2026-06-29T18:00:00Z' },
    seven_day: { utilization: 28, resets_at: '2026-07-02T00:00:00Z' },
    extra_usage: { is_enabled: true, utilization: 12 },
  };
  const out = parseUsageResponse(raw);
  assert.deepEqual(out, {
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

test('parseUsageResponse tolerates null resets_at and null utilization', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: 10, resets_at: '2026-07-02T00:00:00Z' },
  });
  assert.deepEqual(out?.fiveHour, { utilization: 0, resetsAt: '' });
});

test('parseUsageResponse ignores extra_usage when disabled', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: 5, resets_at: 'x' },
    seven_day: { utilization: 5, resets_at: 'y' },
    extra_usage: { is_enabled: false, utilization: 99 },
  });
  assert.equal(out?.extraUtilization, null);
});

test('parseUsageResponse ignores extra_usage with null utilization', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: 5, resets_at: 'x' },
    seven_day: { utilization: 5, resets_at: 'y' },
    extra_usage: { is_enabled: true, utilization: null },
  });
  assert.equal(out?.extraUtilization, null);
});

test('parseUsageResponse returns null for a non-usage body (e.g. error object)', () => {
  assert.equal(parseUsageResponse({ error: { type: 'permission_error' } } as RawUsageResponse), null);
  assert.equal(parseUsageResponse(null), null);
  assert.equal(parseUsageResponse(undefined), null);
});

test('parseUsageResponse tolerates unknown keys', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: 1, resets_at: 'a' },
    seven_day: { utilization: 2, resets_at: 'b' },
    seven_day_opus: { utilization: 3 },
    limits: [{ kind: 'x' }],
    spend: { percent: 0 },
  } as RawUsageResponse);
  assert.equal(out?.fiveHour.utilization, 1);
  assert.equal(out?.sevenDay.utilization, 2);
});

// ---- classifyHttpError -------------------------------------------------------

test('classifyHttpError maps 403 to no-scope (the user:profile scope error)', () => {
  const out = classifyHttpError(
    403,
    '{"error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}',
  );
  assert.equal(out.kind, 'no-scope');
  assert.match(out.message, /scope/);
});

test('classifyHttpError maps 429 to rate-limited', () => {
  assert.equal(classifyHttpError(429).kind, 'rate-limited');
});

test('classifyHttpError maps other statuses to error without echoing the body', () => {
  const out = classifyHttpError(500, '<html>secret-looking-body</html>');
  assert.equal(out.kind, 'error');
  assert.equal(out.message, 'HTTP 500');
  assert.doesNotMatch(out.message, /secret-looking-body/);
});

// ---- matchWorkspaceAccount ---------------------------------------------------

test('matchWorkspaceAccount matches by exact resolved token', () => {
  const tokens = new Map([
    ['acc-a', 'sk-ant-oat01-AAA'],
    ['acc-b', 'sk-ant-oat01-BBB'],
  ]);
  assert.equal(matchWorkspaceAccount('sk-ant-oat01-BBB', tokens), 'acc-b');
});

test('matchWorkspaceAccount returns null when the workspace has no token', () => {
  const tokens = new Map([['acc-a', 'sk-ant-oat01-AAA']]);
  assert.equal(matchWorkspaceAccount(undefined, tokens), null);
  assert.equal(matchWorkspaceAccount('', tokens), null);
});

test('matchWorkspaceAccount returns null when nothing matches', () => {
  const tokens = new Map([['acc-a', 'sk-ant-oat01-AAA']]);
  assert.equal(matchWorkspaceAccount('sk-ant-oat01-ZZZ', tokens), null);
});

test('matchWorkspaceAccount never matches an account whose token expanded to empty', () => {
  // An account with an unset ${VAR} resolves to '' and must not collide with a
  // workspace that also (wrongly) has an empty token — guard against '' === ''.
  const tokens = new Map([['acc-empty', '']]);
  assert.equal(matchWorkspaceAccount('', tokens), null);
});
