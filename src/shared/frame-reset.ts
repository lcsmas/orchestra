// One-shot frame-boundary reset scheduler for StructuredView's row-measure guard
// (#198 D11 / T9). `arm()` schedules `onFrame` for the next frame unless one is
// already pending, and NOTHING is scheduled while idle (a perpetual rAF here woke
// every mounted pane 60x/s). `cancel()` also forgets the handle: StrictMode's
// simulated unmount->remount runs cleanup then the effects again on the SAME refs,
// so a stale handle would make every later `arm()` a silent no-op (review F1).

export interface FrameReset {
  arm(): void;
  cancel(): void;
}

export function createFrameReset(
  onFrame: () => void,
  raf: (cb: () => void) => number,
  caf: (handle: number) => void,
): FrameReset {
  let handle = 0; // rAF handles are >= 1, so 0 means "nothing pending"
  return {
    arm() {
      if (handle) return;
      handle = raf(() => {
        handle = 0;
        onFrame();
      });
    },
    cancel() {
      if (handle) caf(handle);
      handle = 0;
    },
  };
}
