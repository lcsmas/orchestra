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
import { relanceEnabled, relanceMember, relanceMembers, type RelanceRosterDeps } from './relance-roster.ts';

const roster: RelanceRosterDeps = {
  workspaces: () => store.workspaces,
  getWorkspace: (id) => store.getWorkspace(id),
  released: (readers) => {
    const db = getBus();
    return db ? readReleasedReaders(db, readers) : new Set<string>();
  },
  runIdOf: (ws) => resolveWaveRunId(ws),
  paused: (ws) => pauseRefusal(ws, 'auto') !== null,
  wakeable: (ws) => wakeRosterEntry(ws).wakeable,
  warn: (msg, e) => log.warn(msg, e),
};

/** THE delivery of a Relance — both triggers (a member's Reliquats ended, #427; the asleep vague's coordinator, #428). `site` names the Admission hold, `retry` re-enters the sweep that owes it. */
export async function deliverRelance(wsId: string, text: string, site: string, retry: () => Promise<unknown>): Promise<RelanceDelivery> {
  const ws = store.getWorkspace(wsId);
  if (!ws) return 'failed';
  // Admission: a Relance of a SLEEPING fleet member is a start — held under low memory, released (coordinators first, one at a time) by re-entering the sweep.
  if (await wakeHeldForMemory(ws, retry, { site })) return 'held';
  return (await sdkStartAndDeliver(wsId, text)) ? 'sent' : 'failed';
}

const deliver = (wsId: string, text: string): Promise<RelanceDelivery> => deliverRelance(wsId, text, 'relance', () => sweepRelanceNow(productionRelanceDeps));

export const productionRelanceDeps: RelanceDeps = {
  now: () => Date.now(),
  members: () => relanceMembers(roster),
  member: (wsId) => relanceMember(roster, wsId),
  census: (wsId) => censusReliquatsOf(wsId),
  deliver,
};

/** `ORCHESTRA_RELANCE=0` turns the mechanism off (never started). */
export function startRelanceHost(): void {
  if (!relanceEnabled(process.env)) {
    log.info('relance: disabled by ORCHESTRA_RELANCE=0');
    return;
  }
  startRelance(productionRelanceDeps);
}

export { stopRelance };
