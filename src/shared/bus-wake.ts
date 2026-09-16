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
   *  arm's dedup high-water, independent of `pendingThroughSeq`. */
  gateThroughSeq?: number;
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
  /** `pendingThroughSeq` at the moment we last fired (or counted) a wake. */
  wokeThroughSeq: number;
  /** The run whose high-water {@link wokeThroughSeq} belongs to — the mail run
   *  that JUSTIFIED the wake (`pendingRunId` at fire time). The #150 lot re-arm
   *  reads the reader's cursor IN THIS run (from {@link ReaderPendingState.cursorByRun}),
   *  because a global `messages.sequence` is only comparable to the per-run cursor
   *  of the SAME run (review-150 F1). `undefined` for a gate-only wake (excluded
   *  from the cursor re-arm) and for legacy entries — both then fall back to the
   *  single-run `cursorSeq`, preserving prior behaviour. */
  wokeRunId?: string;
  /** The reader's durable cursor at the moment we last woke it (#119). Only the
   *  re-wake-until-answered path reads it: when the reader's cursor later moves
   *  PAST this, the reader acked without answering and is re-armed for a second
   *  wake while the ask stays open. `undefined` for the ordinary lot path, which
   *  re-arms by pending going false, not by cursor advance. */
  cursorAtWake?: number;
}

export type WakeAction =
  /** Fire the order into the reader's session. */
  | { kind: 'fire'; reader: string; throughSeq: number }
  /** The switch is OFF: count a would-have-woken, fire nothing (standing ruling). */
  | { kind: 'count'; reader: string; throughSeq: number }
  /** Nothing to do — no pending state, or already woken for this high-water. */
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
 * exactly that as its own disproof). `count` still consumes the dedup ledger
 * entry, so the shadow counter measures WAKES, not sweep ticks — a counter that
 * ticked 60 times a minute per idle reader would tell nobody anything.
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
 * The re-arm test for #150: has the reader ACKED through the high-water we last
 * woke it for? Its durable cursor ({@link ReaderPendingState.cursorSeq}) reaching
 * `previous.wokeThroughSeq` means it obeyed the outstanding order, so any pending
 * that remains is NEW mail and a fresh wake is owed.
 *
 * Keyed on the CURSOR, not on `pendingThroughSeq`, so it is level-triggered by
 * the ack and NOT by the pending seq merely rising: three rising inserts before
 * any ack (T117.2) leave the cursor untouched and stay a single wake, while an
 * ack that advances the cursor past the last wake re-arms exactly once (bounded
 * by acks, not sweeps — the effectful sweep records the fresh cursor as the new
 * `wokeThroughSeq`, so the reader is not re-woken again until it acks again).
 *
 * This re-arm is the LOT path ONLY — two families of reader are EXCLUDED so it
 * cannot fire spuriously, and both keep their exact pre-#150 behaviour:
 *
 *  - Ask readers (`reWakeUntilAnswered`): pending is answer-based, not
 *    cursor-based (#119). They keep their own effectful `cursorAtWake` re-arm
 *    (src/main/bus-wake.ts), which this must not double-fire.
 *  - Gate-pending readers (`gatePending`): `wokeThroughSeq` may have been raised
 *    to a GATE ID, which shares no numbering with the message cursor (see the
 *    fire branch: `Math.max(lotSeq, gateSeq)`). Comparing a message `cursorSeq`
 *    against a gate id is meaningless — an unrelated acked-lot cursor crossing a
 *    small gate id would spuriously re-arm a gate wake every sweep. Gates keep
 *    the presence dedup (`if (previous) skip`) unchanged; a gate's own re-wake
 *    (answer-based, #119) is out of #150's scope — this fix must not perturb it.
 *
 * With both excluded the comparison is cursor-vs-message-seq only, but it must be
 * the cursor IN THE WOKEN RUN: `wokeThroughSeq` is a global `messages.sequence`
 * recorded against `previous.wokeRunId`, and cursors are PER-RUN, so it is only
 * comparable to the reader's cursor in that same run (review-150 F1). The reader's
 * cursor in the woken run reaching the woken seq means it obeyed the outstanding
 * `orchestra check` for that run, so any pending that remains is NEW mail and a
 * wake is owed. Cross-run: mail newest in run B this tick after a wake for run A
 * reads A's cursor (still < A's seq until A is acked) → no false suppression.
 */
function readerAckedThroughLastWake(
  pending: ReaderPendingState,
  previous: WakeLedgerEntry,
): boolean {
  if (pending.reWakeUntilAnswered === true) return false;
  if (pending.gatePending === true) return false;
  // The cursor in the run the last wake covered. Prefer the per-run map; fall back
  // to the single-run `cursorSeq` only when the woken run is unknown (legacy entry)
  // or the map is absent AND the woken run matches the current mail run.
  const wokeRun = previous.wokeRunId;
  const cursorInWokeRun =
    wokeRun !== undefined && pending.cursorByRun
      ? (pending.cursorByRun.get(wokeRun) ?? 0)
      : wokeRun === undefined || wokeRun === pending.pendingRunId
        ? (pending.cursorSeq ?? 0)
        : 0; // woken run known, but no cursor for it → not yet acked there
  return cursorInWokeRun >= previous.wokeThroughSeq;
}

export function decideWake(
  pending: ReaderPendingState,
  session: ReaderSessionState,
  previous: WakeLedgerEntry | undefined,
  switchOn: boolean,
  askGateOn = false,
): WakeAction {
  const lotPending = pending.pending;
  const gatePending = pending.gatePending === true;
  if (!lotPending && !gatePending) {
    return { kind: 'skip', reader: pending.reader, why: 'no-pending' };
  }
  if (!session.wakeable) return { kind: 'skip', reader: pending.reader, why: 'not-wakeable' };
  if (previous && !readerAckedThroughLastWake(pending, previous)) {
    return { kind: 'skip', reader: pending.reader, why: 'already-woken' };
  }

  const lotSeq = pending.pendingThroughSeq;
  const gateSeq = pending.gateThroughSeq ?? 0;
  const lotFires = lotPending && switchOn;
  const gateFires = gatePending && askGateOn;

  if (lotFires || gateFires) {
    const throughSeq = Math.max(lotFires ? lotSeq : 0, gateFires ? gateSeq : 0);
    return { kind: 'fire', reader: pending.reader, throughSeq };
  }
  const throughSeq = Math.max(lotPending ? lotSeq : 0, gatePending ? gateSeq : 0);
  return { kind: 'count', reader: pending.reader, throughSeq };
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
