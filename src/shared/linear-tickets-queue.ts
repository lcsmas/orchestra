// Which pinned tickets belong in the sidebar's Tickets queue.
//
// Lives in `shared/` (dependency-free) rather than inside Sidebar.tsx so it can
// be unit-tested: node --test cannot import a module that transitively reaches
// `electron`, and a .tsx component is not importable by the runner at all.

import type { PinnedTicket } from './types';

/**
 * The queue holds work that has NOT started.
 *
 * A ticket drops out once it has "graduated" — i.e. it points at a workspace
 * that still exists, whose row already shows the issue via the branch-derived
 * Linear badge. Showing it in both places would render the same issue twice.
 *
 * The liveness check is the subtle half: a ticket whose workspace was deleted
 * must come BACK into the queue. Otherwise it is invisible — hidden because it
 * looks graduated, while the workspace that justified hiding it is gone — and
 * invisible state is unrecoverable from the UI.
 *
 * Pin order is preserved (a plain filter), so a refresh never reshuffles rows.
 */
export function queuedTickets(
  tickets: readonly PinnedTicket[],
  liveWorkspaceIds: readonly string[],
): PinnedTicket[] {
  const live = new Set(liveWorkspaceIds);
  return tickets.filter((t) => !t.workspaceId || !live.has(t.workspaceId));
}
