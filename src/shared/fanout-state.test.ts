import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError, applyTicketPatch, applyWriteBack, newState, parseState, readState, reconcile, stateFile, updateState, writeStateAtomic,
  type FanoutState, type Reality,
} from './fanout-state.ts';

const T = '2026-11-19T10:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function base(): FanoutState {
  let s = newState('run1', { now: T });
  s = applyTicketPatch(s, 'A', { status: 'started', branch: 'a' }, T);
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], frozenInterface: '#471 §Interfaces 1', status: 'started', branch: 'b' }, T);
  return s;
}
const mergedReality = { branchHead: null, mergedIntoTarget: true, pr: { state: 'MERGED' as const, headRefOid: SHA_A, baseRefName: 'master' } };

test('a dependent may START against a frozen interface', () => {
  const s = base();
  assert.equal(s.tickets.B.status, 'started');
});

test('MUST-FAIL: a dependent cannot START with an unmerged upstream and no frozen interface', () => {
  const s = applyTicketPatch(newState('r', { now: T }), 'A', { status: 'started' }, T);
  assert.throws(() => applyTicketPatch(s, 'B', { dependsOn: ['A'], status: 'started' }, T), /no frozen interface/);
});

test('MUST-FAIL: nominate / gate / merge is REFUSED before the upstream is merged', () => {
  const s = base();
  for (const status of ['nominated', 'gated', 'merged']) {
    assert.throws(() => applyTicketPatch(s, 'B', { status }, T), /not merged yet/, status);
  }
  assert.throws(() => applyTicketPatch(s, 'B', { status: 'nominated' }, T), FanoutStateError);
});

test('nominate is accepted once the upstream is merged (positive control)', () => {
  let s = base();
  s = applyTicketPatch(s, 'A', { status: 'merged' }, T);
  s = applyTicketPatch(s, 'B', { status: 'nominated', head: SHA_B }, T);
  assert.equal(s.tickets.B.status, 'nominated');
});

test('an unknown upstream counts as not merged', () => {
  const s = newState('r', { now: T });
  assert.throws(() => applyTicketPatch(s, 'B', { dependsOn: ['ghost'], status: 'nominated' }, T), /ghost/);
});

test('MUST-FAIL: unknown field refused in a patch and in a stored document', () => {
  const s = base();
  assert.throws(() => applyTicketPatch(s, 'A', { colour: 'red' }, T), /unknown field "colour"/);
  const raw = JSON.parse(JSON.stringify(s));
  raw.tickets.A.extra = 1;
  assert.throws(() => parseState(raw), /unknown field "extra"/);
  const raw2 = JSON.parse(JSON.stringify(s));
  raw2.surprise = true;
  assert.throws(() => parseState(raw2), /unknown field "surprise"/);
});

test('self dependency and cycle refused', () => {
  const s = base();
  assert.throws(() => applyTicketPatch(s, 'A', { dependsOn: ['A'] }, T), /itself/);
  assert.throws(() => applyTicketPatch(s, 'A', { dependsOn: ['B'] }, T), /cycle/);
});

test('bad enum / pr / run id refused (path traversal included)', () => {
  const s = base();
  assert.throws(() => applyTicketPatch(s, 'A', { status: 'done' }, T), /status must be one of/);
  assert.throws(() => applyTicketPatch(s, 'A', { pr: -3 }, T), /positive integer/);
  assert.throws(() => stateFile('/h', '../x'), /unsafe run id/);
  assert.throws(() => stateFile('/h', 'a/b'), /unsafe run id/);
  assert.equal(stateFile('/h', 'run-1'), path.join('/h', 'fanout', 'run-1', 'state.json'));
});

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-state-'));
}

