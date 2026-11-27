// #605 — the Boucle on the dummy fleet: one pass of the real loop per scenario (src/shared/fanout-loop-scenarios/), judged from the event log. Each rule of #601 has a must-pass scenario AND a must-fail one
// (the judge on a log that breaks it); scripts/e2e-fanout-run.mjs mutates the loop and every mutant must turn one of these red.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDummy, parseScenario, planOf, runDummyLoop, type Scenario } from './fanout-loop-dummy.ts';
import { FIXED_ANSWER, LOOP_STEPS, ASK_MAX, LoopKilled, renderConnectAsk, runLoop, DEFAULT_OPTIONS, sortReady, transitiveDependents } from './fanout-loop.ts';
import { judgeRun, RULES, type Ev } from './fanout-loop-judge.ts';
import { readLoopState, updateLoopState, withLoop } from './fanout-loop-side.ts';
import { applyPlan } from './fanout-plan.ts';
import { startRun } from './fanout-start.ts';
import { applyTicketPatch, CHOICES_MAX, newState, parkTicket, pauseRun, recordChoice, resumeRun, sha256Hex, TICKET_STATUSES } from './fanout-state.ts';
import { buildReport, renderReport } from './fanout-report.ts';
import { LOOP_BRIEF, renderImplementerBrief } from './fanout-implementer-brief.ts';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fanout-loop-scenarios');
const load = (name: string): Scenario => parseScenario(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')));
const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-loop-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const go = (name: string, opts: Parameters<typeof runDummyLoop>[0]['options'] = {}) => runDummyLoop({ home: tmp(), scenario: load(name), options: { stallMs: 30 * 60_000, maxPasses: 1500, ...opts } });
const mergeOrder = (evs: Ev[]): string[] => evs.filter((e) => e.ev === 'merge').map((e) => String(e.ticket));

test('rts7: seven tickets, every one merged, exit 0, the judge finds nothing', async () => {
  const r = await go('rts7');
  assert.equal(r.result.exit, 0);
  assert.deepEqual(r.result.report.merged, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
  assert.deepEqual(r.result.report.parked, []);
  assert.deepEqual(r.violations, []);
});

test('decision 3 measured: every implementer has start.at before the first merge and coded while its upstream was unmerged', async () => {
  const home = tmp();
  const r = await runDummyLoop({ home, scenario: load('rts7') });
  const s = readLoopState(home, 'rts7')!;
  const firstMerge = r.world.events.find((e) => e.ev === 'merge')!.t;
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) assert.ok(s.tickets[id].start && Date.parse(s.tickets[id].start!.at) <= firstMerge, `${id} start.at`);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn').length, 7, 'one implementer per ticket, never a second');
  assert.equal(r.world.events.filter((e) => e.ev === 'pr-open').length, 7);
  for (const [tk, ups] of Object.entries({ T3: ['T1'], T5: ['T2', 'T3'], T7: ['T5', 'T6'] })) for (const up of ups) {
    const coded = r.world.events.find((e) => e.ev === 'code' && e.ticket === tk)!;
    const merged = r.world.events.find((e) => e.ev === 'merge' && e.ticket === up)!;
    assert.ok(coded.t < merged.t, `${tk} coded before ${up} merged`);
  }
});

test('MUST-FAIL decision 3: an implementer that waits for its upstream is named by the judge', async () => {
  const r = await go('implementer-waits');
  assert.equal(r.result.exit, 0, 'the run still ends — the instrument, not the run, says it broke the rule');
  assert.deepEqual(r.violations.map((v) => [v.rule, v.ticket]), [['implementer-waited', 'T2']]);
});

test('decision 4: each dependency edge gets exactly one connect ask, after the upstream approval and before its merge', async () => {
  const r = await go('rts7');
  const asks = r.world.events.filter((e) => e.ev === 'connect-ask');
  assert.equal(asks.length, 7, 'T3<-T1, T4<-T1, T5<-T2, T5<-T3, T6<-T4, T7<-T5, T7<-T6');
  for (const a of asks) {
    const approved = r.world.events.findIndex((e) => e.ev === 'review-record' && e.ticket === a.up && e.verdict === 'approve' && String(e.head) === String(a.head));
    const merged = r.world.events.findIndex((e) => e.ev === 'merge' && e.ticket === a.up);
    const at = r.world.events.indexOf(a);
    assert.ok(approved >= 0 && approved < at && at < merged, `${a.ticket} <- ${a.up}`);
    assert.match(String(a.head), /^[0-9a-f]{40}$/, 'the exact head');
  }
});

test('decision 5: a question gets the fixed answer and is listed; the run is not slowed into a park', async () => {
  const r = await go('question');
  assert.equal(r.result.exit, 0);
  assert.equal(r.result.report.merged.length, 7);
  assert.equal(r.result.report.choices.length, 1);
  assert.deepEqual([r.result.report.choices[0].ticket, r.result.report.choices[0].rule, r.result.report.choices[0].answer], ['T2', 'reversible-default', FIXED_ANSWER]);
  assert.deepEqual(r.violations, []);
});

test('decision 5 (#645): a "NO SAFE OPTION: …" body no longer parks — it gets the fixed answer, is listed as a reversible-default choice, and every ticket merges, exit 0', async () => {
  const r = await go('nosafe');
  assert.equal(r.result.exit, 0);
  assert.deepEqual(r.result.report.merged, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
  assert.deepEqual(r.result.report.parked, []);
  assert.deepEqual(r.result.report.choices.map((c) => [c.ticket, c.rule, c.answer]), [['T3', 'reversible-default', FIXED_ANSWER]]);
  assert.ok(r.world.events.some((e) => e.ev === 'answered' && e.ticket === 'T3'), 'T3 got its answer');
  assert.deepEqual(r.violations, []);
});

test('#645: the closing report lists the choices recorded `irreversible: …` FIRST (JSON: `irreversible` + choices ordered first; text: its own heading above merged)', () => {
  let st = applyPlan(newState('x', { target: 'main', switches: { seatRecords: 'on' }, now: N }), planOf(load('rts7')), N);
  st = recordChoice(st, { ticket: 'T2', question: 'name?', rule: 'reversible-default', answer: 'the short one' }, N);
  st = recordChoice(st, { ticket: 'T3', question: 'purge the stale rows?', rule: 'reversible-default', answer: 'irreversible: scripts/purge-stale.sql, run by hand after deploy' }, N);
  const r = buildReport(st);
  assert.deepEqual(r.irreversible.map((c) => c.ticket), ['T3']);
  assert.deepEqual(r.choices.map((c) => c.ticket), ['T3', 'T2'], 'irreversible first in the JSON choices too');
  const text = renderReport(r).split('\n');
  const iHead = text.findIndex((l) => /^IRREVERSIBLE/.test(l));
  assert.ok(iHead >= 0 && iHead < text.findIndex((l) => l.startsWith('merged:')), 'its own heading, before merged');
  assert.match(text[iHead + 1], /T3 purge the stale rows\? → irreversible: scripts\/purge-stale\.sql/);
  assert.equal(text.filter((l) => /^ {2}#\d+ T3/.test(l)).length, 1, 'not repeated under the plain choices');
  assert.deepEqual(buildReport(recordChoice(st, { ticket: 'T4', question: 'q', rule: 'reversible-default', answer: 'Irreversible : x' }, N)).irreversible.map((c) => c.ticket), ['T3', 'T4'], 'case and spacing tolerant');
  assert.equal(buildReport(recordChoice(newState('y', { target: 'main', switches: { seatRecords: 'on' }, now: N }), { ticket: 'T1', question: 'q', rule: 'reversible-default', answer: 'not irreversible: no' }, N)).irreversible.length, 0, 'the prefix, not a substring');
});

test('a start held by Admission is a wait, not a fault: nothing parked, everything merged', async () => {
  const r = await go('held');
  assert.equal(r.result.exit, 0);
  assert.equal(r.result.report.merged.length, 7);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.held === true).length, 2);
  assert.deepEqual(r.violations, []);
});

test('decision 10: two independent tickets that are ready in the same pass merge in READINESS order, not declaration order', async () => {
  const r = await go('readiness');
  assert.deepEqual(mergeOrder(r.world.events), ['B', 'A'], 'B was approved 40 s before A although A is declared first');
  const [mb, ma] = r.world.events.filter((e) => e.ev === 'merge');
  assert.equal(mb.t, ma.t, 'same pass: the order is the loop\'s own, not the clock\'s');
  assert.deepEqual(r.violations, []);
});

test('#649: A (2 transitive dependents) and B (none) both ready in one pass — A merges first although B was ready 40 s earlier; the chain then follows', async () => {
  const r = await go('most-depended');
  assert.equal(r.result.exit, 0);
  const order = mergeOrder(r.world.events);
  assert.ok(order.indexOf('A') < order.indexOf('B'), `A before B: ${order.join(',')}`);
  assert.deepEqual(order.filter((t) => t !== 'B'), ['A', 'C', 'D']);
  assert.deepEqual(r.violations, []);
});
test('#649: tied dependents keep readiness order (B before A, both without dependents)', async () => {
  const r = await go('readiness');
  assert.deepEqual(mergeOrder(r.world.events), ['B', 'A']);
});
test('#649: transitiveDependents counts unfinished dependents only, through the chain, cycle-safe; sortReady = dependents desc, then readiness', () => {
  const t = (dependsOn: string[], status = 'nominated') => ({ dependsOn, status });
  assert.deepEqual(transitiveDependents({ A: t([]), B: t([]), C: t(['A']), D: t(['C']) }), { A: 2, B: 0, C: 1, D: 0 });
  assert.deepEqual(transitiveDependents({ A: t([]), C: t(['A']), D: t(['C'], 'merged') }), { A: 1, C: 0, D: 0 }, 'a merged dependent is no longer at risk');
  assert.deepEqual(transitiveDependents({ A: t(['B']), B: t(['A']) }), { A: 1, B: 1 }, 'a cycle terminates');
  const r = (id: string, dependents: number, readyAt: number, order: number) => ({ id, dependents, readyAt, order });
  assert.deepEqual(sortReady([r('B', 0, 1, 1), r('A', 2, 9, 0), r('X', 0, 1, 0)]).map((x) => x.id), ['A', 'X', 'B']);
});
test('#649: the judge accepts the most-depended-first order and refuses a ready ticket with more dependents merged after one with fewer', () => {
  const ev = (rest: Ev[]): Ev[] => [{ t: 0, ev: 'spawn', ticket: 'A' }, { t: 0, ev: 'spawn', ticket: 'B' },
    { t: 20, ev: 'ci-start', ticket: 'A', head: H('a'), doneAt: 25, result: 'green' }, { t: 20, ev: 'ci-start', ticket: 'B', head: H('b'), doneAt: 25, result: 'green' },
    { t: 40, ev: 'review-record', ticket: 'A', head: H('a'), verdict: 'approve' }, { t: 30, ev: 'review-record', ticket: 'B', head: H('b'), verdict: 'approve' }, ...rest];
  const deps = { A: [], B: [], C: ['A'] };
  const judge = (rest: Ev[]) => judgeRun({ events: ev(rest), deps, tickets: ['A', 'B', 'C'], startAt: {} }).map((x) => x.rule);
  const mA = { t: 50, ev: 'merge', ticket: 'A', head: H('a'), ci: 'green' } as Ev, mB = { t: 50, ev: 'merge', ticket: 'B', head: H('b'), ci: 'green' } as Ev;
  assert.ok(!judge([mA, mB]).includes('merge-order'), 'A (1 dependent) first although B was ready earlier');
  assert.ok(judge([mB, mA]).includes('merge-order'), 'B first while A, with a dependent, was ready');
});
test('#649: the closing report counts re-connects and extra review rounds, per run and per ticket', async () => {
  const mv = await go('upstream-moves', { stallMs: 4 * 3_600_000 });
  assert.deepEqual(mv.result.report.moves.reconnects, { total: 1, perTicket: { T1: 0, T2: 1 } }, 'T2 was asked again because T1 moved');
  assert.match(renderReport(mv.result.report), /re-connects \(a CONNECT sent again because the upstream moved\): 1 — T2 1/);
  const cr = await go('corrections-fix');
  const rr = cr.result.report.moves.extraReviewRounds;
  assert.deepEqual(rr, { total: 1, perTicket: { ...Object.fromEntries(Object.keys(rr.perTicket).map((k) => [k, 0])), T1: 1 } }, 'T1: changes-requested then approve = one round beyond the first');
  assert.equal(cr.result.report.moves.reconnects!.total, 0);
  assert.match(renderReport(cr.result.report), /extra review rounds \(beyond the first\): 1 — T1 1/);
  assert.deepEqual((await go('readiness')).result.report.moves, { reconnects: { total: 0, perTicket: { A: 0, B: 0 } }, extraReviewRounds: { total: 0, perTicket: { A: 0, B: 0 } } });
});
test('#675 (dummy fleet): a choice that NARROWS a ticket sentence is challenged — the reviewer\'s finding quoting it, cited `--on-choice`, is NOT exempt: it blocks, the author gets the batch with every choice of the run, the fix is read and the ticket merges', async () => {
  const home = tmp();
  const r = await runDummyLoop({ home, scenario: load('narrowing-choice'), options: { stallMs: 30 * 60_000, maxPasses: 1500 } });
  assert.equal(r.result.exit, 0, r.world.events.filter((e) => e.ev === 'review-error').map((e) => String(e.error)).join('; '));
  assert.deepEqual(r.result.report.merged, ['T1', 'T2']);
  const recs = r.world.events.filter((e) => e.ev === 'review-record' && e.ticket === 'T1').map((e) => e.verdict);
  assert.deepEqual(recs, ['changes-requested', 'approve'], 'the narrowing finding blocked once, then the fix was approved');
  const s = readLoopState(home, 'narrowing-choice')!;
  assert.equal(s.tickets.T1.findings.F1.onChoice, undefined, 'the exemption did not apply');
  assert.equal(s.choices![0].narrows, 'A later manual trigger gets the same effect as the carrier status.');
  assert.deepEqual(s.tickets.T1.reviews![1].criteria, { '1': 'met' }, 'the approve answered the numbered criterion');
  const batch = String(r.world.events.find((e) => e.ev === 'corrections-batch' && e.ticket === 'T1')?.text ?? '');
  assert.match(batch, /F1 MAJOR/);
  assert.match(batch, /## Choices of the run[\s\S]*Choice 1 narrows: « A later manual trigger gets the same effect as the carrier status\. »/);
});
test('#680 (dummy fleet): an UNMET contract blocks — the owner\'s reviewer answers c1 unmet, the author gets the batch with the contract, the fix is approved (met) and both owner and consumer merge; the report lists the contract with its final verdicts', async () => {
  const home = tmp();
  const r = await runDummyLoop({ home, scenario: load('contract-unmet'), options: { stallMs: 30 * 60_000, maxPasses: 1500 } });
  assert.equal(r.result.exit, 0, r.world.events.filter((e) => e.ev === 'review-error').map((e) => String(e.error)).join('; '));
  assert.deepEqual(r.result.report.merged, ['T1', 'T2', 'T3']);
  assert.deepEqual(r.world.events.filter((e) => e.ev === 'review-record' && e.ticket === 'T1').map((e) => e.verdict), ['changes-requested', 'approve'], 'the unmet contract blocked once');
  const s = readLoopState(home, 'contract-unmet')!;
  assert.equal(s.tickets.T1.findings['contract-c1'].severity, 'BLOCKING');
  assert.deepEqual(s.tickets.T1.reviews!.map((x) => x.contracts), [{ c1: 'unmet' }, { c1: 'met' }]);
  assert.deepEqual(s.tickets.T2.reviews![0].contracts, { c1: 'met' }, 'the consumer answered met');
  assert.deepEqual(s.tickets.T2.reviews![0].contractEvidence, { c1: 'src/T2.ts:1' }, 'with its evidence line');
  assert.equal(s.tickets.T3.reviews![0].contracts, undefined, 'T3 is part of no contract: nothing to answer');
  const batch = String(r.world.events.find((e) => e.ev === 'corrections-batch' && e.ticket === 'T1')?.text ?? '');
  assert.match(batch, /contract-c1 BLOCKING — contract c1 is unmet on this head: T1 must — every path that sets the state/);
  assert.deepEqual(r.result.report.contracts, [{ id: 'c1', owner: 'T1', must: 'every path that sets the state dispatches the event through one function', owned: 'met', consumers: [{ ticket: 'T2', answer: 'met' }] }]);
  assert.match(renderReport(r.result.report), /contracts of the plan \(1\)[^\n]*\n  c1: T1 \[met\] must every path that sets the state dispatches the event through one function — consumers: T2 \[met\]/);
});
test('decision 8 (#607, composed): red CI → one re-run → the author is told the check → the same failure after its fix parks the ticket, its dependent with it; a red CI is never merged', async () => {
  const r = await go('red-ci');
  assert.equal(r.result.exit, 3);
  assert.deepEqual(r.result.report.merged, ['T2']);
  assert.deepEqual(r.result.report.parked.map((p) => [p.ticket, p.cause]), [['T1', 'ci'], ['T3', 'upstream']]);
  assert.equal(r.world.events.filter((e) => e.ev === 'ci-start' && e.ticket === 'T1').length, 3, 'run 1, the ONE re-run, the run of the fix');
  const told = r.world.events.filter((e) => e.ev === 'ci-told');
  assert.equal(told.length, 1, 'the author hears once');
  assert.match(String(told[0].text), /Check: test/);
  assert.ok(r.world.events.every((e) => e.ev !== 'merge' || e.ci === 'green'));
  assert.deepEqual(r.violations, []);
});

test('decision 8 (#607, composed): a flaky red goes green on the re-run → merged, listed as flaky in the report, nobody was told', async () => {
  const r = await go('ci-flaky');
  assert.equal(r.result.exit, 0);
  assert.deepEqual(r.result.report.merged, ['T1', 'T2', 'T3']);
  assert.deepEqual(r.result.report.flaky, ['T1/test']);
  assert.equal(r.world.events.filter((e) => e.ev === 'ci-told').length, 0);
  assert.deepEqual(r.violations, []);
});

test('decision 8 (#607 + #655, composed): the same check red on two pull requests AFTER their re-run → the run PAUSES and stays alive: no author told, no merge while paused, it re-runs with backoff, lifts itself on the first green and finishes (never exit 4)', async () => {
  const r = await go('ci-env');
  assert.equal(r.result.exit, 0, 'a pause no longer ends the run');
  assert.equal(r.result.report.paused, null, 'lifted by itself');
  const w = r.result.report.waited;
  assert.equal(w.length, 1);
  assert.equal(w[0].check, 'build');
  assert.equal(w[0].prs.length, 2);
  assert.ok(w[0].reruns >= 1 && w[0].ms >= 2 * 60_000, `waited ${w[0].ms} ms, ${w[0].reruns} re-run(s)`);
  assert.equal(r.world.events.filter((e) => e.ev === 'ci-told').length, 0);
  const firstMerge = Math.min(...r.world.events.filter((e) => e.ev === 'merge').map((e) => Number(e.t)));
  assert.ok(firstMerge >= Date.parse(w[0].until), 'a paused run merges nothing');
  assert.match(renderReport(r.result.report), /waited \d+ min on the environment/);
  assert.deepEqual(r.violations, []);
});

const withStartCheck = (startCheck: string): Scenario => ({ ...load('readiness'), startCheck });
test('decision 9 (#607, composed): --start-check green → an empty PR into the target, awaited, closed, its branch deleted → then the run goes on and merges', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: withStartCheck('green'), options: { startCheck: true, stallMs: 30 * 60_000, maxPasses: 1500 } });
  assert.equal(r.result.exit, 0);
  const opened = r.world.events.filter((e) => e.ev === 'pr-open' && /^orchestra-start-check-/.test(String(e.branch)));
  assert.equal(opened.length, 1);
  assert.equal(r.world.events.filter((e) => e.ev === 'pr-close').length, 1);
  assert.equal(r.world.events.filter((e) => e.ev === 'branch-delete').length, 1);
  assert.ok(r.world.events.findIndex((e) => e.ev === 'pr-close') < r.world.events.findIndex((e) => e.ev === 'spawn'), 'the check came BEFORE the first implementer');
});

