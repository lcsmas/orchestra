import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  __rebuildMemoryGuardForTests,
  createMemoryGuard,
  getMemoryGuardSnapshot,
  realMemoryGuardDeps,
  sampleMemoryGuardNow,
  setMemoryGuardSettingsReader,
  subscribeMemoryGuard,
  type MemoryGuardDeps,
  type MemoryGuardTransitionEvent,
} from './memory-guard.ts';
import {
  DEFAULT_MEMORY_GUARD_SETTINGS,
  GIB,
  SAMPLE_FAST_MS,
  SAMPLE_SLOW_MS,
  isAdmissionHolding,
  type MemoryGuardSettings,
} from '../shared/memory-guard.ts';

const gb = (n: number) => n * GIB;

/** A rig world: the memory the fake source reports, a hand-fired scheduler that RECORDS every delay it is asked for,
 *  a clock, a settings cell and the log lines the sampler wrote. Nothing here decides anything — the sampler under test does. */
function world(initialGb: number | null = 12) {
  const w = {
    mem: initialGb as number | null,
    reads: 0,
    now: 1_000_000,
    settings: { ...DEFAULT_MEMORY_GUARD_SETTINGS } as MemoryGuardSettings,
    delays: [] as number[],
    pending: null as null | { fn: () => void; ms: number },
    cancels: 0,
    infos: [] as string[],
    warns: [] as string[],
    deps: null as unknown as MemoryGuardDeps,
    fire() {
      const p = w.pending;
      assert.ok(p, 'a timer is armed');
      w.pending = null;
      w.now += p.ms;
      p.fn();
    },
  };
  w.deps = {
    readAvailableBytes: () => {
      w.reads += 1;
      return w.mem === null ? null : gb(w.mem);
    },
    getSettings: () => w.settings,
    now: () => w.now,
    schedule: (fn, ms) => {
      w.delays.push(ms);
      w.pending = { fn, ms };
      return w.pending;
    },
    cancel: (h) => {
      w.cancels += 1;
      if (w.pending === h) w.pending = null;
    },
    info: (m) => w.infos.push(m),
    warn: (m) => w.warns.push(m),
  };
  return w;
}

// ─── cadence, asserted on the REAL sampler (the AC): 10 s below the Admission threshold, 60 s above ─────────────────
test('cadence_injected: the sampler re-arms at 60 s above 6 GB, 10 s below, 60 s again after recovery', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  assert.deepEqual(w.delays, [SAMPLE_SLOW_MS], '12 GB → slow');
  w.mem = 5.5;
  w.fire();
  w.fire();
  assert.deepEqual(w.delays, [SAMPLE_SLOW_MS, SAMPLE_FAST_MS, SAMPLE_FAST_MS], '5.5 GB → fast, and stays fast');
  assert.equal(g.snapshot().sampleIntervalMs, SAMPLE_FAST_MS);
  w.mem = 6; // exactly AT the threshold is not below it
  w.fire();
  assert.equal(w.delays[w.delays.length - 1], SAMPLE_SLOW_MS);
  w.mem = 9;
  w.fire();
  assert.equal(w.delays[w.delays.length - 1], SAMPLE_SLOW_MS);
  assert.equal(g.snapshot().sampleIntervalMs, SAMPLE_SLOW_MS);
});

test('cadence_default_scheduler: with NO scheduler injected, real setTimeout fires at 60 s above and 10 s below', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let mem = gb(12);
    let reads = 0;
    const g = createMemoryGuard(
      realMemoryGuardDeps({ readAvailableBytes: () => (reads++, mem), getSettings: () => DEFAULT_MEMORY_GUARD_SETTINGS, info: () => {}, warn: () => {} }),
    );
    g.start();
    assert.equal(reads, 1, 'start takes the first sample at once');
    mock.timers.tick(SAMPLE_SLOW_MS - 1);
    assert.equal(reads, 1, 'nothing before 60 s while memory is plentiful');
    mock.timers.tick(1);
    assert.equal(reads, 2, 'the 60 s tick sampled');
    mem = gb(4);
    mock.timers.tick(SAMPLE_SLOW_MS);
    assert.equal(reads, 3, 'that tick saw 4 GB');
    mock.timers.tick(SAMPLE_FAST_MS - 1);
    assert.equal(reads, 3, 'below the threshold: not before 10 s');
    mock.timers.tick(1);
    assert.equal(reads, 4, '10 s later it sampled again (fast cadence)');
    for (let i = 0; i < 3; i++) mock.timers.tick(SAMPLE_FAST_MS); // one step at a time: a single big tick does not fire timers armed inside it
    assert.equal(reads, 7, 'and keeps sampling every 10 s');
    g.stop();
    mock.timers.tick(SAMPLE_SLOW_MS * 2);
    assert.equal(reads, 7, 'stop() ends the sampling');
  } finally {
    mock.timers.reset();
  }
});

