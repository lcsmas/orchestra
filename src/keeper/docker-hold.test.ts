// #321 — the keeper's Docker HOLD gate over a fake clock / fake files / fake meter: held ⇒ waits and is VISIBLE (hold file: count, since, reason), memory back ⇒ goes out BY ITSELF, FIFO one at a time with a FRESH
// reading and a settle between releases, a newcomer joins an existing line, no / stale / foreign state ⇒ nothing is held and a waiting line is flushed, a client that leaves never gets its call forwarded.
// Each arm names the clause it protects (in-place mutants: scripts/docker-hold-mutants.list.mjs, run by scripts/docker-relay-mutants.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoldGate, type HoldAdmitted, type HoldGate } from './docker-hold.ts';
import { ADMISSION_STATE_TTL_MS, type AdmissionState, type HoldFile } from '../shared/docker-hold.ts';

const GIB = 1024 ** 3;
const STATE = '/h/admission.state';
const HOLD = '/h/keepers/ws.docker.hold';

const state = (over: Partial<AdmissionState> = {}, ts = 1_000_000): AdmissionState => ({
  v: 1, ts, held: true, enabled: true, heldSince: ts - 5_000, episode: 2, availBytes: 5.5 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB, ...over,
});

class Rig {
  clock = 1_000_000;
  files = new Map<string, string>();
  mem: number | null = 8 * GIB; // a FRESH reading well above threshold + margin by default
  sleeps = 0;
  writes: Array<{ file: string; hold: HoldFile }> = [];
  removes: string[] = [];
  logs: string[] = [];
  /** Runs after every poll/settle sleep (the clock has advanced): a test flips the world here. */
  onSleep: ((n: number) => void) | null = null;
  gate: HoldGate;
  setState(s: AdmissionState | string | null): void {
    if (s === null) this.files.delete(STATE);
    else this.files.set(STATE, typeof s === 'string' ? s : JSON.stringify(s));
  }
  constructor(o: { pollMs?: number; settleMs?: number } = {}) {
    this.gate = createHoldGate({
      stateFile: STATE,
      holdFile: HOLD,
      now: () => this.clock,
      readMem: () => this.mem,
      readText: (f) => this.files.get(f) ?? null,
      writeFile: (f, t) => { this.files.set(f, t); if (f === HOLD) this.writes.push({ file: f, hold: JSON.parse(t) as HoldFile }); },
      removeFile: (f) => { this.files.delete(f); this.removes.push(f); },
      sleep: (ms) => new Promise<void>((r) => setImmediate(() => { this.clock += ms; this.sleeps++; this.onSleep?.(this.sleeps); r(); })),
      pollMs: o.pollMs ?? 1_000,
      settleMs: o.settleMs ?? 1_500,
      log: (m) => this.logs.push(m),
    });
  }
  hold(): HoldFile | null {
    const t = this.files.get(HOLD);
    return t ? (JSON.parse(t) as HoldFile) : null;
  }
}
const live = (): AbortSignal => new AbortController().signal;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** `p` is still pending after a few turns of the event loop. */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 5; i++) await tick();
  return !done;
}

test('no state file / garbage / another version ⇒ NOTHING is held (fail open); no hold file is ever written', async () => {
  const r = new Rig();
  for (const s of [null, 'not json', JSON.stringify({ ...state(), v: 2 }), JSON.stringify({ ...state(), held: 'yes' }), JSON.stringify({ ...state(), admissionBytes: null })]) {
    r.setState(s);
    assert.deepEqual(await r.gate.admit('create', live()), { waitedMs: 0, reason: null }, `state ${String(s).slice(0, 40)}`);
  }
  assert.equal(r.writes.length, 0);
  assert.equal(r.sleeps, 0, 'never even polled');
});

test('state NOT held ⇒ a create goes straight out (waited 0)', async () => {
  const r = new Rig();
  r.setState(state({ held: false, heldSince: null }));
  assert.deepEqual(await r.gate.admit('create', live()), { waitedMs: 0, reason: null });
  assert.equal(r.writes.length, 0);
});