for (const [startCheck, code] of [['red:ci', 'start-check-red'], ['missing', 'start-check-missing']] as const) {
  test(`decision 9 (#607, composed): --start-check with a ${startCheck} probe → [run-${code}], exit 2, NOTHING launched, the probe PR closed and its branch deleted`, async () => {
    const r = await runDummyLoop({ home: tmp(), scenario: withStartCheck(startCheck), options: { startCheck: true, stallMs: 30 * 60_000, maxPasses: 1500, startCheckMissingMs: 120_000 } });
    assert.equal(r.result.exit, 2);
    assert.match(r.result.reason ?? '', new RegExp(`^\\[run-${code}\\]`));
    assert.equal(r.world.events.filter((e) => e.ev === 'spawn').length, 0);
    assert.equal(r.world.events.filter((e) => e.ev === 'pr-close').length, 1);
    assert.equal(r.world.events.filter((e) => e.ev === 'branch-delete').length, 1);
  });
}

test('story 21 (#608 + #605, composed): the report of a run carries the cost per ticket, READ from the fleet — none is null', async () => {
  const r = await go('rts7');
  assert.equal(r.result.exit, 0);
  const costs = r.result.report.costPerTicket;
  assert.deepEqual(Object.keys(costs), r.result.report.merged);
  assert.ok(Object.values(costs).every((c) => c !== null && c.tokens > 0), JSON.stringify(costs));
});

test('decision 10: a ticket whose reviewer asked for changes is never merged (no recorded approval)', async () => {
  const r = await go('changes-requested');
  assert.deepEqual(r.result.report.merged, ['T2']);
  assert.deepEqual(r.result.report.parked.map((p) => p.ticket), ['T1']);
  assert.ok(r.world.events.some((e) => e.ev === 'review-record' && e.ticket === 'T1' && e.verdict === 'changes-requested'));
  assert.deepEqual(r.violations, []);
});

test('the loop is the only reader of the run\'s mail: every read is the loop\'s', async () => {
  const r = await go('rts7');
  const reads = r.world.events.filter((e) => e.ev === 'mail-read');
  assert.ok(reads.length > 10);
  assert.ok(reads.every((e) => e.reader === 'loop'));
});

