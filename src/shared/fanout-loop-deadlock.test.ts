// #688 — the open-point DEADLOCK (host 2, attempt 4): a point raised by A about B, B dependsOn A. B cannot be reviewed before it connects to A, the CONNECT waits for A's approval, A's approval waited for the point → nobody moved.
// The rig: 3 tickets (A, B dependsOn A, C unrelated), real `stepApprovals` / `stepOpenPoints` against a hand-made ctx. Each test fails on the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketPatch, newState, setPlan, type FanoutState } from './fanout-state.ts';
import { withLoop, type LoopState } from './fanout-loop-side.ts';
import { DEFAULT_OPTIONS, NOTE_REPEAT_PASSES, newCtx, stepApprovals, type LoopCtx } from './fanout-loop.ts';
import { stepOpenPoints } from './fanout-loop-points.ts';
import { openPointBlocked, openPointRefusal, openPointsOf, pointReleases, recordOpenPoint } from './fanout-open-point.ts';

const T0 = Date.parse('2026-11-27T10:00:00.000Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const MIN = 60_000;
const H: Record<string, string> = { A: 'a'.repeat(40), B: 'b'.repeat(40), C: 'c'.repeat(40) };

interface W { ctx: LoopCtx; st(): LoopState; woken: Array<{ ws: string; text: string }>; notes: string[]; clock: { ms: number }; waited: string[] }
/** A, B (dependsOn A), C; the point(s) given are raised as [from, about]. */
function world(points: Array<[string, string]>, opts: { bConnected?: boolean } = {}): W {
  let s: FanoutState = newState('r1', { now: iso(0), switches: { seatRecords: 'on', minorPolicy: 'demonstrated' } as never });
  s = setPlan(s, ['A', 'B', 'C'], 'declare', iso(0));
  for (const id of ['A', 'B', 'C']) s = applyTicketPatch(s, id, { dependsOn: id === 'B' ? ['A'] : [] }, iso(0));
  const set = (id: string, patch: object): void => { s = { ...s, tickets: { ...s.tickets, [id]: { ...s.tickets[id], ...patch } } }; }; // the rig sets the facts the loop reads; the state's own gates are not under test
  for (const id of ['A', 'B', 'C']) set(id, { status: 'nominated', branch: id.toLowerCase(), head: H[id], implementer: `impl-${id}`, pr: id.charCodeAt(0) - 64 });
  if (opts.bConnected) set('B', { builtOn: { A: H.A } });
  for (const [from, about] of points) s = recordOpenPoint(s, from, { about, text: `${from} needs ${about} to do the thing`, callerId: `impl-${from}`, callerVouched: true, now: iso(0) }).state;
  let state: LoopState = withLoop(s);
  const w = { woken: [] as W['woken'], notes: [] as string[], clock: { ms: 0 }, waited: [] as string[] };
  const deps = { home: '/nowhere', run: 'r1', now: () => iso(w.clock.ms), sleep: async () => {}, log: (l: string) => { w.notes.push(l); }, options: { ...DEFAULT_OPTIONS, stallMs: 4 * 60 * MIN }, fleet: { live: () => true, wake: async (ws: string, text: string) => { w.woken.push({ ws, text }); } } };
  const ctx = { ...newCtx(deps as never, 1, new Map()), st: () => state, update: (fn: (x: LoopState) => LoopState) => (state = fn(state)), guard: async (_l: string, fn: () => Promise<void>) => { await fn(); return true; } } as unknown as LoopCtx;
  const real = ctx.waitOn; void real;
  ctx.waitOn = (key: string) => { w.waited.push(key); ctx.busy = true; return true; };
  return { ctx, st: () => state, woken: w.woken, notes: w.notes, clock: w.clock, waited: w.waited };
}
const approve = (w: W, id: string): void => {
  (w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void)((x) => ({ ...x, tickets: { ...x.tickets, [id]: { ...x.tickets[id], status: 'nominated' as const, reviews: [...(x.tickets[id].reviews ?? []), { n: 1, reviewer: `rev-${id}`, head: H[id], tree: null, verdict: 'approve' as const, findings: [], closed: [], at: iso(w.clock.ms) }] } } }));
};

test('rule 1: a point raised by A about B (B dependsOn A) holds B only — A is approved, so its merge and B\'s CONNECT are free', async () => {
  const w = world([['A', 'B']]);
  approve(w, 'A'); approve(w, 'B');
  assert.equal(openPointBlocked(w.st(), 'A'), false, 'the raiser is not held');
  assert.equal(openPointRefusal(w.st(), 'A'), null, 'neither is its `gate` / `deliver`');
  assert.equal(openPointBlocked(w.st(), 'B'), true, 'the ticket the point is about stays held until its reviewer addresses it');
  await stepApprovals(w.ctx);
  assert.deepEqual([...w.ctx.approved.keys()], ['A']);
});

test('rule 1 is TRANSITIVE: B dependsOn M dependsOn A — a point by A about B still holds B only', () => {
  const w = world([['A', 'B']]);
  (w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void)((x) => ({ ...x, tickets: { ...x.tickets, M: { ...x.tickets.A, dependsOn: ['A'], status: 'started' as const }, B: { ...x.tickets.B, dependsOn: ['M'] } } }));
  assert.equal(openPointBlocked(w.st(), 'A'), false);
  assert.equal(openPointBlocked(w.st(), 'B'), true);
});

test('the other shapes keep today\'s rule: a point about an UPSTREAM, or between UNRELATED tickets, holds both', () => {
  const up = world([['B', 'A']]); // B raises about its upstream A
  assert.deepEqual([openPointBlocked(up.st(), 'A'), openPointBlocked(up.st(), 'B')], [true, true]);
  const un = world([['A', 'C']]);
  assert.deepEqual([openPointBlocked(un.st(), 'A'), openPointBlocked(un.st(), 'C')], [true, true]);
  assert.equal(pointReleases(un.st()).size, 0);
});

test('rule 2: the order to B waits for its connection to A (no order, a bounded wait); once connected it is sent at once, re-sent after orderWaitMs, and the point never stays at one order', async () => {
  const w = world([['A', 'B']]);
  await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 0, 'B is not connected to A: it cannot even be reviewed, the order waits');
  assert.ok(w.waited.includes('point:1:connect'));
  const upd = w.ctx.update as unknown as (f: (x: LoopState) => LoopState) => void;
  upd((x) => ({ ...x, tickets: { ...x.tickets, B: { ...x.tickets.B, builtOn: { A: H.A } } } }));
  await stepOpenPoints(w.ctx);
  assert.deepEqual(w.woken.map((x) => x.ws), ['impl-B']);
  w.clock.ms = 16 * MIN; await stepOpenPoints(w.ctx);
  assert.equal(w.woken.length, 2, 're-sent after orderWaitMs');
  assert.match(w.woken[1].text, /order 2/);
  const already = world([['A', 'B']], { bConnected: true });
  await stepOpenPoints(already.ctx);
  assert.equal(already.woken.length, 1, 'already connected: at once');
});

