import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAutoFlushQueue,
  classifyHttpError,
  expandConfigDir,
  isClaudeAuthUrl,
  isExpired,
  planAccountMigration,
  resolveWorkspaceAccountId,
  parseCredentials,
  parseUsageResponse,
  sanitizeAccountInherit,
  usageLimitedUntil,
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
    fable: null,
  });
});

test('parseUsageResponse reads the Fable weekly window from limits[]', () => {
  // Verified real shape (2026-07): the Fable cap is a `weekly_scoped` entry in
  // `limits[]` — there is no top-level seven_day_fable window.
  const out = parseUsageResponse({
    five_hour: { utilization: 22, resets_at: '2026-07-18T02:30:00Z' },
    seven_day: { utilization: 5, resets_at: '2026-07-24T10:00:00Z' },
    limits: [
      { kind: 'session', percent: 22, resets_at: '2026-07-18T02:30:00Z', scope: null },
      { kind: 'weekly_all', percent: 5, resets_at: '2026-07-24T10:00:00Z', scope: null },
      {
        kind: 'weekly_scoped',
        percent: 10,
        resets_at: '2026-07-24T10:00:00Z',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  } as RawUsageResponse);
  assert.deepEqual(out?.fable, { utilization: 10, resetsAt: '2026-07-24T10:00:00Z' });
});

test('parseUsageResponse fable is null without a Fable-scoped limit', () => {
  const base = { five_hour: { utilization: 5 }, seven_day: { utilization: 5 } };
  // No limits array at all (older plans / older responses).
  assert.equal(parseUsageResponse({ ...base })?.fable, null);
  // A scoped limit for another model must not be misread as Fable.
  assert.equal(
    parseUsageResponse({
      ...base,
      limits: [
        { kind: 'weekly_scoped', percent: 60, scope: { model: { display_name: 'Opus' } } },
        { kind: 'weekly_all', percent: 90, scope: null },
      ],
    } as RawUsageResponse)?.fable,
    null,
  );
});

test('parseUsageResponse tolerates a Fable limit with null percent/reset', () => {
  const out = parseUsageResponse({
    five_hour: { utilization: 5 },
    seven_day: { utilization: 5 },
    limits: [
      { kind: 'weekly_scoped', percent: null, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    ],
  } as RawUsageResponse);
  assert.deepEqual(out?.fable, { utilization: 0, resetsAt: '' });
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

test('parseUsageResponse ignores extra_usage when disabled', () => {
  const base = { five_hour: { utilization: 5 }, seven_day: { utilization: 5 } };
  assert.equal(parseUsageResponse({ ...base, extra_usage: { is_enabled: false, utilization: 99 } })?.extraUtilization, null);
  assert.equal(parseUsageResponse({ ...base })?.extraUtilization, null);
});

test('parseUsageResponse treats enabled extra_usage with null utilization as 0%', () => {
  // Freshly enabled pay-as-you-go: the endpoint omits/nulls utilization but the
  // pool IS enabled and absorbing overflow. Collapsing to null would leave a
  // maxed 5h/7d account looking limited (queue banner never clears).
  const base = { five_hour: { utilization: 100 }, seven_day: { utilization: 5 } };
  assert.equal(parseUsageResponse({ ...base, extra_usage: { is_enabled: true, utilization: null } })?.extraUtilization, 0);
  assert.equal(parseUsageResponse({ ...base, extra_usage: { is_enabled: true } })?.extraUtilization, 0);
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

// ---- planAccountMigration (migrate a workspace's pinned account) -------------

test('planAccountMigration migrates default → a known account', () => {
  assert.deepEqual(planAccountMigration(undefined, 'mc', new Set(['mc', 'other'])), {
    kind: 'migrate',
    targetAccountId: 'mc',
  });
});

test('planAccountMigration migrates one account → another', () => {
  assert.deepEqual(planAccountMigration('other', 'mc', new Set(['mc', 'other'])), {
    kind: 'migrate',
    targetAccountId: 'mc',
  });
});

test('planAccountMigration migrates a pinned account → default login (null/empty target)', () => {
  const known = new Set(['mc']);
  for (const target of [null, undefined, '', '   ']) {
    assert.deepEqual(planAccountMigration('mc', target, known), {
      kind: 'migrate',
      targetAccountId: undefined,
    });
  }
});

test('planAccountMigration is a no-op when already on the target account', () => {
  assert.deepEqual(planAccountMigration('mc', 'mc', new Set(['mc'])), {
    kind: 'noop',
    targetAccountId: 'mc',
  });
});

test('planAccountMigration is a no-op when already on default login and clearing', () => {
  // undefined current + empty target both mean the default login → nothing to move.
  assert.deepEqual(planAccountMigration(undefined, '', new Set(['mc'])), {
    kind: 'noop',
    targetAccountId: undefined,
  });
  assert.deepEqual(planAccountMigration('', null, new Set(['mc'])), {
    kind: 'noop',
    targetAccountId: undefined,
  });
});

test('planAccountMigration errors on an unknown target account', () => {
  assert.deepEqual(planAccountMigration('mc', 'ghost', new Set(['mc'])), {
    kind: 'error',
    error: 'unknown account: ghost',
  });
});

test('planAccountMigration trims whitespace around a real target id', () => {
  assert.deepEqual(planAccountMigration(undefined, '  mc  ', new Set(['mc'])), {
    kind: 'migrate',
    targetAccountId: 'mc',
  });
});

// ---- sanitizeAccountInherit (per-account inheritance spec) -------------------

test('sanitizeAccountInherit returns undefined for empty / non-object / nothing-selected', () => {
  assert.equal(sanitizeAccountInherit(undefined), undefined);
  assert.equal(sanitizeAccountInherit(null), undefined);
  assert.equal(sanitizeAccountInherit('x'), undefined);
  assert.equal(sanitizeAccountInherit({}), undefined);
  // false booleans + empty lists collapse to "nothing selected".
  assert.equal(sanitizeAccountInherit({ settings: false, skills: [], mcpServers: [] }), undefined);
});

test('sanitizeAccountInherit keeps only true booleans and clean name lists', () => {
  assert.deepEqual(
    sanitizeAccountInherit({
      settings: true,
      statusline: true,
      skills: ['frontend-design', 'handoff'],
      mcpServers: ['github'],
    }),
    { settings: true, statusline: true, skills: ['frontend-design', 'handoff'], mcpServers: ['github'] },
  );
});

test('sanitizeAccountInherit drops blanks, non-strings, and de-dupes names; coerces booleans', () => {
  assert.deepEqual(
    sanitizeAccountInherit({
      settings: 'yes', // not strictly true → dropped
      statusline: true,
      skills: ['  handoff  ', 'handoff', '', 42, 'frontend-design'],
      mcpServers: ['github', 'github'],
    }),
    { statusline: true, skills: ['handoff', 'frontend-design'], mcpServers: ['github'] },
  );
});

// ---- usageLimitedUntil / canAutoFlushQueue ------------------------------------

const NOW = Date.parse('2026-07-12T12:00:00Z');
const RESET_5H = '2026-07-12T14:00:00Z';
const RESET_7D = '2026-07-15T00:00:00Z';

function windows(fiveUtil: number, sevenUtil: number, extra?: number | null) {
  return {
    fiveHour: { utilization: fiveUtil, resetsAt: RESET_5H },
    sevenDay: { utilization: sevenUtil, resetsAt: RESET_7D },
    extraUtilization: extra ?? null,
  };
}

test('usageLimitedUntil is null while both windows are under 100', () => {
  assert.equal(usageLimitedUntil(windows(97, 42), NOW), null);
  assert.equal(usageLimitedUntil(windows(0, 0), NOW), null);
});

test('usageLimitedUntil returns the blocked window reset time', () => {
  assert.equal(usageLimitedUntil(windows(100, 42), NOW), Date.parse(RESET_5H));
  assert.equal(usageLimitedUntil(windows(12, 100), NOW), Date.parse(RESET_7D));
});

test('usageLimitedUntil takes the LATER reset when both windows are blocked', () => {
  assert.equal(usageLimitedUntil(windows(100, 100), NOW), Date.parse(RESET_7D));
});

test('usageLimitedUntil: enabled extra usage under 100 absorbs a maxed window', () => {
  assert.equal(usageLimitedUntil(windows(100, 100, 3), NOW), null);
});

test('usageLimitedUntil: maxed extra usage no longer absorbs', () => {
  assert.equal(usageLimitedUntil(windows(100, 42, 100), NOW), Date.parse(RESET_5H));
});

test('usageLimitedUntil falls back to `now` for a blocked window without a parsable reset', () => {
  const data = {
    fiveHour: { utilization: 100, resetsAt: '' },
    sevenDay: { utilization: 10, resetsAt: RESET_7D },
  };
  assert.equal(usageLimitedUntil(data, NOW), NOW);
});

test('canAutoFlushQueue requires a post-queue, un-limited reading', () => {
  const queuedAt = NOW;
  // No reading at all, or no data on it → hold.
  assert.equal(canAutoFlushQueue(queuedAt, null, NOW), false);
  assert.equal(canAutoFlushQueue(queuedAt, { fetchedAt: NOW + 60_000, data: null }, NOW), false);
  // Reading predates (or ties) the queue instant → it can't prove the reset.
  assert.equal(
    canAutoFlushQueue(queuedAt, { fetchedAt: NOW - 60_000, data: windows(3, 3) }, NOW),
    false,
  );
  assert.equal(canAutoFlushQueue(queuedAt, { fetchedAt: NOW, data: windows(3, 3) }, NOW), false);
  // Fresh reading but still limited → hold.
  assert.equal(
    canAutoFlushQueue(queuedAt, { fetchedAt: NOW + 60_000, data: windows(100, 3) }, NOW),
    false,
  );
  // Fresh reading, un-limited → flush.
  assert.equal(
    canAutoFlushQueue(queuedAt, { fetchedAt: NOW + 60_000, data: windows(3, 3) }, NOW),
    true,
  );
});

test('isClaudeAuthUrl accepts Claude/Anthropic https pages only', () => {
  assert.equal(isClaudeAuthUrl('https://claude.ai/oauth/authorize?code=true'), true);
  assert.equal(isClaudeAuthUrl('https://console.anthropic.com/oauth/authorize'), true);
  assert.equal(isClaudeAuthUrl('https://anthropic.com/'), true);
  // Host-anchored: lookalike domains must not get the account's session.
  assert.equal(isClaudeAuthUrl('https://claude.ai.evil.com/oauth/authorize'), false);
  assert.equal(isClaudeAuthUrl('https://notclaude.ai/oauth/authorize'), false);
  // https only, and it must parse as a URL at all.
  assert.equal(isClaudeAuthUrl('http://claude.ai/oauth/authorize'), false);
  assert.equal(isClaudeAuthUrl('not a url'), false);
  assert.equal(isClaudeAuthUrl('file:///etc/passwd'), false);
});