test('MUST-FAIL one reader: a message read by someone else is named, and the question it carried is never answered', async () => {
  const r = await go('steal-mail');
  const rules = new Set(r.violations.map((v) => v.rule));
  assert.ok(rules.has('mail-read-by-other') && rules.has('question-unanswered'), [...rules].join(','));
  assert.deepEqual(r.result.report.merged, []);
  assert.equal(r.result.exit, 3);
});

// ── the judge: every rule has a log that breaks it (an instrument that cannot fail measures nothing) ─────────────────
const H = (c: string): string => c.repeat(40);
const base = (): Ev[] => [
  { t: 0, ev: 'spawn', ticket: 'A' }, { t: 0, ev: 'spawn', ticket: 'B' }, { t: 10, ev: 'code', ticket: 'A' }, { t: 10, ev: 'code', ticket: 'B' },
  { t: 20, ev: 'ci-start', ticket: 'A', head: H('a'), doneAt: 25, result: 'green' }, { t: 21, ev: 'review-record', ticket: 'A', head: H('a'), verdict: 'approve' },
  { t: 30, ev: 'merge', ticket: 'A', head: H('a'), ci: 'green' },
];
const judge = (events: Ev[], deps: Record<string, string[]> = { A: [], B: ['A'] }, startAt: Record<string, number | null> = { A: 0, B: 0 }) => judgeRun({ events, deps, tickets: ['A', 'B'], startAt });
test('judge: the clean log is clean', () => assert.deepEqual(judge(base()), []));
test('judge MUST-FAIL: each rule fires on a log that breaks it', () => {
  const rules = (events: Ev[], deps?: Record<string, string[]>, startAt?: Record<string, number | null>): string[] => [...new Set(judge(events, deps, startAt).map((v) => v.rule))];
  assert.ok(rules(base(), undefined, { A: 0, B: null }).includes('start-all-before-first-merge'));
  assert.ok(rules(base(), undefined, { A: 0, B: 99 }).includes('start-all-before-first-merge'));
  assert.ok(rules([...base().filter((e) => !(e.ev === 'code' && e.ticket === 'B')), { t: 40, ev: 'code', ticket: 'B' }]).includes('implementer-waited'));
  assert.ok(rules([...base(), { t: 1, ev: 'spawn', ticket: 'A' }]).includes('duplicate-agent'));
  assert.ok(!rules([...base(), { t: 1, ev: 'impl-died', ticket: 'A' }, { t: 2, ev: 'spawn', ticket: 'A' }]).includes('duplicate-agent'), 'a replacement AFTER a death is not a duplicate');
  assert.ok(rules([...base(), { t: 1, ev: 'pr-open', ticket: 'A' }, { t: 2, ev: 'pr-open', ticket: 'A' }]).includes('duplicate-agent'));
  assert.ok(rules([{ t: 5, ev: 'connect-ask', ticket: 'B', up: 'A', head: H('a') }, ...base()]).includes('connected-before-approval'));
  assert.ok(rules([...base(), { t: 31, ev: 'connect-ask', ticket: 'B', up: 'A', head: H('a') }]).includes('connected-after-merge'));
  assert.ok(rules([...base(), { t: 22, ev: 'connect-ask', ticket: 'B', up: 'A', head: H('a') }, { t: 23, ev: 'connect-ask', ticket: 'B', up: 'A', head: H('a') }].sort((a, b) => a.t - b.t)).includes('connect-asked-twice'));
  assert.ok(rules(base().filter((e) => e.ev !== 'review-record')).includes('merge-no-approval'));
  assert.ok(rules(base().map((e) => (e.ev === 'merge' ? { ...e, ci: 'red:test' } : e))).includes('merge-ci-not-green'));
  assert.ok(rules([...base().slice(0, 6), { t: 22, ev: 'review-record', ticket: 'A', head: H('a'), verdict: 'changes-requested' }, base()[6]]).includes('merge-no-approval'), 'a later changes-requested on the same head voids the approve');
  assert.ok(rules(base().map((e) => (e.ev === 'review-record' ? { ...e, head: H('c') } : e))).includes('merge-no-approval'), 'an approval of ANOTHER head is not the head that merged');
  const unmerged = [{ t: 0, ev: 'spawn', ticket: 'B' }, { t: 5, ev: 'code', ticket: 'B' }, { t: 21, ev: 'review-record', ticket: 'B', head: H('b'), verdict: 'approve' }, { t: 30, ev: 'merge', ticket: 'B', head: H('b'), ci: 'green' }] as Ev[];
  assert.ok(rules(unmerged).includes('merge-upstream-unmerged'));
  const order: Ev[] = [
    { t: 0, ev: 'spawn', ticket: 'A' }, { t: 0, ev: 'spawn', ticket: 'B' },
    { t: 20, ev: 'ci-start', ticket: 'A', head: H('a'), doneAt: 25, result: 'green' }, { t: 20, ev: 'ci-start', ticket: 'B', head: H('b'), doneAt: 25, result: 'green' },
    { t: 40, ev: 'review-record', ticket: 'A', head: H('a'), verdict: 'approve' }, { t: 30, ev: 'review-record', ticket: 'B', head: H('b'), verdict: 'approve' },
    { t: 50, ev: 'merge', ticket: 'A', head: H('a'), ci: 'green' }, { t: 50, ev: 'merge', ticket: 'B', head: H('b'), ci: 'green' },
  ];
  assert.ok(rules(order, { A: [], B: [] }).includes('merge-order'));
  assert.ok(!rules([...order.slice(0, 6), order[7], order[6]], { A: [], B: [] }).includes('merge-order'), 'the same log merged in readiness order is clean');
  assert.ok(rules([{ t: 1, ev: 'ask', ticket: 'A', kind: 'question', ws: 'w' }]).includes('question-unanswered'));
  assert.ok(rules([{ t: 1, ev: 'ask', ticket: 'A', kind: 'question', ws: 'w' }, { t: 2, ev: 'send', kind: 'answer', to: 'w', text: 'do whatever' }]).includes('question-unanswered'), 'only the FIXED answer counts');
  assert.ok(!rules([{ t: 1, ev: 'ask', ticket: 'A', kind: 'question', ws: 'w' }, { t: 2, ev: 'send', kind: 'answer', to: 'w', text: FIXED_ANSWER }]).includes('question-unanswered'));
  assert.ok(rules([{ t: 1, ev: 'mail-read', ticket: 'A', reader: 'someone', seq: 1, kind: 'ask' }]).includes('mail-read-by-other'));
  for (const rule of RULES) assert.ok(typeof rule === 'string');
});

// ── frozen names ────────────────────────────────────────────────────────────────────────────────────────────────────
test('frozen names: the steps, the fixed answer', () => {
  assert.deepEqual([...LOOP_STEPS], ['reconcile', 'plan', 'start', 'mail', 'nominations', 'open', 'review', 'approvals', 'connect', 'ci', 'corrections', 'deliver', 'end']);
  assert.equal(FIXED_ANSWER, 'Take the reversible option unless the spec imposes the action; an irreversible need is code or a script in your PR that you never run. Record it with `orchestra fanout choice <your ticket> --question "<the question>" --taken "<the option>"` (for an irreversible need: `--taken "irreversible: <what, run by hand>"`), continue. Do not wait for anyone.');
  assert.match(renderConnectAsk({ ticket: 'T3', upstream: 'T1', branch: 'impl-T1', head: H('a') }), new RegExp(`^CONNECT T1 ${H('a')}\\n`));
  assert.match(renderConnectAsk({ ticket: 'T3', upstream: 'T1', branch: 'impl-T1', head: H('a') }), /MERGE COMMIT/);
});
test('the loop writes the REAL #603 records: choices and the pause live in state.json — the sidecar holds the loop-only fields', async () => {
  const home = tmp();
  const r = await runDummyLoop({ home, scenario: load('nosafe'), options: { stallMs: 30 * 60_000 } });
  const st = JSON.parse(fs.readFileSync(path.join(home, 'fanout', 'nosafe', 'state.json'), 'utf8'));
  assert.deepEqual(['T3', 'T5', 'T7'].map((id) => [st.tickets[id].status, st.tickets[id].parked ?? null]), [['merged', null], ['merged', null], ['merged', null]]);
  assert.deepEqual(st.choices.map((c: { ticket: string; rule: string }) => [c.ticket, c.rule]), [['T3', 'reversible-default']]);
  const side = JSON.parse(fs.readFileSync(path.join(home, 'fanout', 'nosafe', 'loop.json'), 'utf8'));
  for (const k of ['parked', 'choices', 'pause', 'rounds']) assert.equal(k in side, false, `${k} is not in the sidecar any more`);
  assert.deepEqual(Object.keys(side).sort(), ['asked', 'askedTo', 'busySince', 'checksSeen', 'handled', 'held', 'orders', 'pointOrders', 'reconnects', 'replaced', 'signalled']);
  assert.deepEqual(r.result.report.parked, []);
});
test('exit 4: a paused run stops, and resumes where it was when run again', async () => {
  const home = tmp();
  const sc = load('rts7');
  const d = buildDummy({ home, run: 'rts7', scenario: sc });
  let paused = false;
  const fleet = { ...d.fleet, async start() { const r = await d.fleet.start(); if (!paused) { paused = true; updateLoopState(home, 'rts7', (cur) => pauseRun(cur!, { reason: 'same check red on 3 PRs', check: 'build', prs: [1, 2, 3] }, d.now())); } return r; } };
  const deps = { home, run: 'rts7', caller: 'rts7', fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan } };
  const first = await runLoop(deps);
  assert.equal(first.exit, 4);
  assert.equal(first.report.paused?.check, 'build');
  updateLoopState(home, 'rts7', (cur) => resumeRun(cur!, d.now()));
  const second = await runLoop(deps);
  assert.equal(second.exit, 0);
  assert.equal(second.report.merged.length, 7);
  assert.equal(d.world.events.filter((e) => e.ev === 'spawn').length, 7, 'resuming started no second agent');
});
test('scenario v1: a malformed file is refused naming what is wrong', () => {
  assert.throws(() => parseScenario({ version: 2 }), /version must be 1/);
  assert.throws(() => parseScenario({ version: 1, repo: { tickets: [] } }), /non-empty/);
  assert.throws(() => parseScenario({ version: 1, repo: { tickets: [{ id: 'A', dependsOn: ['Z'], spec: 's' }] } }), /unknown Z/);
  assert.throws(() => parseScenario({ version: 1, repo: { tickets: [{ id: 'A', dependsOn: [], spec: 's' }] }, ci: { A: ['blue'] } }), /"green" \| "red:<check>"/);
  assert.throws(() => parseScenario({ version: 1, repo: { tickets: [{ id: 'A', dependsOn: [], spec: 's' }] }, agents: { A: { implementer: [{ do: 'approve' }] } } }), /a step is/);
  assert.throws(() => parseScenario({ version: 1, repo: { tickets: [{ id: 'A', dependsOn: [], spec: 's' }] }, events: { A: [{ at: 'code', kind: 'panic' }] } }), /question\|no-safe-option/);
});

