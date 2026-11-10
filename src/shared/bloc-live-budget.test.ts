// #419 — the live-frame budget's pure parts: the height memory that keeps a placeholder the size of its frame, and the watchdog that fails a frame on
// missing PROGRESS (not elapsed time since mount — #415 review M3: a loaded renderer with many simultaneous mounts must not turn a healthy bloc into code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOC_INITIAL_HEIGHT_PX, BLOC_KEEP_MARGIN_PX, BLOC_MOUNT_MARGIN_PX, BLOC_NO_LOAD_MS, BLOC_NO_REPORT_AFTER_LOAD_MS,
  blocHeightCacheSize, blocBoxKey, blocHeightKey, blocSurfaceKey, BLOC_PIN_MAX_EXTRA_ROWS, createBlocWatchdog, recallBlocHeight, rememberBlocExpanded, rememberBlocHeight, wasBlocExpanded, widenWindowForPins,
} from './bloc-live-budget.ts';

/** A manual clock: timers fire only when the test advances time, in due order. */
function clock() {
  let now = 0; let id = 0; const timers = new Map<number, { at: number; f: () => void }>();
  return {
    setTimer: (f: () => void, ms: number) => { const i = ++id; timers.set(i, { at: now + ms, f }); return i; },
    clearTimer: (i: number) => { timers.delete(i); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].f();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
const dog = (c: ReturnType<typeof clock>) => { const log: string[] = []; return { log, w: createBlocWatchdog<number>({ fail: () => log.push('fail'), setTimer: c.setTimer, clearTimer: c.clearTimer }) }; };

test('hysteresis: a bloc unmounts strictly farther than it mounts (a frame at the boundary must not reload on every wheel tick)', () => {
  assert.ok(BLOC_KEEP_MARGIN_PX > BLOC_MOUNT_MARGIN_PX && BLOC_MOUNT_MARGIN_PX > 0);
});

test('height memory: a never-seen bloc reads the initial height, a remembered one its last report, per source', () => {
  assert.equal(recallBlocHeight(blocHeightKey('<p>never seen</p>')), BLOC_INITIAL_HEIGHT_PX);
  rememberBlocHeight(blocHeightKey('<p>a</p>'), 312);
  rememberBlocHeight(blocHeightKey('<p>b</p>'), 40);
  assert.equal(recallBlocHeight(blocHeightKey('<p>a</p>')), 312);
  assert.equal(recallBlocHeight(blocHeightKey('<p>b</p>')), 40);
  rememberBlocHeight(blocHeightKey('<p>a</p>'), 330); // a later report replaces
  assert.equal(recallBlocHeight(blocHeightKey('<p>a</p>')), 330);
});

test('height memory is bounded (oldest out): a very long session never grows it without limit', () => {
  for (let i = 0; i < 5000; i++) rememberBlocHeight(blocHeightKey(`<p>bloc ${i}</p>`), i);
  assert.ok(blocHeightCacheSize() <= 2000, `size ${blocHeightCacheSize()}`);
  assert.equal(recallBlocHeight(blocHeightKey('<p>bloc 4999</p>')), 4999, 'the newest survives');
  assert.equal(recallBlocHeight(blocHeightKey('<p>bloc 0</p>')), BLOC_INITIAL_HEIGHT_PX, 'the oldest is gone');
});

test('M3: a LOADED RENDERER slow to start many frames — load far later than the old 6 s — is NOT a failure', () => {
  const c = clock(); const { log, w } = dog(c);
  w.start();
  c.advance(20_000); // 20 s of a starved renderer: the old 6 s-from-mount timer would have failed this healthy bloc 14 s ago
  assert.deepEqual(log, []);
  w.loaded(); c.advance(300); w.reported(); c.advance(60_000);
  assert.deepEqual(log, [], 'healthy: slow load, prompt report');
});

test('a frame that loaded but never reports fails BLOC_NO_REPORT_AFTER_LOAD_MS after the load (not before)', () => {
  const c = clock(); const { log, w } = dog(c);
  w.start(); c.advance(9_000); w.loaded();
  c.advance(BLOC_NO_REPORT_AFTER_LOAD_MS - 1); assert.deepEqual(log, []);
  c.advance(1); assert.deepEqual(log, ['fail']);
});

test('a frame that never loads fails at BLOC_NO_LOAD_MS (a script hogging the frame process, a dead process) — once', () => {
  const c = clock(); const { log, w } = dog(c);
  w.start(); c.advance(BLOC_NO_LOAD_MS - 1); assert.deepEqual(log, []);
  c.advance(1); assert.deepEqual(log, ['fail']);
  c.advance(120_000); assert.deepEqual(log, ['fail'], 'fires once');
});

test('a report that arrives BEFORE the load event settles the frame for good (the late load arms nothing)', () => {
  const c = clock(); const { log, w } = dog(c);
  w.start(); w.reported(); w.loaded(); c.advance(120_000);
  assert.deepEqual(log, []); assert.equal(c.pending(), 0);
});

test('stop (unmount) cancels the verdict; a failed frame is not revived by a late event', () => {
  const c = clock(); const a = dog(c); a.w.start(); a.w.stop(); c.advance(120_000);
  assert.deepEqual(a.log, []);
  const b = dog(c); b.w.start(); c.advance(BLOC_NO_LOAD_MS); b.w.loaded(); b.w.start(); c.advance(120_000);
  assert.deepEqual(b.log, ['fail'], 'once failed, stays failed until the slot remounts a fresh watchdog');
});

test('50 simultaneous mounts on a starved renderer: only the frames that never progress fail', () => {
  const c = clock(); const dogs = Array.from({ length: 50 }, () => dog(c));
  for (const d of dogs) d.w.start();
  c.advance(12_000); // the renderer was blocked: nobody has loaded
  dogs.forEach((d, i) => { d.w.loaded(); if (i % 10 !== 0) d.w.reported(); }); // 5 frames' scripts never report
  c.advance(BLOC_NO_REPORT_AFTER_LOAD_MS);
  assert.deepEqual(dogs.map((d) => d.log.length), dogs.map((_, i) => (i % 10 === 0 ? 1 : 0)));
});

import { BLOC_LIVE_MAX, BLOC_LIVE_STICKY_PX, chooseLiveBlocs, type LiveCandidate } from './bloc-live-budget.ts';
const cand = (id: string, dist: number, live = false): LiveCandidate => ({ id, dist, live });

test('live ceiling: of 50 blocs within the margin only the LIVE_MAX nearest are live', () => {
  const all = Array.from({ length: 50 }, (_, i) => cand(`b${String(i).padStart(2, '0')}`, i * 40));
  const chosen = chooseLiveBlocs(all, BLOC_LIVE_MAX);
  assert.equal(chosen.size, BLOC_LIVE_MAX);
  for (let i = 0; i < BLOC_LIVE_MAX; i++) assert.ok(chosen.has(`b${String(i).padStart(2, '0')}`), `b${i} is among the nearest`);
  assert.ok(!chosen.has('b49'));
});

test('live ceiling: fewer blocs than the ceiling are all live; a ceiling of 0 mounts nothing', () => {
  assert.equal(chooseLiveBlocs([cand('a', 10), cand('b', 9000)], BLOC_LIVE_MAX).size, 2);
  assert.equal(chooseLiveBlocs([cand('a', 10)], 0).size, 0);
});

test('stickiness: a live frame within STICKY px of a challenger keeps its place; a clearly nearer challenger takes it', () => {
  const near = chooseLiveBlocs([cand('live', 500, true), cand('new', 500 - BLOC_LIVE_STICKY_PX + 50)], 1);
  assert.deepEqual([...near], ['live'], 'a challenger only slightly nearer does not evict');
  const far = chooseLiveBlocs([cand('live', 500, true), cand('new', 500 - BLOC_LIVE_STICKY_PX - 50)], 1);
  assert.deepEqual([...far], ['new'], 'a challenger clearly nearer does');
});

test('the choice is deterministic on ties (id order), so two recomputes never flip-flop', () => {
  const a = chooseLiveBlocs([cand('b', 100), cand('a', 100), cand('c', 100)], 2);
  assert.deepEqual([...a].sort(), ['a', 'b']);
});

test('height key: equal-length blocs sharing their first and last 64 chars but differing in the middle do NOT share a placeholder height', () => {
  const head = '<div style="height:400px">'.padEnd(80, ' '), tail = '</div>'.padStart(80, ' ');
  const a = `${head}${'a'.repeat(5000)}${tail}`, b = `${head}${'a'.repeat(2500)}b${'a'.repeat(2499)}${tail}`;
  assert.equal(a.length, b.length);
  assert.notEqual(blocHeightKey(a), blocHeightKey(b));
  rememberBlocHeight(blocHeightKey(a), 700); rememberBlocHeight(blocHeightKey(b), 90);
  assert.equal(recallBlocHeight(blocHeightKey(a)), 700); assert.equal(recallBlocHeight(blocHeightKey(b)), 90);
});

test('pinned rows: the window widens to cover a pinned row that scrolled out of it, and ignores a pin whose row is gone', () => {
  assert.deepEqual(widenWindowForPins(40, 60, [], 100), [40, 60]);
  assert.deepEqual(widenWindowForPins(40, 60, [45], 100), [40, 60], 'already inside: unchanged');
  assert.deepEqual(widenWindowForPins(40, 60, [12], 100), [12, 60], 'an enlarged bloc 28 rows up stays rendered');
  assert.deepEqual(widenWindowForPins(40, 60, [75], 100), [40, 76]);
  assert.deepEqual(widenWindowForPins(40, 60, [12, 75], 100), [12, 76]);
  assert.deepEqual(widenWindowForPins(40, 60, [150, -1], 100), [40, 60], 'a pin whose row left the list is ignored');
});

test('a non-modal pin (open source view) far from the window is ignored: the cost of a pinned row is bounded', () => {
  assert.deepEqual(widenWindowForPins(400, 420, [400 - BLOC_PIN_MAX_EXTRA_ROWS], 900), [400 - BLOC_PIN_MAX_EXTRA_ROWS, 420], 'at the cap: honoured');
  assert.deepEqual(widenWindowForPins(400, 420, [400 - BLOC_PIN_MAX_EXTRA_ROWS - 1], 900), [400, 420], 'one row beyond: ignored');
  assert.deepEqual(widenWindowForPins(400, 420, [420 + BLOC_PIN_MAX_EXTRA_ROWS - 1], 900), [400, 420 + BLOC_PIN_MAX_EXTRA_ROWS], 'below the window, at the cap');
  assert.deepEqual(widenWindowForPins(400, 420, [420 + BLOC_PIN_MAX_EXTRA_ROWS], 900), [400, 420], 'below, one beyond: ignored');
});

test('box + expanded memory: the placeholder key is distinct from the frame-height keys, and an expanded bloc is remembered until collapsed', () => {
  const src = '<div style="height:900px">tall</div>';
  assert.notEqual(blocBoxKey(src), `inline:${blocHeightKey(src)}`);
  rememberBlocHeight(blocBoxKey(src), 420);
  assert.equal(recallBlocHeight(blocBoxKey(src)), 420);
  assert.equal(wasBlocExpanded(blocBoxKey(src)), false);
  rememberBlocExpanded(blocBoxKey(src), true);
  assert.equal(wasBlocExpanded(blocBoxKey(src)), true);
  rememberBlocExpanded(blocBoxKey(src), false);
  assert.equal(wasBlocExpanded(blocBoxKey(src)), false);
});

test('inline and enlarged surfaces of one bloc keep SEPARATE height entries (blocSurfaceKey depends on the mode; the overlay has its own width)', () => {
  const src = '<div style="height:300px">surface</div>';
  assert.notEqual(blocSurfaceKey('inline', src), blocSurfaceKey('enlarged', src));
  assert.notEqual(blocSurfaceKey('inline', src), blocBoxKey(src), 'and neither is the placeholder box entry');
  rememberBlocHeight(blocSurfaceKey('inline', src), 300);
  rememberBlocHeight(blocSurfaceKey('enlarged', src), 640);
  assert.equal(recallBlocHeight(blocSurfaceKey('inline', src)), 300);
  assert.equal(recallBlocHeight(blocSurfaceKey('enlarged', src)), 640);
});
