// The liveness + phase DECISION — pure, so it is unit- and mutation-testable
// without a bus, a session or an Electron main process (issue #120, ledger #125).
//
// The effectful half lives in src/main/bus-liveness.ts. Everything policy-shaped
// is here for the same reason #117 split `decideWake` and #90 split
// `decideSessionRecycle`: a rule that can only be exercised through a live app is
// a rule nobody re-tests once it ships.
//
// ── What #120 is, frozen on #108 Q16 (the hybrid's ruling) ──────────────────
//
// LIVENESS is DERIVED BY THE APP from real session activity (turn start/end,
// tool calls — the signals the status dot already consumes), NEVER emitted by an
// agent. A member with a dispatched task and no activity for STALE_AFTER_MS →
// the app writes an `escalation` message row to its COORDINATOR (OPS for a
// worker, LEAD for an OPS) — ONCE per silence, cleared on activity. A member in
// `waiting` (parked on an ask/gate, #119's concept — or the app-level
// needs-input `waiting` status) is EXCLUDED: it is silent on purpose.
//
// PHASE is the existing status note (`orchestra status`): every CHANGE writes a
// `status` message row, with NO timer. That half lives at the note's write
// chokepoint (workspaces.ts `dispatchStatusRequest`), not in the sweep.
//
// ── The dead-vs-slow-reader trap (acceptance 2) ─────────────────────────────
//
// A member running an 8-minute build is ALIVE, not stale. A naive
// `now - lastActivity > threshold` cannot tell a dead session from a slow one:
// both look identical to a wall-clock timer once the clock ages past the bound.
// So the decision binds on PROGRESS, not on idle time alone: a member whose
// session is CURRENTLY RUNNING (a turn is in flight — `pretool`/`submit` moved
// the status to `running` and no turn-end has cleared it) is alive regardless of
// how old its last discrete activity stamp is. The activity clock catches the
// gap BETWEEN turns; the running flag catches an in-flight long tool call. This
// is the same bound-on-progress rule ~/.claude/LESSONS.md names for timeouts.

/** How long a member with a dispatched task may be silent (and not running, not
 *  waiting) before the app escalates to its coordinator. #108 Q16: 10 minutes. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

// ── Liveness v2 (#127): the per-tool-class PROGRESS ceiling ──────────────────
//
// The staleness bound above catches a silent-BETWEEN-turns member. It cannot
// catch a member HUNG mid-tool-call: a `pretool` moves the status to `running`
// and stamps activity, and if no `posttool`/`stop` ever follows, the clock
// freezes and `running` stays true forever — `decideEscalation`'s `running`
// guard then skips it unconditionally (the #90 wedge class: process alive,
// status stuck running, no tool result, no exit).
//
// So a member that is `running` is NOT trusted blindly: if a tool call has been
// in flight past its per-tool-class ceiling WITH ZERO PROGRESS, it is escalated
// like any other stall. This is a PROGRESS bound, not a duration bound
// (~/.claude/LESSONS.md; wave-8): a live tool call emits a `posttool` (which
// advances the activity clock) or a status change; only a call that has emitted
// NOTHING for the whole ceiling is flagged. The dead-vs-slow-reader trap
// (acceptance 2) is exactly what the ceiling-plus-progress pair separates: an
// 8-minute build is a live Bash call that either finishes inside its own 600s
// tool cap (a posttool = progress) or keeps its stream alive; a hung MCP/browser
// call emits nothing and outlives its ceiling.

/** Per-tool-class ceiling: how long a single tool call of this class may run
 *  WITH NO PROGRESS before the member is treated as hung.
 *
 *  The classes and their reasoning:
 *   - `Bash` → 600s. The SDK Bash tool's own `timeout` param maxes at 600000 ms
 *     (enforced by the `claude` binary), so a healthy Bash call ALWAYS emits a
 *     tool result (a `posttool`, i.e. progress) at or before 600s. A ceiling
 *     equal to that cap means a legitimate max-length Bash call is never flagged
 *     while its FIRST silent tick past the cap — where no result came and none
 *     ever will — is (the exact hung/timed-out boundary).
 *   - MCP / browser / web tools → a HIGHER ceiling. These have NO built-in cap
 *     and may legitimately run long (a headless E2E, a slow remote MCP server),
 *     so the ceiling is set well above any plausible legitimate call rather than
 *     risk cutting one off. UNBASELINED — no fleet distribution of longest
 *     legitimate MCP-call durations exists — so it is a conservative FLOOR, the
 *     same posture as GATE_SILENCE_RELEASE_MS's header states.
 *   - anything else → the conservative default (same as the uncapped class): an
 *     unknown tool is treated as possibly-uncapped, the safe direction (a longer
 *     ceiling never escalates a live call; a shorter one might).
 *
 *  A call whose tool name was unknown at start (`null`, a legacy hook line) gets
 *  the conservative default too. */
