// #406 phase 2 — every branch of the hidden-drive policy (src/shared/browser-hidden-drive.ts): which action each tab state needs, the throttling
// lease book (flip once, linger, watchdog — P7), the remembered "is the window displayed" evidence, and clip geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenCaptureRefusal, DEVICE_METRICS_MESSAGE, BEYOND_VIEWPORT_MESSAGE,
  clipBeyondViewport,
  LINGER_MS, LeaseBook, NEEDS_FIRST_PAINT_MESSAGE, NO_FRAME_MESSAGE, WATCHDOG_MS, cropRect, decideTabAction,
} from './browser-hidden-drive.ts';
import type { TabFacts } from './browser-hidden-drive.ts';

const T = (o: Partial<TabFacts>): TabFacts => ({ surface: 'hidden', composited: true, hasCover: true, ...o });

test('a tab on screen needs nothing (no flip, no surface)', () => {
  assert.deepEqual(decideTabAction({ tab: T({ surface: 'visible' }), kind: 'capture' }), { act: 'direct' });
  assert.deepEqual(decideTabAction({ tab: T({ surface: 'visible' }), kind: 'input' }), { act: 'direct' });
});

test('a hidden tab whose document was composited is driven in place under a lease — screenshot, click, type and evaluate alike', () => {
  for (const kind of ['capture', 'input', 'other'] as const) assert.deepEqual(decideTabAction({ tab: T({}), kind }), { act: 'lease' });
});

test('a tab with no first frame (never attached, or navigated while hidden) is SURFACED under the cover; without a cover it is refused, fast and clearly', () => {
  for (const surface of ['detached', 'hidden'] as const) {
    assert.deepEqual(decideTabAction({ tab: T({ surface, composited: false }), kind: 'capture' }), { act: 'surface-then-lease' });
    assert.deepEqual(decideTabAction({ tab: T({ surface, composited: false }), kind: 'input' }), { act: 'surface-then-lease' });
    const r = decideTabAction({ tab: T({ surface, composited: false, hasCover: false }), kind: 'capture' });
    assert.deepEqual(r, { act: 'refuse', reason: 'needs-first-paint', message: NEEDS_FIRST_PAINT_MESSAGE });
  }
  assert.match(NEEDS_FIRST_PAINT_MESSAGE, /snapshot, eval, get and open still work/);
});

test('evaluate / navigate / get on a tab with no first frame need no pulse: they work on any state (lease only)', () => {
  assert.deepEqual(decideTabAction({ tab: T({ surface: 'detached', composited: false, hasCover: false }), kind: 'other' }), { act: 'lease' });
});

test('a view that detached after being shown is surfaced like a never-attached one (a2: removeChildView gives no frames)', () => {
  assert.deepEqual(decideTabAction({ tab: T({ surface: 'detached', composited: true }), kind: 'capture' }), { act: 'surface-then-lease' });
});

test('no tab, no action; and the no-frame message names BOTH causes (a never-composited document, an undisplayed desktop workspace) without claiming either', () => {
  assert.equal(decideTabAction({ tab: null, kind: 'input' }).act, 'refuse');
  assert.match(NO_FRAME_MESSAGE, /loaded while it was hidden/);
  assert.match(NO_FRAME_MESSAGE, /desktop workspace that is not displayed/);
  assert.match(NO_FRAME_MESSAGE, /click and type still work/);
});

test('lease book: the FIRST holder flips throttling off, later holders do not; the flip-back waits for the LAST holder plus the linger', () => {
  const b = new LeaseBook();
  assert.deepEqual(b.acquire('a', 0), { flip: true });
  assert.deepEqual(b.acquire('a', 10), { flip: false });
  b.release('a', 20);
  assert.deepEqual(b.due(WATCHDOG_MS - 100), { unflip: [], orphaned: [] }, 'one holder is still in');
  b.release('a', 30);
  assert.deepEqual(b.due(30 + LINGER_MS - 1), { unflip: [], orphaned: [] }, 'inside the linger');
  assert.deepEqual(b.due(30 + LINGER_MS), { unflip: ['a'], orphaned: [] });
  assert.equal(b.isHeld('a'), false);
  assert.deepEqual(b.acquire('a', 5000), { flip: true }, 'after the flip-back a new action flips again');
});

test('lease book: an action inside the linger CANCELS the flip-back (no flip, no flap)', () => {
  const b = new LeaseBook();
  b.acquire('a', 0);
  b.release('a', 10);
  assert.deepEqual(b.acquire('a', 10 + LINGER_MS - 5), { flip: false });
  assert.deepEqual(b.due(10 + LINGER_MS + 50), { unflip: [], orphaned: [] }, 'in use again');
  b.release('a', 700);
  assert.deepEqual(b.due(700 + LINGER_MS), { unflip: ['a'], orphaned: [] });
});