test('decision 10: a CI still running is a wait — the merge comes after it ends, on a green', async () => {
  const r = await go('slow-ci');
  assert.equal(r.result.exit, 0);
  const merges = r.world.events.filter((e) => e.ev === 'merge');
  assert.equal(merges.length, 2);
  for (const m of merges) { assert.equal(m.ci, 'green'); assert.ok(m.t >= Date.parse('2026-01-01T00:19:00Z'), 'not before the CI ended (4 + 15 min)'); }
  assert.deepEqual(r.violations, []);
});
test('decision 10: an approval of an OLD head does not merge a new head (the reviewer is asked again and its record is awaited)', async () => {
  const r = await go('stale-approval', { stallMs: 4 * 3_600_000 });
  assert.equal(r.result.exit, 0);
  const m = r.world.events.find((e) => e.ev === 'merge')!;
  const records = r.world.events.filter((e) => e.ev === 'review-record');
  assert.equal(records.length, 2);
  assert.equal(String(m.head), String(records[1].head), 'merged on the head the SECOND record speaks about');
  assert.ok(m.t >= records[1].t);
  assert.notEqual(String(records[0].head), String(m.head));
  assert.deepEqual(r.violations, []);
});

test('decision 12: killed between reading the mail and writing the nomination, the loop started again still nominates (the signal is durable, the mail is gone)', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'rts7', scenario: load('rts7') });
  let crashed = false;
  const git = { ...d.git, async head(b: string) { if (!crashed && b === 'impl-T1' && d.world.events.some((e) => e.ev === 'mail-read' && e.ticket === 'T1')) { crashed = true; throw new LoopKilled('killed mid-pass'); } return d.git.head(b); } };
  const deps = { home, run: 'rts7', caller: 'rts7', fleet: d.fleet, forge: d.forge, git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } };
  await assert.rejects(runLoop(deps), /killed mid-pass/);
  const again = await runLoop(deps);
  assert.equal(again.exit, 0);
  assert.equal(again.report.merged.length, 7);
  assert.equal(d.world.events.filter((e) => e.ev === 'spawn').length, 7, 'no second agent for any ticket');
  assert.equal(d.world.events.filter((e) => e.ev === 'pr-open').length, 7, 'no second pull request');
});

test('an upstream that moves after it was approved: the dependent connected to the OLD head is asked again, no crash, merged in order (pre-review BLOCKING)', async () => {
  const r = await go('upstream-moves', { stallMs: 4 * 3_600_000 });
  assert.equal(r.result.exit, 0);
  assert.deepEqual(mergeOrder(r.world.events), ['T1', 'T2']);
  const asks = r.world.events.filter((e) => e.ev === 'connect-ask' && e.ticket === 'T2');
  assert.equal(asks.length, 2, 'asked at the first approved head, then at the new one');
  assert.notEqual(String(asks[0].head), String(asks[1].head));
  assert.equal(r.world.events.filter((e) => e.ev === 'send' && e.kind === 'status').length, 0, 'the loop handled it itself: no refusal was relayed to an author');
  assert.deepEqual(r.violations, []);
});
test('#629: a dependent whose agent never records --follows is nominated and merged — the loop records the follows itself and the log says what was written', async () => {
  const r = await go('follows-missing');
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.deepEqual([...r.result.report.merged].sort(), ['T1', 'T2', 'T3']);
  assert.deepEqual(r.result.report.parked, []);
  assert.ok(r.log.some((l) => /T2: recorded follows T1=\d+/.test(l)), 'the loop says it recorded the follows');
  assert.ok(!r.log.some((l) => /T2 nominated/.test(l) && /refused|cannot/.test(l)));
  assert.deepEqual(r.violations, []);
});

test('decision 12 (OPS arm): killed after openPr and before the state write, the restart calls openPr again and gets the SAME PR — never a second one', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'rts7', scenario: load('rts7') });
  let crashed = false;
  const forge = { ...d.forge, async openPr(i: Parameters<typeof d.forge.openPr>[0]) { const r = await d.forge.openPr(i); if (!crashed) { crashed = true; throw new LoopKilled('killed after openPr'); } return r; } };
  const deps = { home, run: 'rts7', caller: 'rts7', fleet: d.fleet, forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } };
  await assert.rejects(runLoop(deps), /killed after openPr/);
  assert.equal(readLoopState(home, 'rts7')!.tickets.T1.pr, null, 'the crash really landed between the forge call and the state write');
  const again = await runLoop(deps);
  assert.equal(again.exit, 0);
  assert.equal(again.report.merged.length, 7);
  assert.equal(d.world.events.filter((e) => e.ev === 'pr-open').length, 7, 'one pull request per ticket, the first one adopted');
  assert.deepEqual(judgeRun({ events: d.world.events, deps: { T1: [] }, tickets: ['T1'], startAt: { T1: 0 } }).filter((v) => v.rule === 'duplicate-agent'), []);
});
test('the dummy forge hands out a NEW jobId when a check is re-run (Interface log v1.1)', async () => {
  const d = buildDummy({ home: tmp(), run: 'x', scenario: load('held') });
  const w = d.world;
  w.commits.set('a'.repeat(40), { parents: [], tree: 't', at: w.t });
  w.branches.set('b', 'a'.repeat(40));
  const n = w.openPr('b', 'T1');
  w.advance(10 * 60_000);
  const first = w.checks(n, 'a'.repeat(40)).map((c) => c.jobId);
  w.rerun(n);
  w.advance(10 * 60_000);
  const second = w.checks(n, 'a'.repeat(40)).map((c) => c.jobId);
  assert.ok(first.every((j, i) => j && j !== second[i]));
});

// ── review 605 r1 ───────────────────────────────────────────────────────────────────────────────────────────────────
const depsOf = (home: string, d: ReturnType<typeof buildDummy>, over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => ({ home, run: d.world.run, caller: d.world.run, fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000, ...opts }, ...over });
const sc = (name: string, patch: Partial<Scenario>): Scenario => ({ ...load(name), ...patch });

