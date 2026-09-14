// #128 — fencing over a REAL SQLite bus (ledger #131, T128.1/T128.3/T128.4).
//
// These drive a genuine database on a temp file — the bug class is semantic
// (which writes land, and when the generation gate fires), so an in-memory
// stand-in would just re-encode the answer I already believed. Runs under system
// node (ABI 127) via build/bus-abi/ like every other bus test; see bus.test.ts's
// header for why the CONSTRUCTOR is the ABI gate.
//
// Each arm names the clause it covers and the mutation it would catch, so a green
// here is a measurement, not decoration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  ack,
  assertCoordinatorGeneration,
  bumpCoordinatorGeneration,
  check,
  coordinatorGeneration,
  fenceEventCounts,
  fenceEvents,
  fencedWrite,
  getGate,
  openBus,
  openGate,
  resolveGate,
  schemaVersion,
  send,
  StaleGenerationError,
  type BusDb,
} from './bus.ts';
import { startRun } from './bus-runs.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const RUN = 'run-fence';

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-fence-'));
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

const FENCING_ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, fencing: true };
const FENCING_OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };

// ─── T128.4 — the migration at the correct INDEX + SCHEMA_VERSION bump ────────

test('T128.4 — MIGRATIONS[5]: a from-4 DB migrates and coordinator_generation is present', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-fence-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus.sqlite');

  // Build a DB genuinely STAMPED at v4 (not a fresh file that runs everything at
  // once — that would hide a broken v4→v5 step). Open to HEAD, rewind the stamp,
  // and remove exactly what MIGRATIONS[5] added, so re-running migrate() from 4
  // really exercises the ADD COLUMN.
  const seed = openBus(file);
  seed.exec('DROP INDEX IF EXISTS idx_fence_events_run');
  seed.exec('DROP TABLE IF EXISTS fence_events');
  seed.exec('ALTER TABLE runs DROP COLUMN coordinator_generation');
  seed.pragma('user_version = 4');
  // CONTROL, same command (carry-forward 4): the column is genuinely ABSENT at v4.
  const colsAt4 = (seed.pragma('table_info(runs)') as { name: string }[]).map((c) => c.name);
  assert.equal(
    colsAt4.includes('coordinator_generation'),
    false,
    'pre-state: the column must be absent at v4, or the arm proves nothing',
  );
  seed.close();

  // Reopen: openBus() runs migrate() from the stamped v4.
  const db = openBus(file);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), SCHEMA_VERSION, 'migrate() reaches HEAD');
  // #128's fencing migration is MIGRATIONS[5]; SCHEMA_VERSION is >= 5 (bumped past
  // 5 as later wave-D tickets append — #129 capability took 6). Assert the FLOOR,
  // not an absolute, so a sibling ticket's bump does not redden #128's own test
  // (updated at #129's rebase onto #128 per the merge-order renumber rule).
  assert.ok(SCHEMA_VERSION >= 5, 'SCHEMA_VERSION bumped to at least 5 for fencing');
  const cols = (db.pragma('table_info(runs)') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('coordinator_generation'), 'the generation column is present after migrate');
  const fenceTbl = (
    db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='fence_events'")
      .get() as { n: number }
  ).n;
  assert.equal(fenceTbl, 1, 'fence_events table is present after migrate');
});

test('a run reads generation 0 until bumped; bump is monotone and reads back', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  assert.equal(coordinatorGeneration(db, RUN), 0, 'a new run starts at generation 0');
  assert.equal(bumpCoordinatorGeneration(db, RUN), 1, 'bump returns the new generation');
  assert.equal(coordinatorGeneration(db, RUN), 1, 'the bump reads back');
  assert.equal(bumpCoordinatorGeneration(db, RUN), 2, 'monotone');
  assert.equal(coordinatorGeneration(db, RUN), 2);
  // An unknown run reads 0, never throws (D1 shape).
  assert.equal(coordinatorGeneration(db, 'no-such-run'), 0);
});

