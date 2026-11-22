// #512 — a verifier verdict is keyed on CONTENT (the git tree of the candidate + the trees of the upstreams it was built on), not on the commit sha.
// Pure halves: the state transitions, reconcile (resume), the deliver decision, the gate answer, the acceptance receipt. Each clause has a must-PASS and a must-FAIL arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketPatch, applyWriteBack, newState, parseState, reconcile, sameContent, stackView, type FanoutState, type Reality } from './fanout-state.ts';
import { decideDelivery, decideGate, type DecideInput } from './fanout-deliver.ts';
import { decideDeliverReceipt, decideGateAcceptance, parseReceipt } from './fanout-acceptance.ts';
import { acceptanceHash, type Acceptance } from './fanout-state.ts';

const T = '2026-11-22T10:00:00.000Z';
const A1 = 'a'.repeat(40); // the gated head
const A2 = 'b'.repeat(40); // the same content after a rebase / author rewrite
const A3 = 'c'.repeat(40); // different content
const TREE1 = '1'.repeat(40);
const TREE2 = '2'.repeat(40);
const U1 = 'd'.repeat(40);
const U2 = 'e'.repeat(40);
const UT1 = '3'.repeat(40);
const UT2 = '4'.repeat(40);

/** A gated (PASS) at A1/TREE1. */
function gated(): FanoutState {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'A', { status: 'nominated', branch: 'a', head: A1 }, T, { tree: TREE1 });
  return applyTicketPatch(s, 'A', { status: 'gated', verdict: 'pass' }, T);
}

test('state: a head set WITH a derived tree records it; a changed head with NO derived tree clears it (unknown, never the old head\'s)', () => {
  let s = gated();
  assert.equal(s.tickets.A.tree, TREE1);
  s = applyTicketPatch(s, 'A', { head: A2 }, T); // must-FAIL arm of "tree follows head": the old tree must not stay
  assert.equal(s.tickets.A.tree, null);
  s = applyTicketPatch(s, 'A', { head: A2 }, T, { tree: TREE2 });
  assert.equal(s.tickets.A.tree, TREE2);
  s = applyTicketPatch(s, 'A', { status: 'gated' }, T); // head untouched ⇒ tree untouched
  assert.equal(s.tickets.A.tree, TREE2);
  assert.equal(applyTicketPatch(gated(), 'A', { head: A1 }, T).tickets.A.tree, TREE1, 'the same sha re-set keeps its tree');
});

test('state: tree / builtOnTree are DERIVED — a patch (state set --json) cannot write them; a hand-edited file with a bad tree is refused', () => {
  assert.throws(() => applyTicketPatch(gated(), 'A', { tree: TREE2 }, T), /unknown field "tree"/);
  assert.throws(() => applyTicketPatch(gated(), 'A', { builtOnTree: {} }, T), /unknown field "builtOnTree"/);
  const raw = JSON.parse(JSON.stringify(gated()));
  raw.tickets.A.tree = 'not-a-tree';
  assert.throws(() => parseState(raw), /tree must be a full lowercase hex/);
  delete raw.tickets.A.tree; // an older state file (no field) still reads
  assert.equal(parseState(raw).tickets.A.tree, null);
});

test('sameContent: same sha, or both trees known and equal; an unknown tree never matches', () => {
  assert.ok(sameContent(A1, null, A1, null));
  assert.ok(sameContent(A1, TREE1, A2, TREE1));
  assert.ok(!sameContent(A1, TREE1, A2, TREE2), 'one changed byte');
  assert.ok(!sameContent(A1, null, A2, TREE1), 'unknown ⇒ sha-keyed ⇒ different');
  assert.ok(!sameContent(A1, TREE1, A2, undefined));
});

const realityOf = (branchHead: string, branchTree: string | null | undefined): Reality => ({ A: { branchHead, branchTree, mergedIntoTarget: false, pr: null } });

test('resume must-PASS: the branch moved to a new sha with the SAME tree ⇒ no divergence, verdict kept, only the recorded head follows', () => {
  const s = gated();
  const plan = reconcile(s, realityOf(A2, TREE1));
  assert.equal(plan.divergences.length, 0);
  assert.equal(plan.writeBack.length, 1);
  assert.deepEqual(plan.writeBack[0].patch, { head: A2, tree: TREE1 });
  const after = applyWriteBack(s, plan.writeBack, T);
  assert.deepEqual([after.tickets.A.head, after.tickets.A.verdict, after.tickets.A.status, after.tickets.A.tree], [A2, 'pass', 'gated', TREE1]);
  assert.equal(plan.tickets.A.next.action, 'merge');
});

