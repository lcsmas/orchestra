// #439 — who may receive an attach: ANY workspace; only structure refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAttachTarget, type AttachTargetNode } from './attach-target.ts';

const nodes: Record<string, AttachTargetNode> = {
  a: { id: 'a' },
  b: { id: 'b', parentId: 'a' },
  c: { id: 'c', parentId: 'b' },
  plain: { id: 'plain', kind: 'worktree' },
  gone: { id: 'gone', archived: true },
};
const ask = (id: string, parentId: string, targetRunClosed = false) => decideAttachTarget({ id, parentId, lookup: (x) => nodes[x], targetRunClosed });
const err = (v: ReturnType<typeof ask>): string => (v.ok ? '' : v.error);

test('#439 any workspace is a valid target: a plain, never-promoted one, a childless one, a nested one', () => {
  assert.equal(ask('a', 'plain').ok, true);
  assert.equal(ask('plain', 'c').ok, true, 'a grandchild of another tree');
});

test('#439 structure refuses: self, unknown, archived, closed run, cycle (with its reason)', () => {
  assert.match(err(ask('a', 'a')), /own parent/);
  assert.match(err(ask('a', 'zzz')), /unknown parent/);
  assert.match(err(ask('plain', 'gone')), /archived/);
  assert.match(err(ask('plain', 'a', true)), /closed/);
  assert.match(err(ask('a', 'c')), /cycle/, 'a under its own grandchild');
});
