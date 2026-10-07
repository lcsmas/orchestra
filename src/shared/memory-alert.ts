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
  /** Containers no workspace owns (#293): created during a live run without the stamp, or stamped for a deleted workspace. The LAST resource-monitor tick's count. */
  unattributedContainers: number;
  /** additive (#293, FI-3 v1.1): the container accounting's state — anything but 'ok' means the count was NOT measured and the row says why instead of printing "0". Absent = 'ok'. */
  unattributedDocker?: 'ok' | 'unavailable' | 'error' | 'not-sampled' | 'stale';
  /** additive (#293): daemons that did not answer the last pass — the count is then a lower bound. */
  unattributedDaemonsDown?: number;
  /** The guard now. */
  nowAvailBytes: number | null;
  /** The EFFECTIVE state, never the guard's raw flags: Admission is holding starts now (`isAdmissionHolding`: toggle ON and held). */
  nowAdmissionHeld: boolean;
  /** At least one run IS under the memory Pause now (the bus says so) — not "the guard is below critical". */
  nowPause: boolean;
  /** Runs the memory Pause could pause right now (`pause` switch ON, live local fleet, topmost) — 0 means a critical crossing will pause NOTHING. */
  eligibleRuns: number;
  /** Admission's global toggle (`false`: the guard measures and decides, nothing is actually held). */
  admissionEnabled: boolean;
  admissionBytes: number;
  criticalBytes: number;
  releaseMarginBytes: number;
  /** Epoch ms the row is written. */
  at: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The unattributed-container clause: the count only when Docker WAS measured; otherwise the reason it was not (never "0"). */
function unattributedPhrase(f: Pick<AlertFacts, 'unattributedContainers' | 'unattributedDocker' | 'unattributedDaemonsDown'>): string {
  switch (f.unattributedDocker ?? 'ok') {
    case 'unavailable': return 'unattributed containers not measured (Docker unreachable)';
    case 'error': return 'unattributed containers not measured (the Docker query failed)';
    case 'not-sampled': return 'unattributed containers not measured yet (no monitor tick since the app started)';
    case 'stale': return 'unattributed containers not measured (the last Docker pass is too old)';
    default: return `${f.unattributedContainers} unattributed container(s)${(f.unattributedDaemonsDown ?? 0) > 0 ? ` (at least — ${f.unattributedDaemonsDown} Docker daemon(s) did not answer)` : ''}`;
  }
}

/** The text of the ONE escalation row: which thresholds were crossed and at what MemAvailable, what the host did, where it stands now, what to expect. English like every host row. */
export function memoryAlertBody(ep: AlertEpisode, f: AlertFacts): string {
  const crossed =
    `MemAvailable fell below the Admission threshold (${formatGb(ep.admission.thresholdBytes, 2)}) at ${formatGb(ep.admission.availBytes, 2)}` +
    (ep.critical ? ` and below the CRITICAL threshold (${formatGb(ep.critical.thresholdBytes, 2)}) at ${formatGb(ep.critical.availBytes, 2)}` : '');
  const reopen = f.admissionBytes + f.releaseMarginBytes;
  const held = f.admissionEnabled ? `${f.heldStarts} automatic fleet start(s) HELD (released coordinators first, one at a time, on a fresh reading, once MemAvailable is above ${formatGb(reopen, 2)})` : 'automatic starts NOT held (the Admission toggle is OFF — the guard only measures)';
  const paused = f.pausedRuns.length > 0 ? `memory Pause on run(s) ${f.pausedRuns.join(', ')} (lifted by the host above ${formatGb(f.admissionBytes, 2)})` : 'no run under the memory Pause';
  const now = `MemAvailable ${f.nowAvailBytes === null ? 'unreadable' : formatGb(f.nowAvailBytes, 2)} · Admission ${f.nowAdmissionHeld ? 'HELD' : !f.admissionEnabled ? 'OFF (toggle)' : 'open'} · memory Pause ${f.nowPause ? 'IN EFFECT' : 'none'}`;
  const next =
    ep.critical
      ? ''
      : f.eligibleRuns > 0
        ? ` If MemAvailable falls below the CRITICAL threshold (${formatGb(f.criticalBytes, 2)}) the host puts the eligible runs under the memory Pause WITHOUT another row for this episode — read the app banner / \`orchestra run status\`.`
        : ` NO run is eligible for the memory Pause (every \`pause\` switch is OFF or no live local fleet): if MemAvailable falls below the CRITICAL threshold (${formatGb(f.criticalBytes, 2)}) the host will pause NOTHING and write NO further row for this episode — watch \`orchestra run status\` and pause the fleet yourself (\`orchestra run pause --hard --run <id>\`).`;
  const anyPaused = f.pausedRuns.length > 0;
  const closing =
    ep.critical && !anyPaused && ep.endedAt === null
      ? 'ACT YOURSELF: the CRITICAL threshold was crossed and NO run is under the memory Pause now (none eligible — `pause` switch OFF, no live local fleet — a human / usage-limit pause already holds it, or its Reprise has begun): the host has NOT stopped the fleet itself. Check `orchestra run status`; if it is still running at critical memory, pause it (`orchestra run pause --hard --run <id>`).'
      : ep.endedAt !== null
        ? `${anyPaused ? 'You need not act: the host lifts its own memory Pause by itself. A run under the memory Pause reads this row after its Reprise (a paused coordinator is not woken).' : 'You need not act: the episode is over.'}`
        : `${!f.admissionEnabled && !anyPaused ? 'Nothing for the host to release (the Admission toggle is OFF and no run is paused).' : `You need not act: the host ${[f.admissionEnabled ? 'releases the held starts' : null, anyPaused ? 'lifts its own memory Pause' : null].filter(Boolean).join(' and ')} by itself once memory recovers.`} A run under the memory Pause reads this row after its Reprise (a paused coordinator is not woken).${next}`;
  const over = ep.endedAt !== null ? ` The episode is already OVER (memory back above ${formatGb(reopen, 2)} at ${iso(ep.endedAt)}).` : '';
  return [
    `Memory guard — episode ${ep.episode} (since ${iso(ep.admission.at)}): ${crossed}.`,
    `Host actions so far: ${held} · ${f.veille} member(s) put in Veille since the crossing · ${paused} · ${unattributedPhrase(f)}.`,
    `Now (${iso(f.at)}): ${now}.${over}`,
    closing,
  ].join('\n');
}
