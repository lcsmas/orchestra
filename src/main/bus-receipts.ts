// Mutation receipts (#130, bus v2) — per-message idempotency for the CLI
// mutations `send` / `ack` / `gate resolve`.
//
// THE PROBLEM v1 LEFT (#108): a lot is acked in BATCH — one ack closes a whole
// delivery — so a retried mutation had no per-message idempotency key. A network
// blip, a re-run of a shell one-liner, a keeper replay: any of these could
// double-apply a `send` (two identical bus rows) or double-resolve a gate.
//
// THE PRIMITIVE: a `(caller_fingerprint, request_id)` composite PRIMARY KEY on
// `mutation_receipts` (bus.ts migration). The caller passes a stable request id;
// the first call runs the mutation and STORES its receipt (the return value);
// a retry with the same key returns that stored receipt and DOES NOT re-run the
// mutation. Two different request ids from the same caller are two independent
// mutations.
//
// COEXISTENCE (ledger #131, standing ruling): this is a switch-gated v2
// mechanism. While its switch is OFF the row is still RECORDED — the shadow
// count that lets a wave measure how often a retry WOULD have been short-
// circuited — but the SHORT-CIRCUIT DOES NOT FIRE: the mutation executes every
// time, exactly as v1 did (two identical sends → two bus rows). Only with the
// switch ON does a replay return the original receipt and skip re-execution.
// The gating boolean is passed in by the caller (the CLI reads it off the run's
// frozen flags via busSwitch); this module never reads the switch itself, so
// the unit suite drives both arms with a plain boolean.

import type { BusDb } from './bus.ts';

/** Which CLI verb produced a receipt. Stored so a request id reused across two
 *  different verbs is refused rather than handed back a receipt of the wrong
 *  shape. Wire-stable — the CLI and the pane read these literals. */
export type BusMutationKind = 'send' | 'ack' | 'gate_resolve';

const MUTATION_KINDS: readonly BusMutationKind[] = ['send', 'ack', 'gate_resolve'];

/** One `mutation_receipts` row. `receipt` is the JSON-encoded original return. */
export interface BusMutationReceipt {
  caller_fingerprint: string;
  request_id: string;
  mutation: BusMutationKind;
  run_id: string;
  receipt: string;
  created_at: number;
}

/** Read one stored receipt back by its composite key, or null. The key is
 *  (run_id, caller_fingerprint, request_id) — run_id is part of it (review #130
 *  F1), so a request id is scoped to its run, never global. */
export function lookupReceipt(
  db: BusDb,
  runId: string,
  callerFingerprint: string,
  requestId: string,
): BusMutationReceipt | null {
  return (
    (db
      .prepare(
        'SELECT * FROM mutation_receipts WHERE run_id=? AND caller_fingerprint=? AND request_id=?',
      )
      .get(runId, callerFingerprint, requestId) as BusMutationReceipt | undefined) ?? null
  );
}

/**
 * The result of running a mutation through {@link withReceipt}.
 *
 * `replayed` is the FIRED shadow signal a caller reports: true only when the
 * short-circuit actually fired (switch ON and a prior receipt existed). It is
 * false on a first call, and false while the switch is OFF EVEN IF a prior
 * receipt exists — because with the switch off the mutation was re-executed,
 * not short-circuited. `value` is the parsed original receipt on a replay, or
 * the fresh mutation's return on a first (or switch-off) call.
 */
export interface ReceiptOutcome<T> {
  value: T;
  /** True iff the replay short-circuit FIRED (switch ON + prior receipt). */
  replayed: boolean;
  /** True iff a stored receipt for this key existed BEFORE this call — the
   *  COUNTED signal, independent of whether the short-circuit fired. */
  counted: boolean;
}

/** Counters for the shadow-observation deliverable (module-global, like
 *  bus-liveness). `countedReplays` = retries a prior receipt was found for;
 *  `firedReplays` = of those, how many the switch let short-circuit. */
export interface BusReceiptCounters {
  /** A retry seen (prior receipt existed) — counted regardless of the switch. */
  countedReplays: number;
  /** A retry the switch let SHORT-CIRCUIT (switch ON). Always ≤ countedReplays. */
  firedReplays: number;
  /** New receipt rows recorded (first calls). */
  recorded: number;
}

const counters: BusReceiptCounters = { countedReplays: 0, firedReplays: 0, recorded: 0 };

/** Snapshot the counters (fresh object; never the live one). */
export function busReceiptCounters(): BusReceiptCounters {
  return { ...counters };
}

/** Reset the counters — the rig seam. Production never calls this. */
export function resetBusReceiptCounters(): void {
  counters.countedReplays = 0;
  counters.firedReplays = 0;
  counters.recorded = 0;
}

