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

// ── #150: re-wake for NEWER mail after the reader ACKED the outstanding order ─
//
// The three ticket must-FAIL arms, driving the CHANGED decideWake end-to-end
// through a mini-sweep that mirrors the effectful loop: prune on the pending set,
// pass `ledger.get(reader)` as `previous`, and on fire/count re-`set` the entry
// with `wokeThroughSeq = action.throughSeq` (exactly src/main/bus-wake.ts L526).
// The reader's cursor (`cursorSeq`) is the re-arm signal — MUTANT: revert the
// L188 guard to `if (previous) skip('already-woken')` and arm (1) goes red while
// arm (2) stays green; that pairing is what proves the fix is NOT a bare `>`.

/** One sweep tick: prune the reader if it has no pending, then decide + record. */
function sweep(
  ledger: Map<string, WakeLedgerEntry>,
  p: ReaderPendingState,
  switchOn = true,
): ReturnType<typeof decideWake> {
  pruneWakeLedger(ledger, new Set(p.pending || p.gatePending === true ? [p.reader] : []));
  const action = decideWake(p, WAKEABLE, ledger.get(p.reader), switchOn);
  if (action.kind === 'fire' || action.kind === 'count') {
    ledger.set(action.reader, { wokeThroughSeq: action.throughSeq });
  }
  return action;
}

test('#150 arm 1 — acked through N, mail N+1 arrives, unrelated pending survives → RE-WAKES', () => {
  // Live repro shape: woken through 633, acked 633, new mail 636 then 638 while an
  // OLDER unrelated lot keeps the pending set non-empty (so pruneWakeLedger never
  // drops the entry). Pre-fix (bare `if (previous) skip`) the reader is NEVER
  // re-woken; post-fix the sweep AFTER the ack re-wakes through the new high-water.
  const ledger = new Map<string, WakeLedgerEntry>();

  // Sweep 1: pending through 633, cursor 632 (633 not yet acked) → first wake.
  const w1 = sweep(ledger, pending({ pendingThroughSeq: 633, cursorSeq: 632 }));
  assert.equal(w1.kind, 'fire');
  assert.equal(ledger.get(R)?.wokeThroughSeq, 633);

  // The reader ACKS 633. New mail 636/638 arrives; older unrelated mail is still
  // unacked so `pending` stays true and the entry is NOT pruned. cursor now 633.
  const w2 = sweep(ledger, pending({ pendingThroughSeq: 638, cursorSeq: 633 }));
  assert.equal(w2.kind, 'fire', 'the ack through 633 re-arms; 638 is new mail');
  assert.equal(w2.kind === 'fire' && w2.throughSeq, 638);
  assert.equal(ledger.get(R)?.wokeThroughSeq, 638);

  // Bounded by ACKS not sweeps: without a further ack, no third wake.
  const w3 = sweep(ledger, pending({ pendingThroughSeq: 638, cursorSeq: 633 }));
  assert.equal(w3.kind, 'skip', 'no further ack → no re-wake, dedup holds');
  assert.equal(w3.kind === 'skip' && w3.why, 'already-woken');
});

test('#150 arm 2 — woken through N, reader does NOT ack, no new mail → NOT re-woken', () => {
  // The dedup-preservation arm. Same high-water across sweeps, cursor never moves
  // (< wokeThroughSeq) → the reader stays suppressed. This is the arm that a bare
  // `pendingThroughSeq > wokeThroughSeq` fix ALSO passes but that T117.2 (rising
  // seqs) breaks — kept alongside arm 1 so the pair pins the cursor semantics.
  const ledger = new Map<string, WakeLedgerEntry>();
  const w1 = sweep(ledger, pending({ pendingThroughSeq: 633, cursorSeq: 632 }));
  assert.equal(w1.kind, 'fire');

  for (let i = 0; i < 3; i++) {
    // three sweeps, no ack (cursor stuck at 632), no new mail (still 633).
    const w = sweep(ledger, pending({ pendingThroughSeq: 633, cursorSeq: 632 }));
    assert.equal(w.kind, 'skip');
    assert.equal(w.kind === 'skip' && w.why, 'already-woken');
  }
});

test('#150 — rising seqs WITHOUT an ack is still ONE wake (T117.2 preserved through cursor)', () => {
  // The needle: NEW mail rising 5→6→7 before ANY ack must NOT re-wake (that is
  // T117.2). Only a cursor advance re-arms. Distinct from the loop test above:
  // here the cursor is explicitly held at 0 while pendingThroughSeq rises.
  const ledger = new Map<string, WakeLedgerEntry>();
  let fires = 0;
  for (const seq of [5, 6, 7]) {
    const a = sweep(ledger, pending({ pendingThroughSeq: seq, cursorSeq: 0 }));
    if (a.kind === 'fire') fires++;
  }
  assert.equal(fires, 1, 'rising pending with no ack = one wake — no bare `>` re-fire');
});

test('#150 gate exclusion — a gate-pending reader is NOT re-armed by a message cursor', () => {
  // review-150's probe: `wokeThroughSeq` for a gate wake is a GATE ID, which
  // shares no numbering with the message cursor. A reader pending for a gate,
  // woken through gate id 4, whose message cursor is HIGH (633 from unrelated
  // acked lot traffic) must NOT be treated as "acked through the gate" — else the
  // cursor (633 >= 4) would spuriously re-arm and re-fire the gate every sweep.
  // Gates keep the presence dedup; their own re-wake is answer-based (#119), out
  // of #150's scope. MUTANT: drop the `gatePending` guard in the helper → red.
  const prev: WakeLedgerEntry = { wokeThroughSeq: 4 }; // a gate id
  const gateReader = pending({
    pending: false,
    gatePending: true,
    gateThroughSeq: 4,
    cursorSeq: 633, // unrelated acked lot cursor, far past the gate id
  });
  const a = decideWake(gateReader, WAKEABLE, prev, false /* wake */, true /* askGate */);
  assert.equal(a.kind, 'skip', 'a message cursor must not re-arm a gate wake');
  assert.equal(a.kind === 'skip' && a.why, 'already-woken');
});

test('#150 arm 3 — the ask re-wake path (reWakeUntilAnswered) is UNCHANGED by the lot re-arm', () => {
  // An ask reader's pending is answer-based: even after it acks (cursor advances
  // past wokeThroughSeq) the LOT re-arm here must NOT re-fire it — the ask path
  // keeps its own effectful `cursorAtWake` re-arm (src/main/bus-wake.ts), which
  // this pure decision must leave to that layer. So with a `previous` present and
  // reWakeUntilAnswered=true, decideWake SKIPS regardless of the cursor.
  const prev: WakeLedgerEntry = { wokeThroughSeq: 633, cursorAtWake: 632 };
  const askAckedPast = pending({
    pendingThroughSeq: 633,
    cursorSeq: 999, // acked far past — would re-arm a LOT reader
    reWakeUntilAnswered: true,
  });
  const a = decideWake(askAckedPast, WAKEABLE, prev, true);
  assert.equal(a.kind, 'skip', 'the pure lot re-arm never touches an ask reader');
  assert.equal(a.kind === 'skip' && a.why, 'already-woken');
});
