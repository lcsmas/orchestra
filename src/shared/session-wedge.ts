// Session-wedge policy (issue #90) — pure decision functions, no Electron, no
// I/O, so they are unit-testable and mutation-testable without a running app.
//
// TYPE-ONLY import (issue #174): the boot-wedge detector below returns the SAME
// verdict shape as the #88 queue-stall detector so both feed one
// `decideSessionRecycle`. A type-only import adds no runtime coupling — this
// module stays free of Electron and I/O — and guarantees the two verdicts can
// never drift apart into incompatible shapes.
import type { QueueStallVerdict } from './queue-stall.ts';
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

/** Minimum gap between the PREVIOUS automatic recycle and the next, and how it
 *  WIDENS with each attempt inside the window (issue #97).
 *
 *  ## The defect this closes
 *
 *  The anti-flap budget above is a hard COUNT in a rolling hour, with no spacing
 *  between attempts. So a session that wedges the instant it is recycled spends
 *  its whole budget as fast as the tick allows — three recycles in three ticks
 *  (`TICK_MS` = 60s), three warm subprocesses torn down inside three minutes —
 *  and only THEN stands down for the rest of the hour. A count without a
 *  widening interval is not anti-flap; it is a burst limiter that front-loads
 *  the damage.
 *
 *  ## Exponential, keyed on the number of recycles already spent
 *
 *  With N recycles already in the window, the NEXT one must wait
 *  `RECYCLE_BACKOFF_BASE_MS * 2^(N-1)` after the most recent one, capped at
 *  `RECYCLE_BACKOFF_MAX_MS` — so N=0 (empty ledger) waits nothing, N=1 waits
 *  base, N=2 waits 2×base. The FIRST recycle is therefore treated instantly — a
 *  genuine one-off stall, which is the common case both 2026-08-25 field
 *  occurrences were. Each subsequent attempt costs
 *  the flapping workspace progressively more real time before it may burn the
 *  next budget slot, so the budget now spans a widening fraction of the hour
 *  instead of three back-to-back ticks.
 *
 *  ## Why a SEPARATE action, not a longer window
 *
 *  `backoff` is NOT `flap-limit`: the budget is not spent, the workspace is not
 *  stood down, and nothing needs a human. It is simply "not yet" — the next tick
 *  re-evaluates and eventually crosses the interval. Collapsing it into either
 *  `none` (indistinguishable from "not stalled") or `flap-limit` (surfaces a
 *  false alarm and consumes the human's attention) would lose that distinction.
 *
 *  UNBASELINED, and chosen as spacings rather than tuned rates (same footing as
 *  MAX_RECYCLES_PER_HOUR). Base 2 min: comfortably above one 60s tick, so the
 *  second attempt is always deferred by at least one tick rather than firing on
 *  the very next one. Cap 15 min: at the current `MAX_RECYCLES_PER_HOUR = 3`
 *  the flap ceiling is hit before any 4th backoff computes, so the LARGEST gap
 *  ever actually used is N=2 → `base*2 = 4 min` — the cap is unreachable today
 *  and exists only to bound the interval if `MAX_RECYCLES_PER_HOUR` is later
 *  raised (without it, `base*2^(N-1)` would grow unbounded and could silently
 *  disable the watchdog for longer than the window). Review F4. */
export const RECYCLE_BACKOFF_BASE_MS = 2 * 60 * 1000;
export const RECYCLE_BACKOFF_MAX_MS = 15 * 60 * 1000;

/** The widening interval the Nth recycle (0-indexed by recycles already spent
 *  in the window) must observe since the previous recycle. Pure, exported for
 *  the rig and the tests so the growth can be asserted directly. */
export function recycleBackoffMs(
  recyclesInWindow: number,
  baseMs: number = RECYCLE_BACKOFF_BASE_MS,
  maxMs: number = RECYCLE_BACKOFF_MAX_MS,
): number {
  if (recyclesInWindow <= 0) return 0;
  const widened = baseMs * 2 ** (recyclesInWindow - 1);
  return Math.min(widened, maxMs);
}

