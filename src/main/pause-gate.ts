// Fleet PAUSE — the ONE "is this workspace paused" helper every GATE site asks (#252, ADR 0003,
// wave D ledger #261 D5). The twin of `sandboxPausedMessage` (#226): same shape (`string | null` —
// the refusal, or null when the start may proceed), same placement (BEFORE the start effect).
// The decision itself is `pauseRefusalWith` (src/main/bus-pause.ts — importable without Electron);
// this file only binds the real store + boot bus connection.

import { store } from './store.ts';
import { getBus } from './bus.ts';
import { pauseRefusalWith, type PauseGateDeps } from './bus-pause.ts';
import { log } from './logger.ts';
import type { WaveNode } from './wave-run-id.ts';
import type { PauseOrigin } from '../shared/bus-pause.ts';

const realDeps: PauseGateDeps = {
  getWorkspace: (id) => store.getWorkspace(id),
  getBus,
  warn: (m, e) => log.warn(m, e),
};

/** The refusal for `ws`, or null when a start may proceed. `origin: 'human'` is never refused. */
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
