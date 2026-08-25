// Queue-stall detection (issue #88) — "work is piling up here and NOTHING is
// eating it", whatever the cause.
//
// ── The field failure this exists for ────────────────────────────────────────
//
// Twice in one day a fleet froze silently and the HUMAN was the detector. A
// coordinator stopped consuming turns — a dead keeper, an exhausted budget, a
// wedged session, it does not matter which — while peers kept handing it work.
// The messages parked correctly, the queue grew correctly, nothing errored, and
// no surface said a word. The convention that caught it was a human remembering
// to ask "has anyone heard from the lead lately?". This module makes that
// convention mechanical.
//
// CAUSE-AGNOSTIC IS THE POINT. This deliberately does not try to explain WHY a
// workspace stopped consuming. It reports the SYMPTOM — deliveries parked, no
// turn started in N minutes — which is the one observation that is true of
// every cause including the ones nobody has thought of yet. A detector that
// enumerates causes can only catch causes already enumerated, and the incident
// that motivated this ticket was, twice, a cause nobody had enumerated.
//
// ── Why it is the COMPLEMENT of #69, not an overlay on it ────────────────────
//
// #69 surfaces `lastStopReason` (`max_turns` / `error` / `usage_limit`) with a
// distinct glyph naming the cause, and #74 auto-resumes the `usage_limit` case.
// Those are the freezes whose cause is KNOWN. This module stands down for all
// of them (see `knownStopReason` below): a badge that shouts "stalled, cause
// unknown" next to a glyph that states the cause is strictly less informative
// than the glyph alone, and on the `usage_limit` case it would additionally
// undo a deliberate design decision — that glyph is the calmest of the three
// precisely because the condition resolves by itself and the app is already
// acting on it (see WorkspaceStatusGlyph.tsx). What is left over — a workspace
// that is simply not consuming, for no reason anything recorded — is exactly
// the residual this ticket names, and exactly what nothing else covers.
//
// ── Pure and total, deliberately ─────────────────────────────────────────────
//
// Same shape and the same reason as `usage-resume.ts`: the whole policy is one
// function over plain data, so it is testable without Electron, without a
// running agent, and without waiting out a real 15-minute stall. The wiring in
// prompt-queue.ts only gathers the inputs and broadcasts the verdict.

import type { AgentStopReason, Workspace, WorkspaceStatus } from './types.ts';
import { isActionableStopReason } from './usage-resume.ts';

/** How long a workspace may hold parked work without starting a turn before it
 *  is reported as stalled. 15 minutes.
 *
 *  NOT a measured figure and this comment is the honest record of that: the
 *  turn-duration distribution across a real fleet is UNBASELINED. The bound is
 *  reasoned, not observed — it must sit above any legitimate single turn (a
 *  full build, a test suite, a headless E2E boot all run for minutes with no
 *  NEW turn start) and far below the hours-long latency the ticket reports for
 *  a human noticing on their own.
 *
 *  The safety of the choice does not actually rest on the number, which is why
 *  a soft justification is acceptable here: a workspace that is mid-turn is
 *  `running`, and {@link decideQueueStall} refuses to badge a running
 *  workspace at all. So a long turn cannot trip this no matter how small N
 *  gets. N only governs how long an ALREADY-IDLE workspace with parked work is
 *  given before it is called stalled.
 *
 *  Not user-configurable in v1 — a setting is a second thing to get wrong and
 *  nobody has yet had cause to want a different value. */
export const QUEUE_STALL_THRESHOLD_MS = 15 * 60 * 1000;