export interface RecycleInput {
  /** True when a live structured session owns this workspace. A workspace with
   *  no session cannot be wedged in the sense this watchdog treats — there is
   *  nothing to recycle, and spawning one would be a different feature. */
  sessionLive: boolean;
  /** Epoch ms of the last message observed on this session's SDK stream, or
   *  null when there is no live session to read it from.
   *
   *  ## Why the DESTRUCTIVE path needs its own evidence (review R1)
   *
   *  The first cut of this module passed only #88's stall verdict and argued
   *  that reusing its guards was deliberate because they "already encode every
   *  false-positive guard this watchdog needs". **That is true for a BADGE and
   *  false for a KILL.** Same guards, vastly higher cost of being wrong:
   *  `recycleSession` calls `sdkStop`, which calls `session.q.interrupt()`.
   *
   *  And the guard being leaned on — `status !== 'running'` — is documented as
   *  unreliable IN THE FILE IT WAS BORROWED FROM. `queue-stall.ts` records that
   *  `status` does NOT survive a restart (`store.load()` floors every
   *  `running`/`waiting` to `idle`) and that on 2026-08-25 3–5 workspaces read
   *  idle while healthy and mid-wave. `status` is a display field maintained by
   *  a best-effort hook chain; it is not sound evidence for tearing down a live
   *  subprocess.
   *
   *  The sharpest case is `'waiting'`, the DESIGNED status for a permission or
   *  dialog block: an agent parked on a permission prompt while a peer messages
   *  it would have its in-flight turn interrupted and its session torn down,
   *  and the human about to click Allow would lose the turn.
   *
   *  So the recycle path now consults the SAME progress evidence layer 1 uses —
   *  the one whose deletion was measured (mutant 2, `busy_backdated`) to make a
   *  live turn's gate wrongly released. A session that emitted anything inside
   *  the silence window is REFUSED regardless of status. */
  lastStreamAt: number | null;
  /** Silence window for the progress refusal above. Same constant layer 1 uses;
   *  injectable for tests. */
  silenceMs?: number;
  /** The #88 stall verdict for this workspace, or null when it is not stalled.
   *
   *  Passing the VERDICT rather than re-deriving it keeps there being exactly
   *  ONE detector — a second, independently-drifting copy of that policy is how
   *  a healthy agent eventually gets recycled.
   *
   *  **CORRECTED (review R1), because the original claim here was wrong and is
   *  the kind nobody re-derives:** this comment used to say #88's guards
   *  "already encode every false-positive guard this watchdog needs". They do
   *  not. They are sufficient for a BADGE and insufficient for a KILL — see
   *  {@link RecycleInput.lastStreamAt}. #88's verdict is NECESSARY but not
   *  SUFFICIENT here: it decides "is this workspace worth looking at", and
   *  `lastStreamAt` decides "is it safe to tear down". */
  stalled: { parkedCount: number; stalledForMs: number } | null;
  /** Epoch ms of recent automatic recycles for this workspace, newest last. */
  recentRecycles: readonly number[];
  /** Epoch ms now. */
  now: number;
  maxPerWindow?: number;
  windowMs?: number;
  /** Backoff params (issue #97); injectable for tests. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export type RecycleDecision =
  | { action: 'none' }
  /** Recycle now. `parkedCount` rides along for the log/telemetry line. */
  | { action: 'recycle'; parkedCount: number; stalledForMs: number }
  /** Under budget, but the widening backoff interval since the last recycle has
   *  not elapsed yet (issue #97). NOT a stand-down: no budget is spent, no human
   *  is needed. The next tick re-evaluates; `waitMs` is how much longer the
   *  interval had to run, for the log/telemetry line only. */
  | { action: 'backoff'; waitMs: number; recyclesInWindow: number }
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
    lastStreamAt,
    recentRecycles,
    now,
    maxPerWindow = MAX_RECYCLES_PER_HOUR,
    windowMs = RECYCLE_WINDOW_MS,
    silenceMs = GATE_SILENCE_RELEASE_MS,
    backoffBaseMs = RECYCLE_BACKOFF_BASE_MS,
    backoffMaxMs = RECYCLE_BACKOFF_MAX_MS,
  } = input;

  if (!stalled) return { action: 'none' };
  if (!sessionLive) return { action: 'none' };

  // PROGRESS REFUSAL (review R1), and it is deliberately placed BEFORE the
  // anti-flap budget: a session that is demonstrably emitting must not even
  // consume a recycle budget slot, or a healthy-but-noisy workspace could
  // exhaust its own budget and then be reported as flapping.
  //
  // `null` means "no live session to read progress from" — which `sessionLive`
  // has already excluded above, so reaching here with null is a contradiction
  // in the caller's inputs. Refuse rather than guess: an unprovable liveness
  // claim is not a licence to kill a subprocess.
  if (lastStreamAt === null) return { action: 'none' };
  if (now - lastStreamAt < silenceMs) return { action: 'none' };

  const recentInWindow = recentRecycles.filter((t) => now - t < windowMs);
  const inWindow = recentInWindow.length;
  if (inWindow >= maxPerWindow) {
    return { action: 'flap-limit', recyclesInWindow: inWindow, stalledForMs: stalled.stalledForMs };
  }

  // WIDENING BACKOFF (issue #97), checked AFTER the flap ceiling but BEFORE the
  // recycle: under budget is a necessary precondition, but the Nth attempt must
  // also wait a widening interval since the LAST recycle so a session that
  // re-wedges instantly cannot burn its whole budget on consecutive ticks. The
  // first attempt (empty ledger) waits nothing — `recycleBackoffMs(0)` is 0 —
  // so a genuine one-off stall is still treated immediately.
  const requiredGap = recycleBackoffMs(inWindow, backoffBaseMs, backoffMaxMs);
  if (requiredGap > 0 && inWindow > 0) {
    // `Math.max`, not "the last element": the doc says newest-last, but a
    // destructive gate must not depend on caller ordering — the most RECENT
    // recycle is the one the interval is measured from however the list arrived.
    const lastRecycle = Math.max(...recentInWindow);
    const sinceLast = now - lastRecycle;
    if (sinceLast < requiredGap) {
      return { action: 'backoff', waitMs: requiredGap - sinceLast, recyclesInWindow: inWindow };
    }
  }

  return {
    action: 'recycle',
    parkedCount: stalled.parkedCount,
    stalledForMs: stalled.stalledForMs,
  };
}

