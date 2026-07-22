import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFallbackActive, pushHistory, HISTORY_CAP } from './active-fallback.ts';

const ws = (id: string, archived = false) => ({ id, archived });

// ─── pickFallbackActive ──────────────────────────────────────────────────────

test('picks the most-recently-opened non-archived workspace', () => {
  // The user opened c, then b, then a. a is active and being archived; the
  // workspace opened just before it was b, so we reopen b.
  const workspaces = [ws('a'), ws('b'), ws('c')];
  const history = ['a', 'b', 'c']; // a most-recent (being archived), b before it
  assert.equal(pickFallbackActive(workspaces, history, 'a'), 'b');
});

test('prefers recency over sidebar order', () => {
  // Sidebar order a,b,c but the user's last two opens were c then b. Archiving
  // b (active) should reopen c (previous open), even though a is first in list.
  const workspaces = [ws('a'), ws('b'), ws('c')];
  const history = ['b', 'c', 'a'];
  assert.equal(pickFallbackActive(workspaces, history, 'b'), 'c');
});

test('skips archived and removed entries in the history', () => {
  const workspaces = [ws('a'), ws('b', true), ws('c')];
  // history says b is most recent after the removed one, but b is archived → c.
  const history = ['x', 'b', 'c', 'a'];
  assert.equal(pickFallbackActive(workspaces, history, 'x'), 'c');
});

test('falls back to first non-archived when history has nothing usable', () => {
  const workspaces = [ws('a', true), ws('b'), ws('c')];
  assert.equal(pickFallbackActive(workspaces, [], 'x'), 'b');
});

test('ignores stale history ids no longer present', () => {
  const workspaces = [ws('a'), ws('b')];
  const history = ['gone', 'also-gone', 'b', 'a'];
  assert.equal(pickFallbackActive(workspaces, history, 'x'), 'b');
});

test('returns null when no non-archived workspace remains', () => {
  const workspaces = [ws('a', true), ws('b', true)];
  assert.equal(pickFallbackActive(workspaces, ['a', 'b'], 'x'), null);
  assert.equal(pickFallbackActive([], [], 'x'), null);
});

test('never returns the removedId even if it leads the history', () => {
  const workspaces = [ws('a'), ws('b')];
  assert.equal(pickFallbackActive(workspaces, ['a', 'b'], 'a'), 'b');
});

// ─── pushHistory ─────────────────────────────────────────────────────────────

test('pushes newest to the front', () => {
  assert.deepEqual(pushHistory(['b', 'c'], 'a'), ['a', 'b', 'c']);
});

test('de-duplicates: re-opening moves an id to the front', () => {
  assert.deepEqual(pushHistory(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
});

test('does not mutate the input array', () => {
  const input = ['a', 'b'];
  pushHistory(input, 'c');
  assert.deepEqual(input, ['a', 'b']);
});

test('caps the stack length', () => {
  const long = Array.from({ length: HISTORY_CAP }, (_, i) => `w${i}`);
  const out = pushHistory(long, 'new');
  assert.equal(out.length, HISTORY_CAP);
  assert.equal(out[0], 'new');
  assert.equal(out.includes(`w${HISTORY_CAP - 1}`), false); // oldest dropped
});
