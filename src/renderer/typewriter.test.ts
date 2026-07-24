import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRevealed, DEFAULT_TYPEWRITER, FINISH_TYPEWRITER } from './typewriter.ts';

const P = DEFAULT_TYPEWRITER;
const F = FINISH_TYPEWRITER;

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

test('STEADY rate below the soft cap — a burst does NOT drain in one frame (anti-chunk)', () => {
  // The core anti-chunkiness property: for backlogs up to the soft cap, the
  // per-frame reveal is the SAME constant regardless of how much is buffered.
  // (This is what a proportional catch-up would violate — and that violation is
  // exactly what made bursts read as blocks.)
  const smallBacklog = nextRevealed(0, 50, 16, P);
  const capBacklog = nextRevealed(0, P.softBacklogCap, 16, P);
  assert.equal(
    smallBacklog,
    capBacklog,
    `reveal should be constant below the cap: ${smallBacklog} vs ${capBacklog}`,
  );
  // And it must be a small, typing-sized step — not a whole burst at once.
  assert.ok(capBacklog < 50, `a single frame revealed ${capBacklog} chars — too chunky`);
});

test('overflow drain only engages ABOVE the soft cap, and only gently', () => {
  // Just below the cap = pure constant rate.
  const atCap = nextRevealed(0, P.softBacklogCap, 16, P);
  // Far above the cap = somewhat faster (bounded lag), but still not a chunk.
  const wayOver = nextRevealed(0, P.softBacklogCap + 5000, 16, P);
  assert.ok(wayOver > atCap, 'huge backlog should drain a bit faster than at-cap');
  assert.ok(wayOver <= P.maxCharsPerFrame, `overflow still capped at ${P.maxCharsPerFrame}`);
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

test('a fully-buffered large message still converges in bounded time (overflow drain)', () => {
  // The rare "all text at once" case (e.g. a very fast cached turn). The gentle
  // overflow keeps it from dragging: ~2s for 12KB, not the ~100s a pure constant
  // rate would take. (Live turns never hit this — see the realistic-live test.)
  let r = 0;
  const target = 12000;
  let frames = 0;
  while (r < target && frames < 100000) {
    r = nextRevealed(r, target, 16, P);
    frames++;
  }
  assert.equal(r, target);
  const seconds = (frames * 16) / 1000;
  assert.ok(seconds < 3, `12KB fully buffered took ${seconds.toFixed(1)}s — too slow`);
});

test('REALISTIC live streaming reveals in small typing-sized steps (no chunks)', () => {
  // The scenario the user actually sees: the model emits ~250 ch/s in ~30-char
  // deltas over a multi-second turn; the display drains every 16ms frame. The
  // reveal must advance in small, steady steps — NEVER a whole delta/burst at
  // once (that is the "block by block" complaint).
  let revealed = 0;
  let target = 0;
  let t = 0;
  const deltaEveryMs = 120;
  const deltaSize = 30;
  const totalChars = 3000;
  let nextDelta = deltaEveryMs;
  let emitted = 0;
  const steps: number[] = [];
  let maxBacklog = 0;
  while (revealed < totalChars && t < 60000) {
    t += 16;
    if (t >= nextDelta && emitted < totalChars) {
      target += deltaSize;
      emitted += deltaSize;
      nextDelta += deltaEveryMs;
    }
    const before = revealed;
    revealed = nextRevealed(revealed, target, 16, P);
    if (revealed > before) steps.push(revealed - before);
    maxBacklog = Math.max(maxBacklog, target - revealed);
  }
  assert.equal(revealed, totalChars);
  const maxStep = Math.max(...steps);
  // No frame revealed a whole delta (30) or more — i.e. never a chunk. A steady
  // typewriter reveals a few chars/frame; a chunky one dumps the delta.
  assert.ok(maxStep < 30, `max single-frame reveal was ${maxStep} chars — chunky`);
  // Backlog stayed small (below the cap), confirming we ran on the CONSTANT rate,
  // not the overflow drain — the whole point.
  assert.ok(maxBacklog < 200, `backlog reached ${maxBacklog} — display lagged`);
});

// ─── FINISH drain (message done, tail still unrevealed) ──────────────────────
//
// When a block closes (the model moves to a tool call) the typewriter holds a
// steady-state backlog of ~80 chars. The old behavior snapped it to full text
// in ONE frame — the "sudden output / instant jump right as a tool card
// appears" complaint. The finish cadence must drain it over SEVERAL frames
// (fluid flourish) yet converge fast (no lingering tail delaying the turn).

test('FINISH: a typical ~80-char tail drains over several frames, never one', () => {
  const tail = 80;
  let r = 0;
  let frames = 0;
  const steps: number[] = [];
  while (r < tail && frames < 1000) {
    const n = nextRevealed(r, tail, 16, F);
    steps.push(n - r);
    r = n;
    frames++;
  }
  assert.equal(r, tail);
  assert.ok(frames >= 3, `drained in ${frames} frame(s) — that IS the snap this replaces`);
  assert.ok(frames <= 15, `took ${frames} frames (~${frames * 16}ms) — tail lingers too long`);
  assert.ok(Math.max(...steps) < tail, 'no single frame dumped the whole tail');
});

test('FINISH: converges quickly even on a large finalized tail, still frame-capped', () => {
  // e.g. the tab was hidden (RAF suspended) and the message finished meanwhile.
  let r = 0;
  const target = 5000;
  let frames = 0;
  while (r < target && frames < 10000) {
    const n = nextRevealed(r, target, 16, F);
    assert.ok(n - r <= F.maxCharsPerFrame, `frame revealed ${n - r} > cap`);
    r = n;
    frames++;
  }
  assert.equal(r, target);
  const seconds = (frames * 16) / 1000;
  assert.ok(seconds < 2, `5KB finished tail took ${seconds.toFixed(1)}s — too slow`);
});

test('FINISH: drains faster than the streaming cadence (it is a catch-up mode)', () => {
  // Same 80-char backlog: finish mode must advance more per frame than the
  // steady streaming rate (which deliberately ignores backlog below its cap).
  const streaming = nextRevealed(0, 80, 16, P);
  const finishing = nextRevealed(0, 80, 16, F);
  assert.ok(
    finishing > streaming,
    `finish (${finishing}) should outpace streaming (${streaming}) on a done tail`,
  );
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
