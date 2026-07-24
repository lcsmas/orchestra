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
  /** The STEADY reveal speed, in characters per millisecond. This is a CONSTANT
   *  pace — it does NOT scale with how much text is buffered. A constant rate is
   *  what makes a typewriter look fluid: when a burst of text arrives, the reveal
   *  does not speed up to drain it, so the burst plays out as smooth typing
   *  rather than a near-instant chunk. ~0.12 ch/ms ≈ 120 ch/s ≈ ~2 chars per
   *  60fps frame — a snappy-but-clearly-visible typing pace. */
  charsPerMs: number;
  /** Soft backlog ceiling (characters). Below this, reveal is the pure constant
   *  `charsPerMs`. Above it, a GENTLE extra drain kicks in (see `overflowPerMs`)
   *  purely to bound how far behind the model the display can fall on a very
   *  large/fast turn — it is NOT the proportional catch-up that caused chunky
   *  bursts (that scaled with the FULL backlog; this scales only with the small
   *  EXCESS over the ceiling, so normal bursts never trigger it). */
  softBacklogCap: number;
  /** Extra characters/ms drained per character of backlog ABOVE `softBacklogCap`.
   *  Small — just enough that a pathologically large buffer converges instead of
   *  dragging, without turning a burst into a chunk. */
  overflowPerMs: number;
  /** Hard cap on characters revealed in one frame — a safety valve so even the
   *  overflow drain can't dump a huge block in a single frame. */
  maxCharsPerFrame: number;
}

/**
 * Catch-up cadence for a message that just FINISHED (its block closed — e.g.
 * the model moved on to a tool call, or the turn ended) while the typewriter
 * still holds an unrevealed tail.
 *
 * At realistic live rates (~250 ch/s arriving vs the ~150 ch/s base reveal)
 * the steady-state backlog is ~80 chars — so when `done` flips, snapping to
 * the full text dumps that whole tail in ONE frame. That snap lands at the
 * exact moment a tool card appears below it, which is precisely the "sudden
 * output / instant jump when tool calls are output" complaint: the reader
 * sees half a sentence materialize + a new row pop in the same frame.
 *
 * Instead, a finished message DRAINS: same constant base rate, but the gentle
 * overflow term engages from backlog 0 (softBacklogCap: 0) with a stronger
 * coefficient, so a typical 80-char tail finishes in ~7 frames (~115ms) —
 * read as a quick fluid flourish, not a dump — while a huge finalized tail
 * (interrupt, tab-hidden catch-up) still converges fast and stays bounded by
 * `maxCharsPerFrame`.
 */
export const FINISH_TYPEWRITER: TypewriterParams = {
  charsPerMs: 0.15,
  softBacklogCap: 0, // drain engages immediately — the message is over
  overflowPerMs: 0.02, // ~80-char tail → 28,19,12,9,6,4,2 ch/frame ≈ 7 frames (~115ms)
  maxCharsPerFrame: 200,
};

/** Defaults for a steady, snappy 60fps typewriter (~120 ch/s) that reads as
 *  fluid typing, with only a gentle bound on lag for very large turns. */
export const DEFAULT_TYPEWRITER: TypewriterParams = {
  charsPerMs: 0.15, // ~150 ch/s ≈ 2-3 chars/frame — steady, visible, snappy.
  // Under realistic live streaming (~250 ch/s arriving in ~30-char deltas) the
  // backlog stays ~90 chars (below the cap) so the reveal is this pure constant
  // rate: measured ~3.8 chars/frame average, 12 max — smooth typing, no chunks,
  // finishing ~0.7s after the model. (A fully-buffered large paste is the only
  // case the overflow term below governs; live turns never hit it.)
  softBacklogCap: 80, // reveal is constant until >80 unrevealed chars buffer up
  overflowPerMs: 0.03, // gentle drain on the EXCESS beyond the cap, so a big
  // fully-buffered turn converges (~2s for 12KB) instead of dragging — without
  // speeding up ordinary live bursts (which stay under the cap).
  maxCharsPerFrame: 200, // safety valve; never dump a block in one frame
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
  // STEADY constant pace — the core of a fluid typewriter. Deliberately does NOT
  // scale with `backlog`, so an arriving burst is typed out at the same rate as
  // a trickle (no instant-drain that reads as a chunk).
  let advance = p.charsPerMs * dt;
  // Gentle bounded overflow: only the EXCESS backlog beyond the soft cap adds a
  // little speed, purely to stop the display lagging unboundedly on a huge turn.
  // Because it keys off (backlog - cap), not the full backlog, ordinary bursts
  // (below the cap) never trigger it and stay perfectly steady.
  const overflow = backlog - p.softBacklogCap;
  if (overflow > 0) advance += p.overflowPerMs * overflow * dt;
  // At least 1 char once any time has passed, so a slow trickle still moves and
  // we can never get stuck one char short forever due to rounding.
  const stepped = dt > 0 ? Math.max(1, advance) : advance;
  const capped = Math.min(stepped, p.maxCharsPerFrame);
  const next = revealed + Math.floor(capped);
  return next >= target ? target : next;
}
