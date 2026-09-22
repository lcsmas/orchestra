// The wake DECISION — pure, so it is unit- and mutation-testable without a bus,
// a session or an Electron main process (issue #117, ledger #123).
//
// The effectful half lives in src/main/bus-wake.ts. Everything policy-shaped is
// here for the same reason #90 split `decideSessionRecycle` out: a rule that can
// only be exercised through a live app is a rule nobody re-tests once it ships.
//
// ── The design this encodes, frozen on #108 comments 4-5 ────────────────────
//
// NO agent turn ever blocks on a bus check. The 600s Bash cap makes a blocking
// `orchestra check` inside a turn a hang, not a wait. So the HOST watches, and
// when a reader has pending state it triggers ONE session turn whose content is
// an ORDER ("run `orchestra check`") and never the message body. The reader then
// runs the verb itself and acks with its OWN `orchestra ack` — the host never
// acks on a reader's behalf, which is the lying "Delivered" the bus exists to
// kill (ADR 0002, #108 round-4 hardening 1).

/** What the sweep knows about one reader, read from DURABLE bus state. */
export interface ReaderPendingState {
  /** The reader's handle — a workspace id (matches #115's `--as` default). */
  reader: string;
  /** Highest `messages.sequence` addressed to this reader (0 when none). */
  pendingThroughSeq: number;
  /** True when a lot is available/outstanding, or a QUESTION message addressed
   *  to the reader is open. This half is gated on the `wake` switch. */
  pending: boolean;
  /**
   * Highest UN-ACKED `messages.sequence` for this reader — the newest message (of
   * ANY kind, a `question` matches the lot recipient predicate too) still ABOVE the
   * reader's per-run cursor, across every pending run. `0` when the reader has acked
   * through EVERYTHING and the only thing keeping it pending is an answer-based
   * unanswered ask (the #185 storm shape: cursor past the question, question
   * unanswered). Distinct from `pendingThroughSeq` (= `max(lot, unanswered-question)`,
   * which stays > 0 for an already-acked-but-unanswered ask): the #185 bounded
   * re-fire keys on THIS — a re-`check` order can only accomplish something while a
   * message remains un-acked (`> 0`). Defaults 0/undefined, so every pre-#185 caller
   * and the whole shared suite behaves identically without edits.
   */
  unackedThroughSeq?: number;
  /**
   * True when an OPEN decision gate is addressed to this reader (#119). Carried
   * SEPARATELY from `pending` because it is gated on a DIFFERENT switch —
   * `askGate`, not `wake`. A reader may be pending for a lot (wake OFF → counted)
   * and for a gate (askGate ON → fired) independently in one sweep, and folding
   * the two into one boolean would force one switch to answer for both — the
   * exact conflation D2 (ledger #123) left gates OUT of #117 to avoid. #119
   * gives gates a recipient and a `check` surface, so they are now wakeable.
   * Defaults false, so every pre-#119 caller (and the whole shared unit suite)
   * behaves identically without editing a line.
   */
  gatePending?: boolean;
  /** Highest OPEN gate id addressed to this reader (0 when none) — the gate
   *  arm's dedup high-water, independent of `pendingThroughSeq`. Gate ids are a
   *  GLOBAL monotonic sequence (one `decision_gates` table), so this stays a
   *  cross-run-safe high-water even though #158 widens the gate LOOKUP to related
   *  runs — the D-H1 gate-axis re-arm is unchanged. */
  gateThroughSeq?: number;
  /**
   * EVERY run (own ∪ related) an OPEN gate addressed to this reader sits in
   * (#158). The wake ORDER names these too, so a reader woken for a CROSS-RUN gate
   * (opened in the ASKER's run — an OPS→LEAD ruling ask) is told to run
   * `orchestra check --run <gateRun>`, which is where the gate surfaces. Empty/
   * undefined when no gate pends. Pre-#158 a gate could only be its OWN run and
   * the order named the reader's own run, so a cross-run gate was woken-for a run
   * that could never show it — the exact "no check surface" half of ledger #157
   * F-C5-1. */
  gateRunIds?: string[];
  /**
   * True when this reader is parked on an UNANSWERED ask/gate it is the RECIPIENT
   * of — a durable pending state that does NOT clear on the reader's own ack
   * (#119: "reading without answering re-wakes until answered", #108 Q15). This
   * is what lets the ask re-wake loop fire a SECOND wake after the recipient acks
   * without answering: the recipient's ack (cursor advance) re-arms the dedup
   * while the ask stays pending. `false` for ordinary lot traffic, which clears
   * on ack the ordinary way.
   */
  reWakeUntilAnswered?: boolean;
  /** This reader's durable cursor position (`cursors.acked_seq`, 0 when none).
   *  The re-arm signal for {@link reWakeUntilAnswered}: an advance past the
   *  cursor recorded at the last wake means the reader acked and must be re-woken
   *  while the ask is still unanswered. This is the cursor in {@link pendingRunId}
   *  (the newest pending item's run); the ask path only ever reasons about that
   *  one run. The LOT #150 re-arm needs cursors across runs — see {@link cursorByRun}. */
  cursorSeq?: number;
  /**
   * The reader's durable cursor (`cursors.acked_seq`, 0 when absent) in EACH run
   * that could carry a wake for it — every pending run PLUS the run a prior wake
   * was recorded for. The #150 lot re-arm is PER-RUN: `cursorSeq` alone is the
   * cursor in the CURRENT sweep's newest-mail run, but the ledger's
   * `wokeThroughSeq` was recorded against the run that fired LAST, and
   * `messages.sequence` is global while `cursors` are per-run — so a cross-run
   * sweep (mail newest in run B this tick, but woken for run A last tick) would
   * compare A's global seq against B's cursor, a category error that re-introduces
   * the #150 starvation across runs (review-150 F1). The re-arm instead reads the
   * cursor IN THE WOKEN RUN from this map. `undefined`/absent run → treated as 0.
   */
  cursorByRun?: ReadonlyMap<string, number>;
  /**
   * The run id the NEWEST pending lot/question physically SITS in (#134 D1a-bis)
   * — usually the reader's own run; for an OPS→LEAD digest the OPS's DESCENDANT
   * run, for a LEAD→OPS ruling the LEAD's ANCESTOR run (the store-less CLI writes
   * mail with the SENDER's run). `undefined` when only a gate is pending. See
   * {@link pendingRunIds} for the FULL set the wake order names.
   */
  pendingRunId?: string;
  /**
   * EVERY run (own ∪ related) with pending exact-mail for this reader (#134 D2) —
   * the set the wake ORDER names, one `orchestra check --run <r>` line per run.
   * A reader may have unread mail in several runs at once (its own wave + a
   * digest up from a sub-wave + a ruling down from the mission); D2 says the
   * order lists them all, and the reader checks/acks each PER-RUN. Empty/undefined
   * when only a gate is pending. `pendingRunId` is the newest of this set. */
  pendingRunIds?: string[];
  /**
   * The run whose `wake` flag GOVERNS this pending item (#134 D1a-bis): the
   * INNERMOST = the DEEPER of (mail run, reader run). For upward mail (OPS→LEAD)
   * that is the mail run (the OPS wave); for downward mail (LEAD→OPS) it is the
   * reader run (the OPS wave). The sweep reads `readWakeSwitch(switchRunId)` — a
   * mutant that reads the reader's own run for upward mail, or the mail's run for
   * downward mail, reddens the G4a fire arm. `undefined` when only a gate pends.
   */
  switchRunId?: string;
}