test('resume must-FAIL: ONE changed byte (another tree) ⇒ head-moved, verdict reset; an unreadable tree ⇒ the same (sha-keyed)', () => {
  for (const tree of [TREE2, null, undefined]) {
    const s = gated();
    const plan = reconcile(s, realityOf(A3, tree));
    assert.deepEqual(plan.divergences.map((d) => d.kind), ['head-moved'], String(tree));
    const after = applyWriteBack(s, plan.writeBack, T);
    assert.deepEqual([after.tickets.A.verdict, after.tickets.A.status], ['none', 'nominated']);
    assert.deepEqual([after.tickets.A.head, after.tickets.A.tree], [A3, tree ?? null], 'the tree FOLLOWS the head in the write-back (a stale tree would later "keep" a verdict on other content)');
  }
  // the pre-review's scenario: PASS recorded on the new content, then the branch is force-pushed back to the OLD content ⇒ must be a divergence
  let s = gated();
  s = applyWriteBack(s, reconcile(s, realityOf(A3, TREE2)).writeBack, T);
  s = applyTicketPatch(s, 'A', { status: 'gated', verdict: 'pass' }, T); // plain `state set --verdict pass`: no --head, no derived tree
  assert.deepEqual(reconcile(s, realityOf('f'.repeat(40), TREE1)).divergences.map((d) => d.kind), ['head-moved'], 'content T1 is not the content the PASS was issued on (T2)');
});

test('resume must-FAIL: a verdict recorded with NO tree (older state / unreadable) is never kept by a tree it does not have', () => {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'A', { status: 'gated', branch: 'a', head: A1, verdict: 'pass' }, T); // no derived tree
  const plan = reconcile(s, realityOf(A2, TREE1));
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['head-moved']);
});

/** UP gated at U1/UT1, DEP built on it (builtOn U1 / UT1) and gated. */
function stacked(): FanoutState {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'UP', { status: 'nominated', branch: 'up', head: U1 }, T, { tree: UT1 });
  s = applyTicketPatch(s, 'UP', { status: 'gated', verdict: 'pass' }, T);
  s = applyTicketPatch(s, 'DEP', { dependsOn: ['UP'], builtOn: { UP: U1 }, branch: 'dep', head: A1, status: 'nominated' }, T, { tree: TREE1, builtOnTree: { UP: UT1 } });
  return applyTicketPatch(s, 'DEP', { status: 'gated', verdict: 'pass' }, T);
}
const depReality = (upHead: string, upTree: string | null): Reality => ({
  UP: { branchHead: upHead, branchTree: upTree, mergedIntoTarget: false, pr: null },
  DEP: { branchHead: A1, branchTree: TREE1, mergedIntoTarget: false, pr: null },
});

test('resume must-PASS: the UPSTREAM moved to a new sha with the tree the dependent was built on ⇒ no upstream-changed, verdict kept', () => {
  const plan = reconcile(stacked(), depReality(U2, UT1));
  assert.ok(!plan.divergences.some((d) => d.kind === 'upstream-changed'), JSON.stringify(plan.divergences));
  assert.equal(plan.writeBack.filter((w) => w.ticket === 'DEP').length, 0);
});

test('resume must-FAIL: ONE changed byte in the UPSTREAM tree ⇒ upstream-changed, the dependent verdict is reset', () => {
  const s = stacked();
  const plan = reconcile(s, depReality(U2, UT2));
  assert.ok(plan.divergences.some((d) => d.ticket === 'DEP' && d.kind === 'upstream-changed'));
  const after = applyWriteBack(s, plan.writeBack, T);
  assert.deepEqual([after.tickets.DEP.verdict, after.tickets.DEP.status], ['none', 'nominated']);
});

test('stack view (gate --ticket): an upstream at another sha with the built-on tree is still a candidate; another tree is `changed`', () => {
  const s = stacked();
  assert.equal(stackView(s, 'DEP')!.order, 'wait-upstream');
  const moved = applyTicketPatch(s, 'UP', { head: U2 }, T, { tree: UT1 });
  assert.equal(stackView(moved, 'DEP')!.order, 'wait-upstream', 'same tree');
  const changed = applyTicketPatch(s, 'UP', { head: U2 }, T, { tree: UT2 });
  assert.equal(stackView(changed, 'DEP')!.order, 're-gate', 'one byte');
  const unknown = applyTicketPatch(s, 'UP', { head: U2 }, T); // tree unreadable
  assert.equal(stackView(unknown, 'DEP')!.order, 're-gate', 'unknown tree ⇒ sha-keyed');
});

