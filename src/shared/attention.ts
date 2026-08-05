import type { Workspace } from './types';

// Pure grouping for the header inbox ("Needs You" triage, Orca-inspired).
// Deliberately a LIVE VIEW over existing workspace state rather than an event
// log with read-tracking: Orchestra's `waiting` status already means "agent
// stopped for you and you haven't looked" (main clears it via markSeen when
// you view the workspace), and `markedUnread` is the explicit bookmark. An
// event inbox would duplicate both with worse semantics (stale entries after
// the workspace moved on).

export interface AttentionGroups {
  /** Agent stopped for YOU — status `waiting` (needs input / finished
   * unseen) or `error`. Sorted by how much they are actually blocking you:
   * errors, then agents BLOCKED on an answer
   * ({@link Workspace.waitingReason} `'blocked'`), then turns that merely
   * finished unseen. A blocked agent is idle until you reply, so it costs
   * real wall-clock; a finished one has already delivered its work. */
  needsYou: Workspace[];
  /** User-bookmarked rows (`markedUnread`), minus any already in needsYou. */
  bookmarked: Workspace[];
  /** Currently running agents — ambient awareness, not counted in the badge. */
  working: Workspace[];
  /** Badge count: distinct workspaces in needsYou + bookmarked. */
  count: number;
}

export function computeAttention(workspaces: Workspace[]): AttentionGroups {
  const live = workspaces.filter((w) => !w.archived);
  // Rank, descending: error (2) > blocked on your answer (1) > finished unseen
  // (0). Absent `waitingReason` reads as 'finished' — the weaker claim — so
  // pre-existing records and pre-split sessions keep their current placement
  // instead of jumping the queue.
  const urgency = (w: Workspace): number =>
    w.status === 'error' ? 2 : w.waitingReason === 'blocked' ? 1 : 0;
  const needsYou = live
    .filter((w) => w.status === 'waiting' || w.status === 'error')
    .sort((a, b) => urgency(b) - urgency(a));
  const inNeeds = new Set(needsYou.map((w) => w.id));
  const bookmarked = live.filter((w) => w.markedUnread && !inNeeds.has(w.id));
  const working = live.filter((w) => w.status === 'running');
  return { needsYou, bookmarked, working, count: needsYou.length + bookmarked.length };
}
