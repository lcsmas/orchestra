// #406 phase 2 — driving a tab nobody is looking at (policy A2, ledger #409 §Decisions Q2). Pure: no Electron, no clock of its own.
//
// A tab the human cannot see is ATTACHED to the window and `setVisible(false)`'d (not removed), and stays THROTTLED while idle — today's cost
// profile. An agent action on it takes a LEASE: `backgroundThrottling` goes off right before the action and back on after the last one (a short
// linger), so the agent can screenshot / click / type on a background tab or a background workspace without bringing it to the front.
// Measured on bare Electron 33 under sway (scripts/probe-hidden-drive-*, docs/codebase-map/browser-panel.md § Hidden-view drive):
//   · the flip is NECESSARY (flip-less: stale / no frame, 0/3) and SUFFICIENT for click+type (land ≤ 100 ms) and for a frame-subscription capture of a view
//     that was composited after its current document loaded (fresh in ~35 ms);
//   · `Page.captureScreenshot` on a hidden view is flaky even with the flip (1–2 of 3 runs): hidden captures come from the frame subscription instead;
//   · a document that loaded while the view was hidden was never composited: it produces no frame and takes no input until it has been shown once
//     ("surface": a short visible pulse BELOW the human's opaque tab, then hidden again);
//   · a hidden-view capture that gets no frame in HIDDEN_FRAME_DEADLINE_MS fails with one honest message (a never-composited document, or a window on an undisplayed
//     sway workspace where the CDP forms hang — measured: the frame subscription still delivers there). No verdict is cached: one dead tab must not refuse healthy ones.

export const LINGER_MS = 600; // throttling stays off this long after the last action (an agent's next command usually follows within it)
export const WATCHDOG_MS = 5000; // a lease nobody touched for this long is orphaned (its action died): force the flip-back — P7: linger + 5 s at most
export const HIDDEN_FRAME_DEADLINE_MS = 1200; // a hidden capture that has produced no frame by then is refused (measured: a fresh frame arrives in ≤ 45 ms)
export const SURFACE_PULSE_MAX_MS = 1500; // the visible pulse under the human's tab ends at the first frame or here

export type Surface = 'visible' | 'hidden' | 'detached';
export type ActionKind = 'capture' | 'input' | 'other';

export interface TabFacts {
  /** `visible` = composited on screen (the active tab of the focused workspace); `hidden` = attached + setVisible(false); `detached` = not a child of the window. */
  surface: Surface;
  /** The tab's CURRENT document has been composited at least once (a navigation while hidden resets it). */
  composited: boolean;
  /** Something opaque and visible, with a rect, can cover a pulse (the focused workspace's visible tab). */
  hasCover: boolean;
}

export type RefusalReason = 'needs-first-paint' | 'no-view';
export type ActionDecision =
  | { act: 'direct' } // composited on screen: no flip, nothing to do
  | { act: 'lease' } // hidden but drivable: throttling off around the action
  | { act: 'surface-then-lease' } // its document was never composited: show it once under the cover, then as `lease`
  | { act: 'refuse'; reason: RefusalReason; message: string };

export const NO_FRAME_MESSAGE =
  'no frame arrived from this tab: either its page loaded while it was hidden and has not been on screen since, or the Orchestra window is on a desktop workspace that is not displayed (nothing paints there). ' +
  'snapshot, eval, get, open, click and type still work; open the Browser pane (or switch to the desktop workspace holding Orchestra) and retry.';
export const BEYOND_VIEWPORT_MESSAGE =
  'a full-page (beyond-the-viewport) screenshot of a tab nobody is looking at is not supported: it would be cropped to the viewport. ' +
  'bring the tab to the front with `orchestra browser tab <ref>` and retry, or take the screenshot without --full.';
export const OFFSCREEN_MESSAGE =
  'the Orchestra window is on a desktop workspace that is not displayed (nothing paints there), so click, type, wheel and screenshot of a browser tab cannot run now. ' +
  'snapshot, eval, get and open still work; switch to the desktop workspace holding Orchestra and retry.';
export const STILL_LOADING_MESSAGE =
  "this tab's page is still loading, so it has no frame to capture and takes no input yet. retry in a moment — snapshot, eval, get and open work meanwhile.";
export const COVER_GONE_MESSAGE =
  "the Browser pane was closed (or the workspace switched) while this tab's first frame was being painted, so the action was cancelled: nothing is on screen to show it under. " +
  'snapshot, eval, get and open still work; open the Browser pane once and retry.';
export const DEVICE_METRICS_MESSAGE =
  'a screenshot of a tab nobody is looking at does not honour Emulation.setDeviceMetricsOverride or clip.scale (it would come back at the wrong size): ' +
  'bring the tab to the front with `orchestra browser tab <ref>` and retry, or clear the emulation.';
export const PAINT_PROBE_MS = 300; // the main renderer must answer a requestAnimationFrame within this, else its window paints nothing (measured: 6-16 ms displayed, a stall on an undisplayed sway workspace ≈ 1 s after the switch)
export const PAINT_VERDICT_TTL_MS = 750; // a burst of actions probes once
export const STALL_VERDICT_TTL_MS = 5000; // a capture that hung is proof of a stall: refuse for this long without asking
export const LOAD_SETTLE_MAX_MS = 6000; // how long a surfaced tab waits for a loading document before refusing with the true cause
export const NEEDS_FIRST_PAINT_MESSAGE =
  'this tab has not been on screen since its page loaded, so it has no frame to capture and takes no input yet, and nothing is on screen to cover showing it briefly. ' +
  "snapshot, eval, get and open still work; ask the user to open this workspace's Browser pane once.";

/**

 * What an agent action on a tab needs. Input and evaluate need no frame; a capture needs one, which a hidden composited tab delivers under a lease.
 */
