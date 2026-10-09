// #321 review M1 — « une à la fois » for the WHOLE FLEET: several keepers' gates share ONE release slot (the lease file beside the app's state file). Real gates + real leases over a shared fake
// directory and ONE virtual clock (a timer wheel: concurrent sleepers do not double-advance time). Each arm names the clause it protects (in-place mutants: scripts/docker-hold-mutants.list.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoldGate, type HoldGate } from './docker-hold.ts';
import { createFleetLine, createReleaseLease, type LeaseIo } from './release-lease.ts';
import { admissionLeaseFile, type AdmissionState } from '../shared/docker-hold.ts';

const GIB = 1024 ** 3;
const STATE = '/h/admission.state';
const SETTLE = 1_500;
const POLL = 1_000;

/** A timer wheel: `sleep` registers a wake time, `run` jumps the clock to the earliest one. */
class VTime {
  now = 1_000_000;
  private timers: Array<{ at: number; resolve: () => void }> = [];
  sleep = (ms: number): Promise<void> => new Promise((resolve) => void this.timers.push({ at: this.now + ms, resolve }));
  async run(until: () => boolean, maxSteps = 2_000): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      for (let k = 0; k < 6; k++) await new Promise<void>((r) => setImmediate(r));
      if (until()) return;
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers.shift();
      if (!t) return;
      this.now = Math.max(this.now, t.at);
      t.resolve();
    }
  }
}

class Dir {
  files = new Map<string, { text: string; at: number }>();
  readonly vt: VTime;
  constructor(vt: VTime) {
    this.vt = vt;
  }
  put(f: string, text: string): void { this.files.set(f, { text, at: this.vt.now }); }
  io(deadPids: ReadonlySet<number> = new Set()): LeaseIo {
    return {
      now: () => this.vt.now,
      createExclusive: (f, text) => { if (this.files.has(f)) return false; this.put(f, text); return true; },
      readText: (f) => this.files.get(f)?.text ?? null,
      ageMs: (f) => (this.files.has(f) ? this.vt.now - this.files.get(f)!.at : null),
      rename: (a, b) => { const x = this.files.get(a); if (!x) throw new Error('ENOENT'); this.files.delete(a); this.files.set(b, x); },
      remove: (f) => void this.files.delete(f),
      pidAlive: (pid) => !deadPids.has(pid),
      listDir: (d) => [...this.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)).filter((n) => !n.includes('/')),
    };
  }
}

const stateOf = (held: boolean, ts: number): AdmissionState => ({ v: 1, ts, held, enabled: true, heldSince: held ? ts - 5_000 : null, episode: 3, availBytes: 5 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB });

function fleet(n: number, o: { lease: boolean; line?: boolean; mem?: () => number | null; dead?: Set<number> }) {
  const vt = new VTime();
  const dir = new Dir(vt);
  const gates: HoldGate[] = [];
  const logs: string[] = [];
  for (let i = 0; i < n; i++) {
    gates.push(createHoldGate({
      stateFile: STATE,
      holdFile: `/h/keepers/ws${i}.docker.hold`,
      now: () => vt.now,
      readMem: o.mem ?? (() => 8 * GIB),
      readText: (f) => dir.files.get(f)?.text ?? null,
      writeFile: (f, t) => dir.put(f, t),
      removeFile: (f) => void dir.files.delete(f),
      sleep: vt.sleep,
      pollMs: POLL,
      settleMs: SETTLE,
      log: (m) => logs.push(`ws${i}: ${m}`),
      ...(o.lease ? { lease: createReleaseLease({ file: admissionLeaseFile(STATE), owner: `ws${i}`, pid: 100 + i, io: dir.io(o.dead), log: (m) => logs.push(`ws${i}: ${m}`) }) } : {}),
      ...(o.lease && o.line !== false ? { fleet: createFleetLine({ ownHoldFile: `/h/keepers/ws${i}.docker.hold`, ownWs: `ws${i}`, pid: 100 + i, leaseFile: admissionLeaseFile(STATE), io: dir.io(o.dead) }) } : {}),
    }));
  }
  return { vt, dir, gates, logs, setState: (held: boolean) => dir.put(STATE, JSON.stringify(stateOf(held, vt.now))) };
}
const live = (): AbortSignal => new AbortController().signal;

test('positive control: ONE keeper — its line leaves one at a time, spaced by the settle (the per-keeper behaviour is unchanged)', async () => {
  const f = fleet(1, { lease: true });
  f.setState(true);
  const at: number[] = [];
  const ps = [0, 1, 2].map(() => f.gates[0].admit('create', live()).then(() => at.push(f.vt.now)));
  await f.vt.run(() => at.length === 0);
  f.setState(false);
  await f.vt.run(() => at.length === 3);
  await Promise.all(ps);
  assert.ok(at[1] - at[0] >= SETTLE && at[2] - at[1] >= SETTLE, JSON.stringify(at));
});