test('atomic rewrite: round-trips, leaves no tmp, and a refused write leaves the old file byte-exact', () => {
  const dir = scratch();
  try {
    const file = stateFile(dir, 'run1');
    writeStateAtomic(file, base());
    assert.deepEqual(readState(file), base());
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
    const before = fs.readFileSync(file);
    const bad = JSON.parse(JSON.stringify(base()));
    bad.tickets.A.junk = 1;
    assert.throws(() => writeStateAtomic(file, bad), /unknown field/);
    assert.ok(before.equals(fs.readFileSync(file)));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updateState: a held lock blocks a second writer; a stale lock is broken', () => {
  const dir = scratch();
  try {
    const file = stateFile(dir, 'run1');
    writeStateAtomic(file, base());
    fs.writeFileSync(`${file}.lock`, '');
    assert.throws(() => updateState(file, (c) => c!, { waitMs: 60 }), /locked/);
    fs.utimesSync(`${file}.lock`, new Date(0), new Date(0));
    updateState(file, (c) => applyTicketPatch(c!, 'A', { status: 'nominated', head: SHA_A }, T));
    assert.equal(readState(file)!.tickets.A.status, 'nominated');
    assert.ok(!fs.existsSync(`${file}.lock`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── reconcile ────────────────────────────────────────────────────────────────────────────────────────────

function withA(status: 'nominated' | 'gated' | 'merged', extra: Record<string, unknown> = {}): FanoutState {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'A', { branch: 'a', head: SHA_A, pr: 7, status: 'started' }, T);
  return applyTicketPatch(s, 'A', { status, ...extra }, T);
}

test('MUST-FAIL: state says merged, git says not → divergence reported, and dependents are NOT released', () => {
  let s = withA('merged');
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], status: 'todo' }, T);
  const reality: Reality = { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_A, baseRefName: 'master' } } };
  const plan = reconcile(s, reality);
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['state-merged-reality-not']);
  assert.equal(plan.tickets.A.next.action, 'investigate');
  assert.equal(plan.tickets.B.next.action, 'wait-upstream', 'a false merge claim must not unblock B');
  assert.deepEqual(plan.writeBack, [], 'a state-ahead claim is never auto-corrected');
});

test('state merged and reality merged → no divergence, dependent startable (positive control)', () => {
  let s = withA('merged');
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], status: 'todo' }, T);
  const plan = reconcile(s, { A: mergedReality });
  assert.deepEqual(plan.divergences, []);
  assert.equal(plan.tickets.B.next.action, 'start');
});

test('squash merge: PR MERGED with the branch gone and not an ancestor is still merged', () => {
  const plan = reconcile(withA('merged'), { A: { branchHead: null, mergedIntoTarget: false, pr: { state: 'MERGED', headRefOid: SHA_A, baseRefName: 'master' } } });
  assert.deepEqual(plan.divergences, []);
});

test('reality merged, state not → divergence + write-back to merged', () => {
  const s = withA('nominated');
  const plan = reconcile(s, { A: mergedReality });
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['reality-merged-state-not']);
  assert.equal(plan.tickets.A.next.action, 'record-merged');
  const next = applyWriteBack(s, plan.writeBack, T);
  assert.equal(next.tickets.A.status, 'merged');
  assert.equal(next.reconciledAt, T);
});

test('head moved: reported, verdict reset on write-back, gated → nominated', () => {
  const s = withA('gated', { verdict: 'pass' });
  const plan = reconcile(s, { A: { branchHead: SHA_B, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_B, baseRefName: 'master' } } });
  assert.ok(plan.divergences.some((d) => d.kind === 'head-moved'));
  assert.equal(plan.tickets.A.next.action, 're-gate');
  const next = applyWriteBack(s, plan.writeBack, T);
  assert.deepEqual([next.tickets.A.head, next.tickets.A.verdict, next.tickets.A.status], [SHA_B, 'none', 'nominated']);
});

test('branch gone and PR closed are reported', () => {
  const gone = reconcile(withA('nominated'), { A: { branchHead: null, mergedIntoTarget: false } });
  assert.ok(gone.divergences.some((d) => d.kind === 'branch-gone'));
  const closed = reconcile(withA('nominated'), { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'CLOSED', headRefOid: SHA_A, baseRefName: 'master' } } });
  assert.ok(closed.divergences.some((d) => d.kind === 'pr-closed-unmerged'));
});

test('MUST-FAIL: an unreadable reality is UNKNOWN — never "branch gone", never "not merged"', () => {
  const plan = reconcile(withA('merged'), { A: { error: 'git ls-remote a: exit 128' } });
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['reality-unreadable']);
});

test('a nominated ticket whose upstream reality contradicts is flagged', () => {
  let s = withA('merged');
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], branch: 'b', head: SHA_B, status: 'started' }, T);
  // B was recorded nominated while A was merged; reality says A is NOT merged.
  s = applyTicketPatch(s, 'B', { status: 'nominated' }, T);
  const plan = reconcile(s, { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_A, baseRefName: 'master' } }, B: { branchHead: SHA_B, mergedIntoTarget: false } });
  assert.ok(plan.divergences.some((d) => d.ticket === 'B' && d.kind === 'nominated-before-upstream-merged'));
});

