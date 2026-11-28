// #676 — the loop's share of an open point, against a hand-made ctx: the order to the `about` implementer (like SYNC), the spacing, the follow-up ticket when `about` is merged, the fixed rule, the approvals held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketPatch, newState, setPlan, type FanoutState } from './fanout-state.ts';
import { withLoop, type LoopState } from './fanout-loop-side.ts';
import { DEFAULT_OPTIONS, stepApprovals, type LoopCtx } from './fanout-loop.ts';
import { MAX_POINT_ORDERS, stepOpenPoints } from './fanout-loop-points.ts';
import { openPointsOf, recordOpenPoint } from './fanout-open-point.ts';

const T0 = Date.parse('2026-11-27T10:00:00.000Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const MIN = 60_000;
const HA = 'a'.repeat(40), HA2 = 'c'.repeat(40), HB = 'b'.repeat(40);

interface W { idle: Map<string, number>; ctx: LoopCtx; st(): LoopState; woken: Array<{ ws: string; text: string }>; did: string[]; clock: { ms: number }; live: Set<string>; busy(): boolean; waited: string[] }
function world(): W {
  let s: FanoutState = newState('r1', { now: iso(0), switches: { seatRecords: 'on', minorPolicy: 'demonstrated' } as never });
  s = setPlan(s, ['A1', 'B1'], 'declare', iso(0));
  for (const id of ['A1', 'B1']) s = applyTicketPatch(s, id, { dependsOn: [] }, iso(0));
  s = applyTicketPatch(s, 'A1', { status: 'nominated', branch: 'a1', head: HA, implementer: 'impl-a', pr: 1 }, iso(0));
  s = applyTicketPatch(s, 'B1', { status: 'nominated', branch: 'b1', head: HB, implementer: 'impl-b', pr: 2 }, iso(0));
  s = recordOpenPoint(s, 'B1', { about: 'A1', text: 'A1 must dispatch the event on a manual mark', callerId: 'impl-b', callerVouched: true, now: iso(0) }).state;
  let state: LoopState = withLoop(s);
  const w = { woken: [] as W['woken'], did: [] as string[], clock: { ms: 0 }, live: new Set(['impl-a', 'impl-b']), waited: [] as string[], busyFlag: false, idle: new Map<string, number>() };
  const ctx = {
    deps: {
      home: '/nowhere', run: 'r1', caller: 'r1', now: () => iso(w.clock.ms), sleep: async () => {}, log: () => {}, options: { ...DEFAULT_OPTIONS, stallMs: 4 * 60 * MIN },
      fleet: { live: (ws: string) => w.live.has(ws), idleFor: (ws: string) => w.idle.get(ws) ?? null, wake: async (ws: string, text: string) => { w.woken.push({ ws, text }); } },
    },
    run: 'r1', pass: 1, signals: new Set(), approved: new Map(), progress: [], finished: false,
    get busy() { return w.busyFlag; }, set busy(v: boolean) { w.busyFlag = v; },
    note: () => {}, waitOn: (key: string) => { w.waited.push(key); w.busyFlag = true; return true; }, guard: async (_l: string, fn: () => Promise<void>) => { await fn(); return true; },
    st: () => state, update: (fn: (x: LoopState) => LoopState) => (state = fn(state)), did: (m: string) => { w.did.push(m); },
  } as unknown as LoopCtx;
  return { idle: w.idle, ctx, st: () => state, woken: w.woken, did: w.did, clock: w.clock, live: w.live, busy: () => w.busyFlag, waited: w.waited };
}
const review = (w: W, id: string, head: string, verdict: 'approve' | 'changes-requested', n = 1): void => {
  const upd = w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void;
  upd((x) => ({ ...x, tickets: { ...x.tickets, [id]: { ...x.tickets[id], reviews: [...(x.tickets[id].reviews ?? []), { n, reviewer: `rev-${id}`, head, tree: null, verdict, findings: [], closed: [], at: iso(w.clock.ms) }] } } }));
};
const setHead = (w: W, id: string, head: string): void => { (w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void)((x) => ({ ...x, tickets: { ...x.tickets, [id]: { ...x.tickets[id], head } } })); };

test('the point goes to the about ticket\'s implementer as an ORDER; the next pass inside the wait sends nothing (busy)', async () => {
  const w = world();
  await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 1);
  assert.equal(w.woken[0].ws, 'impl-a');
  assert.match(w.woken[0].text, /^OPEN POINT 1 — B1 left a point about your ticket A1:\nA1 must dispatch the event on a manual mark\n/);
  assert.match(w.woken[0].text, /approves with the point listed as addressed/);
  assert.deepEqual(w.st().loop.pointOrders['1'], { head: HA, n: 1, at: iso(0), total: 1 });
  w.clock.ms = 5 * MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 1, 'the implementer is on it: no second order inside orderWaitMs');
  assert.equal(w.busy(), true);
});

test('idle-rule: an implementer whose session is idle (nothing queued) gets order 2 at the next pass, not after orderWaitMs (15 min); a running one keeps the 15 min wait', async () => {
  const w = world();
  await stepOpenPoints(w.ctx);
  w.clock.ms = 1 * MIN; await stepOpenPoints(w.ctx); // running or a message queued for it (idleFor null): on it
  assert.equal(w.woken.length, 1, 'running: no second order');
  w.idle.set('impl-a', 11 * MIN); // idle, nothing queued
  w.clock.ms = 2 * MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 2, 'idle with the order unanswered: woken again at once');
  assert.match(w.woken[1].text, /order 2: your head has not moved since/);
  assert.ok(w.did.some((d) => /A1: impl-a idle 11 min owing the answer to open point 1 — woken again/.test(d)), w.did.join('|'));
});