test('HELD ⇒ the call WAITS and is VISIBLE: the hold file carries the count, the oldest since and the reason (reading, threshold, since, episode); memory back ⇒ it proceeds BY ITSELF and the file disappears', async () => {
  const r = new Rig();
  r.setState(state());
  const t0 = r.clock;
  const p = r.gate.admit('create', live());
  assert.ok(await pending(p), 'held: the call does not return');
  const h = r.hold()!;
  assert.equal(h.create, 1);
  assert.equal(h.start, 0);
  assert.equal(h.since, t0);
  assert.equal(h.episode, 2);
  assert.match(h.reason, /Admission hold: MemAvailable 5\.50 GB < 6\.00 GB \(reopens above 7\.00 GB; episode 2, held since \d\d:\d\d:\d\dZ\)/);
  assert.equal(r.gate.waiting(), 1);
  r.setState(state({ held: false, heldSince: null }, r.clock)); // the guard reopened
  const done = (await p) as HoldAdmitted;
  assert.ok(done.waitedMs >= 1_000, `waited ${done.waitedMs} ms`);
  assert.match(done.reason ?? '', /Admission hold: MemAvailable 5\.50 GB/);
  assert.equal(r.hold(), null, 'nothing waits any more: the file is gone');
  assert.equal(r.gate.waiting(), 0);
});

test('a start is counted apart from a create in the hold file', async () => {
  const r = new Rig();
  r.setState(state());
  const a = r.gate.admit('create', live());
  const b = r.gate.admit('start', live());
  const c = r.gate.admit('start', live());
  await pending(a);
  assert.deepEqual([r.hold()!.create, r.hold()!.start], [1, 2]);
  r.setState(state({ held: false }, r.clock));
  await Promise.all([a, b, c]);
});

test('FIFO, ONE AT A TIME: each release needs a FRESH reading above threshold + margin and is followed by a settle — the line goes out in arrival order, spaced by the settle', async () => {
  const r = new Rig({ settleMs: 1_500, pollMs: 1_000 });
  r.setState(state());
  const order: string[] = [];
  const at: Record<string, number> = {};
  const go = (name: string): Promise<void> => r.gate.admit('create', live()).then(() => { order.push(name); at[name] = r.clock; });
  const ps = [go('a'), go('b'), go('c')];
  await tick();
  const reopenedAt = r.clock;
  // the guard reopens, but the FRESH reading is not back far enough: nobody goes out
  r.setState(state({ held: false, heldSince: null }, r.clock));
  r.mem = 6.5 * GIB; // above the 6 GB threshold, below threshold + 1 GB margin
  const sleepsBefore = r.sleeps;
  r.onSleep = (n) => { if (n >= sleepsBefore + 3) r.mem = 8 * GIB; }; // memory comes back after three polls
  await Promise.all(ps);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.ok(at.a - reopenedAt >= 3_000 && at.b - at.a >= 1_500 && at.c - at.b >= 1_500, `spaced by the settle: ${JSON.stringify(at)}`);
  assert.ok(r.sleeps >= sleepsBefore + 3, 'it kept polling while the fresh reading said « not yet »');
});

test('a NEWCOMER joins the line while one is draining (never overtakes it)', async () => {
  const r = new Rig({ settleMs: 2_000 });
  r.setState(state());
  const order: string[] = [];
  const go = (name: string): Promise<void> => r.gate.admit('create', live()).then(() => void order.push(name));
  const a = go('a');
  const b = go('b');
  await tick();
  r.setState(state({ held: false, heldSince: null }, r.clock));
  let late: Promise<void> | null = null;
  r.onSleep = () => { if (!late) late = go('late'); }; // arrives while the first release is settling: the state is NOT held any more, the line is not empty
  await Promise.all([a, b]);
  await late;
  assert.deepEqual(order, ['a', 'b', 'late']);
});

test('the guard holds AGAIN mid-release ⇒ the rest of the line waits again', async () => {
  const r = new Rig({ settleMs: 1_000 });
  r.setState(state());
  const done: string[] = [];
  const go = (n: string): Promise<void> => r.gate.admit('create', live()).then(() => void done.push(n));
  const ps = [go('a'), go('b')];
  await tick();
  r.setState(state({ held: false, heldSince: null }, r.clock));
  r.onSleep = () => { if (done.length >= 1) { r.onSleep = null; r.setState(state({}, r.clock)); } }; // the first release's settle ⇒ memory dropped again
  for (let i = 0; i < 12; i++) await tick();
  assert.deepEqual(done, ['a'], 'a went out, b is held again');
  assert.equal(r.gate.waiting(), 1);
  r.setState(state({ held: false, heldSince: null }, r.clock));
  await Promise.all(ps);
  assert.deepEqual(done, ['a', 'b']);
});

