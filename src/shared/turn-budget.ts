/**
 * Turn-budget exhaustion policy — what to do when a session's `maxTurns` cap
 * runs out (issue #69).
 *
 * ## The defect this closes — MEASURED, not inferred
 *
 * An earlier draft of this module was written from `sdk.d.ts` and claimed
 * `maxTurns` was a session-LIFETIME budget that starved the queue one entry per
 * round-trip. Driving a real `query()` REFUTED that (probes in
 * docs/research/issue-69-maxturns-findings.md, 2026-08-25). What actually
 * happens, reproduced twice identically:
 *
 *   - The cap is **PER-TURN**. With `maxTurns:1`, prompt P1 returns
 *     `error_max_turns` and P2 then runs with a FULL budget. A first exhaustion
 *     is benign, self-recovering, and does NOT throw — so nothing should react
 *     to it.
 *   - The **SECOND** exhaustion is the failure. It THROWS ("Reached maximum
 *     number of turns"), killing the `query()` and discarding every prompt
 *     still queued behind it. Measured: 5 prompts yielded, 2 results seen,
 *     3 never consumed.
 *
 * That is #69's starved queue: a hard kill on the second exhaustion, not a slow
 * drain. Because it IS a throw it lands in `consume()`'s catch/finally, which
 * already reports the lost queue honestly — so the queue is not silently eaten
 * at the SDK seam. What was genuinely missing, and what #69 names as the bug,
 * is that the session is DEAD and the human is not told WHY: `fireFinished`
 * lands every terminal reason on `idle`, and its only differentiator was an OS
 * toast suppressed whenever the window is focused.
 *
 * ## What this policy decides
 *
 * On that budget-driven death, the queue can be rescued: `ws.sdkSessionId` is
 * persisted, so a fresh `query()` resumes the SAME conversation and the carried
 * entries get delivered instead of dropped. Raising `maxTurns` would not fix
 * this — it only changes WHICH turn throws — and the budget cannot be reset in
 * place, since it is fixed at construction with no setter. So the question is
 * not "how big should the cap be" but "how many times may a session be resumed
 * before we conclude it is looping". That is what this module answers.
 */

/** How many budget-driven resumes are allowed inside {@link RECYCLE_WINDOW_MS}
 *  before a session is treated as a runaway and left stopped.
 *
 *  Three, not one: a long-running session can legitimately hit the per-turn cap
 *  more than once (a couple of genuinely hard turns), and killing it on the
 *  first would be worse than the bug. What is NOT legitimate is doing it three
 *  times inside the window below with no human input — that is the runaway
 *  shape `maxTurns` exists to stop.
 *
 *  NOT a measured threshold. An earlier draft justified the window with "200
 *  turns is hours of honest coordinator work", which rested on the refuted
 *  session-lifetime model; there is no measurement of a real coordinator's
 *  exhaustion rate behind these numbers. They are a deliberately loose
 *  backstop: tight enough to stop an unattended loop, loose enough that normal
 *  work never meets them. Revise on evidence, not on taste. */
export const MAX_RECYCLES_PER_WINDOW = 3;

/** The sliding window for {@link MAX_RECYCLES_PER_WINDOW}, in ms (1 hour).
 *  See the note above: chosen as a backstop, not derived from a measurement. */
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
        `Stopped: this session hit its per-turn limit and was resumed ` +
        `${recent.length} times in the last hour — the runaway shape the turn cap ` +
        `exists to stop. Send a message to resume it.`,
    };
  }

  return {
    recycle: true,
    history: [...recent, now],
    reason:
      'Turn limit reached and the session stopped — it was resumed automatically and the ' +
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
