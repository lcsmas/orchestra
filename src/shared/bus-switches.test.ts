// #118 — the PURE switch module, tested directly (ledger #123, reviewer N3).
//
// bus-switches.ts is a 236-line pure module (no SQLite, no Electron) that had
// only INDIRECT coverage through bus-runs.test.ts. A pure module deserves its own
// arms so its edge cases — the `=== true` coercion, the wire↔internal mapping,
// the freeze COPY, D1's bus-down force-OFF — are pinned where they live, and so a
// change to this file reddens a test named for it rather than a distant one.
//
// Each test names the property it certifies; the hostile-input arms are the
// load-bearing ones (a switch that turns itself ON from a typo is the exact
// failure the freeze exists to prevent).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUS_MECHANISMS,
  DEFAULT_BUS_SWITCHES,
  BUS_MECHANISM_LABEL,
  normalizeSwitches,
  serializeSwitches,
  parseSwitches,
  freezeSwitches,
  mechanismEnabled,
  mechanismFromWire,
  mechanismToWire,
  switchStateWord,
  busSwitchNoticeLines,
  busSwitchNotice,
  type BusSwitches,
  type BusMechanism,
} from './bus-switches.ts';

// #129 — derive ALL_ON from the mechanism list so a new BusMechanism
// (capability/fencing/receipts) is exercised by every ON arm without a hand
// edit. ALL_OFF already derives from DEFAULT_BUS_SWITCHES.
const ALL_ON: BusSwitches = Object.fromEntries(
  BUS_MECHANISMS.map((m) => [m, true]),
) as BusSwitches;
const ALL_OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };

// ─── The shape ──────────────────────────────────────────────────────────────

test('BUS_MECHANISMS lists the wave B set plus the wave-D additions, and DEFAULT is every one OFF', () => {
  // Wave B: delivery/wake/askGate/liveness. Wave D appends one switch per bus-v2
  // mechanism (ledger #131 RULING D1); #129 adds `capability` (#128 `fencing`,
  // #130 `receipts` append at their rebases). Assert the wave-B four are present
  // and in order, and that `capability` is present — not an exact whole-list
  // match, so a sibling ticket appending its own mechanism does not redden this.
  assert.deepEqual([...BUS_MECHANISMS].slice(0, 4), ['delivery', 'wake', 'askGate', 'liveness']);
  assert.ok(BUS_MECHANISMS.includes('capability'), '#129 adds the capability mechanism');
  // DEFAULT is every KNOWN mechanism OFF — derived, so it grows with the enum.
  for (const m of BUS_MECHANISMS) assert.equal(DEFAULT_BUS_SWITCHES[m], false, `${m} defaults OFF`);
  assert.equal(Object.keys(DEFAULT_BUS_SWITCHES).length, BUS_MECHANISMS.length);
  // Every mechanism has a human label (French per Q13) — no undefined leaks to UI.
  for (const m of BUS_MECHANISMS) assert.equal(typeof BUS_MECHANISM_LABEL[m], 'string');
});

test('DEFAULT_BUS_SWITCHES is frozen — a caller cannot mutate the shared default', () => {
  assert.ok(Object.isFrozen(DEFAULT_BUS_SWITCHES));
});

// ─── normalizeSwitches — the `=== true` coercion is the safety property ──────

test('normalizeSwitches coerces with === true, never truthiness', () => {
  // The hostile inputs that must NOT read as ON — a switch turning itself on from
  // a hand-edited store is exactly what the freeze exists to prevent.
  assert.deepEqual(normalizeSwitches({ delivery: 'true' }), ALL_OFF, 'the string "true" is NOT on');
  assert.deepEqual(normalizeSwitches({ delivery: 1 }), ALL_OFF, 'the number 1 is NOT on');
  assert.deepEqual(normalizeSwitches({ delivery: {} }), ALL_OFF, 'a truthy object is NOT on');
  assert.deepEqual(normalizeSwitches({ delivery: 'on' }), ALL_OFF);
  // The must-PASS half: an actual boolean true DOES read as on.
  assert.equal(normalizeSwitches({ delivery: true }).delivery, true);
});

