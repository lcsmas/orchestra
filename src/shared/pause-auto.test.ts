import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAUSE_AUTO_BY,
  RESET_GRACE_MS,
  REPRISE_STREAK_WINDOW_MS,
  TRAP_WAIT_MAX_MS,
  decideRunReprise,
  encodePauseAuto,
  heldAddresseesKey,
  memberVerdict,
  mergePauseAuto,
  parseAutoHeld,
  parsePauseAuto,
  repriseBackoffMs,
  type MemberEvidence,
  type MemberVerdict,
} from './pause-auto.ts';
import type { UsageWindows } from './accounts.ts';

// #256 (ledger #276 D6) — the PURE half of the auto Pause / auto Reprise. Expectations are literals; every arm is named for the clause
// the in-place mutants (scripts/pause-auto/mutate-unit.mjs) must redden.

const T0 = 1_800_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const usable: UsageWindows = { fiveHour: { utilization: 12, resetsAt: iso(T0 + 3_600_000) }, sevenDay: { utilization: 30, resetsAt: iso(T0 + 86_400_000) } };
const limitedUntil = (ms: number): UsageWindows => ({ fiveHour: { utilization: 100, resetsAt: iso(ms) }, sevenDay: { utilization: 30, resetsAt: iso(T0 + 86_400_000) } });

/** blocked at T0, "now" T0+60s, a reset one hour away — override with `o`. */
function ev(o: Partial<MemberEvidence> = {}): MemberEvidence {
  return { blockedAt: T0, accountChangedAt: null, resetsAtMs: T0 + 3_600_000, reading: null, now: T0 + 60_000, ...o };
}

test('ENCODING: pause_auto round-trips for ITS epoch and reads null (= MANUAL) for any other pause', () => {
  const json = encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['acc-A'] }, T0);
  assert.deepEqual(parsePauseAuto(json, T0), { reason: 'usage_limit', wsIds: ['w1'], accountIds: ['acc-A'] });
  assert.equal(parsePauseAuto(json, T0 + 1), null, 'a stale column of an EARLIER pause must never make a later manual pause automatic');
  assert.equal(parsePauseAuto(json, null), null, 'not paused');
  assert.equal(parsePauseAuto(null, T0), null);
  assert.equal(parsePauseAuto('', T0), null);
});

test('ENCODING: malformed / foreign pause_auto reads MANUAL (fail safe — never auto-resume what we cannot prove we paused)', () => {
  for (const bad of ['{', 'null', '[]', '"x"', JSON.stringify({ reason: 'auth', wsIds: [], accountIds: [], epoch: T0 }), JSON.stringify({ reason: 'usage_limit', wsIds: [1], accountIds: [], epoch: T0 }), JSON.stringify({ reason: 'usage_limit', wsIds: [], accountIds: [1], epoch: T0 }), JSON.stringify({ reason: 'usage_limit', wsIds: [], accountIds: [] })]) {
    assert.equal(parsePauseAuto(bad, T0), null, bad);
  }
});

test('MERGE: a member joins once; ids and accounts stay index-parallel; a repeat refreshes its account', () => {
  const a = mergePauseAuto(null, { wsId: 'w1', accountId: 'A' });
  assert.deepEqual(a, { reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] });
  const b = mergePauseAuto(a, { wsId: 'w2', accountId: null });
  assert.deepEqual(b, { reason: 'usage_limit', wsIds: ['w1', 'w2'], accountIds: ['A', null] });
  assert.deepEqual(mergePauseAuto(b, { wsId: 'w1', accountId: 'B' }), { reason: 'usage_limit', wsIds: ['w1', 'w2'], accountIds: ['B', null] });
  assert.deepEqual(a, { reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, 'input not mutated');
});

test('constants: the auto pauser label, the 5 min reset grace, the 10 min trap wait', () => {
  assert.equal(PAUSE_AUTO_BY, 'host:usage_limit');
  assert.equal(RESET_GRACE_MS, 300_000);
  assert.equal(TRAP_WAIT_MAX_MS, 600_000);
});

test('VERDICT quota override: a fresh reading showing quota beats a stored reset that is still an hour away', () => {
  const v = memberVerdict(ev({ reading: { fetchedAt: T0 + 30_000, data: usable } }));
  assert.deepEqual(v, { ok: true, via: 'quota' });
});