// ─── every transition is logged WITH the memory at that moment ──────────────────────────────────────────────────────
test('logging: held / pause due / liftable / reopened each logged with MemAvailable and the threshold', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  for (const m of [5.5, 2.4, 6.3, 7.4]) {
    w.mem = m;
    w.fire();
  }
  const all = [...w.warns, ...w.infos].filter((l) => !/started/.test(l));
  assert.equal(all.length, 4, `exactly four transition lines, got: ${all.join(' | ')}`);
  assert.match(w.warns[0], /admission HELD \(episode 1\) — MemAvailable 5\.50 GB < 6\.00 GB/);
  assert.match(w.warns[1], /memory Pause DUE \(episode 1\) — MemAvailable 2\.40 GB < critical 3\.00 GB/);
  assert.match(w.infos.find((l) => /LIFTABLE/.test(l)) ?? '', /memory Pause LIFTABLE \(episode 1\) — MemAvailable 6\.30 GB > 6\.00 GB/);
  assert.match(w.infos.find((l) => /REOPENED/.test(l)) ?? '', /admission REOPENED \(episode 1 over\) — MemAvailable 7\.40 GB > 7\.00 GB/);
});

test('logging: steady samples log nothing (only edges are lines)', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  const before = w.infos.length + w.warns.length;
  for (let i = 0; i < 10; i++) w.fire();
  assert.equal(w.infos.length + w.warns.length, before);
});

// ─── the state a consumer / bus-status reads ────────────────────────────────────────────────────────────────────────
test('snapshot: open → held → critical → open carries state, episode, since-times and the last MemAvailable', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  let s = g.snapshot();
  assert.equal(s.measured, true);
  assert.equal(s.admission, 'open');
  assert.equal(s.availBytes, gb(12));
  w.mem = 5;
  w.fire();
  s = g.snapshot();
  assert.deepEqual([s.admission, s.pause, s.episode, s.heldSince, s.pauseSince], ['held', 'none', 1, w.now, null]);
  const heldAt = w.now;
  w.mem = 2;
  w.fire();
  s = g.snapshot();
  assert.deepEqual([s.admission, s.pause, s.heldSince, s.pauseSince], ['held', 'held', heldAt, w.now]);
  w.mem = 8;
  w.fire();
  s = g.snapshot();
  assert.deepEqual([s.admission, s.pause, s.heldSince, s.pauseSince, s.episode], ['open', 'none', null, null, 1]);
  assert.equal(s.availBytes, gb(8));
  assert.equal(s.admissionBytes, gb(6));
  assert.equal(s.criticalBytes, gb(3));
});

test('sampleNow: a fresh reading + decision at once (the re-measure between two releases), without waiting for the timer', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  w.mem = 5;
  const readsBefore = w.reads;
  const s = g.sampleNow();
  assert.equal(w.reads, readsBefore + 1);
  assert.equal(s.admission, 'held');
  assert.ok(w.pending, 'the timer was re-armed (one pending, not two)');
  w.mem = 8;
  assert.equal(g.sampleNow().admission, 'open');
});

test('sampleNow before start: evaluates but arms no timer', () => {
  const w = world(4);
  const g = createMemoryGuard(w.deps);
  assert.equal(g.sampleNow().admission, 'held');
  assert.equal(w.pending, null);
  assert.deepEqual(w.delays, []);
});

// ─── subscription ───────────────────────────────────────────────────────────────────────────────────────────────────
test('subscribe: one event per edge with the post-sample snapshot; a throwing listener breaks nothing; unsubscribe stops it', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  const seen: MemoryGuardTransitionEvent[] = [];
  g.subscribe(() => {
    throw new Error('listener bug');
  });
  const off = g.subscribe((e) => seen.push(e));
  g.start();
  w.mem = 2; // jumps both thresholds in one sample
  w.fire();
  assert.deepEqual(seen.map((e) => e.transition.kind), ['admission_held', 'pause_due']);
  assert.equal(seen[0].snapshot.pause, 'held', 'every edge of one sample sees the state AFTER the sample');
  assert.ok(w.warns.some((l) => /listener threw/.test(l)));
  off();
  w.mem = 9;
  w.fire();
  assert.equal(seen.length, 2, 'unsubscribed');
});

