// The LIVE per-mechanism switches: where they are stored, and the one cache
// that must never leak into a running run (#118, ledger #123).
//
// Two readers with very different rules:
//
//   getLiveSwitches()  — what the settings UI edits and what a NEW run freezes.
//                        Reads the store. May change at any moment.
//   bus-runs.runFlags() — what a RUNNING run obeys. Reads the run row. Frozen.
//
// Keeping them in separate modules with separate names is deliberate: the
// mutant C10 asks for ("read the flags live instead of from the run row") is
// then a visible substitution of one call for the other, not a subtle argument
// change.

import { store } from './store.ts';
import { type BusSwitches, liveSwitchesFromStore, saveLiveSwitches } from '../shared/bus-switches.ts';

/**
 * The live switch values from the app store, defaulted per-mechanism.
 *
 * Synchronous, because both the startup-notice generator and the freeze run
 * inside code paths that cannot await. `store` keeps an in-memory copy loaded
 * at boot, so this is a plain object read.
 */
export function getLiveSwitches(): BusSwitches {
  // A reader that THROWS must not turn every mechanism ON: all-OFF is the coexistence-safe direction (liveSwitchesFromStore). A store.json that fails to PARSE never reaches here as an error — store.ts loads it EMPTY, so the live defaults apply.
  return liveSwitchesFromStore(() => store.getBusSwitches());
}

/**
 * Persist a new live switch set.
 *
 * NOTE what this does NOT do: it does not touch any existing run row. That is
 * the freeze — a flip lands here and is picked up by the next `startRun`, never
 * by a run already in flight. If you find yourself wanting to "propagate" a
 * flip to running runs, that is T118.2's disproof, not a feature.
 */
export async function setLiveSwitches(next: Partial<BusSwitches>): Promise<BusSwitches> {
  // Only the keys the human has ever set are persisted (saveLiveSwitches / mergeExplicitSwitches): an unset key keeps following its live default (#324 review m3).
  return saveLiveSwitches(() => store.getBusSwitches(), (explicit) => store.setBusSwitches(explicit), next);
}
