// Memory banner (#289, D5 D-pick3) — the STATE half. NO Electron import: the guard, the Admission queue and the bus reach it through `MemoryBannerDeps`; src/main/memory-banner-host.ts binds the real ones and the IPC.
// Pure words/dismiss rules: src/shared/memory-banner.ts. The publisher recomputes the banner on every guard edge and, while the banner is up, on a light timer (the held-start count and the paused runs move without
// a guard edge); it PUSHES only when the state really changed (a revision stamps every push so the renderer can drop an older pull).

import type { GuardTransition, MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import { NO_MEMORY_BANNER, bannerFingerprint, memoryBannerOf, type MemoryBannerState } from '../shared/memory-banner.ts';

/** While a banner is up the counts / paused runs are re-read this often (an episode is minutes long; a bus change must not wait for the next 10–60 s guard sample). */
export const BANNER_REFRESH_MS = 5_000;

export interface MemoryBannerDeps {
  snapshot(): MemoryGuardSnapshot;
  /** Automatic fleet starts currently HELD by Admission (#286). */
  heldStarts(): number;
  /** The runs under the memory Pause, named for the UI. */
  pausedRuns(): string[];
  /** Deliver a changed state to every renderer. */
  push(state: MemoryBannerState): void;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  log: { warn: (m: string, e?: unknown) => void };
}

export interface MemoryBannerPublisher {
  /** The current state (what a renderer's initial pull gets). */
  current(): MemoryBannerState;
  /** Recompute now; push if it changed. */
  refresh(): void;
  /** A guard edge (any kind): recompute. */
  onEdge(e: { transition: Pick<GuardTransition, 'kind'> }): void;
  stop(): void;
}

export function createMemoryBannerPublisher(deps: MemoryBannerDeps): MemoryBannerPublisher {
  let last: MemoryBannerState = NO_MEMORY_BANNER;
  let rev = 0;
  let timer: unknown = null;

  function compute(): MemoryBannerState {
    return memoryBannerOf(deps.snapshot(), { heldStarts: deps.heldStarts(), pausedRuns: deps.pausedRuns() }, last.rev);
  }

  function rearm(active: boolean): void {
    if (!active) {
      if (timer !== null) deps.cancel(timer);
      timer = null;
      return;
    }
    if (timer !== null) return;
    timer = deps.schedule(() => {
      timer = null;
      refresh();
    }, BANNER_REFRESH_MS);
  }

  function refresh(): void {
    try {
      const next = compute();
      if (bannerFingerprint(next) !== bannerFingerprint(last)) {
        last = { ...next, rev: ++rev };
        deps.push(last);
      }
      rearm(last.kind !== 'none');
    } catch (e) {
      deps.log.warn('memory-banner: refresh failed — retried at the next edge / tick', e);
      rearm(last.kind !== 'none');
    }
  }

  return {
    current: () => last,
    refresh,
    onEdge: () => refresh(),
    stop() {
      if (timer !== null) deps.cancel(timer);
      timer = null;
    },
  };
}
