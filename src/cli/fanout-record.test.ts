// #589 (I4, switch seatRecords=on) — the reviewer RECORDS its verdict and findings; gate and deliver accept no other source. Every arm drives the production path:
// `fanout record`, `state set`, `deliver`, `gate`, `closeout`, `resume`, `state show`, and the bus `send --type worker_done`.
// must-PASS: verdict recorded by the reviewer → delivered · MAJOR → refused, then delivered after the reviewer closes it on a later head · a `--decide` with a reason → delivered and listed.
// must-FAIL: recorded by the coordinator / the implementer / another ticket's reviewer · another head · --no-review-gate · a typed verdict file · "fixed" by the coordinator · a blank decision reason.
// Mutants of every clause: scripts/e2e-fanout-record.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { fanoutCompletionRefusal, runRecord, RECORD_USAGE } from './fanout-record.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';
import { runCloseout } from './fanout-closeout.ts';
import { deliver, realDeps, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { gatePr, type GateOpts } from './fanout-gate.ts';
import { verbSend, type BusVerbCtx } from './bus-verbs.ts';
import * as bus from '../main/bus.ts';
import * as busRuns from '../main/bus-runs.ts';
import { withReceipt } from '../main/bus-receipts.ts';
import { applyTicketPatch, newState, readState, setPlan, stateFile, switchesOf, writeStateAtomic, type FanoutState, type TicketState } from '../shared/fanout-state.ts';
import { renderBriefOf } from '../shared/fanout-review.ts';
import { recordReview, recordedVerdictOf, reviewCounts, reviewerDoneRefusal, unrecordedReviewers } from '../shared/fanout-record.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });
/** a runner that knows the tree of a sha: tree-<first char>, or a map */
const trees = (m: Record<string, string>): Runner => (cmd, args) => (cmd === 'git' && args[0] === 'rev-parse' ? (m[args[3].replace(/\^\{tree\}$/, '')] ? { code: 0, stdout: `${m[args[3].replace(/\^\{tree\}$/, '')]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }) : { code: 1, stdout: '', stderr: 'offline' });
const TREE_A = '1'.repeat(40);
const TREE_B = '2'.repeat(40);

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-rec-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const envOf = (home: string, who: string): NodeJS.ProcessEnv => ({ ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: who });
/** the host vouched this session (index.ts `settleHostIdentity` for `record`): the tests pass what the host would say */
const HOST: IdentityResolution = { source: 'host', runId: 'r1', generation: null };
const depsOf = (home: string, who: string, runner: Runner = offline, stdin = '', identity: IdentityResolution | null = HOST): FanoutDeps => ({ env: envOf(home, who), cwd: home, runner, now: () => NOW, readStdin: () => stdin, identity });
const brief = (n: number, kind: 'spawn' | 'wake' | 'replace', head: string, reviewer: string) => ({ n, kind, head, base: null, hash: String(n).padStart(64, '0'), text: 'brief', reviewer, at: NOW });
const reviewOf = (id: string, name: string, head: string) => ({ reviewer: { id, name, at: NOW }, head, base: null, briefs: [brief(1, 'spawn', head, id)] });

/** A run `r1` (coordinator ws r1) with seatRecords chosen, T1 nominated at A (reviewer rev1, implementer impl1), T2 nominated at C (reviewer rev2). */
function seed(home: string, o: { switches?: Record<string, string>; reviewers?: boolean } = {}): FanoutState {
  let s = newState('r1', { now: NOW, switches: { seatRecords: 'on', ...(o.switches ?? {}) } as never });
  if (switchesOf(s).seatRecords === 'on') s = setPlan(s, ['T1', 'T2'], 'declare', NOW); // #587: a run that records declares its tickets before the first spawn
  s = applyTicketPatch(s, 'T2', { dependsOn: [] }, NOW);
  s = applyTicketPatch(s, 'T1', { dependsOn: [], status: 'nominated', branch: 't1', head: A, implementer: 'impl1' }, NOW);
  s = applyTicketPatch(s, 'T2', { status: 'nominated', branch: 't2', head: C }, NOW);
  if (o.reviewers !== false) {
    s = { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, review: reviewOf('rev1', 'review-T1', A) }, T2: { ...s.tickets.T2, review: reviewOf('rev2', 'review-T2', C) } } };
  }
  writeStateAtomic(stateFile(home, 'r1'), s);
  return s;
}
const load = (home: string): FanoutState => readState(stateFile(home, 'r1'))!;
const T = (home: string, id = 'T1'): TicketState => load(home).tickets[id];
const rec = (home: string, who: string, ticket: string, head: string, verdict: string, json: unknown, runner: Runner = offline) =>
  runRecord([ticket, '--run', 'r1', '--head', head, '--verdict', verdict, '--json', '-'], depsOf(home, who, runner, typeof json === 'string' ? json : JSON.stringify(json)));
const MAJOR = (id = 'F1') => ({ findings: { [id]: { severity: 'MAJOR', evidence: 'argued', text: 'the retry loop never ends when the server answers 429' } } });
const setT = (home: string, who: string, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', ...a], depsOf(home, who));
const refused = (r: { code: number; stderr: string }, name: string, code = 2): void => { assert.equal(r.code, code, r.stderr); assert.ok(r.stderr.trimStart().startsWith(`[${name}]`), `starts with [${name}]: ${r.stderr}`); };

function withEnv<T2>(home: string, fn: () => T2): T2 {
  const prev = { h: process.env.ORCHESTRA_HOME, w: process.env.ORCHESTRA_WS_ID };
  process.env.ORCHESTRA_HOME = home; process.env.ORCHESTRA_WS_ID = 'r1';
  const restore = (): void => { for (const [k, v] of [['ORCHESTRA_HOME', prev.h], ['ORCHESTRA_WS_ID', prev.w]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const r = fn(); if (r instanceof Promise) return r.finally(restore) as T2; restore(); return r; } catch (e) { restore(); throw e; }
}

// ── the record ─────────────────────────────────────────────────────────────────────────────────────────────

test('record must-PASS: the recorded reviewer records approve for the head it read — stored with its head, tree, time; counts DERIVED; `state show` lists it', (t) => {
  const home = mkHome(t);
  seed(home);
  const r = rec(home, 'rev1', 'T1', A, 'approve', { findings: { F1: { severity: 'MINOR', evidence: 'argued', text: 'a comment is stale in the retry helper' } } }, trees({ [A]: TREE_A }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /T1: review 1 recorded by rev1 on aaaaaaaaaaaa: approve — 0 BLOCKING \/ 0 MAJOR \/ 1 MINOR open \(F1\)/);
  const t1 = T(home);
  assert.deepEqual(t1.reviews, [{ n: 1, reviewer: 'rev1', head: A, tree: TREE_A, verdict: 'approve', findings: ['F1'], closed: [], at: NOW }]);
  assert.deepEqual({ by: t1.findings.F1.by, raisedOn: t1.findings.F1.raisedOn, text: t1.findings.F1.text, severity: t1.findings.F1.severity, evidence: t1.findings.F1.evidence }, { by: 'rev1', raisedOn: A, text: 'a comment is stale in the retry helper', severity: 'MINOR', evidence: 'argued' });
  assert.deepEqual(reviewCounts(t1, A), { blocking: 0, major: 0, minor: 1, open: ['F1'] });
  assert.equal(t1.verdict, 'approve', 'the ticket verdict follows a record on its own head');
  const shown = runFanout(['state', 'show', '--run', 'r1'], depsOf(home, 'r1')).stdout;
  assert.match(shown, /recorded reviews \(#589\):\n/);
  assert.match(shown, /\n {2}T1 {2}round 1 by rev1 on aaaaaaaa: approve — 0 BLOCKING \/ 0 MAJOR \/ 1 MINOR open \(F1\)\n/);
  assert.match(shown, /\n {2}T2 {2}reviewer review-T2 \(rev2\): NO verdict recorded yet\n/);
  assert.equal(JSON.parse(JSON.stringify(t1)).reviews.length, 1, 'counts are not stored typed');
  assert.ok(!('blocking' in (t1.reviews![0] as object)));
});

test('record must-FAIL [approve-open-finding] / [changes-no-finding]: approve with an open BLOCKING|MAJOR is refused (nothing written); changes-requested needs one; minorPolicy=spec: a blocking MINOR holds the approve too', (t) => {
  const home = mkHome(t);
  seed(home);
  const before = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  const a = rec(home, 'rev1', 'T1', A, 'approve', MAJOR());
  refused(a, 'approve-open-finding');
  assert.match(a.stderr, /F1 MAJOR/);
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), before, 'a refusal writes nothing');
  refused(rec(home, 'rev1', 'T1', A, 'approve', { findings: { F2: { severity: 'BLOCKING', evidence: 'measured', text: 'x'.repeat(20) } } }), 'approve-open-finding');
  refused(rec(home, 'rev1', 'T1', A, 'changes-requested', {}), 'changes-no-finding');
  refused(rec(home, 'rev1', 'T1', A, 'changes-requested', { findings: { F3: { severity: 'MINOR', evidence: 'argued', text: 'a nit about naming' } } }), 'changes-no-finding');
  const ok = rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR());
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(reviewCounts(T(home), A), { blocking: 0, major: 1, minor: 0, open: ['F1'] });
  // minorPolicy=spec: a MINOR quoting the ticket's spec blocks like a MAJOR — approve is refused while it is open
  const home2 = mkHome(t);
  const s0 = seed(home2, { switches: { minorPolicy: 'spec', acceptance: 'off' } });
  const spec = 'The retry loop must stop after five attempts and report the last error.';
  writeStateAtomic(stateFile(home2, 'r1'), { ...s0, tickets: { ...s0.tickets, T1: { ...s0.tickets.T1, spec: 'spec.md', specText: spec } } });
  const sp = { findings: { S1: { severity: 'MINOR', evidence: 'argued', text: 'it never stops', specSentence: 'The retry loop must stop after five attempts and report the last error.' } } };
  refused(rec(home2, 'rev1', 'T1', A, 'approve', sp), 'approve-open-finding');
  assert.equal(rec(home2, 'rev1', 'T1', A, 'changes-requested', sp).code, 0);
});

test('record must-FAIL [record-not-reviewer]: the coordinator, the implementer, another ticket\'s reviewer, an unidentified caller', (t) => {
  const home = mkHome(t);
  seed(home);
  for (const who of ['r1', 'impl1', 'rev2', 'nobody']) {
    const r = rec(home, who, 'T1', A, 'approve', {});
    refused(r, 'record-not-reviewer');
    assert.match(r.stderr, /only T1's recorded reviewer \(review-T1, rev1\) records its verdict/);
  }
  assert.match(rec(home, 'rev2', 'T1', A, 'approve', {}).stderr, /the recorded reviewer of another ticket/);
  const none = runRecord(['T1', '--run', 'r1', '--head', A, '--verdict', 'approve', '--json', '-'], { ...depsOf(home, 'x', offline, '{}'), env: { ORCHESTRA_HOME: home } });
  refused(none, 'record-not-reviewer');
  assert.equal(T(home).reviews, undefined, 'nothing recorded by anyone else');
});

test('record must-FAIL [record-wrong-ticket]: a ticket with no recorded reviewer / an unknown ticket; [record-off]: seatRecords off', (t) => {
  const home = mkHome(t);
  seed(home, { reviewers: false });
  refused(rec(home, 'rev1', 'T1', A, 'approve', {}), 'record-wrong-ticket');
  refused(rec(home, 'rev1', 'T9', A, 'approve', {}), 'record-wrong-ticket');
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  const r = rec(off, 'rev1', 'T1', A, 'approve', {});
  refused(r, 'record-off');
  assert.equal(T(off).reviews, undefined);
});

test('record must-FAIL [record-head-mismatch]: a verdict on another head than the one the reviewer was briefed on; a woken reviewer records the NEW head, not the old one', (t) => {
  const home = mkHome(t);
  seed(home);
  const r = rec(home, 'rev1', 'T1', B, 'approve', {});
  refused(r, 'record-head-mismatch');
  assert.match(r.stderr, /is not the head you were briefed to read \(aaaaaaaaaaaa\)/);
  refused(rec(home, 'rev1', 'T1', 'zz', 'approve', {}), 'record-head-mismatch');
  // the coordinator wakes the reviewer on B (#588 appends the brief): A is no longer the head it speaks about
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
  refused(rec(home, 'rev1', 'T1', A, 'approve', {}), 'record-head-mismatch');
  assert.equal(rec(home, 'rev1', 'T1', B, 'approve', {}).code, 0);
  assert.equal(T(home).reviews![0].head, B);
  // a short sha of the briefed head is the same head; it is stored in full
  const home2 = mkHome(t);
  seed(home2);
  assert.equal(rec(home2, 'rev1', 'T1', A.slice(0, 10), 'approve', {}).code, 0);
  assert.equal(T(home2).reviews![0].head, A);
});

test('record must-FAIL [record-final] (#672): a second record by the same reviewer on the SAME head (approve then changes-requested) is refused, nothing written; the next head records normally', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}).code, 0);
  const r = rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR());
  refused(r, 'record-final');
  assert.match(r.stderr, /already recorded review 1 \(approve\) on aaaaaaaaaaaa/);
  assert.equal(T(home).reviews!.length, 1);
  assert.equal(T(home).verdict, 'approve');
  assert.equal(T(home).findings.F1, undefined, 'the refused record raised nothing');
  // the coordinator wakes the reviewer on B: the new finding goes on the next head
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
  assert.equal(rec(home, 'rev1', 'T1', B, 'changes-requested', MAJOR()).code, 0);
  assert.equal(T(home).reviews!.length, 2);
});

test('record must-FAIL: bad verdict / malformed json / a finding the state\'s own rules refuse / a finding id already recorded', (t) => {
  const home = mkHome(t);
  seed(home);
  refused(rec(home, 'rev1', 'T1', A, 'lgtm', {}), 'record-verdict');
  refused(rec(home, 'rev1', 'T1', A, 'approve', 'not json'), 'record-json');
  refused(rec(home, 'rev1', 'T1', A, 'approve', { blocking: 0 }), 'record-json');
  refused(rec(home, 'rev1', 'T1', A, 'approve', { findings: { F1: { severity: 'MINOR', text: 'x' } } }), 'record-json');
  refused(rec(home, 'rev1', 'T1', A, 'approve', { findings: { F1: { severity: 'MINOR', evidence: 'argued', text: 'a nit', by: 'rev9' } } }), 'record-json');
  refused(rec(home, 'rev1', 'T1', A, 'approve', { findings: { F1: { severity: 'MINOR', evidence: 'argued', text: '  ' } } }), 'record-json');
  const bad = rec(home, 'rev1', 'T1', A, 'changes-requested', { findings: { F1: { severity: 'MAJOR', evidence: 'argued', text: 'a bad thing', specSentence: 'not in any spec at all, really' } } });
  assert.equal(bad.code, 1, bad.stderr);
  assert.match(bad.stderr, /specSentence is not a literal sentence/);
  const noRep = rec(home, 'rev1', 'T1', A, 'approve', { findings: { F1: { severity: 'MINOR', evidence: 'measured', text: 'a measured one with no report' } } });
  assert.match(noRep.stderr, /needs report/);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
  refused(rec(home, 'rev1', 'T1', B, 'changes-requested', MAJOR()), 'finding-exists');
});

test('record: a record is in the state the moment it returns; two reviewers\' records on two tickets do not touch each other', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  assert.equal(rec(home, 'rev2', 'T2', C, 'approve', {}).code, 0);
  assert.equal(T(home, 'T1').reviews!.length, 1);
  assert.equal(T(home, 'T2').reviews!.length, 1);
  assert.deepEqual(Object.keys(T(home, 'T2').findings), []);
});

// ── "fixed": the reviewer, on a later head it read ───────────────────────────────────────────────────────────

/** T1 reviewed at A (MAJOR F1, changes-requested), then the ticket moved to B and the reviewer was woken there. */
function round2(home: string): void {
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
}

test('#674 (M28): across a same-tree rebase two records exist on two heads — the verdict read for the new head is the LATEST one (approve, MAJOR fixed), not the first (changes-requested, MAJOR open)', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR(), trees({ [A]: TREE_A })).code, 0);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
  assert.equal(rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] }, trees({ [B]: TREE_A })).code, 0); // B is a rebase of A: the SAME tree
  const r = recordedVerdictOf(load(home), 'T1', B, TREE_A);
  assert.ok(r.ok && r.recorded.round === 2 && r.recorded.verdict === 'approve' && r.recorded.major === 0, JSON.stringify(r));
});

test('fixed must-PASS: the reviewer closes its MAJOR on a later head it read — settled + fixedBy written, the counts fall to 0, approve accepted', (t) => {
  const home = mkHome(t);
  round2(home);
  const r = rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] });
  assert.equal(r.code, 0, r.stderr);
  const f = T(home).findings.F1;
  assert.equal(f.settled?.how, 'fixed');
  assert.equal(f.settled?.ref, B);
  assert.deepEqual({ ...f.fixedBy, at: undefined }, { by: 'rev1', head: B, at: undefined });
  assert.deepEqual(reviewCounts(T(home), B), { blocking: 0, major: 0, minor: 0, open: [] });
  assert.deepEqual(reviewCounts(T(home), A), { blocking: 0, major: 1, minor: 0, open: ['F1'] }, 'the verdict of the OLD head still says what it said');
  assert.match(r.stdout, /raised 0, closed 1/);
});

test('fixed must-FAIL: [fixed-same-head] the head it was raised on · [fixed-not-open] unknown / already closed · [fixed-by-non-reviewer] a finding no reviewer of the ticket raised · approve while another stays open', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', { findings: { ...MAJOR().findings, F2: { severity: 'MAJOR', evidence: 'argued', text: 'a second real problem' } } }).code, 0);
  const s0 = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s0, tickets: { ...s0.tickets, T1: { ...s0.tickets.T1, review: { ...s0.tickets.T1.review!, reviewer: { id: 'rev1b', name: 'review-T1-2', at: NOW }, briefs: [...s0.tickets.T1.review!.briefs, brief(2, 'replace', A, 'rev1b')] } } } });
  refused(rec(home, 'rev1b', 'T1', A, 'changes-requested', { fixed: ['F1'] }), 'fixed-same-head'); // a replacement on the SAME head cannot close what was raised on it
  writeStateAtomic(stateFile(home, 'r1'), s0);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] }, findings: { ...s.tickets.T1.findings, LEGACY: { severity: 'MAJOR' } } } } });
  refused(rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['NOPE'] }), 'fixed-not-open');
  const byTyped = rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['F1', 'LEGACY'] });
  refused(byTyped, 'fixed-by-non-reviewer');
  assert.match(byTyped.stderr, /LEGACY was not raised by a reviewer of T1 \(by: nobody — typed state\)/);
  // only F1 is closed on B: F2 (raised at A by the same reviewer) stays open, so approve is refused
  refused(rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] }), 'approve-open-finding');
  assert.equal(rec(home, 'rev1', 'T1', B, 'changes-requested', { fixed: ['F1'] }).code, 0);
  assert.deepEqual(reviewCounts(T(home), B).open, ['F2']);
  // already closed once: not closable twice
  const home2 = mkHome(t);
  round2(home2);
  assert.equal(rec(home2, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] }).code, 0);
  const s2 = load(home2); // woken on C: F1 is already closed, not closable twice
  writeStateAtomic(stateFile(home2, 'r1'), { ...s2, tickets: { ...s2.tickets, T1: { ...s2.tickets.T1, head: C, review: { ...s2.tickets.T1.review!, head: C, briefs: [...s2.tickets.T1.review!.briefs, brief(3, 'wake', C, 'rev1')] } } } });
  refused(rec(home2, 'rev1', 'T1', C, 'approve', { fixed: ['F1'] }), 'fixed-not-open');
});

test('fixed: a REPLACEMENT reviewer (the first died) closes the open findings of the first one; a process finding is closed as pr-body', (t) => {
  const home = mkHome(t);
  round2(home);
  const s = load(home);
  const t1 = s.tickets.T1;
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...t1, review: { ...t1.review!, reviewer: { id: 'rev1b', name: 'review-T1-2', at: NOW }, briefs: [...t1.review!.briefs, brief(3, 'replace', B, 'rev1b')] } } } });
  refused(rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] }), 'record-not-reviewer'); // the dead one's word is no longer the ticket's
  assert.equal(rec(home, 'rev1b', 'T1', B, 'approve', { fixed: ['F1'] }).code, 0);
  assert.equal(T(home).findings.F1.fixedBy?.by, 'rev1b');
  // process finding
  const home2 = mkHome(t);
  seed(home2);
  assert.equal(rec(home2, 'rev1', 'T1', A, 'approve', { findings: { P1: { severity: 'MINOR', evidence: 'argued', kind: 'process', text: 'the PR body does not say what changed' } } }).code, 0);
  const s2 = load(home2);
  writeStateAtomic(stateFile(home2, 'r1'), { ...s2, tickets: { ...s2.tickets, T1: { ...s2.tickets.T1, head: B, review: { ...s2.tickets.T1.review!, head: B, briefs: [...s2.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
  assert.equal(rec(home2, 'rev1', 'T1', B, 'approve', { fixed: ['P1'] }).code, 0);
  assert.equal(T(home2).findings.P1.settled?.how, 'pr-body');
});

// ── the coordinator's exits are closed ───────────────────────────────────────────────────────────────────────

test('state set must-FAIL [finding-source]: the coordinator\'s --finding, --finding-json, --settle and their --json keys are refused under seatRecords=on (nothing written)', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const before = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  for (const args of [
    ['T1', '--finding', 'F9=MINOR'],
    ['T1', '--finding-json', '{"F9":{"severity":"MINOR","evidence":"argued"}}'],
    ['T1', '--settle', 'F1=fixed:' + B],
    ['T1', '--settle', 'F1=pr-body:the body says it'],
    ['T1', '--json', '{"findings":{"F9":"MINOR"}}'],
    ['T1', '--json', '{"settle":{"F1":{"how":"fixed","ref":"abc1234"}}}'],
  ]) {
    const r = setT(home, 'r1', ...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`); // a seatRecords refusal exits 2 (SeatRefusal, #587)
    assert.ok(r.stderr.startsWith('[finding-source]'), `${args.join(' ')}: ${r.stderr}`);
  }
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), before, 'nothing written');
  assert.match(setT(home, 'r1', 'T1', '--settle', 'F1=fixed:' + B).stderr, /the coordinator's --settle is refused/);
  // …and the finding fields only the reviewer's record writes are not a patch's either: a --finding-json `by` is refused as unknown off the switch, as [finding-source] on it
  assert.ok(setT(home, 'r1', 'T1', '--finding-json', '{"F9":{"severity":"MINOR","by":"rev1"}}').stderr.startsWith('[finding-source]'));
});

