import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMountedIds } from './mounted-panes.ts';

test('mounts all when under the cap', () => {
  const m = computeMountedIds({
    liveIds: ['a', 'b', 'c'],
    lruOrder: ['c', 'b', 'a'],
    activeId: 'c',
    max: 12,
  });
  assert.deepEqual([...m].sort(), ['a', 'b', 'c']);
});

test('caps at max, keeping the most-recently-used', () => {
  const m = computeMountedIds({
    liveIds: ['a', 'b', 'c', 'd', 'e'],
    // e is newest, a oldest
    lruOrder: ['e', 'd', 'c', 'b', 'a'],
    activeId: 'e',
    max: 3,
  });
  assert.deepEqual([...m].sort(), ['c', 'd', 'e']);
  assert.ok(!m.has('a') && !m.has('b'), 'oldest two are evicted');
});

test('active is always mounted even when the cap is full and it is not yet in the LRU', () => {
  // The user just clicked `z`, which has never been active before, so it is
  // absent from lruOrder. It must still mount (otherwise: blank pane).
  const m = computeMountedIds({
    liveIds: ['a', 'b', 'c', 'z'],
    lruOrder: ['c', 'b', 'a'],
    activeId: 'z',
    max: 3,
  });
  assert.ok(m.has('z'), 'freshly-selected workspace is mounted');
  assert.equal(m.size, 3, 'still respects the cap');
  // z + the two most-recent live ones (c, b); a is evicted.
  assert.deepEqual([...m].sort(), ['b', 'c', 'z']);
});

test('ignores lru ids that are no longer live (archived/deleted)', () => {
  const m = computeMountedIds({
    liveIds: ['a', 'b'],
    lruOrder: ['ghost', 'a', 'gone', 'b'],
    activeId: 'a',
    max: 12,
  });
  assert.deepEqual([...m].sort(), ['a', 'b']);
});

test('null active with an empty lru mounts nothing', () => {
  const m = computeMountedIds({ liveIds: ['a', 'b'], lruOrder: [], activeId: null, max: 12 });
  assert.equal(m.size, 0);
});

test('active not in liveIds is not mounted (stale selection)', () => {
  const m = computeMountedIds({
    liveIds: ['a', 'b'],
    lruOrder: ['a', 'b'],
    activeId: 'archived-one',
    max: 12,
  });
  assert.ok(!m.has('archived-one'));
  assert.deepEqual([...m].sort(), ['a', 'b']);
});

test('max<=0 mounts nothing (defensive)', () => {
  const m = computeMountedIds({ liveIds: ['a'], lruOrder: ['a'], activeId: 'a', max: 0 });
  assert.equal(m.size, 0);
});
