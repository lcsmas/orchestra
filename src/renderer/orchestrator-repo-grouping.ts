/**
 * Pure helpers for the DISPLAY-ONLY repo association on a repo-less
 * orchestrator (`Workspace.repoAssociation`). Split out of Sidebar.tsx so the
 * rule lives in one place and can be unit tested without rendering React —
 * same shape as `host-grouping.ts`.
 *
 * The rule: an orchestrator normally renders in the pinned "Orchestrators"
 * section (Sidebar's section assignment asks `kind`, deliberately — see the
 * `isScratchLike` vs `canOrchestrate` split in shared/types.ts). Giving it a
 * `repoAssociation` files it under that repo's section instead, carrying its
 * whole spawn subtree with it, so a coordinator sits with the children it
 * coordinates.
 *
 * Nothing here touches git: `repoAssociation` is never `repoPath`, so the
 * orchestrator keeps no checkout, no branch, no diff. See the field's docblock
 * for why conflating the two is unsafe.
 */

import type { Workspace } from '../shared/types';

/** The repo section a workspace should be FILED under for sidebar grouping, or
 * `null` when it belongs in a pinned spawn-tree section instead.
 *
 * - A repo-less orchestrator with a `repoAssociation` → that repo path.
 * - Any other orchestrator (or scratch) → `null` (stays pinned).
 * - A git workspace → its own `repoPath`, unchanged.
 *
 * Only `kind === 'orchestrator'` honours the association: the field is
 * meaningless on a git worktree (which already has a real `repoPath` and groups
 * by it) and on a plain scratch session (which has no coordinator role to
 * carry a subtree). Reading it anywhere else would be a silent second grouping
 * key competing with `repoPath`. */
export function repoSectionKeyOf(
  ws: Pick<Workspace, 'kind' | 'repoPath' | 'repoAssociation'>,
): string | null {
  if (ws.kind === 'orchestrator') {
    // REAL ownership beats the display-only preference: once a coordinator has
    // adopted a repo it belongs in that repo's section on the same grounds as
    // any worktree, and a stale `repoAssociation` naming a different repo must
    // not override where its checkout actually lives.
    if (ws.repoPath) return ws.repoPath;
    const assoc = ws.repoAssociation?.trim();
    return assoc ? assoc : null;
  }
  if (ws.kind === 'scratch') return null;
  return ws.repoPath;
}

/** True when this workspace is an orchestrator that has been filed into a repo
 * section by its association — i.e. it must be SKIPPED by the pinned
 * "Orchestrators" section and picked up by repo grouping instead.
 *
 * This is the single predicate both sides of the split consult, so the two can
 * never disagree and double-render (or drop) a row. */
export function isRepoAssociatedOrchestrator(
  ws: Pick<Workspace, 'kind' | 'repoPath' | 'repoAssociation'>,
): boolean {
  // Either route files it into a repo section: a real adopted `repoPath`, or the
  // display-only association. Both must be covered here or the row renders
  // TWICE — once from the pinned list, once from the repo section — since the
  // two sides of the split consult this one predicate to stay complementary.
  return ws.kind === 'orchestrator' && (!!ws.repoPath || !!ws.repoAssociation?.trim());
}

/** Partition orchestrator spawn-tree roots into the ones that stay pinned and
 * the ones that have been filed into a repo section.
 *
 * Returned as one call rather than two filters at the call site so the two
 * lists are guaranteed complementary — every root lands in exactly one, which
 * is what makes "nothing double-renders and nothing vanishes" a property of
 * this function instead of a convention the caller has to maintain. */
export function partitionOrchestratorRoots<
  T extends Pick<Workspace, 'kind' | 'repoPath' | 'repoAssociation'>,
>(roots: T[]): { pinned: T[]; inRepoSections: T[] } {
  const pinned: T[] = [];
  const inRepoSections: T[] = [];
  for (const w of roots) {
    if (isRepoAssociatedOrchestrator(w)) inRepoSections.push(w);
    else pinned.push(w);
  }
  return { pinned, inRepoSections };
}
