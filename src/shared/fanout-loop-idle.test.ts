// idle-rule — the idle rule: an agent alive but idle while the loop waits on something it owes is woken again with the same brief, then replaced; a running agent is never touched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseScenario, runDummyLoop, type Scenario } from './fanout-loop-dummy.ts';
import { idleDecision, idleReading } from './fanout-loop-idle.ts';
import { renderReviewReminder } from './fanout-loop.ts';
import type { Ev } from './fanout-loop-judge.ts';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fanout-loop-scenarios');
const load = (name: string): Scenario => parseScenario(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')));
const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-idle-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const go = (name: string, opts: Parameters<typeof runDummyLoop>[0]['options'] = {}) => runDummyLoop({ home: tmp(), scenario: load(name), options: { stallMs: 30 * 60_000, maxPasses: 3000, ...opts } });
const count = (evs: Ev[], ev: string, ticket?: string): number => evs.filter((e) => e.ev === ev && (!ticket || e.ticket === ticket)).length;

test('idleDecision: a running / queued / unknown agent (null) is never touched; an idle one is woken, then replaced — no delay in it', () => {
  assert.equal(idleDecision({ idle: null, woken: false }), 'none');
  assert.equal(idleDecision({ idle: null, woken: true }), 'none', 'running, even after a wake');
  assert.equal(idleDecision({ idle: 0, woken: false }), 'wake');
  assert.equal(idleDecision({ idle: 0, woken: true }), 'replace');
});

test('idleReading: idle only when the session is idle AND nothing is queued or in dispatch for it (each clause alone turns it to null)', () => {
  const base = { status: 'idle', idleSince: 1_000, now: 61_000 };
  assert.equal(idleReading(base), 60_000);
  for (const [name, over] of Object.entries({ running: { status: 'running' }, waiting: { status: 'waiting' }, archived: { archived: true }, 'turn in flight': { gateHeld: true }, 'turn queued on the session': { queuedCount: 1 }, 'opening prompt owed': { pendingPromptCount: 1 }, 'prompt on the banner queue': { queuedPrompts: 1 }, 'message parked in the inbox': { parkedInboxCount: 1 } })) assert.equal(idleReading({ ...base, ...over }), null, name);
  assert.equal(idleReading({ ...base, now: 500 }), 0, 'a clock step back reads 0, never negative');
});

test('the reviewer reminder carries the brief of the current head and says when the head moved', () => {
  const same = renderReviewReminder({ reviews: [{ head: 'aaaa1111' }] }, 'THE BRIEF', 'aaaa1111');
  assert.match(same, /^REMINDER — the loop is still waiting for your RECORDED verdict on aaaa1111/);
  assert.match(same, /THE BRIEF$/);
  assert.doesNotMatch(same, /head moved/);
  const moved = renderReviewReminder({ reviews: [{ head: '27fc9051aaaa' }] }, 'THE BRIEF', 'bbbb2222');
  assert.match(moved, /The head moved: your last record is on 27fc9051aaaa/);
});

test('idle-rule: a reviewer that is alive and idle and never records is woken again, then replaced; the fresh one records and the run merges', async () => {
  const r = await go('reviewer-idle');
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.equal(count(r.world.events, 'review-reminder', 'T1'), 1, 'woken again once');
  assert.equal(count(r.world.events, 'review-released', 'T1'), 1, 'then released');
  assert.equal(count(r.world.events, 'review-spawn', 'T1'), 2, 'the replacement is a second reviewer');
  assert.ok(r.world.events.findIndex((e) => e.ev === 'review-reminder') < r.world.events.findIndex((e) => e.ev === 'review-released'));
  assert.deepEqual([...r.result.report.merged].sort(), ['T1', 'T2']);
  assert.equal(count(r.world.events, 'review-silent', 'T1'), 2);
  assert.ok(r.log.some((l) => /T1: ws-\S+ idle \d+ min owing a review record on \w+ — woken again/.test(l)), r.log.filter((l) => /idle/.test(l)).join('\n'));
  assert.ok(r.log.some((l) => /T1: ws-\S+ idle \d+ min owing a review record on \w+ — replaced/.test(l)));
  assert.deepEqual(r.violations, []);
});

test('idle-rule: a reviewer that records after the reminder is not replaced', async () => {
  const r = await go('reviewer-idle-wake');
  assert.equal(r.result.exit, 0);
  assert.equal(count(r.world.events, 'review-reminder', 'T1'), 1);
  assert.equal(count(r.world.events, 'review-released', 'T1'), 0);
  assert.equal(count(r.world.events, 'review-spawn', 'T1'), 1);
});

test('idle-rule: a reviewer that is RUNNING a long review (not idle) is never woken or replaced', async () => {
  const sc = load('reviewer-idle-wake');
  sc.agents!.T1.reviewer = [{ do: 'approve', afterMs: 3 * 3_600_000 }];
  const r = await runDummyLoop({ home: tmp(), scenario: sc, options: { stallMs: 4 * 3_600_000, maxPasses: 3000 } });
  assert.equal(r.result.exit, 0);
  assert.equal(count(r.world.events, 'review-reminder'), 0);
  assert.equal(count(r.world.events, 'review-released'), 0);
});

test('idle-rule: a reviewer released but still there idle is NO progress: the ticket is parked one stall bound after the release, not a whole bound later', async () => {
  const wrap = (d: ReturnType<typeof import('./fanout-loop-dummy.ts').buildDummy>) => ({ ...d, fleet: { ...d.fleet, async replaceReviewer(): Promise<void> { /* the release does not take */ } } });
  const r = await runDummyLoop({ home: tmp(), scenario: load('reviewer-idle'), options: { stallMs: 60 * 60_000, maxPasses: 3000 }, wrap });
  assert.equal(r.result.exit, 3);
  assert.match(r.result.reason ?? '', /T1 has no recorded review on its head/);
  const minutes = (r.world.t - Date.parse('2026-01-01T00:00:00Z')) / 60_000;
  assert.ok(minutes < 100, `parked at minute ${minutes}: the wait after the release must not feed the stall clock`);
});

test('idle-rule: an alive idle implementer that ignores a SYNC order is woken again and replaced at the next passes — not after orderWaitMs (set to 10 h)', async () => {
  const r = await go('implementer-idle-order', { orderWaitMs: 10 * 3_600_000 });
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.equal(count(r.world.events, 'sync-order', 'T2'), 3, 'order, the same order again, then one to the successor');
  assert.equal(count(r.world.events, 'impl-replaced', 'T2'), 1);
  const replacedAt = r.world.events.find((e) => e.ev === 'impl-replaced')!.t;
  assert.ok(replacedAt - Date.parse('2026-01-01T00:00:00Z') < 90 * 60_000, `replaced at minute ${(replacedAt - Date.parse('2026-01-01T00:00:00Z')) / 60_000}: the idle rule, not the 10 h orderWaitMs`);
  assert.ok(r.log.some((l) => /T2: ws-\S+ idle \d+ min owing the SYNC order's new head — woken again/.test(l)));
  assert.ok(r.log.some((l) => /T2: ws-\S+ idle \d+ min owing the SYNC order's new head — replaced/.test(l)));
  assert.deepEqual(r.result.report.parked, []);
});

test('idle-rule: a running implementer keeps the orderWaitMs wait (no idle rule on it)', async () => {
  const sc = load('implementer-idle-order');
  sc.agents!.T2.implementer = [{ do: 'code', afterMs: 900_000 }, { do: 'nominate' }, { do: 'sync', afterMs: 3 * 3_600_000 }]; // the order is read at once, the sync takes hours: the agent is running
  const r = await runDummyLoop({ home: tmp(), scenario: sc, options: { stallMs: 4 * 3_600_000, maxPasses: 4000, orderWaitMs: 10 * 3_600_000 } });
  assert.equal(count(r.world.events, 'impl-replaced', 'T2'), 0);
  assert.equal(count(r.world.events, 'sync-order', 'T2'), 1);
});

test('idle-rule: a dependent that never connects when asked is asked again, then replaced; the fresh author connects', async () => {
  const r = await go('connect-idle', { stallMs: 60 * 60_000 });
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.ok(count(r.world.events, 'connect-ask', 'T2') >= 3, 'the ask, the same ask again, the ask to the fresh author');
  assert.equal(count(r.world.events, 'impl-replaced', 'T2'), 1);
  assert.ok(r.log.some((l) => /T2: ws-\S+ idle \d+ min owing the connection to T1 at \w+ — woken again/.test(l)));
  assert.ok(r.log.some((l) => /T2: ws-\S+ idle \d+ min owing the connection to T1 at \w+ — replaced/.test(l)));
  assert.equal(count(r.world.events, 'connect-done', 'T2'), 1);
  assert.deepEqual(r.result.report.parked, []);
});