/** ── Issue #174: the BOOT wedge — a first turn that never starts ─────────────
 *
 *  ## The failure this closes, and why the two layers above do NOT
 *
 *  A burst-spawned child (heavy `CLAUDE.md` preload + many MCP servers) can
 *  wedge in the CLI's session INIT — `getContextUsage` times out — BEFORE it
 *  ever consumes the spawn's opening prompt. Measured 2026-09-21 on the
 *  metarepo: 5 of 6 burst spawns died this way, and only an app relaunch +
 *  #172 rollback ever revived one.
 *
 *  This shape escapes BOTH layers above, and the reason is the opening prompt's
 *  lifecycle (verified at source):
 *
 *   • The spawn prompt is the session's FIRST turn. `sdkSend` pushes it and
 *     `promptStream` immediately SHIFTS it off `session.queue` (queue now
 *     EMPTY), arms `turnGate`, and yields it to the SDK. So:
 *       — {@link decideGateRelease} refuses at its `queuedCount <= 0` guard:
 *         the gate is held but nothing is queued BEHIND it to drain, and
 *         releasing a gate with an empty queue is a no-op anyway.
 *       — {@link decideQueueStall} refuses at its `parkedCount <= 0` guard:
 *         the opening prompt lives in `session.queue` (now drained) and
 *         `ws.sdkPendingPrompts`, NOT in `ws.queuedPrompts` (the banner) or the
 *         durable inbox, so the stall detector sees nothing waiting.
 *
 *  Both existing layers key on WORK QUEUED BEHIND a started session. The boot
 *  wedge has no such work — it has an opening turn that was accepted and never
 *  processed. The one observable that separates it from a healthy session is
 *  PROOF OF LIFE: has the SDK stream ever produced a single message for this
 *  session? A live turn — however slow — emits `system/init` almost at once and
 *  then text/tool deltas. A boot-wedged session emits NOTHING, ever.
 *
 *  ## PROOF OF LIFE, never "prompts are live", never "inbox empty"
 *
 *  The discriminator is `firstMessageSeen` — set true in consume() the first
 *  time ANY message lands on the SDK stream. It is emphatically NOT "a pending
 *  prompt is live in the session" (the exact false-positive the #174 field
 *  recovery guard tripped on: the wedged session HELD live prompts, which read
 *  as alive) and NOT "the inbox is empty" (a boot wedge's prompt is not in the
 *  inbox at all). Only stream output proves the CLI got past init.
 *
 *  ## Bounded on PROGRESS, so a genuinely SLOW boot is never restarted
 *
 *  `firstMessageSeen === false` alone is not enough: a heavy but healthy boot is
 *  briefly in exactly that state. The predicate ALSO requires the stream to have
 *  been silent for the full {@link GATE_SILENCE_RELEASE_MS} window since spawn —
 *  and `lastStreamAt` is stamped at spawn and bumped by EVERY stream message, so
 *  the instant a slow boot emits its first message BOTH `firstMessageSeen` flips
 *  true AND the silence clock resets. A boot that eventually starts its first
 *  turn can never satisfy this, however long its init took. This is the same
 *  progress-not-duration argument as {@link decideGateRelease}, and it is the
 *  ticket's must-FAIL arm: the slow-boot session stays green.
 *
 *  The verdict is shaped as a {@link QueueStallVerdict}-compatible
 *  `{ parkedCount, stalledForMs }` so it feeds the SAME
 *  {@link decideSessionRecycle} the layer-2 stall path uses — inheriting its
 *  anti-flap budget, widening backoff, and progress refusal rather than
 *  duplicating that safety machinery (a second copy is how a healthy agent
 *  eventually gets recycled). `parkedCount` is the count of opening prompts
 *  still owed a turn (`pendingPromptCount`), for the log/telemetry line. */