test('state set under seatRecords=OFF is unchanged: --finding / --finding-json / --settle / --decide work as before; the four record-only fields are unknown', (t) => {
  const home = mkHome(t);
  seed(home, { switches: { seatRecords: 'off' } });
  const d = depsOf(home, 'r1');
  assert.equal(runFanout(['state', 'set', '--run', 'r1', 'T1', '--finding', 'F1=MAJOR'], d).code, 0);
  assert.equal(runFanout(['state', 'set', '--run', 'r1', 'T1', '--finding-json', '{"F2":{"severity":"MINOR","evidence":"argued"}}'], d).code, 0);
  assert.equal(runFanout(['state', 'set', '--run', 'r1', 'T1', '--settle', 'F1=fixed:abc1234'], d).code, 0);
  assert.equal(runFanout(['state', 'set', '--run', 'r1', 'T1', '--decide', 'F2=accepted'], d).code, 0);
  for (const f of ['by', 'text', 'raisedOn', 'fixedBy']) {
    const r = runFanout(['state', 'set', '--run', 'r1', 'T1', '--finding-json', JSON.stringify({ F3: { severity: 'MINOR', [f]: 'x' } })], d);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `unknown field "${f}" in findings[F3]\n`);
  }
  const blank = runFanout(['state', 'set', '--run', 'r1', 'T1', '--decide', 'F2='], d);
  assert.equal(blank.code, 1);
  assert.equal(blank.stderr, '--decide expects <finding id>=<the decision> (got "F2=")\n', 'the old usage error, byte for byte');
  assert.equal(T(home).findings.F1.settled?.ref, 'abc1234');
});