test('M1: K keepers, ONE call each, the guard reopens ⇒ the releases are spaced by the settle ACROSS keepers (the fleet\'s line is one line)', async () => {
  const f = fleet(3, { lease: true });
  f.setState(true);
  const at: Record<string, number> = {};
  const ps = f.gates.map((g, i) => g.admit('start', live()).then(() => (at[`ws${i}`] = f.vt.now)));
  await f.vt.run(() => Object.keys(at).length > 0, 20);
  f.setState(false);
  await f.vt.run(() => Object.keys(at).length === 3);
  await Promise.all(ps);
  const times = Object.values(at).sort((a, b) => a - b);
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= SETTLE && times[2] - times[1] >= SETTLE, `spaced by the settle across the fleet: ${JSON.stringify(times)}`);
});

test('M1 must-FAIL control: the SAME fleet WITHOUT the shared slot releases every keeper\'s call in the same instant (the defect the review measured: 0 ms)', async () => {
  const f = fleet(3, { lease: false });
  f.setState(true);
  const at: number[] = [];
  const ps = f.gates.map((g) => g.admit('start', live()).then(() => at.push(f.vt.now)));
  await f.vt.run(() => at.length > 0, 20);
  f.setState(false);
  await f.vt.run(() => at.length === 3);
  await Promise.all(ps);
  assert.ok(Math.max(...at) - Math.min(...at) < SETTLE, `without the slot they leave together: ${JSON.stringify(at)}`);
});

test('M1: the FRESH reading is taken UNDER the slot — memory that fell while another keeper settled keeps the next keeper in line, and the slot goes back to the fleet', async () => {
  let mem: number | null = 8 * GIB;
  const f = fleet(2, { lease: true, mem: () => mem });
  f.setState(true);
  const at: Record<string, number> = {};
  const ps = f.gates.map((g, i) => g.admit('create', live()).then(() => (at[`ws${i}`] = f.vt.now)));
  await f.vt.run(() => false, 8);
  f.setState(false);
  await f.vt.run(() => Object.keys(at).length === 1);
  mem = 6.5 * GIB; // the container just released shows in the next reading: below threshold + margin
  await f.vt.run(() => false, 12);
  assert.equal(Object.keys(at).length, 1, 'the second keeper stayed in line');
  assert.equal(f.dir.files.has(admissionLeaseFile(STATE)), false, 'and gave the slot back while it waits');
  mem = 8 * GIB;
  await f.vt.run(() => Object.keys(at).length === 2);
  await Promise.all(ps);
});

test('M1: a keeper that DIES holding the slot never wedges the fleet — the next one takes it over at once (pid gone)', async () => {
  const dead = new Set<number>();
  const f = fleet(2, { lease: true, dead });
  f.dir.put(admissionLeaseFile(STATE), JSON.stringify({ v: 1, owner: 'wsDead', pid: 999, ts: f.vt.now }));
  f.setState(false);
  f.setState(true);
  const p = f.gates[0].admit('start', live());
  await f.vt.run(() => false, 6);
  f.setState(false);
  let done = false;
  void p.then(() => (done = true));
  await f.vt.run(() => done, 10); // 10 s: well inside the 20 s TTL
  assert.equal(done, false, 'pid 999 is alive: the slot is busy and the call waits');
  dead.add(999);
  await f.vt.run(() => done, 40);
  assert.equal(done, true, 'once the holder is gone the call goes out');
});

test('M1: stop() gives the slot back (a keeper exiting between its release and the end of its settle must not hold it for the TTL)', async () => {
  const f = fleet(2, { lease: true });
  f.setState(true);
  const p0 = f.gates[0].admit('create', live());
  await f.vt.run(() => false, 6);
  f.setState(false);
  let released = false;
  void p0.then(() => (released = true));
  await f.vt.run(() => released, 40);
  assert.equal(released, true);
  assert.equal(f.dir.files.has(admissionLeaseFile(STATE)), true, 'releasing a call keeps the slot through the settle');
  f.gates[0].stop();
  assert.equal(f.dir.files.has(admissionLeaseFile(STATE)), false);
});

// ── review round 2: oldest call first across the fleet, and a newcomer queues behind a line in motion ──────────────────────────────────────

