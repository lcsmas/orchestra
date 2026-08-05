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

// Hibernation is housekeeping, not an attention signal: the sweeper stops an
// idle agent's process to reclaim memory and the conversation is intact, so a
// hibernated row must never appear in the Needs-You inbox or move the badge.
// Guarded here because `hibernatedAt` sits on the same record computeAttention
// reads — a future grouping rule that keyed on it would silently fill the inbox
// with every idle agent on the machine.
test('hibernatedAt never puts an idle workspace in the inbox or the badge', () => {
  const g = computeAttention([ws({ hibernatedAt: Date.now() - 60_000 })]);
  assert.equal(g.needsYou.length, 0);
  assert.equal(g.bookmarked.length, 0);
  assert.equal(g.working.length, 0);
  assert.equal(g.count, 0);
});

test('a hibernated workspace the user bookmarked still counts (the bookmark is theirs)', () => {
  const g = computeAttention([ws({ hibernatedAt: Date.now(), markedUnread: true })]);
  assert.equal(g.bookmarked.length, 1);
  assert.equal(g.count, 1);
});

test('running agents group under working and stay out of the badge', () => {
  const g = computeAttention([ws({ status: 'running' }), ws({ status: 'running' })]);
  assert.equal(g.working.length, 2);
  assert.equal(g.count, 0);
});

// ── waitingReason: blocked-on-you outranks finished-unseen ──────────────────
// Both are `status: 'waiting'`, so before the split these were indistinguishable
// and the inbox ordered them arbitrarily. A blocked agent is burning wall-clock
// doing nothing until you reply; a finished one already delivered its work.

test('a blocked agent sorts above one that merely finished unseen', () => {
  const fin = ws({ id: 'fin', status: 'waiting', waitingReason: 'finished' });
  const blk = ws({ id: 'blk', status: 'waiting', waitingReason: 'blocked' });
  const g = computeAttention([fin, blk]);
  assert.deepEqual(g.needsYou.map((w) => w.id), ['blk', 'fin']);
});

test('error still outranks a blocked agent', () => {
  const blk = ws({ id: 'blk', status: 'waiting', waitingReason: 'blocked' });
  const err = ws({ id: 'err', status: 'error' });
  const g = computeAttention([blk, err]);
  assert.deepEqual(g.needsYou.map((w) => w.id), ['err', 'blk']);
});

// Absent waitingReason must read as the WEAKER claim. Pre-split records (and
// any `waiting` written by a path that never set a reason) must not jump the
// queue ahead of an agent genuinely blocked on an answer.
test('absent waitingReason ranks as finished, never as blocked', () => {
  const legacy = ws({ id: 'legacy', status: 'waiting' });
  const blk = ws({ id: 'blk', status: 'waiting', waitingReason: 'blocked' });
  const g = computeAttention([legacy, blk]);
  assert.deepEqual(g.needsYou.map((w) => w.id), ['blk', 'legacy']);
});

test('waitingReason does not change the badge count', () => {
  const g = computeAttention([
    ws({ status: 'waiting', waitingReason: 'blocked' }),
    ws({ status: 'waiting', waitingReason: 'finished' }),
  ]);
  assert.equal(g.count, 2);
});