export interface QueueStallInput {
  /** Live workspace status. A `running` workspace is consuming by definition
   *  and is never stalled — see the guard. */
  status: WorkspaceStatus;
  /** Why the last turn ended. When this is an ACTIONABLE reason, #69 already
   *  owns the row's explanation and this module stands down. */
  lastStopReason?: AgentStopReason;
  /** Prompts parked on the banner queue (`Workspace.queuedPrompts`). */
  queuedCount: number;
  /** Peer messages parked on disk in this workspace's inbox file
   *  (`~/.orchestra/inbox/<id>.txt`), counted by main. */
  parkedInboxCount: number;
  /** Epoch ms of the last observed TURN START, or undefined when this
   *  workspace has never started one. */
  lastTurnStartAt?: number;
  /** Epoch ms this workspace was created — the fallback clock for a workspace
   *  that has never taken a turn. Without it, a brand-new workspace with a
   *  parked message would have an infinite stall age and badge instantly. */
  createdAt: number;
  /** True while the agent's process is deliberately stopped by the user
   *  (hibernated). A hibernated workspace is not consuming ON PURPOSE. */
  hibernated: boolean;
  /** Epoch ms this Orchestra process became able to observe turn starts —
   *  i.e. app/renderer start (review-88 R1). The stall age is measured from
   *  `max(lastTurnStartAt, observableSince)`, never from the raw stamp.
   *
   *  ## Why this is REQUIRED and not a refinement
   *
   *  `lastTurnStartAt` persists across a restart; the `status` it pairs with
   *  does NOT — `store.load()` floors every `running`/`waiting` to `idle`
   *  because no process survives a quit. So without this, the age of a
   *  perfectly healthy agent includes THE ENTIRE TIME THE APP WAS CLOSED, and
   *  every guard passes: parked count non-zero (`reconcileParkedCounts` counts
   *  mail parked during downtime — by design), status floored to `idle`, stop
   *  reason cleared by the last clean finish, age = hours.
   *
   *  MEASURED 2026-08-25 on this machine: 3–5 workspaces (the count drifts as
   *  hooks drain) were holding parked mail while healthy, idle and mid-wave —
   *  including the wave's own coordinator and build-verifier. Close the app
   *  overnight, reopen, and every one of them would have badged "stalled 14h"
   *  at once. A false alarm on a healthy agent is the failure that makes a
   *  human ignore the badge forever, so this is the defect that mattered most
   *  in the whole ticket, and the E2E rig could not see it: the rig SEEDS the
   *  restart state and reads those same bytes as a stall.
   *
   *  Deliberately a FLOOR rather than a reset of the stored value: the recorded
   *  turn start stays a true fact about the workspace, and the correction lives
   *  where the decision is made. It also gives the right answer for free after
   *  a renderer reload, which is likewise a point past which nothing earlier
   *  was observed. */
  observableSince: number;
  /** Epoch ms now. */
  now: number;
}

export interface QueueStallVerdict {
  /** Total parked items — the badge's number. */
  parkedCount: number;
  /** How many of those are banner-queued prompts. */
  queuedCount: number;
  /** How many of those are parked inbox messages. */
  parkedInboxCount: number;
  /** How long since the last turn start (or creation), in ms. Drives the
   *  "stalled 22min" half of the tooltip. */
  stalledForMs: number;
}

/** Whether a stop reason means the cause is ALREADY explained on the row by
 *  #69's glyph — in which case this detector stands down. Routed through the
 *  shared predicate rather than re-listing the reasons, because that predicate
 *  exists specifically to stop a sixth hardcoded copy of the allowlist from
 *  drifting (see ACTIONABLE_STOP_REASONS). A new actionable reason added there
 *  automatically suppresses this badge too, which is the correct default: if a
 *  reason is worth its own glyph, it is not an unknown-cause stall. */
function causeAlreadyExplained(reason: AgentStopReason | undefined): boolean {
  return isActionableStopReason(reason);
}

