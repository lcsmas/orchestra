// Unit tests for the shadow mirror's PURE half (#116, ledger #123).
//
// These cover the DECISION logic only. The three delivery outcomes are each
// produced by a real rig in src/main/bus-mirror.test.ts — a pure test can assert
// that `{ok:true, delivery:'inbox'}` maps to `inbox`, but it cannot prove that
// dispatchMessageRequest ever PRODUCES that shape, which is what T116.3 asks.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DivergenceLedger,
  PEER_MESSAGE_MECHANISM,
  outcomeFor,
} from './bus-mirror.ts';

// ─── outcomeFor: the three outcomes must be distinguishable ─────────────────

test('outcomeFor maps each of the old channel\'s five reports onto its outcome', () => {
  // The five shapes dispatchMessageRequest actually returns, enumerated from
  // its six `return` statements. Written by hand, not sampled: carry-forward 1
  // — if I can write the failing input by hand I do not need luck to find the
  // gate blind.
  assert.equal(outcomeFor({ ok: true, delivery: 'live' }), 'live');
  assert.equal(outcomeFor({ ok: true, delivery: 'started' }), 'live');
  assert.equal(outcomeFor({ ok: true, delivery: 'inbox' }), 'inbox');
  assert.equal(outcomeFor({ ok: false }), 'withdrawn');

  // THE DISCRIMINATING ARM. This is the one that would still pass if the whole
  // mapping collapsed to a constant, so it is asserted as a SET: three distinct
  // values must come out of the five inputs. An outcome column that only ever
  // holds one value is #116's own stated disproof of T116.3.
  const produced = new Set(
    [
      { ok: true, delivery: 'live' as const },
      { ok: true, delivery: 'started' as const },
      { ok: true, delivery: 'inbox' as const },
      { ok: false },
    ].map(outcomeFor),
  );
  assert.deepEqual([...produced].sort(), ['inbox', 'live', 'withdrawn']);
});

test('a failed dispatch is withdrawn even when it carries a stale delivery field', () => {
  // ok:false is read FIRST. If the switch were consulted before the ok check,
  // this would record a delivery that never happened — the "stronger false
  // status" #57 exists to kill.
  assert.equal(outcomeFor({ ok: false, delivery: 'live' }), 'withdrawn');
  assert.equal(outcomeFor({ ok: false, delivery: 'inbox' }), 'withdrawn');
});

test('ok:true with no delivery field is withdrawn, not guessed live', () => {
  assert.equal(outcomeFor({ ok: true }), 'withdrawn');
});

// ─── DivergenceLedger ───────────────────────────────────────────────────────

test('a clean mirror reports explicit zeros, not an absent mechanism', () => {
  // T116.4's second half: a counter whose ZERO is unobservable is as useless as
  // one that never moves. Without register(), "no divergence" and "the mirror
  // never ran" would be the same observable (an empty array).
  const led = new DivergenceLedger('run-a');
  led.register(PEER_MESSAGE_MECHANISM);
  assert.deepEqual(led.snapshot(), [
    { mechanism: PEER_MESSAGE_MECHANISM, missed: 0, duplicate: 0, lostWake: 0 },
  ]);

  led.record({ mechanism: PEER_MESSAGE_MECHANISM, outcome: 'live', rows: 1 });
  led.record({ mechanism: PEER_MESSAGE_MECHANISM, outcome: 'inbox', rows: 1 });
  assert.deepEqual(led.snapshot(), [
    { mechanism: PEER_MESSAGE_MECHANISM, missed: 0, duplicate: 0, lostWake: 0 },
    // still all zeros — a healthy mirror diverges nowhere
  ]);
});

test('missed increments when a DELIVERED send produced no bus row', () => {
  const led = new DivergenceLedger('run-b');
  led.record({ mechanism: 'm', outcome: 'live', rows: 0 });
  led.record({ mechanism: 'm', outcome: 'inbox', rows: 0 });
  assert.equal(led.snapshot()[0].missed, 2);
});

test('a WITHDRAWN send with no bus row is agreement, not a miss', () => {
  // The old channel delivered nothing, so the bus having nothing is the two
  // channels AGREEING. Counting it would make `missed` permanently non-zero for
  // every self-send typo and drown the signal the promotion bar reads.
  const led = new DivergenceLedger('run-c');
  led.record({ mechanism: 'm', outcome: 'withdrawn', rows: 0 });
  assert.equal(led.snapshot()[0].missed, 0);
});

test('duplicate counts the EXTRA rows, and stays 0 at exactly one', () => {
  const led = new DivergenceLedger('run-d');
  led.record({ mechanism: 'm', outcome: 'live', rows: 1 });
  assert.equal(led.snapshot()[0].duplicate, 0, 'one row is not a duplicate');
  led.record({ mechanism: 'm', outcome: 'live', rows: 2 });
  assert.equal(led.snapshot()[0].duplicate, 1);
  led.record({ mechanism: 'm', outcome: 'live', rows: 4 });
  assert.equal(led.snapshot()[0].duplicate, 4, '1 + 3 extra rows');
});

test('lostWake is recorded independently of the send path', () => {
  const led = new DivergenceLedger('run-e');
  led.recordLostWake('m');
  led.recordLostWake('m', 3);
  const c = led.snapshot()[0];
  assert.equal(c.lostWake, 4);
  assert.equal(c.missed, 0, 'a lost wake is not a miss');
});

test('snapshot is sorted and is a COPY the caller cannot mutate into the ledger', () => {
  const led = new DivergenceLedger('run-f');
  led.register('zebra');
  led.register('alpha');
  assert.deepEqual(led.snapshot().map((c) => c.mechanism), ['alpha', 'zebra']);
  const snap = led.snapshot();
  snap[0].missed = 99;
  assert.equal(led.snapshot()[0].missed, 0, 'the ledger is not aliased into its report');
});
