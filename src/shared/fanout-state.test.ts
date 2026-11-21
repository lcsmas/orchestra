import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError, applyTicketPatch, applyWriteBack, newState, parseState, readState, reconcile, stackView, stateFile, updateState, writeStateAtomic,
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

test('MUST-FAIL: nominate / gate on an upstream with NO candidate (merely started) and merge before the upstream merged are REFUSED', () => {
  const s = base();
  for (const status of ['nominated', 'gated']) {
    assert.throws(() => applyTicketPatch(s, 'B', { status }, T), /not an admissible candidate — A is started/, status);
  }
  assert.throws(() => applyTicketPatch(s, 'B', { status: 'merged' }, T), /cannot be merged: upstream A not merged yet/);
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

test('mergedAccepted guard sees the NEW status: un-merging with the override still set is refused; setting both together on a non-merged ticket works', () => {
  const s = applyTicketPatch(withA('merged'), 'A', { mergedAccepted: 'why' }, T);
  assert.throws(() => applyTicketPatch(s, 'A', { status: 'started' }, T), /only applies to a merged ticket/);
  const un = applyTicketPatch(s, 'A', { status: 'started', mergedAccepted: null }, T);
  assert.deepEqual([un.tickets.A.status, un.tickets.A.mergedAccepted], ['started', null]);
  const both = applyTicketPatch(withA('nominated'), 'A', { status: 'merged', mergedAccepted: 'why' }, T);
  assert.equal(both.tickets.A.mergedAccepted, 'why');
});


// ── #506: a dependent is nominated + gated on its upstream's verified candidate ──────────────────────────────

const SHA_C = 'c'.repeat(40);
/** A nominated (or gated) with head SHA_A; B depends on A, started. */
function stacked(aStatus: 'nominated' | 'gated' = 'nominated', aExtra: Record<string, unknown> = {}): FanoutState {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'A', { branch: 'a', head: SHA_A, pr: 7, status: aStatus, ...aExtra }, T);
  return applyTicketPatch(s, 'B', { dependsOn: ['A'], frozenInterface: 'fi', branch: 'b', head: SHA_B, pr: 8, status: 'started' }, T);
}
const openPr = (head: string) => ({ branchHead: head, mergedIntoTarget: false, pr: { state: 'OPEN' as const, headRefOid: head, baseRefName: 'master' } });

test('#506 must-PASS: B is nominated, gated (pass) EARLY on A\'s candidate with builtOn = A\'s head; merged stays refused', () => {
  for (const aStatus of ['nominated', 'gated'] as const) {
    let s = stacked(aStatus, aStatus === 'gated' ? { verdict: 'pass' } : {});
    s = applyTicketPatch(s, 'B', { status: 'nominated', builtOn: { A: SHA_A } }, T);
    s = applyTicketPatch(s, 'B', { status: 'gated', verdict: 'pass' }, T);
    assert.deepEqual([s.tickets.B.status, s.tickets.B.verdict, s.tickets.B.builtOn], ['gated', 'pass', { A: SHA_A }]);
    assert.throws(() => applyTicketPatch(s, 'B', { status: 'merged' }, T), /cannot be merged: upstream A not merged yet/, 'order: merged is still refused');
    s = applyTicketPatch(s, 'A', { status: 'merged' }, T);
    assert.equal(applyTicketPatch(s, 'B', { status: 'merged' }, T).tickets.B.status, 'merged');
  }
});

test('#506 must-FAIL: early nominate/gate is refused without builtOn, with a stale builtOn, on a failing / todo / started / unknown upstream, and on a foreign builtOn key', () => {
  const s = stacked();
  assert.throws(() => applyTicketPatch(s, 'B', { status: 'nominated' }, T), /no builtOn for A/);
  assert.throws(() => applyTicketPatch(s, 'B', { status: 'nominated', builtOn: { A: SHA_C } }, T), /built on A@cccccccc but A is now at aaaaaaaa/);
  const moved = applyTicketPatch(applyTicketPatch(s, 'B', { status: 'nominated', builtOn: { A: SHA_A } }, T), 'A', { head: SHA_C, verdict: 'none' }, T);
  assert.throws(() => applyTicketPatch(moved, 'B', { status: 'gated', verdict: 'pass' }, T), /built on A@aaaaaaaa but A is now at cccccccc/, 'a fix round on A makes B\'s gate refused until B re-records');
  assert.equal(applyTicketPatch(moved, 'B', { status: 'gated', verdict: 'pass', builtOn: { A: SHA_C } }, T).tickets.B.status, 'gated', 'positive control: re-recorded');
  for (const v of ['fail', 'changes-requested'] as const) {
    const bad = stacked('gated', { verdict: v });
    assert.throws(() => applyTicketPatch(bad, 'B', { status: 'nominated', builtOn: { A: SHA_A } }, T), new RegExp(`A's verdict is ${v}`));
  }
  const started = applyTicketPatch(newState('r', { now: T }), 'A', { status: 'started', branch: 'a' }, T);
  const sb = applyTicketPatch(started, 'B', { dependsOn: ['A'], head: SHA_B, frozenInterface: 'x' }, T);
  assert.throws(() => applyTicketPatch(sb, 'B', { status: 'nominated', builtOn: {} }, T), /A is started/);
  assert.throws(() => applyTicketPatch(s, 'B', { builtOn: { Z: SHA_A } }, T), /builtOn names Z, which is not in dependsOn/);
  assert.throws(() => applyTicketPatch(s, 'B', { builtOn: { A: 'nothex' } }, T), /7-40 lowercase hex/);
});

test('#506 state document: builtOn round-trips; an older file without it parses as {}', () => {
  const s = applyTicketPatch(stacked(), 'B', { status: 'nominated', builtOn: { A: SHA_A } }, T);
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(s))).tickets.B.builtOn, { A: SHA_A });
  const raw = JSON.parse(JSON.stringify(s));
  delete raw.tickets.A.builtOn;
  assert.deepEqual(parseState(raw).tickets.A.builtOn, {});
});

