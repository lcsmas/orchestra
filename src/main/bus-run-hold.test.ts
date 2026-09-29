import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, openBus, MIGRATIONS, SCHEMA_VERSION, schemaVersion, type BusDb } from './bus.ts';
import { startRun, getRun, runFlags, setRunHold, heldRunIds } from './bus-runs.ts';
import { DEFAULT_BUS_SWITCHES, serializeSwitches } from '../shared/bus-switches.ts';
import * as busRuns from './bus-runs.ts';

// The per-run HOLD flag (#204 remainder, LEAD ruling D4 ii): the durable state
// behind `orchestra run hold|resume`. Real SQLite, real migrations; each arm names
// the mutant it kills. UNKNOWN ⇒ NOT HELD is the coexistence-safe direction.

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-runhold-test-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function seed(db: BusDb, id: string, coordinator = `ops-${id}`): void {
  startRun(db, { id, kind: 'vague', coordinator }, DEFAULT_BUS_SWITCHES);
}
/** The caller a run's own coordinator presents (D7 authorizes exactly this). */
const op = (id: string): string => `ops-${id}`;

test('a freshly started run is NOT held (the zero control)', (t) => {
  // Without this every "held" assertion below could pass on a build that reports
  // every run held. MUTANT: default the column to a held value → this goes RED.
  const db = tmpDb(t);
  seed(db, 'run-a');
  assert.deepEqual([...heldRunIds(db)], []);
});

test('an UNKNOWN run is not held, and hold on it is refused as no-run (never a silent no-op)', (t) => {
  // MUTANT: setRunHold INSERTs a row for an unknown id, or returns 'held' → RED.
  const db = tmpDb(t);
  assert.equal(setRunHold(db, 'no-such-run', true, 'anyone'), 'no-run');
  assert.equal(setRunHold(db, 'no-such-run', false, 'anyone'), 'no-run');
  assert.deepEqual([...heldRunIds(db)], []);
  assert.equal(getRun(db, 'no-such-run'), null, 'a refused hold must not create a run row');
});

test('hold → held; hold again → already-held; resume → resumed; resume again → not-held', (t) => {
  // MUTANT: resume does not clear (held_at stays set) → the 3rd assertion goes RED;
  //   hold non-idempotent (re-stamps) is caught by the timestamp equality below.
  const db = tmpDb(t);
  seed(db, 'run-a');
  assert.equal(setRunHold(db, 'run-a', true, op('run-a')), 'held');
  assert.deepEqual([...heldRunIds(db)], ['run-a']);
  const stamp = (db.prepare('SELECT held_at FROM runs WHERE id=?').get('run-a') as { held_at: number }).held_at;
  assert.equal(typeof stamp, 'number');
  assert.equal(setRunHold(db, 'run-a', true, op('run-a')), 'already-held');
  assert.equal(
    (db.prepare('SELECT held_at FROM runs WHERE id=?').get('run-a') as { held_at: number }).held_at,
    stamp,
    'a second hold must not re-stamp the original hold time',
  );
  assert.equal(setRunHold(db, 'run-a', false, op('run-a')), 'resumed');
  assert.deepEqual([...heldRunIds(db)], []);
  assert.equal(setRunHold(db, 'run-a', false, op('run-a')), 'not-held');
});

test('the hold is PER RUN — holding run-a leaves run-b not held', (t) => {
  // MUTANT: UPDATE without the `WHERE id = ?` (holds every run) → RED.
  const db = tmpDb(t);
  seed(db, 'run-a');
  seed(db, 'run-b');
  setRunHold(db, 'run-a', true, op('run-a'));
  assert.deepEqual([...heldRunIds(db)], ['run-a']);
});

test('hold/resume never touches the FROZEN switch flags (the freeze invariant)', (t) => {
  // The hold lives on the runs row next to the frozen flags; it must not re-freeze
  // or blank them. MUTANT: implement hold via INSERT OR REPLACE on the run → RED.
  const db = tmpDb(t);
  const on = { ...DEFAULT_BUS_SWITCHES, liveness: true, wake: true };
  startRun(db, { id: 'run-a', kind: 'vague', coordinator: 'ops-a' }, on);
  const before = JSON.stringify(runFlags(db, 'run-a'));
  const rowBefore = getRun(db, 'run-a')!;
  setRunHold(db, 'run-a', true, op('run-a'));
  setRunHold(db, 'run-a', false, op('run-a'));
  assert.equal(JSON.stringify(runFlags(db, 'run-a')), before);
  const rowAfter = getRun(db, 'run-a')!;
  assert.equal(rowAfter.created_at, rowBefore.created_at);
  assert.equal(rowAfter.coordinator_generation, rowBefore.coordinator_generation);
});