test('rule 3: every approval hold is LOGGED naming the ticket, the hold and who lifts it', async () => {
  const w = world([['A', 'C']]); // unrelated: both held
  approve(w, 'A');
  await stepApprovals(w.ctx);
  const line = w.notes.find((l) => /A: approval held by open point 1 \(A → C\)/.test(l));
  assert.ok(line, w.notes.join('\n'));
  assert.match(line!, /lifted by the reviewer of C approving a NEW head.*--decide 1=.*fixed rule/);
  // a blocking finding on the recorded approve and an unsettled MINOR are logged too
  const f = world([]);
  (f.ctx.update as unknown as (x: (y: LoopState) => LoopState) => void)((x) => ({ ...x, switches: { ...x.switches, minorPolicy: 'spec' } as never }));
  approve(f, 'C');
  (f.ctx.update as unknown as (x: (y: LoopState) => LoopState) => void)((x) => ({ ...x, tickets: { ...x.tickets, C: { ...x.tickets.C, findings: { 'F1': { severity: 'MINOR', kind: 'code', specSentence: 'it must work' } } as never, specText: 'it must work always' } } }));
  await stepApprovals(f.ctx);
  assert.ok(f.notes.some((l) => /C: approval held — unsettled finding\(s\) F1/.test(l)), f.notes.join('\n'));
});

test('rule 3: the note repeats at most once per NOTE_REPEAT_PASSES passes (the shared dedupe)', async () => {
  const seen = new Map<string, number>();
  const logs: string[] = [];
  const mk = (pass: number): LoopCtx => { const w = world([['A', 'C']]); return { ...w.ctx, note: newCtx({ ...(w.ctx.deps as object), log: (l: string) => logs.push(l) } as never, pass, seen).note } as LoopCtx; };
  for (let pass = 1; pass <= NOTE_REPEAT_PASSES; pass++) { const c = mk(pass); approve({ ctx: c, st: c.st, clock: { ms: 0 } } as unknown as W, 'A'); await stepApprovals(c); }
  assert.equal(logs.filter((l) => /approval held by open point 1/.test(l)).length, 1);
});

test('rule 4: a hold CYCLE is said once as "deadlock: …" and broken — mutual points between A and C: A is released from its own point', async () => {
  const w = world([['A', 'C'], ['C', 'A']]);
  const rel = pointReleases(w.st());
  assert.equal(rel.size, 1, 'one point of the cycle is released, the other keeps its two holds');
  assert.equal([...rel.values()][0].kind, 'cycle');
  approve(w, 'A'); approve(w, 'C');
  await stepApprovals(w.ctx);
  assert.equal(w.notes.filter((l) => /deadlock: point 1 \(A → C\) waits in a cycle A → C → A/.test(l)).length, 1, w.notes.join('\n'));
  assert.equal(w.ctx.approved.size, 0, 'both still hold the OTHER point as its about ticket — the cycle is broken, not the points (their reviewers settle them)');
  const first = openPointsOf(w.st())[0];
  assert.equal(openPointBlocked(w.st(), first.from) && openPointBlocked(w.st(), first.about), true);
});
