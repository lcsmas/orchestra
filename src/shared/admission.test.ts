import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeldStartsLine, heldPhrase, isFleetMember, mustHoldStart, nextToRelease, planRelease, type HeldStart } from './admission.ts';

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