/** Everything about the reader's SESSION the decision needs. */
export interface ReaderSessionState {
  /** False when the workspace is gone, hibernated, or otherwise unwakeable. */
  wakeable: boolean;
}

/** What the sweep remembers between ticks — the dedup ledger.
 *
 *  Presence in the ledger IS the dedup: a reader with an entry has an
 *  outstanding wake and is not woken again until its pending state CLEARS. The
 *  sequence is carried for the log line and for the gate's assertions, and is
 *  deliberately NOT part of the suppression test — see {@link decideWake}. */
export interface WakeLedgerEntry {
  /**
   * The LOT axis high-water — the `pendingThroughSeq` (a global `messages.sequence`)
   * the last wake covered for lot/question traffic. Re-armed by the reader's CURSOR
   * in {@link wokeRunId} reaching it (#150 F1). 0 when the last wake was gate-only.
   *
   * TWO AXES, NOT ONE (D-H1, ledger #151): the lot and gate high-waters are tracked
   * SEPARATELY because they re-arm on different signals and their numbers are not
   * comparable — a `messages.sequence` and a gate id share no numbering. Folding
   * them into one `wokeThroughSeq` (as the first #150 cut did) forced the gate axis
   * through the lot's cursor re-arm, which is meaningless for gates (they clear by
   * ANSWER, not by a cursor advance) — the F2/D-H1 defect.
   */
  wokeLotSeq: number;
  /**
   * The GATE axis high-water — the highest OPEN gate id the last wake covered
   * (#119, D-H1). Re-armed when the reader's `gateThroughSeq` (max open gate id)
   * EXCEEDS this: a genuinely NEW gate opened, so a fresh wake is owed. NEVER
   * re-armed by the message cursor. 0 when the last wake was lot-only. Unlike the
   * lot axis this needs no cursor: `gateThroughSeq` is the max of the CURRENTLY
   * open gates, so it only rises when a new gate opens (the wake-worthy event) and
   * a resolved gate drops out of the max — no rising-before-ack (T117.2) shape.
   */
  wokeGateSeq: number;
  /** The run whose LOT high-water {@link wokeLotSeq} belongs to — the mail run
   *  that JUSTIFIED the lot wake (`pendingRunId` at fire time). The #150 lot re-arm
   *  reads the reader's cursor IN THIS run (from {@link ReaderPendingState.cursorByRun}),
   *  because a global `messages.sequence` is only comparable to the per-run cursor
   *  of the SAME run (review-150 F1). `undefined` for a gate-only wake (the gate
   *  axis re-arms on its own high-water, not a cursor) and for legacy entries —
   *  both then fall back to the single-run `cursorSeq`, preserving prior behaviour. */
  wokeRunId?: string;
  /** The reader's durable cursor at the moment we last woke it (#119). Only the
   *  re-wake-until-answered path reads it: when the reader's cursor later moves
   *  PAST this, the reader acked without answering and is re-armed for a second
   *  wake while the ask stays open. `undefined` for the ordinary lot path, which
   *  re-arms by pending going false, not by cursor advance. */
  cursorAtWake?: number;
  /**
   * A ~monotonic wall-clock timestamp (ms, `Date.now()`-scale) of the last wake
   * ATTEMPT this entry recorded — the pending-since clock for the #183 D1 bounded
   * re-wake. Wall-clock, not a strict monotonic source: a backward NTP jump merely
   * DELAYS a re-wake (the elapsed check reads negative → waits longer), never
   * wedges — self-correcting, so a monotonic clock buys nothing here. The
   * class-wide backstop: a reader latched `already-woken` (neither axis re-armed by
   * its own signal) whose pending has still not cleared is re-fired once
   * {@link REWAKE_BOUND_MS} has elapsed since this mark, LEVEL-TRIGGERED like
   * liveness (#183). Recorded afresh on every fire/count so the re-fire itself
   * resets the clock — bounded by the interval, not by sweeps, so a healthy
   * check+ack cycle (which re-arms via the cursor FIRST, before the bound elapses)
   * never sees a double-fire. `undefined` for legacy entries — treated as "no clock
   * yet", so the FIRST sweep that sees a latch with no `lastWakeAt` records one and
   * the bound counts from there (never re-fires a latch it has not itself timed,
   * which would fire instantly on a restart that rebuilt the ledger). */
  lastWakeAt?: number;
}