/** Decide whether ONE workspace is queue-stalled. Returns the verdict, or null
 *  when it is not stalled.
 *
 *  Every guard is load-bearing and the order is deliberate:
 *
 *   1. **Nothing parked → nothing to be stalled ON.** An idle workspace with an
 *      empty queue is just idle; that is the normal resting state of nearly
 *      every workspace in the tree and badging it would make the badge
 *      meaningless. The badge asserts "work is WAITING", so work must be
 *      waiting.
 *   2. **`running` → consuming.** This is the negative arm the ticket
 *      demands: parked deliveries on a workspace that IS taking turns must not
 *      badge. It is also what makes the threshold safe (see
 *      {@link QUEUE_STALL_THRESHOLD_MS}) — a long turn holds `running` and can
 *      never trip this, however slow it is.
 *   3. **Hibernated → stopped on purpose.** The human stopped this process;
 *      reporting their own deliberate act back to them as an anomaly is noise.
 *      The hibernated chip already says so.
 *   4. **Known cause → #69 owns the row.** See the module header.
 *   5. **Age.** Measured from the last turn start, falling back to
 *      `createdAt` for a workspace that has never taken one — a real state (a
 *      spawned agent whose session never came up is precisely a stall worth
 *      catching), and using creation time means such a workspace is given the
 *      same grace period as any other rather than badging the instant a
 *      message lands.
 *
 *  Derived fresh from live fields on every call rather than stored: a
 *  PERSISTED `stalled` flag is a claim that can outlive the condition it
 *  describes, and a badge that fails to clear is worse than no badge. */
export function decideQueueStall(input: QueueStallInput): QueueStallVerdict | null {
  const {
    status,
    lastStopReason,
    queuedCount,
    parkedInboxCount,
    lastTurnStartAt,
    createdAt,
    hibernated,
    observableSince,
    now,
  } = input;

  // 1. Something must actually be waiting.
  const parkedCount = queuedCount + parkedInboxCount;
  if (parkedCount <= 0) return null;

  // 2. A workspace mid-turn is consuming.
  if (status === 'running') return null;

  // 3. Deliberately stopped is not stalled.
  if (hibernated) return null;

  // 4. A cause the human can already read off the row is not an unknown stall.
  if (causeAlreadyExplained(lastStopReason)) return null;

  // 5. Long enough since anything was consumed here.
  //
  // Floored at `observableSince` (review-88 R1): a turn start recorded BEFORE
  // this process could observe anything says nothing about whether the agent
  // is consuming NOW, and counting the app's own downtime as stall time makes
  // every healthy workspace with parked mail badge on the first restart. After
  // a restart the age therefore starts from zero and has to be earned by real
  // observed silence — which is the only kind this detector can honestly claim.
  const recorded = lastTurnStartAt ?? createdAt;
  const since = Math.max(recorded, observableSince);
  const stalledForMs = now - since;
  if (stalledForMs < QUEUE_STALL_THRESHOLD_MS) return null;

  return { parkedCount, queuedCount, parkedInboxCount, stalledForMs };
}

/** Read the verdict off a real workspace record, so callers do not re-derive
 *  which field feeds which input. Kept beside the policy for the same reason
 *  `isCoordinatorWorkspace` sits beside `decideResume`. */
export function workspaceQueueStall(
  ws: Pick<
    Workspace,
    | 'status'
    | 'lastStopReason'
    | 'queuedPrompts'
    | 'parkedInboxCount'
    | 'lastTurnStartAt'
    | 'createdAt'
    | 'hibernatedAt'
    | 'archived'
  >,
  now: number,
  /** See {@link QueueStallInput.observableSince}. Required — defaulting it to 0
   *  would silently restore the R1 false-alarm, and a parameter whose wrong
   *  value is invisible is one every future caller gets wrong. */
  observableSince: number,
): QueueStallVerdict | null {
  // An archived workspace has no live agent behind it — its status is a frozen
  // leftover, so every liveness claim about it is unsupported. Same exclusion
  // the status glyph makes.
  if (ws.archived) return null;
  return decideQueueStall({
    status: ws.status,
    lastStopReason: ws.lastStopReason,
    queuedCount: ws.queuedPrompts?.length ?? 0,
    parkedInboxCount: ws.parkedInboxCount ?? 0,
    lastTurnStartAt: ws.lastTurnStartAt,
    createdAt: ws.createdAt,
    hibernated: ws.hibernatedAt !== undefined,
    observableSince,
    now,
  });
}
