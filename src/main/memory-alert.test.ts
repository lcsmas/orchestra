import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { createMemoryAlert, alertRecipients, type MemoryAlertDeps, type MemoryAlert } from './memory-alert.ts';
import { createMemoryGuard } from './memory-guard.ts';
import { setLiveTreeSource } from './pause-reprise.ts';
import type { AutoWorkspace } from './pause-auto.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import { DEFAULT_MEMORY_GUARD_SETTINGS, GIB, type MemoryGuardSettings } from '../shared/memory-guard.ts';
import { ALERT_SENDER, ALERT_SETTLE_MS } from '../shared/memory-alert.ts';
import { MEMORY_PAUSE_BY, encodeMemoryPause } from '../shared/pause-memory.ts';

// #289 (wave G, ledger #295 FI-2) — ONE escalation row per memory episode to the LEAD, over a REAL bus.sqlite under the real home (btrfs — never /tmp, never the live bus), the REAL guard (createMemoryGuard) over a fake
// MemAvailable source and a hand-fired scheduler. Named arms are what scripts/memory-alert/mutate-unit.mjs reddens.

const ROOT = path.join(os.homedir(), '.cache', `memory-alert-bus-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, pause: true };
const NO_DELIVERY: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
let n = 0;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

interface World {
  db: bus.BusDb;
  ws: Map<string, AutoWorkspace & { host?: { kind: string } }>;
  clock: { now: number };
  logs: string[];
  facts: { heldStarts: number; veille: number; unattributed: number };
  timers: Array<{ id: number; at: number; fn: () => void }>;
  alert: MemoryAlert;
  deps: MemoryAlertDeps;
  mem: { gb: number | null };
  settings: MemoryGuardSettings;
  g: ReturnType<typeof createMemoryGuard>;
  /** One guard sample at `gb` GB, 20 s after the last (the edges reach the alert exactly as the host wires them). */
  at(gb: number | null): void;
  /** Advance the clock; due timers fire in order. */
  advance(ms: number): void;
  rows(): Array<{ run_id: string; sender: string; recipient: string; body: string }>;
  busOverride: { db: bus.BusDb | null; fail: number };
}

/** L (mission, delivery ON, coordinator L) ⊃ O (vague) ⊃ w1 ; L ⊃ X ⊃ x1 ; R (an unrelated root, delivery OFF) ⊃ r1 ; Q (a second root, delivery ON) ⊃ q1. Workspace id == run id for orchestrators. */
function world(sw: { R?: BusSwitches; late?: boolean } = {}): World {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `b${n++}.sqlite`));
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'X', parentRunId: 'L' }, ON);
  busRuns.startRun(db, { id: 'R', kind: 'mission', coordinator: 'R' }, sw.R ?? NO_DELIVERY);
  const ws = new Map<string, AutoWorkspace & { host?: { kind: string } }>([
    ['L', { id: 'L', kind: 'orchestrator' }],
    ['O', { id: 'O', parentId: 'L', canOrchestrate: true }],
    ['X', { id: 'X', parentId: 'L', canOrchestrate: true }],
    ['w1', { id: 'w1', parentId: 'O' }],
    ['x1', { id: 'x1', parentId: 'X' }],
    ['R', { id: 'R', kind: 'orchestrator' }],
    ['r1', { id: 'r1', parentId: 'R' }],
  ]);
  const liveTree = { get: (id: string) => ws.get(id), ids: () => [...ws.values()].map((w) => w.id) };
  setLiveTreeSource(() => liveTree);
  const w = { clock: { now: 1_800_000_000_000 }, logs: [] as string[], facts: { heldStarts: 0, veille: 0, unattributed: 0 }, timers: [] as World['timers'], mem: { gb: 12 as number | null }, settings: { ...DEFAULT_MEMORY_GUARD_SETTINGS } as MemoryGuardSettings, busOverride: { db: null as bus.BusDb | null, fail: 0 } } as unknown as World;
  w.db = db;
  w.ws = ws;
  let tid = 0;
  w.g = createMemoryGuard({
    readAvailableBytes: () => (w.mem.gb === null ? null : w.mem.gb * GIB),
    getSettings: () => w.settings,
    now: () => w.clock.now,
    schedule: () => null,
    cancel: () => {},
    info: () => {},
    warn: () => {},
  });
  w.deps = {
    getBus: () => {
      setLiveTreeSource(() => liveTree);
      if (w.busOverride.fail > 0) {
        w.busOverride.fail -= 1;
        return null;
      }
      return w.busOverride.db ?? db;
    },
    getWorkspace: (id) => ws.get(id),
    listWorkspaces: () => [...ws.values()],
    storeReady: () => true,
    now: () => w.clock.now,
    log: { info: (m) => void w.logs.push(m), warn: (m) => void w.logs.push(`WARN ${m}`) },
    snapshot: () => w.g.snapshot(),
    heldStarts: () => w.facts.heldStarts,
    veilleSince: () => w.facts.veille,
    unattributedContainers: () => w.facts.unattributed,
    schedule: (fn, ms) => {
      const t = { id: ++tid, at: w.clock.now + ms, fn };
      w.timers.push(t);
      return t.id;
    },
    cancel: (h) => {
      w.timers = w.timers.filter((t) => t.id !== h);
    },
  };
  w.alert = createMemoryAlert(w.deps);
  if (!sw.late) w.g.subscribe((e) => w.alert.onEdge(e)); // `late`: the alert starts AFTER the guard (a boot)
  w.at = (gb) => {
    w.mem.gb = gb;
    w.clock.now += 20_000;
    w.g.sampleNow();
  };
  w.advance = (ms) => {
    const end = w.clock.now + ms;
    for (;;) {
      const due = w.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      w.timers = w.timers.filter((t) => t !== due);
      w.clock.now = Math.max(w.clock.now, due.at);
      due.fn();
    }
    w.clock.now = end;
  };
  w.rows = () => db.prepare("SELECT run_id, sender, recipient, body FROM messages WHERE kind = 'escalation' ORDER BY sequence").all() as ReturnType<World['rows']>;
  return w;
}

// ─── one alert per EPISODE ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('EPISODE oscillation: samples bouncing inside one Admission episode (below the reopen margin) write EXACTLY ONE escalation; a NEW crossing after recovery writes a second', () => {
  const w = world();
  w.at(12);
  w.at(5.5); // Admission HELD: episode 1 opens
  for (const gb of [6.5, 5.9, 6.9, 5.2, 6.8, 5.7]) w.at(gb); // hysteresis: no reopen below 7 GB — the SAME episode
  assert.equal(w.g.snapshot().episode, 1);
  assert.equal(w.rows().length, 0, 'the settle window has not elapsed: nothing written yet');
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1, 'ONE row for the whole oscillating episode');
  w.advance(10 * 60_000);
  assert.equal(w.rows().length, 1, 'and no later row for the same episode');
  w.at(8); // recovery: Admission reopens, episode 1 is over
  w.at(5.4); // a NEW downward crossing: episode 2
  assert.equal(w.g.snapshot().episode, 2);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 2, 'a new crossing after recovery produces a second escalation');
  assert.match(w.rows()[0].body, /episode 1 /);
  assert.match(w.rows()[1].body, /episode 2 /);
});

test('EPISODE row: it is an `escalation` from the host to the LEAD of the ROOT run, naming the threshold crossed, the available memory and the actions taken (starts held, Veille, runs paused, unattributed containers)', () => {
  const w = world();
  w.facts = { heldStarts: 3, veille: 5, unattributed: 2 };
  w.at(12);
  w.at(5.42);
  w.at(5.1); // memory moves between the crossing and the write: the row says both (the crossing, and now)
  // a run is under the memory Pause at the moment the row is written
  const pausedAt = w.clock.now;
  w.db.prepare("UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_auto = ? WHERE id = 'L'").run(pausedAt, MEMORY_PAUSE_BY, encodeMemoryPause({ reason: 'memory', pauseCycle: 1, episode: 1, availBytes: 2 * GIB, thresholdBytes: 3 * GIB }, pausedAt));
  w.advance(ALERT_SETTLE_MS + 1);
  const rows = w.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].run_id, rows[0].sender, rows[0].recipient], ['L', ALERT_SENDER, 'L']);
  const b = rows[0].body;
  assert.match(b, /Memory guard — episode 1 \(since 20[0-9-]+T[0-9:.]+Z\)/);
  assert.match(b, /below the Admission threshold \(6\.00 GB\) at 5\.42 GB/, 'the threshold crossed and MemAvailable at the crossing');
  assert.doesNotMatch(b, /and below the CRITICAL threshold/, 'critical was not crossed');
  assert.match(b, /If MemAvailable falls below the CRITICAL threshold \(3\.00 GB\) the host puts the eligible runs under the memory Pause WITHOUT another row for this episode/, 'one row per episode: the row says what a later critical crossing will NOT do');
  assert.match(b, /3 automatic fleet start\(s\) HELD/, 'starts held');
  assert.match(b, /5 member\(s\) put in Veille/, 'Veille');
  assert.match(b, /memory Pause on run\(s\) L/, 'runs paused');
  assert.match(b, /2 unattributed container\(s\) \(not measured yet — #293\)/, 'the unattributed-container field is there from the start (the dep feeds it)');
  assert.match(b, /Now \(20[0-9-]+T[0-9:.]+Z\): MemAvailable 5\.10 GB · Admission HELD · memory Pause none/, 'the facts are dated: a paused LEAD reads the row after its Reprise');
  assert.match(b, /released coordinators first, one at a time/);
});

test('EPISODE critical: a jump straight below the CRITICAL threshold names BOTH thresholds in the ONE row; a critical crossing AFTER the row was written does not write another', () => {
  const w = world();
  w.at(12);
  w.at(1.2); // one sample: admission_held AND pause_due
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1);
  assert.match(w.rows()[0].body, /below the Admission threshold \(6\.00 GB\) at 1\.20 GB and below the CRITICAL threshold \(3\.00 GB\) at 1\.20 GB/);
  const first = world();
  first.at(12);
  first.at(5);
  first.at(2.5); // pause_due #1
  first.at(6.5); // pause_liftable (Admission still held)
  first.at(2.0); // pause_due #2 — same episode
  first.advance(ALERT_SETTLE_MS + 1);
  assert.match(first.rows()[0].body, /and below the CRITICAL threshold \(3\.00 GB\) at 2\.50 GB/, 'the FIRST critical crossing is the one named');
  const v = world();
  v.at(12);
  v.at(5);
  v.advance(ALERT_SETTLE_MS + 1);
  assert.equal(v.rows().length, 1);
  v.at(2.4); // pause_due, same episode, AFTER the alert
  v.at(8);
  v.at(2.4 + 0); // (still the same sample stream)
  v.advance(60_000);
  assert.equal(v.rows().filter((r) => /episode 1 /.test(r.body)).length, 1, 'ONE row per episode — a later memory-Pause cycle inside it is not a new alert');
});

test('EPISODE end before settle: an episode that is over before its settle window is told when it ends — once, saying it is already over', () => {
  const w = world();
  w.at(12);
  w.at(5.5);
  w.at(8); // admission_reopened 20 s later: the settle window (20 s) has not been reached by the timer
  assert.equal(w.rows().length, 1, 'told at the end');
  assert.match(w.rows()[0].body, /already OVER \(memory back above 7\.00 GB at 20[0-9-]+T/);
  w.advance(5 * 60_000);
  assert.equal(w.rows().length, 1, 'the settle timer does not write it again');
});

test('EPISODE unknown ≠ held: an unreadable meter opens no episode and writes nothing', () => {
  const w = world();
  w.at(null);
  w.at(null);
  w.advance(5 * 60_000);
  assert.deepEqual(w.alert.episodes(), []);
  assert.equal(w.rows().length, 0);
  w.at(5.5); // readable and held: now an episode
  assert.equal(w.alert.episodes().length, 1);
});

test('EPISODE toggle OFF: with the Admission toggle OFF the guard still measures and decides — the row says nothing is actually held', () => {
  const w = world();
  w.settings = { ...DEFAULT_MEMORY_GUARD_SETTINGS, admissionEnabled: false };
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1);
  assert.match(w.rows()[0].body, /automatic starts NOT held \(the Admission toggle is OFF/);
  assert.doesNotMatch(w.rows()[0].body, /start\(s\) HELD/);
});

// ─── who is the LEAD ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LEAD rule: the coordinator of every ROOT run carrying a live local fleet whose frozen `delivery` switch is ON — one row each; non-root coordinators, delivery-OFF runs, runs without a live fleet and a gone coordinator are not told', () => {
  const w = world();
  busRuns.startRun(w.db, { id: 'Q', kind: 'mission', coordinator: 'Q' }, ON);
  w.ws.set('Q', { id: 'Q', kind: 'orchestrator' });
  w.ws.set('q1', { id: 'q1', parentId: 'Q' });
  busRuns.startRun(w.db, { id: 'E', kind: 'mission', coordinator: 'E' }, ON); // a root with NO workspace below it
  w.ws.set('E', { id: 'E', kind: 'orchestrator' });
  assert.deepEqual(alertRecipients(w.db, w.deps), [{ runId: 'L', coordinator: 'L' }, { runId: 'Q', coordinator: 'Q' }], 'R (delivery OFF), E (no fleet), O and X (not roots) are not told');
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.deepEqual(w.rows().map((r) => [r.run_id, r.recipient]), [['L', 'L'], ['Q', 'Q']], 'ONE row per LEAD');
  const gone = world();
  gone.ws.get('L')!.archived = true;
  gone.ws.get('O')!.archived = true;
  gone.ws.get('X')!.archived = true;
  assert.deepEqual(alertRecipients(gone.db, gone.deps), [], 'an archived coordinator reads nothing');
});

test('LEAD rule: a coordinator that is gone is not told even when the run\'s anchor workspace is live (coordinator ≠ anchor)', () => {
  const w = world();
  busRuns.startRun(w.db, { id: 'Z', kind: 'mission', coordinator: 'zc' }, ON);
  w.ws.set('Z', { id: 'Z', kind: 'orchestrator' });
  w.ws.set('z1', { id: 'z1', parentId: 'Z' });
  assert.ok(!alertRecipients(w.db, w.deps).some((r) => r.runId === 'Z'), 'zc is not a workspace: nobody to read the row');
  w.ws.set('zc', { id: 'zc', archived: true });
  assert.ok(!alertRecipients(w.db, w.deps).some((r) => r.runId === 'Z'), 'zc is archived');
  w.ws.set('zc', { id: 'zc' });
  assert.ok(alertRecipients(w.db, w.deps).some((r) => r.runId === 'Z' && r.coordinator === 'zc'), 'control: a live coordinator is told');
});

test('LEAD rule: readers are filtered BEFORE the topmost — a root that cannot read (delivery OFF / coordinator gone) does not silence the delivery-ON run below it; two readers on one chain tell only the topmost', () => {
  const w = world();
  w.db.prepare("UPDATE run_flags SET flags = ? WHERE run_id = 'L'").run(JSON.stringify({ delivery: false, pause: true }));
  assert.deepEqual(alertRecipients(w.db, w.deps), [{ runId: 'O', coordinator: 'O' }, { runId: 'X', coordinator: 'X' }], 'L cannot read: O and X (delivery ON, each with a fleet) are the LEADs the memory Pause actually pauses');
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.deepEqual(w.rows().map((r) => [r.run_id, r.recipient]), [['O', 'O'], ['X', 'X']], 'ONE row each, none for the reader-less root');
  const gone = world();
  gone.ws.get('L')!.archived = true;
  assert.deepEqual(alertRecipients(gone.db, gone.deps).map((r) => r.runId), ['O', 'X'], 'control: a root whose workspace is gone is no root of a live fleet: its children are the LEADs');
  const two = world();
  assert.deepEqual(alertRecipients(two.db, two.deps).map((r) => r.runId), ['L'], 'control: both L and O/X can read — only the topmost is told');
});

test('LEAD rule: nobody to tell is not an error — the episode is marked told, the log says so, no row is written', () => {
  const w = world();
  for (const id of ['O', 'X', 'w1', 'x1']) w.ws.get(id)!.archived = true; // no live workspace below L: no fleet, nobody to tell
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 0);
  assert.ok(w.logs.some((m) => /told to NOBODY/.test(m)), w.logs.join(' | '));
  assert.deepEqual(w.alert.episodes().map((e) => e.sent), [true]);
});

// ─── boot / retries ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('RECONCILE (FI-2.5): a boot while Admission is ALREADY held tells the episode once; a repeated reconcile or the edges of the same episode never duplicate it; a boot with Admission open tells nothing', () => {
  const pre = world({ late: true });
  pre.at(12);
  pre.at(5); // the guard is already held when the alert starts
  const fresh = createMemoryAlert(pre.deps);
  pre.g.subscribe((e) => fresh.onEdge(e));
  fresh.reconcile(pre.g.snapshot());
  fresh.reconcile(pre.g.snapshot());
  pre.advance(ALERT_SETTLE_MS + 1);
  assert.equal(pre.rows().length, 1);
  assert.match(pre.rows()[0].body, /episode 1 /);
  pre.at(4.5);
  pre.advance(60_000);
  assert.equal(pre.rows().length, 1);
  const open = world();
  open.at(12);
  open.alert.reconcile(open.g.snapshot());
  open.advance(5 * 60_000);
  assert.equal(open.rows().length, 0, 'open memory: nothing to tell');
  const unmeasured = world();
  unmeasured.alert.reconcile(unmeasured.g.snapshot()); // never sampled
  assert.deepEqual(unmeasured.alert.episodes(), []);
});

test('RECONCILE unknown ≠ held: a snapshot whose meter is UNREADABLE (it keeps the last good reading) opens no episode', () => {
  const w = world({ late: true });
  w.at(12);
  w.at(5);
  w.at(null); // the meter dies: the guard keeps its last good state (held, 5 GB) but measured is false
  assert.equal(w.g.snapshot().measured, false);
  const fresh = createMemoryAlert(w.deps);
  fresh.reconcile(w.g.snapshot());
  w.advance(5 * 60_000);
  assert.deepEqual(fresh.episodes(), []);
  assert.equal(w.rows().length, 0);
});

test('RETRY: a store that is not loaded yet at the settle time is waited for — nothing is written against an unknown workspace tree', () => {
  const w = world();
  let ready = false;
  w.deps.storeReady = () => ready;
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 0);
  ready = true;
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1);
});

test('RECONCILE then the SAME episode\'s edge (the guard\'s FIFO drain delivers an edge AFTER the snapshot already shows it): one episode, the critical crossing the reconcile saw is kept', () => {
  const w = world({ late: true });
  w.at(12);
  w.at(2);
  const snap = w.g.snapshot();
  const fresh = createMemoryAlert(w.deps);
  fresh.reconcile(snap);
  fresh.onEdge({ transition: { kind: 'admission_held', episode: snap.episode, pauseCycle: snap.pauseCycle, availBytes: 2 * GIB, thresholdBytes: 6 * GIB }, snapshot: snap }); // the queued edge of the very episode the snapshot already shows
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1, 'ONE episode: the late edge does not reopen it');
  assert.match(w.rows()[0].body, /and below the CRITICAL threshold \(3\.00 GB\)/, 'and the critical crossing the reconcile recorded is not lost');
});

test('EDGE failure: a handler that throws is logged, never propagated into the guard\'s drain (the next sample still runs)', () => {
  const w = world();
  w.deps.schedule = () => {
    throw new Error('timer gone');
  };
  w.at(12);
  w.at(5); // admission_held → open → arm → throws, swallowed
  assert.ok(w.logs.some((m) => /WARN memory-alert: handling admission_held failed/.test(m)), w.logs.join(' | '));
  w.at(8); // the guard keeps sampling
  assert.equal(w.g.snapshot().admission, 'open');
});

test('RECONCILE: a boot while the memory Pause is already in effect names the CRITICAL threshold too', () => {
  const w = world({ late: true });
  w.at(12);
  w.at(2);
  const fresh = createMemoryAlert(w.deps);
  fresh.reconcile(w.g.snapshot());
  w.advance(ALERT_SETTLE_MS + 1);
  const bodies = w.rows().map((r) => r.body);
  assert.ok(bodies.some((b) => /and below the CRITICAL threshold \(3\.00 GB\)/.test(b)));
});

test('RETRY: an unavailable bus at the settle time re-arms the timer (bounded) and the row is written ONCE when it is back; a throw half-way never writes the episode twice', () => {
  const w = world();
  w.busOverride.fail = 2;
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 0, 'bus not ready');
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 0);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1, 'back: written');
  w.advance(10 * 60_000);
  assert.equal(w.rows().length, 1);
  // a send that throws after the first recipient: the episode is already marked told — the next edge does not write it again
  const v = world();
  busRuns.startRun(v.db, { id: 'Q', kind: 'mission', coordinator: 'Q' }, ON);
  v.ws.set('Q', { id: 'Q', kind: 'orchestrator' });
  v.ws.set('q1', { id: 'q1', parentId: 'Q' });
  let inserts = 0;
  v.busOverride.db = new Proxy(v.db, {
    get(t, k) {
      const val = Reflect.get(t, k) as unknown;
      if (k === 'prepare') {
        return (sql: string) => {
          if (/INSERT INTO messages/.test(sql) && ++inserts === 2) throw new Error('disk full');
          return (val as (s: string) => unknown).call(t, sql);
        };
      }
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(t) : val;
    },
  }) as unknown as bus.BusDb;
  v.at(12);
  v.at(5);
  v.advance(ALERT_SETTLE_MS + 1);
  assert.equal(v.rows().length, 1, 'the first LEAD was told; the second send threw');
  assert.ok(v.logs.some((m) => /WARN memory-alert: episode 1 NOT written to Q \(run Q\)/.test(m)), v.logs.join(' | '));
  v.at(4.8);
  v.at(8); // the episode ends: its reopen edge would write the episode again if it were not already marked told
  v.advance(10 * 60_000);
  assert.equal(v.rows().length, 1, 'never written again for the same episode');
});

test('RETRY: a failure BEFORE anything was written (facts / recipients unreadable) is retried on the bounded timer — the episode is not told only when it ends', () => {
  const w = world();
  let calls = 0;
  const heldStarts = w.deps.heldStarts;
  w.deps.heldStarts = () => {
    if (++calls <= 2) throw new Error('SQLITE_BUSY');
    return heldStarts();
  };
  w.at(12);
  w.at(5);
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 0, 'the first attempt threw before any write');
  assert.ok(w.logs.some((m) => /WARN memory-alert: preparing the escalation of episode 1 failed — retried/.test(m)), w.logs.join(' | '));
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 0, 'the second attempt threw too');
  w.advance(ALERT_SETTLE_MS + 1);
  assert.equal(w.rows().length, 1, 'the third attempt wrote the row — while the episode is still going on');
  assert.equal(w.alert.episodes()[0].ended, false);
  w.advance(10 * 60_000);
  assert.equal(w.rows().length, 1, 'once');
  // the bound: a permanent failure stops retrying (no timer left behind)
  const p = world();
  p.deps.heldStarts = () => {
    throw new Error('permanent');
  };
  p.at(12);
  p.at(5);
  for (let i = 0; i < 12; i++) p.advance(ALERT_SETTLE_MS + 1);
  assert.equal(p.rows().length, 0);
  assert.equal(p.timers.length, 0, 'bounded: no re-arm after MAX_TRIES');
});

test('STOP: a stopped alert fires no timer and writes nothing', () => {
  const w = world();
  w.at(12);
  w.at(5);
  w.alert.stop();
  w.advance(5 * 60_000);
  assert.equal(w.rows().length, 0);
});
