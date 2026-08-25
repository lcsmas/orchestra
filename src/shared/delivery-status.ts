// Honest delivery status for an inter-agent message — issue #57 fault (b).
//
// ── The bug this encodes against ─────────────────────────────────────────────
//
// `dispatchMessageRequest` reported `delivery: 'live'` — which the CLI prints
// verbatim as `Delivered (live).` — the instant the message was PUSHED onto a
// live structured session's queue. A queue push is not a delivery. Every one of
// these routinely discards a queued turn without ever running it:
//
//   • the target's user presses Escape  (interruptCancellingQueued wipes the queue)
//   • the session ends with turns queued (consume()'s finally drops them)
//   • the user cancels the prompt from the queue tray (sdkQueueRemove)
//   • the session is stopped/cleared/rewound (sdkStop)
//
// In all four the SENDER had already been told 'live', and nothing ever
// corrected it. The issue is explicit about why this half is the dangerous one:
// *a duplicated order is idempotent against a ledger; a dropped one is silent.*
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// Only a turn that actually STARTED may be reported as 'live'. Anything else
// falls back to the durable inbox — the one branch that proves a file write —
// and is reported as 'inbox'. Reporting a weaker TRUE status beats reporting a
// stronger false one, which is the whole point of the ticket.
//
// This lives in `src/shared` and is pure so the decision table can be
// unit-tested and mutation-tested directly, rather than only being reachable
// through a live Electron session.

/** What a live-session delivery attempt actually did.
 *  Mirrors `sdkDeliverConfirmed` (src/main/sdk-delivery.ts). */
export type LiveAttempt =
  /** No live structured session — the caller's PTY/wake/inbox paths apply. */
  | 'none'
  /** The turn really became the session's turn. */
  | 'started'
  /** The turn was discarded before it ran. */
  | 'dropped'
  /** Still queued when we stopped waiting. */
  | 'timeout';

/** The delivery status reported to the sender, or `null` when the live path
 *  does not apply at all and the caller should continue to its other paths. */
export type ReportedDelivery = 'live' | 'inbox' | null;

/** Decide what to tell the sender, given what the live attempt actually did.
 *
 *  The asymmetry is deliberate and is the fix:
 *    started → 'live'   (the only case that earns it)
 *    dropped → 'inbox'  (park it durably; never claim it ran)
 *    timeout → 'inbox'  (we do not KNOW it ran, so we must not say it did)
 *    none    → null     (not our path)
 *
 *  Note `timeout` deliberately does NOT report 'live' even though the message
 *  may well run a moment later. A status that is *probably* true is exactly the
 *  failure mode this ticket exists to remove; the inbox fallback is durable, so
 *  the worst case is that the target sees the message twice — the idempotent
 *  direction the issue explicitly prefers. */
export function reportedDeliveryFor(attempt: LiveAttempt): ReportedDelivery {
  switch (attempt) {
    case 'started':
      return 'live';
    case 'dropped':
    case 'timeout':
      return 'inbox';
    case 'none':
      return null;
  }
}

/** True when a live attempt must be backed by parking the message in the
 *  durable inbox. Kept beside {@link reportedDeliveryFor} so the two can never
 *  drift into a state where we report 'inbox' without actually writing one. */
export function requiresInboxFallback(attempt: LiveAttempt): boolean {
  return attempt === 'dropped' || attempt === 'timeout';
}