test('VERDICT limited: a fresh reading still limited until a reset that is ahead ⇒ wait, no refresh asked', () => {
  const v = memberVerdict(ev({ reading: { fetchedAt: T0 + 30_000, data: limitedUntil(T0 + 3_600_000) } }));
  assert.deepEqual(v, { ok: false, why: 'limited', refresh: false });
});

test('VERDICT staleness: a reading fetched at or before the block is NOT evidence, even when it shows quota', () => {
  for (const fetchedAt of [T0 - 10_000, T0]) {
    const v = memberVerdict(ev({ reading: { fetchedAt, data: usable } }));
    assert.deepEqual(v, { ok: false, why: 'no-fresh-reading', refresh: false }, `fetchedAt ${fetchedAt - T0}`);
  }
});

test('VERDICT account change: a reading older than the migration / re-login was taken for the OLD account; one at the change instant counts', () => {
  const changed = T0 + 40_000;
  assert.equal(memberVerdict(ev({ accountChangedAt: changed, reading: { fetchedAt: changed - 1, data: usable } })).ok, false);
  assert.deepEqual(memberVerdict(ev({ accountChangedAt: changed, reading: { fetchedAt: changed, data: usable } })), { ok: true, via: 'quota' });
  assert.deepEqual(memberVerdict(ev({ accountChangedAt: changed, reading: { fetchedAt: changed + 5_000, data: usable } })), { ok: true, via: 'quota' });
});

test('VERDICT a limited reading whose OWN reset has passed is stale, not a veto', () => {
  // reading at T0+30s says "limited until T0+45s"; now is T0+60s ⇒ it says nothing about now
  const v = memberVerdict(ev({ resetsAtMs: null, reading: { fetchedAt: T0 + 30_000, data: limitedUntil(T0 + 45_000) } }));
  assert.deepEqual(v, { ok: false, why: 'no-fresh-reading', refresh: true });
});

test('VERDICT reset grace: no usable reading ⇒ the stored reset + 5 min is the last resort; an UNKNOWN reset never resumes blind', () => {
  const reset = T0 + 3_600_000;
  assert.deepEqual(memberVerdict(ev({ now: reset + RESET_GRACE_MS })), { ok: true, via: 'reset-grace' });
  assert.deepEqual(memberVerdict(ev({ now: reset + RESET_GRACE_MS - 1 })), { ok: false, why: 'no-fresh-reading', refresh: true });
  assert.deepEqual(memberVerdict(ev({ now: reset - 1 })), { ok: false, why: 'no-fresh-reading', refresh: false });
  assert.deepEqual(memberVerdict(ev({ resetsAtMs: null, now: T0 + 10 * 86_400_000 })), { ok: false, why: 'no-fresh-reading', refresh: true });
});

test('VERDICT a still-limited reading taken AFTER the reset vetoes the grace fallback (weekly window / stale stored reset)', () => {
  const reset = T0 + 600_000;
  const now = reset + RESET_GRACE_MS + 60_000;
  const v = memberVerdict(ev({ resetsAtMs: reset, now, reading: { fetchedAt: now - 1_000, data: limitedUntil(now + 3_600_000) } }));
  assert.deepEqual(v, { ok: false, why: 'limited', refresh: false });
});

test('VERDICT a reading without data (the fetch failed) is no reading', () => {
  assert.deepEqual(memberVerdict(ev({ reading: { fetchedAt: T0 + 30_000, data: null } })), { ok: false, why: 'no-fresh-reading', refresh: false });
});

test('VERDICT extra usage that absorbs the overflow is quota (the shared usageLimitedUntil rule)', () => {
  const data: UsageWindows = { ...limitedUntil(T0 + 3_600_000), extraUtilization: 10 };
  assert.deepEqual(memberVerdict(ev({ reading: { fetchedAt: T0 + 30_000, data } })), { ok: true, via: 'quota' });
});

test('VERDICT account change: the stored reset time belongs to the OLD account — it never feeds the grace fallback of the new one', () => {
  const reset = T0 + 3_600_000;
  const now = reset + RESET_GRACE_MS + 1;
  assert.deepEqual(memberVerdict(ev({ now })), { ok: true, via: 'reset-grace' }, 'control: without a change the grace applies');
  assert.deepEqual(memberVerdict(ev({ now, accountChangedAt: T0 + 100 })), { ok: false, why: 'no-fresh-reading', refresh: true });
});