test('STALE state (older than the TTL: the app that decides is gone) ⇒ not held, and a line already waiting is FLUSHED AT ONCE (no settle between releases)', async () => {
  const r = new Rig({ settleMs: 5_000 });
  r.setState(state());
  const ps = [r.gate.admit('create', live()), r.gate.admit('create', live()), r.gate.admit('start', live())];
  await tick();
  const clockBefore = r.clock;
  r.clock += ADMISSION_STATE_TTL_MS + 1; // nobody refreshed the file
  let rs: HoldAdmitted[];
  try {
    rs = (await Promise.race([Promise.all(ps), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the line was NOT flushed: a stale state still holds')), 2_000))])) as HoldAdmitted[];
  } catch (e) {
    r.gate.stop(); // a gate that never flushes would spin on setImmediate sleeps for ever
    throw e;
  }
  assert.equal(rs.length, 3);
  assert.ok(r.clock - clockBefore < ADMISSION_STATE_TTL_MS + 5_000, 'no 5 s settle between the three releases');
  assert.ok(r.logs.some((l) => /no authoritative Admission state .*stale/.test(l)), r.logs.join('|'));
  // and a NEW call under that stale state goes straight out
  assert.deepEqual(await r.gate.admit('create', live()), { waitedMs: 0, reason: null });
});

test('an UNREADABLE fresh reading releases on the guard\'s word (a meter that cannot answer never wedges the line)', async () => {
  const r = new Rig();
  r.setState(state());
  const p = r.gate.admit('create', live());
  await tick();
  r.mem = null;
  r.setState(state({ held: false, heldSince: null }, r.clock));
  assert.ok(((await p) as HoldAdmitted).waitedMs >= 0);
});

test('a client that LEAVES while held never gets its call forwarded: it leaves the line, the hold file is updated, the next one is unaffected', async () => {
  const r = new Rig();
  r.setState(state());
  const ac = new AbortController();
  const gone = r.gate.admit('create', ac.signal);
  const stays = r.gate.admit('start', live());
  await tick();
  assert.equal(r.hold()!.create + r.hold()!.start, 2);
  ac.abort();
  assert.equal(await gone, null);
  assert.deepEqual([r.hold()!.create, r.hold()!.start], [0, 1], 'the file no longer counts the one that left');
  r.setState(state({ held: false, heldSince: null }, r.clock));
  assert.ok(await stays);
  assert.equal(r.hold(), null);
});

test('an already-aborted signal is never queued', async () => {
  const r = new Rig();
  r.setState(state());
  const ac = new AbortController();
  ac.abort();
  assert.equal(await r.gate.admit('create', ac.signal), null);
  assert.equal(r.gate.waiting(), 0);
});

test('the hold file is refreshed at least every 5 s while anything waits (a dead keeper\'s leftover reads as stale)', async () => {
  const r = new Rig({ pollMs: 1_000 });
  r.setState(state({}, 1_000_000));
  const p = r.gate.admit('create', live());
  for (let i = 0; i < 14; i++) { r.setState(state({ availBytes: 5.4 * GIB }, r.clock)); await new Promise((x) => setImmediate(x)); }
  const ts = r.writes.map((w) => w.hold.ts);
  assert.ok(ts.length >= 3, `heartbeats written: ${ts.length}`);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] <= 6_000, `gap ${ts[i] - ts[i - 1]} ms`);
  r.setState(state({ held: false }, r.clock));
  await p;
});

test('stop(): the line is dropped, the hold file removed, no timer left (keeper exit)', async () => {
  const r = new Rig();
  r.setState(state());
  const p = r.gate.admit('create', live());
  await tick();
  assert.ok(r.hold());
  r.gate.stop();
  assert.equal(await p, null);
  assert.equal(r.hold(), null);
  assert.equal(await r.gate.admit('create', live()), null, 'a stopped gate admits nothing');
});

test('a hold file that cannot be written is logged ONCE and never fails the call', async () => {
  const r = new Rig();
  let fails = 0;
  const gate = createHoldGate({
    stateFile: STATE, holdFile: HOLD, now: () => r.clock, readMem: () => 8 * GIB, readText: (f) => r.files.get(f) ?? null,
    writeFile: () => { fails++; throw new Error('EROFS'); }, removeFile: () => {}, sleep: (ms) => new Promise((x) => setImmediate(() => { r.clock += ms; x(); })), pollMs: 1_000, settleMs: 100, log: (m) => r.logs.push(m),
  });
  r.setState(state());
  const p = gate.admit('create', live());
  await tick();
  r.setState(state({ held: false }, r.clock));
  assert.ok(await p);
  assert.ok(fails >= 1);
  assert.equal(r.logs.filter((l) => /cannot publish/.test(l)).length, 1);
});

test('the published `since` is the OLDEST waiting request\'s, not the newest\'s', async () => {
  const r = new Rig();
  r.setState(state());
  const t0 = r.clock;
  const a = r.gate.admit('create', live());
  r.clock += 7_000;
  const b = r.gate.admit('create', live());
  await pending(a);
  assert.equal(r.hold()!.create, 2);
  assert.equal(r.hold()!.since, t0, 'the oldest wait, not the arrival of the second');
  r.setState(state({ held: false }, r.clock));
  await Promise.all([a, b]);
});

test('a state file that is THERE but unreadable (truncated / another version) lets the call through AND is logged — once until it reads again', async () => {
  const r = new Rig();
  const valid = JSON.stringify(state({ held: false }));
  r.setState(null);
  await r.gate.admit('create', live());
  assert.equal(r.logs.filter((l) => /unreadable/.test(l)).length, 0, 'an ABSENT file is not an error: nothing logged');
  r.setState(valid.slice(0, 40)); // a torn read
  assert.deepEqual(await r.gate.admit('create', live()), { waitedMs: 0, reason: null });
  assert.deepEqual(await r.gate.admit('create', live()), { waitedMs: 0, reason: null });
  assert.equal(r.logs.filter((l) => /unreadable/.test(l)).length, 1, 'one line, not one per call');
  assert.match(r.logs[0], /treated as no hold \(fail open\)/);
  r.setState(valid);
  await r.gate.admit('create', live());
  r.setState(JSON.stringify({ ...state(), v: 2 }));
  await r.gate.admit('create', live());
  assert.equal(r.logs.filter((l) => /unreadable/.test(l)).length, 2, 'a new failure after a good read is logged again');
  r.setState(null);
  await r.gate.admit('create', live());
  assert.equal(r.logs.filter((l) => /unreadable/.test(l)).length, 2, 'absent after a failure: still nothing new');
});

test('the Admission TOGGLE OFF releases a waiting line AT ONCE (like Admission\'s planRelease) even when a fresh reading is still low — and says it was flushed, not that memory came back', async () => {
  const r = new Rig({ settleMs: 5_000 });
  r.setState(state());
  r.mem = 1 * GIB; // far below threshold + margin
  const ps = [r.gate.admit('create', live()), r.gate.admit('create', live()), r.gate.admit('start', live())];
  await tick();
  const before = r.clock;
  r.setState(state({ held: false, enabled: false, heldSince: null }, r.clock)); // the operator turned the toggle OFF: the guard still measures low
  const rs = (await Promise.race([Promise.all(ps), new Promise<never>((_, rej) => setTimeout(() => { r.gate.stop(); rej(new Error('the toggle OFF stranded the line')); }, 2_000))])) as HoldAdmitted[];
  assert.ok(rs.every((x) => x.flushed === true), JSON.stringify(rs));
  assert.ok(r.clock - before < 5_000, 'no settle between the releases');
  assert.equal(r.gate.holding(), false);
});

test('a release because memory CAME BACK is not marked flushed; one because the state went stale IS', async () => {
  const r = new Rig();
  r.setState(state());
  const a = r.gate.admit('create', live());
  await tick();
  r.setState(state({ held: false }, r.clock));
  assert.equal(((await a) as HoldAdmitted).flushed, undefined);
  r.setState(state());
  const b = r.gate.admit('create', live());
  await tick();
  r.clock += ADMISSION_STATE_TTL_MS + 1;
  const rb = (await Promise.race([b, new Promise<never>((_, rej) => setTimeout(() => { r.gate.stop(); rej(new Error('a stale state still holds the line')); }, 2_000))])) as HoldAdmitted;
  assert.equal(rb.flushed, true);
});

test('holding(): false without a fresh held state; true while held OR while a line still drains after the guard reopened; false once stopped', async () => {
  const r = new Rig({ settleMs: 1_500 });
  assert.equal(r.gate.holding(), false, 'no state file');
  r.setState(state({ held: false }));
  assert.equal(r.gate.holding(), false, 'open');
  r.setState(state());
  assert.equal(r.gate.holding(), true);
  r.setState(state({}, r.clock - ADMISSION_STATE_TTL_MS - 1));
  assert.equal(r.gate.holding(), false, 'stale');
  r.setState(state({}, r.clock));
  const p = r.gate.admit('create', live());
  await tick();
  r.setState(state({ held: false }, r.clock));
  r.mem = 6.5 * GIB; // reopened, but the fresh reading keeps the line waiting
  assert.equal(r.gate.holding(), true, 'a line exists');
  r.mem = 8 * GIB;
  await p;
  assert.equal(r.gate.holding(), false);
  r.setState(state());
  r.gate.stop();
  assert.equal(r.gate.holding(), false, 'stopped');
});
