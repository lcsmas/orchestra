// Memory PAUSE (#290) — the HOST binding: the real store, bus and memory guard bound to `MemoryPauseDeps` (src/main/pause-memory.ts holds the logic, Electron-free).
// Mirror of pause-auto-host.ts ↔ pause-auto.ts. FI-2 (ledger #295): SUBSCRIBE FIRST, then reconcile from `getMemoryGuardSnapshot()`; key on `pause_due` / `pause_liftable` + the snapshot.

import { store } from './store.ts';
import { getBus } from './bus.ts';
import { beginReprise } from './bus-pause.ts';
import { log } from './logger.ts';
import { getMemoryGuardSnapshot, subscribeMemoryGuard } from './memory-guard.ts';
import { applyMemoryPause, handleMemoryGuardEdge, newMemoryPauseLedger, viewOfSnapshot, type MemoryPauseApplied, type MemoryPauseDeps } from './pause-memory.ts';

/** The level read: re-checks the persisted pauses against the snapshot — a lift/impose that had to wait (trap pending, ancestor paused, a hold, a throw) is retried, and an app restart (the in-memory guard
 *  state is gone, the persisted Pause is not) is reconciled. The guard itself samples every 10 s below the Admission threshold, 60 s above. */
export const MEMORY_PAUSE_TICK_MS = 15_000;

const realDeps: MemoryPauseDeps = {
  getBus,
  getWorkspace: (id) => store.getWorkspace(id),
  listWorkspaces: () => store.workspaces,
  beginReprise,
  storeReady: () => store.loadedFromDisk,
  now: () => Date.now(),
  log: { info: (m) => log.info(m), warn: (m, e) => log.warn(m, e) },
};

const ledger = newMemoryPauseLedger();
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Real-deps accessor for rigs. */
export function memoryPauseDeps(): MemoryPauseDeps {
  return realDeps;
}

/** One LEVEL read of the guard's snapshot (the tick, the boot reconcile, rigs). */
export function reconcileMemoryPauseNow(): MemoryPauseApplied {
  try {
    return applyMemoryPause(realDeps, viewOfSnapshot(getMemoryGuardSnapshot()), ledger, 'level');
  } catch (e) {
    log.warn('memory-pause: reconcile failed — retried at the next tick', e);
    return { want: 'none', imposed: [], lifted: [] };
  }
}

/** Start (idempotent): SUBSCRIBE to the guard's edges FIRST, then reconcile from the snapshot (an edge between a snapshot and a later subscribe would be lost — FI-2.5), then the level tick. */
export function startMemoryPause(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeMemoryGuard((e) => void handleMemoryGuardEdge(realDeps, ledger, e));
  reconcileMemoryPauseNow();
  timer = setInterval(() => void reconcileMemoryPauseNow(), MEMORY_PAUSE_TICK_MS);
  timer.unref?.();
}

export function stopMemoryPause(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearInterval(timer);
  timer = null;
  ledger.imposed.clear();
}
