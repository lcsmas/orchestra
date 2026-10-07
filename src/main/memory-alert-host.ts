// Memory guard ALERT (#289) — the HOST binding: the real store, bus, guard and Admission queue bound to `MemoryAlertDeps` (src/main/memory-alert.ts holds the logic, Electron-free).
// FI-2 (ledger #295): SUBSCRIBE FIRST, then reconcile from `getMemoryGuardSnapshot()` — a boot while Admission is already held tells the episode once.

import { store } from './store.ts';
import { getBus } from './bus.ts';
import { log } from './logger.ts';
import { getMemoryGuardSnapshot, subscribeMemoryGuard } from './memory-guard.ts';
import { listHeldStarts } from './admission.ts';
import { createMemoryAlert, type MemoryAlert, type MemoryAlertDeps } from './memory-alert.ts';

const realDeps: MemoryAlertDeps = {
  getBus,
  getWorkspace: (id) => store.getWorkspace(id),
  listWorkspaces: () => store.workspaces,
  storeReady: () => store.loadedFromDisk,
  now: () => Date.now(),
  log: { info: (m) => log.info(m), warn: (m, e) => log.warn(m, e) },
  snapshot: getMemoryGuardSnapshot,
  heldStarts: () => listHeldStarts().length,
  // fleet members (a workspace with a parent) put in Veille since the crossing: `hibernatedAt` is stamped by the Veille sweep
  veilleSince: (at) => store.workspaces.filter((w) => !w.archived && !!w.parentId && (w.hibernatedAt ?? 0) >= at).length,
  unattributedContainers: () => 0, // #293 (the relay's unattributed count) is not landed: the field stays, the value is 0
  schedule: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  cancel: (h) => clearTimeout(h as NodeJS.Timeout),
};

const alert: MemoryAlert = createMemoryAlert(realDeps);
let unsubscribe: (() => void) | null = null;

/** Real-alert accessor for rigs. */
export function memoryAlert(): MemoryAlert {
  return alert;
}

/** Start (idempotent): SUBSCRIBE to the guard's edges FIRST, then reconcile from the snapshot (an edge between a snapshot and a later subscribe would be lost — FI-2.5). */
export function startMemoryAlert(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeMemoryGuard((e) => alert.onEdge(e));
  alert.reconcile(getMemoryGuardSnapshot());
}

export function stopMemoryAlert(): void {
  unsubscribe?.();
  unsubscribe = null;
  alert.stop();
}