/**
 * #183 D1 — the bounded level-triggered re-wake interval. No pending message or
 * gate may wait longer than this without a fresh wake attempt while its reader is
 * wakeable. The class-wide backstop for the fleet-stopping latch (#183 §State,
 * THREE 4h/6h/14h latches against healthy active sessions): the gate axis
 * ({@link gateAxisReArmed}) re-fires ONLY when a genuinely new gate opens, and the
 * lot axis ({@link lotAxisReArmed}) re-fires ONLY when the reader ACKS — so an
 * operator-driven session whose turns are not wake-driven (it never runs
 * `check`/`ack` for that run) is unreachable by both, and its one consumed wake
 * latches `already-woken` until an unrelated topology/emergency event. This bound
 * closes that class regardless of which specific re-arm failed.
 */
export const REWAKE_BOUND_MS = 5 * 60_000;

export type WakeAction =
  /** Fire the order into the reader's session. `throughSeq` is the max of the two
   *  axes for the human log line; `lotSeq`/`gateSeq` are recorded on the ledger
   *  SEPARATELY (D-H1) so each axis re-arms on its own signal. Each is the
   *  high-water of ONLY the sources that JUSTIFIED this action (0 for an axis that
   *  did not fire/count). `lastWakeAt` is the `now` this action fired at (~monotonic
   *  wall clock — see {@link WakeLedgerEntry.lastWakeAt}), recorded on the ledger
   *  for the #183 bounded re-wake clock. */
  | { kind: 'fire'; reader: string; throughSeq: number; lotSeq: number; gateSeq: number; wokeRunId?: string; lastWakeAt: number }
  /** The switch is OFF: count a would-have-woken, fire nothing (standing ruling). */
  | { kind: 'count'; reader: string; throughSeq: number; lotSeq: number; gateSeq: number; wokeRunId?: string; lastWakeAt: number }
  /** Nothing to do — no pending state, or already woken on BOTH axes' high-waters. */
  | { kind: 'skip'; reader: string; why: SkipReason };

export type SkipReason = 'no-pending' | 'already-woken' | 'not-wakeable';

