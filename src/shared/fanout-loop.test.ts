// #605 — the Boucle on the dummy fleet: one pass of the real loop per scenario (src/shared/fanout-loop-scenarios/), judged from the event log. Each rule of #601 has a must-pass scenario AND a must-fail one
// (the judge on a log that breaks it); scripts/e2e-fanout-run.mjs mutates the loop and every mutant must turn one of these red.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDummy, parseScenario, planOf, runDummyLoop, type Scenario } from './fanout-loop-dummy.ts';
import { FIXED_ANSWER, LOOP_STEPS, NO_SAFE_OPTION, renderConnectAsk, runLoop, DEFAULT_OPTIONS } from './fanout-loop.ts';
import { judgeRun, RULES, type Ev } from './fanout-loop-judge.ts';
import { applyPlan, parkTicket, pauseRun, readLoopState, recordRound, resumeRun, situationFingerprint, updateLoopState, withLoop, parkedTickets } from './fanout-loop-compat.ts';
import { newState, sha256Hex } from './fanout-state.ts';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fanout-loop-scenarios');
const load = (name: string): Scenario => parseScenario(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')));
const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-loop-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const go = (name: string, opts: Parameters<typeof runDummyLoop>[0]['options'] = {}) => runDummyLoop({ home: tmp(), scenario: load(name), options: { stallMs: 30 * 60_000, ...opts } });
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

test('decision 5: "NO SAFE OPTION: …" parks the ticket (cause question) and its dependents (cause upstream); the others go on, exit 3', async () => {
  const r = await go('nosafe');
  assert.equal(r.result.exit, 3);
  assert.deepEqual(r.result.report.merged, ['T1', 'T2', 'T4', 'T6']);
  const byTicket = Object.fromEntries(r.result.report.parked.map((p) => [p.ticket, p]));
  assert.equal(byTicket.T3.cause, 'question');
  assert.match(byTicket.T3.reason, /contradicts itself/);
  for (const d of ['T5', 'T7']) assert.deepEqual([byTicket[d].cause, byTicket[d].reason], ['upstream', 'blocked by T3']);
  assert.deepEqual(r.result.report.choices.map((c) => [c.ticket, c.rule]), [['T3', 'no-safe-option']]);
  assert.deepEqual(r.violations, []);
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

test('decision 10: a red CI is never merged (no #607 yet: the ticket ends parked, its dependent with it)', async () => {
  const r = await go('red-ci');
  assert.equal(r.result.exit, 3);
  assert.deepEqual(r.result.report.merged, ['T2']);
  assert.deepEqual(r.result.report.parked.map((p) => [p.ticket, p.cause]), [['T1', 'situation'], ['T3', 'upstream']]);
  assert.ok(r.world.events.every((e) => e.ev !== 'merge' || e.ci === 'green'));
  assert.deepEqual(r.violations, []);
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
test('frozen names: the steps, the fixed answer, the no-safe-option marker', () => {
  assert.deepEqual([...LOOP_STEPS], ['reconcile', 'plan', 'start', 'mail', 'nominations', 'open', 'review', 'approvals', 'connect', 'ci', 'corrections', 'deliver', 'end']);
  assert.equal(FIXED_ANSWER, 'Take the reversible option, record it under `## Choices` in your PR body, continue. Do not wait for anyone.');
  assert.equal(NO_SAFE_OPTION, 'NO SAFE OPTION: ');
  assert.match(renderConnectAsk({ ticket: 'T3', upstream: 'T1', branch: 'impl-T1', head: H('a') }), new RegExp(`^CONNECT T1 ${H('a')}\\n`));
  assert.match(renderConnectAsk({ ticket: 'T3', upstream: 'T1', branch: 'impl-T1', head: H('a') }), /MERGE COMMIT/);
});
test('compat (#603 names): park is transitive, refuses merged / unknown / no reason; the fingerprint is the frozen sha256; a repeat is the second sighting', async () => {
  let s = withLoop(applyPlan(newState('rts7', { target: 'main', switches: { seatRecords: 'on' }, now: 'n' }), planOf(load('rts7')), 'n'));
  s = parkTicket(s, 'T3', { cause: 'ci', reason: 'check build is red' }, 'now');
  assert.deepEqual(parkedTickets(s).map((p) => [p.ticket, p.cause, p.blockedBy ?? null]), [['T3', 'ci', null], ['T5', 'upstream', 'T3'], ['T7', 'upstream', 'T3']]);
  assert.throws(() => parkTicket(s, 'T9', { cause: 'ci', reason: 'x' }, 'now'), /\[park-unknown-ticket\]/);
  assert.throws(() => parkTicket(s, 'T1', { cause: 'ci', reason: '' }, 'now'), /\[park-no-reason\]/);
  assert.throws(() => parkTicket(s, 'T1', { cause: 'nope' as never, reason: 'x' }, 'now'), /\[park-bad-cause\]/);
  assert.equal(situationFingerprint({ openFindings: ['b', 'a'], tree: 'abc' }), sha256Hex('findings:a,b\ntree:abc'));
  const first = recordRound(s, 'T1', 'fp', 't1');
  assert.equal(first.repeat, false);
  assert.equal(recordRound(first.state, 'T1', 'fp', 't2').repeat, true);
  assert.equal(recordRound(first.state, 'T1', 'other', 't2').repeat, false);
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
  const git = { ...d.git, async head(b: string) { if (!crashed && b === 'impl-T1' && d.world.events.some((e) => e.ev === 'mail-posted' && e.ticket === 'T1')) { crashed = true; throw new Error('killed mid-pass'); } return d.git.head(b); } };
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
test('one ticket that never records --follows is refused its nomination and told so — the run goes on without it (pre-review MAJOR)', async () => {
  const r = await go('follows-missing');
  assert.equal(r.result.exit, 3);
  assert.deepEqual(r.result.report.merged, ['T1', 'T3']);
  assert.deepEqual(r.result.report.parked.map((p) => [p.ticket, p.cause]), [['T2', 'situation']]);
  const told = r.world.events.filter((e) => e.ev === 'send' && e.kind === 'status' && /could not nominate T2: .*interface-unfollowed/.test(String(e.text)));
  assert.ok(told.length >= 1, 'the author got the refusal');
  assert.deepEqual(r.violations, []);
});

test('decision 12 (OPS arm): killed after openPr and before the state write, the restart calls openPr again and gets the SAME PR — never a second one', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'rts7', scenario: load('rts7') });
  let crashed = false;
  const forge = { ...d.forge, async openPr(i: Parameters<typeof d.forge.openPr>[0]) { const r = await d.forge.openPr(i); if (!crashed) { crashed = true; throw new Error('killed after openPr'); } return r; } };
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