test('MAJOR-1: a send that throws mid-stepMail is retried next pass: the question is answered and listed ONCE', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'question', scenario: load('question') });
  let thrown = false, answers = 0;
  const fleet = { ...d.fleet, async send(to: string, text: string, kind: 'status' | 'answer') { if (kind === 'answer' && !thrown) { thrown = true; throw new Error('bus down'); } if (kind === 'answer') answers++; return d.fleet.send(to, text, kind); } };
  const r = await runLoop(depsOf(home, d, { fleet }));
  assert.equal(r.exit, 0);
  assert.equal(answers, 1);
  assert.equal(r.report.choices.length, 1, 'listed once: the choice was written before the first (failed) send and not again');
});
test('MAJOR-1: killed between the choice and the answer, the restart answers and lists the question (and the mail is acked only after)', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'question', scenario: load('question') });
  let killed = false;
  const fleet = { ...d.fleet, async send(to: string, text: string, kind: 'status' | 'answer') { if (kind === 'answer' && !killed) { killed = true; throw new LoopKilled('killed before the answer'); } return d.fleet.send(to, text, kind); } };
  await assert.rejects(runLoop(depsOf(home, d, { fleet })), /killed before the answer/);
  assert.equal(readLoopState(home, 'question')!.choices?.length, 1, 'the choice is durable before the answer goes out');
  assert.ok(d.world.drainMail().some((m) => m.kind === 'ask'), 'and the mail was NOT acked: the restart is handed it again');
  const again = await runLoop(depsOf(home, d));
  assert.equal(again.exit, 0);
  assert.equal(again.report.choices.length, 1);
  assert.equal(again.report.merged.length, 7);
  assert.ok(d.world.events.some((e) => e.ev === 'answered'), 'T2 got its answer');
});
test('MAJOR-1: a NO SAFE OPTION ask in a batch killed before its ack is answered and listed once on restart (#645: it no longer parks)', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'nosafe', scenario: load('nosafe') });
  let killed = false;
  const fleet = { ...d.fleet, async ack(n: number) { if (!killed && d.world.events.some((e) => e.ev === 'ask' && e.kind === 'no-safe-option')) { killed = true; throw new LoopKilled('killed before the ack'); } return d.fleet.ack(n); } };
  await assert.rejects(runLoop(depsOf(home, d, { fleet })), /killed before the ack/);
  const again = await runLoop(depsOf(home, d));
  assert.equal(again.exit, 0);
  assert.deepEqual(again.report.parked, []);
  assert.equal(again.report.choices.length, 1);
  assert.equal(d.world.events.filter((e) => e.ev === 'send' && e.kind === 'answer' && e.ticket === 'T3').length, 1, 'the handled ask is not answered a second time');
});
test('MAJOR-2: a check set that is not identical on two polls is not green — a late-registering workflow does not let a lone `lint` merge', async () => {
  const r = await go('late-check');
  assert.equal(r.result.exit, 0);
  assert.ok(r.world.events.filter((e) => e.ev === 'merge').every((e) => e.ci === 'green'));
  assert.deepEqual(r.violations, []);
});
test('MAJOR-2: a green that ran 0 steps is refused (the ticket is never merged)', async () => {
  const r = await go('zero-step-ci');
  assert.deepEqual(r.result.report.merged, ['B']);
  assert.deepEqual(r.result.report.parked.map((p) => p.ticket), ['A']);
  assert.ok(!r.world.events.some((e) => e.ev === 'merge' && e.ticket === 'A'));
});
test('MAJOR-2: the dummy forge merges by MERGE COMMIT only — a squash is refused (and the loop asks for a merge)', async () => {
  const d = buildDummy({ home: tmp(), run: 'x', scenario: load('held') });
  const w = d.world;
  w.commits.set('a'.repeat(40), { parents: [], tree: 't', at: w.t });
  w.branches.set('b', 'a'.repeat(40));
  const n = w.openPr('b', 'T1');
  assert.equal(w.merge(n, 'a'.repeat(40), 'squash').ok, false);
  assert.equal(w.merge(n, 'a'.repeat(40), 'rebase').ok, false);
  assert.equal(w.merge(n, 'a'.repeat(40), 'merge').ok, true);
  assert.equal(w.commits.get(w.branches.get('main')!)!.parents.length, 2, 'a two-parent merge commit');
});
test('MINOR-1 (#645): whatever the spelling of NO SAFE OPTION, the ticket is answered with the fixed answer and goes on — nothing parks', async () => {
  for (const body of ['NO SAFE OPTION: x', 'NO SAFE OPTION:\nthe reason', 'no safe option: x', '  NO SAFE OPTION: x', 'Hello\nNO SAFE OPTION: x', 'No-Safe_Option - x']) {
    const s = sc('nosafe', { events: { T3: [{ at: 'code', kind: 'no-safe-option', body } as never] } });
    const r = await runDummyLoop({ home: tmp(), scenario: s, options: { stallMs: 30 * 60_000 } });
    assert.deepEqual(r.result.report.parked, [], body);
    assert.equal(r.result.exit, 0, body);
    assert.equal(r.result.report.choices.filter((c) => c.rule === 'reversible-default').length, 1, `${body} was answered with the fixed answer`);
  }
});
test('MINOR-2: a held start, a CI and a reviewer that take 5 h are waits (bounded: they feed the 4 h clock for up to its length), not a stall', async () => {
  const long = { stallMs: 4 * 3_600_000 };
  const held = await runDummyLoop({ home: tmp(), scenario: sc('held', { admissionHold: { T2: 300 } }), options: long });
  assert.equal(held.result.exit, 0, held.result.reason);
  assert.equal(held.result.report.merged.length, 7);
  const ci = await runDummyLoop({ home: tmp(), scenario: sc('slow-ci', { timing: { ciMs: 5 * 3_600_000 } }), options: long });
  assert.equal(ci.result.exit, 0, ci.result.reason);
  const rv = await runDummyLoop({ home: tmp(), scenario: sc('readiness', { agents: { A: { reviewer: [{ do: 'approve', afterMs: 5 * 3_600_000 }] }, B: {} } }), options: long });
  assert.equal(rv.result.exit, 0, rv.result.reason);
});
test('MINOR-2: a real stall still ends the run — the reason says "stalled" (cause situation)', async () => {
  const r = await go('changes-requested');
  assert.match(r.result.report.parked.find((p) => p.ticket === 'T1')!.reason, /^stalled 30 min/);
});
test('MINOR-3: the loop section of the implementer brief — present for a loop-led run (`state.loopPlan`, set by the #604 applyPlan, turns it on), byte-identical to before otherwise', async () => {
  const r = await go('rts7');
  assert.ok(r.world.events.filter((e) => e.ev === 'spawn').every((e) => e.briefHasLoop === true), 'every brief the loop launched carries the loop section');
  assert.ok(!LOOP_BRIEF.includes('NO SAFE OPTION'), '#645: the marker is gone from the brief');
  for (const needle of ['--taken "irreversible: <what>"', 'a script in the PR that you never run', 'unless the spec imposes the action', 'CONNECT <upstream> <head>', 'orchestra fanout choice', 'MERGE COMMIT', 'overrides anything else', 'never wait for an upstream']) assert.ok(LOOP_BRIEF.includes(needle) || LOOP_BRIEF.includes(needle.replace('`## Choices`', '## Choices')), needle);
  const planned = applyPlan(newState('rts7', { target: 'main', switches: { seatRecords: 'on' }, now: '2026-01-01T00:00:00.000Z' }), planOf(load('rts7')), '2026-01-01T00:00:00.000Z');
  const { loopPlan: _lp, ...st0 } = planned; // the REAL #604 `applyPlan` sets `loopPlan` (which turns the loop section on): the byte-identity pin is for a state WITHOUT it
  const st = { ...st0, tickets: Object.fromEntries(Object.entries(st0.tickets).map(([k, t]) => [k, { ...t, specText: null }])) }; // #675: the plan now carries the ticket text, which the brief prints; the pinned hashes are of the brief of a ticket with none (no choice, no text ⇒ byte-identical)
  assert.equal(sha256Hex(renderImplementerBrief({ state: st, ticket: 'T3' })), '3172fcf54ff9e9a96f1cc9875eb9f3a0856218e665288ce34889226b8509ec9a', 'no loop ⇒ the brief is what it was before #605 (re-pinned #682: the dummy plan\'s interface line now carries kind + shape — the only change)');
  assert.equal(sha256Hex(renderImplementerBrief({ state: st, ticket: 'T1' })), '6db5e0fbea164656044cb58fde0d88e42782377868b18185e31807419aabd15a');
  assert.equal(renderImplementerBrief({ state: st, ticket: 'T3', loop: false }), renderImplementerBrief({ state: st, ticket: 'T3' }));
  assert.equal(renderImplementerBrief({ state: st, ticket: 'T3', loop: true }), `${renderImplementerBrief({ state: st, ticket: 'T3' })}\n\n${LOOP_BRIEF}`);
  assert.ok(planned.loopPlan, 'a loop-planned run carries #604\'s marker');
  assert.ok(renderImplementerBrief({ state: planned, ticket: 'T3' }).endsWith(LOOP_BRIEF), 'the #604 marker (state.loopPlan) turns the loop section on by itself');
});
const N = '2026-01-01T00:00:00.000Z';
test('MINOR-4 swap gate, FLIPPED (#603 landed): `parked` is a TICKET_STATUS and the shipped startRun SKIPS a parked ticket — a parked ticket whose agent is gone is never respawned', async () => {
  assert.equal((TICKET_STATUSES as readonly string[]).includes('parked'), true);
  const home = tmp();
  updateLoopState(home, 'x', () => withLoop(parkTicket(applyPlan(newState('x', { target: 'main', switches: { seatRecords: 'on' }, now: N }), planOf(load('rts7')), N), 'T3', { cause: 'question', reason: 'no safe option' }, N)));
  const spawned: string[] = [];
  const r = await startRun('x', 'x', { home, now: () => N, implementerLive: () => false, repoPath: () => undefined, spawn: async ({ name }) => { spawned.push(name); return { ok: true, id: `ws-${name}`, branch: name }; } });
  assert.deepEqual(r.skipped.filter((x) => x.reason === 'parked').map((x) => x.ticket), ['T3', 'T5', 'T7']);
  assert.deepEqual(spawned.sort(), ['impl-T1', 'impl-T2', 'impl-T4', 'impl-T6']);
});
test('MINOR-5: a port error on ONE ticket (prState, wake, openPr) is logged and retried next pass — the run still ends in a report', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'rts7', scenario: load('rts7') });
  const hit = new Set<string>();
  const once = (k: string): boolean => { if (hit.has(k)) return false; hit.add(k); return true; };
  const forge = { ...d.forge, async prState(n: number) { if (n === 1 && once('prState')) throw new Error('forge 502'); return d.forge.prState(n); }, async openPr(i: Parameters<typeof d.forge.openPr>[0]) { if (i.branch === 'impl-T2' && once('openPr')) throw new Error('forge 503'); return d.forge.openPr(i); } };
  const fleet = { ...d.fleet, async wake(ws: string, t: string) { if (ws === 'ws-impl-T3' && once('wake')) throw new Error('bus timeout'); return d.fleet.wake(ws, t); }, async spawnReviewer(t: string, h: string) { if (t === 'T4' && once('review')) throw new Error('host busy'); return d.fleet.spawnReviewer(t, h); } };
  const r = await runLoop(depsOf(home, d, { forge, fleet }));
  assert.equal(r.exit, 0);
  assert.equal(r.report.merged.length, 7);
  assert.deepEqual([...hit].sort(), ['openPr', 'prState', 'review', 'wake']);
});

// ── OPS round 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('an agent\'s ask is cut to ASK_MAX before it is listed (recordChoice refuses longer, [choice-bad]); the run is not ended by a long question', async () => {
  const s = sc('question', { events: { T2: [{ at: 'code', kind: 'question', body: `Which name? ${'x'.repeat(6000)}` } as never] } });
  const r = await runDummyLoop({ home: tmp(), scenario: s, options: { stallMs: 30 * 60_000 } });
  assert.equal(r.result.exit, 0);
  assert.equal(r.result.report.choices.length, 1);
  assert.equal(r.result.report.choices[0].question.length, ASK_MAX);
  assert.throws(() => recordChoice(newState('r', { now: 'n', switches: { seatRecords: 'on' } }), { ticket: 'T', question: 'q'.repeat(2001), rule: 'reversible-default', answer: 'a' }, 'n'), /\[choice-bad\]/);
});
test('the dummy forge CONTRACT: close(n) really closes — prState says closed, a merge is refused, nothing is merged', async () => {
  const d = buildDummy({ home: tmp(), run: 'x', scenario: load('held') });
  const w = d.world;
  w.commits.set('a'.repeat(40), { parents: [], tree: 't', at: w.t });
  w.branches.set('b', 'a'.repeat(40));
  const n = w.openPr('b', 'T1');
  assert.equal((await d.forge.prState(n)).state, 'open');
  await d.forge.close(n);
  assert.equal((await d.forge.prState(n)).state, 'closed');
  const m = await d.forge.merge(n, 'a'.repeat(40), 'merge');
  assert.equal(m.ok, false);
  assert.match(String(m.reason), /closed/);
  assert.ok(!w.events.some((e) => e.ev === 'merge'));
  await d.forge.close(n);
  assert.equal(w.events.filter((e) => e.ev === 'pr-close').length, 1, 'closing twice is one close');
});
test('a respawned author is asked to connect AGAIN (the ask is keyed by implementer id + head, not by head alone)', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'rts7', scenario: load('rts7') });
  const wakes: Array<[string, string]> = [];
  let swapped = false;
  const fleet = { ...d.fleet,
    live: (ws: string) => ws === 'ws-impl-T3-r2' || d.fleet.live(ws),
    async wake(ws: string, text: string) {
      wakes.push([ws, text.split('\n')[0]]);
      if (!swapped && ws === 'ws-impl-T3') { swapped = true; updateLoopState(home, 'rts7', (cur) => withLoop(applyTicketPatch(cur!, 'T3', { implementer: 'ws-impl-T3-r2' }, d.now()), cur!.loop)); } // the author died and startRun respawned it
      return d.fleet.wake(ws, text);
    } };
  await runLoop(depsOf(home, d, { fleet }, { maxPasses: 40 }));
  assert.equal(readLoopState(home, 'rts7')!.loop.reconnects.T3 ?? 0, 0, '#649: a re-ask of a respawned author on the SAME head is not a re-connect (the upstream did not move)');
  const t3 = wakes.filter(([, l]) => l.startsWith('CONNECT T1 '));
  assert.deepEqual(t3.map(([ws]) => ws).filter((w) => w.startsWith('ws-impl-T3')), ['ws-impl-T3', 'ws-impl-T3-r2']);
});

// ── review 605 r2: a wait is bounded ───────────────────────────────────────────────────────────────────────────────
const bounded = { stallMs: 30 * 60_000, holdMs: 60 * 60_000, maxPasses: 1500 };
test('r2 MAJOR-1 MUST-FAIL: a reviewer that is ALIVE and never records is bounded — the ticket is parked (situation) with the true reason, long before the pass limit', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('changes-requested', { agents: { T1: { reviewer: [{ do: 'silent' }] } } }), options: bounded });
  assert.equal(r.result.exit, 3);
  assert.ok(r.result.passes < 200, `ended at pass ${r.result.passes}`);
  assert.match(r.result.reason ?? '', /^stalled 30 min: T1 has no recorded review on its head/);
  assert.deepEqual(r.result.report.parked.map((p) => [p.ticket, p.cause]), [['T1', 'situation']]);
  assert.deepEqual(r.result.report.merged, ['T2']);
});
test('r2 MAJOR-1: a DEAD reviewer is replaced (the loop calls the host op again) — the run recovers, nothing parked', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('changes-requested', { agents: { T1: { reviewer: [{ do: 'die' }, { do: 'approve' }] } } }), options: bounded });
  assert.equal(r.result.exit, 0);
  assert.equal(r.result.report.merged.length, 2);
  assert.deepEqual(r.world.events.filter((e) => e.ev === 'review-spawn' && e.ticket === 'T1').map((e) => e.action), ['spawn', 'replace']);
});
test('r2 MAJOR-1 MUST-FAIL: an agent that is silent after an Admission hold is bounded by holdMs — parked, not waited for ever', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('held', { admissionHold: { T2: 3 }, agents: { T2: { implementer: [] } } }), options: bounded });
  assert.equal(r.result.exit, 3);
  assert.ok(r.result.passes < 400, `ended at pass ${r.result.passes}`);
  assert.match(r.result.report.parked.find((p) => p.ticket === 'T2')!.reason, /^stalled 30 min: .*T2 has no candidate/);
});
test('r2 MAJOR-1 MUST-FAIL: a PR the forge shows no check on waits only for the bound — then parked, not for ever', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('zero-step-ci', { faults: { noChecks: ['A'] } }), options: bounded });
  assert.equal(r.result.exit, 3);
  assert.ok(r.result.passes < 200, `ended at pass ${r.result.passes}`);
  assert.deepEqual(r.result.report.merged, ['B']);
  assert.match(r.result.report.parked[0].reason, /A is approved but not mergeable/);
});

