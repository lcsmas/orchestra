import type { Workspace } from './types';

// Pure grouping for the header inbox ("Needs You" triage, Orca-inspired).
// Deliberately a LIVE VIEW over existing workspace state rather than an event
// log with read-tracking: the three attention states are already on the
// workspace record (`waiting` = blocked on you, `autoUnread` = finished but
// never opened, `markedUnread` = your own bookmark), and main clears the first
// two via markSeen when you view the workspace. An event inbox would duplicate
// them with worse semantics (stale entries after the workspace moved on).

export interface AttentionGroups {
  /** Agent stopped for YOU. Three sources, ranked by how much they actually
   * block you:
   *   2. `error`   — the run failed; the failure is the signal.
   *   1. `waiting` — the agent is BLOCKED on your answer and is burning
   *      wall-clock doing nothing until you reply.
   *   0. `autoUnread` — the turn FINISHED and you have never opened it. Work is
   *      already delivered; nothing is stalled, so it sorts last.
   * A row can be both `waiting` and `autoUnread`; the higher rank wins. */
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
  // (0). A row that is both `waiting` and `autoUnread` ranks as blocked, the
  // stronger claim — answering it is what unblocks the agent.
  const urgency = (w: Workspace): number =>
    w.status === 'error' ? 2 : w.status === 'waiting' ? 1 : 0;
  const needsYou = live
    .filter((w) => w.status === 'waiting' || w.status === 'error' || w.autoUnread)
    .sort((a, b) => urgency(b) - urgency(a));
  const inNeeds = new Set(needsYou.map((w) => w.id));
  const bookmarked = live.filter((w) => w.markedUnread && !inNeeds.has(w.id));
  const working = live.filter((w) => w.status === 'running');
  return { needsYou, bookmarked, working, count: needsYou.length + bookmarked.length };
}
