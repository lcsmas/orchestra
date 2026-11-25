// #605 — the Boucle on the dummy fleet: one pass of the real loop per scenario (src/shared/fanout-loop-scenarios/), judged from the event log. Each rule of #601 has a must-pass scenario AND a must-fail one
// (the judge on a log that breaks it); scripts/e2e-fanout-run.mjs mutates the loop and every mutant must turn one of these red.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDummy, parseScenario, planOf, runDummyLoop, type Scenario } from './fanout-loop-dummy.ts';
import { FIXED_ANSWER, LOOP_STEPS, ASK_MAX, LoopKilled, NO_SAFE_OPTION, parseNoSafeOption, renderConnectAsk, runLoop, DEFAULT_OPTIONS } from './fanout-loop.ts';
import { judgeRun, RULES, type Ev } from './fanout-loop-judge.ts';
import { applyPlan, recordChoice, parkTicket, pauseRun, readLoopState, recordRound, resumeRun, situationFingerprint, updateLoopState, withLoop, parkedTickets } from './fanout-loop-compat.ts';
import { applyTicketPatch, newState, sha256Hex, TICKET_STATUSES } from './fanout-state.ts';
import { LOOP_BRIEF, renderImplementerBrief } from './fanout-implementer-brief.ts';

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
  const git = { ...d.git, async head(b: string) { if (!crashed && b === 'impl-T1' && d.world.events.some((e) => e.ev === 'mail-posted' && e.ticket === 'T1')) { crashed = true; throw new LoopKilled('killed mid-pass'); } return d.git.head(b); } };
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
  assert.equal(readLoopState(home, 'question')!.loop.choices.length, 1, 'the choice is durable before the answer goes out');
  assert.ok(d.world.drainMail().some((m) => m.kind === 'ask'), 'and the mail was NOT acked: the restart is handed it again');
  const again = await runLoop(depsOf(home, d));
  assert.equal(again.exit, 0);
  assert.equal(again.report.choices.length, 1);
  assert.equal(again.report.merged.length, 7);
  assert.ok(d.world.events.some((e) => e.ev === 'answered'), 'T2 got its answer');
});
test('MAJOR-1: a NO SAFE OPTION in a batch killed before its ack is parked once on restart (not lost, not listed twice)', async () => {
  const home = tmp();
  const d = buildDummy({ home, run: 'nosafe', scenario: load('nosafe') });
  let killed = false;
  const fleet = { ...d.fleet, async ack(n: number) { if (!killed && d.world.events.some((e) => e.ev === 'ask' && e.kind === 'no-safe-option')) { killed = true; throw new LoopKilled('killed before the ack'); } return d.fleet.ack(n); } };
  await assert.rejects(runLoop(depsOf(home, d, { fleet })), /killed before the ack/);
  const again = await runLoop(depsOf(home, d));
  assert.equal(again.exit, 3);
  assert.deepEqual(again.report.parked.map((p) => [p.ticket, p.cause]), [['T3', 'question'], ['T5', 'upstream'], ['T7', 'upstream']]);
  assert.equal(again.report.choices.length, 1);
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
test('MINOR-1: NO SAFE OPTION is parsed fail-CLOSED (case, spacing, colon, not first line); only a body without the marker is a question', async () => {
  for (const body of ['NO SAFE OPTION:\nthe reason', 'NO SAFE OPTION:the reason', 'NO SAFE OPTION:', 'no safe option: x', '  NO SAFE OPTION: x', 'Hello\nNO SAFE OPTION: x', 'No-Safe_Option - x']) {
    assert.ok(parseNoSafeOption(body), body);
    const s = sc('nosafe', { events: { T3: [{ at: 'code', kind: 'no-safe-option', body } as never] } });
    const r = await runDummyLoop({ home: tmp(), scenario: s, options: { stallMs: 30 * 60_000 } });
    assert.equal(r.result.report.parked.find((p) => p.ticket === 'T3')?.cause, 'question', body);
    assert.equal(r.result.report.choices.filter((c) => c.rule === 'reversible-default').length, 0, `${body} was not answered with the fixed answer`);
  }
  assert.equal(parseNoSafeOption('Which of the two names should T3 use?'), null);
  assert.equal(parseNoSafeOption('NO SAFE OPTION:')!.reason, '(no reason given)');
  assert.equal(parseNoSafeOption('NO SAFE OPTION: a\nb')!.reason, 'a');
});
test('MINOR-2: a held start, a CI that takes hours and a reviewer that reads for hours are not a stall (4 h clock)', async () => {
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
test('MINOR-3: the loop section of the implementer brief — present for a loop-led run (startRun passes it), byte-identical to before otherwise', async () => {
  const r = await go('rts7');
  assert.ok(r.world.events.filter((e) => e.ev === 'spawn').every((e) => e.briefHasLoop === true), 'every brief the loop launched carries the loop section');
  for (const needle of ['NO SAFE OPTION: <reason>', 'CONNECT <upstream> <head>', '`## Choices`', 'MERGE COMMIT', 'overrides anything else', 'never wait for an upstream']) assert.ok(LOOP_BRIEF.includes(needle) || LOOP_BRIEF.includes(needle.replace('`## Choices`', '## Choices')), needle);
  const st = applyPlan(newState('rts7', { target: 'main', switches: { seatRecords: 'on' }, now: '2026-01-01T00:00:00.000Z' }), planOf(load('rts7')), '2026-01-01T00:00:00.000Z');
  assert.equal(sha256Hex(renderImplementerBrief({ state: st, ticket: 'T3' })), 'ba8d1058cfd07dcfe57f722b417609b3b083c025df4175d3704c7581494fa019', 'no loop ⇒ the brief is what it was before #605 (hash taken on the unmodified renderer)');
  assert.equal(sha256Hex(renderImplementerBrief({ state: st, ticket: 'T1' })), 'b88073ddf1793f4e7e5254289b14f78400f52a408c2b12b7c15a942aa30aa560');
  assert.equal(renderImplementerBrief({ state: st, ticket: 'T3', loop: false }), renderImplementerBrief({ state: st, ticket: 'T3' }));
  assert.equal(renderImplementerBrief({ state: st, ticket: 'T3', loop: true }), `${renderImplementerBrief({ state: st, ticket: 'T3' })}\n\n${LOOP_BRIEF}`);
  assert.ok(renderImplementerBrief({ state: { ...st, loopPlan: { at: 'x', hash: 'y', attempts: 1 } } as never, ticket: 'T3' }).endsWith(LOOP_BRIEF), 'the #604 marker (state.loopPlan) turns it on too');
});
test('MINOR-4 SWAP GATE (#603): while `parked` is not a TICKET_STATUS the shipped startRun respawns a parked ticket — when this fails #603 landed: delete fanout-loop-compat.ts, import its names from fanout-state.ts, flip this to "startRun skips a parked ticket"', () => {
  assert.equal((TICKET_STATUSES as readonly string[]).includes('parked'), false);
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
  assert.throws(() => recordChoice(withLoop(newState('r', { now: 'n', switches: { seatRecords: 'on' } })), { ticket: 'T', question: 'q'.repeat(2001), rule: 'reversible-default', answer: 'a' }, 'n'), /\[choice-bad\]/);
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
  const t3 = wakes.filter(([, l]) => l.startsWith('CONNECT T1 '));
  assert.deepEqual(t3.map(([ws]) => ws).filter((w) => w.startsWith('ws-impl-T3')), ['ws-impl-T3', 'ws-impl-T3-r2']);
});