// ── review 605 r3: replacements are capped ─────────────────────────────────────────────────────────────────────────
test('r3 MAJOR MUST-FAIL: a reviewer that dies every time is replaced at most `maxReplacements` times, then the ticket is parked — never 300 spawns', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('changes-requested', { agents: { T1: { reviewer: Array.from({ length: 800 }, () => ({ do: 'die' as const })) } } }), options: { ...bounded, stallMs: 30 * 60_000 } });
  assert.equal(r.result.exit, 3);
  assert.equal(r.world.events.filter((e) => e.ev === 'review-spawn' && e.ticket === 'T1').length, 3, '1 spawn + 2 replacements (the cap), no more');
  assert.ok(r.result.passes < 100, `ended at pass ${r.result.passes}`);
  const p = r.result.report.parked.find((x) => x.ticket === 'T1')!;
  assert.deepEqual([p.cause, /^reviewer died 2 times on /.test(p.reason)], ['situation', true]);
  assert.deepEqual(r.result.report.merged, ['T2']);
});
test('r3 MAJOR MUST-FAIL: an implementer that dies at once every time is replaced at most `maxReplacements` times, then parked ("implementer died N times")', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('changes-requested', { agents: { T1: { implementer: [{ do: 'die' }] } } }), options: bounded });
  assert.equal(r.result.exit, 3);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length, 3, '1 spawn + 2 respawns');
  assert.ok(r.result.passes < 100, `ended at pass ${r.result.passes}`);
  assert.match(r.result.report.parked.find((x) => x.ticket === 'T1')!.reason, /^implementer died 2 times/);
  assert.deepEqual(r.result.report.merged, ['T2']);
});
test('r3: the cap is a LoopOptions field — maxReplacements 0 parks at the first death, 5 allows five replacements', async () => {
  const die = sc('changes-requested', { agents: { T1: { implementer: [{ do: 'die' }] } } });
  const zero = await runDummyLoop({ home: tmp(), scenario: die, options: { ...bounded, maxReplacements: 0 } });
  assert.equal(zero.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length, 1);
  const five = await runDummyLoop({ home: tmp(), scenario: die, options: { ...bounded, maxReplacements: 5 } });
  assert.equal(five.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length, 6);
});
test('r3: a replacement that WORKS is not penalised — one death then a good agent: merged, nothing parked', async () => {
  const r = await runDummyLoop({ home: tmp(), scenario: sc('changes-requested', { agents: { T1: { implementer: [{ do: 'die' }], respawn: [{ do: 'code' }, { do: 'nominate' }], reviewer: [{ do: 'die' }, { do: 'approve' }] } } }), options: bounded });
  assert.equal(r.result.exit, 0, r.result.reason);
  assert.equal(r.result.report.merged.length, 2);
});
test('r3 MINOR: a SECOND hold of the same ticket starts its own clock (it does not inherit the first hold\'s age)', async () => {
  const scenario: Scenario = { version: 1, run: 'two-holds', repo: { tickets: [{ id: 'A', dependsOn: [], spec: 'spec/A.md' }, { id: 'B', dependsOn: [], spec: 'spec/B.md' }] }, admissionHold: { A: 15 }, agents: { A: { implementer: [{ do: 'code' }, { do: 'die' }], respawn: [{ do: 'code' }, { do: 'nominate' }] } } };
  const r = await runDummyLoop({ home: tmp(), scenario, options: { stallMs: 5 * 60_000, holdMs: 25 * 60_000, maxPasses: 1500 } });
  assert.equal(r.result.exit, 0, r.result.reason);
  assert.deepEqual([...r.result.report.merged].sort(), ['A', 'B']);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'A' && e.held === true).length, 2, 'two hold episodes');
});

test('r3 MINOR (OPS): a replacement that FAILS to spawn is not charged to the cap — three host failures, then a working reviewer: merged, nothing parked', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'changes-requested', scenario: sc('changes-requested', { agents: { T1: { reviewer: [{ do: 'die' }, { do: 'approve' }] } } }) });
  let fails = 3, calls = 0;
  const fleet = { ...d.fleet, async spawnReviewer(t: string, h: string) { calls++; if (t === 'T1' && d.world.events.some((e) => e.ev === 'review-died') && fails-- > 0) throw new Error('host busy'); return d.fleet.spawnReviewer(t, h); } };
  const r = await runLoop(depsOf(home, d, { fleet }, { maxPasses: 400 }));
  assert.equal(r.exit, 0, r.reason);
  assert.equal(r.report.merged.length, 2);
  assert.ok(fails < 0 && calls >= 6, 'the replacement was tried 4 times: 3 failures + 1 success');
  assert.equal(readLoopState(home, 'changes-requested')!.loop.replaced[`rev:T1:${d.world.events.find((e) => e.ev === 'review-record' && e.ticket === 'T1')!.head}`], 1, 'one replacement charged');
});
test('swap: an ask with control characters is cleaned before it is listed ([choice-bad] would retry the message for ever); a NO SAFE OPTION body too', async () => {
  const q = await runDummyLoop({ home: tmp(), scenario: sc('question', { events: { T2: [{ at: 'code', kind: 'question', body: 'Which name?\u0007 \u0001beep' } as never] } }), options: { stallMs: 30 * 60_000 } });
  assert.equal(q.result.exit, 0, q.result.reason);
  assert.equal(q.result.report.choices[0].question, 'Which name?   beep');
  const n = await runDummyLoop({ home: tmp(), scenario: sc('nosafe', { events: { T3: [{ at: 'code', kind: 'no-safe-option', body: 'NO SAFE OPTION: bad\u0000spec' } as never] } }), options: { stallMs: 30 * 60_000 } });
  assert.equal(n.result.exit, 0, n.result.reason);
  assert.equal(n.result.report.choices[0].question, 'NO SAFE OPTION: bad spec');
});

// ── swap review: the loop section follows the LOOP; a full choices list never poisons a restart ────────────────────
test('swap MAJOR: a HAND-planned run (a complete plan, no loopPlan marker) still gets the loop section in every brief — the section follows the loop, not the marker', async () => {
  const home = tmp();
  const r = await runDummyLoop({ home, scenario: load('pre-planned'), options: { stallMs: 30 * 60_000 } });
  assert.equal(readLoopState(home, 'pre-planned')!.loopPlan, undefined, 'no #604 marker: the plan was written by hand');
  assert.equal(r.result.exit, 0, r.result.reason);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.briefHasLoop === true).length, 7, 'all 7 briefs carry LOOP_BRIEF');
  assert.deepEqual(r.violations, []);
});
test('swap MINOR: past CHOICES_MAX the loop still ANSWERS a question (NO SAFE OPTION included) — the listing is skipped (logged), no [choice-bad] on every restart', async () => {
  for (const name of ['question', 'nosafe']) {
    const home = tmp();
    const d = buildDummy({ home, run: name, scenario: load(name) });
    updateLoopState(home, name, () => { let st = applyPlan(newState(name, { target: 'main', switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: N }), d.plan, N); for (let i = 0; i < CHOICES_MAX; i++) st = recordChoice(st, { ticket: 'T1', question: `q${i}`, rule: 'reversible-default', answer: 'a' }, N); return withLoop(st); });
    const log: string[] = [];
    const r = await runLoop({ ...depsOf(home, d), log: (l) => log.push(l) });
    assert.equal(readLoopState(home, name)!.choices!.length, CHOICES_MAX, 'nothing was added past the cap');
    assert.ok(log.some((l) => /choices are full/.test(l)), 'said in the log');
    assert.equal(r.exit, 0, r.reason); assert.ok(d.world.events.some((e) => e.ev === 'answered'), 'the question was answered');
  }
});

// ── the connect of stack C (#606 / #607 / #608 steps filled in the loop) ───────────────────────────────────────────
test('#608 (composed): a merge the state forgot is adopted from git at the next start — no second agent, no second PR, no second merge', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'readiness', scenario: load('readiness') });
  const deps = { home, run: 'readiness', caller: 'readiness', fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } };
  assert.equal((await runLoop(deps)).exit, 0);
  const before = { spawn: d.world.events.filter((e) => e.ev === 'spawn').length, pr: d.world.events.filter((e) => e.ev === 'pr-open').length, merge: d.world.events.filter((e) => e.ev === 'merge').length };
  updateLoopState(home, 'readiness', (cur) => withLoop({ ...cur!, tickets: { ...cur!.tickets, A: { ...cur!.tickets.A, status: 'started', mergedHead: null, mergedTree: null } } }, cur!.loop)); // the state lost A's merge (a kill before it was written)
  const again = await runLoop(deps);
  assert.equal(again.exit, 0);
  assert.deepEqual(again.report.merged.sort(), ['A', 'B']);
  assert.equal(readLoopState(home, 'readiness')!.tickets.A.status, 'merged');
  assert.deepEqual({ spawn: d.world.events.filter((e) => e.ev === 'spawn').length, pr: d.world.events.filter((e) => e.ev === 'pr-open').length, merge: d.world.events.filter((e) => e.ev === 'merge').length }, before);
});

test('decision 8 (composed): a run that is already paused starts, merges and asks nothing — it ends exit 4 with the reason in the report', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'readiness', scenario: load('readiness') });
  updateLoopState(home, 'readiness', () => withLoop(pauseRun(newState('readiness', { target: 'main', switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: d.now() }), { reason: 'check "build" is red on #1, #2', check: 'build', prs: [1, 2] }, d.now())));
  const r = await runLoop({ home, run: 'readiness', caller: 'readiness', fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } });
  assert.equal(r.exit, 4);
  assert.equal(r.report.paused?.check, 'build');
  assert.equal(d.world.events.filter((e) => e.ev === 'spawn').length, 0, 'nothing was started under a pause');
});

test('#606 (composed): the reviewer asks for changes → ONE batch to the same author → its fix → the SAME reviewer approves the new head → merged (no second agent)', async () => {
  const r = await go('corrections-fix');
  assert.equal(r.result.exit, 0);
  assert.deepEqual(r.result.report.merged.sort(), ['T1', 'T2']);
  const batches = r.world.events.filter((e) => e.ev === 'corrections-batch');
  assert.equal(batches.length, 1, 'one batch, not one per finding');
  assert.match(String(batches[0].text), /F1/);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length, 1, 'the SAME author');
  assert.ok(r.world.events.some((e) => e.ev === 'review-wake' && e.ticket === 'T1'), 'the same reviewer is woken on the fix, not a new one');
  assert.deepEqual(r.violations, []);
});

