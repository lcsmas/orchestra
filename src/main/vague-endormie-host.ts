// Vague endormie (#428) — production wiring of the sweep (vague-endormie.ts): the roster from the store + bus, the kernel-scope census, and delivery through the SAME function a member's Relance uses
// (`deliverRelance`: Admission, then `sdkStartAndDeliver` — a coordinator in Veille is lazy-started and its conversation resumed). Not importable under plain node --test (store / platform seam):
// vague-endormie-wiring.test.ts pins it by source; the real path is the session-budget rig `scripts/session-budget/vague-endormie.mjs`.

import path from 'node:path';
import { getBus } from './bus.ts';
import { orchestraHome } from './platform/index.ts';
import { readReleasedReaders } from './bus-liveness.ts';
import { readWaitingReaders } from './bus-wake.ts';
import { heldRunIds } from './bus-runs.ts';
import { idleClockOf, seenThisRun } from './idle-clock.ts';
import { sdkHasBackgroundTasks } from './sdk-delivery';
import { wakeRosterEntry } from './wake-roster';
import { log } from './logger.ts';
import { pauseRefusal } from './pause-gate';
import { store } from './store';
import { resolveWaveRunId } from './workspaces';
import { censusReliquatsOf } from './relance-census.ts';
import { deliverRelance } from './relance-host.ts';
import { relanceEnabled } from './relance-roster.ts';
import { createVagueFileStore } from './vague-endormie-store.ts';
import { startVagueEndormie, stopVagueEndormie, sweepVaguesNow, type VagueDeps } from './vague-endormie.ts';
import { vagueFacts, vagueFactsOf, type VagueRosterDeps } from './vague-roster.ts';

const busOrThrow = () => {
  const db = getBus();
  if (!db) throw new Error('no bus');
  return db;
};

/** Admission's « this start is held » predicate, injected by index.ts (the one importer of Admission besides the start gates — admission-wiring.test.ts enumerates them). */
let heldStartOf: (wsId: string) => boolean = () => false;

const roster: VagueRosterDeps = {
  workspaces: () => store.workspaces,
  getWorkspace: (id) => store.getWorkspace(id),
  runIdOf: (ws) => resolveWaveRunId(ws),
  released: (readers) => readReleasedReaders(busOrThrow(), readers),
  busWaiting: (readers) => readWaitingReaders(busOrThrow(), readers),
  paused: (ws) => pauseRefusal(ws, 'auto') !== null,
  heldStart: (ws) => heldStartOf(ws.id),
  heldRuns: () => heldRunIds(busOrThrow()),
  lastActivityAt: (ws) => idleClockOf(ws),
  seenThisRun: (ws) => seenThisRun(ws.id),
  backgroundTask: (ws) => sdkHasBackgroundTasks(ws.id),
  wakeable: (ws) => wakeRosterEntry(ws).wakeable,
};

export const productionVagueDeps: VagueDeps = {
  now: () => Date.now(),
  vagues: () => vagueFacts(roster),
  vague: (runId) => vagueFactsOf(roster, runId),
  census: (wsId) => censusReliquatsOf(wsId),
  // an absent / corrupt store.json falls back to EMPTY defaults: the roster is then NOT the fleet — same gate as every other destructive pass of the app (index.ts `store.loadedFromDisk`)
  rosterTrusted: () => store.loadedFromDisk,
  persist: createVagueFileStore(() => path.join(orchestraHome(), 'vague-endormie.json')),
  deliver: (coordinatorId, text) => deliverRelance(coordinatorId, text, 'relance-vague', () => sweepVaguesNow(productionVagueDeps)),
};

/** `ORCHESTRA_RELANCE=0` (the Relance family's kill switch) = never started. */
export function startVagueEndormieHost(opts: { heldStart: (wsId: string) => boolean }): void {
  if (!relanceEnabled(process.env)) {
    log.info('vague-endormie: disabled by ORCHESTRA_RELANCE=0');
    return;
  }
  heldStartOf = opts.heldStart;
  startVagueEndormie(productionVagueDeps);
}

export { stopVagueEndormie };
