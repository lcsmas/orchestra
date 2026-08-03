// Should the structured view request an on-disk history backfill for a pane?
//
// This is the gate that decides whether a REMOUNTED StructuredView re-reads the
// workspace's transcript from disk. It is pure so `node --test` can cover the
// state combinations that only occur after a pane eviction (App.tsx's
// MAX_MOUNTED_PANES LRU), which is exactly where the "some transcript
// disappeared" bug lived.
//
// THE BUG (v0.5.192 and earlier). The old gate was `if (requested || messages > 0)
// return` with `requested` a per-MOUNT ref. That is correct only while a pane
// stays mounted, and it silently produces a TRUNCATED transcript otherwise:
//
//   1. A workspace's pane is evicted (the user visits >12 others — with 72
//      workspaces on this machine that is routine). The component unmounts, so
//      both the `historyRequested` ref AND the measured-row height cache die.
//   2. The `agent:event` subscription in store.ts is GLOBAL and ungated, so the
//      session keeps folding events for the UNMOUNTED workspace. A background
//      turn appends, say, 3 new messages to a session whose 400 earlier
//      messages were never in the store (they only ever existed on disk).
//   3. The user reopens that workspace. StructuredView mounts fresh, and the
//      gate reads `messages.length > 0` → 3 → "already have history, skip".
//      The pane renders those 3 orphan messages as the ENTIRE conversation.
//      Everything before them is gone from the view while remaining on disk.
//
// The store-emptiness heuristic conflates "this session has been backfilled"
// with "this session has any messages at all". Those differ precisely when
// events land while no pane is mounted. So the gate must key on whether THIS
// session was actually backfilled — tracked explicitly on the session
// (`historyBackfilled`), which survives unmount because it lives in the store —
// rather than inferring it from message count.
//
// Note the fix deliberately does NOT depend on the eviction cap: raising
// MAX_MOUNTED_PANES only narrows the window, and a session can also receive
// events before its pane is ever opened (peer delivery, `orchestra spawn`,
// queued-prompt wake — all of which start turns headlessly).

/** Inputs the gate needs. All plain data — no React, no store handle. */
export interface HistoryBackfillState {
  /** Did THIS mount already fire a request? (the per-mount ref) */
  requestedThisMount: boolean;
  /** Has this workspace's session been backfilled from disk at least once?
   *  Lives on the folded session in the store, so it survives pane eviction. */
  alreadyBackfilled: boolean;
  /** Folded message count currently in the store for this workspace. */
  messageCount: number;
  /** Was the session explicitly cleared (`/clear`)? Main returns [] for a
   *  cleared session, but short-circuiting here saves the round trip and
   *  documents the intent. */
  cleared: boolean;
}

/**
 * True when the pane should ask main for the on-disk transcript.
 *
 * Backfill is requested once per SESSION (not once per mount): a remount of a
 * partially-folded session must still pull the history it never had.
 */
export function shouldRequestHistory(s: HistoryBackfillState): boolean {
  if (s.requestedThisMount) return false; // in flight / done this mount
  if (s.cleared) return false; // `/clear` — nothing to restore
  if (s.alreadyBackfilled) return false; // this session already has its history
  // NOTE: message count is deliberately NOT consulted. A non-empty session that
  // has never been backfilled is the bug case — messages folded in while the
  // pane was unmounted, with the earlier transcript still only on disk.
  return true;
}

/**
 * Where to splice backfilled history relative to messages already in the store.
 *
 * The old code dropped the backfill entirely when live messages had appeared
 * ("skip rather than append stale history after fresh messages") — which is what
 * turned an evicted-then-reopened pane into a 3-message transcript. History is
 * always OLDER than anything folded live, so the correct move is to PREPEND it,
 * not to discard it.
 *
 * Returns the ids of history events to keep: those not already represented in
 * the store (a session that folded a few live messages must not show them
 * twice once the same lines are read back off disk).
 */
export function dedupeHistoryAgainstLive(opts: {
  /** Stable ids of messages already folded into the store, in order. */
  liveIds: readonly string[];
  /** Stable ids the history backfill would produce, in order. */
  historyIds: readonly string[];
}): { prepend: string[]; overlap: number } {
  const live = new Set(opts.liveIds);
  const prepend = opts.historyIds.filter((id) => !live.has(id));
  return { prepend, overlap: opts.historyIds.length - prepend.length };
}
