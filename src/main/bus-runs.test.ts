// #118 — THE FREEZE, tested against a real SQLite file (ledger #123 T118.2).
//
// Every test here names the clause it kills. The headline claim is: a run's
// per-mechanism flags are read at wave start, RECORDED ON THE RUN ROW, and a
// mid-wave flip does not change them — while a NEW run picks the new value up.
//
// The C10 mutant these must go red for: reading the flags LIVE instead of from
// the run row (i.e. replacing `runFlags(db, id)` with `getLiveSwitches()`).
// `test('MUTANT ...')` below drives exactly that substitution in-process so the
// discriminating power is measured, not asserted — see its comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBus, send, check, type BusDb } from './bus.ts';
import {
  startRun,
  getRun,
  runFlags,
  busSwitch,
  listRuns,
  ensureRunFlagsSchema,
} from './bus-runs.ts';
import {
  mechanismFromWire,
  mechanismToWire,
  DEFAULT_BUS_SWITCHES,
  freezeSwitches,
  mechanismEnabled,
  normalizeSwitches,
  parseSwitches,
  serializeSwitches,
  busSwitchNotice,
  busSwitchNoticeLines,
  BUS_MECHANISMS,
  type BusSwitches,
} from '../shared/bus-switches.ts';

function tmpDb(): { db: BusDb; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'bus-runs-118-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  ensureRunFlagsSchema(db);
  return { db, dir };
}

function cleanup(db: BusDb, dir: string) {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

const ALL_ON: BusSwitches = { delivery: true, wake: true, askGate: true, liveness: true };
const ALL_OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };

// ─── The freeze ─────────────────────────────────────────────────────────────

test('T118.2 — the run row carries the flags frozen at wave start', () => {
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'wave-b', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);
    const row = getRun(db, 'wave-b');
    assert.ok(row, 'the run row must exist');
    // Assert the ROW, not a return value: T118.2 says "assert the run row itself".
    assert.deepEqual(row.flags, ALL_ON);
    // And assert it is on the row in the DB, read through a fresh statement —
    // not a cached object the writer happens to still hold.
    const raw = db.prepare('SELECT flags FROM run_flags WHERE run_id=?').get('wave-b') as {
      flags: string;
    };
    assert.deepEqual(JSON.parse(raw.flags), ALL_ON);
  } finally {
    cleanup(db, dir);
  }
});

test('T118.2 — flipping a switch MID-WAVE does not change the running run row', () => {
  const { db, dir } = tmpDb();
  try {
    // Wave start: delivery ON, everything else OFF.
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false };
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, live);
    assert.equal(runFlags(db, 'run-1').delivery, true);
    assert.equal(runFlags(db, 'run-1').wake, false);

    // THE FLIP. A human toggles wake ON and delivery OFF while run-1 is live.
    live.wake = true;
    live.delivery = false;

    // The running run's row is UNCHANGED — both directions, per T118.2:
    // the ON flag stays ON and the OFF flag stays OFF. Asserting only one
    // direction would pass on a row that had been zeroed out entirely.
    const after = runFlags(db, 'run-1');
    assert.equal(after.delivery, true, 'a frozen ON flag must not go off mid-wave');
    assert.equal(after.wake, false, 'a frozen OFF flag must not come on mid-wave');
  } finally {
    cleanup(db, dir);
  }
});

test('T118.2 — a NEW run picks up the new switch values', () => {
  const { db, dir } = tmpDb();
  try {
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false };
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, live);
    live.wake = true;
    live.delivery = false;
    startRun(db, { id: 'run-2', kind: 'vague', coordinator: 'ops-b' }, live);

    // The two runs disagree, which is the whole point: run-1 is frozen at the
    // old values and run-2 at the new ones, simultaneously, in one DB.
    assert.equal(runFlags(db, 'run-1').delivery, true);
    assert.equal(runFlags(db, 'run-1').wake, false);
    assert.equal(runFlags(db, 'run-2').delivery, false);
    assert.equal(runFlags(db, 'run-2').wake, true);
  } finally {
    cleanup(db, dir);
  }
});

