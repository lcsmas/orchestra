// Session-wedge policy (issue #90) — pure decision functions, no Electron, no
// I/O, so they are unit-testable and mutation-testable without a running app.
//
// ── The defect this module exists to make impossible ────────────────────────
//
// A structured (SDK) session drives its turns through an async generator,
// `promptStream` in src/main/agent-sdk.ts. Each turn arms a one-shot gate
// (`session.turnGate`) before yielding, and the generator parks on that gate
// until the turn's `result` message arrives on the SDK stream. On the normal
// delivery path the gate is released in EXACTLY ONE place: consume()'s
// `msg.type === 'result'` branch.
//
// So a turn that is yielded but never produces a `result` parks the generator
// at `await turnInFlight` permanently, and the resulting state is uniquely
// nasty because every external probe reads HEALTHY:
//
//   • `sessions.has(wsId)` is true            -> the session is "live"
//   • control requests still answer            -> they use a different channel
//     (`session.q`) than the prompt generator, which is why the 2026-08-25
//     field capture saw `reload-skills` answered by a session that had not
//     started a turn in 35 minutes
//   • `session.pump` is null                   -> the generator is parked at the
//     GATE, not at the pump, so every later `sdkSend`'s `session.pump?.()` is a
//     silent no-op
//   • deliveries time out and are withdrawn    -> `sdkSendAwaitingStart` waits
//     DELIVERY_START_TIMEOUT_MS for a start that cannot come, then withdraws
//   • the withdrawn messages park in the inbox -> which is drained by the
//     UserPromptSubmit SHELL HOOK, i.e. only by a turn starting
//
// The last two close the loop: a parked message cannot wake the agent, because
// the only thing that drains the inbox is the very turn that can never start.
// Self-sustaining freeze. Nothing on the delivery path can break it; only a
// teardown can (`sdkStop` and consume()'s `finally` are the two places that
// call `session.turnGate?.()`), which is why the field incidents recovered
// only when a human re-kicked them.
//
// Two layers live here, and they are deliberately independent:
//
//   1. {@link decideGateRelease} — the ROOT CAUSE. The gate must not be
//      releasable only by a `result`. A turn whose stream has gone completely
//      silent for a long time releases the gate so the queue can drain.
//   2. {@link decideSessionRecycle} — the CAUSE-AGNOSTIC WATCHDOG. Even if the
//      wedge takes a shape layer 1 does not model, a workspace with parked work
//      that has not started a turn in a long time gets its session recycled
//      automatically. It never asks WHY, which is the whole point: the field
//      cause is recorded as UNEXPLAINED and the fix must not depend on it.
//
// Layer 2 is not redundancy for its own sake. Layer 1 fixes the mechanism I can
// prove; layer 2 is what makes the ticket's bar ("NEVER", not "visible")
// survive a mechanism I could not.

/** How long a turn's SDK stream must be COMPLETELY SILENT before its gate is
 *  force-released.
 *
 *  ## This is a PROGRESS bound, not a duration bound
 *
 *  The distinction is the whole safety argument, so it is worth stating flatly:
 *  this is NOT "a turn may not run longer than 10 minutes". A turn may run for
 *  hours. The clock is reset by EVERY message on the SDK stream — every text
 *  delta, every tool call, every tool result. It expires only when a turn has
 *  emitted nothing whatsoever for the full window.
 *
 *  A wall-clock bound on turn DURATION would be the #62 mistake repeated: a
 *  dead turn and a slow-but-live turn are indistinguishable to a timer, so
 *  bounding duration cuts off the legitimate long turn (a full build, a test
 *  suite, a headless E2E boot — all routine in this repo) while a genuinely
 *  wedged turn that happens to be fast is missed. Bounding PROGRESS separates
 *  them: a live turn always emits something.
 *
 *  UNBASELINED, and deliberately so. The distribution of longest-silence-within
 *  -a-live-turn across a real fleet has not been measured, and I will not put a
 *  fabricated figure here (see the wave's rule on unmeasured numbers). 10
 *  minutes is chosen as a conservative FLOOR: it is far above any inter-message
 *  gap a working agent plausibly shows (tool results and text deltas arrive
 *  continuously, and even a long `Bash` call is bounded by its own timeout,
 *  which is 600_000 ms at its maximum in this codebase — so a single tool call
 *  cannot outlast this window while still being healthy... except at exactly
 *  that maximum, which is why the value is not smaller).
 *
 *  Safety does not rest on the number being right. Releasing the gate is a
 *  RECOVERABLE, NON-DESTRUCTIVE act: it lets the next queued turn proceed. If
 *  the window were somehow too short, the cost is that a queued turn starts
 *  while a silent turn was still notionally in flight — the same thing a user
 *  pressing Escape and re-sending does. If it is too long, layer 2 catches the
 *  workspace anyway. Neither failure loses a message. */
export const GATE_SILENCE_RELEASE_MS = 10 * 60 * 1000;

export interface GateReleaseInput {
  /** Whether a turn is currently in flight (`session.turnGate !== null`). */
  gateHeld: boolean;
  /** The turn uuid the gate is held for, as observed EARLIER by the watchdog. */
  observedTurnUuid: string | null;
  /** The turn uuid the gate is held for NOW. When these differ the gate slot
   *  was reused by a healthy later turn and must not be touched. */
  currentTurnUuid: string | null;
  /** Epoch ms of the last message seen on this session's SDK stream. */
  lastStreamAt: number;
  /** True while the session is tearing down; teardown releases the gate itself. */
  stopping: boolean;
  /** Whether anything is actually waiting on the gate. Releasing a gate with an
   *  empty queue changes nothing observable, so there is no reason to do it —
   *  and not doing it keeps the action rare and auditable. */
  queuedCount: number;
  /** Epoch ms now. */
  now: number;
  /** Silence window; injectable so tests need no fake clock. */
  silenceMs?: number;
}