test('decide: a written reason is required ([decision-reason-blank]); with one the finding is closed as "not fixed", counted out, and listed by the closeout with its reason', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  for (const arg of ['F1=', 'F1=   ']) {
    const r = setT(home, 'r1', 'T1', '--decide', arg);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.startsWith('[decision-reason-blank]'), r.stderr);
  }
  assert.equal(T(home).findings.F1.decision, undefined);
  const ok = setT(home, 'r1', 'T1', '--decide', 'F1=the retry cap is the product owner\'s call, tracked in the next ticket');
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(T(home).findings.F1.decision?.by, 'r1');
  assert.deepEqual(reviewCounts(T(home), A), { blocking: 0, major: 0, minor: 0, open: [] }, 'a decided finding is not counted');
  const c = runCloseout([ '--run', 'r1'], depsOf(home, 'r1'));
  assert.match(c.stdout, /decided NOT fixed \(#589\): 1 finding\(s\) the coordinator closed with a written reason/);
  assert.match(c.stdout, /T1\/F1 {2}MAJOR @aaaaaaaa {2}decided by r1 at .*: the retry cap is the product owner's call/);
  const j = JSON.parse(runCloseout(['--run', 'r1', '--json'], depsOf(home, 'r1')).stdout);
  assert.equal(j.decided[0].finding, 'F1');
  // off: the close-out is byte-identical (no decided section, no key)
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  assert.equal(setT(off, 'r1', 'T1', '--finding', 'F1=MAJOR').code, 0);
  assert.equal(setT(off, 'r1', 'T1', '--decide', 'F1=ok').code, 0);
  assert.ok(!/decided NOT fixed/.test(runCloseout(['--run', 'r1'], depsOf(off, 'r1')).stdout));
  assert.ok(!('decided' in JSON.parse(runCloseout(['--run', 'r1', '--json'], depsOf(off, 'r1')).stdout)));
});

// ── deliver / gate take the verdict from the state ───────────────────────────────────────────────────────────

function rig(head: string, ci: 'green' | 'red' = 'green', treeOf: Record<string, string> = {}) {
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    const [a, b] = args;
    const ok = (s: string): GhResult => ({ code: 0, stdout: s, stderr: '' });
    if (a === 'api') { const m = /commits\/([0-9a-f]+)/.exec(args[1]); return m && treeOf[m[1]] ? ok(JSON.stringify({ commit: { tree: { sha: treeOf[m[1]] } } })) : { code: 1, stdout: '', stderr: 'HTTP 404' }; }
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: head }]));
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'd'.repeat(40) } }));
      const roll = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: ci === 'green' ? 'SUCCESS' : 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }];
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: roll }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const dd: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: () => {} };
  return { dd, gh, merged: () => merged };
}
const dopts = (o: Partial<DeliverOpts> = {}): DeliverOpts => ({ branch: 't1', into: 'master', ticket: 'T1', strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 0, requireChecks: [], run: 'r1', ...o });
const verdictFile = (dir: string): string => { const f = path.join(dir, 'verdict.json'); fs.writeFileSync(f, JSON.stringify({ round: 1, blocking: 0, major: 0, minor: 0, head: A })); return f; };

