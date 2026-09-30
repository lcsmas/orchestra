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

// F6 (review D1a): a pause the CLI wrote is NOT enforced while the boot bus is unavailable (fail-open on purpose — fail-closed would freeze
// every agent behind a broken bus). Say so ONCE per process instead of per gate read.
let warnedNoBus = false;
const realDeps: PauseGateDeps = {
  getWorkspace: (id) => store.getWorkspace(id),
  getBus,
  warn: (m, e) => log.warn(m, e),
  onBusUnavailable: () => {
    if (warnedNoBus) return;
    warnedNoBus = true;
    log.warn('pause gate: the bus is UNAVAILABLE — a fleet Pause written by the CLI is NOT enforced by the host (fail-open by design; see bus.md §Fleet PAUSE)');
  },
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

// D1b seam (host trap): it observes every HUMAN-origin turn so a turn that starts on a paused member WITHOUT a fresh human mark is
// interrupted. Registered by the trap at init; sdkSend calls `notePauseHumanTurn` once per HUMAN send (composer, Send now, tray release,
// toolbar retry, the brief claimed by a human send). A throwing observer never breaks a send.
let humanTurnObserver: ((wsId: string) => void) | null = null;

export function setPauseHumanTurnObserver(fn: ((wsId: string) => void) | null): void {
  humanTurnObserver = fn;
}

export function notePauseHumanTurn(wsId: string): void {
  try {
    humanTurnObserver?.(wsId);
  } catch (e) {
    log.warn('pause gate: human-turn observer threw', e);
  }
}