test('#608 (composed): a ticket whose branch vanished is parked by the reconcile step at the next start — no second agent is started on it', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'readiness', scenario: load('readiness') });
  const base = { home, run: 'readiness', caller: 'readiness', fleet: d.fleet, forge: d.forge, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } };
  assert.equal((await runLoop({ ...base, git: d.git })).exit, 0);
  const spawns = d.world.events.filter((e) => e.ev === 'spawn').length;
  updateLoopState(home, 'readiness', (cur) => withLoop({ ...cur!, tickets: { ...cur!.tickets, A: { ...cur!.tickets.A, status: 'started', mergedHead: null, mergedTree: null } } }, cur!.loop));
  const git = { ...d.git, head: async (b: string) => (b === readLoopState(home, 'readiness')!.tickets.A.branch ? null : d.git.head(b)), isMerged: async (b: string, base2: string) => (b === readLoopState(home, 'readiness')!.tickets.A.branch ? false : d.git.isMerged(b, base2)) };
  const prA = readLoopState(home, 'readiness')!.tickets.A.pr!;
  const forge = { ...d.forge, prState: async (n: number) => (n === prA ? { state: 'open' as const, head: 'a'.repeat(40) } : d.forge.prState(n)) };
  const again = await runLoop({ ...base, forge, git });
  assert.equal(again.exit, 3);
  assert.deepEqual(again.report.parked.map((p) => [p.ticket, p.cause]), [['A', 'situation']]);
  assert.match(again.report.parked[0].reason, /is gone/);
  assert.equal(d.world.events.filter((e) => e.ev === 'spawn').length, spawns, 'no second agent');
});

// ── stack C connect fix round (reviews 606 / 608 / 607 of ledger #613) ─────────────────────────────────────────────
test('606 MAJOR-1 (composed): the author dies AFTER its batch (round recorded, head unchanged) → a fresh author gets the batch again with the hand-over line → fix → the same reviewer approves → merged', async () => {
  const r = await go('corrections-author-dies');
  assert.equal(r.result.exit, 0);
  assert.deepEqual(r.result.report.merged.sort(), ['T1', 'T2']);
  const batches = r.world.events.filter((e) => e.ev === 'corrections-batch');
  assert.equal(batches.length, 2, 'the batch again, to the new author');
  assert.doesNotMatch(String(batches[0].text), /You replace the previous author/);
  assert.match(String(batches[1].text), /You replace the previous author/);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T1').length, 2);
  assert.deepEqual(r.violations, []);
});

test('606 MAJOR-2 (composed): a transient port error inside the corrections step is retried next pass — it never ends the run', async () => {
  let thrown = 0;
  const r = await runDummyLoop({ home: tmp(), scenario: load('corrections-fix'), options: { stallMs: 30 * 60_000, maxPasses: 1500 }, wrap: (d) => ({ ...d, git: { ...d.git, async head(b: string) { if (thrown < 2 && /runCorrections/.test(new Error().stack ?? '')) { thrown++; throw new Error('ECONNRESET git'); } return d.git.head(b); } } }) });
  assert.ok(thrown >= 1, 'the fault was injected');
  assert.equal(r.result.exit, 0);
  assert.deepEqual(r.result.report.merged.sort(), ['T1', 'T2']);
});

test('606 m1: the stall park reason of a ticket waiting for corrections names the open findings, not "approved"', async () => {
  const r = await go('changes-requested');
  const p = r.result.report.parked.find((x) => x.ticket === 'T1')!;
  assert.match(p.reason, /changes requested by its reviewer \(open: F1\)/);
  assert.doesNotMatch(p.reason, /approved but not mergeable/);
});

test('606 m2 (decision 12): killed between the wake of a batch and the write of its round, the restart sends the batch AGAIN (once) and the run finishes', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'corrections-fix', scenario: load('corrections-fix') });
  let crashed = false;
  const fleet = { ...d.fleet, async wake(ws: string, text: string) { await d.fleet.wake(ws, text); if (!crashed && /^Corrections for /.test(text)) { crashed = true; throw new LoopKilled('killed after the wake'); } } };
  const deps = { home, run: 'corrections-fix', caller: 'corrections-fix', fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } };
  await assert.rejects(runLoop(deps), /killed after the wake/);
  const again = await runLoop(deps);
  assert.equal(again.exit, 0);
  assert.equal(d.world.events.filter((e) => e.ev === 'corrections-batch').length, 2, 'the first wake reached the author, the restart re-sent it (a crash resends, never loses)');
});

test('608 m1 (decision 12): killed INSIDE the reconcile step (its git read) the pass dies — reconcile\'s "unknown, never gone" swallow does not eat the kill — and the restart finishes with no second agent', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'rts7', scenario: load('rts7') });
  let fresh = false, crashed = false;
  const sleep = async (ms: number) => { fresh = true; await d.sleep(ms); };
  const git = { ...d.git, async head(b: string) { if (fresh) { fresh = false; if (!crashed && d.world.events.some((e) => e.ev === 'spawn')) { crashed = true; throw new LoopKilled('killed in reconcile'); } } return d.git.head(b); } };
  const deps = { home, run: 'rts7', caller: 'rts7', fleet: d.fleet, forge: d.forge, git, now: d.now, sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } };
  await assert.rejects(runLoop(deps), /killed in reconcile/);
  const again = await runLoop(deps);
  assert.equal(again.exit, 0);
  assert.equal(d.world.events.filter((e) => e.ev === 'spawn').length, 7, 'no second agent for any ticket');
});

test('608 m2 (decision 11, composed): a run where nothing merged and nothing is parked (every ticket dropped by the human) ends exit 1, not 0', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'readiness', scenario: load('readiness') });
  updateLoopState(home, 'readiness', () => {
    let st = applyPlan(newState('readiness', { target: 'main', switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: d.now() }), d.plan, d.now());
    for (const id of ['A', 'B']) st = applyTicketPatch(st, id, { status: 'dropped' }, d.now());
    return withLoop(st);
  });
  const r = await runLoop({ home, run: 'readiness', caller: 'readiness', fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } });
  assert.deepEqual(r.report.merged, []);
  assert.deepEqual(r.report.parked, []);
  assert.equal(r.exit, 1);
});

test('608 m2 (decision 11, composed): a ticket behind a DROPPED upstream is parked at once with that reason (the end step), not after a 30-minute stall', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'red-ci', scenario: { ...load('red-ci'), ci: {}, agents: {} } });
  updateLoopState(home, 'red-ci', () => {
    let st = applyPlan(newState('red-ci', { target: 'main', switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: d.now() }), d.plan, d.now());
    st = applyTicketPatch(st, 'T1', { status: 'dropped' }, d.now());
    return withLoop(st);
  });
  const r = await runLoop({ home, run: 'red-ci', caller: 'red-ci', fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: d.plan, stallMs: 30 * 60_000 } });
  const t3 = r.report.parked.find((p) => p.ticket === 'T3');
  assert.ok(t3, JSON.stringify(r.report.parked));
  assert.match(t3!.reason, /blocked by T1 \(dropped, never merged\)/);
  assert.deepEqual(r.report.merged, ['T2']);
  assert.equal(r.exit, 3);
});

test('607 c1 (decision 8, composed): a READY ticket (approved, green) in the very pass that pauses the run is NOT merged — nothing merges while the run is paused', async () => {
  const r = await go('ci-env-ready');
  const w = r.result.report.waited;
  assert.equal(w.length, 1);
  assert.equal(w[0].check, 'build');
  const approved = r.world.events.filter((e) => e.ev === 'review-record' && e.ticket === 'T4' && e.verdict === 'approve');
  assert.equal(approved.length, 1, 'T4 was approved (its CI is green) before the pause');
  const t4 = r.world.events.filter((e) => e.ev === 'merge' && e.ticket === 'T4').map((e) => Number(e.t));
  assert.ok(t4.length === 1 && t4[0] >= Date.parse(w[0].until), 'T4 (approved before the pause began) merged only after the pause lifted');
  assert.ok(Number(approved[0].t) < Date.parse(w[0].at) + 60_000, 'T4 was ready when the run paused');
});

// ── stack C connect fix round 2 (review 606 of ledger #613, MAJOR-3 + its minor) ────────────────────────────────────
test('606 MAJOR-3 (composed): the author dies TWICE — every spawn after the recorded round (also the ones the loop\'s start step makes) gets exactly ONE batch, with the hand-over line', async () => {
  const r = await go('corrections-author-dies-twice');
  const evs = r.world.events;
  const spawnsAt = evs.map((e, i) => (e.ev === 'spawn' && e.ticket === 'T1' ? i : -1)).filter((i) => i >= 0);
  const batchAt = evs.map((e, i) => (e.ev === 'corrections-batch' && e.ticket === 'T1' ? i : -1)).filter((i) => i >= 0);
  assert.ok(spawnsAt.length >= 3, `the author was respawned more than once (${spawnsAt.length} spawns)`);
  for (let k = 0; k < spawnsAt.length; k++) {
    const upto = k + 1 < spawnsAt.length ? spawnsAt[k + 1] : evs.length;
    const mine = batchAt.filter((b) => b > spawnsAt[k] && b < upto);
    assert.equal(mine.length, 1, `spawn #${k + 1} got ${mine.length} batch(es), expected exactly 1 (spawns ${spawnsAt}, batches ${batchAt})`);
    if (k > 0) assert.match(String(evs[mine[0]].text), /You replace the previous author/);
  }
});

test('606 m3 (stall reason): once the author PUSHED its fix the reason no longer says "no fix yet" (the reviewer is the one that is silent)', async () => {
  const r = await go('corrections-fix-silent');
  const p = r.result.report.parked.find((x) => x.ticket === 'T1')!;
  assert.ok(p, 'T1 is parked by the stall');
  assert.doesNotMatch(p.reason, /no fix yet/);
  assert.match(p.reason, /no recorded review on its head/);
});

