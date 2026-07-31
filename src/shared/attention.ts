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
   * unseen) or `error`. Errors sort first. */
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
  const needsYou = live
    .filter((w) => w.status === 'waiting' || w.status === 'error')
    .sort((a, b) => Number(b.status === 'error') - Number(a.status === 'error'));
  const inNeeds = new Set(needsYou.map((w) => w.id));
  const bookmarked = live.filter((w) => w.markedUnread && !inNeeds.has(w.id));
  const working = live.filter((w) => w.status === 'running');
  return { needsYou, bookmarked, working, count: needsYou.length + bookmarked.length };
}