/**
 * Decide what to do about ONE reader on ONE sweep tick.
 *
 * ── The dedup rule: PRESENCE, re-armed by the reader's own ACK ──────────────
 *
 * "At most one pending wake per reader; N inserts while busy = ONE wake"
 * (#117 acceptance 2). A ledger entry means the reader has an OUTSTANDING order
 * to `orchestra check` — one order covers every message pending when it obeys —
 * so while that order is outstanding it is not re-woken. The suppression test is
 * therefore: an entry exists AND the reader has NOT yet acked through the seq we
 * last woke it for ({@link readerAckedThroughLastWake} — its `cursorSeq` is still
 * below `previous.wokeThroughSeq`). Once the reader HAS acked through that mark,
 * the order is fulfilled and any pending that remains is NEW mail (#150) → the
 * entry is re-armed and the reader woken again through the fresh high-water.
 *
 * DISPROVED DESIGN, recorded here so it is not re-derived. A first attempt
 * suppressed only when `previous.wokeThroughSeq >= pending.pendingThroughSeq`,
 * reasoning that a high-water mark "makes both directions observable". It does
 * not: three inserts landing while the reader is mid-turn arrive at RISING
 * sequences (5, 6, 7); the reader has acked NOTHING, yet each rising seq passes a
 * `>=`/`>` test against the previous mark and the reader is woken THREE times —
 * the exact failure T117.2 exists to catch. That is why the re-arm keys on the
 * reader's CURSOR (did it ACK the last order?), NOT on the pending seq rising:
 * rising pending with no ack is one busy window → one wake; a cursor advancing
 * past the last wake is the reader having obeyed → a fresh order is owed (#150).
 * The hand-written 3-insert test in bus-wake.test.ts is kept as the regression.
 *
 * ── #150: NEW mail after an ACK, while unrelated pending survives the prune ──
 *
 * The straightforward re-arm is {@link pruneWakeLedger}: when a reader's pending
 * set EMPTIES, its entry is dropped and it wakes normally for the next lot. But
 * that only fires when the WHOLE set empties. A reader that acked through N yet
 * still holds OLDER unacked unrelated mail keeps a non-empty pending set, so the
 * prune never runs, the entry survives, and pre-#150 the presence test skipped
 * every subsequent sweep — new mail N+1 never woke it (live repro: 3 msgs /
 * 14 min, ledger #147 C5). The cursor-based re-arm here closes that: acking
 * through the last wake's high-water re-arms independently of whether the set
 * emptied. Ask readers (`reWakeUntilAnswered`) are EXCLUDED — their pending is
 * answer-based, not cursor-based, and they keep their own effectful re-arm
 * (src/main/bus-wake.ts, the `cursorAtWake` delete), left unchanged (#119).
 *
 * ── COUNTED, NOT FIRED ──────────────────────────────────────────────────────
 *
 * With the switch off this returns `count`, not `skip`. The distinction is the
 * whole point of the standing ruling: a mechanism whose off-state is
 * indistinguishable from the feature being absent cannot be observed in shadow,
 * so the switch-off arm of the gate would be vacuous (ledger #123 gate C7 names
 * exactly that as its own disproof). `count` still consumes a dedup entry — but in
 * the SEPARATE count ledger (#153), never the fire ledger — so the shadow counter
 * measures WAKES, not sweep ticks (a counter ticking 60 times a minute per idle
 * reader tells nobody anything), while a later OFF→ON flip still finds an EMPTY fire
 * ledger and delivers the wake OFF suppressed. See the two-ledger note above.
 */
/**
 * TWO SWITCHES, ONE ORDER (#119). `switchOn` is the `wake` switch and gates the
 * lot/question half (`pending`). `askGateOn` is a SECOND, independent switch
 * (`askGate`) gating the gate half (`gatePending`). This stays the ONE decision
 * site so "at most one wake per reader" holds: pending for a lot, a gate, or
 * both, it returns ONE action and the sweep delivers ONE `orchestra check`.
 *
 *   fire  iff (pending && wake) || (gatePending && askGate)
 *   count iff (pending || gatePending) && not fire      -- COUNTED, not FIRED
 *
 * `throughSeq` is the high-water of only the sources that JUSTIFIED the action
 * (the ON sources for a fire, every pending source for a count). Gate ids and
 * message sequences share no numbering, so a source whose switch is OFF must not
 * raise the mark — that would mask its counted-not-fired state on the next sweep.
 */
/**
 * The LOT-axis re-arm test (#150 F1): has the reader ACKED, IN THE WOKEN RUN,
 * through the lot high-water we last woke it for? Its cursor in `previous.wokeRunId`
 * reaching `previous.wokeLotSeq` means it obeyed the outstanding `orchestra check`,
 * so any lot pending that remains is NEW mail and a fresh wake is owed.
 *
 * Keyed on the CURSOR, not on `pendingThroughSeq`, so it is level-triggered by the
 * ack and NOT by the pending seq merely rising: three rising inserts before any
 * ack (T117.2) leave the cursor untouched and stay a single wake, while an ack that
 * advances the cursor past the last wake re-arms exactly once (bounded by acks, not
 * sweeps — the sweep records the fresh cursor as the new `wokeLotSeq`).
 *
 * Ask readers (`reWakeUntilAnswered`) are EXCLUDED: their pending is answer-based,
 * not cursor-based (#119), and they keep their own effectful `cursorAtWake` re-arm
 * (src/main/bus-wake.ts), which this must not double-fire.
 *
 * PER-RUN: `wokeLotSeq` is a global `messages.sequence` recorded against
 * `previous.wokeRunId`, and cursors are PER-RUN, so it is only comparable to the
 * reader's cursor in that same run (review-150 F1). Cross-run: mail newest in run B
 * this tick after a wake for run A reads A's cursor (still < A's seq until A is
 * acked) → no false suppression.
 */
