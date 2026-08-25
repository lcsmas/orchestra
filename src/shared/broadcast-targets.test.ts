import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDirectChildTargets,
  normalizeExplicitTargets,
  type BroadcastCandidate,
} from './broadcast-targets.ts';

// ISSUE #86 — which ids a broadcast actually addresses.
//
// These are the SERVER-side rules. The CLI-side report shape is gated by
// `src/cli/broadcast-message.test.ts` against the built bundle; this file pins
// the resolution those reports are built from, which lives on the shared side
// precisely so it is reachable without Electron.

const WS = (id: string, parentId: string | null, archived = false): BroadcastCandidate => ({
  id,
  parentId,
  archived,
});

test('--children resolves DIRECT children only, never the subtree', () => {
  // parent -> kid1, kid2 ; kid1 -> grandkid. A subtree walk would return 3.
  const all = [
    WS('parent', null),
    WS('kid1', 'parent'),
    WS('kid2', 'parent'),
    WS('grandkid', 'kid1'),
    WS('stranger', 'someone-else'),
  ];
  const got = resolveDirectChildTargets(all, 'parent');
  assert.deepEqual(got, ['kid1', 'kid2']);
  assert.ok(!got.includes('grandkid'), 'a subtree broadcast is a foot-gun; direct-only is the contract');
  assert.ok(!got.includes('stranger'), "another parent's child must never be addressed");
  assert.ok(!got.includes('parent'), 'nobody is their own parent — self can never appear');
});

test('--children excludes archived children', () => {
  // An archived workspace has no agent to receive anything, so including it
  // would manufacture a guaranteed per-target failure and turn every broadcast
  // from a parent with old children into a non-zero exit.
  const all = [WS('kid1', 'parent'), WS('kid2', 'parent', true), WS('kid3', 'parent')];
  assert.deepEqual(resolveDirectChildTargets(all, 'parent'), ['kid1', 'kid3']);
});

test('--children of a parent with no children is EMPTY, so the caller can name it', () => {
  // The empty set must be distinguishable, because the dispatcher turns it into
  // a NAMED refusal rather than a silent success. A halt that reached nobody
  // reporting exit 0 is the failure this ticket exists to eliminate.
  assert.deepEqual(resolveDirectChildTargets([WS('a', null), WS('b', 'other')], 'a'), []);
});

test('a top-level workspace (parentId null/undefined) is not swept up by any parent', () => {
  // Guards the `x?.a === y` shape that has bitten this repo before: if the
  // filter compared undefined to undefined it would match EVERY top-level
  // workspace, and a broadcast would hit the entire fleet.
  const all: BroadcastCandidate[] = [
    { id: 'top1' },
    { id: 'top2', parentId: null },
    WS('kid', 'parent'),
  ];
  assert.deepEqual(resolveDirectChildTargets(all, 'parent'), ['kid']);
  // The dangerous case stated directly: resolving children of an UNDEFINED
  // parent must not return the top-level rows.
  assert.deepEqual(
    resolveDirectChildTargets(all, undefined as unknown as string),
    [],
    'undefined must never match undefined here — that would address the whole fleet',
  );
});

test('--to collapses duplicates, preserving first-seen order', () => {
  // Not cosmetic: each delivery becomes a SEPARATE turn for the target agent,
  // so a duplicate id sends the same halt twice.
  assert.deepEqual(normalizeExplicitTargets(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('--to drops blanks and whitespace-only entries (a trailing comma is a typo)', () => {
  assert.deepEqual(normalizeExplicitTargets(['a', '', '  ', 'b', '\t']), ['a', 'b']);
  assert.deepEqual(normalizeExplicitTargets([' a ', 'a']), ['a'], 'trimming happens before dedup');
});

test('--to with nothing usable is EMPTY, so the caller refuses instead of broadcasting', () => {
  assert.deepEqual(normalizeExplicitTargets(['', '   ']), []);
  assert.deepEqual(normalizeExplicitTargets([]), []);
});