// ─── thresholds apply HOT ───────────────────────────────────────────────────────────────────────────────────────────
test('hot_thresholds: raising Admission to 10 GB holds at 8 GB on the NEXT sample, no restart; sampleNow applies it at once', () => {
  const w = world(8);
  const g = createMemoryGuard(w.deps);
  g.start();
  assert.equal(g.snapshot().admission, 'open');
  w.settings = { ...w.settings, admissionGb: 10, criticalGb: 4 };
  assert.equal(g.snapshot().admission, 'open', 'nothing changes until a sample reads the new settings');
  w.fire();
  assert.equal(g.snapshot().admission, 'held');
  assert.equal(g.snapshot().admissionBytes, gb(10));
  assert.equal(g.snapshot().sampleIntervalMs, SAMPLE_FAST_MS, '8 GB is now below the Admission threshold → fast');
  w.mem = 6.5;
  w.settings = { ...w.settings, admissionGb: 6, criticalGb: 3 };
  assert.equal(g.sampleNow().admission, 'held', '6.5 GB is in the hysteresis band of the restored 6 GB: still held');
  w.mem = 7.5;
  assert.equal(g.sampleNow().admission, 'open');
});

test('hot_thresholds: an invalid stored pair never reaches the decision — the defaults apply', () => {
  const w = world(5);
  w.settings = { admissionGb: 2, criticalGb: 5, admissionEnabled: true };
  const g = createMemoryGuard(w.deps);
  g.start();
  assert.equal(g.snapshot().admissionBytes, gb(6));
  assert.equal(g.snapshot().admission, 'held');
});

test('toggle: OFF still measures + decides + logs, but isAdmissionHolding is false; ON again holds', () => {
  const w = world(5);
  w.settings = { ...w.settings, admissionEnabled: false };
  const g = createMemoryGuard(w.deps);
  g.start();
  const s = g.snapshot();
  assert.equal(s.admission, 'held');
  assert.equal(s.admissionEnabled, false);
  assert.equal(isAdmissionHolding(s), false);
  assert.match(w.warns[0], /toggle OFF/);
  w.settings = { ...w.settings, admissionEnabled: true };
  assert.equal(isAdmissionHolding(g.sampleNow()), true);
});

// ─── unreadable memory ──────────────────────────────────────────────────────────────────────────────────────────────
test('unreadable: state unchanged, ONE warning for the whole outage, fast retry, one info on recovery', () => {
  const w = world(5);
  const g = createMemoryGuard(w.deps);
  g.start();
  assert.equal(g.snapshot().admission, 'held');
  w.mem = null;
  for (let i = 0; i < 5; i++) w.fire();
  const s = g.snapshot();
  assert.equal(s.measured, false);
  assert.equal(s.admission, 'held', 'unknown does not reopen Admission');
  assert.equal(s.availBytes, gb(5), 'the last GOOD reading is kept');
  assert.equal(w.warns.filter((l) => /UNREADABLE/.test(l)).length, 1);
  assert.equal(w.delays[w.delays.length - 1], SAMPLE_FAST_MS);
  w.mem = 8;
  w.fire();
  assert.equal(g.snapshot().measured, true);
  assert.equal(w.infos.filter((l) => /readable again/.test(l)).length, 1);
});

test('unreadable: a source that THROWS is the same as null', () => {
  const w = world(12);
  const g = createMemoryGuard({ ...w.deps, readAvailableBytes: () => { throw new Error('EIO'); } });
  g.start();
  assert.equal(g.snapshot().measured, false);
  assert.ok(w.pending, 'still sampling');
});

test('unreadable at boot: never a fabricated figure', () => {
  const w = world(null);
  const g = createMemoryGuard(w.deps);
  g.start();
  const s = g.snapshot();
  assert.deepEqual([s.measured, s.availBytes, s.readAt, s.admission], [false, null, null, 'open']);
});

// ─── lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('lifecycle: start twice arms ONE timer; stop cancels it; a stopped guard samples on demand but never re-arms', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  g.start();
  assert.equal(w.delays.length, 1);
  g.stop();
  assert.equal(w.pending, null);
  g.sampleNow();
  assert.equal(w.pending, null);
});

// ─── the process-wide facade downstream tracks import ───────────────────────────────────────────────────────────────
test('facade: the singleton reads the injected source + the settings reader, and subscribers survive a rebuild', () => {
  const w = world(12);
  const seen: string[] = [];
  const off = subscribeMemoryGuard((e) => seen.push(e.transition.kind));
  setMemoryGuardSettingsReader(() => w.settings);
  const g = __rebuildMemoryGuardForTests({ now: w.deps.now, schedule: w.deps.schedule, cancel: w.deps.cancel, info: w.deps.info, warn: w.deps.warn }, () => (w.mem === null ? null : gb(w.mem)));
  g.start();
  assert.equal(getMemoryGuardSnapshot().admission, 'open');
  w.mem = 4;
  w.fire();
  assert.equal(getMemoryGuardSnapshot().admission, 'held');
  assert.deepEqual(seen, ['admission_held']);
  w.mem = 8;
  assert.equal(sampleMemoryGuardNow().admission, 'open');
  assert.deepEqual(seen, ['admission_held', 'admission_reopened']);
  off();
  g.stop();
  __rebuildMemoryGuardForTests();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
});