test('state: builtOnTree follows builtOn — re-recording a different upstream head without its tree drops the old tree', () => {
  const up2 = applyTicketPatch(stacked(), 'UP', { head: U2 }, T, { tree: UT2 });
  const s = applyTicketPatch(up2, 'DEP', { builtOn: { UP: U2 } }, T);
  assert.deepEqual(s.tickets.DEP.builtOnTree, {});
  assert.deepEqual(applyTicketPatch(s, 'DEP', { builtOn: { UP: U2 } }, T, { builtOnTree: { UP: UT2 } }).tickets.DEP.builtOnTree, { UP: UT2 });
  assert.deepEqual(applyTicketPatch(stacked(), 'DEP', { status: 'gated' }, T).tickets.DEP.builtOnTree, { UP: UT1 }, 'untouched builtOn keeps its tree');
});

test('resume must-PASS: merged at another sha with the SAME tree as the verdict ⇒ not merged-at-ungated-head; another tree ⇒ it is', () => {
  const s = gated();
  const merged = (tree: string): Reality => ({ A: { branchHead: null, mergedIntoTarget: true, pr: { state: 'MERGED', headRefOid: A2, baseRefName: 'master' }, prTree: tree } });
  assert.ok(!reconcile(s, merged(TREE1)).divergences.some((d) => d.kind === 'merged-at-ungated-head'));
  assert.ok(reconcile(s, merged(TREE2)).divergences.some((d) => d.kind === 'merged-at-ungated-head'));
});

// ── deliver decision ─────────────────────────────────────────────────────────────────────────────────────────
const pr = (head: string) => ({ state: 'OPEN' as const, baseRefName: 'master', headRefOid: head, mergeable: 'MERGEABLE' });
const dIn = (o: Partial<DecideInput> = {}): DecideInput => ({
  pr: pr(A1), checks: [{ name: 'ci', state: 'success', steps: 5 }], into: 'master', verifiedHead: A1, waitedMs: 0, noChecksGraceMs: 0, stable: true, ...o,
});

test('deliver must-PASS: PR head = another sha, same tree ⇒ merge bound to the REAL head (the --match-head-commit sha)', () => {
  const d = decideDelivery(dIn({ pr: pr(A2), headSameTree: true }));
  assert.deepEqual(d, { action: 'merge', head: A2 });
});
test('deliver must-FAIL: PR head = another sha, trees differ or unread ⇒ head-moved (the unfixed arm: same input, no tree proof)', () => {
  assert.equal((decideDelivery(dIn({ pr: pr(A3), headSameTree: false, treesDiffer: true })) as { reason?: string }).reason, 'head-moved');
  assert.match((decideDelivery(dIn({ pr: pr(A3), treesDiffer: true })) as { detail: string }).detail, /trees differ/);
  assert.equal((decideDelivery(dIn({ pr: pr(A2) })) as { reason?: string }).reason, 'head-moved', 'no tree proof = the old sha rule');
});
test('deliver: the review verdict of another sha with the same tree stands; without the proof it is a verdict-head-mismatch', () => {
  const v = { round: 1, blocking: 0, major: 0, minor: 0, head: A2 };
  assert.equal(decideDelivery(dIn({ verdict: v, verdictSameTree: true })).action, 'merge');
  assert.equal((decideDelivery(dIn({ verdict: v })) as { reason?: string }).reason, 'verdict-head-mismatch');
  assert.equal((decideDelivery(dIn({ verdict: { ...v, blocking: 1 }, verdictSameTree: true })) as { reason?: string }).reason, 'review-blocking', 'a same-tree verdict still has to be green');
});
test('deliver: already merged at another sha is accepted only with the same tree', () => {
  const merged = { ...pr(A2), state: 'MERGED' as const };
  assert.equal(decideDelivery(dIn({ pr: merged, headSameTree: true })).action, 'already-merged');
  assert.equal((decideDelivery(dIn({ pr: merged })) as { reason?: string }).reason, 'head-moved');
});

