// #293 (wave G ledger #295, FI-3 v1.3) — the three production predicates the container accounting classifies with, bound to the bus + store through injected deps (Electron-free: node --test drives them over a REAL bus.sqlite).
// Kept out of src/main/container-accounting.ts so the real-dockerd rig that imports that producer never loads better-sqlite3.

import type { BusDb } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { liveFleetRuns, type MemoryPauseDeps } from './pause-memory.ts';

export type ContainerWindowDeps = Pick<MemoryPauseDeps, 'getWorkspace' | 'listWorkspaces'> & {
  getBus(): BusDb | null;
  /** The store has parsed store.json (before that no workspace is "known", and every labelled container would look like an orphan). */
  storeReady(): boolean;
};

/**
 * Start of the earliest LIVE fleet run, epoch ms (null = none → nothing can be "unattributed"). "Live" is `liveFleetRuns` — the SAME definition as the LEAD selection of the memory alert and the memory Pause (#289/#290):
 * the run's anchor workspace is live (exists, not archived, not sandbox-hosted) with ≥ 1 live local workspace below it. NO keeper condition: a hibernated coordinator still leads its run. Nothing writes `runs.closed_at`.
 * Residual (accepted, FI-3 v1.3): a long-lived run widens the window by days.
 */
export function earliestLiveFleetRunStart(deps: ContainerWindowDeps): number | null {
  const db = deps.getBus();
  if (!db) return null;
  let min: number | null = null;
  for (const r of liveFleetRuns(db, deps)) {
    const run = getRun(db, r.id);
    if (run) min = min === null ? run.created_at : Math.min(min, run.created_at);
  }
  return min;
}

/**
 * A container labelled for a workspace this store does not have is an ORPHAN. While the store is UNTRUSTED (`storeReady` false: not parsed yet — or a fresh install / corrupt store.json, where it stays false all session) it
 * knows nobody, so it must not turn every labelled container into an orphan, nor attribute another Orchestra instance's: it trusts the container's `orchestra.run` stamp alone (a run THIS bus has).
 */
export const workspaceKnownIn = (deps: Pick<ContainerWindowDeps, 'getWorkspace' | 'storeReady' | 'getBus'>) => (id: string, runId: string): boolean => (deps.storeReady() ? !!deps.getWorkspace(id) : runKnownIn(deps)(runId));

/** An orphan must carry a run stamp THIS app's bus knows: a container stamped by another Orchestra instance sharing the daemon (a dev build beside the live app) is not ours. */
export const runKnownIn = (deps: Pick<ContainerWindowDeps, 'getBus'>) => (runId: string): boolean => {
  const db = deps.getBus();
  return !!db && runId !== '' && getRun(db, runId) !== null;
};
