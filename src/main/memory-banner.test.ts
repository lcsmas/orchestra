import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { createMemoryGuard } from './memory-guard.ts';
import { createMemoryBannerPublisher, BANNER_REFRESH_MS, type MemoryBannerDeps, type MemoryBannerPublisher } from './memory-banner.ts';
import { memoryPausedRuns } from './pause-memory.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { DEFAULT_MEMORY_GUARD_SETTINGS, GIB, type MemoryGuardSettings } from '../shared/memory-guard.ts';
import { MEMORY_PAUSE_BY, encodeMemoryPause } from '../shared/pause-memory.ts';
import { bannerVisible, dismissedWith, type MemoryBannerState } from '../shared/memory-banner.ts';

// #289 (D5 D-pick3) — the banner's STATE half over a REAL bus (the paused runs are read from the memory-Pause motive rows) and the REAL guard (createMemoryGuard) on a fake MemAvailable source with a hand-fired scheduler.
// Named arms are what scripts/memory-banner/mutate-unit.mjs reddens.

const ROOT = path.join(os.homedir(), '.cache', `memory-banner-bus-${process.pid}`);
let n = 0;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

interface World {
  db: bus.BusDb;
  pushes: MemoryBannerState[];
  logs: string[];
  timers: Array<{ id: number; at: number; fn: () => void }>;
  clock: { now: number };
  settings: MemoryGuardSettings;
  mem: { gb: number | null };
  held: { n: number };
  g: ReturnType<typeof createMemoryGuard>;
  pub: MemoryBannerPublisher;
  at(gb: number | null): void;
  advance(ms: number): void;
  pauseRun(id: string, on: boolean): void;
}

function world(): World {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `b${n++}.sqlite`));
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, { ...DEFAULT_BUS_SWITCHES, pause: true });
  busRuns.startRun(db, { id: 'Q', kind: 'mission', coordinator: 'Q' }, { ...DEFAULT_BUS_SWITCHES, pause: true });
  const w = { db, pushes: [] as MemoryBannerState[], logs: [] as string[], timers: [] as World['timers'], clock: { now: 9_000_000 }, settings: { ...DEFAULT_MEMORY_GUARD_SETTINGS } as MemoryGuardSettings, mem: { gb: 12 as number | null }, held: { n: 0 } } as unknown as World;
  w.g = createMemoryGuard({ readAvailableBytes: () => (w.mem.gb === null ? null : w.mem.gb * GIB), getSettings: () => w.settings, now: () => w.clock.now, schedule: () => null, cancel: () => {}, info: () => {}, warn: () => {} });
  let tid = 0;
  const deps: MemoryBannerDeps = {
    snapshot: () => w.g.snapshot(),
    heldStarts: () => w.held.n,
    pausedRuns: () => memoryPausedRuns(db).map((r) => `run-${r.runId}`),
    push: (s) => void w.pushes.push(s),
    schedule: (fn, ms) => {
      const t = { id: ++tid, at: w.clock.now + ms, fn };
      w.timers.push(t);
      return t.id;
    },
    cancel: (h) => {
      w.timers = w.timers.filter((t) => t.id !== h);
    },
    log: { warn: (m) => void w.logs.push(m) },
  };
  w.pub = createMemoryBannerPublisher(deps);
  w.g.subscribe((e) => w.pub.onEdge(e));
  w.at = (gb) => {
    w.mem.gb = gb;
    w.clock.now += 10_000;
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
  w.pauseRun = (id, on) => {
    if (on) {
      const at = w.clock.now;
      db.prepare("UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_auto = ? WHERE id = ?").run(at, MEMORY_PAUSE_BY, encodeMemoryPause({ reason: 'memory', pauseCycle: 1, episode: 1, availBytes: 2 * GIB, thresholdBytes: 3 * GIB }, at), id);
    } else {
      db.prepare('UPDATE runs SET paused_at = NULL, paused_by = NULL, pause_mode = NULL, pause_auto = NULL WHERE id = ?').run(id);
    }
  };
  return w;
}