export interface BootWedgeInput {
  /** True iff a live (non-stopping) structured session owns this workspace. */
  sessionLive: boolean;
  /** Whether the SDK stream has EVER produced a message for this session —
   *  proof the CLI got past init and started consuming. The whole discriminator
   *  turns on this: false + silent = boot-wedged; true = past init, so this
   *  predicate stands down and the layer-1/layer-2 paths own it from here. */
  firstMessageSeen: boolean;
  /** A turn is in flight (`session.turnGate !== null`) — the opening turn was
   *  accepted by the generator and yielded to the SDK. Without a turn in flight
   *  there is nothing wedged in the sense this predicate treats (the session is
   *  simply idle between turns, or has not been sent anything). */
  turnInFlight: boolean;
  /** Opening prompts still owed a turn (`ws.sdkPendingPrompts.length`). At least
   *  one must be outstanding, or there is no work to have wedged ON — and it is
   *  what the auto-heal re-delivers after the recycle. */
  pendingPromptCount: number;
  /** Epoch ms of the last message seen on the SDK stream. Stamped at spawn,
   *  bumped by every stream message — the progress clock. */
  lastStreamAt: number;
  /** True while the session is tearing down; teardown handles its own turn. */
  stopping: boolean;
  /** Epoch ms now. */
  now: number;
  /** Silence window; the SAME constant layer 1 uses, injectable for tests. */
  silenceMs?: number;
}

/** Whether a session is BOOT-WEDGED: it accepted an opening turn, never emitted
 *  a single stream message, and has been silent for the whole window since
 *  spawn. Returns a recycle-ready verdict, or null when it is not boot-wedged.
 *
 *  Every guard is load-bearing:
 *   1. **A live session, or nothing to treat.** No session ⇒ not this defect.
 *   2. **PROOF OF LIFE refusal.** Any stream message ever ⇒ the CLI got past
 *      init; this predicate stands down (the started-turn wedge is layer 1/2).
 *      This is the must-FAIL arm's guard: a slow boot that emitted `system/init`
 *      is refused here.
 *   3. **A turn must actually be in flight.** An idle session between turns is
 *      not wedged.
 *   4. **An opening prompt must be outstanding.** Something must have wedged ON,
 *      and it is what the heal re-delivers.
 *   5. **Not while stopping.** Teardown owns the turn.
 *   6. **PROGRESS bound.** Silent for the whole window — the reset-on-first-
 *      message clock is what makes a slow-but-live boot safe. */
export function decideBootWedge(input: BootWedgeInput): QueueStallVerdict | null {
  const {
    sessionLive,
    firstMessageSeen,
    turnInFlight,
    pendingPromptCount,
    lastStreamAt,
    stopping,
    now,
    silenceMs = GATE_SILENCE_RELEASE_MS,
  } = input;

  if (!sessionLive) return null;
  // 2. PROOF OF LIFE — the discriminator. A single stream message is proof the
  //    CLI got past init, so this predicate stands down (the slow-boot must-FAIL
  //    arm). NEVER "prompts are live" and NEVER "inbox empty".
  if (firstMessageSeen) return null;
  if (!turnInFlight) return null;
  if (pendingPromptCount <= 0) return null;
  if (stopping) return null;
  // 6. PROGRESS bound: silent for the full window since spawn. A slow boot resets
  //    lastStreamAt the instant it emits, so it can never reach here.
  const stalledForMs = now - lastStreamAt;
  if (stalledForMs < silenceMs) return null;

  return {
    parkedCount: pendingPromptCount,
    queuedCount: 0,
    parkedInboxCount: 0,
    stalledForMs,
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