test('classification table: todo/started/nominated/gated verdicts', () => {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'U', { status: 'started', branch: 'u' }, T);
  s = applyTicketPatch(s, 'W', { dependsOn: ['U'] }, T);
  s = applyTicketPatch(s, 'F', { dependsOn: ['U'], frozenInterface: 'ref' }, T);
  s = applyTicketPatch(s, 'S', {}, T);
  const plan = reconcile(s, {});
  assert.deepEqual(Object.fromEntries(Object.entries(plan.tickets).map(([k, v]) => [k, v.next.action])), {
    U: 'continue', W: 'wait-upstream', F: 'start-against-frozen-interface', S: 'start',
  });
  const g = (v: 'pass' | 'fail') => reconcile(withA('gated', { verdict: v }), { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_A, baseRefName: 'master' } } }).tickets.A.next.action;
  assert.equal(g('pass'), 'merge');
  assert.equal(g('fail'), 'fix-and-renominate');
});

test('a STARTED branch cut from the target tip is not "merged" (ancestry counts only once nominated); a moving started head is not a divergence', () => {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'A', { branch: 'a', head: SHA_A, status: 'started' }, T);
  const fresh = reconcile(s, { A: { branchHead: SHA_B, mergedIntoTarget: true } });
  assert.deepEqual(fresh.divergences, []);
  assert.equal(fresh.tickets.A.next.action, 'continue');
  // same reality once nominated IS merged evidence
  const nom = applyTicketPatch(s, 'A', { status: 'nominated' }, T);
  assert.deepEqual(reconcile(nom, { A: { branchHead: SHA_A, mergedIntoTarget: true } }).divergences.map((d) => d.kind), ['reality-merged-state-not']);
});

test('pre-review BLOCKING: a MERGED PR + a branch still on a different head is merged, never demoted by the head-moved write-back', () => {
  const s = withA('gated', { verdict: 'pass' });
  const plan = reconcile(s, { A: { branchHead: SHA_B, mergedIntoTarget: false, pr: { state: 'MERGED', headRefOid: SHA_A, baseRefName: 'master' } } });
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['reality-merged-state-not']);
  assert.equal(applyWriteBack(s, plan.writeBack, T).tickets.A.status, 'merged');
});

test('pre-review MAJOR: a short recorded head is a prefix of the remote head, not a moved head; a bad head/branch is refused', () => {
  const s = withA('gated', { verdict: 'pass', head: SHA_A.slice(0, 7) });
  assert.deepEqual(reconcile(s, { A: { branchHead: SHA_A, mergedIntoTarget: false } }).divergences, []);
  for (const head of ['--help', '-x', 'ZZZ', 'abc']) assert.throws(() => applyTicketPatch(s, 'A', { head }, T), /head/, head);
  for (const branch of ['feat/*', '-x', 'a..b', 'a b']) assert.throws(() => applyTicketPatch(s, 'A', { branch }, T), /branch/, branch);
});

test('pre-review MAJOR: stale plan — a ticket changed after the read is not overwritten by the write-back', () => {
  const s = withA('nominated');
  const plan = reconcile(s, { A: mergedReality });
  const changed = applyTicketPatch(s, 'A', { head: SHA_B }, '2026-11-19T10:00:05.000Z'); // coordinator wrote in between
  assert.equal(applyWriteBack(changed, plan.writeBack, T).tickets.A.status, 'nominated');
});

test('review MAJOR 1: a PR MERGED into a NON-target base is not merged on the target — no write-back, dependent stays blocked', () => {
  let s = withA('nominated');
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], status: 'todo' }, T);
  const plan = reconcile(s, { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'MERGED', headRefOid: SHA_A, baseRefName: 'feature-upstream' } } });
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['pr-merged-other-base']);
  assert.deepEqual(plan.writeBack, []);
  assert.equal(plan.tickets.B.next.action, 'wait-upstream');
  // positive control: same PR into the target IS merged
  const ok = reconcile(s, { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'MERGED', headRefOid: SHA_A, baseRefName: 'master' } } });
  assert.equal(ok.writeBack[0].patch.status, 'merged');
  // and a state `merged` backed only by an other-base PR is a divergence
  assert.ok(reconcile(withA('merged'), { A: { branchHead: null, mergedIntoTarget: false, pr: { state: 'MERGED', headRefOid: SHA_A, baseRefName: 'feature-upstream' } } }).divergences.some((d) => d.kind === 'state-merged-reality-not'));
});

