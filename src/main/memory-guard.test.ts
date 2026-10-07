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
  subscribeMemoryGuardSamples,
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

test('sampled: false until the first sample attempt (even an unreadable one), then true', () => {
  const w = world(null);
  const g = createMemoryGuard(w.deps);
  assert.equal(g.snapshot().sampled, false);
  g.start();
  assert.deepEqual([g.snapshot().sampled, g.snapshot().measured], [true, false]);
});

test('mayReleaseOneStart rides the snapshot: the LATEST decision, false while unreadable (even with a good old reading) and before the first sample', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  assert.equal(g.snapshot().mayReleaseOneStart, false, 'before the first sample');
  g.start();
  assert.equal(g.snapshot().mayReleaseOneStart, true, '12 GB: a held start may go out');
  w.mem = 6.5;
  w.fire();
  assert.equal(g.snapshot().mayReleaseOneStart, false, '6.5 GB is under 7');
  w.mem = 9;
  assert.equal(g.sampleNow().mayReleaseOneStart, true, 'sampleNow() carries it fresh');
  w.mem = null;
  w.fire();
  const s = g.snapshot();
  assert.equal(s.availBytes, gb(9), 'the last GOOD reading is still shown…');
  assert.equal(s.mayReleaseOneStart, false, '…but a dead meter releases nothing');
});

test('snapshot.pauseCycle numbers memory Pauses; the edges carry it', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  const seen: string[] = [];
  g.subscribe((e) => seen.push(`${e.transition.kind}/${e.transition.pauseCycle}`));
  g.start();
  for (const m of [2, 6.5, 2.5]) {
    w.mem = m;
    w.fire();
  }
  assert.deepEqual(seen, ['admission_held/0', 'pause_due/1', 'pause_liftable/1', 'pause_due/2']);
  assert.deepEqual([g.snapshot().episode, g.snapshot().pauseCycle], [1, 2]);
});

test('no_replay: a subscriber gets only the edges AFTER it subscribed; the snapshot is how it reconciles', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  g.start();
  w.mem = 2;
  w.fire(); // admission_held + pause_due happen BEFORE anyone subscribes
  const seen: string[] = [];
  g.subscribe((e) => seen.push(e.transition.kind));
  assert.deepEqual(seen, [], 'nothing is replayed on subscribe');
  assert.deepEqual([g.snapshot().admission, g.snapshot().pause], ['held', 'held'], 'the late subscriber reads the state from the snapshot');
  w.mem = 8;
  w.fire();
  assert.deepEqual(seen, ['pause_liftable', 'admission_reopened']);
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

test('onSample: one call per SAMPLE (timer tick, sampleNow, unreadable) with the post-sample state — not per edge; a throwing listener breaks nothing; unsubscribe stops it', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  const seen: Array<[string, boolean, number | null]> = [];
  g.onSample(() => {
    throw new Error('listener bug');
  });
  const off = g.onSample((s) => seen.push([s.admission, s.measured, s.availBytes === null ? null : s.availBytes / GIB]));
  g.start();
  w.mem = 4;
  w.fire(); // the edge sample
  w.fire(); // a steady sample while held: NO edge, still a sample
  g.sampleNow(); // an on-demand sample counts too
  w.mem = null;
  w.fire(); // unreadable: state unchanged, still a sample
  assert.deepEqual(seen, [['open', true, 12], ['held', true, 4], ['held', true, 4], ['held', true, 4], ['held', false, 4]]);
  assert.ok(w.warns.some((l) => /sample listener threw/.test(l)));
  off();
  w.mem = 12;
  w.fire();
  assert.equal(seen.length, 5, 'unsubscribed');
});

test('onSample: a sample\'s listeners run AFTER its own edges, and the OUTER sample reports the freshest state when an edge listener re-measured', () => {
  const w = world(12);
  const g = createMemoryGuard(w.deps);
  const order: string[] = [];
  g.subscribe((e) => {
    order.push(`edge:${e.transition.kind}`);
    if (e.transition.kind === 'admission_held') {
      w.mem = 9; // rebounds while the edge is delivered
      g.sampleNow();
    }
  });
  g.onSample((s) => order.push(`sample:${s.admission}`));
  g.start();
  order.length = 0;
  w.mem = 4;
  w.fire();
  // The nested sampleNow (inside the held edge's listener) reports itself at once; its own edge waits in the FIFO behind the batch being delivered; the
  // OUTER sample reports last and with the freshest state ('open'), never the stale 'held' it started from.
  assert.deepEqual(order, ['edge:admission_held', 'sample:open', 'edge:admission_reopened', 'sample:open']);
});

test('onSample: no replay on subscribe — a late subscriber reads the level from the snapshot, then hears only later samples', () => {
  const w = world(4);
  const g = createMemoryGuard(w.deps);
  g.start(); // already held before anyone subscribes
  const seen: string[] = [];
  g.onSample((s) => seen.push(s.admission));
  assert.deepEqual(seen, [], 'nothing replayed');
  assert.equal(g.snapshot().admission, 'held');
  w.fire();
  assert.deepEqual(seen, ['held']);
});