test('deliver must-PASS: the verdict recorded by the reviewer on the delivered head → merged; the result names the recorded verdict; no verdict file, no flag', async (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', { findings: { F1: { severity: 'MINOR', evidence: 'argued', text: 'a stale comment' } } }).code, 0);
  const r = rig(A);
  const out = await withEnv(home, () => deliver(dopts(), r.dd));
  assert.equal(out.exit, 0, JSON.stringify(out.result));
  assert.equal(out.result.verdict, 'merged');
  assert.equal(out.result.reviewGated, true);
  assert.deepEqual(out.result.recorded, { reviewer: 'rev1', round: 1, verdict: 'approve', blocking: 0, major: 0, minor: 1 });
  assert.ok(r.merged());
});

test('deliver must-FAIL [record-missing]: nothing recorded / recorded on another head — the refusal names the reviewer to wake; no reviewer at all says to spawn it', async (t) => {
  const home = mkHome(t);
  seed(home);
  const r = rig(A);
  const out = await withEnv(home, () => deliver(dopts(), r.dd));
  assert.equal(out.exit, 2);
  assert.equal(out.result.reason, 'record-missing');
  assert.match(out.result.detail!, /^\[record-missing\] T1: no recorded verdict on aaaaaaaaaaaa — reviewer review-T1 \(rev1\) has not recorded it: wake it \(`orchestra fanout review T1`/);
  assert.ok(!r.merged());
  // recorded on A, delivered at B (the content changed)
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}, trees({ [A]: TREE_A })).code, 0);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B } } });
  const r2 = rig(B, 'green', { [A]: TREE_A, [B]: TREE_B });
  const out2 = await withEnv(home, () => deliver(dopts({ verifiedHead: B }), r2.dd));
  assert.equal(out2.result.reason, 'record-missing');
  assert.match(out2.result.detail!, /\(recorded: aaaaaaaa\)/);
  // no reviewer recorded on the ticket
  const home3 = mkHome(t);
  seed(home3, { reviewers: false });
  const out3 = await withEnv(home3, () => deliver(dopts(), rig(A).dd));
  assert.equal(out3.result.reason, 'record-missing');
  assert.match(out3.result.detail!, /no reviewer is recorded .*`orchestra fanout review T1`/);
});

test('deliver must-FAIL [typed-verdict] / [ungated-merge]: a verdict file typed by the coordinator and --no-review-gate are refused — even with a recorded approve — and nothing is merged', async (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}).code, 0);
  const r = rig(A);
  const typed = await withEnv(home, () => deliver(dopts({ reviewVerdict: verdictFile(home) }), r.dd));
  assert.equal(typed.exit, 2);
  assert.equal(typed.result.reason, 'typed-verdict');
  assert.match(typed.result.detail!, /^\[typed-verdict\] seatRecords=on/);
  const ungated = await withEnv(home, () => deliver(dopts({ noReviewGate: true }), r.dd));
  assert.equal(ungated.exit, 2);
  assert.equal(ungated.result.reason, 'ungated-merge');
  assert.match(ungated.result.detail!, /^\[ungated-merge\] seatRecords=on/);
  assert.ok(!r.merged());
  // ungated with verifier=off is the same refusal name (the switch, not the verifier switch, answers)
  const home2 = mkHome(t);
  seed(home2, { switches: { verifier: 'off' } });
  const o2 = await withEnv(home2, () => deliver(dopts({ noReviewGate: true }), rig(A).dd));
  assert.equal(o2.result.reason, 'ungated-merge');
});

