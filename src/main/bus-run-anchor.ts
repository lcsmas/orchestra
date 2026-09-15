// Start (and freeze) the bus RUN at the wave anchor = the NEAREST ORCHESTRATOR
// (#134, LEAD ruling D1, ledger #135).
//
// THE GAP #134 CLOSES: `startRun` (bus-runs.ts) had zero production callers, so
// no `runs` row was ever created, every `busSwitch(runId, …)` read all-OFF, and
// the #118 freeze was satisfied vacuously.
//
// D1 MODEL: a workspace's run is its nearest orchestrator (an OPS/LEAD is its
// own run; a member obeys the OPS's). The run row is created:
//   - when an orchestrator launches (anchor === itself), and
//   - LAZILY, when a MEMBER launches under a pre-existing orchestrator whose row
//     does not exist yet (a LEAD promoted before this ticket shipped, or an OPS
//     promoted with no relaunch). The row is only a parent pointer + frozen
//     flags for its own members, so a late mission row is not a late freeze of
//     anything that governs those members.
// `parent_run_id` = the ANCHOR's parent orchestrator (nested LEAD→OPS = two rows).
//
// Platform-free (collaborators injected) so the integration test drives the REAL
// function against a real SQLite bus, never a re-implementation — `workspaces.ts`
// (`./store`/`./platform`) cannot load under `node --test`.
//
// D1 (LEAD, ledger #123): the bus NEVER blocks a spawn. `getBus()` may be null,
// `startRun` may throw on a corrupt DB — every failure is a LOG LINE, never a
// throw into the launch path.

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
  /** Does a run row already exist for this id? (skip the INSERT if so.) */
  getRun: (db: BusDb, runId: string) => BusRunRow | null;
  /** RE-FREEZE a MISSION run's flags at a wave boundary (#134 D1b). No-op unless
   *  the run is a mission. Fired ONLY when a NEW nested (OPS) run is created, so
   *  the LEAD's plain children track the latest flip; never on member spawn. */
  refreezeRun: (db: BusDb, runId: string, liveSwitches: BusSwitches) => boolean;
  /** The live switch set to freeze onto a NEW run row. */
  getLiveSwitches: () => BusSwitches;
  /** Structured log for the D1 best-effort failure line. */
  warn: (msg: string, err?: unknown) => void;
}

/** What the caller resolved about the launching workspace's anchor. */
export interface AnchorInfo {
  /** The launching workspace's id. */
  wsId: string;
  /** The nearest-orchestrator run id the workspace belongs to (resolveWaveRunId). */
  anchorId: string;
  /** True iff the ANCHOR workspace is a real orchestrator (canOrchestrate). A
   *  plain standalone workspace resolves anchorId === wsId WITHOUT being an
   *  orchestrator — those get NO run row here (they are shadow until adopted). */
  anchorIsOrchestrator: boolean;
  /** The anchor's own parent orchestrator run id (nested-run pointer), or null. */
  parentRunId: string | null;
}

/**
 * Ensure the anchor's run row exists (idempotent, best-effort). Returns the row
 * that now exists (frozen), or null when there is nothing to start / the bus was
 * down / the call failed (D1).
 *
 * Only a real ORCHESTRATOR anchor gets a row (D1: "startRun fires when a
 * workspace becomes an orchestrator"). This is called on EVERY launch:
 *   - orchestrator launches → `anchorId === wsId` and `anchorIsOrchestrator` →
 *     its own row is created;
 *   - member launches → `anchorId` is its OPS; if the OPS row is missing it is
 *     created LAZILY here.
 * A plain standalone workspace (anchorId === wsId but NOT an orchestrator) is
 * deliberately skipped — it has no wave to freeze and inventing a row would
 * populate the pane with spurious runs.
 *
 * `startRun` is INSERT-OR-IGNORE keyed on the `runs` row existence (#123 F1), so
 * calling this on every launch is idempotent and never re-freezes a running run.
 */
export function maybeStartRunAtAnchor(deps: BusRunAnchorDeps, anchor: AnchorInfo): BusRunRow | null {
  if (!anchor.anchorIsOrchestrator) return null; // no wave to freeze
  try {
    const db = deps.getBus();
    if (!db) return null; // D1: no bus → the run reads all-OFF, spawn proceeds
    // Cheap idempotence: skip the INSERT entirely when the row already exists,
    // so the common case (every relaunch/member-spawn of a live wave) is a pure
    // read. startRun is itself INSERT-OR-IGNORE, so this is an optimization, not
    // a correctness gate.
    const existing = deps.getRun(db, anchor.anchorId);
    if (existing) return existing;
    // A top-level orchestrator (no parent orchestrator) is a MISSION; a nested
    // one (an OPS under a LEAD) is a VAGUE. The kind is what `refreezeRun` gates
    // on — only mission rows are ever re-frozen (D1b).
    const kind = anchor.parentRunId === null ? 'mission' : 'vague';
    const row = deps.startRun(
      db,
      {
        id: anchor.anchorId,
        kind,
        coordinator: anchor.anchorId,
        parentRunId: anchor.parentRunId,
      },
      deps.getLiveSwitches(),
    );
    // D1b — WAVE BOUNDARY: a NEW nested (OPS) run just started, so re-freeze its
    // parent MISSION row to the current live switches. `refreezeRun` is a no-op
    // unless the parent is a mission, and it touches ONLY the mission row — the
    // OPS/member rows are never re-frozen (F1). Fired here (new-nested-run only),
    // never on a member spawn that merely READS an existing OPS row.
    if (anchor.parentRunId) {
      try {
        deps.refreezeRun(db, anchor.parentRunId, deps.getLiveSwitches());
      } catch (e) {
        deps.warn(`bus-run-anchor: mission re-freeze for ${anchor.parentRunId} failed`, e);
      }
    }
    return row;
  } catch (err) {
    // D1: a bus failure must never throw into the launch path.
    deps.warn(
      `bus-run-anchor: could not start run ${anchor.anchorId} — spawn proceeds all-OFF`,
      err,
    );
    return null;
  }
}
