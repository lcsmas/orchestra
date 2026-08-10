import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnchorIndex } from './scroll-anchor.ts';

test('unique ids resolve exactly like indexOf', () => {
  const ids = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < ids.length; i++) {
    assert.equal(resolveAnchorIndex(ids, ids[i], i), i);
    // …even when the hint is stale (rows were prepended/removed).
    assert.equal(resolveAnchorIndex(ids, ids[i], 0), i);
    assert.equal(resolveAnchorIndex(ids, ids[i], ids.length - 1), i);
  }
});

test('a stale hint still finds the row after a history prepend', () => {
  const before = ['x', 'y', 'z'];
  const after = ['h1', 'h2', ...before];
  assert.equal(resolveAnchorIndex(after, 'y', before.indexOf('y')), 3);
});

test('DUPLICATE ids resolve to the occurrence the user is looking at', () => {
  // The transcript-teleport shape: a hibernated session woke up and re-minted
  // `user:0` at the bottom of a list whose top row was already `user:0`.
  const ids = ['user:0', ...Array.from({ length: 180 }, (_, i) => `m${i}`), 'user:0'];
  const bottom = ids.length - 1;
  assert.equal(ids.indexOf('user:0'), 0, 'indexOf is what teleported the viewport');
  assert.equal(resolveAnchorIndex(ids, 'user:0', bottom), bottom);
  // A stale-but-nearby hint still lands on the bottom copy, not the top one.
  assert.equal(resolveAnchorIndex(ids, 'user:0', bottom - 3), bottom);
  // And an anchor genuinely captured at the top still resolves to the top.
  assert.equal(resolveAnchorIndex(ids, 'user:0', 0), 0);
});

test('a removed anchor row reports -1 rather than a wrong index', () => {
  assert.equal(resolveAnchorIndex(['a', 'b'], 'gone', 1), -1);
  assert.equal(resolveAnchorIndex([], 'a', 0), -1);
});

test('out-of-range hints are tolerated', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(resolveAnchorIndex(ids, 'c', 99), 2);
  assert.equal(resolveAnchorIndex(ids, 'a', -5), 0);
});