test('P7 watchdog: a lease nobody released or touched for WATCHDOG_MS is orphaned and forced back — linger + 5 s at most', () => {
  const b = new LeaseBook();
  b.acquire('dead', 0); // its action died: end() never called
  assert.deepEqual(b.due(WATCHDOG_MS - 1), { unflip: [], orphaned: [] });
  assert.deepEqual(b.due(WATCHDOG_MS), { unflip: ['dead'], orphaned: ['dead'] });
  assert.equal(b.isHeld('dead'), false);
  const live = new LeaseBook();
  live.acquire('slow', 0);
  live.touch('slow', 4000); // a command still running keeps its lease
  assert.deepEqual(live.due(WATCHDOG_MS + 100), { unflip: [], orphaned: [] });
  assert.deepEqual(live.due(4000 + WATCHDOG_MS), { unflip: ['slow'], orphaned: ['slow'] });
});

test('lease book: release without a lease / more releases than holders are harmless; forget drops a gone tab; nextWakeAt is the earliest deadline', () => {
  const b = new LeaseBook();
  b.release('x', 0);
  b.acquire('x', 0);
  b.release('x', 1);
  b.release('x', 2);
  assert.equal(b.nextWakeAt(), 1 + LINGER_MS);
  b.acquire('y', 100);
  assert.equal(b.nextWakeAt(), 1 + LINGER_MS, 'x flips back before y is called orphaned');
  b.forget('x');
  assert.equal(b.nextWakeAt(), 100 + WATCHDOG_MS);
  b.forget('y');
  assert.equal(b.nextWakeAt(), null);
  assert.equal(b.size(), 0);
});

test('cropRect: a CDP clip is clamped into the frame and scaled by the device pixel ratio; no clip = the whole frame', () => {
  assert.equal(cropRect(undefined, 800, 600), null);
  assert.equal(cropRect({ x: 0, y: 0, width: 0, height: 10 }, 800, 600), null);
  assert.deepEqual(cropRect({ x: 10, y: 20, width: 100, height: 50 }, 800, 600), { x: 10, y: 20, width: 100, height: 50 });
  assert.deepEqual(cropRect({ x: 10, y: 20, width: 100, height: 50 }, 1600, 1200, 2), { x: 20, y: 40, width: 200, height: 100 });
  assert.deepEqual(cropRect({ x: 700, y: 500, width: 500, height: 500 }, 800, 600), { x: 700, y: 500, width: 100, height: 100 }, 'clamped to the frame');
  assert.deepEqual(cropRect({ x: -50, y: -50, width: 100, height: 100 }, 800, 600), { x: 0, y: 0, width: 100, height: 100 });
});

test('clipBeyondViewport: only a captureBeyondViewport request whose clip exceeds the viewport is unsupported on a hidden view', () => {
  const clip = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  assert.equal(clipBeyondViewport({ captureBeyondViewport: true, clip: clip(0, 0, 800, 600) }, 800, 600), false, 'exactly the viewport');
  assert.equal(clipBeyondViewport({ captureBeyondViewport: true, clip: clip(0, 0, 800, 3000) }, 800, 600), true, 'a full-page height');
  assert.equal(clipBeyondViewport({ captureBeyondViewport: true, clip: clip(700, 0, 200, 100) }, 800, 600), true, 'overflowing to the right');
  assert.equal(clipBeyondViewport({ clip: clip(0, 0, 800, 3000) }, 800, 600), false, 'without captureBeyondViewport the clip is clamped to the viewport by CDP itself');
  assert.equal(clipBeyondViewport({ captureBeyondViewport: true }, 800, 600), false, 'no clip: the viewport');
  assert.equal(clipBeyondViewport({ captureBeyondViewport: true, clip: clip(0, 0, 800.5, 600.5) }, 800, 600), false, 'sub-pixel rounding is not "beyond"');
});

test('hiddenCaptureRefusal: a hidden view cannot honour a full-page clip, a scaled clip or an active Emulation.setDeviceMetricsOverride — and refuses nothing else', () => {
  const vp = (clip?: { x: number; y: number; width: number; height: number; scale?: number }, extra: object = {}) => ({ clip, ...extra });
  assert.equal(hiddenCaptureRefusal(vp(), {}, 800, 600), null, 'a plain viewport screenshot');
  assert.equal(hiddenCaptureRefusal(vp({ x: 0, y: 0, width: 400, height: 300, scale: 1 }), {}, 800, 600), null, 'a clip inside the viewport at scale 1');
  assert.equal(hiddenCaptureRefusal(vp({ x: 0, y: 0, width: 800, height: 3000, scale: 1 }, { captureBeyondViewport: true }), {}, 800, 600), BEYOND_VIEWPORT_MESSAGE);
  assert.equal(hiddenCaptureRefusal(vp({ x: 0, y: 0, width: 400, height: 300, scale: 2 }), {}, 800, 600), DEVICE_METRICS_MESSAGE, 'clip.scale ≠ 1');
  assert.equal(hiddenCaptureRefusal(vp(), { deviceMetricsOverride: true }, 800, 600), DEVICE_METRICS_MESSAGE, 'an emulated viewport / dsf (visible 720×1280 vs hidden 360×640)');
  assert.equal(hiddenCaptureRefusal(vp(), { deviceMetricsOverride: false }, 800, 600), null);
});
