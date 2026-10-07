import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdmissionReport, formatHeldStartsLine, formatRestartHeldReply, heldPhrase, heldStartLabel, isFleetMember, isHumanOrigin, releaseFailureBody, releaseTimeoutBody, mustHoldStart, nextToRelease, planRelease, type HeldStart } from './admission.ts';

const H = (wsId: string, seq: number, coordinator = false, kind: HeldStart['kind'] = 'spawn'): HeldStart => ({ wsId, kind, seq, since: 1_000 + seq, coordinator });

// ── positive control: the baseline MUST hold, else every "passes" arm below is vacuous ──
test('baseline: an AUTOMATIC start of a FLEET MEMBER while Admission is held IS held', () => {
  assert.equal(mustHoldStart({ ws: { parentId: 'ops' }, origin: 'auto', holding: true, queued: false }), true);
});

test('fleet_member: a workspace with a coordinator (parentId) — never a top-level / detached / unknown one', () => {
  assert.equal(isFleetMember({ parentId: 'ops' }), true);
  assert.equal(isFleetMember({}), false);
  assert.equal(isFleetMember({ parentId: '' }), false);
  assert.equal(isFleetMember(undefined), false);
  assert.equal(isFleetMember(null), false);
});

test('human_origin: only the human origin reads as human', () => {
  assert.equal(isHumanOrigin('human'), true);
  assert.equal(isHumanOrigin('auto'), false);
});

test('human_passes: a human-initiated start is never held, whatever the memory or the queue', () => {
  assert.equal(mustHoldStart({ ws: { parentId: 'ops' }, origin: 'human', holding: true, queued: true }), false);
});

test('non_member_passes: an automatic start of a top-level workspace is never held', () => {
  assert.equal(mustHoldStart({ ws: {}, origin: 'auto', holding: true, queued: true }), false);
  assert.equal(mustHoldStart({ ws: undefined, origin: 'auto', holding: true, queued: true }), false);
});

test('not_holding: memory fine and nobody queued → passes; memory fine but the line is not empty → the newcomer JOINS it (arrival order)', () => {
  assert.equal(mustHoldStart({ ws: { parentId: 'ops' }, origin: 'auto', holding: false, queued: false }), false);
  assert.equal(mustHoldStart({ ws: { parentId: 'ops' }, origin: 'auto', holding: false, queued: true }), true);
});

test('release_order: coordinators first, then arrival order; ties never reorder', () => {
  const a = H('a', 1), b = H('b', 2), c = H('c', 3, true), d = H('d', 4, true);
  assert.equal(nextToRelease([a, b, c, d])?.wsId, 'c', 'the OLDEST coordinator, ahead of older workers');
  assert.equal(nextToRelease([a, b, d])?.wsId, 'd');
  assert.equal(nextToRelease([b, a])?.wsId, 'a', 'no coordinator → arrival order, whatever the array order');
  assert.equal(nextToRelease([]), null);
});

const SNAP = { admissionEnabled: true, measured: true, mayReleaseOneStart: true };
test('plan_release: a fresh snapshot with room releases the next; the three waits are named', () => {
  assert.deepEqual(planRelease([H('a', 1)], SNAP), { action: 'release', entry: H('a', 1) });
  assert.deepEqual(planRelease([], SNAP), { action: 'wait', reason: 'empty' });
  assert.deepEqual(planRelease([H('a', 1)], { ...SNAP, mayReleaseOneStart: false }), { action: 'wait', reason: 'memory' });
  assert.deepEqual(planRelease([H('a', 1)], { ...SNAP, measured: false }), { action: 'wait', reason: 'unmeasured' });
  assert.deepEqual(planRelease([H('a', 1)], { ...SNAP, measured: false, mayReleaseOneStart: true }), { action: 'wait', reason: 'unmeasured' }, 'a dead meter releases nothing even if the flag is stale-true');
});

test('plan_release_toggle_off: the global toggle OFF holds nothing — queued starts go out at once, whatever the memory', () => {
  assert.equal(planRelease([H('a', 1)], { admissionEnabled: false, measured: true, mayReleaseOneStart: false }).action, 'release');
  assert.equal(planRelease([H('a', 1)], { admissionEnabled: false, measured: false, mayReleaseOneStart: false }).action, 'release');
});

