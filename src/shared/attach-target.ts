// #439 — who may receive an attach (ADR 0012: ANY workspace is a valid target; the old "must be an orchestrator" refusal is gone). Pure:
// `dispatchAttachRequest` (main) asks it, the sidebar's drop rule shares the same structural clauses. Only STRUCTURE refuses: self, an
// unknown / archived target, a target whose run is CLOSED (#437 — mail to it is refused, a member there could never send), and a parent cycle.

import type { RunNode } from './run-position.ts';

export interface AttachTargetNode extends RunNode {
  archived?: boolean;
}

export type AttachVerdict = { ok: true } | { ok: false; error: string };

/** The ancestry walk's lookup: workspace id → node. */
export type AttachLookup = (id: string) => AttachTargetNode | undefined;

export function decideAttachTarget(input: {
  id: string;
  parentId: string;
  lookup: AttachLookup;
  /** Is the TARGET's run closed on the bus (its coordinator was archived / is being deleted)? */
  targetRunClosed: boolean;
}): AttachVerdict {
  const { id, parentId, lookup } = input;
  if (parentId === id) return { ok: false, error: 'a workspace cannot be its own parent' };
  const parent = lookup(parentId);
  if (!parent) return { ok: false, error: `unknown parent workspace: ${parentId}` };
  if (parent.archived === true) return { ok: false, error: `cannot attach under an archived workspace (${parentId}) — unarchive it first` };
  if (input.targetRunClosed) return { ok: false, error: `the run of ${parentId} is closed (its coordinator was archived or deleted) — nothing can join it` };
  // Walk the proposed parent's ancestry: if `id` appears anywhere up the chain this edge closes a cycle. `seen` also terminates on a
  // pre-existing cycle in the store rather than spinning forever.
  const seen = new Set<string>([id]);
  for (let cur: AttachTargetNode = parent; ; ) {
    if (seen.has(cur.id)) return { ok: false, error: 'that would create a parent cycle' };
    seen.add(cur.id);
    const next = cur.parentId ? lookup(cur.parentId) : undefined;
    if (!next) break;
    cur = next;
  }
  return { ok: true };
}