function lotAxisReArmed(pending: ReaderPendingState, previous: WakeLedgerEntry): boolean {
  if (pending.reWakeUntilAnswered === true) return false;
  const wokeRun = previous.wokeRunId;
  // #159: the woken run is ORPHANED — it fell out of the reader's related-run set,
  // so `cursorByRun` (built over the CURRENT related set only, src/main/bus-wake.ts)
  // has NO key for it. An absent key is NOT "cursor 0 / not yet acked" — it is "this
  // high-water belongs to a run the reader no longer relates to". Treating it as 0
  // made `0 >= wokeLotSeq` false → `already-woken` skip every sweep, silently, until
  // an old-channel turn advanced a live-run cursor (F-C5-3 19min, F-C6 8min). The
  // orphaning vector is a TOPOLOGY change (a related mail-run reparented/deleted, or
  // a reparent around a restart) — NOT a bare `orchestra restart`, which re-resolves
  // resolveWaveRunId to the SAME run (it is a pure parent-link walk). A stale
  // high-water must RE-ARM, not suppress: drop the orphaned mark and wake afresh.
  if (wokeRun !== undefined && pending.cursorByRun && !pending.cursorByRun.has(wokeRun)) {
    return true;
  }
  // The cursor in the run the last LOT wake covered. Prefer the per-run map; fall
  // back to the single-run `cursorSeq` only when the woken run is unknown (legacy
  // entry) or matches the current mail run.
  const cursorInWokeRun =
    wokeRun !== undefined && pending.cursorByRun
      ? (pending.cursorByRun.get(wokeRun) ?? 0)
      : wokeRun === undefined || wokeRun === pending.pendingRunId
        ? (pending.cursorSeq ?? 0)
        : 0; // woken run known, but no cursor for it → not yet acked there
  return cursorInWokeRun >= previous.wokeLotSeq;
}

/**
 * The GATE-axis re-arm test (D-H1): a genuinely NEW gate opened since the last
 * wake — the reader's `gateThroughSeq` (max OPEN gate id) EXCEEDS the gate
 * high-water we last woke it for. NEVER keyed on the message cursor (a gate id and
 * a `messages.sequence` share no numbering — that was the F2 mistake).
 *
 * A plain `>` is safe here where it is NOT for lots: `gateThroughSeq` is the max of
 * the CURRENTLY open gates, so it rises only when a new gate opens (the wake-worthy
 * event) and a resolved gate simply drops out of the max — there is no
 * rising-before-ack (T117.2) shape to guard against. N gates opening before the
 * first wake still coalesce to one wake: the first wake covers through the max, and
 * `gateThroughSeq > wokeGateSeq` is false until a gate ABOVE that max opens.
 */
function gateAxisReArmed(pending: ReaderPendingState, previous: WakeLedgerEntry): boolean {
  return (pending.gateThroughSeq ?? 0) > previous.wokeGateSeq;
}

/**
 * The #183 D1 BOUNDED re-arm test — the class-wide backstop. True when an
 * otherwise-latched reader (neither its lot nor its gate axis re-armed by its own
 * signal) has been latched at least {@link REWAKE_BOUND_MS} without clearing its
 * pending: re-fire, LEVEL-TRIGGERED, exactly like the liveness sweep.
 *
 * Why it is safe against the fast path (#153 / T117.2): this is consulted ONLY when
 * both per-signal re-arms are dead this sweep. A HEALTHY reader re-arms via its
 * CURSOR ({@link lotAxisReArmed}) the moment it acks — long before the bound
 * elapses — so the bound never fires on a check+ack cycle and there is no
 * double-fire within the interval (arm: healthy-cycle). N rising inserts before any
 * ack still coalesce to one wake until the bound, then ONE re-fire, then the clock
 * resets on that re-fire — bounded by the interval, never per-sweep.
 *
 * Requires a `previous.lastWakeAt` we ourselves recorded: an entry with no clock
 * (legacy, or a ledger rebuilt on restart) is NOT re-fired instantly — the sweep
 * records `lastWakeAt` on the current tick and the bound counts from there. A wake
 * whose cursor already reached the woken lot is handled by the lot axis, not here.
 */
function boundedReArmed(previous: WakeLedgerEntry, now: number): boolean {
  if (previous.lastWakeAt === undefined) return false;
  return now - previous.lastWakeAt >= REWAKE_BOUND_MS;
}

