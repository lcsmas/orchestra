/**
 * `Page.captureScreenshot` chain for the CDP proxy (#395, research §2.3):
 * invalidate → frame probes → deadline → `capturePage()` fallback.
 *
 * A `WebContentsView` only produces frames while composited, so a bare `Page.captureScreenshot`
 * can wait on a frame that never comes (agent-browser then times out at 30 s with no reason).
 * The chain bounds that: ask for a repaint, keep nudging with cheap probes while the real capture
 * is pending, and past the deadline return `capturePage()`'s image instead — or fail NAMED.
 * Pure + timer-injected so every branch is unit-testable without Electron.
 */

/** Cheap 1x1 captures fired while the real one is pending — they can produce the frame it waits for. */
export const CAPTURE_PROBE_DELAYS_MS: readonly number[] = [250, 750, 1750, 3750];
/** Past this the primary capture is given up on (under agent-browser's 30 s command timeout). */
export const CAPTURE_DEADLINE_MS = 5000;
/** `capturePage()` on a never-painted view can hang forever (browser-panel.md): bound it. */
export const CAPTURE_FALLBACK_TIMEOUT_MS = 1000;

export interface CaptureTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CaptureDeps {
  /** The real `Page.captureScreenshot` via the tab's debugger. */
  primary(): Promise<string>;
  /** Fire-and-forget 1x1 JPEG capture; its outcome is irrelevant. */
  probe(): Promise<unknown>;
  /** Ask the view for a fresh frame (`webContents.invalidate()`). */
  invalidate(): void;
  /** `capturePage()` encoded as requested, or `null` when the request has options it cannot honour. */
  fallback: (() => Promise<string>) | null;
  timers?: CaptureTimers;
  deadlineMs?: number;
  fallbackTimeoutMs?: number;
}

export type CaptureResult = { via: 'debugger' | 'fallback'; data: string };

const realTimers: CaptureTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export async function captureWithFallback(deps: CaptureDeps): Promise<CaptureResult> {
  const timers = deps.timers ?? realTimers;
  const deadlineMs = deps.deadlineMs ?? CAPTURE_DEADLINE_MS;
  const fallbackTimeoutMs = deps.fallbackTimeoutMs ?? CAPTURE_FALLBACK_TIMEOUT_MS;
  const handles: unknown[] = [];
  try {
    deps.invalidate();
    return await new Promise<CaptureResult>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        fn();
      };
      deps.primary().then(
        (data) => finish(() => resolve({ via: 'debugger', data })),
        // A primary that FAILS (vs hangs) still gets the fallback below, after the deadline path
        // would have: failing fast with the primary's own error is more useful when nothing can fall back.
        (err) => {
          if (!deps.fallback) return finish(() => reject(err));
          void runFallback(err);
        },
      );
      for (const ms of CAPTURE_PROBE_DELAYS_MS) {
        if (ms >= deadlineMs) continue;
        handles.push(timers.set(() => { if (!done) deps.probe().catch(() => {}); }, ms));
      }
      handles.push(
        timers.set(() => {
          if (done) return;
          if (!deps.fallback) {
            return finish(() => reject(new Error(`Page.captureScreenshot produced no frame within ${deadlineMs} ms (the panel is probably not visible)`)));
          }
          void runFallback(new Error(`Page.captureScreenshot produced no frame within ${deadlineMs} ms`));
        }, deadlineMs),
      );

      async function runFallback(cause: unknown): Promise<void> {
        if (done) return;
        let timer: unknown;
        try {
          const data = await Promise.race([
            deps.fallback!(),
            new Promise<never>((_, rej) => {
              timer = timers.set(() => rej(new Error(`capturePage() gave no image within ${fallbackTimeoutMs} ms`)), fallbackTimeoutMs);
            }),
          ]);
          finish(() => resolve({ via: 'fallback', data }));
        } catch (fbErr) {
          const c = cause instanceof Error ? cause.message : String(cause);
          finish(() => reject(new Error(`${c}; fallback failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`)));
        } finally {
          if (timer !== undefined) timers.clear(timer);
        }
      }
    });
  } finally {
    for (const h of handles) timers.clear(h);
  }
}
