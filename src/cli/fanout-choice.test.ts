// #641 — an implementer's choice is a run decision: `fanout choice` records it, the reviewer brief and the closing report list it, `fanout record --on-choice` keeps a finding about it from blocking,
// and a finding that the code does not do what the choice says still blocks. Every arm drives the production verbs (`choice`, `record`, `review` brief, `buildReport`, `deliver` gate read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runChoice } from './fanout-choice.ts';
import { runRecord } from './fanout-record.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';
import { applyTicketPatch, newState, readState, setPlan, stateFile, writeStateAtomic, type FanoutState } from '../shared/fanout-state.ts';
import { renderBriefOf } from '../shared/fanout-review.ts';
import { reviewCounts, recordedVerdictOf } from '../shared/fanout-record.ts';
import { buildReport, renderReport } from '../shared/fanout-report.ts';
import { renderImplementerBrief } from '../shared/fanout-implementer-brief.ts';

const NOW = '2026-11-26T10:00:00.000Z';
const A = 'a'.repeat(40);
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });
const HOST: IdentityResolution = { source: 'host', runId: 'r1', generation: null };
const mkHome = (t: { after: (fn: () => void) => void }): string => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-choice-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const depsOf = (home: string, who: string, stdin = '', identity: IdentityResolution | null = HOST): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: who }, cwd: home, runner: offline, now: () => NOW, readStdin: () => stdin, identity });
const brief = { n: 1, kind: 'spawn' as const, head: A, base: null, hash: '1'.repeat(64), text: 'brief', reviewer: 'rev1', at: NOW };

/** run r1, seatRecords=on; T1 nominated at A (implementer impl1, reviewer rev1), T2 (implementer impl2). */
function seed(home: string): void {
  let s = newState('r1', { now: NOW, switches: { seatRecords: 'on' } as never });
  s = setPlan(s, ['T1', 'T2'], 'declare', NOW);
  s = applyTicketPatch(s, 'T2', { dependsOn: [] }, NOW);
  s = applyTicketPatch(s, 'T1', { dependsOn: [], status: 'nominated', branch: 't1', head: A, implementer: 'impl1' }, NOW);
  s = applyTicketPatch(s, 'T2', { implementer: 'impl2' }, NOW);
  s = { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, review: { reviewer: { id: 'rev1', name: 'review-T1', at: NOW }, head: A, base: null, briefs: [brief] } } } };
  writeStateAtomic(stateFile(home, 'r1'), s);
}
const load = (home: string): FanoutState => readState(stateFile(home, 'r1'))!;
const choose = (home: string, who: string, ticket = 'T1', q = 'page size 0: error or default?', taken = 'default to 20 (reversible)', identity: IdentityResolution | null = HOST) =>
  runChoice([ticket, '--run', 'r1', '--question', q, '--taken', taken], depsOf(home, who, '', identity));
const rec = (home: string, verdict: string, json: unknown, extra: string[] = []) =>
  runRecord(['T1', '--run', 'r1', '--head', A, '--verdict', verdict, '--json', '-', ...extra], depsOf(home, 'rev1', JSON.stringify(json)));
const F = (text: string) => ({ severity: 'MAJOR', evidence: 'argued', text });

test('choice must-PASS: the ticket\'s implementer records it — a run decision of T1 (reversible-default, its option as the answer)', (t) => {
  const home = mkHome(t); seed(home);
  const r = choose(home, 'impl1');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /T1: choice 1 recorded/);
  assert.deepEqual(load(home).choices, [{ n: 1, ticket: 'T1', question: 'page size 0: error or default?', rule: 'reversible-default', answer: 'default to 20 (reversible)', at: NOW }]);
});

test('choice must-FAIL: coordinator / another ticket\'s implementer / the reviewer / an unvouched session record nothing; unknown ticket; blank text', (t) => {
  const home = mkHome(t); seed(home);
  const before = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  for (const who of ['r1', 'impl2', 'rev1']) { const r = choose(home, who); assert.equal(r.code, 2); assert.match(r.stderr, /^\[choice-caller\]/); }
  const unvouched = choose(home, 'impl1', 'T1', 'q', 'a', { source: 'env', why: 'no key' } as never);
  assert.equal(unvouched.code, 2); assert.match(unvouched.stderr, /^\[choice-caller\]/);
  assert.match(choose(home, 'impl1', 'T9').stderr, /^\[choice-unknown-ticket\]/);
  assert.match(choose(home, 'impl1', 'T1', 'q', '  ').stderr, /^\[choice-bad\]/);
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), before, 'a refusal writes nothing');
});