test('MUTANT (C10) — reading flags LIVE instead of from the run row is detectable', () => {
  // The mutation C10 names for #118, driven in-process rather than described:
  // `liveRead` is what the production code would become if the freeze were
  // removed. This test asserts the two readers DISAGREE after a mid-wave flip.
  //
  // Why this is the honest form: it proves the assertion in the test above has
  // discriminating power. If live-read and row-read returned the same thing
  // here, T118.2's green would be decoration — it would pass on the mutant too.
  const { db, dir } = tmpDb();
  try {
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false };
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, live);
    live.wake = true;
    live.delivery = false;
    const liveRead = () => normalizeSwitches(live); // the MUTANT
    const rowRead = () => runFlags(db, 'run-1'); // production
    assert.notDeepEqual(
      rowRead(),
      liveRead(),
      'if these agreed, T118.2 would pass on the mutant and prove nothing',
    );
    assert.deepEqual(rowRead(), { delivery: true, wake: false, askGate: false, liveness: false });
    assert.deepEqual(liveRead(), { delivery: false, wake: true, askGate: false, liveness: false });
  } finally {
    cleanup(db, dir);
  }
});

test('startRun is idempotent and NEVER re-freezes an existing run', () => {
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);
    // A resume path calls startRun again with the CURRENT (flipped) switches.
    const second = startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, ALL_OFF);
    // The returned row must carry the ORIGINAL flags, not the offered ones —
    // that is why startRun reads the row back instead of returning its input.
    assert.deepEqual(second.flags, ALL_ON);
    assert.deepEqual(runFlags(db, 'run-1'), ALL_ON);
    assert.equal(listRuns(db).length, 1, 'a second startRun must not duplicate the run');
  } finally {
    cleanup(db, dir);
  }
});

test('freezeSwitches returns a COPY — a later mutation of the caller cannot reach the run', () => {
  const live: BusSwitches = { ...ALL_ON };
  const frozen = freezeSwitches(live);
  live.delivery = false;
  assert.equal(frozen.delivery, true);
});

test('the freeze holds through the REAL write+read path, not just freezeSwitches()', () => {
  // WHY THIS EXISTS, and it is not redundant with the test above. A mutation run
  // while building this suite REMOVED the copy from freezeSwitches (`const frozen
  // = liveSwitches`) and EVERY test stayed green: serializeSwitches() snapshots
  // to JSON on the very next line, so the aliasing never reached the DB. That is
  // a surviving mutant — the unit test proved a property of a helper, not of the
  // path the feature runs on.
  //
  // This arm drives startRun with a live object and MUTATES IT AFTERWARDS, then
  // reads the run back out of SQLite. It is the assertion that would have caught
  // a freeze bypassed anywhere between the caller and the row.
  const { db, dir } = tmpDb();
  try {
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false };
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, live);
    live.delivery = false;
    live.wake = true;
    const fromRow = runFlags(db, 'run-1');
    assert.equal(fromRow.delivery, true, 'the caller mutating its object must not reach the row');
    assert.equal(fromRow.wake, false);
    // Positive control in the SAME test (carry-forward 4): the object really WAS
    // mutated, so a green above is not "the mutation never happened".
    assert.equal(live.delivery, false);
    assert.equal(live.wake, true);
  } finally {
    cleanup(db, dir);
  }
});

test('D1 — with the bus unavailable every mechanism freezes OFF', () => {
  // LEAD reconciliation (ledger #123 §Briefing): a mechanism whose authority the
  // bus carries reads as OFF for the run when the bus is down.
  const frozen = freezeSwitches(ALL_ON, /* busAvailable */ false);
  assert.deepEqual(frozen, ALL_OFF);
  // Positive control in the same test: with the bus AVAILABLE the same input
  // freezes ON. Without this arm, an implementation that always returns all-OFF
  // would pass the assertion above (carry-forward 4).
  assert.deepEqual(freezeSwitches(ALL_ON, true), ALL_ON);
});

