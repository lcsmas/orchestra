// Vague endormie (#428) — production wiring of the sweep (vague-endormie.ts): the roster from the store + bus, the kernel-scope census, and delivery through the SAME function a member's Relance uses
// (`deliverRelance`: Admission, then `sdkStartAndDeliver` — a coordinator in Veille is lazy-started and its conversation resumed). Not importable under plain node --test (store / platform seam):
// vague-endormie-wiring.test.ts pins it by source; the real path is the session-budget rig `scripts/session-budget/vague-endormie.mjs`.

import { getBus } from './bus.ts';
import { readReleasedReaders } from './bus-liveness.ts';
import { readWaitingReaders } from './bus-wake.ts';
import { heldRunIds } from './bus-runs.ts';
import { livenessSilencedByAdmission } from './admission';
import { idleClockOf } from './idle-clock.ts';
import { log } from './logger.ts';
import { pauseRefusal } from './pause-gate';
import { store } from './store';
import { resolveWaveRunId } from './workspaces';
import { censusReliquatsOf } from './relance-census.ts';
import { deliverRelance } from './relance-host.ts';
import { relanceEnabled } from './relance-roster.ts';
import { startVagueEndormie, stopVagueEndormie, sweepVaguesNow, type VagueDeps } from './vague-endormie.ts';
import { vagueFacts, vagueFactsOf, type VagueRosterDeps } from './vague-roster.ts';

const busOrThrow = () => {
  const db = getBus();
  if (!db) throw new Error('no bus');
  return db;
};

const roster: VagueRosterDeps = {
  workspaces: () => store.workspaces,
  getWorkspace: (id) => store.getWorkspace(id),
  runIdOf: (ws) => resolveWaveRunId(ws),
  released: (readers) => readReleasedReaders(busOrThrow(), readers),
  busWaiting: (readers) => readWaitingReaders(busOrThrow(), readers),
  paused: (ws) => pauseRefusal(ws, 'auto') !== null,
  heldStart: (ws) => livenessSilencedByAdmission(ws.id),
  heldRuns: () => heldRunIds(busOrThrow()),
  lastActivityAt: (ws) => idleClockOf(ws),
};

export const productionVagueDeps: VagueDeps = {
  now: () => Date.now(),
  vagues: () => vagueFacts(roster),
  vague: (runId) => vagueFactsOf(roster, runId),
  census: (wsId) => censusReliquatsOf(wsId),
  deliver: (coordinatorId, text) => deliverRelance(coordinatorId, text, 'relance-vague', () => sweepVaguesNow(productionVagueDeps)),
};

/** `ORCHESTRA_RELANCE=0` (the Relance family's kill switch) = never started. */
export function startVagueEndormieHost(): void {
  if (!relanceEnabled(process.env)) {
    log.info('vague-endormie: disabled by ORCHESTRA_RELANCE=0');
    return;
  }
  startVagueEndormie(productionVagueDeps);
}

export { stopVagueEndormie };
