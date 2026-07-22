/**
 * Typewriter reveal scheduler for the structured agent view.
 *
 * ## Problem
 *
 * The Claude Agent SDK delivers assistant text in BURSTS: the model emits a
 * phrase, pauses, emits another. Rendering each burst the instant it arrives —
 * however cheaply (see `markdown-blocks.ts`, which fixed the per-frame COST) —
 * still makes text appear in chunks: a line snaps in, a pause, another line
 * snaps in. That reads as "block by block", not fluid streaming.
 *
 * ## Fix
 *
 * Decouple ARRIVAL (bursty, network-paced) from DISPLAY (smooth, frame-paced).
 * Incoming text is the `target`; we reveal a growing PREFIX of it at a steady
 * per-frame rate so characters flow in evenly regardless of how the network
 * delivered them — a typewriter. This is what the Claude Code desktop app and
 * ChatGPT do.
 *
 * This module is the pure math: given the current revealed length, the target
 * length, and how many milliseconds elapsed since the last frame, compute the
 * next revealed length. No React, no timers, no DOM — so it's unit-testable and
 * the same logic drives the RAF loop in `useTypewriter`.
 *
 * ## Cadence design
 *
 * A fixed chars/frame rate has two failure modes: too slow and the display
 * falls arbitrarily far behind a fast turn (finishing seconds after the model
 * did); too fast and it's indistinguishable from no smoothing. So the rate
 * ADAPTS to the backlog — the number of characters revealed but not yet shown:
 *
 *   - A base speed (chars/ms) gives the gentle floor cadence when nearly caught
 *     up, so even a slow trickle still animates rather than popping in.
 *   - The effective speed scales UP with the backlog (proportional catch-up), so
 *     a large burst drains quickly and the display never lags more than ~a short,
 *     bounded time behind the model. This keeps it fluid AND responsive.
 *
 * The result is smooth typing that speeds up under load and eases off when the
 * stream slows — never stalling, never lagging unboundedly.
 */

export interface TypewriterParams {
  /** Base reveal speed in characters per millisecond when nearly caught up.
   *  ~0.05 ch/ms ≈ 50 ch/s ≈ ~3 chars/60fps-frame — a readable typing pace. */
  baseCharsPerMs: number;
  /** Fraction of the current backlog to additionally drain per millisecond.
   *  Higher → bursts catch up faster (display lags less, but animates less).
   *  ~0.01/ms means a backlog empties on a ~100ms time-constant under catch-up. */
  catchupPerMs: number;
  /** Never reveal more than this many characters in a single frame, so a huge
   *  paste/burst still animates over a few frames instead of dumping at once.
   *  A safety cap on the proportional term; generous enough to keep long turns
   *  from dragging. */
  maxCharsPerFrame: number;
}

/** Sensible defaults tuned for a 60fps typewriter that feels like the Claude
 *  Code app: gentle floor, quick but visible catch-up on bursts. */
export const DEFAULT_TYPEWRITER: TypewriterParams = {
  baseCharsPerMs: 0.05, // ~3 chars/frame floor at 60fps — the slow-trickle pace
  catchupPerMs: 0.02, // drain ~2%/ms of backlog → bursts catch up on a ~short,
  // bounded time constant, so display never lags far behind the model. Tuned so
  // a fully-available message reveals responsively (see typewriter.test.ts):
  // ~0.3s for 2KB, ~0.56s for 12KB, ~1.0s for 30KB — animated, never dragging.
  maxCharsPerFrame: 600, // cap a single frame's reveal so a huge burst still
  // animates over a few frames instead of dumping at once.
};

/**
 * Compute the next revealed length after `dtMs` milliseconds have elapsed.
 *
 * @param revealed  characters currently shown (0..target)
 * @param target    total characters available to show (the accumulated text len)
 * @param dtMs      ms since the previous frame (clamped internally to a sane range)
 * @param p         cadence parameters
 * @returns the new revealed length, an integer in [revealed, target]
 *
 * Monotonic (never un-reveals) and clamped to `target` (never overshoots). When
 * `revealed >= target` there is nothing to do and `target` is returned.
 */
export function nextRevealed(
  revealed: number,
  target: number,
  dtMs: number,
  p: TypewriterParams = DEFAULT_TYPEWRITER,
): number {
  if (revealed >= target) return target;
  // Clamp dt: a backgrounded tab or the first frame can report a huge/zero gap;
  // treat those as a single nominal frame so we neither dump nor stall.
  const dt = Math.max(0, Math.min(dtMs, 100));
  const backlog = target - revealed;
  // Steady floor + proportional catch-up, both scaled by elapsed time.
  const advance = p.baseCharsPerMs * dt + p.catchupPerMs * backlog * dt;
  // At least 1 char once any time has passed, so a slow trickle still moves and
  // we can never get stuck one char short forever due to rounding.
  const stepped = dt > 0 ? Math.max(1, advance) : advance;
  const capped = Math.min(stepped, p.maxCharsPerFrame);
  const next = revealed + Math.floor(capped);
  return next >= target ? target : next;
}