/**
 * Run a mutation idempotently under a receipt.
 *
 * `exec` performs the real mutation and returns a JSON-serializable receipt (a
 * send's sequence, an ack's / resolve's boolean). `switchOn` is the run's frozen
 * gating flag (COUNTED-not-FIRED while off).
 *
 * The ENTIRE decision runs inside ONE transaction so a concurrent retry cannot
 * slip between the lookup and the record: the PK insert is `INSERT OR IGNORE`,
 * so if two racing callers both miss the lookup, exactly one row lands and the
 * loser's own exec still ran (v1-safe — a double execute is what the OLD channel
 * already does; the receipt makes the FIRST winner's value authoritative on the
 * next replay). BEGIN IMMEDIATE takes the write lock up front (the deferred-
 * upgrade SQLITE_BUSY source bus.ts's check()/ack() avoid the same way).
 *
 * WHY THE SWITCH ONLY GATES THE SHORT-CIRCUIT, NOT THE RECORD: recording the
 * row while OFF is the shadow count — remove it and the divergence counter can
 * never leave zero, the "counter that never moves" disproof (mirror_records
 * makes the same choice). Firing the short-circuit while OFF would change v1
 * behaviour under a switch that is supposed to be inert, the coexistence
 * violation. So: OFF → always record (if absent) + always run exec + never
 * return a stored value; ON → return the stored value without running exec when
 * a receipt exists.
 */
export function withReceipt<T>(
  db: BusDb,
  input: {
    callerFingerprint: string;
    requestId: string;
    mutation: BusMutationKind;
    runId: string;
    switchOn: boolean;
  },
  exec: () => T,
): ReceiptOutcome<T> {
  if (!input.callerFingerprint?.trim()) {
    throw new Error('bus.withReceipt: callerFingerprint is required');
  }
  if (!input.requestId?.trim()) throw new Error('bus.withReceipt: requestId is required');
  if (!MUTATION_KINDS.includes(input.mutation)) {
    throw new Error(`bus.withReceipt: unknown mutation ${JSON.stringify(input.mutation)}`);
  }

  // The key is (run_id, caller_fingerprint, request_id) — run_id scoped so the
  // same handle + request_id in a DIFFERENT run does NOT collide (review #130 F1).
  const getExisting = db.prepare(
    'SELECT * FROM mutation_receipts WHERE run_id=? AND caller_fingerprint=? AND request_id=?',
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO mutation_receipts
       (run_id, caller_fingerprint, request_id, mutation, receipt, created_at)
     VALUES (?,?,?,?,?,?)`,
  );

  const tx = db.transaction((): ReceiptOutcome<T> => {
    const existing = getExisting.get(input.runId, input.callerFingerprint, input.requestId) as
      | BusMutationReceipt
      | undefined;

    if (existing) {
      // A request id reused across two DIFFERENT verbs is a caller bug, not a
      // retry — the stored receipt shape would not match. Refuse rather than
      // hand back the wrong shape. This throw rolls back the DB transaction, so
      // the COUNTED increment must come AFTER it (review #130 F3): incrementing
      // before would leave the JS module-global counter inflated with no matching
      // row when the tx rolls back — a shadow-metric skew the DB does not have.
      if (existing.mutation !== input.mutation) {
        throw new Error(
          `bus.withReceipt: request id ${JSON.stringify(input.requestId)} for ` +
            `${input.callerFingerprint} in run ${JSON.stringify(input.runId)} was first used for mutation ` +
            `${JSON.stringify(existing.mutation)}, now ${JSON.stringify(input.mutation)} — a request id is per-mutation`,
        );
      }
      // A genuine retry (same verb): COUNTED always, past the mismatch guard.
      counters.countedReplays++;
      if (input.switchOn) {
        // FIRED: return the original receipt, DO NOT re-run exec.
        counters.firedReplays++;
        return { value: JSON.parse(existing.receipt) as T, replayed: true, counted: true };
      }
      // COUNTED-not-FIRED: switch OFF → v1 behaviour, re-run the mutation.
      const value = exec();
      return { value, replayed: false, counted: true };
    }

    // First call for this key: run the mutation, then record its receipt.
    const value = exec();
    insert.run(
      input.runId,
      input.callerFingerprint,
      input.requestId,
      input.mutation,
      JSON.stringify(value),
      Date.now(),
    );
    counters.recorded++;
    return { value, replayed: false, counted: false };
  });
  return tx.immediate();
}

/** How many receipt rows exist for a run — the pane's / bus-status's read. */
export function receiptRowCount(db: BusDb, runId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM mutation_receipts WHERE run_id=?')
    .get(runId) as { n: number };
  return Number(row.n);
}