export const BASH_TOOL_CEILING_MS = 10 * 60 * 1000; // 600s — matches the Bash tool cap
export const UNCAPPED_TOOL_CEILING_MS = 30 * 60 * 1000; // MCP/browser/web/unknown: a long floor

export function toolClassCeilingMs(tool: string | null | undefined): number {
  if (tool === 'Bash') return BASH_TOOL_CEILING_MS;
  // Everything else — MCP tools (`mcp__*`), the embedded browser, WebFetch/
  // WebSearch, custom SDK tools, and any unknown/legacy-null name — is treated as
  // possibly-uncapped and gets the long floor. Naming Bash explicitly (the one
  // class with a proven internal cap) rather than allow-listing the uncapped set
  // keeps a NEW tool safe by default: it never escalates a live call early.
  return UNCAPPED_TOOL_CEILING_MS;
}

/** What the sweep knows about ONE member, read from the app's OWN activity
 *  signals (the status dot's sources) plus durable bus state. All timestamps are
 *  epoch ms. Nothing here is emitted by the agent — it is all host-derived. */
export interface MemberLivenessState {
  /** The member's handle — a workspace id (matches #115's `--as` default and the
   *  wake roster's `reader`). */
  reader: string;
  /** The coordinator this member escalates TO (its `parentId`, resolved to a
   *  live workspace id). `null` when the member has no resolvable coordinator —
   *  such a member is never escalated, because there is nobody to escalate to. */
  coordinator: string | null;
  /** True when this member was DISPATCHED work (a spawned agent carries a
   *  `lastTask`). A hand-made UI workspace with no task is not a fleet member and
   *  is never escalated. */
  hasTask: boolean;
  /** Last host-observed activity for this member (`getLastActivity`), or
   *  `undefined` when nothing has been seen this app run — in which case the
   *  caller floors it at app-start, so a just-launched app never escalates on a
   *  stale/absent clock. */
  lastActivityAt: number | undefined;
  /** The app-start floor — used when `lastActivityAt` is undefined. */
  appStartedAt: number;
  /** True when a turn is CURRENTLY IN FLIGHT (status === 'running'): the member
   *  is provably alive even if its last discrete activity stamp is old. This is
   *  the anti-trap signal (acceptance 2). */
  running: boolean;
  /** True when the member is PARKED and expected to be silent: the app-level
   *  needs-input `waiting` status, OR #119's bus `waiting` (an asker parked on an
   *  open ask/gate). Either way it is excluded from staleness (acceptance/T120.4). */
  waiting: boolean;
  /** Liveness v2 (#127): EVERY tool call currently in flight for this member
   *  (empty when none is running). Host-derived from `applyAgentEvent`'s
   *  `pretool`/`posttool` chokepoint (no new probe). A LIST, not one slot, because
   *  parallel `tool_use` is the common case and a hung call must not be masked by
   *  a fast sibling (review-127 F1). A call still in this list IS the zero-progress
   *  signal — its `posttool` never arrived. */
  inFlightTools?: readonly InFlightToolState[];
}

/** One in-flight tool call the progress bound reasons about. Mirrors the leaf
 *  tracker in hibernation-activity.ts, kept as a shared type so the pure policy
 *  is testable without importing the main-process tracker. */
export interface InFlightToolState {
  /** The tool name as seen at call start, or `null` when unknown. */
  tool: string | null;
  /** Epoch ms the call started (the `pretool` event). */
  startedAt: number;
}