test('deliver must-PASS then must-FAIL: MAJOR → refused (review-blocking), then delivered after the reviewer closes it on a later head it read', async (t) => {
  const home = mkHome(t);
  round2(home); // T1: MAJOR F1 recorded at A (changes-requested), ticket now at B, reviewer woken on B
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: A, review: { ...s.tickets.T1.review!, head: A } } } });
  const blocked = rig(A);
  const out = await withEnv(home, () => deliver(dopts({ verifiedHead: A }), blocked.dd));
  assert.equal(out.exit, 2, JSON.stringify(out.result));
  assert.equal(out.result.reason, 'review-blocking');
  assert.match(out.result.detail!, /review round 1: 0 BLOCKING \/ 1 MAJOR/);
  assert.ok(!blocked.merged());
  // the fix: head B, reviewer reads it and closes F1
  writeStateAtomic(stateFile(home, 'r1'), { ...load(home), tickets: { ...load(home).tickets, T1: { ...load(home).tickets.T1, head: B, review: { ...load(home).tickets.T1.review!, head: B } } } });
  assert.equal(rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] }).code, 0);
  const good = rig(B);
  const out2 = await withEnv(home, () => deliver(dopts({ verifiedHead: B }), good.dd));
  assert.equal(out2.exit, 0, JSON.stringify(out2.result));
  assert.equal(out2.result.verdict, 'merged');
  assert.equal(out2.result.recorded?.round, 2);
  assert.ok(good.merged());
});

test('deliver must-PASS: a `--decide` with a reason lifts the MAJOR — delivered, and the closeout lists the decision', async (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const out = await withEnv(home, () => deliver(dopts(), rig(A).dd));
  assert.equal(out.result.reason, 'review-blocking');
  assert.equal(setT(home, 'r1', 'T1', '--decide', 'F1=accepted: the cap is configurable, follow-up planned').code, 0);
  const r = rig(A);
  const out2 = await withEnv(home, () => deliver(dopts(), r.dd));
  assert.equal(out2.exit, 0, JSON.stringify(out2.result));
  assert.equal(out2.result.recorded?.major, 0);
  assert.ok(r.merged());
  assert.match(runCloseout(['--run', 'r1'], depsOf(home, 'r1')).stdout, /T1\/F1 {2}MAJOR .*accepted: the cap is configurable/);
});

test('deliver: a rebase that keeps the TREE keeps the verdict (as today) — the delivered head is another sha of the recorded tree', async (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}, trees({ [A]: TREE_A })).code, 0);
  assert.equal(T(home).reviews![0].tree, TREE_A);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, tree: TREE_A } } });
  const r = rig(B, 'green', { [A]: TREE_A, [B]: TREE_A });
  const out = await withEnv(home, () => deliver(dopts({ verifiedHead: B }), r.dd));
  assert.equal(out.exit, 0, JSON.stringify(out.result));
  assert.deepEqual(out.result.viaTree, { verifiedHead: B, tree: TREE_A });
  assert.ok(r.merged());
  // …and with another tree it is record-missing
  const home2 = mkHome(t);
  seed(home2);
  assert.equal(rec(home2, 'rev1', 'T1', A, 'approve', {}, trees({ [A]: TREE_A })).code, 0);
  const s2 = load(home2);
  writeStateAtomic(stateFile(home2, 'r1'), { ...s2, tickets: { ...s2.tickets, T1: { ...s2.tickets.T1, head: B } } });
  const out2 = await withEnv(home2, () => deliver(dopts({ verifiedHead: B }), rig(B, 'green', { [A]: TREE_A, [B]: TREE_B }).dd));
  assert.equal(out2.result.reason, 'record-missing');
});

test('deliver with seatRecords OFF is unchanged: --review-verdict and --no-review-gate work, no `recorded` in the result, no recorded verdict is read', async (t) => {
  const home = mkHome(t);
  seed(home, { switches: { seatRecords: 'off' } });
  const r = rig(A);
  const out = await withEnv(home, () => deliver(dopts({ reviewVerdict: verdictFile(home), verifiedHead: A }), r.dd));
  assert.equal(out.exit, 0, JSON.stringify(out.result));
  assert.ok(!('recorded' in out.result));
  const out2 = await withEnv(home, () => deliver(dopts({ noReviewGate: true, verifiedHead: A }), rig(A).dd));
  assert.equal(out2.result.reviewGated, false);
  assert.equal(out2.exit, 0);
  const none = await withEnv(home, () => deliver(dopts({ verifiedHead: A }), rig(A).dd));
  assert.equal(none.result.reason, 'no-verdict');
  // verifier=on and off both: the recorded path answers the same (off: no verifier seat, the reviewer's record is the gate)
  for (const verifier of ['on', 'off']) {
    const h = mkHome(t);
    seed(h, { switches: { verifier } });
    assert.equal(rec(h, 'rev1', 'T1', A, 'approve', {}).code, 0);
    const o = await withEnv(h, () => deliver(dopts(), rig(A).dd));
    assert.equal(o.exit, 0, `verifier=${verifier}: ${JSON.stringify(o.result)}`);
  }
});

test('gate: under seatRecords=on --ticket answers only for a head with the recorded verdict (record-missing / review-blocking); the answer carries it; off: no `recorded` key', async (t) => {
  const gopts = (o: Partial<GateOpts> = {}): GateOpts => ({ branch: 't1', into: 'master', head: A, requireChecks: [], ticket: 'T1', run: 'r1', settleMs: 0, ...o });
  const gdeps = (r: ReturnType<typeof rig>) => ({ gh: r.gh, log: () => {}, sleep: async () => {}, recorded: realDeps().recorded, followUp: undefined, acceptance: undefined, stack: undefined });
  const home = mkHome(t);
  seed(home);
  const miss = await withEnv(home, () => gatePr(gopts(), gdeps(rig(A))));
  assert.equal(miss.exit, 2);
  assert.equal(miss.result.reason, 'record-missing');
  assert.match(miss.result.detail!, /reviewer review-T1 \(rev1\)/);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const blocked = await withEnv(home, () => gatePr(gopts(), gdeps(rig(A))));
  assert.equal(blocked.exit, 2);
  assert.equal(blocked.result.reason, 'review-blocking');
  assert.match(blocked.result.detail!, /0 BLOCKING \/ 1 MAJOR finding\(s\) open \(F1\)/);
  assert.equal(setT(home, 'r1', 'T1', '--decide', 'F1=decided: tracked elsewhere').code, 0);
  const ok = await withEnv(home, () => gatePr(gopts(), gdeps(rig(A))));
  assert.equal(ok.exit, 0, JSON.stringify(ok.result));
  assert.deepEqual(ok.result.recorded, { reviewer: 'rev1', round: 1, verdict: 'changes-requested', blocking: 0, major: 0, minor: 0 });
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  const o = await withEnv(off, () => gatePr(gopts(), gdeps(rig(A))));
  assert.equal(o.exit, 0);
  assert.ok(!('recorded' in o.result));
});

// ── worker_done of a recorded reviewer ───────────────────────────────────────────────────────────────────────