test('review MINOR 2: merged at a head the verdict did not cover is a divergence', () => {
  const s = withA('gated', { verdict: 'pass' });
  const plan = reconcile(s, { A: { branchHead: SHA_B, mergedIntoTarget: true, pr: { state: 'MERGED', headRefOid: SHA_B, baseRefName: 'master' } } });
  assert.deepEqual(plan.divergences.map((d) => d.kind), ['reality-merged-state-not', 'merged-at-ungated-head']);
  assert.equal(plan.tickets.A.next.action, 'investigate');
  assert.deepEqual(reconcile(s, { A: { branchHead: SHA_A, mergedIntoTarget: true, pr: { state: 'MERGED', headRefOid: SHA_A, baseRefName: 'master' } } }).divergences.map((d) => d.kind), ['reality-merged-state-not']);
});

test('review MINOR 3: nominated|gated or a pass/approve verdict without a recorded head is refused', () => {
  const s = applyTicketPatch(newState('r', { now: T }), 'C', { branch: 'c', status: 'started' }, T);
  assert.throws(() => applyTicketPatch(s, 'C', { status: 'gated' }, T), /needs a recorded head/);
  assert.throws(() => applyTicketPatch(s, 'C', { status: 'nominated' }, T), /needs a recorded head/);
  assert.throws(() => applyTicketPatch(s, 'C', { verdict: 'pass' }, T), /needs a recorded head/);
  assert.equal(applyTicketPatch(s, 'C', { status: 'nominated', head: SHA_A }, T).tickets.C.status, 'nominated');
});

const mergedAt = (sha: string) => ({ A: { branchHead: sha, mergedIntoTarget: true, pr: { state: 'MERGED' as const, headRefOid: sha, baseRefName: 'master' } } });

test('follow-up MINOR 1: merged-at-ungated-head persists across resumes, withholds dependents, and clears only when the merged head is recorded', () => {
  let s = withA('gated', { verdict: 'pass' });
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], status: 'todo' }, T);
  const p1 = reconcile(s, mergedAt(SHA_B));
  assert.ok(p1.divergences.some((d) => d.kind === 'merged-at-ungated-head'));
  assert.equal(p1.tickets.B.next.action, 'wait-upstream', 'dependents wait for the re-gate');
  assert.deepEqual(p1.writeBack, [], 'the merge is NOT recorded, so the divergence cannot vanish');
  const s2 = applyWriteBack(s, p1.writeBack, '2026-11-19T11:00:00.000Z');
  assert.ok(reconcile(s2, mergedAt(SHA_B)).divergences.some((d) => d.kind === 'merged-at-ungated-head'), 'resume 2 still reports it');
  // a `merged` ticket with the stale verdict/head is caught too
  const asMerged = applyTicketPatch(s, 'A', { status: 'merged' }, T);
  assert.ok(reconcile(asMerged, mergedAt(SHA_B)).divergences.some((d) => d.kind === 'merged-at-ungated-head'));
  // clears once the coordinator records the merged head after re-gating
  const fixed = applyTicketPatch(asMerged, 'A', { head: SHA_B }, T);
  const p3 = reconcile(fixed, mergedAt(SHA_B));
  assert.deepEqual(p3.divergences, []);
  assert.equal(p3.tickets.B.next.action, 'start');
});

test('follow-up MINOR 2: mergedAccepted overrides a non-target-base merge that later squash-landed; only on a merged ticket', () => {
  const other = { A: { branchHead: null, mergedIntoTarget: false, pr: { state: 'MERGED' as const, headRefOid: SHA_A, baseRefName: 'U' } } };
  let s = withA('merged');
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], status: 'todo' }, T);
  const without = reconcile(s, other);
  assert.ok(without.divergences.length > 0);
  assert.equal(without.tickets.B.next.action, 'wait-upstream');
  const accepted = applyTicketPatch(s, 'A', { mergedAccepted: 'landed via U squash in #123' }, T);
  const plan = reconcile(accepted, other);
  assert.deepEqual(plan.divergences, []);
  assert.equal(plan.tickets.B.next.action, 'start');
  assert.throws(() => applyTicketPatch(withA('nominated'), 'A', { mergedAccepted: 'x' }, T), /only applies to a merged ticket/);
  assert.throws(() => applyTicketPatch(s, 'A', { mergedAccepted: '' }, T), /non-empty/);
  assert.throws(() => parseState({ ...JSON.parse(JSON.stringify(s)), tickets: { A: { ...s.tickets.A, mergedAccepted: 5 } } }), /mergedAccepted/);
});
