// Relance (#427) — production wiring of the sweep (relance.ts): the roster from the store, the kernel-scope census, and delivery through the SAME path a Réveil takes
// (`sdkStartAndDeliver`: lazy-starts a Veille'd member, resuming its conversation) behind the SAME Admission gate (a start under low memory is HELD, not failed). Lifted out of
// index.ts so a rig and a wiring test can drive the real mapping. Not importable under plain node --test (store / platform seam): relance-wiring.test.ts pins it by source.

import { getBus } from './bus.ts';
import { readReleasedReaders } from './bus-liveness.ts';
import { log } from './logger.ts';
import { pauseRefusal } from './pause-gate';
import { wakeHeldForMemory } from './admission-wake';
import { sdkStartAndDeliver } from './sdk-delivery';
import { store } from './store';
import { wakeRosterEntry } from './wake-roster';
import { resolveWaveRunId } from './workspaces';
import { censusReliquatsOf } from './relance-census.ts';
import { startRelance, stopRelance, sweepRelanceNow, type RelanceDeps, type RelanceDelivery } from './relance.ts';
import type { Workspace } from '../shared/types';
import type { RelanceMember } from '../shared/relance.ts';

/** A member of the fleet as the Relance decision reads it. */
export function relanceMembers(): RelanceMember[] {
  const all = store.workspaces;
  const coordinatorOf = (ws: Workspace): boolean => {
    const parent = ws.parentId ? store.getWorkspace(ws.parentId) : undefined;
    return !!parent && !parent.archived;
  };
  // Released = reported done and not re-tasked (durable bus state, never mail). Only asked for the members the sweep will follow; an unreadable bus reads « nobody released »:
  // a finished member may get one needless turn, a stalled one is never silenced.
  let released = new Set<string>();
  try {
    const db = getBus();
    if (db) released = readReleasedReaders(db, all.filter((w) => coordinatorOf(w) && !!w.lastTask).map((w) => ({ reader: w.id, runId: resolveWaveRunId(w) })));
  } catch (e) {
    log.warn('relance: released read failed — treating as none released', e);
  }
  return all.map((ws) => ({
    wsId: ws.id,
    hasCoordinator: coordinatorOf(ws),
    hasTask: !!ws.lastTask,
    released: released.has(ws.id),
    paused: pauseRefusal(ws, 'auto') !== null,
    wakeable: wakeRosterEntry(ws).wakeable,
    // a running turn, a turn parked on an answer / permission, or a prompt already queued: a Relance now would only pile behind it
    active: ws.status === 'running' || ws.status === 'waiting' || (ws.sdkPendingPrompts?.length ?? 0) > 0,
  }));
}

async function deliver(wsId: string, text: string): Promise<RelanceDelivery> {
  const ws = store.getWorkspace(wsId);
  if (!ws) return 'failed';
  // Admission: a Relance of a SLEEPING fleet member is a start — held under low memory, released (coordinators first, one at a time) by re-entering the sweep.
  if (await wakeHeldForMemory(ws, () => sweepRelanceNow(productionRelanceDeps), { site: 'relance' })) return 'held';
  return (await sdkStartAndDeliver(wsId, text)) ? 'sent' : 'failed';
}

export const productionRelanceDeps: RelanceDeps = {
  now: () => Date.now(),
  members: relanceMembers,
  census: (wsId) => censusReliquatsOf(wsId),
  deliver,
};

/** `ORCHESTRA_RELANCE=0` turns the mechanism off (never started). */
export function startRelanceHost(): void {
  if (process.env.ORCHESTRA_RELANCE === '0') {
    log.info('relance: disabled by ORCHESTRA_RELANCE=0');
    return;
  }
  startRelance(productionRelanceDeps);
}

export { stopRelance };