/**
 * TWO DEDUP LEDGERS, NOT ONE (#153). A `count` (switch OFF) must NEVER arm the
 * FIRE dedup, or a mid-process OFF→ON flip strands every reader counted under OFF
 * in `already-woken` starvation: the counted reader was never delivered a wake, so
 * it never acked, so its cursor never reaches the `wokeLotSeq` the count recorded,
 * so the ack-based re-arm can never fire and every ON-sweep after the flip skips it
 * (the C5 eternal-sleep shape #150, reintroduced by the SHADOW path; found LIVE in
 * canary-4, ledger #152 F-C4-1).
 *
 * The fix: fires dedup against fires, counts dedup against counts. The sweep keeps
 * a SEPARATE `countLedger`, and `decideWake` is told BOTH prior entries. Because
 * fire-vs-count per axis is decided purely by the switch (known here), each axis
 * consults the ledger it would WRITE: the FIRE ledger when its switch is ON, the
 * COUNT ledger when OFF. So a reader counted at seq N under OFF has an EMPTY fire
 * ledger, and the first ON-sweep after new mail sees no prior FIRE entry → fires
 * the full pending (acceptance 1). Counts still dedup against counts, so the shadow
 * counter measures WAKES-worth of events, not 60 sweep-ticks a minute (acceptance
 * 3). The ask re-wake-until-answered re-arm (#119) and the #150/#112/#134 rules are
 * unchanged — they act per-axis on whichever entry governs.
 */
