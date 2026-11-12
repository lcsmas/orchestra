// #438 — the pause canary's PLAIN shape: one plain parent that owns its mission run + its children (no LEAD, no OPS). Pure topology only; the drill itself is `canary:pause -- --shape plain`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetSpec, namesOf } from '../../scripts/pause-canary/ids.mjs';

test('plain spec: ONE coordinator id (lead === ops), the children are its workers, branches named pc-ops / pc-w1', () => {
  const s = fleetSpec(1, 'abcdef01', { shape: 'plain', childKind: 'bg' });
  assert.equal(s.shape, 'plain');
  assert.equal(s.lead, s.ops, 'the plain parent is both « lead » and « ops » of every drill call');
  assert.deepEqual(s.coordRoles, ['ops']);
  assert.equal(s.workers.length, 1);
  assert.equal(s.workers[0].kind, 'bg');
  assert.notEqual(s.workers[0].id, s.ops);
  assert.deepEqual(Object.values(namesOf(s)).sort(), ['pc-ops', 'pc-w1']);
});

test('fleet spec is unchanged by the plain option (LEAD ⊃ OPS ⊃ workers, kinds round-robin)', () => {
  const s = fleetSpec(3, 'abcdef01');
  assert.equal(s.shape, 'fleet');
  assert.notEqual(s.lead, s.ops);
  assert.deepEqual(s.coordRoles, ['lead', 'ops']);
  assert.deepEqual(s.workers.map((w: { kind: string }) => w.kind), ['obey', 'blocked', 'quota']);
  assert.deepEqual(Object.values(namesOf(s)).sort(), ['pc-lead', 'pc-ops', 'pc-w1', 'pc-w2', 'pc-w3']);
});

test('a bad shape or member count is refused', () => {
  assert.throws(() => fleetSpec(1, 'abcdef01', { shape: 'nope' }), /shape must be/);
  assert.throws(() => fleetSpec(0, 'abcdef01', { shape: 'plain' }), /members must be/);
});
