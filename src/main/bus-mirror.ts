// Shadow mirror — the IMPURE half (#116, ledger #123).
//
// The decision logic is in `src/shared/bus-mirror.ts` (pure, unit-tested). What
// is left here is exactly the part that touches the world: minting a send id,
// the bus INSERT, and the try/catch that makes a bus failure a LOG LINE instead
// of a delivery failure.
//
// ── THE ONE INVARIANT THIS FILE EXISTS TO HOLD ──────────────────────────────
//
// `mirrorDispatch()` is READ-ONLY with respect to delivery. It is called AFTER
// the old channel has already produced its `MessageResult`, it returns void, it
// never throws, and it never awaits anything the caller's return value depends
// on. There is no code path in which the mirror changes what
// `dispatchMessageRequest` returns to its caller. T116.2 is the arm that proves
// it: the DB is removed mid-run, the OLD DELIVERY STILL SUCCEEDS (the delivery
// itself is asserted, not the absence of an error) and an error line is logged.
//
// D1 (wave-A LEAD ruling, ledger #122) — the bus NEVER blocks boot, so
// `getBus()` may return null at ANY moment. A null bus here is a `missed`, not
// an exception: the counters live in memory precisely so a bus outage is
// COUNTED rather than lost (see DivergenceLedger's own comment).

import { randomUUID } from 'node:crypto';
import { getBus, send as busSend, recordMirror, mirroredRowCount } from './bus.ts';
import type { BusDb } from './bus.ts';
import { log } from './logger.ts';
import {
  DivergenceLedger,
  PEER_MESSAGE_MECHANISM,
  outcomeFor,
} from '../shared/bus-mirror.ts';
import type {
  BusDivergenceReport,
  DivergenceCounters,
  MirrorableResult,
  MirrorOutcome,
} from '../shared/bus-mirror.ts';

/** The run (wave) the mirror attributes its rows to.
 *
 *  #115 owns the run LIFECYCLE (`runs` rows, `orchestra run …`). Until that
 *  lands the mirror still has to name a run, so it takes one from the
 *  environment and otherwise falls back to a stable per-boot id. It never
 *  INSERTS into `runs` — migration v1 documents that `messages.run_id` carries
 *  no FK on purpose, so shadowing a run #115 has not declared is legal and
 *  becomes a real row the moment #115 declares it. */
let currentRunId: string | null = null;

export function mirrorRunId(): string {
  if (!currentRunId) {
    currentRunId = process.env.ORCHESTRA_RUN_ID?.trim() || `host-${Date.now().toString(36)}`;
  }
  return currentRunId;
}

/** Test seam: pin the run id (and the ledger scoped to it). */
export function setMirrorRunId(id: string): void {
  currentRunId = id;
  ledger = new DivergenceLedger(id);
  ledger.register(PEER_MESSAGE_MECHANISM);
}

let ledger = new DivergenceLedger(mirrorRunId());
ledger.register(PEER_MESSAGE_MECHANISM);

/** The frozen contract shape (ledger #123 §Seams): what the IPC handler and
 *  `orchestra bus-status` both return. */
export function divergenceCounters(): DivergenceCounters[] {
  return ledger.snapshot();
}

export function divergenceRunId(): string {
  return mirrorRunId();
}

/** Recorded by the host's staleness sweep (#117 owns the wake itself). Exposed
 *  here because the counter belongs to this ticket's frozen shape. */
export function recordLostWake(mechanism: string, n = 1): void {
  ledger.recordLostWake(mechanism, n);
}

export interface MirrorInput {
  mechanism?: string;
  sender: string;
  recipient: string | null;
  body: string;
  /** The old channel's own report. */
  result: MirrorableResult;
  /** Test seam: an explicit db instead of the boot connection. */
  db?: BusDb | null;
}

/**
 * Mirror one send of an old, still-authoritative channel into the bus.
 *
 * ALWAYS returns; NEVER throws. Returns the outcome it recorded so a caller
 * that wants to assert on the mirror (a rig) can, without any caller being able
 * to make delivery depend on it.
 */
