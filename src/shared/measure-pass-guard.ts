// StructuredView's row-measure circuit breaker, as a pure state machine (#198 T9). Bounds the
// synchronous measure->render chain so a genuine height feedback loop degrades to the coalesced
// rAF path instead of hitting React error #185 (which black-screens the app).
import { createFrameReset } from './frame-reset.ts';

export interface PassVerdict {
  /** Synchronous passes counted since the last frame boundary. */
  passes: number;
  /** Past the limit: the caller must take the coalesced (rAF) path. */
  looping: boolean;
  /** First time this instance tripped — the caller logs the warning exactly once. */
  firstTrip: boolean;
}

export interface MeasurePassGuard {
  /** A row reported a CHANGED height in render commit `commit`. N rows in one commit are ONE pass. */
  recordPass(commit: object): PassVerdict;
  /** Unmount: drop a pending frame reset. The guard stays usable (StrictMode re-runs effects). */
  dispose(): void;
}

export function createMeasurePassGuard(
  max: number,
  raf: (cb: () => void) => number,
  caf: (handle: number) => void,
): MeasurePassGuard {
  let passes = 0;
  let lastCommit: object | null = null;
  let warned = false;
  const frameReset = createFrameReset(() => (passes = 0), raf, caf);
  return {
    recordPass(commit) {
      if (commit !== lastCommit) {
        lastCommit = commit;
        passes += 1;
      }
      frameReset.arm(); // idle panes never get here, so nothing is scheduled while quiet
      const looping = passes > max;
      const firstTrip = looping && !warned;
      if (firstTrip) warned = true;
      return { passes, looping, firstTrip };
    },
    dispose() {
      frameReset.cancel();
    },
  };
}
