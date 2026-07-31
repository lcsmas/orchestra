import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, rankJumpTargets, type JumpTarget } from './jump-rank.ts';

test('fuzzyScore: subsequence matches, non-subsequence is null', () => {
  assert.notEqual(fuzzyScore('nx', 'next-api'), null);
  assert.equal(fuzzyScore('zz', 'next-api'), null);
});

test('fuzzyScore: case-insensitive', () => {
  assert.notEqual(fuzzyScore('NA', 'next-api'), null);
});

test('fuzzyScore: empty query scores 0', () => {
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('fuzzyScore: prefix run beats scattered match', () => {
  const prefix = fuzzyScore('ne', 'next-api');
  const scattered = fuzzyScore('ne', 'one-more');
  assert.ok(prefix !== null && scattered !== null && prefix > scattered);
});

test('fuzzyScore: word-boundary hits beat mid-word hits', () => {
  const boundary = fuzzyScore('fa', 'fix-auth');
  const midword = fuzzyScore('fa', 'sofa');
  assert.ok(boundary !== null && midword !== null && boundary > midword);
});

const targets: JumpTarget[] = [
  { id: 'a', branch: 'fix-auth-flow', repoLabel: 'orchestra', createdAt: 100 },
  { id: 'b', branch: 'add-webhook-retry', repoLabel: 'next-api', createdAt: 200 },
  { id: 'c', branch: 'route-accessoire', repoLabel: 'workspace', createdAt: 300 },
];

test('rankJumpTargets: empty query orders by MRU, then createdAt desc', () => {
  const ranked = rankJumpTargets('', targets, ['b']);
  assert.deepEqual(
    ranked.map((t) => t.id),
    ['b', 'c', 'a'],
  );
});

test('rankJumpTargets: query drops non-matches and ranks branch hits first', () => {
  const ranked = rankJumpTargets('auth', targets, []);
  assert.deepEqual(
    ranked.map((t) => t.id),
    ['a'],
  );
});

test('rankJumpTargets: repo-label match surfaces the repo workspaces', () => {
  const ranked = rankJumpTargets('next', targets, []);
  assert.ok(ranked.some((t) => t.id === 'b'));
});

test('rankJumpTargets: MRU bonus breaks near-ties toward the recent workspace', () => {
  const twins: JumpTarget[] = [
    { id: 'x', branch: 'fix-thing-one', repoLabel: 'repo', createdAt: 1 },
    { id: 'y', branch: 'fix-thing-two', repoLabel: 'repo', createdAt: 2 },
  ];
  const ranked = rankJumpTargets('fix', twins, ['x']);
  assert.equal(ranked[0].id, 'x');
});