export function decideWake(
  pending: ReaderPendingState,
  session: ReaderSessionState,
  previousFire: WakeLedgerEntry | undefined,
  switchOn: boolean,
  askGateOn = false,
  previousCount: WakeLedgerEntry | undefined = undefined,
  now: number = Date.now(),
): WakeAction {
  const lotPending = pending.pending;
  const gatePending = pending.gatePending === true;
  if (!lotPending && !gatePending) {
    return { kind: 'skip', reader: pending.reader, why: 'no-pending' };
  }
  if (!session.wakeable) return { kind: 'skip', reader: pending.reader, why: 'not-wakeable' };

  // The prior entry each axis dedups AGAINST is the ledger it would WRITE this
  // sweep — the FIRE ledger when the axis's switch is ON, the COUNT ledger when OFF
  // (#153). A count recorded under OFF lives ONLY in `previousCount`, so an ON-sweep
  // reads an absent FIRE entry and re-fires; and a count under OFF still dedups
  // against the previous count. Selected per axis because the two switches flip
  // independently (a lot can fire while a gate counts, or vice versa).
  const lotPrev = switchOn ? previousFire : previousCount;
  const gatePrev = askGateOn ? previousFire : previousCount;

  // ── TWO AXES, EACH WITH ITS OWN RE-ARM (D-H1) ───────────────────────────────
  // An axis is "active" this sweep when it is pending AND either it has no prior
  // entry in the ledger it dedups against, or its own re-arm signal advanced: the
  // LOT axis on the reader's cursor in the woken run (#150 F1), the GATE axis on its
  // own high-water rising (a new gate opened). Suppress only when NEITHER axis is
  // active — that is the dedup: an outstanding order on an un-advanced axis is not
  // re-issued.
  const lotActive = lotPending && (lotPrev === undefined || lotAxisReArmed(pending, lotPrev));
  const gateActive = gatePending && (gatePrev === undefined || gateAxisReArmed(pending, gatePrev));
  if (!lotActive && !gateActive) {
    // ── #183 D1: the BOUNDED level-triggered backstop ──────────────────────────
    // Both per-signal re-arms are dead this sweep — the reader is latched
    // `already-woken`. That is CORRECT for a reader mid-turn on its outstanding
    // order, but WRONG for the #183 class: an operator-driven session whose turns
    // are not wake-driven never acks that lot and never opens a new gate, so
    // neither axis can ever re-arm and the latch holds for HOURS. If the reader has
    // been latched at least REWAKE_BOUND_MS (measured from the last wake WE timed on
    // EITHER ledger — a latch persists in whichever ledger the last wake landed),
    // re-fire the STILL-PENDING axes. This ships regardless of which specific
    // re-arm failed (D2); the clock resets on the re-fire (`lastWakeAt` below), so
    // it is bounded by the interval, never per-sweep.
    const boundPrev = lotPrev ?? gatePrev; // whichever ledger carries the latch clock
    if (boundPrev !== undefined && boundedReArmed(boundPrev, now)) {
      // #185: REVALIDATE before a bounded re-fire — a re-`check` order can only
      // accomplish something while a message is still UN-ACKED. Key the lot axis on
      // `unackedThroughSeq > 0` (the newest message of ANY kind still above the
      // reader's cursor). This is the ONE signal that covers every case:
      //   - ordinary un-acked lot → un-acked → re-fire (#183 D5),
      //   - a never-acked unanswered ask → the ask row is itself un-acked → re-fire
      //     (the mirror: no pre-#183 silent latch), and
      //   - a co-pending un-acked lot behind an already-obeyed newer ask → the lot
      //     is un-acked → re-fire (review-185: no cross-run starvation).
      // It fires NOTHING only when the reader has acked through EVERYTHING and the
      // sole remaining pending is an answer-based unanswered ask (unackedThroughSeq
      // == 0, pendingThroughSeq > 0): a re-`check` is a no-op it cannot silence, and
      // the ask clears by ANSWER, not by re-ordering a check → this is the storm we
      // stop (live repro #185: cursor 1688 past ask 1458, nothing un-acked). Such a
      // reader still re-arms on its own `cursorAtWake` advance (#119) if it acks new
      // mail, and clears when the ask is answered.
      const hasUnacked = (pending.unackedThroughSeq ?? 0) > 0;
      const lotBoundEligible = lotPending && hasUnacked;
      const lotSeqNow = pending.pendingThroughSeq;
      const gateSeqNow = pending.gateThroughSeq ?? 0;
      const lotFires = lotBoundEligible && switchOn;
      const gateFires = gatePending && askGateOn;
      // Carry each axis's mark forward from the ledger it dedups against, exactly as
      // the normal path does, so a bounded re-fire never resets the OTHER axis's
      // high-water (which would spuriously re-fire it next sweep).
      const lotSeq = lotBoundEligible ? lotSeqNow : (lotPrev?.wokeLotSeq ?? 0);
      const gateSeq = gatePending ? gateSeqNow : (gatePrev?.wokeGateSeq ?? 0);
      const wokeRunId = lotBoundEligible ? pending.pendingRunId : lotPrev?.wokeRunId;
      if (lotFires || gateFires) {
        const throughSeq = Math.max(lotFires ? lotSeqNow : 0, gateFires ? gateSeqNow : 0);
        return { kind: 'fire', reader: pending.reader, throughSeq, lotSeq, gateSeq, wokeRunId, lastWakeAt: now };
      }
      // A bounded re-fire is owed only when a cursor-clearable lot or a gate is
      // eligible. An ask-only latch (lot pending but reWakeUntilAnswered) falls
      // through to the ordinary skip — its re-arm is the `cursorAtWake` path.
      if (lotBoundEligible || gatePending) {
        const throughSeq = Math.max(lotBoundEligible ? lotSeqNow : 0, gatePending ? gateSeqNow : 0);
        return { kind: 'count', reader: pending.reader, throughSeq, lotSeq, gateSeq, wokeRunId, lastWakeAt: now };
      }
    }
    return { kind: 'skip', reader: pending.reader, why: 'already-woken' };
  }

  const lotSeqNow = pending.pendingThroughSeq;
  const gateSeqNow = pending.gateThroughSeq ?? 0;
  const lotFires = lotActive && switchOn;
  const gateFires = gateActive && askGateOn;
  // The marks to RECORD per axis: the current high-water for an axis that acted this
  // sweep, else carry the prior mark forward so the other axis's re-arm is not lost
  // when only one axis acts (a lot re-arm must not reset wokeGateSeq to 0, or the
  // gate would spuriously re-fire next sweep). Carry EACH axis from the prior entry
  // it dedups against (`lotPrev`/`gatePrev`) — never crossing the fire/count ledgers
  // (#153), so a counted gate's mark is not resurrected from a stale fire entry.
  const lotSeq = lotActive ? lotSeqNow : (lotPrev?.wokeLotSeq ?? 0);
  const gateSeq = gateActive ? gateSeqNow : (gatePrev?.wokeGateSeq ?? 0);
  // The run the recorded LOT mark belongs to — the current mail run when the lot
  // axis acted, else carried forward with its mark (so a gate-only re-arm does not
  // orphan the lot high-water from its run).
  const wokeRunId = lotActive ? pending.pendingRunId : lotPrev?.wokeRunId;

  // fire vs count is per the SWITCH of each ACTIVE axis; the two coalesce into ONE
  // action (at most one order per reader). A source whose switch is OFF is counted,
  // never fired, and must not raise the FIRED mark — its counted-not-fired state
  // stays observable next sweep.
  if (lotFires || gateFires) {
    const throughSeq = Math.max(lotFires ? lotSeqNow : 0, gateFires ? gateSeqNow : 0);
    return { kind: 'fire', reader: pending.reader, throughSeq, lotSeq, gateSeq, wokeRunId, lastWakeAt: now };
  }
  const throughSeq = Math.max(lotActive ? lotSeqNow : 0, gateActive ? gateSeqNow : 0);
  return { kind: 'count', reader: pending.reader, throughSeq, lotSeq, gateSeq, wokeRunId, lastWakeAt: now };
}

/**
 * Drop ledger entries for readers that no longer have pending state, so a reader
 * that acked re-arms for the NEXT lot.
 *
 * Deliberately keyed on the CURRENT sweep's pending set rather than on an ack
 * event: an ack performed by the CLI while the app was closed emits no event the
 * app could have observed, and this module must be level-triggered end to end
 * (#117 acceptance 3). Reading the durable state and pruning what it no longer
 * justifies is the only shape that survives a restart.
 */
export function pruneWakeLedger(
  ledger: Map<string, WakeLedgerEntry>,
  stillPending: ReadonlySet<string>,
): void {
  for (const reader of [...ledger.keys()]) {
    if (!stillPending.has(reader)) ledger.delete(reader);
  }
}

