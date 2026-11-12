// The bus RUN id for a workspace = its NEAREST ORCHESTRATOR at or above it
// (LEAD ruling D1, ledger #135 §Decisions — this OVERTURNED the earlier
// tree-root/walkToRootId model of #118 N2).
//
// WHY NOT THE TREE ROOT: the real topology is LEAD (tree root, long-lived,
// promoted) → OPS (promoted under the LEAD, one per wave) → members. With the
// tree root, EVERY wave resolves to the LEAD's run, so the switches would freeze
// ONCE for the LEAD's lifetime and never per wave — breaking the "read at WAVE
// start" granularity (#108 Q17) and making the canary's "flip → next wave"
// impossible. So the anchor is the NEAREST orchestrator: the OPS gets its own
// run, nested under the LEAD's via `parent_run_id`.
//
// #432 — the walks now live in `src/shared/run-position.ts` (the ONE module that decides run
// membership / coordination); the exports below are thin delegates kept for their callers and tests.
//
// PURE and dependency-free ON PURPOSE: `workspaces.ts` imports the Electron platform
// seam and cannot load under `node --test`, so the walk lives here with the
// store injected as a lookup, and its arms (the promoted-worktree capability, a
// scratch orchestrator kind, the broken link, the cycle) run as plain unit tests.

import {
  coordinates,
  isPlainOwnAnchor as isPlainOwnAnchorOf,
  parentRunOf,
  ancestorCoordinatorId,
  runIdOf,
  type RunNode,
} from '../shared/run-position.ts';

/** The minimal workspace shape the walks need (= {@link RunNode}). */
export type WaveNode = RunNode;

/** Does the node coordinate? Delegates to `coordinates`. */
export function nodeOrchestrates(n: WaveNode): boolean {
  return coordinates(n);
}

/** The run id a workspace belongs to = its nearest coordinator at or above it. Delegates to `runIdOf`. */
export function nearestOrchestratorId(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
): string {
  return runIdOf(ws, lookup);
}

/** The run id of a new orchestrator's PARENT coordinator (or, with `anchorsRun`, run anchor), or null. */
export function parentOrchestratorId(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
  anchorsRun?: (id: string) => boolean,
): string | null {
  return ancestorCoordinatorId(ws, lookup, anchorsRun);
}

/** #221 — a plain workspace that is its own run anchor. Delegates to run-position. */
export function isPlainOwnAnchor(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
): boolean {
  return isPlainOwnAnchorOf(ws, lookup);
}

/** #221 — the parent run for a NEW orchestrator. Delegates to `parentRunOf`. */
export function parentRunTarget(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
  anchorsRun: (id: string) => boolean,
): { id: string | null; implicit: boolean } {
  return parentRunOf(ws, lookup, anchorsRun);
}

/**
 * Walk `parentId` up to the topmost RESOLVABLE ancestor and return its id (the
 * OLD tree-root model). RETAINED only for any caller that still needs the tree
 * root; the bus RUN anchor is `nearestOrchestratorId` now (D1). Do NOT use this
 * for run identity — it puts every wave on the LEAD's run.
 */
export function walkToRootId(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
): string {
  let cur: WaveNode = ws;
  const seen = new Set<string>([cur.id]);
  while (cur.parentId) {
    const parent = lookup(cur.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur.id;
}