test('normalizeSwitches defaults each field independently and ignores unknowns', () => {
  // A store written by a build that knew THREE mechanisms upgrades cleanly,
  // keeping the three it set; an unknown key from a NEWER build is dropped.
  const partial = normalizeSwitches({ delivery: true, wake: true });
  assert.deepEqual(partial, { ...ALL_OFF, delivery: true, wake: true });
  const withUnknown = normalizeSwitches({ delivery: true, quantum: true });
  assert.equal('quantum' in withUnknown, false, 'an unknown mechanism is not carried');
  assert.equal(withUnknown.delivery, true);
});

test('normalizeSwitches tolerates null/undefined/non-object → all-OFF', () => {
  assert.deepEqual(normalizeSwitches(null), ALL_OFF);
  assert.deepEqual(normalizeSwitches(undefined), ALL_OFF);
  assert.deepEqual(normalizeSwitches(42), ALL_OFF);
  assert.deepEqual(normalizeSwitches('nope'), ALL_OFF);
});

test('a __proto__ payload does not pollute or turn a switch on', () => {
  const hostile = JSON.parse('{"__proto__":{"wake":true}}');
  const out = normalizeSwitches(hostile);
  assert.deepEqual(out, ALL_OFF, 'prototype-injected wake must not read as on');
});

// ─── serialize / parse round-trip ────────────────────────────────────────────

test('serializeSwitches is stable, explicit, and key-ordered', () => {
  const s = serializeSwitches({ ...ALL_OFF, liveness: true, delivery: true });
  // Keys in BUS_MECHANISMS order regardless of input order — never a bitmask,
  // because a later build with more mechanisms must read this unambiguously.
  // Built from the mechanism list so a new mechanism extends the expected string
  // rather than reddening it (all the added ones serialize false here).
  const expected =
    '{' +
    BUS_MECHANISMS.map((m) => `"${m}":${m === 'delivery' || m === 'liveness'}`).join(',') +
    '}';
  assert.equal(s, expected);
  // And the wave-B prefix is still exactly as frozen (positive control).
  assert.ok(s.startsWith('{"delivery":true,"wake":false,"askGate":false,"liveness":true'));
});

test('parseSwitches round-trips serializeSwitches for every combination', () => {
  // 2^N combinations over the live mechanism list, so a new mechanism widens the
  // sweep instead of leaving its bit untested.
  const n = BUS_MECHANISMS.length;
  for (let bits = 0; bits < 1 << n; bits++) {
    const sw = Object.fromEntries(
      BUS_MECHANISMS.map((m, i) => [m, !!(bits & (1 << i))]),
    ) as BusSwitches;
    assert.deepEqual(parseSwitches(serializeSwitches(sw)), sw, `bits=${bits}`);
  }
});

test('parseSwitches on null/garbage/malformed JSON → all-OFF, never throws', () => {
  assert.deepEqual(parseSwitches(null), ALL_OFF);
  assert.deepEqual(parseSwitches(undefined), ALL_OFF);
  assert.deepEqual(parseSwitches(''), ALL_OFF);
  assert.deepEqual(parseSwitches('{delivery:true'), ALL_OFF, 'malformed JSON is all-OFF, not a throw');
  assert.deepEqual(parseSwitches('[true,true,true,true]'), ALL_OFF, 'a JSON array is all-OFF');
  assert.deepEqual(parseSwitches('null'), ALL_OFF);
});

// ─── freezeSwitches — the COPY and the D1 force-OFF ──────────────────────────

test('freezeSwitches returns a COPY — mutating the caller cannot reach the snapshot', () => {
  const live: BusSwitches = { ...ALL_ON };
  const frozen = freezeSwitches(live);
  live.delivery = false;
  live.wake = false;
  assert.equal(frozen.delivery, true, 'the snapshot must not track a later caller mutation');
  assert.equal(frozen.wake, true);
});

test('freezeSwitches with busAvailable=false forces every mechanism OFF (D1)', () => {
  // When the bus is down, a mechanism the bus would carry reads OFF for the run,
  // recorded on the row so the run stays self-describing as unadopted.
  assert.deepEqual(freezeSwitches(ALL_ON, false), ALL_OFF);
  // The default is busAvailable=true — a normal freeze keeps the live values.
  assert.deepEqual(freezeSwitches(ALL_ON), ALL_ON);
});

// ─── mechanismEnabled ─────────────────────────────────────────────────────────