const ok: MemberVerdict = { ok: true, via: 'quota' };
const wait: MemberVerdict = { ok: false, why: 'limited', refresh: false };

test('RUN decision: every trigger needs quota — one limited member keeps the run paused', () => {
  assert.deepEqual(decideRunReprise({ verdicts: [ok, ok], pausedAt: T0, trapAt: T0 + 1, now: T0 + 100 }), { action: 'reprise' });
  assert.deepEqual(decideRunReprise({ verdicts: [ok, wait], pausedAt: T0, trapAt: T0 + 1, now: T0 + 100 }), { action: 'wait', why: 'quota-not-back' });
  assert.deepEqual(decideRunReprise({ verdicts: [], pausedAt: T0, trapAt: T0 + 1, now: T0 + 100 }), { action: 'wait', why: 'no-trigger-member' });
});

test('RUN decision: the Reprise waits for the trap (the Bilans are the Consigne source) — until the trap is overdue', () => {
  assert.deepEqual(decideRunReprise({ verdicts: [ok], pausedAt: T0, trapAt: null, now: T0 + TRAP_WAIT_MAX_MS - 1 }), { action: 'wait', why: 'trap-pending' });
  assert.deepEqual(decideRunReprise({ verdicts: [ok], pausedAt: T0, trapAt: null, now: T0 + TRAP_WAIT_MAX_MS }), { action: 'reprise' });
});

test('RUN decision: the flap guard holds a Reprise until its instant, after the quota check and before the trap check', () => {
  assert.deepEqual(decideRunReprise({ verdicts: [ok], pausedAt: T0, trapAt: T0 + 1, holdoffUntil: T0 + 500, now: T0 + 499 }), { action: 'wait', why: 'backoff' });
  assert.deepEqual(decideRunReprise({ verdicts: [ok], pausedAt: T0, trapAt: T0 + 1, holdoffUntil: T0 + 500, now: T0 + 500 }), { action: 'reprise' });
  assert.deepEqual(decideRunReprise({ verdicts: [ok], pausedAt: T0, trapAt: T0 + 1, holdoffUntil: null, now: T0 + 1 }), { action: 'reprise' });
  assert.deepEqual(decideRunReprise({ verdicts: [wait], pausedAt: T0, trapAt: T0 + 1, holdoffUntil: T0 + 500, now: T0 + 1 }), { action: 'wait', why: 'quota-not-back' });
});

test('constants: the flap guard doubles from 5 min to a 60 min cap; the streak window is 2 h', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(repriseBackoffMs), [0, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  assert.equal(REPRISE_STREAK_WINDOW_MS, 7_200_000);
});

test('HELD codec (R4): encode/parse round-trips for ITS epoch only; malformed or foreign shapes read none; a hold needs a valid auto pause; the key is order-insensitive', () => {
  const held = { at: T0 + 5, addressees: ['Zc@Zc', 'Zd@Zd'], to: 'L' };
  const json = encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T0, held);
  assert.deepEqual(parseAutoHeld(json, T0), held);
  assert.equal(parseAutoHeld(json, T0 + 1), null, 'epoch-bound');
  assert.equal(parseAutoHeld(json, null), null);
  assert.equal(parseAutoHeld(encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T0), T0), null, 'no hold recorded');
  assert.deepEqual(parsePauseAuto(json, T0), { reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, 'the reason codec ignores the hold');
  for (const bad of [{ at: 'x', addressees: [], to: 'L' }, { at: 1, addressees: [1], to: 'L' }, { at: 1, addressees: [], to: 2 }, null, 'str', { addressees: [], to: 'L' }]) {
    const j = JSON.stringify({ reason: 'usage_limit', wsIds: [], accountIds: [], epoch: T0, held: bad });
    assert.equal(parseAutoHeld(j, T0), null, JSON.stringify(bad));
  }
  assert.equal(parseAutoHeld('{', T0), null);
  assert.equal(parseAutoHeld(JSON.stringify({ reason: 'auth', wsIds: [], accountIds: [], epoch: T0, held }), T0), null, 'a hold on a non-auto pause is nothing');
  assert.deepEqual(heldAddresseesKey([{ wsId: 'Zd', runId: 'Zd' }, { wsId: 'Zc', runId: 'R' }]), ['Zc@R', 'Zd@Zd']);
});