export type EscalationAction =
  /** Write an `escalation` row to `coordinator` about `reader`. `hungTool`, when
   *  set, is the tool name of an in-flight call that blew its ceiling (#127) —
   *  the escalation is about a HUNG CALL, not between-turns silence, so the body
   *  reads differently. Absent = a staleness escalation (the #120 path). */
  | {
      kind: 'escalate';
      reader: string;
      coordinator: string;
      silentForMs: number;
      hungTool?: string | null;
    }
  /** The switch is OFF: count a would-have-escalated, write nothing (standing
   *  ruling — COUNTED, not FIRED). */
  | {
      kind: 'count';
      reader: string;
      coordinator: string;
      silentForMs: number;
      hungTool?: string | null;
    }
  /** Nothing to do. `why` names which guard held, so a gate can assert WHICH
   *  clause fired rather than merely "no escalation". */
  | { kind: 'skip'; reader: string; why: EscalationSkip };

export type EscalationSkip =
  | 'no-task' // not a dispatched member
  | 'no-coordinator' // nobody to escalate to
  | 'running' // a turn is in flight AND making progress — alive (the anti-trap)
  | 'waiting' // parked on an ask / needs-input — silent on purpose
  | 'fresh' // activity within the threshold — alive
  | 'already-escalated'; // one escalation per silence — dedup holds

/** What the sweep remembers between ticks — the dedup ledger, analogous to
 *  #117's wake ledger. Presence IS the dedup for the SAME action: a member
 *  already FIRED this silence is not fired again; a member already COUNTED this
 *  silence is not counted again (no count-storm). But a prior COUNT does NOT
 *  suppress a FIRE — that is the switch-flip-ON case (F1, review-120): a member
 *  continuously stale across an OFF→ON flip was counted while OFF and MUST still
 *  escalate exactly once when the switch turns ON. Cleared by
 *  `pruneEscalationLedger` on activity (acceptance 1). */
export interface EscalationLedgerEntry {
  /** `lastActivityAt` at the moment we acted — carried for the log line and the
   *  gate's assertions, deliberately NOT part of the suppression test (which keys
   *  on PRESENCE + `fired`, the #117 lesson: a high-water compare re-fires on
   *  rising values). */
  escalatedAtActivity: number | undefined;
  /** True once a real escalation ROW was written for this silence (the switch was
   *  ON). A `count`-only entry has `fired: false` and does NOT suppress the first
   *  fire after a switch flips ON. */
  fired: boolean;
}

/**
 * Decide what to do about ONE member on ONE sweep tick.
 *
 * Guard order is deliberate and each guard's disproof is a distinct skip reason:
 *   1. no dispatched task  → not a fleet member
 *   2. no coordinator      → nobody to escalate to
 *   3. running             → a turn is in flight AND making progress: ALIVE
 *                            (acceptance 2 anti-trap). BUT a running member whose
 *                            in-flight tool call has blown its per-tool-class
 *                            ceiling with ZERO progress is HUNG (#127) and falls
 *                            through to escalation — this is the progress bound.
 *   4. waiting             → parked on purpose (T120.4)
 *   5. fresh               → activity within STALE_AFTER_MS: ALIVE
 *   6. already-escalated   → one per silence (acceptance 1)
 * Only past all six does it escalate (or count, switch-gated).
 *
 * `running`/`waiting` are checked BEFORE the wall-clock staleness test on
 * purpose: a member that is running or waiting is alive/parked no matter how old
 * its discrete activity stamp is, and testing the clock first would let a
 * slow-but-live 8-min build fall through to `escalate` (the exact trap). The
 * #127 progress bound is checked INSIDE the running guard so it applies ONLY to
 * a running member (a not-running member is caught by the staleness clock below).
 */
