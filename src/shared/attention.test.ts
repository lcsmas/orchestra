import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAttention } from './attention.ts';
import type { Workspace } from './types.ts';

let seq = 0;
function ws(over: Partial<Workspace>): Workspace {
  seq += 1;
  return {
    id: over.id ?? `ws-${seq}`,
    name: 'n',
    repoPath: '/repo',
    worktreePath: '/wt',
    branch: over.branch ?? `branch-${seq}`,
    baseBranch: 'main',
    createdAt: seq,
    status: 'idle',
    agent: 'claude',
    ...over,
  } as Workspace;
}

test('waiting and error land in needsYou, errors first', () => {
  const a = ws({ id: 'a', status: 'waiting' });
  const b = ws({ id: 'b', status: 'error' });
  const { needsYou, count } = computeAttention([a, b]);
  assert.deepEqual(
    needsYou.map((w) => w.id),
    ['b', 'a'],
  );
  assert.equal(count, 2);
});

test('archived workspaces are excluded everywhere', () => {
  const g = computeAttention([
    ws({ status: 'waiting', archived: true }),
    ws({ status: 'running', archived: true }),
    ws({ markedUnread: true, archived: true }),
  ]);
  assert.equal(g.needsYou.length + g.bookmarked.length + g.working.length, 0);
  assert.equal(g.count, 0);
});

test('a waiting workspace that is also bookmarked is not double-counted', () => {
  const w = ws({ status: 'waiting', markedUnread: true });
  const g = computeAttention([w]);
  assert.equal(g.needsYou.length, 1);
  assert.equal(g.bookmarked.length, 0);
  assert.equal(g.count, 1);
});

test('bookmarks on idle workspaces show under bookmarked and count', () => {
  const g = computeAttention([ws({ markedUnread: true }), ws({})]);
  assert.equal(g.bookmarked.length, 1);
  assert.equal(g.count, 1);
});

test('running agents group under working and stay out of the badge', () => {
  const g = computeAttention([ws({ status: 'running' }), ws({ status: 'running' })]);
  assert.equal(g.working.length, 2);
  assert.equal(g.count, 0);
});