test('held_phrase / held_starts_line: since-when is in the OPS-facing text; the line lists RELEASE order', () => {
  assert.match(heldPhrase('spawn', Date.UTC(2026, 9, 7, 14, 2, 11)), /^spawn held for memory since 2026-10-07T14:02:11\.000Z — it starts when memory recovers \(Admission\)$/);
  assert.equal(formatHeldStartsLine([]), null);
  const line = formatHeldStartsLine([
    { wsId: 'a', label: 'worker-a', kind: 'spawn', since: Date.UTC(2026, 9, 7, 14, 0, 0), coordinator: false, seq: 1 },
    { wsId: 'c', label: 'sub-ops', kind: 'restart', since: Date.UTC(2026, 9, 7, 14, 1, 0), coordinator: true, seq: 2 },
  ]) as string;
  assert.match(line, /^held starts: 2 held for memory, release order — sub-ops \(restart, coordinator, since 2026-10-07T14:01:00\.000Z\) → worker-a \(spawn, since 2026-10-07T14:00:00\.000Z\)$/);
});

test('release_failure_body: names the kind, the member, since-when, the reason and the way out', () => {
  assert.equal(
    releaseFailureBody('restart', 'ws-m1', Date.UTC(2026, 9, 7, 14, 2, 11), 'the mid-turn guard refused'),
    'Admission: the restart of ws-m1 that was HELD for memory since 2026-10-07T14:02:11.000Z was released but did NOT start — the mid-turn guard refused. It is not queued any more: retry it with `orchestra restart ws-m1`.',
  );
});

// ─── #286 leftovers (review r2 T1, seat 2 F1 F2 F3) ─────────────────────────────────────────────────────────────────────────────────

test('T1 release_timeout_body: "not CONFIRMED within N s — it may still be starting; check peers first", never "did NOT start"', () => {
  const b = releaseTimeoutBody('spawn', 'ws-m1', Date.UTC(2026, 9, 7, 14, 2, 11), 90);
  assert.equal(b, 'Admission: the spawn of ws-m1 that was HELD for memory since 2026-10-07T14:02:11.000Z was released but is not CONFIRMED within 90 s — it may still be starting. Check `orchestra peers` first; only if ws-m1 is still stopped retry it with `orchestra restart ws-m1`.');
  assert.doesNotMatch(b, /did NOT start/);
});

test('F2 decide_admission_report: every branch — send, no coordinator (unknown member / archived-or-missing parent), no bus, switch OFF (counted, not fired)', () => {
  const ok = { hasMember: true, coordinatorLive: true, hasBus: true, switchOn: true };
  assert.deepEqual(decideAdmissionReport(ok), { action: 'send' });
  assert.deepEqual(decideAdmissionReport({ ...ok, hasMember: false }), { action: 'skip', why: 'no-coordinator' });
  assert.deepEqual(decideAdmissionReport({ ...ok, coordinatorLive: false }), { action: 'skip', why: 'no-coordinator' });
  assert.deepEqual(decideAdmissionReport({ ...ok, hasBus: false }), { action: 'skip', why: 'no-bus' });
  assert.deepEqual(decideAdmissionReport({ ...ok, switchOn: false }), { action: 'skip', why: 'switch-off' });
  assert.deepEqual(decideAdmissionReport({ ...ok, coordinatorLive: false, hasBus: false, switchOn: false }), { action: 'skip', why: 'no-coordinator' }, 'no coordinator wins: nobody to tell');
  assert.deepEqual(decideAdmissionReport({ ...ok, hasBus: false, switchOn: false }), { action: 'skip', why: 'no-bus' }, 'no bus wins over the switch');
});

test('F3 held_start_label: name, else branch, else the id (a deleted workspace)', () => {
  assert.equal(heldStartLabel({ name: 'worker-a', branch: 'feat/a' }, 'id1'), 'worker-a');
  assert.equal(heldStartLabel({ branch: 'feat/a' }, 'id1'), 'feat/a');
  assert.equal(heldStartLabel({}, 'id1'), 'id1');
  assert.equal(heldStartLabel(undefined, 'id1'), 'id1');
  assert.equal(heldStartLabel(null, 'id1'), 'id1');
});

test('F1 restart_held_reply: the line `orchestra restart` prints for an accepted-but-held restart carries the note, never the normal "Restarted" line', () => {
  const note = heldPhrase('restart', Date.UTC(2026, 9, 7, 14, 2, 11));
  assert.equal(formatRestartHeldReply('ws-m1', note), 'Restart of ws-m1 accepted — restart held for memory since 2026-10-07T14:02:11.000Z — it starts when memory recovers (Admission)');
  assert.doesNotMatch(formatRestartHeldReply('ws-m1', note), /Restarted/);
});