test('#506 resume: a fresh stacked B reads awaiting-merge/wait-upstream (no divergence); once A merged it reads merge', () => {
  let s = stacked('gated', { verdict: 'pass' });
  s = applyTicketPatch(s, 'B', { status: 'gated', verdict: 'pass', builtOn: { A: SHA_A } }, T);
  const plan = reconcile(s, { A: openPr(SHA_A), B: openPr(SHA_B) });
  assert.deepEqual(plan.divergences, []);
  assert.deepEqual([plan.tickets.B.class, plan.tickets.B.next.action], ['awaiting-merge', 'wait-upstream']);
  const after = reconcile(applyTicketPatch(s, 'A', { status: 'merged' }, T), { A: mergedReality, B: openPr(SHA_B) });
  assert.deepEqual([after.tickets.B.class, after.tickets.B.next.action], ['awaiting-merge', 'merge']);
});

test('#506 resume MUST-FAIL: upstream moved after B\'s PASS ⇒ B reads re-gate (never awaiting-merge), verdict void on write-back; re-recording clears it', () => {
  let s = stacked('gated', { verdict: 'pass' });
  s = applyTicketPatch(s, 'B', { status: 'gated', verdict: 'pass', builtOn: { A: SHA_A } }, T);
  // fix round on A, recorded by the coordinator: new head, verdict reset
  const fixed = applyTicketPatch(s, 'A', { head: SHA_C, verdict: 'none', status: 'nominated' }, T);
  const plan = reconcile(fixed, { A: openPr(SHA_C), B: openPr(SHA_B) });
  assert.ok(plan.divergences.some((d) => d.ticket === 'B' && d.kind === 'upstream-changed'));
  assert.deepEqual([plan.tickets.B.class, plan.tickets.B.next.action], ['diverged', 're-gate']);
  const next = applyWriteBack(fixed, plan.writeBack, T);
  assert.deepEqual([next.tickets.B.status, next.tickets.B.verdict], ['nominated', 'none']);
  // the remote tip of A moved before the coordinator recorded it: still re-gate (reality's tip wins)
  const onlyRemote = reconcile(s, { A: openPr(SHA_C), B: openPr(SHA_B) });
  assert.equal(onlyRemote.tickets.B.next.action, 're-gate');
  // positive control: B re-records the new upstream head ⇒ no upstream-changed
  const healed = applyTicketPatch(next, 'B', { status: 'nominated', builtOn: { A: SHA_C } }, T);
  assert.ok(!reconcile(healed, { A: openPr(SHA_C), B: openPr(SHA_B) }).divergences.some((d) => d.kind === 'upstream-changed'));
});

test('#506 resume: an upstream that is no candidate (dropped / failed after B was recorded) flags B; a MERGED B with an open upstream is still flagged', () => {
  let s = stacked('gated', { verdict: 'pass' });
  s = applyTicketPatch(s, 'B', { status: 'nominated', builtOn: { A: SHA_A } }, T);
  const failed = applyTicketPatch(s, 'A', { verdict: 'fail' }, T);
  const p1 = reconcile(failed, { A: openPr(SHA_A), B: openPr(SHA_B) });
  assert.ok(p1.divergences.some((d) => d.ticket === 'B' && d.kind === 'nominated-before-upstream-merged'));
  assert.equal(p1.tickets.B.next.action, 'investigate');
  const mergedB = parseState({ ...JSON.parse(JSON.stringify(s)), tickets: { ...JSON.parse(JSON.stringify(s)).tickets, B: { ...JSON.parse(JSON.stringify(s)).tickets.B, status: 'merged' } } });
  assert.ok(reconcile(mergedB, { A: openPr(SHA_A), B: { branchHead: null, mergedIntoTarget: true } }).divergences.some((d) => d.ticket === 'B' && d.kind === 'nominated-before-upstream-merged'));
});