test('worker_done must-FAIL [record-missing]: a recorded reviewer\'s worker_done is refused until its head\'s verdict is recorded — the refusal prints the command; after the record it is accepted', (t) => {
  const home = mkHome(t);
  seed(home);
  const env = envOf(home, 'rev1');
  const refusal = fanoutCompletionRefusal('rev1', 'r1', env);
  assert.ok(refusal);
  assert.ok(refusal!.startsWith('[record-missing] orchestra send: worker_done refused'));
  assert.ok(refusal!.includes(`run: orchestra fanout record T1 --head ${A} --verdict approve|changes-requested --json <file|->`), refusal!);
  // through the real send verb on a REAL bus file: the refusal is ctx.fail, nothing is written
  const busDir = mkHome(t);
  const db = bus.openBus(path.join(busDir, 'bus.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  let failed = '';
  const mk = (handle: string): BusVerbCtx => ({
    db, id: { runId: 'r1', handle }, out: () => {}, fail: ((m: string) => { failed = m; throw new Error('FAIL'); }) as BusVerbCtx['fail'],
    bus: { send: bus.send, check: bus.check, ack: bus.ack, openGate: bus.openGate, resolveGate: bus.resolveGate, getGate: bus.getGate, sendGateResolutionRewake: bus.sendGateResolutionRewake, openGatesForRecipient: bus.openGatesForRecipient, openGatesForRecipientInRuns: bus.openGatesForRecipientInRuns, getRelatedRunIds: busRuns.getRelatedRunIds, getRun: busRuns.getRun, fencedWrite: bus.fencedWrite, mintCapability: bus.mintCapability, verifyCapability: bus.verifyCapability, rotateCapabilityForRecipient: bus.rotateCapabilityForRecipient, withReceipt, busSwitch: () => false } as never,
    generation: null, fencingOn: false, capabilityEnabled: () => false,
    completionRefusal: (sender: string, runId: string) => fanoutCompletionRefusal(sender, runId, env),
  });
  const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const ctx = mk('rev1');
  assert.throws(() => verbSend(ctx, { kind: 'worker_done', body: 'done', cap: 'dcap_x' } as never), /FAIL/);
  assert.match(failed, /\[record-missing\] .*orchestra fanout record T1 --head a{40}/);
  assert.equal(count(), 0, 'nothing was written to the bus');
  // the record
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}).code, 0);
  assert.equal(fanoutCompletionRefusal('rev1', 'r1', env), null);
  verbSend(ctx, { kind: 'worker_done', body: 'done', cap: 'dcap_x' } as never);
  assert.equal(count(), 1, 'after the record the completion is accepted');
  failed = '';
  verbSend(mk('r1'), { kind: 'worker_done', body: 'the coordinator is never held' } as never);
  assert.equal(count(), 2);
  assert.equal(failed, '');
});

test('worker_done: only a recorded reviewer is held — the coordinator, an implementer, a status from the reviewer, a merged ticket\'s reviewer, seatRecords off, an unreadable state: all pass', (t) => {
  const home = mkHome(t);
  seed(home);
  const env = envOf(home, 'x');
  for (const who of ['r1', 'impl1', 'stranger']) assert.equal(fanoutCompletionRefusal(who, 'r1', env), null, who);
  const s = load(home);
  assert.equal(reviewerDoneRefusal({ ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, status: 'merged' } } }, 'rev1'), null);
  assert.equal(reviewerDoneRefusal({ ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, status: 'dropped' } } }, 'rev1'), null);
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  assert.equal(fanoutCompletionRefusal('rev1', 'r1', envOf(off, 'x')), null);
  assert.equal(fanoutCompletionRefusal('rev1', 'no-such-run', env), null);
  fs.writeFileSync(stateFile(home, 'r1'), '{not json');
  assert.equal(fanoutCompletionRefusal('rev1', 'r1', env), null);
  // a status is not a completion: the hook is consulted for worker_done only
  const db2 = bus.openBus(path.join(mkHome(t), 'bus.sqlite'));
  t.after(() => { try { db2.close(); } catch { /* closed */ } });
  const ctx2 = { db: db2, id: { runId: 'r1', handle: 'rev1' }, out: () => {}, fail: ((m: string) => { throw new Error(m); }) as BusVerbCtx['fail'], bus: { send: bus.send, getRun: busRuns.getRun, getRelatedRunIds: busRuns.getRelatedRunIds, fencedWrite: bus.fencedWrite, withReceipt, verifyCapability: bus.verifyCapability, busSwitch: () => false } as never, generation: null, fencingOn: false, capabilityEnabled: () => false, completionRefusal: () => '[record-missing] x' } as BusVerbCtx;
  verbSend(ctx2, { kind: 'status', body: 'working' } as never);
  assert.throws(() => verbSend(ctx2, { kind: 'worker_done', body: 'done' } as never), /record-missing/);
});

// ── resume ───────────────────────────────────────────────────────────────────────────────────────────────────

