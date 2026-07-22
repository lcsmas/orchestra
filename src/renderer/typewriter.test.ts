import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRevealed, DEFAULT_TYPEWRITER } from './typewriter.ts';

const P = DEFAULT_TYPEWRITER;

test('nothing to reveal when caught up', () => {
  assert.equal(nextRevealed(100, 100, 16, P), 100);
  assert.equal(nextRevealed(120, 100, 16, P), 100); // never exceeds target
});

test('reveals at least one char per frame while behind', () => {
  assert.ok(nextRevealed(0, 1000, 16, P) >= 1);
  // even a tiny dt reveals progress
  assert.ok(nextRevealed(0, 1000, 1, P) >= 1);
});

test('never overshoots the target', () => {
  // huge dt + huge backlog, but result is clamped to target
  assert.equal(nextRevealed(995, 1000, 1000, P), 1000);
});

test('monotonic — never un-reveals', () => {
  let r = 0;
  const target = 5000;
  for (let i = 0; i < 500; i++) {
    const n = nextRevealed(r, target, 16, P);
    assert.ok(n >= r, `frame ${i}: ${n} < ${r}`);
    r = n;
  }
});

test('bigger backlog drains faster (proportional catch-up)', () => {
  const small = nextRevealed(0, 100, 16, P) - 0;
  const big = nextRevealed(0, 100000, 16, P) - 0;
  assert.ok(big > small, `big backlog ${big} should reveal more than small ${small}`);
});

test('single-frame reveal is capped', () => {
  // An enormous backlog must not dump more than maxCharsPerFrame in one frame.
  const n = nextRevealed(0, 10_000_000, 16, P);
  assert.ok(n <= P.maxCharsPerFrame, `revealed ${n} exceeds cap ${P.maxCharsPerFrame}`);
});

test('dt is clamped so a backgrounded tab does not dump everything', () => {
  // A 10s gap (tab was hidden) should reveal no more than a ~100ms frame would.
  const hugeGap = nextRevealed(0, 1_000_000, 10_000, P);
  const clampFrame = nextRevealed(0, 1_000_000, 100, P);
  assert.equal(hugeGap, clampFrame);
});

test('zero dt reveals nothing', () => {
  assert.equal(nextRevealed(10, 1000, 0, P), 10);
});

test('converges to target within a bounded number of frames on a steady stream', () => {
  // Simulate a 12KB message fully available, drained at 60fps (~16ms/frame).
  let r = 0;
  const target = 12000;
  let frames = 0;
  while (r < target && frames < 10000) {
    r = nextRevealed(r, target, 16, P);
    frames++;
  }
  assert.equal(r, target);
  // With catch-up, a fully-available 12KB message should finish in well under a
  // second (~0.56s ≈ 35 frames at 60fps), not drag for many seconds.
  assert.ok(frames < 60, `took ${frames} frames to reveal 12KB — too slow`);
});

test('keeps up with a realistic bursty arrival without lagging unboundedly', () => {
  // target jumps in bursts (network), display drains every 16ms frame.
  let revealed = 0;
  let target = 0;
  const bursts = [200, 0, 0, 350, 0, 0, 0, 500, 0, 120, 0, 0, 800, 0, 0];
  let maxBacklog = 0;
  for (const burst of bursts) {
    target += burst;
    // ~3 frames between bursts
    for (let f = 0; f < 3; f++) {
      revealed = nextRevealed(revealed, target, 16, P);
      maxBacklog = Math.max(maxBacklog, target - revealed);
    }
  }
  // drain the tail
  let frames = 0;
  while (revealed < target && frames < 1000) {
    revealed = nextRevealed(revealed, target, 16, P);
    frames++;
  }
  assert.equal(revealed, target);
  // Backlog stayed bounded (never fell arbitrarily far behind the model).
  assert.ok(maxBacklog < 1500, `max backlog ${maxBacklog} — display lagged too far behind`);
});
