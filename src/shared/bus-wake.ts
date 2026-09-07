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
  /** True when a lot is available OR outstanding, or an ask/gate is open. */
  pending: boolean;
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
 * ── The dedup rule: PRESENCE in the ledger, never a sequence comparison ─────
 *
 * "At most one pending wake per reader; N inserts while busy = ONE wake"
 * (#117 acceptance 2). The suppression test is therefore `previous !== undefined`
 * — the reader has an outstanding order to check, so it needs no second one.
 *
 * DISPROVED DESIGN, recorded here so it is not re-derived. This first suppressed
 * only when `previous.wokeThroughSeq >= pending.pendingThroughSeq`, reasoning
 * that a high-water mark "makes both directions observable". It does not: three
 * inserts landing while the reader is mid-turn arrive at RISING sequences (5, 6,
 * 7), each one passes a `>=` test against the previous mark, and the reader is
 * woken THREE times — the exact failure T117.2 exists to catch, shipped by the
 * guard meant to prevent it. The hand-written 3-insert test in bus-wake.test.ts
 * caught it before a line of it ran (carry-forward 1); it is kept as the
 * regression.
 *
 * The seq is still carried on the entry, because the log line and the gate need
 * to say WHICH traffic a wake covered. It is just not what decides suppression.
 *
 * ── Why an ACK does not appear here, and why that is the RE-ARM ─────────────
 *
 * It does not need to. An ack advances `cursors.acked_seq` past the lot, so the
 * next sweep computes `pending: false` and returns `no-pending` (#117 acceptance
 * 4). The ledger entry is then dropped by {@link pruneWakeLedger} — and THAT is
 * the only re-arm. It is the right one: an order to `orchestra check` covers
 * every message outstanding at the moment the reader runs it, so new traffic
 * arriving before the reader has obeyed the first order needs no second order.
 * A reader that has acked and then receives new mail has an empty ledger entry
 * and is woken normally.
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
export function decideWake(
  pending: ReaderPendingState,
  session: ReaderSessionState,
  previous: WakeLedgerEntry | undefined,
  switchOn: boolean,
): WakeAction {
  if (!pending.pending) return { kind: 'skip', reader: pending.reader, why: 'no-pending' };
  if (!session.wakeable) return { kind: 'skip', reader: pending.reader, why: 'not-wakeable' };
  if (previous) return { kind: 'skip', reader: pending.reader, why: 'already-woken' };
  const throughSeq = pending.pendingThroughSeq;
  return switchOn
    ? { kind: 'fire', reader: pending.reader, throughSeq }
    : { kind: 'count', reader: pending.reader, throughSeq };
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

/** The ORDER a wake turn carries. A CONSTANT, and the only string the host puts
 *  in a wake — the message BODY never travels this path (#117 acceptance 5).
 *
 *  Why the body is banned rather than merely discouraged: a host that pastes the
 *  message into the turn has silently delivered it, and the reader's `ack` then
 *  certifies a read that the bus never handed over. The order keeps the bus the
 *  single delivery path, so a lot is read exactly where it is acked. */
export const WAKE_ORDER = 'lot pending — run `orchestra check`';

/** True when `text` is a wake order this module produced. Used by the gate to
 *  assert the order is present, and by the body-leak check to assert it is the
 *  ONLY thing present. */
export function isWakeOrder(text: string): boolean {
  return text.trim() === WAKE_ORDER;
}