test('resume: a reviewer with no record on its head is named with the one verb that wakes or replaces it; once it records, the line is gone; off: nothing printed', (t) => {
  const home = mkHome(t);
  seed(home);
  const d = depsOf(home, 'r1');
  const first = runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write'], d);
  assert.match(first.stdout, /! T1 +reviewer-no-record +T1: reviewer review-T1 \(rev1\) has recorded no verdict on aaaaaaaaaaaa — wake it, or replace it if it died: `orchestra fanout review T1`/);
  assert.match(first.stdout, /! T2 +reviewer-no-record/);
  assert.equal(unrecordedReviewers(load(home)).length, 2);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}).code, 0);
  const second = runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write'], d);
  assert.ok(!/T1: reviewer review-T1/.test(second.stdout));
  assert.match(second.stdout, /T2: reviewer review-T2/);
  const js = JSON.parse(runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write', '--json'], d).stdout);
  assert.deepEqual(js.reviewersWithoutRecord.map((x: { ticket: string }) => x.ticket), ['T2']);
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  const o = runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write'], depsOf(off, 'r1'));
  assert.ok(!/reviewer-no-record/.test(o.stdout));
  assert.ok(!('reviewersWithoutRecord' in JSON.parse(runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write', '--json'], depsOf(off, 'r1')).stdout)));
});

// ── the state file ───────────────────────────────────────────────────────────────────────────────────────────

test('state file: a v1 file with none of the new fields loads and is written back unchanged; the new fields round-trip; a hand-edited review is refused', (t) => {
  const home = mkHome(t);
  seed(home, { switches: { seatRecords: 'off' } });
  const text = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  assert.ok(!text.includes('"reviews"'));
  assert.ok(!text.includes('"raisedOn"'));
  const on = mkHome(t);
  seed(on);
  assert.equal(rec(on, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const s = load(on);
  writeStateAtomic(stateFile(on, 'r1'), s);
  assert.deepEqual(load(on), s);
  const raw = JSON.parse(fs.readFileSync(stateFile(on, 'r1'), 'utf8'));
  raw.tickets.T1.reviews[0].n = 5;
  fs.writeFileSync(stateFile(on, 'r1'), JSON.stringify(raw));
  assert.throws(() => load(on), /reviews\[0\]\.n must be 1/);
  raw.tickets.T1.reviews[0].n = 1;
  raw.tickets.T1.reviews[0].verdict = 'pass';
  fs.writeFileSync(stateFile(on, 'r1'), JSON.stringify(raw));
  assert.throws(() => load(on), /verdict must be one of approve\|changes-requested/);
});

test('help: `fanout record --help` prints its usage; the generic `help fanout` text is untouched (byte-identical off); a bad call prints the usage', () => {
  const r = runRecord(['--help'], { env: {}, cwd: '/', runner: offline, now: () => NOW, readStdin: () => '' });
  assert.equal(r.stdout, `${RECORD_USAGE}\n`);
  for (const name of ['record-off', 'record-wrong-ticket', 'record-not-reviewer', 'record-head-mismatch', 'fixed-by-non-reviewer', 'approve-open-finding', 'typed-verdict', 'ungated-merge', 'finding-source']) assert.ok(RECORD_USAGE.includes(`[${name}]`) || name === 'record-missing' || ['typed-verdict', 'ungated-merge', 'finding-source'].includes(name), name);
  const bad = runRecord(['T1'], { env: {}, cwd: '/', runner: offline, now: () => NOW, readStdin: () => '' });
  assert.equal(bad.code, 1);
  assert.ok(bad.stderr.startsWith('usage: orchestra fanout record'));
});

// ── the head the reviewer speaks about, the latest verdict, the wiring ───────────────────────────────────────

test('record-head: the ticket moving to B WITHOUT waking the reviewer does not let it record B (it was briefed on A); the latest review on a head wins; a record on an OLD head does not release worker_done on the new one', async (t) => {
  const home = mkHome(t);
  seed(home);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B } } }); // the coordinator recorded the new head; nobody woke the reviewer
  refused(rec(home, 'rev1', 'T1', B, 'approve', {}), 'record-head-mismatch');
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0); // what it read is what it may record
  // the same head twice is refused (#672: a verdict on a head is final); the coordinator's --decide closes the MAJOR, the recorded round 1 then reads 0 open
  const home2 = mkHome(t);
  seed(home2);
  assert.equal(rec(home2, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  assert.equal(setT(home2, 'r1', 'T1', '--decide', 'F1=accepted by the product owner').code, 0);
  refused(rec(home2, 'rev1', 'T1', A, 'approve', {}), 'record-final');
  assert.deepEqual(T(home2).reviews!.map((r) => [r.n, r.verdict]), [[1, 'changes-requested']]);
  const out = await withEnv(home2, () => deliver(dopts(), rig(A).dd));
  assert.equal(out.result.recorded?.round, 1);
  assert.equal(out.result.recorded?.major, 0, 'the decided finding is not counted');
  // recorded at A, woken on B: its worker_done waits for B's verdict, not A's
  const home3 = mkHome(t);
  round2(home3);
  const refusal = fanoutCompletionRefusal('rev1', 'r1', envOf(home3, 'rev1'));
  assert.ok(refusal?.includes(`--head ${B}`), String(refusal));
  assert.equal(rec(home3, 'rev1', 'T1', B, 'approve', { fixed: ['F1'] }).code, 0);
  assert.equal(fanoutCompletionRefusal('rev1', 'r1', envOf(home3, 'rev1')), null);
});

test('state show with seatRecords OFF prints no records block (byte-identical to before)', (t) => {
  const home = mkHome(t);
  seed(home, { switches: { seatRecords: 'off' } });
  assert.ok(!/recorded reviews/.test(runFanout(['state', 'show', '--run', 'r1'], depsOf(home, 'r1')).stdout));
});

test('wiring pin: index.ts routes `fanout record` and hands the bus `send` its completionRefusal (the unit tests above pass both explicitly)', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'index.ts'), 'utf8');
  assert.ok(src.includes("args[0] === 'record' ? runRecord(args.slice(1), fanoutDeps) :"), 'fanout record is routed');
  assert.ok(src.includes('completionRefusal: (sender, runId) => fanoutCompletionRefusal(sender, runId)'), 'verbSend gets the hook');
  assert.match(src, /if \(args\[0\] === 'record'\) \{[^\n]*\n\s+await settleHostIdentity\(\);\n\s+fanoutDeps\.identity = hostIdentity;\n\s+if \(process\.env\.ORCHESTRA_SESSION_KEY\?\.trim\(\) && hostIdentity\?\.source !== 'host'\) fail\('refusing to record: the host could not vouch this session/, 'the host is asked who the recorder is, its answer is handed to the verb, and a keyed session it cannot vouch records nothing');
  assert.ok(src.includes('if (stateSetNeedsHost(args, process.env)) { await settleHostIdentity(); fanoutDeps.identity = hostIdentity; }'), 'a `state set --decide|--json` on a recording run asks the host who the caller is');
});

test('recordReview (the pure rule): off the switch it records nothing, whoever calls — [record-off] — and a refusal never returns a state', (t) => {
  const home = mkHome(t);
  const off = seed(home, { switches: { seatRecords: 'off' } });
  assert.throws(() => recordReview(off, 'T1', { head: A, verdict: 'approve', input: { findings: {}, fixed: [] }, callerId: 'rev1', callerVouched: true, tree: null, now: NOW }), /^FanoutStateError: \[record-off\]|\[record-off\] seatRecords is off/);
  const on = seed(mkHome(t));
  assert.throws(() => recordReview(on, 'T1', { head: A, verdict: 'approve', input: { findings: {}, fixed: [] }, callerId: 'r1', callerVouched: true, tree: null, now: NOW }), /\[record-not-reviewer\]/);
  assert.equal(recordReview(on, 'T1', { head: A, verdict: 'approve', input: { findings: {}, fixed: [] }, callerId: 'rev1', callerVouched: true, tree: null, now: NOW }).tickets.T1.reviews!.length, 1);
  assert.equal(on.tickets.T1.reviews, undefined, 'the input state is never mutated');
});

test('record must-FAIL [record-not-reviewer]: the reviewer\'s id asserted by the environment ALONE is not proof — a coordinator that exports the reviewer\'s ws id records nothing (the host did not vouch)', (t) => {
  const home = mkHome(t);
  seed(home);
  const forged = (identity: IdentityResolution | null) => runRecord(['T1', '--run', 'r1', '--head', A, '--verdict', 'approve', '--json', '-'], depsOf(home, 'rev1', offline, '{}', identity));
  for (const id of [null, { source: 'env', why: 'unvouched' } as IdentityResolution, { source: 'env', why: 'no-key' } as IdentityResolution, { source: 'env', why: 'unreachable' } as IdentityResolution]) {
    const r = forged(id);
    refused(r, 'record-not-reviewer');
    assert.match(r.stderr, /the host could not vouch that you are review-T1 \(rev1\)/);
  }
  assert.equal(T(home).reviews, undefined);
  assert.equal(forged(HOST).code, 0);
});

// ── review round 1 (pre-review subagent): who may decide, typed verdict word, decoy run, policy-blocking MINOR at deliver ──

test('decide must-FAIL [decide-caller]: an implementer / another ticket\'s reviewer / an unvouched "coordinator" cannot lift a reviewer\'s finding; the recorded `by` is the vouched id, never what a --json patch says', (t) => {
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', MAJOR()).code, 0);
  const as = (who: string, identity: IdentityResolution | null, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', 'T1', ...a], depsOf(home, who, offline, '', identity));
  for (const [who, id] of [['impl1', HOST], ['rev2', HOST], ['rev1', HOST], ['r1', null], ['r1', { source: 'env', why: 'unvouched' } as IdentityResolution]] as const) {
    const r = as(who, id, '--decide', 'F1=trust me');
    assert.equal(r.code, 2, `${who}: ${r.stderr}`);
    assert.ok(r.stderr.startsWith('[decide-caller]'), r.stderr);
  }
  assert.match(as('impl1', HOST, '--decide', 'F1=x').stderr, /only the run's coordinator \(r1\)/);
  assert.match(as('r1', null, '--decide', 'F1=x').stderr, /the host did not vouch for r1/);
  assert.equal(T(home).findings.F1.decision, undefined, 'nothing was decided by anyone else');
  const r = as('r1', HOST, '--json', JSON.stringify({ decide: { F1: { text: 'accepted: tracked in the next ticket', by: 'rev1' } } }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(T(home).findings.F1.decision?.by, 'r1', 'by = the vouched coordinator, not the forged "rev1"');
  // off: no host is asked, no caller is checked (an implementer\'s decide works as it always did)
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  assert.equal(setT(off, 'r1', 'T1', '--finding', 'F1=MAJOR').code, 0);
  assert.equal(runFanout(['state', 'set', '--run', 'r1', 'T1', '--decide', 'F1=ok'], depsOf(off, 'impl1', offline, '', null)).code, 0);
});

test('state set must-FAIL [typed-verdict]: the coordinator cannot type the reviewer\'s word (approve / changes-requested); pass / fail / none stay its own; off unchanged', (t) => {
  const home = mkHome(t);
  seed(home);
  for (const v of ['approve', 'changes-requested']) {
    const r = setT(home, 'r1', 'T1', '--verdict', v);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.startsWith('[typed-verdict]'), r.stderr);
  }
  assert.equal(setT(home, 'r1', 'T1', '--verdict', 'pass').code, 0);
  assert.equal(setT(home, 'r1', 'T1', '--verdict', 'none').code, 0);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}).code, 0);
  assert.equal(T(home).verdict, 'approve', 'the record writes it');
  const off = mkHome(t);
  seed(off, { switches: { seatRecords: 'off' } });
  assert.equal(setT(off, 'r1', 'T1', '--verdict', 'approve').code, 0);
});

test('deliver must-FAIL [run-switch]: a decoy run with seatRecords=off named by --run does not skip the recorded-verdict rule of the caller\'s own run', async (t) => {
  const home = mkHome(t);
  seed(home);
  let shadow = newState('shadow', { now: NOW, switches: { seatRecords: 'off' } as never });
  shadow = applyTicketPatch(shadow, 'T1', { status: 'nominated', branch: 't1', head: A }, NOW);
  writeStateAtomic(stateFile(home, 'shadow'), shadow);
  const r = rig(A);
  const out = await withEnv(home, () => deliver(dopts({ run: 'shadow', reviewVerdict: verdictFile(home), verifiedHead: A }), r.dd));
  assert.equal(out.exit, 1, JSON.stringify(out.result));
  assert.equal(out.result.reason, 'bad-state');
  assert.match(out.result.detail!, /\[run-switch\] --run shadow has seatRecords=off but your own run r1 has seatRecords=on/);
  assert.ok(!r.merged());
  // …while a run with NO recording own run is untouched (the off arm of the other tests): the decoy only matters when the caller's own run records
  const plain = mkHome(t);
  seed(plain, { switches: { seatRecords: 'off' } });
  writeStateAtomic(stateFile(plain, 'shadow'), shadow);
  const ok = await withEnv(plain, () => deliver(dopts({ run: 'shadow', reviewVerdict: verdictFile(plain), verifiedHead: A }), rig(A).dd));
  assert.equal(ok.exit, 0, JSON.stringify(ok.result));
});

test('deliver [finding-unsettled]: under minorPolicy=spec a recorded MINOR quoting the spec holds the merge until the reviewer closes it on a later head', async (t) => {
  const home = mkHome(t);
  const s0 = seed(home, { switches: { minorPolicy: 'spec' } });
  const spec = 'The retry loop must stop after five attempts and report the last error.';
  writeStateAtomic(stateFile(home, 'r1'), { ...s0, tickets: { ...s0.tickets, T1: { ...s0.tickets.T1, spec: 'spec.md', specText: spec } } });
  const sp = { findings: { S1: { severity: 'MINOR', evidence: 'argued', text: 'it never stops', specSentence: spec } } };
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', sp).code, 0);
  const out = await withEnv(home, () => deliver(dopts(), rig(A).dd));
  assert.equal(out.exit, 2, JSON.stringify(out.result));
  assert.equal(out.result.reason, 'finding-unsettled');
  assert.match(out.result.detail!, /S1/);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B, review: { ...s.tickets.T1.review!, head: B, briefs: [...s.tickets.T1.review!.briefs, brief(2, 'wake', B, 'rev1')] } } } });
  assert.equal(rec(home, 'rev1', 'T1', B, 'approve', { fixed: ['S1'] }).code, 0);
  const good = await withEnv(home, () => deliver(dopts({ verifiedHead: B }), rig(B).dd));
  assert.equal(good.exit, 0, JSON.stringify(good.result));
});

