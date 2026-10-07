// Memory guard ALERT to the LEAD (#289, epic #284 "Visibility", wave G ledger #295 FI-2) — the PURE half: the episode ledger and the text of the ONE `escalation` row per memory episode.
// Impure halves: src/main/memory-alert.ts (bus, Electron-free) + src/main/memory-alert-host.ts (store, guard, admission).
//
// ONE alert per Admission `episode` (the guard counts downward crossings of the Admission threshold; oscillation inside the hysteresis band is the SAME episode). A critical crossing inside the episode
// (a memory Pause cycle) is NOT a new alert: the alert names every threshold crossed by the time it is sent. A short SETTLE window after the crossing lets the host's own actions (starts held,
// members put in Veille, runs paused) show before the row is written; an episode that ends first is told when it ends.

import { formatGb } from './memory-guard.ts';

/** How long after the crossing the alert waits so "the actions taken" are not all zero: two fast samples (the guard samples every 10 s below the Admission threshold). */
export const ALERT_SETTLE_MS = 20_000;

/** The sender of every host-written escalation row (the Pause / Reprise hold use the same). */
export const ALERT_SENDER = 'host';

export interface CrossedThreshold {
  /** Epoch ms of the crossing (the guard's own clock edge). */
  at: number;
  availBytes: number;
  thresholdBytes: number;
}

/** What the guard went through since the episode began. */
export interface AlertEpisode {
  episode: number;
  /** The Admission crossing (always present: an episode IS a crossing of the Admission threshold). */
  admission: CrossedThreshold;
  /** The CRITICAL crossing(s): the first one, and how many memory-Pause cycles the guard counted in this episode. */
  critical: (CrossedThreshold & { pauseCycle: number }) | null;
  pauseCycles: number;
  /** Epoch ms the episode ended (Admission reopened), null while it lasts. */
  endedAt: number | null;
}

/** The host's actions + the live state at the moment the row is written. */
export interface AlertFacts {
  /** Automatic starts of fleet members currently HELD by Admission. */
  heldStarts: number;
  /** Fleet members put in Veille since the crossing. */
  veille: number;
  /** Runs under the memory Pause right now (ids). */
  pausedRuns: readonly string[];
  /** Containers no workspace owns (#293). 0 until that track lands — the field stays so the contract does not move. */
  unattributedContainers: number;
  /** The guard now. */
  nowAvailBytes: number | null;
  nowAdmissionHeld: boolean;
  nowPause: boolean;
  /** Admission's global toggle (`false`: the guard measures and decides, nothing is actually held). */
  admissionEnabled: boolean;
  admissionBytes: number;
  criticalBytes: number;
  releaseMarginBytes: number;
  /** Epoch ms the row is written. */
  at: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The text of the ONE escalation row: which thresholds were crossed and at what MemAvailable, what the host did, where it stands now, what to expect. English like every host row. */
export function memoryAlertBody(ep: AlertEpisode, f: AlertFacts): string {
  const crossed =
    `MemAvailable fell below the Admission threshold (${formatGb(ep.admission.thresholdBytes, 2)}) at ${formatGb(ep.admission.availBytes, 2)}` +
    (ep.critical ? ` and below the CRITICAL threshold (${formatGb(ep.critical.thresholdBytes, 2)}) at ${formatGb(ep.critical.availBytes, 2)}` : '');
  const reopen = f.admissionBytes + f.releaseMarginBytes;
  const held = f.admissionEnabled ? `${f.heldStarts} automatic fleet start(s) HELD (released coordinators first, one at a time, on a fresh reading, once MemAvailable is above ${formatGb(reopen, 2)})` : 'automatic starts NOT held (the Admission toggle is OFF — the guard only measures)';
  const paused = f.pausedRuns.length > 0 ? `memory Pause on run(s) ${f.pausedRuns.join(', ')} (lifted by the host above ${formatGb(f.admissionBytes, 2)})` : 'no run under the memory Pause';
  const now = `MemAvailable ${f.nowAvailBytes === null ? 'unreadable' : formatGb(f.nowAvailBytes, 2)} · Admission ${f.nowAdmissionHeld ? 'HELD' : 'open'} · memory Pause ${f.nowPause ? 'IN EFFECT' : 'none'}`;
  const next = ep.critical ? '' : ` If MemAvailable falls below the CRITICAL threshold (${formatGb(f.criticalBytes, 2)}) the host puts the eligible runs under the memory Pause WITHOUT another row for this episode — read the app banner / \`orchestra run status\`.`;
  const over = ep.endedAt !== null ? ` The episode is already OVER (memory back above ${formatGb(reopen, 2)} at ${iso(ep.endedAt)}).` : '';
  return [
    `Memory guard — episode ${ep.episode} (since ${iso(ep.admission.at)}): ${crossed}.`,
    `Host actions so far: ${held} · ${f.veille} member(s) put in Veille since the crossing · ${paused} · ${f.unattributedContainers} unattributed container(s) (not measured yet — #293).`,
    `Now (${iso(f.at)}): ${now}.${over}`,
    `You need not act: the host releases the held starts and lifts its own memory Pause by itself once memory recovers. A run under the memory Pause reads this row after its Reprise (a paused coordinator is not woken).${next}`,
  ].join('\n');
}
