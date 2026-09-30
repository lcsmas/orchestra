// Fleet PAUSE — the ONE "is this workspace paused" helper every GATE and SILENCE site asks
// (#252, ADR 0003, wave D ledger #261 D5). The twin of `sandboxPausedMessage` (#226): same
// shape (`string | null` — the refusal, or null when the start may proceed), same placement
// (BEFORE the start effect).
//
// The workspace's run is resolved at GATE TIME (`nearestOrchestratorId` over the live store —
// the same walk as `resolveWaveRunId`, never `$ORCHESTRA_RUN_ID`), then `activePauseFor` walks
// `parent_run_id` to the carrier and reads ITS frozen `pause` switch. Unknown ⇒ NOT paused
// (no bus, no run row, an unreadable read — logged): the coexistence-safe direction.

import { store } from './store.ts';
import { getBus, type BusDb } from './bus.ts';
import { activePauseFor, effectivePausedRunIds } from './bus-pause.ts';
import { nearestOrchestratorId, type WaveNode } from './wave-run-id.ts';
import { log } from './logger.ts';
import { pauseGateDecision, type PauseOrigin } from '../shared/bus-pause.ts';

/** Seams so the decision runs over a real bus + a fake workspace map without the Electron store. */
export interface PauseGateDeps {
  getWorkspace: (id: string) => WaveNode | undefined;
  getBus: () => BusDb | null;
  warn?: (msg: string, err?: unknown) => void;
}

/** The decision over injected deps (the unit suite drives THIS; production binds the store). */
export function pauseRefusalWith(
  deps: PauseGateDeps,
  ws: WaveNode | null | undefined,
  origin: PauseOrigin,
): string | null {
  if (origin === 'human') return null; // HUMAN rows: allowed, un-pause nothing — never even read
  if (!ws) return null;
  try {
    const db = deps.getBus();
    if (!db) return null;
    const runId = nearestOrchestratorId(ws, deps.getWorkspace);
    return pauseGateDecision(origin, activePauseFor(db, runId));
  } catch (e) {
    deps.warn?.('pause gate: unreadable — treating as NOT paused', e);
    return null;
  }
}

const realDeps: PauseGateDeps = {
  getWorkspace: (id) => store.getWorkspace(id),
  getBus,
  warn: (m, e) => log.warn(m, e),
};

/** The refusal for `ws` (`run en pause — orchestra run resume --run <id>`), or null when a start
 *  may proceed. `origin: 'human'` is never refused. */
export function pauseRefusal(
  ws: WaveNode | null | undefined,
  origin: PauseOrigin = 'auto',
): string | null {
  return pauseRefusalWith(realDeps, ws, origin);
}

/** {@link pauseRefusal} by workspace id (an unknown id is not paused). */
export function pauseRefusalById(
  wsId: string | null | undefined,
  origin: PauseOrigin = 'auto',
): string | null {
  return wsId ? pauseRefusal(store.getWorkspace(wsId), origin) : null;
}

/** Every run the pause currently covers (carriers + descendants) — the liveness SILENCE seam.
 *  Unreadable / no bus ⇒ the empty set (over-escalating beats a phantom silence). */
export function pausedRunIdsSafe(db: BusDb | null): Set<string> {
  if (!db) return new Set();
  try {
    return effectivePausedRunIds(db);
  } catch (e) {
    log.warn('pause gate: paused-run read failed — silencing nothing', e);
    return new Set();
  }
}