// ── review round 1, m2: clauses that had no test ─────────────────────────────────────────────────────────────

test('record-json: a finding id outside the id alphabet and a text over 2000 characters are refused ([record-json]); 2000 is accepted', (t) => {
  const home = mkHome(t);
  seed(home);
  for (const id of ['has space', '../x', '-lead', 'x'.repeat(65), '']) refused(rec(home, 'rev1', 'T1', A, 'changes-requested', { findings: { [id]: { severity: 'MAJOR', evidence: 'argued', text: 'a real problem' } } }), 'record-json');
  refused(rec(home, 'rev1', 'T1', A, 'changes-requested', { fixed: ['bad id'] }), 'record-json');
  refused(rec(home, 'rev1', 'T1', A, 'changes-requested', { findings: { F1: { severity: 'MAJOR', evidence: 'argued', text: 'x'.repeat(2001) } } }), 'record-json');
  assert.equal(T(home).reviews, undefined, 'nothing recorded by the refusals');
  assert.equal(rec(home, 'rev1', 'T1', A, 'changes-requested', { findings: { F1: { severity: 'MAJOR', evidence: 'argued', text: 'x'.repeat(2000) } } }).code, 0);
});

test('deliver [no-verified-head]: under seatRecords=on the delivered head must be a FULL 40-hex sha (the merge is bound to it) — a short ticket head with no --verified-head is could-not-check', async (t) => {
  const home = mkHome(t);
  seed(home);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: A.slice(0, 10), review: { ...s.tickets.T1.review!, head: A.slice(0, 10), briefs: [brief(1, 'spawn', A.slice(0, 10), 'rev1')] } } } });
  assert.equal(rec(home, 'rev1', 'T1', A.slice(0, 10), 'approve', {}).code, 0);
  const r = rig(A);
  const out = await withEnv(home, () => deliver(dopts(), r.dd));
  assert.equal(out.exit, 1, JSON.stringify(out.result));
  assert.equal(out.result.reason, 'no-verified-head');
  assert.ok(!r.merged());
  const ok = await withEnv(home, () => deliver(dopts({ verifiedHead: A }), rig(A).dd));
  assert.equal(ok.exit, 0, JSON.stringify(ok.result));
});

test('gate: a rebase that keeps the TREE keeps the recorded verdict at the gate too (the tree of --head is read); another tree is record-missing', async (t) => {
  const gopts = (head: string): GateOpts => ({ branch: 't1', into: 'master', head, requireChecks: [], ticket: 'T1', run: 'r1', settleMs: 0 });
  const gdeps = (r: ReturnType<typeof rig>) => ({ gh: r.gh, log: () => {}, sleep: async () => {}, recorded: realDeps().recorded, followUp: undefined, acceptance: undefined, stack: undefined });
  const home = mkHome(t);
  seed(home);
  assert.equal(rec(home, 'rev1', 'T1', A, 'approve', {}, trees({ [A]: TREE_A })).code, 0);
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, head: B } } });
  const same = await withEnv(home, () => gatePr(gopts(B), gdeps(rig(B, 'green', { [A]: TREE_A, [B]: TREE_A }))));
  assert.equal(same.exit, 0, JSON.stringify(same.result));
  assert.equal(same.result.recorded?.reviewer, 'rev1');
  const other = await withEnv(home, () => gatePr(gopts(B), gdeps(rig(B, 'green', { [A]: TREE_A, [B]: TREE_B }))));
  assert.equal(other.exit, 2);
  assert.equal(other.result.reason, 'record-missing');
});

test('resume / worker_done: a merged or dropped ticket has no reviewer owing a record (unrecordedReviewers skips it)', (t) => {
  const home = mkHome(t);
  const s = seed(home);
  assert.equal(unrecordedReviewers(s).length, 2);
  for (const status of ['merged', 'dropped'] as const) {
    const done = { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, status } } };
    assert.deepEqual(unrecordedReviewers(done).map((u) => u.ticket), ['T2'], status);
  }
});

test('wiring pin: the `--as <other handle>` nudge — the caller\'s own workspace id is asked too, not only the handle it sends as', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'index.ts'), 'utf8');
  assert.ok(src.includes('?? (selfWorkspaceId() && selfWorkspaceId() !== sender ? fanoutCompletionRefusal(selfWorkspaceId()!, runId) : null)'), 'the own-workspace fallback');
});

test('m1: the reviewer\'s brief ends with the record command (ticket, run, head, verdict, --json) and the json shape; the worker_done comes after, and says it is refused until recorded', (t) => {
  const home = mkHome(t);
  const s = seed(home);
  const b = renderBriefOf(s, 'T1', { kind: 'spawn', head: A, base: null }).text;
  assert.ok(b.includes(`orchestra fanout record T1 --run r1 --head ${A} --verdict approve|changes-requested --json <file|->`), 'the exact record command');
  assert.ok(b.includes('"findings":{"<id>":{"severity":"BLOCKING|MAJOR|MINOR","evidence":"measured|argued","text":') && b.includes('"fixed":["<id of an open finding'), 'the json shape');
  assert.ok(b.indexOf('orchestra fanout record') < b.indexOf('worker_done'), 'record first, worker_done after');
  assert.ok(b.includes('is refused until your verdict for aaaaaaaaaaaa is recorded'), 'the worker_done rule');
  assert.ok(!/write your findings/i.test(b), 'no prose-verdict instruction left');
});
