// Fleet PAUSE — the pure half (#252, ADR 0003, wave D ledger #261).
//
// A run is PAUSED when it (or an ANCESTOR run, via `runs.parent_run_id`) carries an active
// `paused_at` AND the CARRIER row's frozen `pause` switch is ON. Descendants carry no pause of
// their own: the gate walks up to the carrier at GATE TIME (never an env snapshot). The refusal
// text has ONE source (here) — the twin of `sandboxPausedMessage`.

/** Who is asking to start something. HUMAN origins (composer, toolbar Restart, terminal, "Send
 *  now", …) are ALLOWED while paused and un-pause nothing (ledger #261 D5); everything else is
 *  AUTO (réveil, spawn, usage-limit auto-resume, watchdog, inbox/queue drains, …). */
export type PauseOrigin = 'human' | 'auto';

/** What every refused start says. `runId` is the CARRIER (the run `orchestra run resume` lifts). */
export function pauseRefusalMessage(runId: string): string {
  return `run en pause — orchestra run resume --run ${runId}`;
}

/** One link of the chain `[run, ...ancestors]` the gate walks, nearest first. */
export interface PauseChainLink {
  runId: string;
  /** `runs.paused_at` — null/undefined = this row carries no pause. */
  pausedAt: number | null | undefined;
  /** THIS row's frozen `pause` switch (never the live store). */
  pauseSwitchOn: boolean;
}

/** The active pause a chain resolves to, or null. The NEAREST carrier wins; a carrier whose own
 *  frozen `pause` switch is OFF is not a pause at all (a stale column on a re-frozen run). */
export function activePauseInChain(
  chain: readonly PauseChainLink[],
): { runId: string; pausedAt: number } | null {
  for (const link of chain) {
    if (link.pausedAt !== null && link.pausedAt !== undefined && link.pauseSwitchOn) {
      return { runId: link.runId, pausedAt: Number(link.pausedAt) };
    }
  }
  return null;
}

/** THE DECISION every gate runs: the refusal text, or null when no pause governs. The HUMAN exemption
 *  lives in ONE place — `pauseRefusalWith` (src/main/bus-pause.ts) returns before reading the pause at all. */
export function pauseGateDecision(active: { runId: string } | null): string | null {
  return active ? pauseRefusalMessage(active.runId) : null;
}
