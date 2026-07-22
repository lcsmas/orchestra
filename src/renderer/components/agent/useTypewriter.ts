import { useEffect, useRef, useState } from 'react';
import { nextRevealed, DEFAULT_TYPEWRITER } from '../../typewriter';

/**
 * Progressively reveal `text` at a steady typewriter cadence while a message is
 * streaming, so bursty SDK delivery displays as fluid typing instead of chunks.
 *
 * Returns the currently-revealed PREFIX of `text`. A `requestAnimationFrame`
 * loop advances the revealed length toward `text.length` using the pure
 * `nextRevealed` scheduler (see `renderer/typewriter.ts`); the caller renders
 * the returned prefix through the normal markdown path (partial markdown is
 * fine — it's what streaming already produces, and `markdown-blocks.ts` keeps
 * the per-frame render cheap).
 *
 * Invariants:
 * - **Monotonic within a message**: revealed length only grows as `text` grows.
 * - **Finishes complete**: once `done` is true we snap to the full text on the
 *   next frame and stop the loop — a finished message is NEVER left truncated.
 * - **No animation when disabled or already-complete**: if `!enabled` (e.g. a
 *   non-streaming/finished message on first render) the full text is returned
 *   immediately with no RAF loop, so historical transcript messages don't
 *   re-type themselves on mount.
 *
 * The loop is driven off the real frame clock (via `performance.now()` deltas)
 * so it stays smooth independent of how often `text` updates.
 */
// No-RAF environments (SSR / node smoke tests) can't animate — reveal in full
// so a server-rendered or test-rendered streaming message shows its text rather
// than an empty first frame.
const canAnimate = typeof requestAnimationFrame === 'function';

export function useTypewriter(text: string, done: boolean, enabled: boolean): string {
  const active = enabled && canAnimate;
  // How many characters are currently shown. Ref drives the loop; state forces
  // the re-render. Kept in sync. Seeded to the full length when we're not going
  // to animate (finished/historical/SSR) so nothing flashes empty.
  const revealedRef = useRef(active ? 0 : text.length);
  const [revealed, setRevealed] = useState(active ? 0 : text.length);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  // Latest target/done without restarting the loop each render.
  const textRef = useRef(text);
  const doneRef = useRef(done);
  textRef.current = text;
  doneRef.current = done;

  // When animation is disabled (finished/historical message), show everything
  // and never start a loop. This also handles the case where a message mounts
  // already-done (backfill) — it must appear in full, not re-type.
  useEffect(() => {
    if (active) return;
    revealedRef.current = text.length;
    setRevealed(text.length);
  }, [active, text.length]);

  useEffect(() => {
    if (!active) return;

    const tick = (ts: number) => {
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      const dt = last == null ? 16 : ts - last;

      const target = textRef.current.length;
      const isDone = doneRef.current;
      const cur = revealedRef.current;

      // A finished message must show in full immediately — no lingering tail.
      const next = isDone ? target : nextRevealed(cur, target, dt, DEFAULT_TYPEWRITER);

      if (next !== cur) {
        revealedRef.current = next;
        setRevealed(next);
      }

      // Keep animating while there's still text to reveal. When done AND fully
      // revealed, stop the loop (it restarts if more text/`enabled` arrives via
      // the deps below).
      if (revealedRef.current < textRef.current.length || !doneRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        lastTsRef.current = null;
      }
    };

    // (Re)start the loop if it isn't running — e.g. new text arrived after we
    // had caught up, or `done` flipped.
    if (rafRef.current == null) {
      lastTsRef.current = null;
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTsRef.current = null;
    };
    // Re-run when the target length or done-ness changes so a loop that stopped
    // after catching up wakes back up for the next burst.
  }, [active, text.length, done]);

  if (!active) return text;
  // Guard: never return more than the text (text could shrink only on a new
  // message, handled by keying — but clamp defensively).
  const n = Math.min(revealed, text.length);
  return text.slice(0, n);
}