test('the same head after the wait: order 2; after the next wait the loop\'s FIXED RULE decides — recorded as a decision (by loop), the point settles and unblocks both tickets', async () => {
  const w = world();
  await stepOpenPoints(w.ctx);
  w.clock.ms = 16 * MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 2);
  assert.match(w.woken[1].text, /order 2: your head has not moved since/);
  w.clock.ms = 32 * MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 2, 'no third order');
  const p = openPointsOf(w.st())[0];
  assert.deepEqual([p.status, p.settled!.how, p.settled!.by], ['settled', 'decided', 'loop']);
  assert.match(p.settled!.text!, /fixed rule of the loop \(reversible option\).*2 orders to impl-a and A1 has no new head/);
  assert.ok(w.did.some((d) => /decided by the fixed rule/.test(d)), 'a recorded decision is progress');
});

test('a new head the reviewer has not read: wait (no order); read and APPROVED without addressing it: a new order; at the cap the fixed rule decides; changes-requested: wait for the corrections', async () => {
  const w = world();
  await stepOpenPoints(w.ctx);
  setHead(w, 'A1', HA2);
  w.clock.ms = 20 * MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 1, 'the new head answers the order: the reviewer reads it first');
  assert.ok(w.waited.some((k) => k.startsWith('point:1:')));
  review(w, 'A1', HA2, 'changes-requested');
  await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 1, 'changes requested: the corrections step is on it');
  review(w, 'A1', HA2, 'approve', 2);
  await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 2, 'approved without addressing the point: ordered again');
  assert.deepEqual(w.st().loop.pointOrders['1'], { head: HA2, n: 1, at: iso(20 * MIN), total: 2 });
  // a loop of heads that approve without addressing it ends at the cap
  let head = HA2, total = 2;
  for (let i = 0; total < MAX_POINT_ORDERS; i++) { head = String(i + 3).repeat(40); setHead(w, 'A1', head); review(w, 'A1', head, 'approve', 3 + i); w.clock.ms += MIN; await stepOpenPoints(w.ctx); total++; }
  assert.equal(w.woken.length, MAX_POINT_ORDERS);
  head = '9'.repeat(40); setHead(w, 'A1', head); review(w, 'A1', head, 'approve', 20); w.clock.ms += MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, MAX_POINT_ORDERS, 'past the cap: no more orders');
  assert.equal(openPointsOpen(w), 0);
  assert.match(openPointsOf(w.st())[0].settled!.text!, new RegExp(`${MAX_POINT_ORDERS} orders and the approved head 9{12} still does not address it`));
});
const openPointsOpen = (w: W): number => openPointsOf(w.st()).filter((p) => p.status === 'open').length;

test('about already MERGED: the loop opens the follow-up ticket (followUpOf set, in the plan, todo — `start` gives it an implementer); nobody is ordered', async () => {
  const w = world();
  (w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void)((x) => ({ ...x, tickets: { ...x.tickets, A1: { ...x.tickets.A1, status: 'merged' as const } } }));
  await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 0);
  const s = w.st();
  assert.deepEqual([s.tickets['A1-op1'].followUpOf, s.tickets['A1-op1'].status, s.plan!.tickets.includes('A1-op1'), openPointsOf(s)[0].followUp], ['A1', 'todo', true, 'A1-op1']);
  assert.ok(w.did.some((d) => /follow-up ticket A1-op1 opened \(followUpOf A1\)/.test(d)));
  await stepOpenPoints(w.ctx); // next pass: the follow-up flows through the ordinary steps; one ticket only
  assert.deepEqual(Object.keys(w.st().tickets).sort(), ['A1', 'A1-op1', 'B1']);
});

test('the ticket it is about is parked / dropped: nothing can address the point — the fixed rule decides at once; a dead implementer is waited for (start replaces it), never ordered', async () => {
  const dead = world();
  dead.live.delete('impl-a');
  await stepOpenPoints(dead.ctx);
  assert.deepEqual([dead.woken.length, openPointsOpen(dead)], [0, 1]);
  assert.ok(dead.waited.some((k) => k === 'point:1:start'));
  const parked = world();
  (parked.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void)((x) => ({ ...x, tickets: { ...x.tickets, A1: { ...x.tickets.A1, status: 'dropped' as const } } }));
  await stepOpenPoints(parked.ctx);
  assert.equal(openPointsOpen(parked), 0);
  assert.match(openPointsOf(parked.st())[0].settled!.text!, /A1 is dropped — nothing can address the point/);
});

test('approvals: an approved head is NOT approved (no merge, no CONNECT) while a point it raised / is about is open; free once settled', async () => {
  const w = world();
  const upd = w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void;
  review(w, 'A1', HA, 'approve'); review(w, 'B1', HB, 'approve');
  await stepApprovals(w.ctx);
  assert.deepEqual([...w.ctx.approved.keys()], [], 'both tickets are held by the open point');
  upd((x) => ({ ...x, openPoints: x.openPoints!.map((p) => ({ ...p, status: 'settled' as const, settled: { how: 'decided' as const, at: iso(0), by: 'r1', text: 'ok' } })) }));
  await stepApprovals(w.ctx);
  assert.deepEqual([...w.ctx.approved.keys()].sort(), ['A1', 'B1']);
});
