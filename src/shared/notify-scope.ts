// Turn-end notifications (unseen-done bell, chime, OS toast, Needs-You inbox) are ROOT-only: a spawned
// worker/ops ends turns all wave long (`orchestra ask` never blocks), so its turn-end is not "done".
// A child's QUESTION still notifies (it is blocked on the human). User ask 2026-10-31.
import type { Workspace } from './types.ts';

/** A child for notification purposes = its parent still exists and is not archived — the same rule that
 *  nests it in the sidebar's spawn tree (an orphan or an archived parent's child renders as a root). */
export function hasLiveParent(
  ws: Pick<Workspace, 'parentId'>,
  lookup: (id: string) => Pick<Workspace, 'archived'> | undefined | null,
): boolean {
  if (!ws.parentId) return false;
  const p = lookup(ws.parentId);
  return !!p && !p.archived;
}