test('mechanismEnabled reads === true off the frozen set', () => {
  assert.equal(mechanismEnabled(ALL_ON, 'wake'), true);
  assert.equal(mechanismEnabled(ALL_OFF, 'wake'), false);
  // It reads the frozen object it is handed — the type forbids passing live.
  assert.equal(mechanismEnabled({ ...ALL_OFF, askGate: true }, 'askGate'), true);
});

// ─── the wire mapping — the one place snake_case meets camelCase ─────────────

test('mechanismFromWire maps the wire names and refuses everything else', () => {
  assert.equal(mechanismFromWire('delivery'), 'delivery');
  assert.equal(mechanismFromWire('wake'), 'wake');
  assert.equal(mechanismFromWire('ask_gate'), 'askGate', 'snake ask_gate → camel askGate');
  assert.equal(mechanismFromWire('liveness'), 'liveness');
  assert.equal(mechanismFromWire('capability'), 'capability', '#129 capability wire == key');
  // Unknown, and — critically — the INTERNAL key on the wire must be rejected.
  assert.equal(mechanismFromWire('askGate'), null, 'the internal key is not a wire name');
  assert.equal(mechanismFromWire('nope'), null);
  assert.equal(mechanismFromWire(''), null);
});

test('mechanismToWire is the inverse, and ask_gate is the only remapped name', () => {
  assert.equal(mechanismToWire('askGate'), 'ask_gate');
  assert.equal(mechanismToWire('delivery'), 'delivery');
  assert.equal(mechanismToWire('wake'), 'wake');
  assert.equal(mechanismToWire('liveness'), 'liveness');
  assert.equal(mechanismToWire('capability'), 'capability', '#129 capability is not remapped');
});

test('fromWire ∘ toWire is identity on every mechanism (no drift)', () => {
  for (const m of BUS_MECHANISMS) {
    assert.equal(mechanismFromWire(mechanismToWire(m)), m, `round-trip broke for ${m}`);
  }
});

test('mechanismToWire throws on a value that is not a mechanism (never a silent guess)', () => {
  assert.throws(() => mechanismToWire('bogus' as BusMechanism), /no wire name/);
});

// ─── switchStateWord ──────────────────────────────────────────────────────────

test('switchStateWord is ON/OFF', () => {
  assert.equal(switchStateWord(true), 'ON');
  assert.equal(switchStateWord(false), 'OFF');
});

// ─── the notice lines — F4 wire name, both-states, no silence ────────────────

test('busSwitchNoticeLines emits one line per mechanism in the WIRE name (F4)', () => {
  const on = busSwitchNoticeLines(ALL_ON);
  const off = busSwitchNoticeLines(ALL_OFF);
  assert.equal(on.length, BUS_MECHANISMS.length);
  assert.equal(off.length, BUS_MECHANISMS.length);
  // The wire name ask_gate, never the internal askGate.
  const onJoined = on.join('\n');
  const offJoined = off.join('\n');
  assert.match(onJoined, /bus switch ask_gate=ON/);
  assert.match(offJoined, /bus switch ask_gate=OFF/);
  assert.ok(!onJoined.includes('askGate'), 'the internal key must not leak onto the wire');
  assert.ok(!offJoined.includes('askGate'));
});

test('busSwitchNoticeLines names the authority side in both states', () => {
  const on = busSwitchNoticeLines(ALL_ON).join('\n');
  const off = busSwitchNoticeLines(ALL_OFF).join('\n');
  assert.match(on, /the bus is AUTHORITATIVE/);
  assert.match(off, /the OLD channel stays authoritative/);
  assert.match(off, /COUNTS this mechanism, it does not fire it/);
});

test('busSwitchNotice: null only for no-switches; an all-OFF set still PRINTS', () => {
  assert.equal(busSwitchNotice(null), null);
  assert.equal(busSwitchNotice(undefined), null);
  const notice = busSwitchNotice(ALL_OFF);
  assert.ok(notice, 'all-OFF must still produce a notice — silence is unreadable');
  assert.match(notice, /frozen at wave start/);
  // Every mechanism named, in the wire spelling.
  for (const m of BUS_MECHANISMS) assert.ok(notice.includes(`${mechanismToWire(m)}=OFF`));
});
