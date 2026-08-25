/**
 * Turn-budget exhaustion policy — what to do when a session's `maxTurns` cap
 * runs out (issue #69).
 *
 * ## The defect this closes (measured against master 2ebd3fb, v0.5.260)
 *
 * Orchestra opens ONE `query()` per structured session and streams every turn
 * of that session's life through it (`promptStream` in agent-sdk.ts). The SDK's
 * `maxTurns` is an option on THAT construction — its own type doc reads
 * "Maximum number of conversation turns before the query stops" — so the
 * hard-coded `maxTurns: 200` is a **session-lifetime** budget, not a per-turn
 * one. The literal's in-source comment ("a large cap: real turns end on their
 * own; this only backstops runaways") is false for any long-lived role: a
 * coordinator takes a turn per fleet ping, so it reaches 200 in normal use.
 *
 * What made this a SILENT failure rather than a loud one is that exhaustion is
 * not a throw. It arrives as an `SDKResultError` with
 * `subtype: 'error_max_turns'` on the message stream (sdk.d.ts) — an ordinary
 * `result`. So `consume()`'s catch/finally — the code that drains the queue,
 * settles senders' delivery receipts and emits "N queued messages were not
 * delivered" — NEVER RUNS. Instead the normal result branch opens the turn
 * gate, `promptStream` yields the next queued turn, and that turn dies on the
 * same already-exhausted budget immediately. The queue drains into a black
 * hole one entry per round-trip while every sender holds a
 * 'Delivered (live)' receipt.
 *
 * Field failure (#69, fix-wave-5): a coordinator hit `error_max_turns` mid
 * close-out and 43 messages piled up with nothing consuming them. The only
 * record was a `[WARN]` in the app log.
 *
 * ## Why RECYCLE the query rather than raise the cap
 *
 * Rejected — **raise the cap / make it per-workspace.** A bigger number moves
 * the wall without removing it: a coordinator that legitimately runs for days
 * reaches 2000 exactly as it reached 200, and the failure at the new wall is
 * identical and just as silent. It also forces a guess about how many turns a
 * role "should" need, which nothing in the app knows.
 *
 * Rejected — **reset the budget per user-initiated turn.** Unimplementable
 * against this SDK: `maxTurns` is fixed when `query()` is constructed and there
 * is no setter on the `Query` handle. The only way to obtain a fresh budget IS
 * to construct a new `query()`.
 *
 * Chosen — **recycle the query on exhaustion, with a runaway guard.** Tearing
 * the exhausted query down and re-entering `ensureSession` is lossless because
 * `ws.sdkSessionId` is persisted continuously and passed back as `resume`, so
 * the replacement query continues the SAME conversation with a fresh budget.
 * That makes `maxTurns` do the job its comment claims — backstop a runaway —
 * because a runaway is now caught by {@link shouldRecycleForBudget}'s rate
 * guard rather than by the raw count. A session that exhausts its budget
 * repeatedly in a short window is not a busy coordinator, it is a loop; that
 * one stops, and (this is the non-negotiable half) says so in the UI.
 *
 * The recycle is deliberately NOT silent either: every recycle is a visible
 * notice in the transcript. "Nothing tells the human why" is the actual bug in
 * #69, so a fix that quietly papered over exhaustion would reproduce it.
 */

/** How many budget recycles are allowed inside {@link RECYCLE_WINDOW_MS} before
 *  a session is treated as a runaway and left stopped.
 *
 *  Three, not one: exhausting a 200-turn budget is legitimate for a coordinator
 *  and may genuinely happen more than once in a long wave. What is NOT
 *  legitimate is burning 200 turns three times inside the window below — that
 *  is ~600 model round-trips with no human input, which is the runaway shape
 *  `maxTurns` was always meant to stop. */
export const MAX_RECYCLES_PER_WINDOW = 3;

