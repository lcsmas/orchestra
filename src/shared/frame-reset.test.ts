import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameReset } from './frame-reset.ts';

// Deterministic frame clock: `raf` queues, `frame()` runs what was queued.
function clock() {
  let next = 1;
  let queue = new Map<number, () => void>();
  let scheduled = 0;
  return {
    raf: (cb: () => void) => {
      const h = next++;
      queue.set(h, cb);
      scheduled++;
      return h;
    },
    caf: (h: number) => void queue.delete(h),
    frame() {
      const q = queue;
      queue = new Map();
      for (const cb of q.values()) cb();
    },
    pending: () => queue.size,
    scheduled: () => scheduled,
  };
}

test('frame-reset: idle schedules NOTHING (no perpetual rAF)', () => {
  const c = clock();
  let resets = 0;
  createFrameReset(() => resets++, c.raf, c.caf);
  for (let i = 0; i < 100; i++) c.frame();
  assert.equal(c.scheduled(), 0);
  assert.equal(resets, 0);
});

test('frame-reset: arm coalesces within a frame, fires once, does not re-arm itself', () => {
  const c = clock();
  let resets = 0;
  const r = createFrameReset(() => resets++, c.raf, c.caf);
  r.arm();
  r.arm();
  r.arm();
  assert.equal(c.pending(), 1);
  c.frame();
  assert.equal(resets, 1);
  assert.equal(c.pending(), 0); // one-shot: nothing left scheduled
  c.frame();
  assert.equal(resets, 1);
});

// Review F1: StrictMode runs cleanup then the effects again on the SAME instance
// while the mount's reset is still pending. The reset must keep working after.
test('frame-reset: arm still works after cancel (StrictMode unmount->remount on the same refs)', () => {
  const c = clock();
  let passes = 0;
  let tripped = false;
  const r = createFrameReset(() => (passes = 0), c.raf, c.caf);
  passes++;
  r.arm(); // the mount's pass leaves a reset pending…
  r.cancel(); // …StrictMode's simulated unmount cancels it
  // the pane then keeps measuring rows, one per frame, like a streaming turn
  for (let i = 0; i < 40; i++) {
    passes++;
    r.arm();
    if (passes > 12) tripped = true; // the guard's threshold (MAX_SYNC_MEASURE_PASSES)
    c.frame();
  }
  assert.equal(tripped, false, 'counter must be back to 0 every frame');
  assert.equal(passes, 0);
});

test('frame-reset: cancel drops a pending reset', () => {
  const c = clock();
  let resets = 0;
  const r = createFrameReset(() => resets++, c.raf, c.caf);
  r.arm();
  r.cancel();
  c.frame();
  assert.equal(resets, 0);
});