test('an unknown run reads as all-OFF, never as the live switches', () => {
  const { db, dir } = tmpDb();
  try {
    assert.deepEqual(runFlags(db, 'never-started'), ALL_OFF);
  } finally {
    cleanup(db, dir);
  }
});

test('a corrupt / NULL flags column reads as all-OFF, not as "use live"', () => {
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);
    db.prepare('UPDATE run_flags SET flags=? WHERE run_id=?').run('{not json', 'run-1');
    assert.deepEqual(runFlags(db, 'run-1'), ALL_OFF);
    assert.deepEqual(parseSwitches(null), ALL_OFF);
  } finally {
    cleanup(db, dir);
  }
});

test('mechanismEnabled reads the frozen set', () => {
  assert.equal(mechanismEnabled(ALL_ON, 'wake'), true);
  assert.equal(mechanismEnabled(ALL_OFF, 'wake'), false);
});

// ─── Switch normalization ───────────────────────────────────────────────────

test('normalizeSwitches accepts only literal true — a "true" STRING is OFF', () => {
  // A switch that turns itself on from a hand-edited store typo is exactly what
  // the freeze exists to prevent, so the coercion is === true, not truthiness.
  const s = normalizeSwitches({ delivery: 'true', wake: 1, askGate: true, liveness: {} });
  assert.deepEqual(s, { delivery: false, wake: false, askGate: true, liveness: false });
});

test('normalizeSwitches defaults each mechanism independently', () => {
  // A store written by a build that knew fewer mechanisms must keep the ones it
  // DID set, rather than falling back to the default set wholesale.
  const s = normalizeSwitches({ delivery: true });
  assert.equal(s.delivery, true);
  assert.equal(s.wake, false);
  assert.equal(Object.keys(s).length, BUS_MECHANISMS.length);
});

test('serialize → parse round-trips every mechanism', () => {
  const mixed: BusSwitches = { delivery: true, wake: false, askGate: true, liveness: false };
  assert.deepEqual(parseSwitches(serializeSwitches(mixed)), mixed);
});

// ─── The startup notice (T118.3) ────────────────────────────────────────────

test('T118.3 — the notice names EVERY mechanism in BOTH states', () => {
  const on = busSwitchNoticeLines(ALL_ON);
  const off = busSwitchNoticeLines(ALL_OFF);
  assert.equal(on.length, BUS_MECHANISMS.length);
  assert.equal(off.length, BUS_MECHANISMS.length);
  for (const m of BUS_MECHANISMS) {
    // POSITIVE control: switch ON → the ON string appears.
    assert.ok(
      on.some((l) => l.includes(`bus switch ${m}=ON`)),
      `switch ${m} ON must print an ON line`,
    );
    // NEGATIVE control: switch OFF → the OPPOSITE string appears — not merely
    // the absence of the ON one (carry-forward 2). This is the assertion that
    // fails on a notice which prints ON lines and stays silent otherwise.
    assert.ok(
      off.some((l) => l.includes(`bus switch ${m}=OFF`)),
      `switch ${m} OFF must print its OWN line, not silence`,
    );
    assert.ok(
      !off.some((l) => l.includes(`bus switch ${m}=ON`)),
      `switch ${m} OFF must not print an ON line`,
    );
  }
});

test('T118.3 — the OFF line names the old channel as authoritative (counted, not fired)', () => {
  // The coexistence ruling has to be READABLE by the fleet skill, not implied.
  const off = busSwitchNoticeLines(ALL_OFF).join('\n');
  assert.match(off, /OLD channel stays authoritative/);
  assert.match(off, /COUNTS this mechanism, it does not fire it/);
  const on = busSwitchNoticeLines(ALL_ON).join('\n');
  assert.match(on, /AUTHORITATIVE for this mechanism/);
});

test('T118.3 — an all-OFF set still PRINTS a notice (silence is unreadable)', () => {
  const notice = busSwitchNotice(ALL_OFF);
  assert.ok(notice, 'all-OFF must still produce a notice');
  assert.match(notice, /frozen at wave start/);
  for (const m of BUS_MECHANISMS) assert.ok(notice.includes(`${m}=OFF`));
});