test('round 2 / fairness: a keeper draining a long line cannot starve an OLDER call on another keeper — the fleet\'s line is oldest-first (A1, B1, A2, A3 by arrival)', async () => {
  const f = fleet(2, { lease: true });
  f.setState(true);
  const order: string[] = [];
  const go = (g: number, name: string): Promise<void> => f.gates[g].admit('create', live()).then(() => void order.push(name));
  const ps = [go(0, 'A1')];
  await f.vt.run(() => false, 2);
  f.vt.now += 100; ps.push(go(1, 'B1'));
  await f.vt.run(() => false, 2);
  f.vt.now += 100; ps.push(go(0, 'A2'));
  await f.vt.run(() => false, 2);
  f.vt.now += 100; ps.push(go(0, 'A3'));
  await f.vt.run(() => false, 6);
  f.setState(false);
  await f.vt.run(() => order.length === 4, 400);
  await Promise.all(ps);
  assert.deepEqual(order, ['A1', 'B1', 'A2', 'A3']);
});

test('round 2 / fairness, the measured defect: an OLDER call on keeper B and six NEWER on keeper A, A polling first after the reopen — B goes first, not after A\'s six (without the ordering B waited behind all of them)', async () => {
  const run = async (line: boolean): Promise<string[]> => {
    const f = fleet(2, { lease: true, line });
    f.setState(true);
    const base = f.vt.now;
    const order: string[] = [];
    const ps: Array<Promise<void>> = [f.gates[1].admit('create', live()).then(() => void order.push('B'))];
    await f.vt.run(() => false, 1); // B's loop is polling (phase 0)
    f.vt.now = base + 400; // A's calls arrive LATER, and A polls 400 ms behind B
    for (let i = 0; i < 6; i++) ps.push(f.gates[0].admit('create', live()).then(() => void order.push(`A${i + 1}`)));
    await f.vt.run(() => f.vt.now >= base + 3000, 100); // the reopen lands right after B\'s 3.0 s poll: A\'s poll (3.4 s) comes BEFORE B\'s next (4.0 s)
    f.setState(false);
    await f.vt.run(() => order.length === 7, 800);
    await Promise.all(ps);
    return order;
  };
  assert.equal((await run(true))[0], 'B', 'oldest first: A saw the older call and stood aside');
  const without = await run(false);
  assert.equal(without[0], 'A1', `CONTROL (round 1 alone): A takes the slot first...`);
  assert.equal(without.indexOf('B'), 6, `...and keeps it until it has drained — B, the OLDEST, comes last: ${without.join(',')}`);
});

test('round 2 / newcomers: a NEW call on another keeper finds the fleet\'s line in motion and QUEUES behind it (Admission: a newcomer never jumps the line) — it does not pass at once', async () => {
  const f = fleet(2, { lease: true });
  f.setState(true);
  const done: string[] = [];
  const ps = [0, 1, 2].map((i) => f.gates[0].admit('create', live()).then(() => void done.push(`A${i}`)));
  await f.vt.run(() => false, 4);
  f.setState(false);
  await f.vt.run(() => done.length === 1, 100); // the line starts draining
  assert.equal(f.gates[1].holding(), true, 'an IDLE keeper (nothing of its own waiting) sees the fleet\'s line in motion: a START must go through the inspect + the gate, not around them');
  let newcomer: number | null = null;
  const nc = f.gates[1].admit('start', live()).then((r) => { newcomer = f.vt.now; return r; });
  await f.vt.run(() => false, 3);
  assert.equal(newcomer, null, 'the newcomer did not pass while the other keeper\'s line was draining');
  await f.vt.run(() => newcomer !== null, 400);
  await Promise.all([...ps, nc]);
  assert.deepEqual(done, ['A0', 'A1', 'A2']);
  assert.ok(newcomer !== null, 'released in its turn');
  // CONTROL: nothing in motion ⇒ a newcomer passes at once
  const g = fleet(2, { lease: true });
  g.setState(false);
  assert.deepEqual(await g.gates[1].admit('create', live()), { waitedMs: 0, reason: null });
  assert.equal(g.gates[1].holding(), false);
});

test('round 2 / a FLUSH (stale state, toggle OFF) never needs the slot: a live holder elsewhere, a stuck one even — the line leaves at once', async () => {
  const f = fleet(1, { lease: true });
  f.dir.put(admissionLeaseFile(STATE), JSON.stringify({ v: 1, owner: 'wsOther', pid: 999, ts: f.vt.now })); // a live keeper holds the slot
  f.setState(true);
  const p = f.gates[0].admit('create', live());
  await f.vt.run(() => false, 3);
  f.dir.put(STATE, JSON.stringify({ ...stateOf(false, f.vt.now), enabled: false })); // the operator turns the toggle OFF
  let done = false;
  void p.then(() => (done = true));
  const t0 = f.vt.now;
  await f.vt.run(() => done, 10);
  assert.equal(done, true, 'released without the slot');
  assert.ok(f.vt.now - t0 <= POLL, `at the next poll, not after the other keeper\'s settle / TTL: ${f.vt.now - t0} ms`);
});