export function decideTabAction(i: { tab: TabFacts | null; kind: ActionKind }): ActionDecision {
  if (!i.tab) return { act: 'refuse', reason: 'no-view', message: 'the browser tab has no live view' };
  if (i.tab.surface === 'visible') return { act: 'direct' };
  if (i.kind === 'other') return { act: 'lease' }; // evaluate / navigate / get: they work on any state; the lease keeps timers and loads moving
  if (i.tab.composited && i.tab.surface === 'hidden') return { act: 'lease' };
  if (i.tab.hasCover) return { act: 'surface-then-lease' };
  return { act: 'refuse', reason: 'needs-first-paint', message: NEEDS_FIRST_PAINT_MESSAGE };
}

/**
 * Reference-counted throttling leases. `acquire` says whether THIS call has to flip throttling off (the first holder); `release` starts the linger; `due`
 * lists what to flip back (the linger of a released lease elapsed) and what to force-release (a lease untouched for WATCHDOG_MS: its action died — P7).
 * Pure bookkeeping: the caller owns the timer and the actual `setBackgroundThrottling`.
 */
interface Lease {
  holders: number;
  touchedAt: number;
  releaseAt: number | null; // set when holders reached 0: the flip-back time
  unthrottled: boolean;
}
export class LeaseBook {
  private readonly leases = new Map<string, Lease>();
  acquire(id: string, now: number): { flip: boolean } {
    const l = this.leases.get(id);
    if (!l) {
      this.leases.set(id, { holders: 1, touchedAt: now, releaseAt: null, unthrottled: true });
      return { flip: true };
    }
    l.holders += 1;
    l.touchedAt = now;
    l.releaseAt = null; // the linger is cancelled: the view is in use again
    const flip = !l.unthrottled;
    l.unthrottled = true;
    return { flip };
  }
  /** A command on the tab is still running / just ran: keeps the watchdog from calling its lease orphaned. */
  touch(id: string, now: number): void {
    const l = this.leases.get(id);
    if (l) l.touchedAt = now;
  }
  release(id: string, now: number): void {
    const l = this.leases.get(id);
    if (!l || l.holders === 0) return;
    l.holders -= 1;
    l.touchedAt = now;
    if (l.holders === 0) l.releaseAt = now + LINGER_MS;
  }
  /** Tabs whose throttling must go back ON now. A lease with holders that nobody touched for WATCHDOG_MS is orphaned and forced. */
  due(now: number): { unflip: string[]; orphaned: string[] } {
    const unflip: string[] = [];
    const orphaned: string[] = [];
    for (const [id, l] of this.leases) {
      if (l.holders > 0 && now - l.touchedAt >= WATCHDOG_MS) {
        orphaned.push(id);
        unflip.push(id);
        this.leases.delete(id);
      } else if (l.holders === 0 && l.releaseAt !== null && now >= l.releaseAt) {
        unflip.push(id);
        this.leases.delete(id);
      }
    }
    return { unflip, orphaned };
  }
  /** The tab is gone (closed / destroyed / rebuilt): nothing to flip back. */
  forget(id: string): void {
    this.leases.delete(id);
  }
  /** Earliest time `due` will have something to report, or null when no lease is held. */
  nextWakeAt(): number | null {
    let t: number | null = null;
    for (const l of this.leases.values()) {
      const at = l.holders > 0 ? l.touchedAt + WATCHDOG_MS : (l.releaseAt ?? Infinity);
      if (t === null || at < t) t = at;
    }
    return t;
  }
  isHeld(id: string): boolean {
    return this.leases.has(id);
  }
  size(): number {
    return this.leases.size;
  }
}

/** A CDP `clip` (CSS px, scale) clamped into a frame of `w`×`h` device pixels (`dpr` device px per CSS px); null = the whole frame. */
export function cropRect(clip: { x: number; y: number; width: number; height: number } | undefined, w: number, h: number, dpr = 1): { x: number; y: number; width: number; height: number } | null {
  if (!clip || !(clip.width > 0) || !(clip.height > 0)) return null;
  const x = Math.max(0, Math.min(w - 1, Math.round(clip.x * dpr)));
  const y = Math.max(0, Math.min(h - 1, Math.round(clip.y * dpr)));
  const width = Math.max(1, Math.min(w - x, Math.round(clip.width * dpr)));
  const height = Math.max(1, Math.min(h - y, Math.round(clip.height * dpr)));
  return { x, y, width, height };
}

/** A CDP screenshot that asks for content beyond the viewport (`captureBeyondViewport` with a `clip` larger than it): a hidden view's `capturePage()` can only return the viewport. */
export function clipBeyondViewport(params: { captureBeyondViewport?: unknown; clip?: { x: number; y: number; width: number; height: number } }, viewportW: number, viewportH: number): boolean {
  const c = params.clip;
  if (params.captureBeyondViewport !== true || !c) return false;
  return c.x + c.width > viewportW + 1 || c.y + c.height > viewportH + 1;
}

/** Why a hidden view's `capturePage()` cannot honour this CDP screenshot (it returns the viewport at the view's own scale), or null. */
export function hiddenCaptureRefusal(
  params: { captureBeyondViewport?: unknown; clip?: { x: number; y: number; width: number; height: number; scale?: number } },
  info: { deviceMetricsOverride?: boolean },
  viewportW: number,
  viewportH: number,
): string | null {
  if (clipBeyondViewport(params, viewportW, viewportH)) return BEYOND_VIEWPORT_MESSAGE;
  const scale = params.clip?.scale;
  if ((typeof scale === 'number' && scale !== 1) || info.deviceMetricsOverride) return DEVICE_METRICS_MESSAGE;
  return null;
}
