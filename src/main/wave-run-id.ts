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
// PURE and dependency-free ON PURPOSE (only `import type` + the pure
// `canOrchestrate` from types.ts): `workspaces.ts` imports the Electron platform
// seam and cannot load under `node --test`, so the walk lives here with the
// store injected as a lookup, and its arms (the promoted-worktree capability, a
// scratch orchestrator kind, the broken link, the cycle) run as plain unit tests.

import { canOrchestrate } from '../shared/types.ts';

/** The minimal workspace shape the walks need: id, optional parent, and the two
 *  fields `canOrchestrate()` reads (kind + the capability flag). */
export interface WaveNode {
  id: string;
  parentId?: string;
  kind?: string;
  canOrchestrate?: boolean;
}

/** `canOrchestrate` over the minimal node shape — an orchestrator is the KIND
 *  `'orchestrator'` OR the capability flag (a PROMOTED worktree), never the kind
 *  alone (D1: an OPS is a promoted worktree carrying the flag). */
function nodeOrchestrates(n: WaveNode): boolean {
  return canOrchestrate({ kind: n.kind as never, canOrchestrate: n.canOrchestrate });
}

/**
 * The run id a workspace belongs to = the NEAREST orchestrator at or above it.
 *
 * Itself if it is an orchestrator (an OPS/LEAD is its own run); else walk
 * `parentId` up to the first ancestor that `canOrchestrate`. A plain workspace
 * with NO orchestrator anywhere above it is its own run (a bare `orchestra spawn
 * --detached` with no coordinator) — the coexistence-safe fallback, matching the
 * design guardrail "a workspace with no anchor above it is its own run".
 *
 * @param lookup resolves a parent id to its node, or undefined for a broken/
 *   absent link (a dangling `parentId` after a delete) — the walk then stops at
 *   the deepest resolvable node and returns the nearest orchestrator found so
 *   far, else that node's own id. Never throws; a cycle is bounded by `seen`.
 */
export function nearestOrchestratorId(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
): string {
  let cur: WaveNode = ws;
  const seen = new Set<string>([cur.id]);
  // The workspace itself, then each resolvable ancestor: the FIRST orchestrator
  // is the run. Checking `cur` first is what makes "self if it orchestrates" hold.
  for (;;) {
    if (nodeOrchestrates(cur)) return cur.id;
    if (!cur.parentId) break;
    const parent = lookup(cur.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  // No orchestrator at or above `ws` (or a broken link before one was found):
  // `ws` is its own run. NOT the deepest ancestor — a plain member whose whole
  // chain is non-orchestrators is a standalone run, and using an arbitrary
  // ancestor would put unrelated members in one run.
  return ws.id;
}

/**
 * For a workspace that BECOMES an orchestrator, the run id of its PARENT
 * orchestrator (the nested-run pointer, `parent_run_id`) — or null if it is a
 * top-level orchestrator (a LEAD with no orchestrator above it).
 *
 * Walk STARTS at `ws.parentId` (never `ws` itself — `ws` is the new orchestrator
 * whose own row we are creating), and returns the first ancestor that
 * `canOrchestrate`. This is what makes LEAD→OPS two rows with the OPS's
 * `parent_run_id` = the LEAD's run id.
 */
export function parentOrchestratorId(
  ws: WaveNode,
  lookup: (id: string) => WaveNode | undefined,
): string | null {
  if (!ws.parentId) return null;
  const seen = new Set<string>([ws.id]);
  let cur = lookup(ws.parentId);
  while (cur && !seen.has(cur.id)) {
    if (nodeOrchestrates(cur)) return cur.id;
    seen.add(cur.id);
    if (!cur.parentId) break;
    cur = lookup(cur.parentId);
  }
  return null;
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
