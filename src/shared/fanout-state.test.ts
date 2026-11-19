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
const mergedReality = { branchHead: null, mergedIntoTarget: true, pr: { state: 'MERGED' as const, headRefOid: SHA_A } };

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
  const reality: Reality = { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_A } } };
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
  const plan = reconcile(withA('merged'), { A: { branchHead: null, mergedIntoTarget: false, pr: { state: 'MERGED', headRefOid: SHA_A } } });
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
  const plan = reconcile(s, { A: { branchHead: SHA_B, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_B } } });
  assert.ok(plan.divergences.some((d) => d.kind === 'head-moved'));
  assert.equal(plan.tickets.A.next.action, 're-gate');
  const next = applyWriteBack(s, plan.writeBack, T);
  assert.deepEqual([next.tickets.A.head, next.tickets.A.verdict, next.tickets.A.status], [SHA_B, 'none', 'nominated']);
});

test('branch gone and PR closed are reported', () => {
  const gone = reconcile(withA('nominated'), { A: { branchHead: null, mergedIntoTarget: false } });
  assert.ok(gone.divergences.some((d) => d.kind === 'branch-gone'));
  const closed = reconcile(withA('nominated'), { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'CLOSED', headRefOid: SHA_A } } });
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
  const plan = reconcile(s, { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_A } }, B: { branchHead: SHA_B, mergedIntoTarget: false } });
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
  const g = (v: 'pass' | 'fail') => reconcile(withA('gated', { verdict: v }), { A: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: SHA_A } } }).tickets.A.next.action;
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