/** The header line of a wake order — the only prose the host puts in a wake; the
 *  message BODY never travels this path (#117 acceptance 5). Why the body is
 *  banned rather than discouraged: a host that pastes the message into the turn
 *  has silently delivered it, and the reader's `ack` then certifies a read the
 *  bus never handed over. The order keeps the bus the single delivery path — a
 *  lot is read exactly where it is acked. */
export const WAKE_ORDER_HEADER = 'lot pending — run the check command(s) below, then ack each lot:';

/**
 * BUILD the wake order (#134 D2, ledger #135, rules OQ3). The order NAMES the
 * run(s) the reader must check — one `orchestra check --run <r>` line per run
 * with pending mail for this reader — because a wake carries an order, never
 * content, and a run id is part of the order. `check`/`ack`/cursor stay per-run
 * (#115's one-lot-one-run contract untouched); a plain `orchestra check` still
 * means "my own run", so the explicit `--run` is what lets a reader retrieve mail
 * in a RELATED run (an OPS→LEAD digest in a descendant, a LEAD→OPS ruling in an
 * ancestor) that a plain check would never see — the OQ3 permanent-loop fix.
 *
 * Runs are sorted for a stable, testable string. At least one run is always
 * present when this is called (the sweep only wakes a reader that is pending).
 */
export function buildWakeOrder(runIds: readonly string[]): string {
  const runs = [...new Set(runIds)].sort();
  const lines = runs.map((r) => `orchestra check --run ${r}`);
  return [WAKE_ORDER_HEADER, ...lines].join('\n');
}

/** The legacy single-run constant, kept for the shape the older gate arms assert
 *  (a wake for one own-run lot). Equivalent to `buildWakeOrder([ownRun])` minus
 *  the run id — retained ONLY where a test needs a run-agnostic sentinel. New
 *  code builds the order with {@link buildWakeOrder}. */
export const WAKE_ORDER = WAKE_ORDER_HEADER;

/** True when `text` is a wake order this module produced (#134 D2): the header
 *  followed by ≥1 `orchestra check --run <r>` line, and NOTHING else. Used by the
 *  gate to assert the order is present, and by the body-leak check to assert it
 *  is the ONLY thing present — a pasted message body would add a non-matching
 *  line and fail this. */
export function isWakeOrder(text: string): boolean {
  const lines = text.trim().split('\n');
  if (lines[0] !== WAKE_ORDER_HEADER) return false;
  if (lines.length < 2) return false; // must name at least one run
  return lines.slice(1).every((l) => /^orchestra check --run \S+$/.test(l.trim()));
}

/** The run ids a wake order names (#134 D2) — what the reader checks. Empty for a
 *  non-order string. The recognizer above guarantees the shape; this extracts. */
export function wakeOrderRuns(text: string): string[] {
  if (!isWakeOrder(text)) return [];
  return text
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.trim().replace(/^orchestra check --run /, ''));
}

/** The coalescing DECISION for a fresh send against the reader's UNSTARTED queue
 *  (#162). Pure so `sdkSend` (agent-sdk.ts, un-importable under the strip-types
 *  runner because of its `./platform` dir-import) and the acceptance test call
 *  ONE implementation — the test never re-implements the rule it certifies.
 *
 *  `queuedTexts` are the texts of the entries CURRENTLY in `session.queue`, in
 *  order. Every one is UNSTARTED by construction: the running turn was shifted
 *  off the queue before this decision runs, so a merge target found here can
 *  never be a started turn (acceptance arm 2).
 *
 *  Returns, when the incoming send is a wake order AND a queued wake order
 *  exists to merge into:
 *   - `mergeIndex`: the queue index whose entry absorbs the incoming order — the
 *     FIRST queued wake order (`findIndex`), i.e. the existing/oldest one, not the
 *     newest; any single unstarted wake order is a valid merge target since the
 *     union is order-independent, and the first keeps one stable target, and
 *   - `mergedText`: the UNION of both orders' named runs (`buildWakeOrder`
 *     dedups + sorts) — a superset of each, so the single coalesced turn checks
 *     every run either order would have.
 *  Returns `null` (append a fresh turn as before) when the incoming send is NOT
 *  a wake order, or when no queued wake order exists. Keyed on `isWakeOrder` for
 *  BOTH sides, so an ordinary prompt or peer message never coalesces with a wake
 *  order and #112's duplicate-prompt guard is untouched (acceptance arm 3).
 *
 *  This governs QUEUEING only; the engine-side ledger dedup in the sweep (which
 *  governs FIRING) is unchanged. */
export function coalesceWakeOrderInto(
  incomingText: string,
  queuedTexts: readonly string[],
): { mergeIndex: number; mergedText: string } | null {
  if (!isWakeOrder(incomingText)) return null;
  const mergeIndex = queuedTexts.findIndex((t) => isWakeOrder(t));
  if (mergeIndex < 0) return null;
  const mergedText = buildWakeOrder([
    ...wakeOrderRuns(queuedTexts[mergeIndex]),
    ...wakeOrderRuns(incomingText),
  ]);
  return { mergeIndex, mergedText };
}
