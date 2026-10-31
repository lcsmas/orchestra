import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildParentOf, hiddenDotKind, isFolded, repoColor, rollupStatus, rollupTitle } from './sidebar-tree.ts';

// lead ─┬─ ops ─┬─ w1
//       │       └─ w2
//       └─ w3          other (root, no kids)   orphan (parent deleted → a root)
const list = [
  { id: 'lead' }, { id: 'ops', parentId: 'lead' }, { id: 'w1', parentId: 'ops' }, { id: 'w2', parentId: 'ops' },
  { id: 'w3', parentId: 'lead' }, { id: 'other' }, { id: 'orphan', parentId: 'gone' },
];
const parentOf = buildParentOf(list);
const none = new Set<string>();

test('buildParentOf keeps only parents present in the list', () => {
  assert.equal(parentOf.get('w1'), 'ops');
  assert.equal(parentOf.has('orphan'), false);
  assert.equal(parentOf.has('lead'), false);
});

test('selecting a worker unfolds its ancestors and folds unrelated subtrees', () => {
  assert.equal(isFolded('lead', 'w1', parentOf, none), false);
  assert.equal(isFolded('ops', 'w1', parentOf, none), false);
  assert.equal(isFolded('other', 'w1', parentOf, none), true);
});

test('selecting a coordinator unfolds its WHOLE subtree, not just one level', () => {
  assert.equal(isFolded('lead', 'lead', parentOf, none), false);
  assert.equal(isFolded('ops', 'lead', parentOf, none), false);
});

test('selecting a sibling branch folds the other branch', () => {
  assert.equal(isFolded('ops', 'w3', parentOf, none), true);
  assert.equal(isFolded('lead', 'w3', parentOf, none), false);
});

test('no selection folds everything; a manual toggle flips one row', () => {
  assert.equal(isFolded('lead', null, parentOf, none), true);
  assert.equal(isFolded('lead', null, parentOf, new Set(['lead'])), false);
  assert.equal(isFolded('ops', 'w1', parentOf, new Set(['ops'])), true);
});

test('a parentOf cycle cannot loop forever', () => {
  const cyc = new Map([['a', 'b'], ['b', 'a']]);
  assert.equal(isFolded('a', 'b', cyc, none), false);
});

test('rollup: an idle coordinator shows a running worker, with Orca precedence question > error > running', () => {
  assert.deepEqual(rollupStatus({ status: 'idle' }, [{ status: 'running' }, { status: 'idle' }]), { status: 'running', count: 1 });
  assert.deepEqual(rollupStatus({ status: 'idle' }, [{ status: 'running' }, { status: 'waiting' }]), { status: 'waiting', count: 1 });
  assert.deepEqual(rollupStatus({ status: 'running' }, [{ status: 'error' }, { status: 'error' }]), { status: 'error', count: 2 });
});

test('rollup: nothing when the row is already as urgent, has no kids, or carries its own unseen-done bell', () => {
  assert.equal(rollupStatus({ status: 'running' }, [{ status: 'running' }]), null);
  assert.equal(rollupStatus({ status: 'waiting' }, [{ status: 'error' }]), null);
  assert.equal(rollupStatus({ status: 'idle' }, []), null);
  assert.equal(rollupStatus({ status: 'idle' }, [{ status: 'idle' }, { status: 'stopped' }]), null);
  assert.equal(rollupStatus({ status: 'idle', autoUnread: true }, [{ status: 'running' }]), null);
});

test('rollupTitle names the source of the borrowed state', () => {
  assert.equal(rollupTitle('lead', { status: 'running', count: 2 }), 'lead — 2 spawned agents running');
  assert.equal(rollupTitle('lead', { status: 'waiting', count: 1 }), 'lead — 1 spawned agent waiting for your answer');
});

test('hidden dots: a child unseen-done is not a notification, the manual tag is', () => {
  assert.equal(hiddenDotKind({ status: 'idle' }), 'idle');
  assert.equal(hiddenDotKind({ status: 'idle', markedUnread: true }), 'waiting');
  assert.equal(hiddenDotKind({ status: 'stopped' }), 'off');
  assert.equal(hiddenDotKind({ status: 'running' }), 'running');
});

test('repoColor: registered repos get distinct colours by position; an unknown path is stable', () => {
  const repos = ['/home/lmas/dev/perso', '/home/lmas/dev/metarepo', '/home/lmas/Applications/orchestra'];
  assert.equal(new Set(repos.map((p) => repoColor(p, repos))).size, 3);
  const seven = Array.from({ length: 7 }, (_, i) => `/r/${i}`);
  assert.equal(new Set(seven.map((p) => repoColor(p, seven))).size, 7);
  assert.equal(repoColor('/not/registered', repos), repoColor('/not/registered', repos));
});