test('bumpCoordinatorGeneration refuses a run with no runs row', (t) => {
  const db = tmpBus(t);
  assert.throws(
    () => bumpCoordinatorGeneration(db, 'unstarted'),
    /has no runs row/,
    'cannot fence a run nobody started — a silent no-op would let stale writes land',
  );
});

// ─── the typed primitive ──────────────────────────────────────────────────────

test('assertCoordinatorGeneration throws a TYPED StaleGenerationError on a stale write', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  bumpCoordinatorGeneration(db, RUN); // now at 1
  // At/above current: no throw.
  assert.doesNotThrow(() => assertCoordinatorGeneration(db, RUN, 1));
  assert.doesNotThrow(() => assertCoordinatorGeneration(db, RUN, 2));
  // No generation presented: never fenced (the unfenced v1 path).
  assert.doesNotThrow(() => assertCoordinatorGeneration(db, RUN, null));
  assert.doesNotThrow(() => assertCoordinatorGeneration(db, RUN, undefined));
  // Stale: TYPED throw. The type is the contract (T128.1) — a caller catches
  // fencing specifically, not by string-matching the message.
  let caught: unknown;
  try {
    assertCoordinatorGeneration(db, RUN, 0);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof StaleGenerationError, 'the throw is the typed error, not a bare Error');
  assert.equal((caught as StaleGenerationError).name, 'StaleGenerationError');
  assert.equal((caught as StaleGenerationError).presented, 0);
  assert.equal((caught as StaleGenerationError).current, 1);
});

// ─── T128.1 — the must-FAIL arm through the real WRITE path ───────────────────

test('T128.1 — a stale-generation SEND is REFUSED (switch ON) and writes NO row', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  // OPS at generation G=0 could write; a respawn bumps to G+1=1.
  bumpCoordinatorGeneration(db, RUN);

  const before = (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }
  ).n;

  // The stale coordinator (still presenting G=0) tries to send. fencedWrite is
  // what the CLI verb calls BEFORE bus.send — it must throw, so the send never
  // runs. Disproof: if it did not throw, the row count below would rise and the
  // superseded coordinator would keep writing (the split #128 prevents).
  assert.throws(
    () => {
      fencedWrite(db, { runId: RUN, verb: 'send', presented: 0, fencingOn: true, actor: 'ops-old' });
      send(db, { runId: RUN, sender: 'ops-old', kind: 'dispatch', body: 'stale write' });
    },
    (e: unknown) => e instanceof StaleGenerationError,
    'a stale send must throw the typed error before the write',
  );

  const after = (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }
  ).n;
  assert.equal(after, before, 'the messages row count is UNCHANGED — the send never ran');

  // The CURRENT coordinator (presenting G=1) writes fine — the must-PASS control.
  fencedWrite(db, { runId: RUN, verb: 'send', presented: 1, fencingOn: true, actor: 'ops-new' });
  const seq = send(db, { runId: RUN, sender: 'ops-new', kind: 'dispatch', body: 'live write' });
  assert.ok(seq > 0, 'the live coordinator writes normally');
});

test('T128.1 — a stale-generation ACK is REFUSED (switch ON), leaving the lot unchanged', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  send(db, { runId: RUN, sender: 'peer', kind: 'dispatch', body: 'm1' });
  const lot = check(db, RUN, 'reader-1');
  assert.ok(lot.delivery, 'a lot was taken');
  bumpCoordinatorGeneration(db, RUN); // reader/actor superseded at G0, now G1

  assert.throws(
    () =>
      fencedWrite(db, { runId: RUN, verb: 'ack', presented: 0, fencingOn: true, actor: 'reader-1' }),
    (e: unknown) => e instanceof StaleGenerationError,
  );
  // The ack never ran, so the lot is still outstanding (acked_at IS NULL).
  const still = (
    db
      .prepare('SELECT acked_at FROM deliveries WHERE id=?')
      .get(lot.delivery!.id) as { acked_at: number | null }
  ).acked_at;
  assert.equal(still, null, 'row unchanged: the lot stays outstanding after a refused ack');
  // Control: the live generation acks fine.
  fencedWrite(db, { runId: RUN, verb: 'ack', presented: 1, fencingOn: true, actor: 'reader-1' });
  assert.equal(ack(db, RUN, 'reader-1', lot.delivery!.id), true);
});

