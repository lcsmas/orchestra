// #240 r3 F3 — the fence is per-call: a stale release can never drop a later call's fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginMigration, endMigration, isMigrating } from './migration-fence.ts';

test('beginMigration: one holder per workspace; a 2nd is refused (null) until released', () => {
  const t1 = beginMigration('w1');
  assert.ok(t1);
  assert.equal(isMigrating('w1'), true);
  assert.equal(beginMigration('w1'), null);
  assert.ok(beginMigration('w2'), 'another workspace is independent');
  endMigration('w1', t1);
  assert.equal(isMigrating('w1'), false);
  endMigration('w2');
});

test('a STALE token cannot release a later holder\'s fence (call 1\'s late finally vs call 2)', () => {
  const t1 = beginMigration('w3') as string;
  endMigration('w3', t1); // call 1's re-pin release
  const t2 = beginMigration('w3') as string; // call 2 begins from the workspace:update broadcast
  assert.notEqual(t1, t2);
  endMigration('w3', t1); // call 1's `finally` — must be a no-op
  assert.equal(isMigrating('w3'), true, 'call 2 still holds the fence');
  assert.equal(beginMigration('w3'), null, 'a 3rd migration is still refused');
  endMigration('w3', t2);
  assert.equal(isMigrating('w3'), false);
});

test('endMigration without a token force-releases (test/tools only); releasing an unheld fence is harmless', () => {
  const t = beginMigration('w4');
  assert.ok(t);
  endMigration('w4');
  assert.equal(isMigrating('w4'), false);
  endMigration('w4', 'nope');
  assert.equal(isMigrating('w4'), false);
});
