// #118 N2 (ledger #123) — the freeze run id is the WAVE ANCHOR = the tree ROOT.
//
// The defect: walking a single level up (`ws.parentId ?? ws.id`) split a 3-deep
// tree — LEAD → OPS → IMPL resolved to TWO run ids (OPS and LEAD), so the two
// halves of one wave froze against different rows and the notice diverged. The
// fix walks to the root. These arms drive the PURE walk with an injected lookup
// (no store, no Electron), so a mutation to one level reddens the 3-chain arm —
// which is exactly the mutant the verifier runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { walkToRootId, isRootAnchor, type WaveNode } from './wave-run-id.ts';

/** A Map-backed lookup, the store stand-in. */
function lookupOf(nodes: WaveNode[]): (id: string) => WaveNode | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => byId.get(id);
}

test('N2 — a 3-level chain root→mid→leaf: every node resolves to the ROOT', () => {
  const root: WaveNode = { id: 'lead-root' };
  const mid: WaveNode = { id: 'ops-mid', parentId: 'lead-root' };
  const leaf: WaveNode = { id: 'impl-leaf', parentId: 'ops-mid' };
  const lookup = lookupOf([root, mid, leaf]);

  // THE assertion N2 is about: all three members of the wave compute ONE run id,
  // the root. A one-level walk would give leaf→'ops-mid' and mid→'lead-root' —
  // two ids — which is what splits the freeze. This arm reddens on that mutant.
  assert.equal(walkToRootId(leaf, lookup), 'lead-root', 'leaf must resolve to the ROOT, not its parent');
  assert.equal(walkToRootId(mid, lookup), 'lead-root', 'mid must resolve to the ROOT');
  assert.equal(walkToRootId(root, lookup), 'lead-root', 'the root resolves to itself');
});

test('N2 — a root with no parent resolves to itself', () => {
  const solo: WaveNode = { id: 'solo' };
  assert.equal(walkToRootId(solo, lookupOf([solo])), 'solo');
});

test('N2 fallback — a BROKEN parent link stops at the deepest RESOLVABLE ancestor', () => {
  // leaf → mid exists, but mid's parent ('gone-root') is absent from the store
  // (a dangling parentId after a delete). The walk must not throw and must return
  // the deepest ancestor it could resolve — 'mid', not 'gone-root', not the leaf.
  const mid: WaveNode = { id: 'mid', parentId: 'gone-root' };
  const leaf: WaveNode = { id: 'leaf', parentId: 'mid' };
  const lookup = lookupOf([mid, leaf]); // 'gone-root' deliberately absent
  assert.equal(walkToRootId(leaf, lookup), 'mid', 'a broken link falls back to the deepest resolvable ancestor');
  // And a leaf whose OWN parent is missing falls back to itself.
  const orphan: WaveNode = { id: 'orphan', parentId: 'nope' };
  assert.equal(walkToRootId(orphan, lookupOf([orphan])), 'orphan');
});

test('N2 cycle guard — a malformed parentId cycle terminates, never loops', () => {
  // a → b → a. The `seen` set bounds the walk; it stops the moment it revisits an
  // id rather than looping forever. Which of the two it returns is unspecified,
  // but it must be one of them and it must RETURN.
  const a: WaveNode = { id: 'a', parentId: 'b' };
  const b: WaveNode = { id: 'b', parentId: 'a' };
  const lookup = lookupOf([a, b]);
  const got = walkToRootId(a, lookup);
  assert.ok(got === 'a' || got === 'b', `cycle must terminate at a or b, got ${got}`);
});

// ─── #134 isRootAnchor — only the tree ROOT starts (and freezes) the run ─────

test('#134 — the ROOT is an anchor; every MEMBER under it is NOT', () => {
  const root: WaveNode = { id: 'lead-root' };
  const mid: WaveNode = { id: 'ops-mid', parentId: 'lead-root' };
  const leaf: WaveNode = { id: 'impl-leaf', parentId: 'ops-mid' };
  const lookup = lookupOf([root, mid, leaf]);
  // THE #134 condition: startRun is called iff this holds. The root owns the run
  // row; mid and leaf resolve (via walkToRootId) to the SAME root and must NOT
  // start their own run, or one wave gets two independently-frozen run rows.
  assert.equal(isRootAnchor(root, lookup), true, 'the root IS the anchor');
  assert.equal(isRootAnchor(mid, lookup), false, 'a mid member is NOT an anchor');
  assert.equal(isRootAnchor(leaf, lookup), false, 'a leaf member is NOT an anchor');
});

test('#134 — a plain solo workspace (no parent) is its own anchor', () => {
  const solo: WaveNode = { id: 'solo' };
  assert.equal(isRootAnchor(solo, lookupOf([solo])), true);
});

test('#134 — a member with a BROKEN parent link is an anchor at its deepest resolvable ancestor', () => {
  // mid's parent is absent; mid becomes the deepest resolvable root, so mid is
  // its own anchor and leaf (which resolves to mid) is not. Mirrors the
  // walkToRootId dangling-link fallback so a delete never leaves a member unable
  // to find any anchor.
  const mid: WaveNode = { id: 'mid', parentId: 'gone-root' };
  const leaf: WaveNode = { id: 'leaf', parentId: 'mid' };
  const lookup = lookupOf([mid, leaf]);
  assert.equal(isRootAnchor(mid, lookup), true, 'mid is the deepest resolvable root');
  assert.equal(isRootAnchor(leaf, lookup), false, 'leaf resolves up to mid, not itself');
});

test('N2 — a deep chain (5 levels) still reaches the single root', () => {
  const nodes: WaveNode[] = [
    { id: 'r' },
    { id: 'n1', parentId: 'r' },
    { id: 'n2', parentId: 'n1' },
    { id: 'n3', parentId: 'n2' },
    { id: 'n4', parentId: 'n3' },
  ];
  const lookup = lookupOf(nodes);
  for (const n of nodes) assert.equal(walkToRootId(n, lookup), 'r', `${n.id} must reach root r`);
});
