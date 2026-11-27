// The host's pause of the run (a 429 on the pool seats, a human): every member is frozen, so the Boucle acts on NOTHING while it lasts — no stall clock, no order counted, no decision, no idle rule, no replacement, no spawn —
// and restarts its clocks at the lift. The dummy world freezes its agents and parks their messages; `act-while-paused` is the event the loop must never cause.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseScenario, runDummyLoop, type Scenario } from './fanout-loop-dummy.ts';
import { resetAfterPause } from './fanout-loop-pause.ts';
import { applyTicketPatch, newState, setPlan } from './fanout-state.ts';
import { withLoop } from './fanout-loop-side.ts';
import type { Ev } from './fanout-loop-judge.ts';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fanout-loop-scenarios');
const load = (name: string): Scenario => parseScenario(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')));
const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-pause-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const go = (name: string, opts: Parameters<typeof runDummyLoop>[0]['options'] = {}, wrap?: Parameters<typeof runDummyLoop>[0]['wrap']) => runDummyLoop({ home: tmp(), scenario: load(name), options: { stallMs: 30 * 60_000, maxPasses: 3000, ...opts }, wrap });
const count = (evs: Ev[], ev: string, ticket?: string): number => evs.filter((e) => e.ev === ev && (!ticket || e.ticket === ticket)).length;
const T0 = Date.parse('2026-01-01T00:00:00Z');

test('a pause (429) in the middle of a review: the loop does nothing while it lasts (no stall though it outlasts stallMs, no reminder, no replacement), says it once each way, and the run ends merged after the auto-resume', async () => {
  const r = await go('pause-review');
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.deepEqual([...r.result.report.merged].sort(), ['T1', 'T2']);
  assert.equal(count(r.world.events, 'act-while-paused'), 0, JSON.stringify(r.world.events.filter((e) => e.ev === 'act-while-paused')));
  assert.equal(count(r.world.events, 'review-reminder') + count(r.world.events, 'review-released'), 0, 'a frozen reviewer is not a silent one');
  assert.equal(count(r.world.events, 'review-spawn'), 2, 'one reviewer per ticket, none replaced');
  assert.equal(r.log.filter((l) => /host pause: the run is paused/.test(l)).length, 1, 'said once');
  assert.equal(r.log.filter((l) => /host pause lifted after 45 min/.test(l)).length, 1);
  assert.deepEqual(r.violations, []);
});

test('the pause comes twice (the limit hits again after the Reprise): paused, resumed, paused, resumed — one line each, still nothing acted, merged', async () => {
  const r = await go('pause-again', { stallMs: 60 * 60_000 });
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.equal(count(r.world.events, 'act-while-paused'), 0);
  assert.equal(r.log.filter((l) => /host pause: the run is paused/.test(l)).length, 2);
  assert.equal(r.log.filter((l) => /host pause lifted/.test(l)).length, 2);
  assert.equal(count(r.world.events, 'review-released'), 0);
});

test('orders sent BEFORE a pause do not count toward the 2 of the escalation: 2 orders, a 40 min pause, then the order goes out again before the implementer is replaced (3 orders to the first one, replaced after the resume — never during)', async () => {
  const r = await go('pause-order', { stallMs: 4 * 3_600_000 });
  assert.equal(r.result.exit, 0, JSON.stringify(r.result.report.parked));
  assert.equal(count(r.world.events, 'act-while-paused'), 0);
  const replacedAt = r.world.events.find((e) => e.ev === 'impl-replaced')!.t;
  const resumeAt = r.world.events.find((e) => e.ev === 'host-resume')!.t;
  assert.ok(replacedAt > resumeAt, 'replaced after the resume');
  const firstWs = r.world.events.find((e) => e.ev === 'sync-order')!.ws;
  const before = r.world.events.filter((e) => e.ev === 'sync-order' && e.ws === firstWs && e.t < replacedAt).length;
  assert.equal(before, 3, 'orders 1 and 2 before the pause, order 2 again after it (the count restarted at 1)');
  assert.ok((replacedAt - T0) > 60 * 60_000, 'not at the pre-pause minute 24');
});

test('a pause nobody lifts (a human\'s) is waited out for ever: no stall, nothing parked, nothing acted — the run ends exit 4 at the pass limit', async () => {
  const r = await go('pause-human', { maxPasses: 400 });
  assert.equal(r.result.exit, 4, r.result.reason);
  assert.match(r.result.reason ?? '', /paused by the host/);
  assert.equal(count(r.world.events, 'act-while-paused'), 0);
  assert.deepEqual(r.result.report.parked, [], 'no ticket parked by a stall that the pause caused');
  assert.equal(r.log.filter((l) => /host pause: the run is paused/.test(l)).length, 1);
});

test('the pause cannot be read: nothing is done that pass (unknown is never "not paused"); the read is retried and the run goes on', async () => {
  let calls = 0;
  const wrap = (d: ReturnType<typeof import('./fanout-loop-dummy.ts').buildDummy>) => ({ ...d, fleet: { ...d.fleet, async runPause() { if (++calls <= 3) throw new Error('the bus is locked'); return d.fleet.runPause!(); } } });
  const r = await go('pause-review', {}, wrap);
  assert.equal(r.result.exit, 0);
  const firstSpawn = r.world.events.find((e) => e.ev === 'spawn')!.t;
  assert.ok(firstSpawn - T0 >= 3 * 60_000, `first spawn at +${(firstSpawn - T0) / 60_000} min: the 3 unreadable passes started nothing`);
  assert.ok(r.log.some((l) => /host pause unreadable: the bus is locked/.test(l)));
});

test('resetAfterPause: an order already sent counts as ONE with its wait restarted; the points\' counters shrink the same way; idle marks, bounded waits and the pause mark are forgotten', () => {
  const t = '2026-01-01T01:00:00.000Z', old = '2026-01-01T00:00:00.000Z';
  let s = newState('r', { target: 'main', repo: null, now: old, switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' } });
  s = setPlan(s, ['A'], 'declare', old);
  s = applyTicketPatch(s, 'A', { dependsOn: [] }, old);
  const loop = { asked: {}, askedTo: {}, signalled: {}, handled: {}, checksSeen: {}, held: {}, busySince: { 'review:A:h': old }, replaced: { 'rev:A:h': 1 }, reconnects: {}, orders: { A: { head: 'h', n: 2, at: old, reason: 'merge-conflict' }, B: { head: 'h', n: 1, at: old, reason: 'x', replacing: true as const } }, pointOrders: { '1': { head: 'h', n: 2, at: old, total: 3 }, '2': { head: 'h', n: 1, at: old, total: 1 } }, idle: { 'rev:ws:h': { wokenAt: old } }, hostPause: { since: old, by: 'host:usage_limit' } };
  const out = resetAfterPause(withLoop(s, loop), t).loop;
  assert.deepEqual(out.orders.A, { head: 'h', n: 1, at: t, reason: 'merge-conflict' });
  assert.equal(out.orders.B.replacing, true, 'a release in progress stays');
  assert.deepEqual(out.pointOrders['1'], { head: 'h', n: 1, at: t, total: 2 });
  assert.deepEqual(out.pointOrders['2'], { head: 'h', n: 1, at: t, total: 1 });
  assert.deepEqual([out.idle, out.busySince], [{}, {}]);
  assert.equal('hostPause' in out, false);
  assert.deepEqual(out.replaced, { 'rev:A:h': 1 }, 'the death counters are not the pause\'s to reset');
});