test('#506 stackView (what `fanout gate --ticket` prints): none | wait-upstream | re-gate | blocked', () => {
  let s = stacked('gated', { verdict: 'pass' });
  assert.equal(stackView(s, 'B')!.order, 'blocked', 'B has no builtOn yet');
  s = applyTicketPatch(s, 'B', { status: 'gated', verdict: 'pass', builtOn: { A: SHA_A } }, T);
  assert.deepEqual(stackView(s, 'B')!.upstreams.map((u) => [u.id, u.state]), [['A', 'candidate']]);
  assert.equal(stackView(s, 'B')!.order, 'wait-upstream');
  assert.equal(stackView(applyTicketPatch(s, 'A', { head: SHA_C }, T), 'B')!.order, 're-gate');
  assert.equal(stackView(applyTicketPatch(s, 'A', { status: 'merged' }, T), 'B')!.order, 'none');
  assert.equal(stackView(s, 'A')!.order, 'none');
  assert.equal(stackView(s, 'ghost'), null);
});

test('#506 review: an upstream that MERGED at another head than builtOn reads re-gate on resume (never merge) and `changed` in stackView; matching head stays clean', () => {
  let s = stacked('gated', { verdict: 'pass' });
  s = applyTicketPatch(s, 'B', { status: 'gated', verdict: 'pass', builtOn: { A: SHA_A } }, T);
  const done = applyTicketPatch(applyTicketPatch(s, 'A', { head: SHA_C }, T), 'A', { status: 'merged' }, T); // fix round H2 merged
  const merged2 = { branchHead: SHA_C, mergedIntoTarget: true, pr: { state: 'MERGED' as const, headRefOid: SHA_C, baseRefName: 'master' } };
  const plan = reconcile(done, { A: merged2, B: openPr(SHA_B) });
  assert.ok(plan.divergences.some((d) => d.ticket === 'B' && d.kind === 'upstream-changed'));
  assert.deepEqual([plan.tickets.B.class, plan.tickets.B.next.action], ['diverged', 're-gate']);
  assert.deepEqual(plan.writeBack.filter((w) => w.ticket === 'B'), [], 'no verdict reset: the dependent may already be re-gated');
  assert.equal(stackView(done, 'B')!.order, 're-gate');
  const healed = applyTicketPatch(done, 'B', { builtOn: { A: SHA_C } }, T); // re-recording a head (not dropping it) is allowed: deliver re-proves against the real merge
  assert.equal(reconcile(healed, { A: merged2, B: openPr(SHA_B) }).tickets.B.next.action, 'merge');
  assert.equal(stackView(healed, 'B')!.order, 'none');
  const same = applyTicketPatch(s, 'A', { status: 'merged' }, T);
  assert.equal(reconcile(same, { A: mergedReality, B: openPr(SHA_B) }).tickets.B.next.action, 'merge', 'positive control: merged at the built-on head');
});

test('#506 R2: dropping builtOn under an unchanged PASS is refused (it would read as built-after-merge and skip the content check); allowed once the verdict is voided', () => {
  let s = stacked('gated', { verdict: 'pass' });
  s = applyTicketPatch(s, 'B', { status: 'gated', verdict: 'pass', builtOn: { A: SHA_A } }, T);
  s = applyTicketPatch(s, 'A', { status: 'merged' }, T);
  assert.throws(() => applyTicketPatch(s, 'B', { builtOn: {} }, T), /cannot drop builtOn A while the resulting pass verdict stands/);
  // D1: whatever the PREVIOUS verdict — a swap pass→approve, or void-then-pass in ONE patch, also leaves a PASS without builtOn
  assert.throws(() => applyTicketPatch(s, 'B', { builtOn: {}, verdict: 'approve' }, T), /cannot drop builtOn A while the resulting approve verdict stands/);
  const none = applyTicketPatch(s, 'B', { verdict: 'none', status: 'nominated' }, T);
  assert.throws(() => applyTicketPatch(none, 'B', { builtOn: {}, verdict: 'pass', status: 'gated' }, T), /cannot drop builtOn A while the resulting pass verdict stands/);
  assert.throws(() => applyTicketPatch(none, 'B', { builtOn: {}, verdict: 'approve' }, T), /cannot drop builtOn A/);
  assert.deepEqual(applyTicketPatch(none, 'B', { builtOn: {} }, T).tickets.B.builtOn, {}, 'dropping with the verdict at none is the void step');
  assert.throws(() => applyTicketPatch(s, 'B', { builtOn: null }, T), /cannot drop builtOn A/);
  const voided = applyTicketPatch(s, 'B', { builtOn: {}, verdict: 'none', status: 'nominated' }, T);
  assert.deepEqual(voided.tickets.B.builtOn, {});
  assert.deepEqual(applyTicketPatch(s, 'B', { builtOn: { A: SHA_C } }, T).tickets.B.builtOn, { A: SHA_C }, 're-recording a head is not dropping');
});