export function mirrorDispatch(input: MirrorInput): MirrorOutcome {
  const mechanism = input.mechanism ?? PEER_MESSAGE_MECHANISM;
  // INSIDE the try (review F3): `input.result` is data from a caller, and
  // `outcomeFor` dereferences it. Reading it before the guard put a TypeError
  // on a path whose entire contract is "never throws" — and F1's fix below adds
  // a second reader of this value, which is what made the latent bug live.
  let outcome: MirrorOutcome = 'withdrawn';
  let rows = 0;
  try {
    outcome = outcomeFor(input.result);
    const runId = mirrorRunId();
    const sendId = randomUUID();
    // ── F1 (BLOCKING, review 2026-09-08) ────────────────────────────────────
    // A REFUSED send must NOT become a bus row.
    //
    // `busSend` used to be unconditional, so all four refusal shapes — empty
    // text, unknown target, message-yourself, inbox write failed — landed as
    // real `kind='dispatch'` rows. `bus.check` has no recipient filter, so a
    // reader is handed messages the AUTHORITATIVE channel explicitly refused,
    // in the artifact ADR 0002 calls the SOURCE OF TRUTH. Old channel delivers
    // 1, bus asserts 5.
    //
    // And it was invisible to the instrument built to detect it: `withdrawn` is
    // deliberately not `missed` (a refusal the bus also skipped is agreement),
    // so the counters read the exact 0/0/0 promotion bar while diverging badly.
    //
    // The fix is to SKIP THE INSERT, not to count refusals as `missed` — that
    // would break the promotion bar from the other side, making every self-send
    // typo look like a mirror fault.
    const db = input.db !== undefined ? input.db : getBus();
    if (outcome === 'withdrawn') {
      // NOT an early `return`: that would skip `ledger.record` at the bottom,
      // and a refusal is still a real event the ledger must see — it simply is
      // not a MESSAGE. Falling through with `rows` left at 0 also keeps the
      // accounting honest, since `record()` does not score a withdrawn send as
      // `missed`.
      log.info(
        `bus mirror: ${mechanism} send to ${input.recipient ?? '?'} was REFUSED by the old channel — not mirrored`,
      );
    } else if (!db) {
      // D1: the bus is down. This is a real divergence for a delivered
      // message — record it and say so out loud. It is NOT an error for the
      // delivery, which already happened.
      log.warn(
        `bus mirror: bus unavailable — ${mechanism} send to ${input.recipient ?? '?'} (${outcome}) not mirrored`,
      );
    } else {
      // ── F4 (review 2026-09-08) — ONE transaction, not two bare INSERTs ────
      // A partial write (crash/lock between the two) left a `messages` row that
      // `mirroredRowCount` could not see, so the ledger scored `missed++` for a
      // message the bus DOES hold — a divergence counter reporting the exact
      // opposite of the truth, in the passing-looking direction.
      db.transaction(() => {
        const sequence = busSend(db, {
          runId,
          sender: input.sender,
          recipient: input.recipient,
          kind: 'dispatch',
          body: input.body,
        });
        recordMirror(db, {
          runId,
          mechanism,
          sendId,
          sequence,
          outcome,
          sender: input.sender,
          recipient: input.recipient,
        });
      })();
      rows = mirroredRowCount(db, runId, sendId);
    }
  } catch (e) {
    // THE CATCH T116.2's mutant removes. Everything above is best-effort; the
    // delivery this shadows has already happened and must not be undone by a
    // SQLite error. The message is loud and names the mechanism so an operator
    // can tell a mirror failure from a delivery failure at a glance.
    log.error(
      `bus mirror: FAILED to mirror a ${mechanism} send to ${input.recipient ?? '?'} (delivery outcome ${outcome} stands)`,
      e,
    );
  }
  ledger.record({ mechanism, outcome, rows });
  return outcome;
}

/** The frozen contract, assembled for IPC and for `orchestra bus-status`.
 *
 *  ONE builder feeding BOTH surfaces, deliberately: T116.4 requires the pane and
 *  the CLI to print the SAME numbers, and two independent assemblers is exactly
 *  how they would drift apart without any test noticing. */
export function busDivergenceReport(): BusDivergenceReport {
  return {
    runId: mirrorRunId(),
    busAvailable: getBus() !== null,
    counters: divergenceCounters(),
  };
}