test('nested_sampleNow: a listener that re-measures gets its edges AFTER the batch being delivered — sample order, last edge = final state', () => {
  // A — a fall (held, pause_due) whose FIRST edge's listener re-measures after memory rebounded: the nested edges must queue BEHIND pause_due.
  {
    const w = world(12);
    const g = createMemoryGuard(w.deps);
    const seen: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    g.start();
    const off = g.subscribe((e) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        seen.push(e.transition.kind);
        if (e.transition.kind === 'admission_held') {
          w.mem = 8; // memory rebounds before the consumer finished reacting to the first edge
          g.sampleNow();
        }
      } finally {
        depth -= 1;
      }
    });
    w.mem = 2;
    w.fire(); // fall: admission_held + pause_due — the listener re-measures inside the first
    assert.deepEqual(seen, ['admission_held', 'pause_due', 'pause_liftable', 'admission_reopened'], 'FIFO: the nested sample\'s edges come after the outer batch');
    const s = g.snapshot();
    assert.deepEqual([s.admission, s.pause], ['open', 'none'], 'the LAST delivered edge (admission_reopened) matches the final state — a consumer acting on the last edge ends right');
    assert.equal(maxDepth, 1, 'a listener is NEVER re-entered: the nested sample\'s edges wait until the current listener returned');
    assert.ok(w.pending, 'exactly one timer armed after the nested sample');
    off();
  }
  // B — a recovery whose LAST edge's listener re-measures after memory collapsed again.
  {
    const w = world(12);
    const g = createMemoryGuard(w.deps);
    const seen: string[] = [];
    g.start();
    w.mem = 2;
    w.fire();
    g.subscribe((e) => {
      seen.push(e.transition.kind);
      if (e.transition.kind === 'admission_reopened') {
        w.mem = 2.5;
        g.sampleNow();
      }
    });
    w.mem = 8;
    w.fire();
    assert.deepEqual(seen, ['pause_liftable', 'admission_reopened', 'admission_held', 'pause_due']);
    const s = g.snapshot();
    assert.deepEqual([s.admission, s.pause], ['held', 'held']);
  }
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

test('settings_read_failure_keeps_thresholds: a getSettings() that THROWS keeps the thresholds in force (never the defaults)', () => {
  const w = world(8);
  w.settings = { admissionGb: 10, criticalGb: 4, admissionEnabled: true };
  let broken = false;
  const g = createMemoryGuard({ ...w.deps, getSettings: () => { if (broken) throw new Error('store unreadable'); return w.settings; } });
  g.start();
  assert.equal(g.snapshot().admissionBytes, gb(10));
  assert.equal(g.snapshot().admission, 'held', '8 GB is below the custom 10 GB');
  broken = true;
  w.mem = 9; // would be OPEN under the defaults (6/7), still HELD under the custom 10 GB
  w.fire();
  assert.equal(g.snapshot().admissionBytes, gb(10), 'the thresholds in force did not change');
  assert.equal(g.snapshot().admission, 'held');
});

test('unreachable_warning: ONE warning per (threshold, machine) when Admission could never reopen on this host; silent once fixed; again if it returns', () => {
  const w = world(12);
  const g = createMemoryGuard({ ...w.deps, totalBytes: () => gb(4) });
  g.start();
  for (let i = 0; i < 5; i++) w.fire();
  const warnings = () => w.warns.filter((l) => /exceed this machine's memory/.test(l));
  assert.equal(warnings().length, 1, 'six samples, one warning');
  assert.match(warnings()[0], /Admission 6 GB \+ 1 GB reopen margin >= MemTotal 4\.00 GB/);
  w.settings = { admissionGb: 2, criticalGb: 1, admissionEnabled: true };
  w.fire();
  assert.equal(warnings().length, 1, 'a reachable pair does not warn');
  w.settings = { admissionGb: 6, criticalGb: 3, admissionEnabled: true };
  w.fire();
  assert.equal(warnings().length, 2, 'the same problem coming back warns again');
  const quiet = world(12);
  createMemoryGuard({ ...quiet.deps, totalBytes: () => gb(32) }).start();
  assert.equal(quiet.warns.length, 0, 'a normal host never warns');
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

test('facade: subscribeMemoryGuardSamples hears every sample of the singleton, survives a rebuild, a throwing listener is ignored, unsubscribe stops it', () => {
  const w = world(12);
  const seen: string[] = [];
  subscribeMemoryGuardSamples(() => {
    throw new Error('listener bug');
  });
  const off = subscribeMemoryGuardSamples((s) => seen.push(`${s.admission}/${s.availBytes === null ? 'null' : s.availBytes / GIB}`));
  setMemoryGuardSettingsReader(() => w.settings);
  const rebuilt = { now: w.deps.now, schedule: w.deps.schedule, cancel: w.deps.cancel, info: w.deps.info, warn: w.deps.warn };
  const g = __rebuildMemoryGuardForTests(rebuilt, () => (w.mem === null ? null : gb(w.mem)));
  g.start();
  w.mem = 4;
  w.fire();
  w.fire();
  assert.equal(sampleMemoryGuardNow().admission, 'held');
  assert.deepEqual(seen, ['open/12', 'held/4', 'held/4', 'held/4'], 'tick, edge, steady tick, on-demand — one call each (the throwing subscriber broke none)');
  const g2 = __rebuildMemoryGuardForTests(rebuilt, () => (w.mem === null ? null : gb(w.mem)));
  g2.start();
  assert.equal(seen.length, 5, 'a rebuilt guard keeps the subscriber');
  off();
  w.fire();
  assert.equal(seen.length, 5, 'unsubscribed');
  g2.stop();
  __rebuildMemoryGuardForTests();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
});