test('reviewer brief (#675): lists EVERY choice of the run under `## Choices of the run` — the ticket\'s own marked, the other tickets\' shown; no choice ⇒ no section', (t) => {
  const home = mkHome(t); seed(home);
  const none = renderBriefOf(load(home), 'T1', { kind: 'spawn', head: A, base: null }).text;
  assert.doesNotMatch(none, /Choices of the run|Choices recorded/);
  assert.equal(choose(home, 'impl1').code, 0);
  assert.equal(choose(home, 'impl2', 'T2', 'other question', 'other option').code, 0);
  const text = renderBriefOf(load(home), 'T1', { kind: 'spawn', head: A, base: null }).text;
  assert.match(text, /## Choices of the run\n[^\n]*\n1\. \[T1 — this ticket\] page size 0: error or default\? → TAKEN: default to 20 \(reversible\)\n   Choice 1 narrows: none declared\n2\. \[T2\] other question → TAKEN: other option\n   Choice 2 narrows: none declared/);
  assert.match(text, /--on-choice <finding>=<n>/);
});

test('record --on-choice: a finding about the choice does not block — approve is accepted, the report lists the finding and the choice; a code-vs-choice finding (no flag) still blocks', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl1').code, 0);
  // the code-vs-choice finding has no flag: approve is refused, nothing written
  const bad = rec(home, 'approve', { findings: { F1: F('the code answers 0 with an error although the choice says default to 20') } });
  assert.equal(bad.code, 2); assert.match(bad.stderr, /^\[approve-open-finding\]/);
  // the finding whose subject IS the choice: --on-choice
  const ok = rec(home, 'approve', { findings: { F2: F('an unasked product choice: page size 0 should be an error') } }, ['--on-choice', 'F2=1']);
  assert.equal(ok.code, 0, ok.stderr);
  const s = load(home);
  assert.equal(s.tickets.T1.findings.F2.onChoice, 1);
  assert.deepEqual(reviewCounts(s.tickets.T1, A), { blocking: 0, major: 0, minor: 0, open: [] });
  const gate = recordedVerdictOf(s, 'T1', A);
  assert.ok(gate.ok && gate.recorded.blocking === 0 && gate.recorded.major === 0 && gate.recorded.verdict === 'approve');
  const rep = buildReport(s);
  assert.deepEqual(rep.choices.map((c) => [c.n, c.ticket, c.answer]), [[1, 'T1', 'default to 20 (reversible)']]);
  assert.deepEqual(rep.findingsLeft.map((f) => [f.ticket, f.finding, f.end]), [['T1', 'F2', 'on-choice']]);
  const text = renderReport(rep);
  assert.match(text, /choices taken by the agents \(1\)[\s\S]*#1 T1 \[reversible-default\] page size 0.*TAKEN: default to 20/);
  assert.match(text, /T1\/F2 {2}MAJOR {2}on-choice: about choice 1/);
});

test('record --on-choice must-FAIL: a finding not in this record, a choice the ticket has not recorded (another ticket\'s too), a bad spelling', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl2', 'T2', 'q2', 'o2').code, 0); // choice 1 belongs to T2
  const body = { findings: { F1: F('a finding') } };
  const unknownFinding = rec(home, 'changes-requested', body, ['--on-choice', 'F9=1']);
  assert.equal(unknownFinding.code, 2); assert.match(unknownFinding.stderr, /^\[on-choice-finding\]/);
  const otherTicket = rec(home, 'changes-requested', body, ['--on-choice', 'F1=1']);
  assert.equal(otherTicket.code, 2); assert.match(otherTicket.stderr, /^\[on-choice-unknown\]/);
  const none = rec(home, 'changes-requested', body, ['--on-choice', 'F1=7']);
  assert.equal(none.code, 2); assert.match(none.stderr, /^\[on-choice-unknown\]/);
  assert.equal(rec(home, 'changes-requested', body, ['--on-choice', 'F1']).code, 1);
  assert.equal(load(home).tickets.T1.reviews, undefined, 'nothing was recorded');
});

test('--on-choice is not a coordinator move: `state set --finding-json` with an onChoice field is refused', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl1').code, 0);
  const r = runFanout(['state', 'set', 'T1', '--run', 'r1', '--finding-json', '{"F1":{"severity":"MAJOR","onChoice":1}}'], depsOf(home, 'r1'));
  assert.notEqual(r.code, 0, r.stdout);
  assert.equal(load(home).tickets.T1.findings.F1, undefined);
});

test('implementer brief (Boucle): names the command, no longer the PR-body section', () => {
  const s = applyTicketPatch(newState('r1', { now: NOW }), 'T1', { dependsOn: [] }, NOW);
  const text = renderImplementerBrief({ state: s, ticket: 'T1', loop: true });
  assert.match(text, /orchestra fanout choice <your ticket> --question/);
  assert.doesNotMatch(text, /## Choices/);
});