test('T128.1 — a stale-generation GATE-RESOLVE is REFUSED (switch ON), resolution unchanged', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  const gateId = openGate(db, RUN, 'ops', 'ruling?', 'lead');
  bumpCoordinatorGeneration(db, RUN);

  assert.throws(
    () =>
      fencedWrite(db, {
        runId: RUN,
        verb: 'gate-resolve',
        presented: 0,
        fencingOn: true,
        actor: 'ops-old',
      }),
    (e: unknown) => e instanceof StaleGenerationError,
  );
  assert.equal(getGate(db, gateId)?.resolved_at, null, 'the gate stays OPEN after a refused resolve');
  // Control: the live coordinator resolves it.
  fencedWrite(db, {
    runId: RUN,
    verb: 'gate-resolve',
    presented: 1,
    fencingOn: true,
    actor: 'ops-new',
  });
  assert.equal(resolveGate(db, gateId, 'ops-new', 'the ruling'), true);
  assert.ok(getGate(db, gateId)?.resolved_at, 'the gate is resolved by the live coordinator');
});

// ─── T128.3 — COUNTED-not-FIRED while the switch is OFF ───────────────────────

test('T128.3 — with fencing OFF a stale write is COUNTED, not rejected; the row lands', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_OFF);
  bumpCoordinatorGeneration(db, RUN); // current = 1

  const before = (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }
  ).n;

  // The stale coordinator (G=0) writes with the switch OFF. fencedWrite must NOT
  // throw — the old channel is authoritative — but must RECORD the would-have-
  // fenced event so the switch-off state is observable. Disproof: a build that
  // rejects while OFF breaks coexistence; a build that records nothing makes the
  // OFF state indistinguishable from having no fencing at all.
  assert.doesNotThrow(() =>
    fencedWrite(db, { runId: RUN, verb: 'send', presented: 0, fencingOn: false, actor: 'ops-old' }),
  );
  const seq = send(db, { runId: RUN, sender: 'ops-old', kind: 'dispatch', body: 'shadow-counted' });
  assert.ok(seq > 0, 'the write STILL lands — old channel authoritative');
  const after = (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }
  ).n;
  assert.equal(after, before + 1, 'the stale write proceeded (COUNTED, not FIRED)');

  // The shadow trail recorded exactly one COUNTED (fired=0) event.
  const counts = fenceEventCounts(db, RUN);
  assert.equal(counts.counted, 1, 'one would-have-fenced event was COUNTED');
  assert.equal(counts.fired, 0, 'nothing FIRED while the switch is OFF');
  const evs = fenceEvents(db, RUN);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].fired, 0, 'the recorded event is counted, not fired');
  assert.equal(evs[0].presented, 0);
  assert.equal(evs[0].current, 1);
  assert.equal(evs[0].verb, 'send');
});

test('T128.3 control — with fencing ON a stale write records a FIRED event (fired=1)', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  bumpCoordinatorGeneration(db, RUN);
  assert.throws(() =>
    fencedWrite(db, { runId: RUN, verb: 'send', presented: 0, fencingOn: true, actor: 'ops-old' }),
  );
  const counts = fenceEventCounts(db, RUN);
  assert.equal(counts.fired, 1, 'the rejection recorded a FIRED event');
  assert.equal(counts.counted, 0);
});

test('a NON-stale write records NO fence event in either switch state', (t) => {
  const db = tmpBus(t);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  bumpCoordinatorGeneration(db, RUN); // current = 1
  // Live generation, switch ON: passes, records nothing.
  fencedWrite(db, { runId: RUN, verb: 'send', presented: 1, fencingOn: true, actor: 'ops' });
  // No generation presented (unfenced path), switch OFF: passes, records nothing.
  fencedWrite(db, { runId: RUN, verb: 'send', presented: null, fencingOn: false, actor: 'ops' });
  assert.equal(fenceEvents(db, RUN).length, 0, 'a non-stale/unfenced write is not a fence event');
});