/** Whether a stranded turn gate should be force-released.
 *
 *  Every guard is load-bearing:
 *
 *   1. **A gate must actually be held.** Nothing to release otherwise.
 *   2. **Something must be waiting.** A release with an empty queue is a no-op
 *      dressed as an intervention.
 *   3. **Not while stopping.** Teardown already releases the gate; racing it
 *      would double-release.
 *   4. **The turn must be the SAME one we observed going silent.** This is what
 *      makes the action safe against the gate slot being reused: if the uuid
 *      changed, a healthy turn owns the gate now and we stand down. A
 *      watchdog that skipped this would eventually release a live turn's gate.
 *   5. **The stream must have been silent for the whole window** — the progress
 *      bound. A turn emitting anything at all is never released. */
export function decideGateRelease(input: GateReleaseInput): boolean {
  const {
    gateHeld,
    observedTurnUuid,
    currentTurnUuid,
    lastStreamAt,
    stopping,
    queuedCount,
    now,
    silenceMs = GATE_SILENCE_RELEASE_MS,
  } = input;

  if (!gateHeld) return false;
  if (queuedCount <= 0) return false;
  if (stopping) return false;
  // 4. Same turn, or stand down. `null` on either side means we cannot prove
  // identity, and an unprovable identity is a refusal — never a guess.
  if (observedTurnUuid === null || currentTurnUuid === null) return false;
  if (observedTurnUuid !== currentTurnUuid) return false;
  // 5. Progress bound.
  return now - lastStreamAt >= silenceMs;
}

/** Max automatic session recycles per workspace per rolling hour.
 *
 *  Anti-flap is MANDATORY and this is why: an automatic restart that fires
 *  repeatedly is strictly worse than the stall it treats. A stalled session
 *  holds its messages parked and durable; a flapping one can tear down a
 *  session mid-turn over and over, and each restart costs the conversation's
 *  warm subprocess. So the watchdog is allowed to be wrong a bounded number of
 *  times and then must STOP and say so.
 *
 *  Both 2026-08-25 field occurrences were single events on a single workspace,
 *  35 minutes apart at most, so a budget of 3/hour is far above the observed
 *  need while still converging quickly on "this is not working, tell a human".
 *  UNBASELINED as a rate; justified as a ceiling rather than a tuning. */
export const MAX_RECYCLES_PER_HOUR = 3;
export const RECYCLE_WINDOW_MS = 60 * 60 * 1000;

export interface RecycleInput {
  /** True when a live structured session owns this workspace. A workspace with
   *  no session cannot be wedged in the sense this watchdog treats — there is
   *  nothing to recycle, and spawning one would be a different feature. */
  sessionLive: boolean;
  /** The #88 stall verdict for this workspace, or null when it is not stalled.
   *  Passing the VERDICT rather than re-deriving it is deliberate: #88's
   *  `decideQueueStall` already encodes every false-positive guard this
   *  watchdog needs (parked>0, not `running`, not hibernated, no already
   *  explained stop reason, age floored at `observableSince`), and a second,
   *  independently-drifting copy of that policy is exactly how a healthy agent
   *  eventually gets recycled. */
  stalled: { parkedCount: number; stalledForMs: number } | null;
  /** Epoch ms of recent automatic recycles for this workspace, newest last. */
  recentRecycles: readonly number[];
  /** Epoch ms now. */
  now: number;
  maxPerWindow?: number;
  windowMs?: number;
}

export type RecycleDecision =
  | { action: 'none' }
  /** Recycle now. `parkedCount` rides along for the log/telemetry line. */
  | { action: 'recycle'; parkedCount: number; stalledForMs: number }
  /** Budget exhausted — do NOT recycle, and SURFACE it. Never silent: a
   *  watchdog that quietly gives up leaves the human with neither a working
   *  agent nor a reason. */
  | { action: 'flap-limit'; recyclesInWindow: number; stalledForMs: number };

/** Decide what the watchdog should do for ONE workspace.
 *
 *  Cause-agnostic BY CONSTRUCTION: it never inspects why the session stopped
 *  taking turns. That is the requirement — the field cause is UNEXPLAINED and
 *  recorded as such, so a fix that depended on identifying it would only cover
 *  the shapes already seen. */
export function decideSessionRecycle(input: RecycleInput): RecycleDecision {
  const {
    sessionLive,
    stalled,
    recentRecycles,
    now,
    maxPerWindow = MAX_RECYCLES_PER_HOUR,
    windowMs = RECYCLE_WINDOW_MS,
  } = input;

  if (!stalled) return { action: 'none' };
  if (!sessionLive) return { action: 'none' };

  const inWindow = recentRecycles.filter((t) => now - t < windowMs).length;
  if (inWindow >= maxPerWindow) {
    return { action: 'flap-limit', recyclesInWindow: inWindow, stalledForMs: stalled.stalledForMs };
  }
  return {
    action: 'recycle',
    parkedCount: stalled.parkedCount,
    stalledForMs: stalled.stalledForMs,
  };
}

/** Drop recycle stamps that have aged out of the window — so the ledger a
 *  caller keeps does not grow without bound. */
export function pruneRecycles(
  recentRecycles: readonly number[],
  now: number,
  windowMs: number = RECYCLE_WINDOW_MS,
): number[] {
  return recentRecycles.filter((t) => now - t < windowMs);
}