export function decideEscalation(
  m: MemberLivenessState,
  previous: EscalationLedgerEntry | undefined,
  now: number,
  switchOn: boolean,
): EscalationAction {
  if (!m.hasTask) return { kind: 'skip', reader: m.reader, why: 'no-task' };
  if (!m.coordinator) return { kind: 'skip', reader: m.reader, why: 'no-coordinator' };
  const coordinator = m.coordinator;
  // ANTI-TRAP + #127 progress bound: a turn in flight is alive regardless of the
  // discrete clock's age — UNLESS its in-flight tool call has exceeded its
  // per-tool-class ceiling with zero progress, which is the #90 hung-mid-call
  // wedge (process alive, status stuck running, no result, no exit). Only that
  // one case falls through; every other running member is skipped as before.
  if (m.running) {
    const hung = hungCall(m, now);
    if (hung === null) return { kind: 'skip', reader: m.reader, why: 'running' };
    // Hung mid-call → treat as a stall, sharing the dedup/switch resolution with
    // the staleness path. `silentForMs` here is the hung call's elapsed-in-call,
    // so the escalation body reports how long THAT call has been stuck. The 6th
    // arg carries the hung tool name (may be null when unknown at call start),
    // which flags the action as a hung-call escalation.
    return resolveStall(coordinator, hung.elapsedMs, previous, switchOn, m.reader, {
      tool: hung.tool,
    });
  }
  // Parked on an ask / needs-input: silent on purpose, never stale (T120.4).
  if (m.waiting) return { kind: 'skip', reader: m.reader, why: 'waiting' };
  const last = m.lastActivityAt ?? m.appStartedAt;
  const silentForMs = now - last;
  if (silentForMs <= STALE_AFTER_MS) {
    return { kind: 'skip', reader: m.reader, why: 'fresh' };
  }
  // Past the threshold, silent, with a task and a coordinator, not running, not
  // waiting → stale. No hung-tool context (this is between-turns silence).
  return resolveStall(coordinator, silentForMs, previous, switchOn, m.reader, undefined);
}

/** The MOST-OVERDUE hung tool call for a running member — the in-flight call
 *  whose elapsed-in-call most exceeds its per-tool-class ceiling — or `null` when
 *  no in-flight call is past its ceiling (the member is alive).
 *
 *  ## Progress is per-CALL, via list membership — NOT the global activity clock
 *
 *  A tool call in `inFlightTools` has, by construction, not yet had its
 *  `posttool` (which removes it from the list keyed on its own toolUseId). So
 *  membership past the ceiling IS the zero-progress signal. This is what fixes
 *  review-127 F1: the OLD single-slot design read the shared `lastActivityAt`,
 *  which a FAST parallel call's posttool advances — falsely marking a HUNG
 *  sibling as "progress observed" and never escalating it. Per-call membership
 *  cannot be fooled by a sibling: only the hung call's own (never-arriving)
 *  posttool clears it.
 *
 *  Each call is measured against ITS OWN class ceiling (Bash 600s, MCP/browser/
 *  unknown 30min), so a hung Bash and a legitimately-long MCP call are judged
 *  correctly side by side. `>=` on the ceiling (not `>`) makes the boundary tick
 *  the first flag. Returns the call with the largest `elapsed - ceiling` so the
 *  escalation names the worst offender. */
function hungCall(m: MemberLivenessState, now: number): { tool: string | null; elapsedMs: number } | null {
  const calls = m.inFlightTools;
  if (!calls || calls.length === 0) return null; // running but no call in flight — alive
  let worst: { tool: string | null; elapsedMs: number; over: number } | null = null;
  for (const call of calls) {
    const elapsed = now - call.startedAt;
    const ceiling = toolClassCeilingMs(call.tool);
    if (elapsed < ceiling) continue; // this call is under its ceiling — still alive
    const over = elapsed - ceiling;
    if (worst === null || over > worst.over) {
      worst = { tool: call.tool, elapsedMs: elapsed, over };
    }
  }
  return worst ? { tool: worst.tool, elapsedMs: worst.elapsedMs } : null;
}

/** The shared dedup + switch resolution for a member decided to be stalled
 *  (either by the staleness clock or by the #127 progress bound). Extracted so
 *  both stall paths share ONE copy of the F1 switch-flip and count-storm rules —
 *  N copies is how the two paths would drift (LESSONS: collapse a rule stated in
 *  N places to one). `silentForMs` is the figure the escalation reports. */
