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
}

export type EscalationAction =
  /** Write an `escalation` row to `coordinator` about `reader`. */
  | { kind: 'escalate'; reader: string; coordinator: string; silentForMs: number }
  /** The switch is OFF: count a would-have-escalated, write nothing (standing
   *  ruling — COUNTED, not FIRED). */
  | { kind: 'count'; reader: string; coordinator: string; silentForMs: number }
  /** Nothing to do. `why` names which guard held, so a gate can assert WHICH
   *  clause fired rather than merely "no escalation". */
  | { kind: 'skip'; reader: string; why: EscalationSkip };

export type EscalationSkip =
  | 'no-task' // not a dispatched member
  | 'no-coordinator' // nobody to escalate to
  | 'running' // a turn is in flight — alive (the anti-trap)
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
 *   3. running             → a turn is in flight: ALIVE (acceptance 2 anti-trap)
 *   4. waiting             → parked on purpose (T120.4)
 *   5. fresh               → activity within STALE_AFTER_MS: ALIVE
 *   6. already-escalated   → one per silence (acceptance 1)
 * Only past all six does it escalate (or count, switch-gated).
 *
 * `running`/`waiting` are checked BEFORE the wall-clock staleness test on
 * purpose: a member that is running or waiting is alive/parked no matter how old
 * its discrete activity stamp is, and testing the clock first would let a
 * slow-but-live 8-min build fall through to `escalate` (the exact trap).
 */
export function decideEscalation(
  m: MemberLivenessState,
  previous: EscalationLedgerEntry | undefined,
  now: number,
  switchOn: boolean,
): EscalationAction {
  if (!m.hasTask) return { kind: 'skip', reader: m.reader, why: 'no-task' };
  if (!m.coordinator) return { kind: 'skip', reader: m.reader, why: 'no-coordinator' };
  // ANTI-TRAP: a turn in flight is alive regardless of the discrete clock's age.
  if (m.running) return { kind: 'skip', reader: m.reader, why: 'running' };
  // Parked on an ask / needs-input: silent on purpose, never stale (T120.4).
  if (m.waiting) return { kind: 'skip', reader: m.reader, why: 'waiting' };
  const last = m.lastActivityAt ?? m.appStartedAt;
  const silentForMs = now - last;
  if (silentForMs <= STALE_AFTER_MS) {
    return { kind: 'skip', reader: m.reader, why: 'fresh' };
  }
  // Past the threshold, silent, with a task and a coordinator, not running, not
  // waiting → stale.
  //
  // Dedup (F1, review-120): a member already FIRED this silence never fires or
  // counts again. But a prior COUNT-only entry (switch was OFF) does NOT suppress
  // a FIRE — otherwise a member continuously stale across an OFF→ON flip, having
  // been counted while OFF, would be marked `already-escalated` and NEVER
  // escalate after the switch turns ON (the first real escalation silently lost).
  // So: suppress iff we already fired, OR we are only about to count again.
  if (previous?.fired) return { kind: 'skip', reader: m.reader, why: 'already-escalated' };
  const coordinator = m.coordinator;
  if (!switchOn) {
    // Switch OFF → count, but only ONCE per silence (a prior count suppresses a
    // second count — no 60×/min count-storm, the #117 lesson).
    if (previous) return { kind: 'skip', reader: m.reader, why: 'already-escalated' };
    return { kind: 'count', reader: m.reader, coordinator, silentForMs };
  }
  // Switch ON → fire (whether or not it was previously counted while OFF).
  return { kind: 'escalate', reader: m.reader, coordinator, silentForMs };
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
