// #439 — the sidebar's drop rule: ANY row attaches; where a row is also a reorder target the middle attaches and the edges reorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropIntent, REORDER_EDGE } from './dnd-attach-zone.ts';

test('#439 a row that can only be attached to attaches over its whole height (a plain, never-promoted child row included)', () => {
  for (const y of [0, 0.1, 0.5, 0.9, 1]) assert.equal(dropIntent({ canAttach: true, canReorder: false, yFraction: y }), 'attach');
});

test('#439 a row that is BOTH: middle attaches, top / bottom quarter reorder (before / after)', () => {
  assert.equal(dropIntent({ canAttach: true, canReorder: true, yFraction: 0.5 }), 'attach');
  assert.equal(dropIntent({ canAttach: true, canReorder: true, yFraction: REORDER_EDGE }), 'attach', 'the edge itself still attaches');
  assert.equal(dropIntent({ canAttach: true, canReorder: true, yFraction: 0.1 }), 'before');
  assert.equal(dropIntent({ canAttach: true, canReorder: true, yFraction: 0.9 }), 'after');
});

test('#439 a row that cannot be attached to only reorders by halves; neither = no drop', () => {
  assert.equal(dropIntent({ canAttach: false, canReorder: true, yFraction: 0.4 }), 'before');
  assert.equal(dropIntent({ canAttach: false, canReorder: true, yFraction: 0.6 }), 'after');
  assert.equal(dropIntent({ canAttach: false, canReorder: false, yFraction: 0.5 }), null);
});
