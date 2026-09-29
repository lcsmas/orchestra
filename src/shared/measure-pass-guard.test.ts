import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurePassGuard, type MeasurePassGuard, type PassVerdict } from './measure-pass-guard.ts';

const MAX = 12; // MAX_SYNC_MEASURE_PASSES

function clock() {
  let next = 1;
  let queue = new Map<number, () => void>();
  let scheduled = 0;
  return {
    scheduled: () => scheduled,
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
  };
}
const setup = () => {
  const c = clock();
  return { c, guard: createMeasurePassGuard(MAX, c.raf, c.caf) };
};

// Mirrors StructuredView's onHeight: an UNCHANGED height is not a pass; a changed one is a
// pass, and in a feedback loop every changed height arrives in its OWN render commit.
function measure(guard: MeasurePassGuard, heights: number[]): PassVerdict[] {
  const out: PassVerdict[] = [];
  let known: number | undefined;
  for (const h of heights) {
    if (known === h) continue;
    known = h;
    out.push(guard.recordPass({}));
  }
  return out;
}

// MUST-TRIP: a genuine feedback loop (A->B->A: every pass reports a NEW height, no paint between).
test('guard trips on a genuinely oscillating height sequence, once, then bounds', () => {
  const { guard } = setup();
  const heights = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 100 : 130));
  const v = measure(guard, heights);
  assert.equal(v.length, 30, 'every step is a changed height, so a pass');
  assert.equal(v[MAX - 1].looping, false, 'the 12th pass is still within the limit');
  assert.equal(v[MAX].looping, true, 'the 13th consecutive pass trips');
  assert.equal(v.filter((x) => x.firstTrip).length, 1, 'the warning fires exactly once');
  assert.equal(v[MAX].firstTrip, true);
  assert.ok(v.slice(MAX).every((x) => x.looping), 'stays bounded until a frame boundary');
});

test('after the trip, a frame boundary lets the sync path back in', () => {
  const { c, guard } = setup();
  measure(guard, Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 130)));
  c.frame();
  const [v] = measure(guard, [140]);
  assert.equal(v.passes, 1);
  assert.equal(v.looping, false);
  assert.equal(v.firstTrip, false, 'the latch is per instance: a second trip is not re-announced');
});

// MUST-NOT-TRIP arms — each is the adversarial input of one way to break the guard.
test('a cold pane open (many rows, ONE commit) is one pass, not N', () => {
  const { guard } = setup();
  const commit = {};
  let last!: PassVerdict;
  for (let row = 0; row < 20; row++) last = guard.recordPass(commit);
  assert.equal(last.passes, 1);
  assert.equal(last.looping, false);
});

test('streaming across frames never accumulates toward the limit', () => {
  const { c, guard } = setup();
  for (let i = 0; i < 60; i++) {
    const [v] = measure(guard, [i * 7 + 1]);
    assert.equal(v.looping, false, `row ${i}`);
    c.frame();
  }
});

test('idle schedules NO frames; one pass arms exactly one one-shot reset', () => {
  const { c, guard } = setup();
  for (let i = 0; i < 50; i++) c.frame();
  assert.equal(c.scheduled(), 0, 'a quiet pane must not wake the renderer');
  guard.recordPass({});
  c.frame();
  for (let i = 0; i < 50; i++) c.frame();
  assert.equal(c.scheduled(), 1, 'the reset fires once and does not re-arm itself');
});

test('dispose then keep measuring (StrictMode): the reset still works', () => {
  const { c, guard } = setup();
  measure(guard, [10]);
  guard.dispose();
  for (let i = 0; i < 40; i++) {
    const [v] = measure(guard, [i + 100]);
    assert.equal(v.looping, false);
    c.frame();
  }
});