function resolveStall(
  coordinator: string,
  silentForMs: number,
  previous: EscalationLedgerEntry | undefined,
  switchOn: boolean,
  reader: string,
  /** Present iff this is a #127 hung-tool-call escalation; `tool` is the hung
   *  tool's name (may be null when unknown). Absent = a #120 staleness stall. */
  hung: { tool: string | null } | undefined,
): EscalationAction {
  // Dedup (F1, review-120): a member already FIRED this silence never fires or
  // counts again. But a prior COUNT-only entry (switch was OFF) does NOT suppress
  // a FIRE — otherwise a member continuously stale across an OFF→ON flip, having
  // been counted while OFF, would be marked `already-escalated` and NEVER
  // escalate after the switch turns ON (the first real escalation silently lost).
  // So: suppress iff we already fired, OR we are only about to count again.
  if (previous?.fired) return { kind: 'skip', reader, why: 'already-escalated' };
  if (!switchOn) {
    // Switch OFF → count, but only ONCE per silence (a prior count suppresses a
    // second count — no 60×/min count-storm, the #117 lesson).
    if (previous) return { kind: 'skip', reader, why: 'already-escalated' };
    return hung
      ? { kind: 'count', reader, coordinator, silentForMs, hungTool: hung.tool }
      : { kind: 'count', reader, coordinator, silentForMs };
  }
  // Switch ON → fire (whether or not it was previously counted while OFF).
  return hung
    ? { kind: 'escalate', reader, coordinator, silentForMs, hungTool: hung.tool }
    : { kind: 'escalate', reader, coordinator, silentForMs };
}

/**
 * Drop ledger entries for members that are no longer stale, so a member that
 * resumed activity RE-ARMS: its next silence produces a NEW escalation
 * (acceptance 1, "silence again → a new one").
 *
 * Keyed on the CURRENT sweep's stale set rather than on an activity EVENT: like
 * #117's `pruneWakeLedger`, the sweep is level-triggered over durable/observed
 * state, and an activity stamp that landed while the app was busy emits no event
 * this could have subscribed to. Reading who is stale NOW and pruning everyone
 * else is the only shape that re-arms correctly across a restart.
 */
export function pruneEscalationLedger(
  ledger: Map<string, EscalationLedgerEntry>,
  stillStale: ReadonlySet<string>,
): void {
  for (const reader of [...ledger.keys()]) {
    if (!stillStale.has(reader)) ledger.delete(reader);
  }
}

/** True when a phase note genuinely CHANGED, so the caller writes a `status` row
 *  only on a real transition and an unchanged re-set writes zero (acceptance 3's
 *  positive control). Both sides are the SANITIZED note text; an absent note is
 *  the empty string, so "cleared → cleared" and "same text re-set" both return
 *  false. Pure and here so the zero-control is mutation-tested without importing
 *  workspaces.ts (which cannot load under the strip-types test runner). */
export function phaseChanged(prev: string, next: string): boolean {
  return prev !== next;
}

/** The body of an `escalation` message row: names the silent member and how long
 *  it has been silent, so the coordinator's `orchestra check` surfaces something
 *  actionable rather than an opaque ping. Kept in the pure module so a test
 *  asserts the exact rendered string (carry-forward 2: a marker as specific as
 *  the claim). */
export function escalationBody(reader: string, silentForMs: number): string {
  const mins = Math.floor(silentForMs / 60_000);
  return `member ${reader} has a dispatched task and no session activity for ${mins}m — check on it`;
}

/** The body of a HUNG-TOOL-CALL escalation row (#127): a member whose in-flight
 *  tool call blew its per-tool-class ceiling with zero progress — the #90 wedge
 *  class. Names the tool so the coordinator's `orchestra check` says which call
 *  is stuck, not just that the member is silent (a running member is NOT silent
 *  by the activity clock, so the #120 body would misdescribe it). Kept pure so a
 *  test asserts the exact string (carry-forward 2). `tool` is `null` when the
 *  name was unknown at call start. */
export function hungCallEscalationBody(
  reader: string,
  tool: string | null,
  elapsedMs: number,
): string {
  const mins = Math.floor(elapsedMs / 60_000);
  const toolName = tool ?? 'a tool';
  return `member ${reader} has a dispatched task and its ${toolName} call has been running ${mins}m with no progress — it may be hung mid-call; check on it`;
}