test('busSwitchNotice returns null only when there are no switches at all', () => {
  assert.equal(busSwitchNotice(null), null);
  assert.ok(busSwitchNotice(ALL_OFF));
});

// ─── The run tree the pane renders ──────────────────────────────────────────

test('listRuns returns nested runs with their own frozen flags', () => {
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'mission', kind: 'mission', coordinator: 'lead' }, ALL_ON);
    startRun(
      db,
      { id: 'wave-b', kind: 'vague', coordinator: 'ops-b', parentRunId: 'mission' },
      ALL_OFF,
    );
    const runs = listRuns(db);
    assert.equal(runs.length, 2);
    const wave = runs.find((r) => r.id === 'wave-b');
    assert.equal(wave?.parent_run_id, 'mission');
    // The nested run's flags are its OWN, not inherited from the mission.
    assert.deepEqual(wave?.flags, ALL_OFF);
    assert.deepEqual(runs.find((r) => r.id === 'mission')?.flags, ALL_ON);
  } finally {
    cleanup(db, dir);
  }
});

test('the wave-A core verbs still work alongside run rows (no schema collision)', () => {
  // ensureRunFlagsSchema() runs additive DDL on the same DB the core uses. This
  // is the positive control that it did not disturb messages/deliveries — the
  // failure mode of a badly-scoped migration.
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);
    const seq = send(db, { runId: 'run-1', sender: 'a', kind: 'status', body: 'hello' });
    assert.equal(seq, 1);
    const lot = check(db, 'run-1', 'b');
    assert.equal(lot.messages.length, 1);
    assert.equal(lot.messages[0].body, 'hello');
  } finally {
    cleanup(db, dir);
  }
});

// ─── busSwitch() — the signature frozen with #117 on ledger #123 ────────────

test('busSwitch(runId, wire) reads the FROZEN row, both directions', () => {
  const { db, dir } = tmpDb();
  try {
    const live: BusSwitches = { delivery: true, wake: false, askGate: true, liveness: false };
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, live);
    // Mid-wave flip: every value inverted.
    live.delivery = false;
    live.wake = true;
    live.askGate = false;
    live.liveness = true;
    // The contract function still reports the FROZEN values, not the live ones.
    assert.equal(busSwitch(db, 'run-1', 'delivery'), true);
    assert.equal(busSwitch(db, 'run-1', 'wake'), false);
    assert.equal(busSwitch(db, 'run-1', 'ask_gate'), true);
    assert.equal(busSwitch(db, 'run-1', 'liveness'), false);
  } finally {
    cleanup(db, dir);
  }
});

test('busSwitch returns FALSE for an unknown run and an unknown mechanism', () => {
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'run-1', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);
    // Unknown run → false, never the live switches.
    assert.equal(busSwitch(db, 'no-such-run', 'delivery'), false);
    // Unknown mechanism name → false, never a guess or a throw. A typo'd
    // mechanism firing would be worse than one that stays off.
    assert.equal(busSwitch(db, 'run-1', 'askGate'), false, 'the WIRE name is ask_gate');
    assert.equal(busSwitch(db, 'run-1', 'nonsense'), false);
    // Positive control in the same test: a known name on a known run IS true,
    // so the falses above are not "this function always returns false".
    assert.equal(busSwitch(db, 'run-1', 'ask_gate'), true);
  } finally {
    cleanup(db, dir);
  }
});

test('the wire names map to the internal keys, both ways', () => {
  assert.equal(mechanismFromWire('ask_gate'), 'askGate');
  assert.equal(mechanismToWire('askGate'), 'ask_gate');
  assert.equal(mechanismFromWire('unknown'), null);
  // Every mechanism has a wire name and round-trips — an enumeration, not a
  // spot check, so adding a mechanism without a wire name fails here.
  for (const m of BUS_MECHANISMS) {
    assert.equal(mechanismFromWire(mechanismToWire(m)), m);
  }
});
