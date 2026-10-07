// Memory banner (#289, D5 D-pick3) — the HOST binding: the real guard, Admission queue, bus and store bound to `MemoryBannerDeps`, the `memoryGuard:*` IPC and the push to every renderer
// (src/main/memory-banner.ts holds the logic, Electron-free). FI-2: SUBSCRIBE FIRST, then refresh from the snapshot.

import { ipcMain } from 'electron';
import { store } from './store';
import { platform } from './platform';
import { log } from './logger';
import { getBus } from './bus';
import { getMemoryGuardSnapshot, subscribeMemoryGuard } from './memory-guard';
import { listHeldStarts } from './admission';
import { memoryPausedRuns } from './pause-memory';
import { createMemoryBannerPublisher, type MemoryBannerPublisher } from './memory-banner';
import type { MemoryBannerState } from '../shared/memory-banner';

/** The pull (initial state at boot / reload) and the push the renderer subscribes to (the WHOLE state — a snapshot, not a delta, so it cannot drift). */
export const MEMORY_BANNER_PULL_CHANNEL = 'memoryGuard:banner';
export const MEMORY_BANNER_PUSH_CHANNEL = 'memoryGuard:bannerUpdate';

const publisher: MemoryBannerPublisher = createMemoryBannerPublisher({
  snapshot: getMemoryGuardSnapshot,
  heldStarts: () => listHeldStarts().length,
  pausedRuns: () => {
    const db = getBus();
    if (!db) return [];
    return memoryPausedRuns(db).map((r) => {
      const w = store.getWorkspace(r.runId);
      return w ? w.branch || w.name || r.runId : r.runId;
    });
  },
  push: (state) => platform.broadcast(MEMORY_BANNER_PUSH_CHANNEL, state),
  schedule: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  cancel: (h) => clearTimeout(h as NodeJS.Timeout),
  log: { warn: (m, e) => log.warn(m, e) },
});

let unsubscribe: (() => void) | null = null;

/** Register the pull channel. Called ONCE at module scope from index.ts (a second registration THROWS on darwin). Never rejects: an unreadable guard answers the last state. */
export function registerMemoryBannerIpc(): void {
  ipcMain.handle(MEMORY_BANNER_PULL_CHANNEL, (): MemoryBannerState => {
    publisher.refresh(); // a pull is also a fresh read (the renderer just booted / reloaded)
    return publisher.current();
  });
}

/** Start (idempotent): SUBSCRIBE to the guard's edges FIRST, then refresh from the snapshot (an edge between a snapshot and a later subscribe would be lost — FI-2.5). After the memory Pause (its runs are written on the same edge). */
export function startMemoryBanner(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeMemoryGuard((e) => publisher.onEdge(e));
  publisher.refresh();
}

export function stopMemoryBanner(): void {
  unsubscribe?.();
  unsubscribe = null;
  publisher.stop();
}
