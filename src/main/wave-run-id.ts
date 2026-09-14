// The FREEZE run id for a workspace = its WAVE ANCHOR, the tree ROOT
// (#118 N2/Q-B2, ledger #123).
//
// PURE and dependency-free ON PURPOSE: `workspaces.ts` imports the Electron
// platform seam and the SDK chain, so it cannot be loaded under `node --test`.
// The walk-to-root logic lives here so its arms (the 3-level chain, the broken
// link, the cycle) run as plain unit tests, with the store injected as a lookup.

/** The minimal workspace shape the walk needs: an id and an optional parent. */
export interface WaveNode {
  id: string;
  parentId?: string;
}

/**
 * Walk `parentId` up to the topmost RESOLVABLE ancestor and return its id.
 *
 * A wave is LEAD → OPS → IMPL…, and every member must freeze against ONE run id
 * or the startup notice splits — walking a single level up gave a 3-deep tree
 * two different ids, which is exactly the N2 defect. `$ORCHESTRA_RUN_ID` is NOT
 * plumbed into the agent env on master, so this store walk is the only wave
 * identity available.
 *
 * @param lookup resolves a parent id to its node, or undefined for a broken/
 *   absent link (a dangling `parentId` after a delete).
 *
 * Invariants:
 *  - a root (no `parentId`) resolves to itself;
 *  - a broken link stops at the deepest resolvable ancestor, never throws;
 *  - a cycle is bounded by the `seen` set (a malformed `parentId` cycle would
 *    otherwise loop forever).
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
