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
//     does not exist yet (a LEAD of an older build, or an OPS
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
import { WAVE_REFREEZE_KEEPS_FROZEN, type BusMechanism, type BusSwitches } from '../shared/bus-switches.ts';
import { coordinates, coordinatorOf, isCoordinatorKind, isTopLevel, parentRunOf, runIdOf, type RunNode as WaveNode } from '../shared/run-position.ts';

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
  refreezeRun: (db: BusDb, runId: string, liveSwitches: BusSwitches, keepFrozen?: readonly BusMechanism[]) => boolean;
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
  /** True iff the ANCHOR workspace is a real orchestrator (it coordinates). A
   *  plain standalone workspace resolves anchorId === wsId WITHOUT being an
   *  orchestrator — those get NO run row here (they are shadow until adopted). */
  anchorIsOrchestrator: boolean;
  /** #433 — the anchor OWNS a run row: a real orchestrator, OR a top-level workspace (no resolvable
   *  parent) — its mission is born with it. A plain workspace that HAS a parent keeps no row here
   *  (it gets its run at its first spawn, #434). */
  anchorOwnsRun: boolean;
  /** The anchor's own parent run id (nested-run pointer), or null. */
  parentRunId: string | null;
  /** #221 — `parentRunId` names a run-less PLAIN workspace (not an orchestrator): start its
   *  mission row before the anchor's own. It never becomes an orchestrator. */
  parentRunImplicit?: boolean;
  /** #434 — the runs above the anchor whose row is missing, TOP-DOWN, each with its own parent pointer (a vague when it has one). */
  missingParentRuns?: Array<{ id: string; parentRunId: string | null }>;
}

/** "Does this workspace id anchor a run (a row exists)?" — best-effort like every bus
 *  read here: no bus / a throwing read is `false`, never a throw into the launch path. */
export function runAnchorProbe(deps: BusRunAnchorDeps): (id: string) => boolean {
  return (id) => {
    try {
      const db = deps.getBus();
      return !!db && deps.getRun(db, id) !== null;
    } catch {
      return false;
    }
  };
}

/** #433 — a workspace with no resolvable parent (none set, or a dangling link after a delete) is top-level: it owns a mission from birth. */
export function isParentless(ws: WaveNode, lookup: (id: string) => WaveNode | undefined): boolean {
  return isTopLevel(ws, lookup);
}

/**
 * Everything the anchor-start needs about a launching workspace (pure — the store
 * is the injected `lookup`, so a rig drives the REAL resolution, not a copy).
 * The anchor may be a DIFFERENT node than `ws` (a member's anchor is its OPS), so
 * `parentRunId` is computed from the ANCHOR node.
 */
export function computeAnchorInfo(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
  anchorsRunProbe?: (id: string) => boolean,
): AnchorInfo {
  const anchorsRun = anchorsRunProbe ?? (() => false);
  const anchorId = runIdOf(ws, lookup);
  const anchorNode = anchorId === ws.id ? ws : lookup(anchorId);
  const anchorIsOrchestrator = anchorNode ? coordinates(anchorNode) : false;
  // #221 — only a REAL orchestrator anchor nests; a plain standalone starts no row anyway.
  const parent =
    anchorNode && anchorIsOrchestrator
      ? parentRunOf(anchorNode, lookup, anchorsRun)
      : { id: null, implicit: false };
  // #434 — every run ABOVE the anchor (the runs it is a member of, up the direct-parent chain) must have a row, or `parent_run_id` dangles:
  // with the probe, each ancestor whose row is missing is started too (top-down, each with ITS OWN parent pointer: a vague when it has a
  // parent, a mission at the top). Without a probe only a non-owning direct parent counts (the #221 implicit parent).
  const missingParentRuns: Array<{ id: string; parentRunId: string | null }> = [];
  if (anchorNode && anchorIsOrchestrator) {
    const seen = new Set<string>([anchorNode.id]);
    for (let cur = coordinatorOf(anchorNode, lookup); cur && !seen.has(cur.id); cur = coordinatorOf(cur, lookup)) {
      seen.add(cur.id);
      const missing = anchorsRunProbe ? !anchorsRunProbe(cur.id) : !coordinates(cur);
      if (missing) missingParentRuns.unshift({ id: cur.id, parentRunId: coordinatorOf(cur, lookup)?.id ?? null });
    }
  }
  const implicit = parent.implicit || (!!parent.id && missingParentRuns.some((m) => m.id === parent.id));
  return {
    wsId: ws.id,
    anchorId,
    anchorIsOrchestrator,
    anchorOwnsRun: anchorIsOrchestrator || (anchorId === ws.id && isParentless(ws, lookup)),
    parentRunId: parent.id,
    ...(implicit ? { parentRunImplicit: true } : {}),
    ...(missingParentRuns.length > 0 ? { missingParentRuns } : {}),
  };
}

