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
import {
  walkToRootId,
  nearestOrchestratorId,
  parentOrchestratorId,
  type WaveNode,
} from './wave-run-id.ts';

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

// ─── #134 D1 — the run anchor is the NEAREST ORCHESTRATOR, not the tree root ──
//
// Topology under test: LEAD (orchestrator kind) → OPS (promoted worktree,
// canOrchestrate flag) → IMPL (plain member). The OPS is its OWN run (nested
// under the LEAD); the member obeys the OPS's run. The tree-root model (a
// walkToRootId mutant) would put the member on the LEAD's run — the exact defect
// ruling D1 forbids, and the arm each of these must redden on that mutant.

const LEAD: WaveNode = { id: 'lead', kind: 'orchestrator' };
const OPS: WaveNode = { id: 'ops', parentId: 'lead', kind: 'worktree', canOrchestrate: true };
const IMPL: WaveNode = { id: 'impl', parentId: 'ops', kind: 'worktree' };
const WAVE = lookupOf([LEAD, OPS, IMPL]);

test('#134 D1 — a member resolves to its NEAREST orchestrator (the OPS), NOT the LEAD root', () => {
  // The load-bearing D1 assertion: IMPL's run is the OPS, not the LEAD. A
  // walkToRootId mutant returns 'lead' here and this reddens.
  assert.equal(nearestOrchestratorId(IMPL, WAVE), 'ops', 'member runs on its OPS, not the LEAD');
  assert.notEqual(nearestOrchestratorId(IMPL, WAVE), 'lead', 'the tree-root model is WRONG (D1)');
});

test('#134 D1 — an orchestrator (OPS or LEAD) is its OWN run', () => {
  assert.equal(nearestOrchestratorId(OPS, WAVE), 'ops', 'the OPS is its own run');
  assert.equal(nearestOrchestratorId(LEAD, WAVE), 'lead', 'the LEAD is its own run');
});

test('#134 D1 — canOrchestrate is the CAPABILITY flag, not the kind alone (a promoted worktree)', () => {
  // The OPS has kind==='worktree' — keying on kind==='orchestrator' alone would
  // walk PAST it to the LEAD. The capability flag is what makes it the anchor.
  const kindOnlyWrong = OPS.kind === 'orchestrator';
  assert.equal(kindOnlyWrong, false, 'the OPS is NOT kind orchestrator — it is a promoted worktree');
  assert.equal(nearestOrchestratorId(IMPL, WAVE), 'ops', 'yet the member still anchors on it (via the flag)');
});

test('#134 D1 — a plain standalone workspace (no orchestrator above) is its own run', () => {
  const solo: WaveNode = { id: 'solo', kind: 'worktree' };
  assert.equal(nearestOrchestratorId(solo, lookupOf([solo])), 'solo');
  // A plain chain with NO orchestrator anywhere: each is its own run, never an
  // arbitrary ancestor.
  const a: WaveNode = { id: 'a', kind: 'worktree' };
  const b: WaveNode = { id: 'b', parentId: 'a', kind: 'worktree' };
  assert.equal(nearestOrchestratorId(b, lookupOf([a, b])), 'b', 'a plain member with no orchestrator is standalone');
});

test('#134 D1 — a broken parent link stops the walk and returns self (never throws)', () => {
  const orphanMember: WaveNode = { id: 'm', parentId: 'gone', kind: 'worktree' };
  assert.equal(nearestOrchestratorId(orphanMember, lookupOf([orphanMember])), 'm');
});

test('#134 D1 — a cycle terminates (never loops)', () => {
  const x: WaveNode = { id: 'x', parentId: 'y', kind: 'worktree' };
  const y: WaveNode = { id: 'y', parentId: 'x', kind: 'worktree' };
  const got = nearestOrchestratorId(x, lookupOf([x, y]));
  assert.ok(got === 'x' || got === 'y', `must terminate, got ${got}`);
});

// ─── parentOrchestratorId — the parent_run_id nested pointer ─────────────────

test('#134 D1 — the OPS parent_run_id points at the LEAD run (nested runs)', () => {
  assert.equal(parentOrchestratorId(OPS, WAVE), 'lead', 'OPS nests under the LEAD');
});

test('#134 D1 — a top-level orchestrator (LEAD) has NULL parent_run_id', () => {
  assert.equal(parentOrchestratorId(LEAD, WAVE), null);
});

test('#134 D1 — parentOrchestratorId walks PAST plain ancestors to the next orchestrator', () => {
  // A sub-orchestrator SUB under a plain wrapper W under the LEAD: SUB's parent
  // orchestrator is the LEAD, skipping the plain W (which has no run).
  const W: WaveNode = { id: 'w', parentId: 'lead', kind: 'worktree' };
  const SUB: WaveNode = { id: 'sub', parentId: 'w', kind: 'worktree', canOrchestrate: true };
  const lk = lookupOf([LEAD, W, SUB]);
  assert.equal(parentOrchestratorId(SUB, lk), 'lead', 'skips the plain wrapper to the LEAD');
  // And SUB is its own run (nearest orchestrator = itself).
  assert.equal(nearestOrchestratorId(SUB, lk), 'sub');
});

test('#134 D1 — parentOrchestratorId starts ABOVE self (an orchestrator does not nest under itself)', () => {
  // OPS.parentId='lead'; the walk must not return 'ops' even though OPS
  // canOrchestrate — the parent pointer is the orchestrator ABOVE it.
  assert.equal(parentOrchestratorId(OPS, WAVE), 'lead');
});

// ─── the retained tree-root walk (walkToRootId) — unchanged behaviour ────────

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
