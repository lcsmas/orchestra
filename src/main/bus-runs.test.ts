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
import {
  openBus,
  open as openRaw,
  migrate,
  schemaVersion,
  SCHEMA_VERSION,
  MIGRATIONS,
  send,
  check,
  type BusDb,
} from './bus.ts';
import {
  startRun,
  getRun,
  runFlags,
  busSwitch,
  listRuns,
  refreezeRun,
  refreezeMissionRun,
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

// #128/#129/#130 — derive from the mechanism list so a new BusMechanism is
// all-ON here too, rather than a hand-written literal that a sibling ticket's
// mechanism would silently omit.
const ALL_ON: BusSwitches = Object.fromEntries(
  BUS_MECHANISMS.map((m) => [m, true]),
) as BusSwitches;
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
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false };
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
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false };
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
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false };
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
    assert.deepEqual(rowRead(), { delivery: true, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false });
    assert.deepEqual(liveRead(), { delivery: false, wake: true, askGate: false, liveness: false, fencing: false, capability: false, receipts: false });
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

test('F1 — a pre-existing runs row with NO run_flags is NOT freezable late', () => {
  // Reviewer 7c372e9a on ledger #123. The blocking shape: a `runs` row that
  // exists but has no `run_flags` row (a run created by a writer that predates
  // run_flags — #115's CLI lifecycle, an older build, a partially-applied v2, a
  // failed second insert). With two independent `INSERT OR IGNORE`s, startRun
  // took the `runs` ignore but WROTE run_flags at the later call — freezing the
  // running run at the then-current LIVE switches and flipping busSwitch ON under
  // a run that was live before the switch was touched. This is T118.2's literal
  // disproof: "the running run's flags change."
  const { db, dir } = tmpDb();
  try {
    // Simulate the writer that predates run_flags: a bare `runs` row, no flags.
    db.prepare(
      `INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('run-x', 'vague', 'ops-b', null, null, Date.now());
    // Pre-state: no run_flags row, so the run reads all-OFF.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM run_flags WHERE run_id=?').get('run-x') &&
        (db.prepare('SELECT COUNT(*) AS n FROM run_flags WHERE run_id=?').get('run-x') as { n: number }).n,
      0,
    );
    assert.deepEqual(runFlags(db, 'run-x'), ALL_OFF, 'a run with no flags row reads all-OFF');
    assert.equal(busSwitch(db, 'run-x', 'wake'), false);

    // The human flips ALL ON mid-wave; a resume path calls startRun('run-x', ALL_ON).
    startRun(db, { id: 'run-x', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);

    // THE ASSERTION: the running run's flags must NOT have become ON. An existing
    // runs row means "already started" — no run_flags is written, so it stays
    // all-OFF, not freezable late. On the two-OR-IGNORE code this reads ALL_ON.
    assert.deepEqual(
      runFlags(db, 'run-x'),
      ALL_OFF,
      'F1: an existing run with no flags must not be freezable late at live switches',
    );
    assert.equal(busSwitch(db, 'run-x', 'wake'), false, 'busSwitch must not flip ON mid-wave');
    assert.equal(listRuns(db).length, 1, 'no new run was created — this IS the running run');
    // No run_flags row was written for the pre-existing run.
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM run_flags WHERE run_id=?').get('run-x') as { n: number }).n,
      0,
      'no run_flags row is written for a run that already existed',
    );
  } finally {
    cleanup(db, dir);
  }
});

test('F1 control — a genuinely NEW run (no prior runs row) DOES freeze its flags', () => {
  // The must-PASS counterpart, same command family as the F1 arm above: proves
  // the fix did not simply stop freezing altogether. A brand-new run — one whose
  // `runs` row this startRun creates — freezes at the live switches it is handed.
  const { db, dir } = tmpDb();
  try {
    startRun(db, { id: 'fresh-run', kind: 'vague', coordinator: 'ops-b' }, ALL_ON);
    assert.deepEqual(runFlags(db, 'fresh-run'), ALL_ON, 'a NEW run must freeze its live switches');
    assert.equal(busSwitch(db, 'fresh-run', 'wake'), true);
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
    const live: BusSwitches = { delivery: true, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false };
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
  assert.deepEqual(s, { delivery: false, wake: false, askGate: true, liveness: false, fencing: false, capability: false, receipts: false });
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
  const mixed: BusSwitches = { delivery: true, wake: false, askGate: true, liveness: false, fencing: true, capability: true, receipts: true };
  assert.deepEqual(parseSwitches(serializeSwitches(mixed)), mixed);
});

// ─── The startup notice (T118.3) ────────────────────────────────────────────

test('T118.3 — the notice names EVERY mechanism in BOTH states', () => {
  const on = busSwitchNoticeLines(ALL_ON);
  const off = busSwitchNoticeLines(ALL_OFF);
  assert.equal(on.length, BUS_MECHANISMS.length);
  assert.equal(off.length, BUS_MECHANISMS.length);
  for (const m of BUS_MECHANISMS) {
    // The notice emits the WIRE name (F4, ledger #123): `ask_gate`, not the
    // internal `askGate`. Assert the wire spelling the fleet skill greps for.
    const wire = mechanismToWire(m);
    // POSITIVE control: switch ON → the ON string appears.
    assert.ok(
      on.some((l) => l.includes(`bus switch ${wire}=ON`)),
      `switch ${wire} ON must print an ON line`,
    );
    // NEGATIVE control: switch OFF → the OPPOSITE string appears — not merely
    // the absence of the ON one (carry-forward 2). This is the assertion that
    // fails on a notice which prints ON lines and stays silent otherwise.
    assert.ok(
      off.some((l) => l.includes(`bus switch ${wire}=OFF`)),
      `switch ${wire} OFF must print its OWN line, not silence`,
    );
    assert.ok(
      !off.some((l) => l.includes(`bus switch ${wire}=ON`)),
      `switch ${wire} OFF must not print an ON line`,
    );
  }
});

test('T118.3 (F4) — the notice emits the WIRE name ask_gate, never the internal askGate', () => {
  const on = busSwitchNoticeLines(ALL_ON).join('\n');
  const off = busSwitchNoticeLines(ALL_OFF).join('\n');
  // The internal camel key must never leak onto the wire the fleet skill reads.
  assert.ok(!on.includes('askGate'), 'ON notice leaked the internal key askGate');
  assert.ok(!off.includes('askGate'), 'OFF notice leaked the internal key askGate');
  // And the wire name IS present — the must-PASS half so this is not vacuously
  // satisfied by a notice that dropped the ask_gate line entirely.
  assert.match(on, /bus switch ask_gate=ON/);
  assert.match(off, /bus switch ask_gate=OFF/);
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
  for (const m of BUS_MECHANISMS) assert.ok(notice.includes(`${mechanismToWire(m)}=OFF`));
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
  // MIGRATIONS[2] adds run_flags to the same DB the core verbs use. This is the
  // positive control that it did not disturb messages/deliveries — the failure
  // mode of a badly-scoped migration.
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
    const live: BusSwitches = { delivery: true, wake: false, askGate: true, liveness: false, fencing: false, capability: false, receipts: false };
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

// ─── C11 — the migration chain applies from EVERY intermediate version ──────
//
// OPS-B's gate, added mid-wave: "a candidate tested only against a fresh DB has
// not tested its migration at all". Four wave-B tickets each append a migration,
// so the real population is DBs stamped at every version below ours, not just
// fresh files.
//
// The loop iterates 1..SCHEMA_VERSION-1 as a RANGE (as #116 built theirs), so
// when my slot is renumbered at rebase this test needs NO edit — the renumber
// stays one integer in two places, which is the whole point of the ruling.

test('C11 — run_flags survives migrate() from EVERY intermediate schema version', () => {
  for (let from = 1; from < SCHEMA_VERSION; from++) {
    const dir = mkdtempSync(path.join(tmpdir(), `bus-c11-v${from}-`));
    const file = path.join(dir, 'bus.sqlite');
    try {
      // Stamp a DB at `from` by running the chain only that far, exactly as a
      // real older Orchestra would have left it.
      const seed = openRaw(file);
      const current = schemaVersion(seed);
      assert.equal(current, 0, 'a fresh file must start at user_version 0');
      // migrate() always goes to SCHEMA_VERSION, so replay the prefix by hand:
      // apply migrations 1..from and stamp, which is what an older build did.
      seed.exec('BEGIN IMMEDIATE');
      for (let v = 1; v <= from; v++) {
        // Reach into the same MIGRATIONS the shipped code uses — a hand-written
        // copy of the SQL here would test the copy.
        const sql = MIGRATIONS[v];
        assert.ok(sql, `no migration body for v${v}`);
        seed.exec(sql);
      }
      seed.pragma(`user_version = ${from}`);
      seed.exec('COMMIT');
      assert.equal(schemaVersion(seed), from, `DB must be stamped at v${from}`);
      seed.close();

      // Now upgrade with the SHIPPED migrate(), and require my table to exist
      // AND BE QUERYABLE — a table that exists with the wrong shape is the
      // silent-no-op failure the CREATE TABLE IF NOT EXISTS workaround had.
      const db = openBus(file);
      assert.equal(schemaVersion(db), SCHEMA_VERSION, `must reach v${SCHEMA_VERSION} from v${from}`);
      startRun(db, { id: `from-v${from}`, kind: 'vague', coordinator: 'c11' }, ALL_ON);
      assert.deepEqual(runFlags(db, `from-v${from}`), ALL_ON, `flags must round-trip from v${from}`);
      // Queryable with the columns the code expects, not merely present.
      const row = db
        .prepare('SELECT run_id, flags, frozen_at FROM run_flags WHERE run_id=?')
        .get(`from-v${from}`) as { run_id: string; flags: string; frozen_at: number };
      assert.equal(row.run_id, `from-v${from}`);
      assert.equal(typeof row.frozen_at, 'number');
      assert.deepEqual(JSON.parse(row.flags), ALL_ON);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('C11 — the fresh-file arm, and the loop above actually RAN', () => {
  // Carry-forward 4: if SCHEMA_VERSION were ever 1, the loop above would iterate
  // ZERO times and report a tidy green having tested nothing. Assert the range
  // is non-empty, and cover the fresh path explicitly.
  assert.ok(SCHEMA_VERSION >= 2, `SCHEMA_VERSION is ${SCHEMA_VERSION} — the C11 loop would be vacuous`);
  const { db, dir } = tmpDb();
  try {
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    startRun(db, { id: 'fresh', kind: 'vague', coordinator: 'c11' }, ALL_ON);
    assert.deepEqual(runFlags(db, 'fresh'), ALL_ON);
  } finally {
    cleanup(db, dir);
  }
});

test('C11 — a DB stamped ABOVE SCHEMA_VERSION is REFUSED, not silently run', () => {
  // The other end of the chain: a file written by a NEWER Orchestra must not be
  // run against this build's expectations.
  const dir = mkdtempSync(path.join(tmpdir(), 'bus-c11-future-'));
  try {
    const file = path.join(dir, 'bus.sqlite');
    const db = openBus(file);
    db.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
    assert.throws(() => migrate(db), /newer than this build supports/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── #130 — the `receipts` mechanism reads off the frozen run row ─────────────

test('busSwitch(db, runId, "receipts") reads the FROZEN receipts flag, not live (T130.3 production gate)', () => {
  // COVERS: the production path the CLI's runMutation takes — busSwitch on the
  // NEW `receipts` mechanism, off the run row. The rig in bus-verbs.test.ts
  // stubs busSwitch; this asserts the REAL reader against a real frozen row.
  // MUTANT: drop `receipts` from BUS_MECHANISMS/WIRE_TO_MECHANISM → mechanismFromWire
  //   returns null → busSwitch returns false even when frozen ON → the ON arm RED.
  const { db, dir } = tmpDb();
  try {
    // A run frozen with receipts ON, everything else OFF.
    startRun(
      db,
      { id: 'run-r', kind: 'vague', coordinator: 'ops' },
      { delivery: false, wake: false, askGate: false, liveness: false, receipts: true },
    );
    assert.equal(busSwitch(db, 'run-r', 'receipts'), true, 'a frozen receipts=ON reads ON');
    assert.equal(busSwitch(db, 'run-r', 'delivery'), false, 'receipts is independent of delivery');

    // A run frozen all-OFF: receipts reads OFF (coexistence-safe), and an
    // unknown run reads OFF too.
    startRun(db, { id: 'run-off', kind: 'vague', coordinator: 'ops' }, { ...DEFAULT_BUS_SWITCHES });
    assert.equal(busSwitch(db, 'run-off', 'receipts'), false, 'frozen OFF reads OFF');
    assert.equal(busSwitch(db, 'never', 'receipts'), false, 'an unknown run reads OFF, never live');
  } finally {
    cleanup(db, dir);
  }
});

// ═══ #156 — ADMIN re-freeze of a FLAT mission (refreezeMissionRun) ════════════
//
// A FLAT orchestrator (plain children only, never a promoted sub-OPS) never hits
// bus-run-anchor.ts D1b's wave-boundary re-freeze, so its mission keeps the flags
// frozen at its first anchor forever. `refreezeMissionRun` is the explicit,
// gated operator path. Every arm drives the SHIPPED pure function against a real
// SQLite bus and carries its must-FAIL twin (a mutation that flips the arm).

// Freeze a MISSION at all-OFF (the live bloc2 case: froze all-OFF, switches later
// flipped ON, can never pick them up without this path).
function seedMissionOff(db: BusDb, id: string): void {
  startRun(db, { id, kind: 'mission', coordinator: id }, { ...DEFAULT_BUS_SWITCHES });
}

test('T156.1 — a FLAT mission frozen OFF, switches now ON, children idle → refreeze flips it ON', () => {
  const { db, dir } = tmpDb();
  try {
    seedMissionOff(db, 'mission-flat');
    // Pre-state: the freeze pinned all-OFF, and NOTHING the app ships can flip it
    // (a flat mission never re-freezes). Assert that starting-point explicitly so
    // the arm proves the transition, not a state that was already true.
    for (const m of BUS_MECHANISMS) assert.equal(runFlags(db, 'mission-flat')[m], false);

    // Human has since flipped delivery + wake ON. All children idle (hasLiveChild
    // false). The refreeze takes the CURRENT live switches.
    const live: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true };
    const outcome = refreezeMissionRun(db, 'mission-flat', live, { hasLiveChild: false });
    assert.equal(outcome, 'refrozen', 'the mission row was re-frozen');
    assert.equal(runFlags(db, 'mission-flat').delivery, true, 'delivery picked up the flip');
    assert.equal(runFlags(db, 'mission-flat').wake, true, 'wake picked up the flip');
    assert.equal(runFlags(db, 'mission-flat').askGate, false, 'an unset switch stays OFF');

    // must-FAIL TWIN: the ONLY shipped pre-#156 path (startRun) CANNOT flip a
    // running mission — it is INSERT-OR-IGNORE, freeze-once. Prove it: a second
    // startRun with the flipped live switches is a no-op, the row stays all-OFF.
    const { db: db2, dir: dir2 } = tmpDb();
    try {
      seedMissionOff(db2, 'mission-flat');
      startRun(db2, { id: 'mission-flat', kind: 'mission', coordinator: 'mission-flat' }, live);
      assert.equal(
        runFlags(db2, 'mission-flat').delivery,
        false,
        'CONTROL: startRun (the only pre-#156 path) leaves the frozen mission all-OFF',
      );
    } finally {
      cleanup(db2, dir2);
    }
  } finally {
    cleanup(db, dir);
  }
});

test('T156.2 — a mission with a live child mid-turn → REFUSED, row untouched', () => {
  const { db, dir } = tmpDb();
  try {
    seedMissionOff(db, 'mission-busy');
    const before = JSON.stringify(runFlags(db, 'mission-busy'));

    const live: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true };
    const outcome = refreezeMissionRun(db, 'mission-busy', live, { hasLiveChild: true });
    assert.equal(outcome, 'live-child', 'refused while a child is mid-turn');
    assert.equal(
      JSON.stringify(runFlags(db, 'mission-busy')),
      before,
      'the mission row is byte-identical — no flip happened',
    );

    // must-FAIL TWIN: with the live-child gate REMOVED (hasLiveChild ignored), the
    // same call would flip the row. Drive that by passing hasLiveChild:false and
    // showing it WOULD change — so a mutant dropping the gate reddens this arm.
    const flippedIfUngated = refreezeMissionRun(db, 'mission-busy', live, { hasLiveChild: false });
    assert.equal(flippedIfUngated, 'refrozen', 'CONTROL: the very same input flips once the gate is off');
    assert.equal(runFlags(db, 'mission-busy').delivery, true, 'proving the gate was the only thing refusing');
  } finally {
    cleanup(db, dir);
  }
});

test('T156.3 — a vague (OPS) run → no-op REFUSED (the refreezeRun mission gate, through refreezeMissionRun)', () => {
  const { db, dir } = tmpDb();
  try {
    // A vague row frozen delivery=ON. Flip live to delivery=OFF/wake=ON.
    startRun(db, { id: 'ops-vague', kind: 'vague', coordinator: 'ops-vague' }, {
      ...DEFAULT_BUS_SWITCHES,
      delivery: true,
    });
    const before = JSON.stringify(runFlags(db, 'ops-vague'));

    const live: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: false, wake: true };
    const outcome = refreezeMissionRun(db, 'ops-vague', live, { hasLiveChild: false });
    assert.equal(outcome, 'not-mission', 'a vague row is refused with a reason');
    assert.equal(
      JSON.stringify(runFlags(db, 'ops-vague')),
      before,
      'the vague row is untouched (delivery still ON, wake still OFF)',
    );

    // The underlying gate is refreezeRun's WHERE (kind = mission): even the raw
    // primitive refuses a vague row. This is the invariant the CLI re-asserts.
    assert.equal(
      refreezeRun(db, 'ops-vague', live),
      false,
      'refreezeRun itself is a NO-OP on a vague row — mission rows only',
    );
    assert.equal(JSON.stringify(runFlags(db, 'ops-vague')), before, 'still untouched after the raw call');

    // An UNKNOWN run → no-run (the CLI prints "nothing to refreeze").
    assert.equal(
      refreezeMissionRun(db, 'no-such-run', live, { hasLiveChild: false }),
      'no-run',
      'an unknown run id resolves to no-run',
    );
  } finally {
    cleanup(db, dir);
  }
});

test('T156.4 — #134 F1 unchanged: refreeze NEVER late-inserts a row; it only UPDATEs an existing mission', () => {
  const { db, dir } = tmpDb();
  try {
    const live: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true };

    // (a) No run row at all → refreeze creates NOTHING (no `runs`, no `run_flags`).
    assert.equal(refreezeMissionRun(db, 'ghost', live, { hasLiveChild: false }), 'no-run');
    assert.equal(getRun(db, 'ghost'), null, 'the run row was NOT late-created');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM run_flags WHERE run_id=?').get('ghost') as { n: number }).n,
      0,
      'and NO run_flags row was inserted',
    );

    // (b) A mission `runs` row that predates run_flags (an old build / a partial
    // insert) — refreeze must NOT insert its run_flags row late (that IS the #134
    // F1 mid-wave-freeze the invariant forbids). Simulate it by inserting a bare
    // runs row with no matching run_flags row.
    db.prepare(
      "INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)",
    ).run('mission-bare', 'mission', 'mission-bare', null, null, Date.now());
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM run_flags WHERE run_id=?').get('mission-bare') as { n: number }).n,
      0,
      'precondition: the mission has NO run_flags row',
    );

    const outcome = refreezeMissionRun(db, 'mission-bare', live, { hasLiveChild: false });
    assert.equal(outcome, 'no-flags', 'a mission with no run_flags row is a no-op, not a late insert');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM run_flags WHERE run_id=?').get('mission-bare') as { n: number }).n,
      0,
      '#134 F1: NO run_flags row was inserted — the run reads all-OFF, never late-frozen',
    );
    assert.equal(runFlags(db, 'mission-bare').delivery, false, 'and it reads all-OFF (coexistence-safe)');
  } finally {
    cleanup(db, dir);
  }
});