// ── gate answer ──────────────────────────────────────────────────────────────────────────────────────────────
const WF = ['on:\n  pull_request:\njobs:\n  test:\n    runs-on: x\n    steps:\n      - run: npm test\n'];
const gIn = (o: Record<string, unknown> = {}) => decideGate({ workflows: WF, pr: { headRefOid: A2 }, head: A1, checks: [{ name: 'test', state: 'success', steps: 4 }], into: 'master', prFiles: ['src/a.ts'], stable: true, ...o });
test('gate must-PASS: the PR head has another sha but the SAME tree ⇒ headMatches + ciGreenOnHead, sameTree reported', () => {
  const a = gIn({ headTree: TREE1, prTree: TREE1 });
  assert.deepEqual([a.headMatches, a.sameTree, a.ciGreenOnHead, a.fullSuite], [true, true, true, 'ci']);
  assert.match(a.detail, /same tree/);
});
test('gate must-FAIL: another sha AND another / unread tree ⇒ the CI of another head is not accepted', () => {
  for (const [headTree, prTree] of [[TREE1, TREE2], [TREE1, null], [null, TREE1], [undefined, undefined]] as const) {
    const a = gIn({ headTree, prTree });
    assert.deepEqual([a.headMatches, a.sameTree, a.ciGreenOnHead], [false, false, false], `${headTree}/${prTree}`);
  }
});
test('gate: the same sha never needs a tree (positive control: headMatches, sameTree false)', () => {
  const a = gIn({ pr: { headRefOid: A1 } });
  assert.deepEqual([a.headMatches, a.sameTree, a.ciGreenOnHead], [true, false, true]);
});

// ── acceptance receipt ───────────────────────────────────────────────────────────────────────────────────────
const FILES = { 't/x.test.js': 'f'.repeat(64) };
const ACC: Acceptance = { files: FILES, run: 'node --test t/x.test.js', hash: acceptanceHash(FILES, 'node --test t/x.test.js'), source: { branch: 'w', head: A1 }, frozenAt: T, amendments: [] };
const rcpt = (o: Record<string, unknown> = {}) => ({ head: A1, hash: ACC.hash, ok: true, tree: TREE1, ticket: 'T-1', ...o }) as { head: string; hash: string; ok: boolean; tree?: string; ticket?: string };

test('receipt must-PASS: issued for another sha with the same tree ⇒ holds; same sha ⇒ holds (control)', () => {
  assert.equal(decideDeliverReceipt(ACC, rcpt(), A2, { ticket: 'T-1', headTree: TREE1 }).ok, true);
  assert.equal(decideDeliverReceipt(ACC, rcpt(), A1, { ticket: 'T-1' }).ok, true);
});
test('receipt must-FAIL: another sha + another / unread tree ⇒ acceptance-stale; a receipt WITHOUT a tree stays head-keyed', () => {
  for (const ctx of [{ headTree: TREE2 }, { headTree: null }, {}]) {
    const r = decideDeliverReceipt(ACC, rcpt(), A2, { ticket: 'T-1', ...ctx });
    assert.deepEqual([r.ok, (r as { reason?: string }).reason], [false, 'acceptance-stale'], JSON.stringify(ctx));
  }
  const old = rcpt(); delete old.tree;
  assert.equal(decideDeliverReceipt(ACC, old, A2, { ticket: 'T-1', headTree: TREE1 }).ok, false);
});
test('receipt must-FAIL: a verdict of ANOTHER ticket is refused even on the same sha / the same tree', () => {
  for (const head of [A1, A2]) {
    const r = decideDeliverReceipt(ACC, rcpt({ ticket: 'T-9' }), head, { ticket: 'T-1', headTree: TREE1 });
    assert.deepEqual([r.ok, (r as { reason?: string }).reason], [false, 'acceptance-stale']);
    assert.match((r as { detail: string }).detail, /ticket T-9/);
  }
});
test('receipt must-FAIL: a changed frozen set / command (hash) stays acceptance-stale whatever the tree (A\'s refusal kept)', () => {
  const r = decideDeliverReceipt(ACC, rcpt({ hash: '9'.repeat(64) }), A1, { ticket: 'T-1', headTree: TREE1 });
  assert.deepEqual([r.ok, (r as { reason?: string }).reason], [false, 'acceptance-stale']);
});
test('receipt: parse accepts head-only (older) and tree/ticket forms, refuses a malformed tree', () => {
  assert.equal(parseReceipt(JSON.stringify({ head: A1, hash: ACC.hash, ok: true })).ok, true);
  assert.equal(parseReceipt(JSON.stringify(rcpt())).ok, true);
  assert.equal(parseReceipt(JSON.stringify(rcpt({ tree: 'zz' }))).ok, false);
});
test('gate receipt carries the tree of the checkout HEAD and the ticket', () => {
  const a = decideGateAcceptance(ACC, { cwdGiven: true, cwdHead: A1, head: A1, dirty: [], files: [{ path: 't/x.test.js', status: 'same' }], run: () => ({ cmd: ACC.run, exit: 0 }), cwdTree: TREE1, ticket: 'T-1' });
  assert.deepEqual(a.receipt, { head: A1, hash: ACC.hash, ok: true, tree: TREE1, ticket: 'T-1' });
});