test('PUBLISH walk: open → HELD → memory Pause → (Pause let go, Admission still held) → open — a push per CHANGE, never per sample, each with a strictly increasing revision', () => {
  const w = world();
  w.at(12);
  assert.equal(w.pushes.length, 0, 'open memory: nothing to publish (the renderer starts from none)');
  w.at(5.5);
  assert.deepEqual(w.pushes.map((p) => p.kind), ['held']);
  w.at(5.4); // the reading moves WITHOUT a guard edge: the banner timer says the NEW figure
  w.advance(BANNER_REFRESH_MS + 1);
  assert.equal(w.pushes.length, 2);
  assert.equal(w.pushes[1].availBytes, 5.4 * GIB);
  w.at(5.4);
  w.advance(BANNER_REFRESH_MS + 1);
  assert.equal(w.pushes.length, 2, 'an identical sample publishes nothing');
  w.at(2.3); // critical: the guard holds the Pause; its runs are written by the memory Pause host on the same edge
  w.pauseRun('L', true);
  w.pub.refresh();
  const pause = w.pushes[w.pushes.length - 1];
  assert.equal(pause.kind, 'pause');
  assert.deepEqual(pause.pausedRuns, ['run-L'], 'the runs under the memory Pause, read from the bus');
  w.at(6.5); // Pause liftable (above Admission) but the run is still paused until its Reprise: the Pause IS still in effect
  assert.equal(w.pushes[w.pushes.length - 1].kind, 'pause');
  w.pauseRun('L', false); // the Reprise finished
  w.pub.refresh();
  assert.equal(w.pushes[w.pushes.length - 1].kind, 'held', 'Admission is still held');
  w.at(8);
  assert.equal(w.pushes[w.pushes.length - 1].kind, 'none', 'recovery: the banner is gone');
  const revs = w.pushes.map((p) => p.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.equal(new Set(revs).size, revs.length, 'strictly increasing');
  assert.equal(w.pub.current().kind, 'none');
});

test('PUBLISH counts: the held-start count and the paused runs move WITHOUT a guard edge — the banner timer re-reads them while it is up, and stops when the banner is gone', () => {
  const w = world();
  w.at(12);
  assert.equal(w.timers.length, 0, 'no banner ⇒ no timer');
  w.at(5.5);
  assert.equal(w.timers.length, 1, 'banner up ⇒ one refresh timer');
  w.held.n = 3;
  w.advance(BANNER_REFRESH_MS + 1);
  assert.equal(w.pub.current().heldStarts, 3);
  assert.equal(w.pushes[w.pushes.length - 1].heldStarts, 3, 'pushed');
  w.pauseRun('Q', true);
  w.advance(BANNER_REFRESH_MS + 1);
  assert.equal(w.pub.current().kind, 'pause', 'a run paused without any guard edge in between still flips the banner');
  assert.deepEqual(w.pub.current().pausedRuns, ['run-Q']);
  w.pauseRun('Q', false);
  w.at(8); // recovery
  assert.equal(w.pub.current().kind, 'none');
  assert.equal(w.timers.length, 0, 'banner gone ⇒ the timer is disarmed');
  w.advance(10 * 60_000);
  assert.equal(w.pushes[w.pushes.length - 1].kind, 'none');
});

test('PUBLISH unknown ≠ held: a guard that never held and cannot read publishes no banner; the toggle OFF holds nothing', () => {
  const w = world();
  w.at(null);
  assert.equal(w.pushes.length, 0);
  w.settings = { ...DEFAULT_MEMORY_GUARD_SETTINGS, admissionEnabled: false };
  w.at(12);
  w.at(5);
  assert.equal(w.pub.current().kind, 'none', 'below the threshold with the toggle OFF: nothing is held, nothing to announce');
  assert.equal(w.pushes.length, 0);
});

test('PUBLISH an unreadable sample never blanks a banner the guard still holds: no `none` push (the renderer would forget the dismissals), the figure turns unreadable and comes back with the next good read', () => {
  const w = world();
  w.at(12);
  w.at(5.5);
  assert.equal(w.pub.current().kind, 'held');
  const before = w.pushes.length;
  w.at(null); // one unreadable sample: the guard keeps its state
  w.pub.refresh();
  assert.equal(w.pub.current().kind, 'held', 'still held: an unreadable meter is not an open one');
  assert.equal(w.pub.current().availBytes, null, 'the figure says unreadable, not the last good reading');
  assert.ok(w.pushes.slice(before).every((p) => p.kind !== 'none'), `no none push in between: ${w.pushes.slice(before).map((p) => p.kind).join(',')}`);
  w.at(5.3); // no edge (still held): the tick brings the figure back
  w.advance(BANNER_REFRESH_MS + 1);
  assert.equal(w.pub.current().kind, 'held');
  assert.equal(w.pub.current().availBytes, 5.3 * GIB, 'back on the next good read');
  assert.ok(w.pushes.every((p) => p.kind !== 'none'), 'never a none push while the guard holds');
});

test('PUBLISH tick outlives the banner while the GUARD holds: a banner that went none while the Admission toggle was OFF comes back with the toggle, with no guard edge to announce it; the refresh period is a light one', () => {
  assert.ok(BANNER_REFRESH_MS >= 1_000 && BANNER_REFRESH_MS <= 10_000, `${BANNER_REFRESH_MS} ms: counts / paused runs move without a guard edge and an episode is minutes long`);
  const w = world();
  w.at(12);
  w.at(5.5);
  assert.equal(w.pub.current().kind, 'held');
  // the Admission toggle OFF while held: nothing is held (no banner); ON again: the banner returns without an edge
  w.settings = { ...DEFAULT_MEMORY_GUARD_SETTINGS, admissionEnabled: false };
  w.at(5.3);
  w.pub.refresh();
  assert.equal(w.pub.current().kind, 'none');
  assert.equal(w.timers.length, 1, 'tick still armed');
  w.settings = { ...DEFAULT_MEMORY_GUARD_SETTINGS };
  w.at(5.3);
  w.advance(BANNER_REFRESH_MS + 1);
  assert.equal(w.pub.current().kind, 'held', 'toggle back ON');
  // a recovery (guard open, banner none) disarms it
  w.at(8);
  assert.equal(w.pub.current().kind, 'none');
  assert.equal(w.timers.length, 0, 'guard open ⇒ no tick');
});

test('PUBLISH the episode ends while a Pause stands (Reprise held): the banner stays RED with `episodeOver` set — a push the renderer reads as a new, undismissed banner (ruling #289 b)', () => {
  const w = world();
  w.at(12);
  w.at(2.3); // critical: the guard holds the Pause
  w.pauseRun('L', true);
  w.pub.refresh();
  const live = w.pub.current();
  assert.deepEqual([live.kind, live.episodeOver, live.pausedRuns], ['pause', false, ['run-L']]);
  const hidden = dismissedWith([], live); // the human hid it during the episode
  assert.equal(bannerVisible(live, hidden), false);
  w.at(8); // memory recovers above the reopen margin: Admission reopened — but the run is STILL paused (its Reprise is held; nothing lifts it here)
  const over = w.pub.current();
  assert.deepEqual([over.kind, over.episodeOver, over.pausedRuns], ['pause', true, ['run-L']], 'still the memory Pause, and now its episode is over');
  assert.equal(over.episode, live.episode, 'same guard episode number: only the phase differs');
  assert.ok(w.pushes.some((p) => p.kind === 'pause' && p.episodeOver === true), 'the change was PUSHED');
  assert.equal(bannerVisible(over, hidden), true, 'the dismissal of the live episode no longer applies: this Pause now needs attention');
  w.pauseRun('L', false); // the human lifts it
  w.pub.refresh();
  assert.equal(w.pub.current().kind, 'none');
});

test('PUBLISH Pause red means RUNS paused: the guard below critical with no run under the memory Pause stays amber', () => {
  const w = world();
  w.at(12);
  w.at(2.3); // critical, but no run is written under the memory Pause (every pause switch OFF / no fleet / a manual pause holds them)
  assert.equal(w.pub.current().kind, 'held');
  w.pauseRun('L', true);
  w.pub.refresh();
  assert.equal(w.pub.current().kind, 'pause');
  assert.deepEqual(w.pub.current().pausedRuns, ['run-L']);
});

test('PUBLISH pull: `current()` is what a renderer\'s first pull gets; refresh() is also a fresh read; stop() cancels the timer; a throwing dep is logged, never thrown', () => {
  const w = world();
  w.at(12);
  w.at(5); // the guard is already held when a SECOND publisher starts (a reload / a late subscriber)
  const late = createMemoryBannerPublisher({ snapshot: () => w.g.snapshot(), heldStarts: () => 2, pausedRuns: () => [], push: () => {}, schedule: (fn, ms) => { const t = { id: 99, at: w.clock.now + ms, fn }; w.timers.push(t); return t.id; }, cancel: (h) => { w.timers = w.timers.filter((t) => t.id !== h); }, log: { warn: () => {} } });
  assert.equal(late.current().kind, 'none', 'nothing computed yet');
  late.refresh();
  assert.equal(late.current().kind, 'held');
  assert.equal(late.current().heldStarts, 2);
  const armed = w.timers.length;
  late.stop();
  assert.equal(w.timers.length, armed - 1, 'stop cancels the timer');
  const boom = createMemoryBannerPublisher({ snapshot: () => { throw new Error('guard gone'); }, heldStarts: () => 0, pausedRuns: () => [], push: () => {}, schedule: () => 1, cancel: () => {}, log: { warn: (m) => void w.logs.push(m) } });
  assert.doesNotThrow(() => boom.refresh());
  assert.ok(w.logs.some((m) => /memory-banner: refresh failed/.test(m)));
});

// ── verifier seat 2 (G6 final gate, c/6047274773) F2 / C05: the publisher's FAILURE path is pinned — a refresh that throws is logged AND re-armed, so the banner recovers on the next tick ──

function flakyPublisher(w: World, opts: { failHeld: { on: boolean }; failSnapshot: { on: boolean } }) {
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const pushes: MemoryBannerState[] = [];
  const logs: string[] = [];
  let tid = 0;
  const pub = createMemoryBannerPublisher({
    snapshot: () => {
      if (opts.failSnapshot.on) throw new Error('guard gone');
      return w.g.snapshot();
    },
    heldStarts: () => {
      if (opts.failHeld.on) throw new Error('queue gone');
      return 0;
    },
    pausedRuns: () => [],
    push: (s) => void pushes.push(s),
    schedule: (fn, ms) => {
      const t = { id: ++tid, at: w.clock.now + ms, fn };
      timers.push(t);
      return t.id;
    },
    cancel: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    log: { warn: (m) => void logs.push(m) },
  });
  const fire = (): void => {
    const t = timers.shift();
    if (t) {
      w.clock.now = Math.max(w.clock.now, t.at);
      t.fn();
    }
  };
  return { pub, timers, pushes, logs, fire };
}

test('PUBLISH failure path (C05): a refresh that throws while the guard HOLDS is logged and RE-ARMED — the next tick publishes the banner; without the re-arm a transient throw would leave it blank until the next guard edge', () => {
  const w = world();
  w.at(12);
  w.at(5); // Admission HELD
  const failHeld = { on: true };
  const f = flakyPublisher(w, { failHeld, failSnapshot: { on: false } });
  f.pub.refresh();
  assert.ok(f.logs.some((m) => /memory-banner: refresh failed/.test(m)));
  assert.equal(f.pushes.length, 0, 'nothing could be computed');
  assert.equal(f.timers.length, 1, 'the guard holds, so the tick is re-armed after the failure');
  failHeld.on = false;
  f.fire();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].kind, 'held');
});

test('PUBLISH failure path (C05): the SNAPSHOT itself throwing while a banner is up re-arms too (the banner is not forgotten, the tick retries); with no banner and no snapshot nothing is armed', () => {
  const w = world();
  w.at(12);
  w.at(5);
  const failSnapshot = { on: false };
  const f = flakyPublisher(w, { failHeld: { on: false }, failSnapshot });
  f.pub.refresh();
  assert.equal(f.pub.current().kind, 'held');
  assert.equal(f.timers.length, 1, 'control: the held banner keeps its tick armed');
  failSnapshot.on = true;
  f.fire(); // the tick runs, the snapshot throws → the failure path
  assert.ok(f.logs.some((m) => /memory-banner: refresh failed/.test(m)));
  assert.equal(f.timers.length, 1, 'a banner is up: the tick is RE-ARMED after the failed read');
  assert.equal(f.pub.current().kind, 'held', 'the banner is not blanked by a failed read');
  const none = flakyPublisher(w, { failHeld: { on: false }, failSnapshot: { on: true } });
  none.pub.refresh();
  assert.equal(none.timers.length, 0, 'no banner and no snapshot: nothing to keep alive');
});
