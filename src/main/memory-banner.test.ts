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
import type { MemoryBannerState } from '../shared/memory-banner.ts';

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

test('PUBLISH unknown ≠ held: an unreadable meter publishes no banner; the toggle OFF holds nothing', () => {
  const w = world();
  w.at(null);
  assert.equal(w.pushes.length, 0);
  w.settings = { ...DEFAULT_MEMORY_GUARD_SETTINGS, admissionEnabled: false };
  w.at(12);
  w.at(5);
  assert.equal(w.pub.current().kind, 'none', 'below the threshold with the toggle OFF: nothing is held, nothing to announce');
  assert.equal(w.pushes.length, 0);
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
