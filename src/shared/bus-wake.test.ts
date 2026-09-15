import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWake,
  pruneWakeLedger,
  isWakeOrder,
  buildWakeOrder,
  wakeOrderRuns,
  WAKE_ORDER_HEADER,
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

test('#134 D2 — buildWakeOrder names each run and carries no body slot', () => {
  const order = buildWakeOrder(['ops-wave', 'lead-mission']);
  assert.match(order, /orchestra check --run ops-wave/);
  assert.match(order, /orchestra check --run lead-mission/);
  // Runs are sorted + deduped for a stable string.
  assert.equal(buildWakeOrder(['b', 'a', 'a']), buildWakeOrder(['a', 'b']));
  // No format-string slot could smuggle a body in.
  assert.equal(/%s|\{\}|\$\{/.test(order), false);
});

test('#134 D2 — isWakeOrder is as SPECIFIC as the claim it certifies (carry-forward 2)', () => {
  const order = buildWakeOrder(['r1']);
  assert.equal(isWakeOrder(order), true);
  // A pasted body adds a non-matching line → red (the body-leak guard).
  assert.equal(isWakeOrder(`${order}\nsecret body text`), false);
  // The bare header with NO run line is not a valid order (must name a run).
  assert.equal(isWakeOrder(WAKE_ORDER_HEADER), false);
  // Prose that merely MENTIONS the verb is not the order.
  assert.equal(isWakeOrder('please run `orchestra check` when you can'), false);
  assert.equal(isWakeOrder('the order mentions orchestra check but is prose'), false);
});

test('#134 D2 — wakeOrderRuns extracts exactly the runs the order names', () => {
  assert.deepEqual(wakeOrderRuns(buildWakeOrder(['a', 'b'])), ['a', 'b']);
  assert.deepEqual(wakeOrderRuns('not an order'), []);
});

// ── TWO SWITCHES, ONE ORDER (#119): the gate half rides askGate, not wake ────

test('gate-only pending fires under askGate, NOT under wake', () => {
  // MUTANT: gate `gateFires` on `switchOn` instead of `askGateOn` → the first
  //   assertion (wake ON, askGate OFF) would fire → red.
  const gateOnly = pending({ pending: false, gatePending: true, gateThroughSeq: 4 });
  // wake ON but askGate OFF: the gate must NOT fire — it is counted.
  const wakeOnly = decideWake(gateOnly, WAKEABLE, undefined, true, false);
  assert.equal(wakeOnly.kind, 'count', 'a gate does not fire on the wake switch');
  // askGate ON: it fires, at the GATE high-water (4), not the message seq.
  const gateOn = decideWake(gateOnly, WAKEABLE, undefined, false, true);
  assert.equal(gateOn.kind, 'fire');
  assert.equal(gateOn.kind === 'fire' && gateOn.throughSeq, 4, 'the fire covers the gate id, not a lot seq');
});

test('a reader pending for BOTH a lot and a gate produces ONE action (one order)', () => {
  // The coalescing invariant "at most one wake per reader". With both switches ON,
  // one fire, at the max of the two justifying high-waters.
  const both = pending({ pendingThroughSeq: 7, gatePending: true, gateThroughSeq: 9 });
  const a = decideWake(both, WAKEABLE, undefined, true, true);
  assert.equal(a.kind, 'fire');
  assert.equal(a.kind === 'fire' && a.throughSeq, 9, 'the one order covers both — max high-water');
});

test('mixed switches: only the ON source raises the high-water', () => {
  // wake OFF, askGate ON: fire, and the mark is the GATE seq only — the OFF lot
  // must not raise it, or its counted-not-fired state is masked next sweep.
  // MUTANT: use `Math.max(lotSeq, gateSeq)` unconditionally in the fire branch →
  //   throughSeq becomes 7 → red.
  const both = pending({ pendingThroughSeq: 7, gatePending: true, gateThroughSeq: 4 });
  const a = decideWake(both, WAKEABLE, undefined, false, true);
  assert.equal(a.kind, 'fire');
  assert.equal(a.kind === 'fire' && a.throughSeq, 4, 'only the ON (gate) source justifies the mark');
});

test('neither switch on, both pending → count across every pending source', () => {
  const both = pending({ pendingThroughSeq: 7, gatePending: true, gateThroughSeq: 9 });
  const a = decideWake(both, WAKEABLE, undefined, false, false);
  assert.equal(a.kind, 'count');
  assert.equal(a.kind === 'count' && a.throughSeq, 9, 'counted at the max pending high-water');
});

test('gate default: omitting askGateOn keeps the pre-#119 behaviour (gate never fires)', () => {
  // Back-compat: the 4-arg call every #117 caller makes leaves gates OFF.
  const gateOnly = pending({ pending: false, gatePending: true, gateThroughSeq: 4 });
  const a = decideWake(gateOnly, WAKEABLE, undefined, true /* wake */); // no 5th arg
  assert.equal(a.kind, 'count', 'without the askGate arg a gate is counted, never fired');
});