// ── #628 / #625 / #629 / log: the correctifs of the local trial (#601) ──
import { newCtx, NOTE_REPEAT_PASSES, renderSyncOrder, stepNominations, type LoopDeps } from './fanout-loop.ts';
const syncOpts = { stallMs: 4 * 3_600_000, maxPasses: 3000 };
test('#628: a merge-conflict at delivery sends the implementer ONE SYNC order (merge the target in by merge commit, push, report); the reviewer reads the new head, delivery retries and merges — no park', async () => {
  const r = await go('merge-conflict-sync', syncOpts);
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.deepEqual(mergeOrder(r.world.events), ['T1', 'T2']);
  const orders = r.world.events.filter((e) => e.ev === 'sync-order');
  assert.equal(orders.length, 1, 'one order was enough');
  assert.match(String(orders[0].text), /^SYNC main/);
  assert.equal(r.world.events.filter((e) => e.ev === 'sync-done').length, 1);
  assert.equal(r.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T2').length, 1, 'the same implementer did it: nobody was replaced');
  assert.ok(r.world.events.filter((e) => e.ev === 'review-record' && e.ticket === 'T2').length >= 2, 'the reviewer read the synced head');
  assert.deepEqual(r.violations, []);
});
test('#628: the order text says merge commit, push, report — never rebase, never squash', () => {
  const t = renderSyncOrder({ ticket: 'T2', target: 'main', pr: 3, reason: 'merge-conflict', detail: 'the PR conflicts with its base' });
  assert.match(t, /^SYNC main\n/);
  assert.match(t, /MERGE COMMIT/);
  assert.match(t, /never rebase, never squash/);
  assert.match(t, /send a status with the new head sha/);
});
test('#628: 2 orders and the head never moved → the implementer is replaced by a fresh one on the same branch (not counted as a death, nothing parked), the order is sent again, the run merges', async () => {
  const r = await go('merge-conflict-replace', { ...syncOpts, maxReplacements: 0 }); // a replacement on purpose is no death: the cap of deaths (0 here) never parks it
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.deepEqual(mergeOrder(r.world.events), ['T1', 'T2']);
  const orders = r.world.events.filter((e) => e.ev === 'sync-order');
  assert.equal(orders.length, 3, 'two to the first implementer, one to its successor');
  const at = (pred: (e: Ev) => boolean): number[] => r.world.events.flatMap((e, i) => (pred(e) ? [i] : []));
  const [sp1, sp2] = at((e) => e.ev === 'spawn' && e.ticket === 'T2');
  const [o1, o2, o3] = at((e) => e.ev === 'sync-order');
  assert.ok(sp1 < o1 && o1 < o2 && o2 < at((e) => e.ev === 'impl-replaced')[0] && at((e) => e.ev === 'impl-replaced')[0] < sp2 && sp2 < o3, 'order, order, replace, fresh spawn, order again');
  assert.equal(r.world.events.filter((e) => e.ev === 'impl-replaced' && e.ticket === 'T2').length, 1);
  const spawns = r.world.events.filter((e) => e.ev === 'spawn' && e.ticket === 'T2');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].branch, spawns[0].branch, 'the same branch');
  assert.deepEqual(r.result.report.parked, []);
  assert.ok(r.log.filter((l) => /T2: merge refused by the forge — merge-conflict/.test(l)).length >= 2, 'the repeated refusal stays visible in the log');
});
test('#628: a refusal the loop has no rule for goes to the implementer with the RAW reason (a ruled one — head-moved, ci-red — does not)', async () => {
  const base = load('merge-conflict-sync');
  const scn: Scenario = { ...base, faults: {} };
  const wrap = (reason: string) => (d: ReturnType<typeof buildDummy>) => ({ ...d, forge: { ...d.forge, async merge(n: number, h: string, m: 'merge' | 'squash' | 'rebase') { const t = [...d.world.prs.values()].find((p) => p.n === n)!.ticket; return t === 'T2' && !d.world.events.some((e) => e.ev === 'sync-done') ? { ok: false, reason, detail: `raw detail of ${reason}` } : d.forge.merge(n, h, m); } } });
  const raw = await runDummyLoop({ home: tmp(), scenario: scn, options: syncOpts, wrap: wrap('base-not-allowed') });
  assert.equal(raw.result.exit, 0);
  const o = raw.world.events.find((e) => e.ev === 'sync-order')!;
  assert.ok(o, 'T2 was told');
  assert.match(String(o.text), /^FIX base-not-allowed/);
  assert.ok(raw.log.some((l) => /order 1 sent to/.test(l)));
  const ruled = await runDummyLoop({ home: tmp(), scenario: scn, options: { ...syncOpts, stallMs: 60 * 60_000 }, wrap: wrap('head-moved') });
  assert.equal(ruled.world.events.filter((e) => e.ev === 'sync-order').length, 0, 'head-moved has a rule (the nominations step reads the new head): nobody is ordered');
});
test('loop log: a refusal note that repeats is printed again on a later pass — at most once per NOTE_REPEAT_PASSES', () => {
  const lines: string[] = [];
  const seen = new Map<string, number>();
  const deps = { log: (l: string) => lines.push(l) } as unknown as LoopDeps;
  for (let pass = 1; pass <= 25; pass++) newCtx(deps, pass, seen).note('T2: merge refused by the forge — merge-conflict');
  assert.deepEqual(lines.map((l) => /\[pass (\d+)\]/.exec(l)![1]), ['1', String(1 + NOTE_REPEAT_PASSES), String(1 + 2 * NOTE_REPEAT_PASSES)]);
  const other = newCtx(deps, 26, seen);
  other.note('another line');
  assert.equal(lines.length, 4, 'a different line prints at once');
});
test('#625: --tickets and no plan → the loop asks the planner (the plan agent), waits for the accepted plan, then leads the run; the plan agent is released (#629)', async () => {
  const r = await go('plan-agent');
  assert.equal(r.result.exit, 0, r.result.reason);
  assert.deepEqual([...r.result.report.merged].sort(), ['T1', 'T2']);
  const evs = r.world.events.map((e) => e.ev);
  assert.ok(evs.indexOf('plan-agent-spawn') >= 0 && evs.indexOf('plan-accepted') > evs.indexOf('plan-agent-spawn') && evs.indexOf('plan-agent-released') > evs.indexOf('plan-accepted'));
  assert.ok(evs.indexOf('spawn') > evs.indexOf('plan-accepted'), 'no implementer before the plan');
  assert.ok(r.log.some((l) => /asking for a plan of T1, T2/.test(l)));
});
test('#625: --tickets with NO planner and no plan is still refused [run-plan-needed], naming both ways', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'no-planner', scenario: load('plan-agent') });
  const r = await runLoop({ home, run: 'no-planner', caller: 'no-planner', fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: () => {}, options: { ...DEFAULT_OPTIONS, plan: null, tickets: ['T1', 'T2'] } });
  assert.equal(r.exit, 2);
  assert.match(String(r.reason), /run-plan-needed|--tickets/);
});
test('#629: a nomination the state REFUSES is logged "has a head", never "nominated" (ctx.did prints what was written)', async () => {
  const home = tmp();
  const run = 'refused-nom';
  const d = buildDummy({ home, run, scenario: load('follows-missing') });
  const now = d.now();
  updateLoopState(home, run, () => {
    let s = applyPlan(newState(run, { target: 'main', switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now }), d.plan, now);
    s = applyTicketPatch(s, 'T2', { follows: { T1: 1 } }, now);
    s = applyTicketPatch(s, 'T1', { interface: '`T1.api2` — changed', interfaceReason: 'rename' }, now); // T1's interface is now v2: T2 follows the stale v1
    s = applyTicketPatch(s, 'T1', { status: 'merged' }, now); // no unmerged upstream: the loop tries to nominate T2
    s = applyTicketPatch(s, 'T2', { branch: 'impl-T2', implementer: 'ws-impl-T2', status: 'started' }, now);
    return withLoop(s);
  });
  const sha = 'a'.repeat(40);
  const lines: string[] = [];
  const deps = { home, run, caller: run, fleet: d.fleet, forge: d.forge, git: { ...d.git, head: async () => sha, tree: async () => 'b'.repeat(40), isMerged: async () => true }, now: d.now, sleep: d.sleep, log: (l: string) => lines.push(l), options: { ...DEFAULT_OPTIONS } } as unknown as LoopDeps;
  const ctx = newCtx(deps, 1, new Map());
  ctx.signals.add('T2');
  await stepNominations(ctx);
  assert.equal(readLoopState(home, run)!.tickets.T2.status, 'started', 'the state refused the nomination');
  assert.ok(lines.some((l) => /T2 has a head at aaaaaaaaaaaa/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /T2 nominated/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /cannot be nominated yet — .*follows T1 v1/.test(l)), lines.join("\n"));
});

// ── #637: a head with ANOTHER sha and the SAME tree as the approved one is delivered (#512 content key) ──
test('#637: the implementer re-connects onto a same-tree head AFTER the approval — no new review (the verdict covers the tree), deliver merges the real PR head instead of refusing verdict-head-mismatch every pass', async () => {
  const r = await go('same-tree-head', { stallMs: 4 * 3_600_000, maxPasses: 3000 });
  assert.equal(r.result.exit, 0, `${r.result.reason ?? ''} ${r.log.filter((l) => /not deliverable/.test(l)).slice(0, 2).join(' | ')}`);
  assert.deepEqual(r.result.report.merged, ['T1']);
  const rt = r.world.events.find((e) => e.ev === 'retree')!;
  const approved = r.world.events.find((e) => e.ev === 'review-record' && e.ticket === 'T1')!;
  assert.ok(rt && approved && approved.t < rt.t, 'the approval is on the OLD head, the same-tree commit comes after it');
  assert.equal(r.world.events.filter((e) => e.ev === 'review-record' && e.ticket === 'T1').length, 1, 'no second review: the verdict covers the tree');
  assert.equal(r.world.events.find((e) => e.ev === 'merge')!.head, rt.head, 'the merge binds to the real PR head, not the verdict\'s');
  assert.ok(!r.log.some((l) => /verdict-head-mismatch/.test(l)), 'never refused');
  assert.deepEqual(r.violations, []);
});
test('#637: the PR head is ANOTHER sha with the verified head\'s tree (the forge moved, the content did not) — delivered, the merge bound to the real PR head', async () => {
  const scn = sc('same-tree-head', { agents: { T1: { implementer: [{ do: 'code' }, { do: 'nominate' }] } } });
  let prHead = '';
  const wrap = (d: ReturnType<typeof buildDummy>) => ({ ...d, forge: { ...d.forge,
    async prState(n: number) { const s = await d.forge.prState(n); if (s.state !== 'open') return s; if (!prHead) { prHead = d.world.commit([s.head], 'forge-head', 'x'); d.world.commits.get(prHead)!.tree = d.world.commits.get(s.head)!.tree; } return { ...s, head: prHead }; },
    async merge(n: number, h: string, m: 'merge' | 'squash' | 'rebase') { assert.equal(h, prHead, 'the merge is bound to the REAL pull request head'); return d.forge.merge(n, d.world.branches.get(d.world.prs.get(n)!.branch)!, m); },
  } });
  const r = await runDummyLoop({ home: tmp(), scenario: scn, options: { stallMs: 4 * 3_600_000, maxPasses: 3000 }, wrap });
  assert.equal(r.result.exit, 0, `${r.result.reason ?? ''} ${r.log.filter((l) => /not deliverable/.test(l)).slice(0, 1).join('')}`);
  assert.deepEqual(r.result.report.merged, ['T1']);
});
test('#637 MUST-FAIL: a PR head with ANOTHER tree than the verified head is never delivered (head-moved) — the same-tree rule does not open the gate', async () => {
  const scn = sc('same-tree-head', { agents: { T1: { implementer: [{ do: 'code' }, { do: 'nominate' }] } } });
  let prHead = '';
  const wrap = (d: ReturnType<typeof buildDummy>) => ({ ...d, forge: { ...d.forge,
    async prState(n: number) { const s = await d.forge.prState(n); if (s.state !== 'open') return s; if (!prHead) prHead = d.world.commit([s.head], 'forge-head', 'another-content'); return { ...s, head: prHead }; },
    async merge(n: number, h: string, m: 'merge' | 'squash' | 'rebase') { return d.forge.merge(n, d.world.branches.get(d.world.prs.get(n)!.branch)!, m); }, // the dummy forge itself would refuse a moved head: here only the LOOP's gate is measured
  } });
  const r = await runDummyLoop({ home: tmp(), scenario: scn, options: { stallMs: 60 * 60_000, maxPasses: 3000 }, wrap });
  assert.equal(r.result.exit, 3);
  assert.deepEqual(r.result.report.merged, []);
  assert.equal(r.world.events.filter((e) => e.ev === 'merge').length, 0);
});