test('MIGRATIONS[8] adds runs.held_at and a v7 DB with a live run upgrades to "not held"', (t) => {
  // The population that exists in the field: DBs stamped at v7 WITH run rows. The
  // migration must add the column without disturbing them, and the old rows must
  // read NOT held (NULL). MUTANT: NOT NULL DEFAULT 1 / drop the migration → RED.
  assert.ok(SCHEMA_VERSION >= 8, `SCHEMA_VERSION ${SCHEMA_VERSION} — hold needs slot 8`);
  assert.match(MIGRATIONS[8] ?? '', /ALTER TABLE runs ADD COLUMN held_at/);
  assert.match(MIGRATIONS[8] ?? '', /ALTER TABLE runs ADD COLUMN held_by/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-runhold-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus.sqlite');
  const seedDb = open(file);
  seedDb.exec('BEGIN IMMEDIATE');
  for (let v = 1; v <= 7; v++) seedDb.exec(MIGRATIONS[v]!);
  seedDb.pragma('user_version = 7');
  seedDb.exec('COMMIT');
  seedDb
    .prepare(`INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)`)
    .run('old-run', 'vague', 'ops-old', null, null, 1);
  assert.equal(schemaVersion(seedDb), 7);
  seedDb.close();

  const db = openBus(file);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.deepEqual([...heldRunIds(db)], [], 'a pre-existing run reads NOT held after the upgrade');
  assert.equal(setRunHold(db, 'old-run', true, 'ops-old'), 'held');
  assert.deepEqual([...heldRunIds(db)], ['old-run']);
});

const tmp2 = tmpDb;

// ── review-A4 dispositions (ledger #224) ─────────────────────────────────────
// `busRuns.*` (namespace) so a build without the new exports fails ARM BY ARM.

test('#204 F3: hold records WHO (held_by) and WHEN; resume clears both; a second (ancestor) hold keeps the first holder', (t) => {
  // MUTANT: never write held_by / re-stamp the holder on a repeat hold / resume leaves held_by → RED.
  const db = tmp2(t);
  tree(db);
  assert.equal(busRuns.getRunHold(db, 'run-ops'), null, 'not held → null');
  assert.equal(setRunHold(db, 'run-ops', true, 'ws-ops'), 'held');
  const first = busRuns.getRunHold(db, 'run-ops')!;
  assert.equal(first.heldBy, 'ws-ops');
  assert.equal(typeof first.heldAt, 'number');
  assert.equal(setRunHold(db, 'run-ops', true, 'ws-lead'), 'already-held');
  assert.equal(busRuns.getRunHold(db, 'run-ops')!.heldBy, 'ws-ops', 'the ORIGINAL holder is kept');
  assert.equal(setRunHold(db, 'run-ops', false, 'ws-lead'), 'resumed');
  assert.equal(busRuns.getRunHold(db, 'run-ops'), null);
  assert.equal(
    (db.prepare('SELECT held_by AS b FROM runs WHERE id=?').get('run-ops') as { b: string | null }).b,
    null,
    'resume clears held_by too',
  );
  assert.equal(busRuns.getRunHold(db, 'no-such-run'), null, 'unknown run → null');
});

test('#204 F3: runStatusView is the /busStatus wire shape — runExists + heldAt + heldBy', (t) => {
  // MUTANT: drop heldBy / report held for a not-held run / unknown run reads runExists true → RED.
  const db = tmp2(t);
  seed(db, 'run-a');
  assert.deepEqual(busRuns.runStatusView(db, 'run-a'), { runExists: true, heldAt: null, heldBy: null });
  setRunHold(db, 'run-a', true, op('run-a'));
  const v = busRuns.runStatusView(db, 'run-a');
  assert.equal(v.runExists, true);
  assert.equal(v.heldBy, op('run-a'));
  assert.equal(typeof v.heldAt, 'number');
  assert.deepEqual(busRuns.runStatusView(db, 'ghost'), { runExists: false, heldAt: null, heldBy: null });
});

test('#204 F4: resume is scoped to ITS run — resume(a) leaves b held', (t) => {
  // review-A4 F4 (survivor). MUTANT: resume UPDATE without `WHERE id = ?` (clears every run) → RED.
  const db = tmp2(t);
  seed(db, 'run-a');
  seed(db, 'run-b');
  setRunHold(db, 'run-a', true, op('run-a'));
  setRunHold(db, 'run-b', true, op('run-b'));
  assert.equal(setRunHold(db, 'run-a', false, op('run-a')), 'resumed');
  assert.deepEqual([...heldRunIds(db)], ['run-b']);
  assert.equal(busRuns.getRunHold(db, 'run-b')!.heldBy, op('run-b'), "run-b's holder is untouched");
});

// ── LEAD ruling D7 + review-A4 F7 (ledger #224) ──────────────────────────────
// Who may hold/resume run X: X's coordinator, or the coordinator of an ANCESTOR run.

const ON = { ...DEFAULT_BUS_SWITCHES, liveness: true, fencing: true };
/** run-lead(ws-lead) ⊃ run-ops(ws-ops) ⊃ run-deep(ws-deep); sibling run-opsb(ws-ops-b). */
function tree(db: BusDb): void {
  startRun(db, { id: 'run-lead', kind: 'mission', coordinator: 'ws-lead' }, ON);
  startRun(db, { id: 'run-ops', kind: 'vague', coordinator: 'ws-ops', parentRunId: 'run-lead' }, ON);
  startRun(db, { id: 'run-opsb', kind: 'vague', coordinator: 'ws-ops-b', parentRunId: 'run-lead' }, ON);
  startRun(db, { id: 'run-deep', kind: 'vague', coordinator: 'ws-deep', parentRunId: 'run-ops' }, ON);
}

test('#204 D7 (MUST-FAIL before the fix): the coordinator of X and of every ANCESTOR run may hold/resume X', (t) => {
  // MUTANT: drop the ancestor walk (own coordinator only) → the ws-ops/ws-lead arms are RED.
  const db = tmp2(t);
  tree(db);
  assert.equal(setRunHold(db, 'run-deep', true, 'ws-deep'), 'held', 'X\'s own coordinator');
  assert.equal(setRunHold(db, 'run-deep', false, 'ws-ops'), 'resumed', 'the PARENT run\'s coordinator');
  assert.equal(setRunHold(db, 'run-deep', true, 'ws-lead'), 'held', 'the GRANDPARENT run\'s coordinator (the LEAD)');
  assert.equal(busRuns.getRunHold(db, 'run-deep')!.heldBy, 'ws-lead', 'held_by is the authorized actor');
});

test('#204 D7 (MUST-FAIL before the fix): every other caller is REFUSED and the state is untouched', (t) => {
  // Unrelated member, a SIBLING OPS, a DESCENDANT run's coordinator, no identity, empty identity.
  // MUTANT: skip the check / allow descendants / allow a null actor → the matching arm is RED.
  const db = tmp2(t);
  tree(db);
  for (const actor of ['ws-w', 'ws-ops-b', 'ws-deep', null, '', '  ']) {
    assert.equal(setRunHold(db, 'run-ops', true, actor), 'refused', `hold by ${JSON.stringify(actor)}`);
  }
  assert.deepEqual([...heldRunIds(db)], [], 'no refused caller changed anything');
  // resume is guarded the same way: a held run stays held, holder unchanged.
  assert.equal(setRunHold(db, 'run-ops', true, 'ws-ops'), 'held');
  for (const actor of ['ws-w', 'ws-ops-b', 'ws-deep', null]) {
    assert.equal(setRunHold(db, 'run-ops', false, actor), 'refused', `resume by ${JSON.stringify(actor)}`);
  }
  assert.deepEqual([...heldRunIds(db)], ['run-ops']);
  assert.equal(busRuns.getRunHold(db, 'run-ops')!.heldBy, 'ws-ops');
});

test('#204 D7: identity is compared case-folded + trimmed, and an unknown run is no-run BEFORE authorization', (t) => {
  // MUTANT: exact-case compare → the UPPERCASE arm is RED; authorize before the row check → 'refused' not 'no-run'.
  const db = tmp2(t);
  tree(db);
  assert.equal(setRunHold(db, 'run-ops', true, '  WS-OPS '), 'held');
  assert.equal(setRunHold(db, 'ghost-run', true, 'ws-w'), 'no-run');
  assert.equal(setRunHold(db, 'ghost-run', false, null), 'no-run');
});

test('#204 D7: runHoldAuthority names who may act — coordinator first, then ancestors nearest-first; cycle-safe', (t) => {
  // The CLI message is built from this. MUTANT: return only the own coordinator / farthest-first → RED.
  const db = tmp2(t);
  tree(db);
  assert.deepEqual(busRuns.runHoldAuthority(db, 'run-deep'), {
    coordinator: 'ws-deep',
    ancestors: ['ws-ops', 'ws-lead'],
    chain: [
      { runId: 'run-deep', coordinator: 'ws-deep' },
      { runId: 'run-ops', coordinator: 'ws-ops' },
      { runId: 'run-lead', coordinator: 'ws-lead' },
    ],
  });
  assert.deepEqual(busRuns.runHoldAuthority(db, 'run-lead'), {
    coordinator: 'ws-lead',
    ancestors: [],
    chain: [{ runId: 'run-lead', coordinator: 'ws-lead' }],
  });
  assert.equal(busRuns.runHoldAuthority(db, 'ghost-run'), null);
  // A malformed parent cycle must terminate (bounded by a seen-set), not hang the CLI.
  db.exec("UPDATE runs SET parent_run_id='run-deep' WHERE id='run-lead'");
  const cyc = busRuns.runHoldAuthority(db, 'run-deep')!;
  assert.ok(cyc.ancestors.length <= 3, `bounded: ${JSON.stringify(cyc)}`);
});

// ── verifier H1 (ledger #224): pin the /busStatus hold view ──────────────────

test('#204 H1: the /busStatus run view carries the hold — heldAt/heldBy shaping, and hooks-server actually uses it', (t) => {
  // The route lives in Electron-bound hooks-server.ts, so the shaping is one pure function it calls.
  // MUTANT: drop the hold from the view / report a not-held run as held / hooks-server stops calling it → RED.
  const db = tmp2(t);
  tree(db);
  const LIVE = '{"delivery":true}';
  const frozen = (id: string): string => JSON.stringify(JSON.parse(serializeSwitches(runFlags(db, id))));
  const notHeld = busRuns.busStatusRunView(db, 'run-ops', LIVE);
  assert.deepEqual(notHeld, {
    displayRunId: 'run-ops',
    runExists: true,
    heldAt: null,
    heldBy: null,
    frozenFlags: serializeSwitches(runFlags(db, 'run-ops')),
    liveFlags: LIVE,
  });
  assert.equal(setRunHold(db, 'run-ops', true, 'ws-lead'), 'held');
  const held = busRuns.busStatusRunView(db, 'run-ops', LIVE) as Record<string, unknown>;
  assert.equal(typeof held.heldAt, 'number');
  assert.equal(held.heldBy, 'ws-lead');
  assert.equal(held.runExists, true);
  assert.equal(JSON.stringify(JSON.parse(String(held.frozenFlags))), frozen('run-ops'), 'the frozen flags are unaffected by the hold');
  // An unknown run: no row, not held, frozen reads all-OFF (#206) — never a phantom hold.
  const ghost = busRuns.busStatusRunView(db, 'ghost', LIVE) as Record<string, unknown>;
  assert.equal(ghost.runExists, false);
  assert.equal(ghost.heldAt, null);
  assert.equal(ghost.heldBy, null);
  // A null bus (D1): only the id + live flags, and NO hold/exists keys (older-app shape).
  assert.deepEqual(busRuns.busStatusRunView(null, 'run-ops', LIVE), {
    displayRunId: 'run-ops',
    frozenFlags: null,
    liveFlags: LIVE,
  });
  // Structural wiring guard: the Electron route must build its reply through this function.
  const route = fs.readFileSync(new URL('./hooks-server.ts', import.meta.url), 'utf8');
  assert.match(route, /busStatusRunView\(/, 'hooks-server /busStatus calls busStatusRunView');
});
