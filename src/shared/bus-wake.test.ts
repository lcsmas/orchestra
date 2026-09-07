import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWake,
  pruneWakeLedger,
  isWakeOrder,
  WAKE_ORDER,
  type ReaderPendingState,
  type WakeLedgerEntry,
} from './bus-wake.ts';

// Pure policy tests for the wake DECISION (#117, ledger #123 gate block T117).
//
// EACH TEST NAMES THE PRODUCTION CLAUSE IT KILLS, because C10 mutates those
// clauses and requires the named test to go RED. A test that survives its own
// mutant is decoration, so the mutant is written down beside it.
//
// Every input here is written BY HAND. Carry-forward 1: if the failing input can
// be authored, discovering that the gate is blind should not require luck.

const R = 'ws-reader';

function pending(overrides: Partial<ReaderPendingState> = {}): ReaderPendingState {
  return { reader: R, pendingThroughSeq: 7, pending: true, ...overrides };
}
const WAKEABLE = { wakeable: true };

// ── The switch: COUNTED, not FIRED (standing ruling; gate C7) ───────────────

test('switch ON fires; switch OFF counts — and the two are DISTINGUISHABLE', () => {
  // MUTANT (C10): invert the `switchOn ?` ternary in decideWake → this goes red.
  const on = decideWake(pending(), WAKEABLE, undefined, true);
  assert.equal(on.kind, 'fire');

  const off = decideWake(pending(), WAKEABLE, undefined, false);
  // The load-bearing half. `skip` would ALSO produce "no turn fired", which is
  // why asserting only "did not fire" is vacuous: it passes on a build where
  // the mechanism does not exist. C7 names exactly that as its own disproof.
  assert.equal(off.kind, 'count');
  assert.notEqual(off.kind, 'skip');
  assert.equal(off.kind === 'count' && off.throughSeq, 7);
});

// ── Dedup: N inserts while busy = ONE wake (T117.2) ────────────────────────

test('a reader already woken through this high-water is NOT woken again', () => {
  // MUTANT (C10): delete the `previous.wokeThroughSeq >= …` guard → red here,
  // and T117.2's integration arm sees 3 wakes instead of 1.
  const prev: WakeLedgerEntry = { wokeThroughSeq: 7 };
  const again = decideWake(pending({ pendingThroughSeq: 7 }), WAKEABLE, prev, true);
  assert.equal(again.kind, 'skip');
  assert.equal(again.kind === 'skip' && again.why, 'already-woken');
});

test('three inserts landing while the reader is busy produce exactly ONE fire', () => {
  // The literal count 1, not "at least one" (T117.2 says so explicitly).
  const ledger = new Map<string, WakeLedgerEntry>();
  let fires = 0;
  // seq 5, then 6, then 7 arrive between sweeps; the reader acks nothing.
  for (const seq of [5, 6, 7]) {
    const a = decideWake(pending({ pendingThroughSeq: seq }), WAKEABLE, ledger.get(R), true);
    if (a.kind === 'fire') {
      fires++;
      ledger.set(R, { wokeThroughSeq: a.throughSeq });
    }
  }
  assert.equal(fires, 1);
});

test('NEW traffic does not re-wake a reader whose order is still outstanding', () => {
  // The corrected semantics, stated as an assertion so it cannot drift back.
  // An order to `orchestra check` covers everything outstanding when the reader
  // obeys it, so mail arriving at a HIGHER sequence before the reader has
  // checked needs no second order. This is the same clause as the 3-insert test
  // above, asserted directly rather than through a loop.
  const prev: WakeLedgerEntry = { wokeThroughSeq: 7 };
  const newer = decideWake(pending({ pendingThroughSeq: 8 }), WAKEABLE, prev, true);
  assert.equal(newer.kind, 'skip');
  assert.equal(newer.kind === 'skip' && newer.why, 'already-woken');
});

// ── No pending state, and unwakeable readers ───────────────────────────────

test('no pending state → skip, with a reason that is not "already-woken"', () => {
  const a = decideWake(pending({ pending: false }), WAKEABLE, undefined, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'no-pending');
});

test('an unwakeable (archived) reader is never fired at, even with pending work', () => {
  const a = decideWake(pending(), { wakeable: false }, undefined, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'not-wakeable');
});

// ── The ack path (T117.4) ──────────────────────────────────────────────────

test('pruneWakeLedger drops a reader that no longer has pending state', () => {
  // This is HOW an ack clears pending: the ack advances cursors.acked_seq, the
  // next sweep computes pending:false, and the prune drops the mark. Without
  // the prune the mark would be stale-but-harmless today and would suppress the
  // NEXT genuine lot whose sequence happened to fall below it.
  const ledger = new Map<string, WakeLedgerEntry>([[R, { wokeThroughSeq: 7 }]]);
  pruneWakeLedger(ledger, new Set());
  assert.equal(ledger.has(R), false);
});

test('pruneWakeLedger KEEPS a reader still pending — a positive control', () => {
  // Carry-forward 4: the test above proves the prune can delete. This one proves
  // it can also NOT delete, so a prune that simply cleared the map every tick
  // (and thereby re-woke on every sweep) does not read as passing.
  const ledger = new Map<string, WakeLedgerEntry>([[R, { wokeThroughSeq: 7 }]]);
  pruneWakeLedger(ledger, new Set([R]));
  assert.equal(ledger.get(R)?.wokeThroughSeq, 7);
});

test('after an ack, a re-inserted lot at a LOWER sequence still wakes', () => {
  // The composed behaviour T117.4 and its follow-on depend on: prune, then a
  // fresh decision with no ledger entry.
  const ledger = new Map<string, WakeLedgerEntry>([[R, { wokeThroughSeq: 7 }]]);
  pruneWakeLedger(ledger, new Set()); // reader acked; nothing pending
  const a = decideWake(pending({ pendingThroughSeq: 3 }), WAKEABLE, ledger.get(R), true);
  assert.equal(a.kind, 'fire');
});

// ── The order carries NO body (T117.5) ─────────────────────────────────────

test('WAKE_ORDER names the verb and contains no message body slot', () => {
  assert.match(WAKE_ORDER, /orchestra check/);
  // A format string would be the only way a body could reach this path.
  assert.equal(/%s|\{\}|\$\{/.test(WAKE_ORDER), false);
});

test('isWakeOrder is as SPECIFIC as the claim it certifies', () => {
  // Carry-forward 2: fed a string that MENTIONS the marker without being the
  // order, it must be red. A `.includes('orchestra check')` predicate would
  // pass all three of these and certify nothing.
  assert.equal(isWakeOrder(WAKE_ORDER), true);
  assert.equal(isWakeOrder(`${WAKE_ORDER}\n\nsecret body text`), false);
  assert.equal(isWakeOrder('please run `orchestra check` when you can'), false);
  assert.equal(isWakeOrder('the order mentions orchestra check but is prose'), false);
});