/** The sliding window for {@link MAX_RECYCLES_PER_WINDOW}, in ms (1 hour).
 *
 *  Sized against the thing being measured: 200 turns is hours of honest
 *  coordinator work, so three of them inside ONE hour cannot be honest work —
 *  while a wave that spans a day and recycles a few times, spaced out, stays
 *  under the guard and keeps running. */
export const RECYCLE_WINDOW_MS = 60 * 60 * 1000;

/** A recorded budget recycle: the epoch-ms timestamps of prior recycles for one
 *  session, oldest-first. Persisted on the workspace so the guard survives the
 *  session teardown the recycle itself performs — an in-memory counter would be
 *  reset by the very restart it is supposed to be counting, making the runaway
 *  guard unable to ever fire. */
export type RecycleHistory = readonly number[];

/** The decision {@link shouldRecycleForBudget} returns. */
export interface RecycleDecision {
  /** Recycle the query (tear down + resume with a fresh budget)? */
  recycle: boolean;
  /** The pruned history to persist — prior recycles inside the window, plus
   *  `now` when {@link recycle} is true. Always assign this rather than
   *  appending to the old list, or entries outside the window accumulate
   *  forever and the guard tightens over the life of the workspace. */
  history: number[];
  /** Why, in the words the human reads. Present for BOTH outcomes: a recycle
   *  says the budget was renewed, a refusal says the session was stopped as a
   *  runaway. #69's whole point is that neither may be silent. */
  reason: string;
}

/**
 * Decide whether a session that just reported `error_max_turns` should have its
 * query recycled with a fresh budget, or be left stopped as a runaway.
 *
 * Pure so the policy is testable without Electron — `agent-sdk.ts` cannot be
 * imported by the test runner (it pulls in `platform`/`store`/`pty`), and this
 * decision is the part that can silently rot.
 *
 * @param prior  recycles already recorded for this workspace (epoch ms)
 * @param now    current time (epoch ms), injected so tests need no clock
 */
export function shouldRecycleForBudget(prior: RecycleHistory, now: number): RecycleDecision {
  // Prune first: only recycles INSIDE the window count toward the guard.
  // `>` not `>=` on the cutoff is immaterial at ms resolution; what matters is
  // that an old entry can never hold the guard down forever.
  const cutoff = now - RECYCLE_WINDOW_MS;
  const recent = prior.filter((t) => t > cutoff);

  if (recent.length >= MAX_RECYCLES_PER_WINDOW) {
    return {
      recycle: false,
      // Keep the pruned history: the workspace stays "recently a runaway" until
      // the window slides, so a human who resumes it manually does not get an
      // immediately-reset guard.
      history: recent,
      reason:
        `Stopped: this session exhausted its ${MAX_RECYCLES_PER_WINDOW}-turn-budget allowance ` +
        `${recent.length} times in the last hour, which is the runaway shape the turn cap ` +
        `exists to stop. Send a message to resume it.`,
    };
  }

  return {
    recycle: true,
    history: [...recent, now],
    reason:
      'Turn budget exhausted — the session was renewed with a fresh budget and the ' +
      'queued messages will be delivered. The conversation is intact.',
  };
}

/** Human-facing wording for a workspace whose last turn ended on a terminal
 *  reason the human needs to know about. Returns null for the ordinary
 *  end-of-turn, which owes the sidebar no explanation.
 *
 *  This backs the persisted `ws.lastStopReason` (types.ts) that the sidebar
 *  renders — the surface #69 requires. It is NOT the transient OS toast:
 *  `fireFinished`'s toast is suppressed whenever the window is focused, so a
 *  user sitting in front of the app is precisely the one it never reaches. */
export function stopReasonNote(reason: string | undefined): string | null {
  switch (reason) {
    case 'max_turns':
      return 'Stopped: turn budget exhausted';
    case 'error':
      return 'Stopped: the turn ended on an error';
    default:
      // `end_turn` and `interrupted` are not failures — a clean finish and the
      // user's own action respectively. Neither decorates the row.
      return null;
  }
}