/**
 * #166 — the PURE gate deciding whether a coordinator-replacement launch should
 * BUMP the coordinator generation. Called ONLY from restart chokepoints (never a
 * first start), so this gate is the sole discriminator that a replacement is real
 * and safe to fence on. Platform-free so it is driven directly in tests (the
 * effect `maybeBumpCoordinatorOnReplacement` in workspaces.ts calls THIS).
 *
 * Bump IFF ALL hold:
 *  - `anchor.anchorIsOrchestrator` — the run belongs to a real coordinator;
 *  - `anchor.wsId === anchor.anchorId` — the launching ws IS that coordinator,
 *    not a member. A member's anchor is its OPS's run, so bumping on a member
 *    relaunch would fence the LIVE OPS's own writes (catastrophic over-bump);
 *  - `runRowExists` — a run row already exists for the anchor. `bumpCoordinator
 *    Generation` throws on a missing row, and a first-ever start has no old
 *    coordinator to fence (acceptance arm 1: first-start stays 0, respawn 0→1).
 */
export function shouldBumpCoordinatorGeneration(
  anchor: AnchorInfo,
  runRowExists: boolean,
): boolean {
  return anchor.anchorIsOrchestrator && anchor.wsId === anchor.anchorId && runRowExists;
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
  if (!anchor.anchorOwnsRun) return null; // a plain workspace WITH a parent: no run of its own yet (#434)
  try {
    const db = deps.getBus();
    if (!db) return null; // D1: no bus → the run reads all-OFF, spawn proceeds
    // Cheap idempotence: skip the INSERT entirely when the row already exists,
    // so the common case (every relaunch/member-spawn of a live wave) is a pure
    // read. startRun is itself INSERT-OR-IGNORE, so this is an optimization, not
    // a correctness gate.
    const existing = deps.getRun(db, anchor.anchorId);
    if (existing) return existing;
    // #221/#434 — a missing parent run (a run-less plain parent, or an owner whose row the bus lost) gets its row FIRST, top-down, so a failure
    // aborts before the child row — never a dangling parent_run_id.
    for (const m of anchor.missingParentRuns ?? (anchor.parentRunImplicit && anchor.parentRunId ? [{ id: anchor.parentRunId, parentRunId: null }] : [])) {
      deps.startRun(db, { id: m.id, kind: m.parentRunId ? 'vague' : 'mission', coordinator: m.id, parentRunId: m.parentRunId }, deps.getLiveSwitches());
    }
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
    // D1b — WAVE BOUNDARY: re-freeze the parent MISSION row to the current live
    // switches, so the LEAD's plain children track the latest flip. `refreezeRun`
    // is a no-op unless the parent is a mission, and touches ONLY the mission row
    // (the OPS/member rows are never re-frozen — F1).
    //
    // FIRED ONLY WHEN THE ANCHOR LAUNCHES ITSELF (`anchor.wsId === anchor.anchorId`)
    // — the true wave boundary (an OPS spawns-as / spawns its first agent). A MEMBER spawn
    // that LAZILY creates a missing OPS row (`wsId !== anchorId`) must NOT
    // re-freeze the mission: D1b says "re-freeze only at wave boundaries, never on
    // member spawn" (review-F1 F1 — the lazy path was re-freezing the mission on a
    // member spawn, at-most-once/wave but violating the invariant). The lazy path
    // still NESTS the OPS (its row + parent_run_id above); it just doesn't touch
    // the mission's frozen flags.
    if (anchor.parentRunId && anchor.wsId === anchor.anchorId) {
      try {
        // #324 (LEAD Q17 option A): the AUTOMATIC re-freeze leaves memoryCap as the mission froze it; only `orchestra run refreeze` applies the live value of that key
        deps.refreezeRun(db, anchor.parentRunId, deps.getLiveSwitches(), WAVE_REFREEZE_KEEPS_FROZEN);
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

/**
 * #433 — the app-start migration: every top-level workspace in `nodes` that has no run row gets its
 * mission (frozen from the live switches), nothing else. Returns the ids started. Touches no session
 * and never re-freezes a mission: only a PARENTLESS anchor is considered, so `parentRunId` is null
 * (the wave-boundary re-freeze fires on a nested anchor only). The caller filters archived / sandbox
 * workspaces out of `nodes`.
 */
export function startRunsForParentless(
  deps: BusRunAnchorDeps,
  nodes: readonly WaveNode[],
  lookup: (id: string) => WaveNode | undefined,
): string[] {
  const started: string[] = [];
  const probe = runAnchorProbe(deps);
  for (const ws of nodes) {
    if (!isParentless(ws, lookup) || probe(ws.id)) continue;
    const anchor = computeAnchorInfo(ws, lookup, probe);
    if (anchor.anchorId !== ws.id || !anchor.anchorOwnsRun) continue;
    if (maybeStartRunAtAnchor(deps, anchor)) started.push(ws.id);
  }
  return started;
}

/**
 * #434 — the app-start migration of the owners that HAVE a parent (a promoted OPS, a plain parent that already has children):
 * each live workspace that coordinates and whose run has no row gets its vague (parent_run_id = the run it is a member of),
 * PARENTS FIRST so the pointer never dangles. Returns the ids started. Never re-freezes a mission (same rule as the top-level pass).
 */
export function startRunsForOwners(
  deps: BusRunAnchorDeps,
  nodes: readonly WaveNode[],
  lookup: (id: string) => WaveNode | undefined,
): string[] {
  const depth = (ws: WaveNode): number => {
    let d = 0;
    const seen = new Set<string>([ws.id]);
    for (let cur: WaveNode | undefined = ws; cur?.parentId; ) {
      const p = lookup(cur.parentId);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      cur = p;
      d += 1;
    }
    return d;
  };
  const started: string[] = [];
  const probe = runAnchorProbe(deps);
  const owners = nodes.filter((ws) => !isParentless(ws, lookup) && coordinates(ws) && !probe(ws.id)).sort((a, b) => depth(a) - depth(b));
  for (const ws of owners) {
    const anchor = computeAnchorInfo(ws, lookup, probe);
    if (anchor.anchorId !== ws.id || !anchor.anchorOwnsRun) continue;
    if (maybeStartRunAtAnchor(deps, { ...anchor, wsId: ws.id })) started.push(ws.id);
  }
  return started;
}

/**
 * #434 — the parent that must START OWNING a run because `child` was just created under it (its first spawn): the resolved direct
 * parent when it is not marked as an owner yet, else null. PURE — `ensureParentOwnsRun` (workspaces.ts) persists `ownsRun` on what
 * this returns, and a rig drives this same decision to compose "spawn" without Electron.
 */
export function ownerToMark(child: WaveNode, lookup: (id: string) => WaveNode | undefined): WaveNode | null {
  const parent = coordinatorOf(child, lookup);
  return parent && parent.ownsRun !== true && !isCoordinatorKind(parent) ? parent : null; // run-position: non-run — the first-spawn ownership WRITE guard (is `ownsRun` recorded yet?)
}
