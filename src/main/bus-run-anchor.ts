// Start (and freeze) the bus RUN at the wave anchor (#134, ledger #135).
//
// THE GAP #134 CLOSES: `startRun` (bus-runs.ts) had zero production callers, so
// no `runs` row was ever created, every `busSwitch(runId, …)` read all-OFF, and
// the #118 freeze was satisfied vacuously. This module is the ONE production
// caller — invoked from `startAgentPty` on every launch — and it is deliberately
// platform-free (it takes its collaborators as arguments) so the integration
// test can drive the REAL function against a real SQLite bus, rather than
// re-implementing the anchor-start logic in the test. `workspaces.ts` imports
// `./store`/`./platform` and cannot be loaded under `node --test`; this can.
//
// D1 (LEAD, ledger #123): the bus NEVER blocks a spawn. `getBus()` may be null,
// `startRun` may throw on a corrupt DB — every failure is a LOG LINE, never a
// thrown error into the launch path. The spawn proceeds reading all-OFF.

import type { BusDb } from './bus.ts';
import type { BusRunRow } from './bus-runs.ts';
import type { BusSwitches } from '../shared/bus-switches.ts';

/** The collaborators the anchor-start needs, injected so a rig drives the real
 *  function without the Electron/store chain `workspaces.ts` drags in. */
export interface BusRunAnchorDeps {
  /** The boot bus, or null when it failed to open (D1). */
  getBus: () => BusDb | null;
  /** INSERT-OR-IGNORE the run row, freezing `liveSwitches` iff the row is new. */
  startRun: (
    db: BusDb,
    input: { id: string; kind: string; coordinator: string; parentRunId?: string | null },
    liveSwitches: BusSwitches,
  ) => BusRunRow;
  /** The live switch set to freeze onto a NEW run row. */
  getLiveSwitches: () => BusSwitches;
  /** Structured log for the D1 best-effort failure line. */
  warn: (msg: string, err?: unknown) => void;
}

/**
 * If `ws` is the wave ANCHOR, start its run (idempotent, best-effort).
 *
 * `anchorId` is `resolveWaveRunId(ws)` — the tree root. When it equals `ws.id`
 * this workspace IS the anchor and owns the run row; when it does not, `ws` is a
 * MEMBER that shares the anchor's already-started run and must NOT start one.
 *
 * `startRun` is INSERT-OR-IGNORE keyed on the `runs` row existence (#123 F1), so
 * calling this on EVERY launch (spawn/promote/resume) is idempotent and never
 * re-freezes a running run — the second call takes the ignore and writes no
 * flags. Returns the row that now exists (frozen), or null when it was a member,
 * the bus was down, or the call failed (D1).
 *
 * `parentRunId` is null: `walkToRootId` resolves to the TOPMOST ancestor, so an
 * anchor has no run above it (ledger #135 OQ1). If a future model makes nesting
 * expressible, this is the one line to change.
 */
export function maybeStartRunAtAnchor(
  deps: BusRunAnchorDeps,
  ws: { id: string },
  anchorId: string,
): BusRunRow | null {
  if (anchorId !== ws.id) return null; // a MEMBER — shares the anchor's run
  try {
    const db = deps.getBus();
    if (!db) return null; // D1: no bus → the run reads all-OFF, spawn proceeds
    return deps.startRun(
      db,
      { id: anchorId, kind: 'vague', coordinator: anchorId, parentRunId: null },
      deps.getLiveSwitches(),
    );
  } catch (err) {
    // D1: a bus failure must never throw into the launch path.
    deps.warn(`bus-run-anchor: could not start run ${anchorId} — spawn proceeds all-OFF`, err);
    return null;
  }
}
