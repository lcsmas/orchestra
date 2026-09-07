import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SCHEMA_VERSION,
  ack,
  busPath,
  check,
  getGate,
  migrate,
  open,
  openBus,
  openGate,
  openGates,
  resolveGate,
  schemaVersion,
  send,
  type BusDb,
} from './bus.ts';

// These drive a REAL SQLite database on a real temp file — no mock, no fake.
// The bug class here is semantic (which rows a reader is handed, and when the
// cursor moves), and an in-memory stand-in for SQLite would just re-encode
// whichever answer I already believed.
//
// WHICH RUNTIME THIS RUNS UNDER, AND WHY IT MATTERS. `pnpm run test` is system
// node (ABI 127); the binding the AppImage SHIPS is Electron's (ABI 130). They
// are mutually unusable. bus-binding.ts loads the ABI-127 build from
// build/bus-abi/ so these tests construct a genuine database — see
// scripts/build-bus-abi.mjs, which gates both ABIs by CONSTRUCTION and asserts
// the require()-succeeds-under-the-wrong-ABI trap that makes that necessary.
//
// EACH TEST BELOW NAMES THE PRODUCTION CLAUSE IT COVERS. G3 of ledger #122
// mutates those clauses and requires the named test to go RED; a test that
// survives its own mutant is decoration, so the mutant is written down.

const RUN = 'run-A';

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-test-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed by the test */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function seed(db: BusDb, bodies: string[], runId = RUN): number[] {
  return bodies.map((body) => send(db, { runId, sender: 'ops', kind: 'dispatch', body }));
}

// ─── open() / schema ────────────────────────────────────────────────────────

test('open() sets WAL and busy_timeout on EVERY connection, read-only included', (t) => {
  // COVERS: the `db.pragma('busy_timeout = …')` line in open(), which sits
  // OUTSIDE the `if (!opts.readonly)` block on purpose.
  // MUTANT: move that pragma inside the `if (!opts.readonly)` block, or drop it.
  // WHY IT MATTERS: spike #109 condition 1 — without busy_timeout, 10 concurrent
  // writers lose 7–27% of inserts with no error any caller would notice. A
  // read-only connection that omits it is exactly the call site that would be
  // "obviously fine" to skip.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-pragma-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus.sqlite');

  const rw = openBus(file);
  assert.equal(rw.pragma('journal_mode', { simple: true }), 'wal');
  rw.close();

  // WHY THIS TEST IS SHAPED LIKE THIS — a vacuity trap I walked into and had to
  // dig out. My first version asserted `busy_timeout === 5000` on a read-only
  // connection. It passed. It ALSO passed with the pragma deleted from open(),
  // because better-sqlite3's own constructor defaults `timeout: 5000` and
  // applies it — so the assertion pinned a state that was ALREADY TRUE and could
  // never fail. Measured, not reasoned:
  //   new Database(f, { readonly: true })  →  busy_timeout = 5000
  //
  // So 5000 is not a discriminating value. A NON-DEFAULT one is: the assertion
  // below can only hold if open() actually issued the pragma, on a connection
  // whose `readonly` flag would tempt a "writers only" refactor to skip it.
  const ro = open(file, { readonly: true, busyTimeoutMs: 1234 });
  assert.equal(
    ro.pragma('busy_timeout', { simple: true }),
    1234,
    'a READ-ONLY connection must also get busy_timeout from open() — spike #109 condition 1',
  );
  ro.close();

  // The must-FAIL control's own precondition: 0 must be settable and must read
  // back as 0. If the option were silently ignored, the contention rig's
  // negative arm would quietly become a second copy of the positive one and
  // could never fail. (scripts/verify-bus-contention.mjs depends on this.)
  const zero = open(file, { busyTimeoutMs: 0 });
  assert.equal(zero.pragma('busy_timeout', { simple: true }), 0, 'busyTimeoutMs: 0 must be honored');
  zero.close();

  // And the default really is the 5000 the spike measured against.
  const dflt = open(file);
  assert.equal(dflt.pragma('busy_timeout', { simple: true }), 5000);
  dflt.close();
});

test('migrate() is idempotent, records its version, and refuses a newer schema', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus.sqlite');

  const fresh = open(file);
  assert.equal(schemaVersion(fresh), 0, 'a fresh DB starts at version 0');
  assert.equal(migrate(fresh), SCHEMA_VERSION);
  // Idempotent: a second migrate on an already-current DB is a no-op, which is
  // what makes it safe to call from N processes at boot.
  assert.equal(migrate(fresh), SCHEMA_VERSION);

  // Every table #114 names must actually exist — an empty migration string would
  // still leave user_version set, so the version alone proves nothing.
  const tables = new Set(
    (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  for (const t of ['runs', 'messages', 'deliveries', 'cursors', 'decision_gates']) {
    assert.ok(tables.has(t), `migration must create the ${t} table (got ${[...tables].join(',')})`);
  }

  // A DOWNGRADE must be refused, not silently run. Simulate the file having been
  // written by a future Orchestra.
  fresh.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  assert.throws(() => migrate(fresh), /newer than this build supports/);
  fresh.close();
});

test('busPath() follows ORCHESTRA_HOME', (t) => {
  // The bus is one DB per ORCHESTRA_HOME (#108 ruling Q3). A dev instance must
  // never write into the real home's bus — the same isolation every other
  // subsystem here gets.
  const prev = process.env.ORCHESTRA_HOME;
  t.after(() => {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
  });
  process.env.ORCHESTRA_HOME = '/tmp/some-isolated-home';
  assert.equal(busPath(), '/tmp/some-isolated-home/bus.sqlite');
  delete process.env.ORCHESTRA_HOME;
  assert.equal(busPath(), path.join(os.homedir(), '.orchestra', 'bus.sqlite'));
});

// ─── #114 acceptance 2, clause 1: TOTAL ORDER ───────────────────────────────

test('messages.sequence is a strictly increasing total order, and ids are never reused', (t) => {
  // COVERS: `sequence INTEGER PRIMARY KEY AUTOINCREMENT` in the migration.
  // MUTANT: drop the AUTOINCREMENT keyword.
  // WHY IT MATTERS: a bare INTEGER PRIMARY KEY is a rowid alias, and SQLite
  // REUSES the largest deleted rowid. A reused sequence silently reorders the
  // bus — a later message would sort before an earlier one, and every cursor
  // comparison downstream would be wrong. The deletion half below is what makes
  // this test able to see the mutant at all: without a delete, both variants
  // produce 1,2,3 and the assertion is vacuous.
  const db = tmpBus(t);

  const first = seed(db, ['a', 'b', 'c']);
  assert.deepEqual(first, [1, 2, 3], 'sequences start at 1 and increase by 1');

  // Interleave a second run: the order is TOTAL across the whole bus, not
  // per-run, which is what makes it usable as a global clock.
  const other = send(db, { runId: 'run-B', sender: 'lead', kind: 'status', body: 'x' });
  const fourth = send(db, { runId: RUN, sender: 'ops', kind: 'status', body: 'd' });
  assert.equal(other, 4);
  assert.equal(fourth, 5, 'sequence is global, not per-run');

  // THE DISCRIMINATING HALF. Delete the newest rows, then insert again.
  // With AUTOINCREMENT: the next sequence is 6. Without it: SQLite reuses 5.
  db.exec('DELETE FROM messages WHERE sequence >= 4');
  const afterDelete = send(db, { runId: RUN, sender: 'ops', kind: 'status', body: 'e' });
  assert.equal(
    afterDelete,
    6,
    'a sequence must NEVER be reused after a delete — that is what AUTOINCREMENT buys',
  );
  assert.ok(afterDelete > fourth, 'the new sequence must be above every sequence ever issued');

  // And the rows come back in sequence order for a reader of this run.
  const seqs = (
    db.prepare('SELECT sequence FROM messages WHERE run_id=? ORDER BY sequence').all(RUN) as {
      sequence: number;
    }[]
  ).map((r) => r.sequence);
  assert.deepEqual(seqs, [1, 2, 3, 6]);
});

test('send() refuses an unknown kind at the WRITE boundary', (t) => {
  // COVERS: the MESSAGE_KINDS guard in send().
  // MUTANT: delete the `if (!MESSAGE_KINDS.includes(...)) throw` block.
  // WHY THE WRITE BOUNDARY: a row with an unknown kind is invisible to every
  // reader that switches on the eight known kinds, and no downstream check could
  // distinguish it from a legitimate row. Validate where it enters, not where it
  // is consumed.
  const db = tmpBus(t);
  assert.throws(
    () => send(db, { runId: RUN, sender: 'a', kind: 'made_up' as never, body: 'x' }),
    /unknown message kind/,
  );
  // The positive control: this test would also "pass" if send() threw on
  // EVERYTHING, so prove a legitimate kind still lands.
  assert.equal(send(db, { runId: RUN, sender: 'a', kind: 'heartbeat', body: 'x' }), 1);
  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c,
    1,
    'exactly the legitimate row landed — the refused one wrote nothing',
  );
});

test('send() refuses a whitespace-only runId or sender, not just an empty one', (t) => {
  // COVERS: the `.trim()` in send()'s runId/sender guards.
  // MUTANT: drop `?.trim()` back to a bare falsy check.
  // WHY: '' was already refused but '   ' was accepted, so a whitespace handle
  // became a DISTINCT reader — cursors and deliveries key on the raw string, so
  // messages addressed to '  ops  ' are invisible to every relève by 'ops' and
  // nothing anywhere reports a problem. Reported by the adversarial review (F6).
  const db = tmpBus(t);
  for (const bad of ['', '   ', '\t', '\n']) {
    assert.throws(
      () => send(db, { runId: bad, sender: 'ops', kind: 'status', body: 'x' }),
      /runId is required/,
      `runId ${JSON.stringify(bad)} must be refused`,
    );
    assert.throws(
      () => send(db, { runId: RUN, sender: bad, kind: 'status', body: 'x' }),
      /sender is required/,
      `sender ${JSON.stringify(bad)} must be refused`,
    );
  }
  // Positive control: a legitimate handle with INTERNAL spaces is still fine —
  // the guard must reject blank, not reject spaces.
  assert.equal(send(db, { runId: RUN, sender: 'ops wave a', kind: 'status', body: 'x' }), 1);
});

test('every migration SQL string parses — no stray backtick terminates it early', (t) => {
  // WHY THIS EXISTS, twice over. The migration lives in a template literal, and
  // I twice wrote prose in a SQL comment containing backticks (`sequence`,
  // `messages.run_id`). Each time the backtick CLOSED the literal and the whole
  // file stopped parsing — caught only because the suite refused to load at all.
  // That is luck, not a gate: the same mistake inside a rarely-run branch would
  // ship. This asserts the shipped SQL is intact and executable.
  const db = tmpBus(t);
  // If a literal had been cut short, these tables would simply not exist.
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const t of ['cursors', 'decision_gates', 'deliveries', 'messages', 'runs']) {
    assert.ok(tables.includes(t), `${t} missing — a migration string was truncated`);
  }
  // And the indexes, which live at the END of the migration: a backtick anywhere
  // above would drop them while still leaving the earlier tables present.
  const indexes = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const i of ['idx_messages_run', 'idx_messages_thread', 'idx_deliveries_outstanding', 'idx_gates_open']) {
    assert.ok(indexes.includes(i), `${i} missing — the migration was cut short before its indexes`);
  }
});

// ─── clause 2: ONE OUTSTANDING LOT PER READER ───────────────────────────────

test('a second check before ack returns the SAME lot, byte-identical, folding in NOTHING', (t) => {
  // COVERS: the `if (out) return { …, replay: true, messages: rowsInRange(...) }`
  //   branch of check(), which reads the FROZEN from_seq/to_seq of the
  //   outstanding delivery row.
  // MUTANT A: delete the `if (out)` early-return so check() always takes a new lot.
  // MUTANT B: keep the branch but widen the replay to `rowsAfter(from_seq)` —
  //   i.e. fold in messages that arrived since. This is the subtle one, and it is
  //   why the test inserts DURING the outstanding window.
  // WHY IT MATTERS: a reader that crashed mid-lot must get back exactly what it
  // was handed. Redelivery is only safe if it is identical (spike #109 arm 2).
  const db = tmpBus(t);
  seed(db, ['m1', 'm2', 'm3']);

  const first = check(db, RUN, 'worker-1');
  assert.equal(first.replay, false, 'the first check is a fresh take, not a replay');
  assert.deepEqual(
    first.messages.map((m) => m.sequence),
    [1, 2, 3],
  );

  // Messages arrive while the lot is outstanding. MUTANT B folds these in.
  seed(db, ['m4', 'm5']);

  const second = check(db, RUN, 'worker-1');
  assert.equal(second.replay, true, 'a second check before ack must be flagged as a replay');
  assert.equal(second.delivery?.id, first.delivery?.id, 'it must be the SAME delivery row');
  assert.deepEqual(
    second.messages.map((m) => m.sequence),
    [1, 2, 3],
    'the replayed lot must NOT fold in messages that arrived while it was outstanding',
  );
  // Byte-identical, not merely same-ids: the whole row content is what a reader
  // would act on.
  assert.deepEqual(second.messages, first.messages, 'the replayed lot must be byte-identical');

  // And the invariant that makes it true: exactly ONE outstanding row exists.
  const outstanding = (
    db
      .prepare('SELECT COUNT(*) c FROM deliveries WHERE run_id=? AND reader=? AND acked_at IS NULL')
      .get(RUN, 'worker-1') as { c: number }
  ).c;
  assert.equal(outstanding, 1, 'exactly one lot may be outstanding per (run, reader)');
});

test('the unique partial index — not application logic — is what refuses a second outstanding lot', (t) => {
  // COVERS: `CREATE UNIQUE INDEX … idx_deliveries_outstanding … WHERE acked_at IS NULL`.
  // MUTANT: drop the WHERE clause (making it a plain unique index), or drop the
  //   index entirely.
  // WHY A SEPARATE TEST: the test above passes on check()'s early return alone,
  // so it does NOT prove the index is load-bearing. Spike #109 arm 2b probed the
  // index directly for exactly this reason; this is that probe, in production.
  const db = tmpBus(t);
  seed(db, ['m1']);
  check(db, RUN, 'worker-1');

  const insertRaw = db.prepare(
    'INSERT INTO deliveries (run_id, reader, from_seq, to_seq, taken_at) VALUES (?,?,?,?,?)',
  );

  // must-FAIL arm: a second OUTSTANDING lot for the same (run, reader).
  assert.throws(
    () => insertRaw.run(RUN, 'worker-1', 0, 1, Date.now()),
    /UNIQUE constraint failed|SQLITE_CONSTRAINT/,
    'the index must refuse a second outstanding lot for the same reader',
  );

  // Two positive controls, because an index that refused EVERYTHING would also
  // have produced the throw above. These are what make the refusal meaningful.
  assert.doesNotThrow(
    () => insertRaw.run(RUN, 'worker-2', 0, 1, Date.now()),
    'a DIFFERENT reader must still be allowed an outstanding lot',
  );
  db.prepare('UPDATE deliveries SET acked_at=? WHERE run_id=? AND reader=?').run(
    Date.now(),
    RUN,
    'worker-1',
  );
  assert.doesNotThrow(
    () => insertRaw.run(RUN, 'worker-1', 1, 1, Date.now()),
    'after the ack, the same reader must be allowed a new lot (the partial WHERE)',
  );
});

// ─── clause 3: ACK THEN CHECK RETURNS ONLY NEWER ROWS ───────────────────────

test('ack then check returns ONLY rows newer than the acked lot', (t) => {
  // COVERS: the `bump.run(runId, reader, row.to_seq)` cursor advance in ack(),
  //   and check()'s use of `cursors.acked_seq` as the exclusive lower bound.
  // MUTANT A: remove the bump — check() then replays acked messages forever.
  // MUTANT B: advance the cursor in check() at TAKE time instead (the naive
  //   design spike #109's must-FAIL control used) — a crash between take and ack
  //   then loses the lot permanently.
  const db = tmpBus(t);
  seed(db, ['m1', 'm2', 'm3']);

  const lot1 = check(db, RUN, 'worker-1');
  assert.deepEqual(lot1.messages.map((m) => m.sequence), [1, 2, 3]);

  assert.equal(ack(db, RUN, 'worker-1', lot1.delivery!.id), true);

  // Nothing new yet: an empty lot, NOT a replay of the acked one.
  const empty = check(db, RUN, 'worker-1');
  assert.deepEqual(empty.messages, [], 'acked messages must never come back');
  assert.equal(empty.delivery, null, 'an empty relève opens no delivery row');
  assert.equal(empty.replay, false);

  seed(db, ['m4', 'm5']);
  const lot2 = check(db, RUN, 'worker-1');
  assert.deepEqual(
    lot2.messages.map((m) => m.sequence),
    [4, 5],
    'only rows above the acked cursor',
  );
  assert.equal(lot2.replay, false);

  // A second reader is independent: it has its own cursor and still sees all 5.
  const otherReader = check(db, RUN, 'worker-2');
  assert.deepEqual(
    otherReader.messages.map((m) => m.sequence),
    [1, 2, 3, 4, 5],
    "one reader's ack must not advance another reader's cursor",
  );
});

test('ack is the READER-s: it refuses a lot belonging to someone else, and never rewinds', (t) => {
  // COVERS: the `AND run_id=? AND reader=?` predicate in ack()'s UPDATE, and the
  //   `MAX(acked_seq, excluded.acked_seq)` in the cursor upsert.
  // MUTANT A: drop `AND reader=?` — any agent could then ack on a reader's
  //   behalf, which is precisely the lying "Delivered" the bus exists to kill
  //   (#108 round-4 hardening 1).
  // (The `MAX(...)` in the cursor upsert is NOT covered here — it is unreachable
  //  through the public API. See the dedicated test below, which proves why and
  //  says so out loud rather than claiming coverage it does not have.)
  const db = tmpBus(t);
  seed(db, ['m1', 'm2']);
  const mine = check(db, RUN, 'worker-1');

  // Another agent must not be able to ack my lot.
  assert.equal(
    ack(db, RUN, 'worker-2', mine.delivery!.id),
    false,
    'only the lot-s own reader may ack it',
  );
  assert.equal(
    check(db, RUN, 'worker-1').replay,
    true,
    'the lot must still be outstanding after a foreign ack attempt',
  );

  // The real reader can.
  assert.equal(ack(db, RUN, 'worker-1', mine.delivery!.id), true);
  // Acking twice is a no-op, not a second cursor move.
  assert.equal(ack(db, RUN, 'worker-1', mine.delivery!.id), false, 'a second ack changes nothing');
  assert.equal(ack(db, RUN, 'worker-1', 99999), false, 'an unknown lot id acks nothing');

  // A later lot acked normally still advances the cursor forward.
  seed(db, ['m3', 'm4']);
  const second = check(db, RUN, 'worker-1');
  assert.deepEqual(second.messages.map((m) => m.sequence), [3, 4]);
  assert.equal(ack(db, RUN, 'worker-1', second.delivery!.id), true);
  assert.deepEqual(check(db, RUN, 'worker-1').messages, []);
});

test('the cursor cannot be rewound by a stale ack — and MAX() is belt-and-braces, not the guard', (t) => {
  // HONESTY NOTE, and the reason this test is written the way it is.
  // I first wrote an arm claiming to cover the `MAX(acked_seq, excluded.acked_seq)`
  // in ack()'s cursor upsert, with the mutant `MAX(...)` -> `excluded.acked_seq`.
  // I RAN that mutant: the suite stayed 13/13 GREEN. The arm was decoration.
  //
  // Root cause, verified rather than guessed: MAX() is UNREACHABLE through the
  // public API, for two independent reasons proven below. So rather than assert
  // a false coverage claim, this test pins the two guards that actually make a
  // rewind impossible, and records MAX() as defence-in-depth for a future caller
  // (e.g. #115's CLI) that might reach the upsert by another path.
  const db = tmpBus(t);
  seed(db, ['m1', 'm2', 'm3', 'm4']);

  const older = check(db, RUN, 'worker-1', 2);
  assert.deepEqual(older.messages.map((m) => m.sequence), [1, 2]);
  assert.equal(ack(db, RUN, 'worker-1', older.delivery!.id), true);
  const newer = check(db, RUN, 'worker-1', 2);
  assert.deepEqual(newer.messages.map((m) => m.sequence), [3, 4]);
  assert.equal(ack(db, RUN, 'worker-1', newer.delivery!.id), true);

  // GUARD 1 — ack() is idempotent: re-acking the OLDER lot returns false and
  // never reaches the cursor upsert at all (the `changes === 0` early return).
  assert.equal(
    ack(db, RUN, 'worker-1', older.delivery!.id),
    false,
    'an already-acked lot cannot be acked again, so it never re-enters the upsert',
  );
  assert.deepEqual(
    check(db, RUN, 'worker-1').messages,
    [],
    'the cursor did not rewind — no acked message is ever re-delivered',
  );

  // GUARD 2 — two lots can never be outstanding at once for one reader, so an
  // out-of-order ack of two OPEN lots (the only other route to a rewind) cannot
  // be constructed. That is the unique partial index, tested directly above.
  const outstanding = (
    db
      .prepare('SELECT COUNT(*) c FROM deliveries WHERE run_id=? AND reader=? AND acked_at IS NULL')
      .get(RUN, 'worker-1') as { c: number }
  ).c;
  assert.equal(outstanding, 0);

  // And the cursor sits where the NEWEST acked lot left it, not the last-acked-call's.
  const cursor = (
    db.prepare('SELECT acked_seq FROM cursors WHERE run_id=? AND reader=?').get(RUN, 'worker-1') as {
      acked_seq: number;
    }
  ).acked_seq;
  assert.equal(cursor, 4, 'the cursor is at the newest acked lot');
});

test('a lot is capped by `limit`, and the cursor advances only as far as the lot reached', (t) => {
  // COVERS: the `LIMIT ?` in check()'s rowsAfter and `row.to_seq` (NOT the max
  //   sequence in the table) as the cursor target.
  // MUTANT: bump the cursor to the table's MAX(sequence) instead of to_seq —
  //   messages beyond the lot would be skipped without ever being delivered.
  const db = tmpBus(t);
  seed(db, ['m1', 'm2', 'm3', 'm4', 'm5']);

  const lot = check(db, RUN, 'worker-1', 2);
  assert.deepEqual(lot.messages.map((m) => m.sequence), [1, 2], 'limit caps the lot');
  ack(db, RUN, 'worker-1', lot.delivery!.id);

  assert.deepEqual(
    check(db, RUN, 'worker-1', 2).messages.map((m) => m.sequence),
    [3, 4],
    'the next lot resumes exactly where the acked one ended — nothing skipped',
  );
});

test('a lot never crosses runs', (t) => {
  // COVERS: the `run_id=?` predicate in check()'s row queries.
  // MUTANT: drop it — a reader would then be handed another run-s traffic.
  const db = tmpBus(t);
  seed(db, ['a1'], 'run-A');
  seed(db, ['b1', 'b2'], 'run-B');

  assert.deepEqual(check(db, 'run-A', 'w').messages.map((m) => m.body), ['a1']);
  assert.deepEqual(check(db, 'run-B', 'w').messages.map((m) => m.body), ['b1', 'b2']);
});

// ─── clause 4: GATE LIFECYCLE ───────────────────────────────────────────────

test('a decision gate opens, resolves exactly once, and leaves the first Ruling intact', (t) => {
  // COVERS: the `WHERE id=? AND resolved_at IS NULL` predicate in resolveGate().
  // MUTANT: drop `AND resolved_at IS NULL` — a second resolve would then
  //   overwrite the first, so two agents racing to record the human-s answer
  //   could silently replace a Ruling. resolveGate would also report `true`
  //   twice, which is the observable this test pins.
  const db = tmpBus(t);

  const id = openGate(db, RUN, 'ops', 'ship or hold?');
  const opened = getGate(db, id);
  assert.ok(opened);
  assert.equal(opened.question, 'ship or hold?');
  assert.equal(opened.asked_by, 'ops');
  assert.equal(opened.resolution, null, 'a new gate is unresolved');
  assert.equal(opened.resolved_at, null);
  assert.deepEqual(
    openGates(db, RUN).map((g) => g.id),
    [id],
    'an unresolved gate is listed as open',
  );

  assert.equal(resolveGate(db, id, 'lead', 'ship'), true, 'the first resolve wins');

  const resolved = getGate(db, id)!;
  assert.equal(resolved.resolution, 'ship');
  assert.equal(resolved.resolved_by, 'lead');
  assert.ok(typeof resolved.resolved_at === 'number' && resolved.resolved_at > 0);
  assert.deepEqual(openGates(db, RUN), [], 'a resolved gate is no longer open');

  // THE DISCRIMINATING ASSERTION for the mutant.
  assert.equal(resolveGate(db, id, 'someone-else', 'hold'), false, 'a gate resolves exactly once');
  assert.equal(
    getGate(db, id)!.resolution,
    'ship',
    'the second resolve must not overwrite the first Ruling',
  );
  assert.equal(getGate(db, id)!.resolved_by, 'lead');

  assert.equal(resolveGate(db, 99999, 'lead', 'x'), false, 'an unknown gate id resolves nothing');
  assert.equal(getGate(db, 99999), null);

  // Gates are scoped to their run.
  const otherRun = openGate(db, 'run-B', 'ops', 'other?');
  assert.deepEqual(openGates(db, RUN), []);
  assert.deepEqual(openGates(db, 'run-B').map((g) => g.id), [otherRun]);
});

test('the cursor is NOT advanced at take time — a lot lost before its ack is redelivered in full', (t) => {
  // COVERS: the absence of any cursor write in check(). Spike #109 condition 3
  //   ("do not advance a cursor at take time") and arm 2's must-FAIL control.
  // MUTANT: add a cursor bump inside check() next to the insertDelivery call —
  //   i.e. rebuild the naive consumer the spike measured losing data.
  //
  // WHY A DEDICATED TEST, and why it deletes the delivery row. Every other test
  // here reaches the replay branch first, and replay reads from_seq/to_seq off
  // the delivery row — so a corrupted CURSOR stays invisible behind it. The
  // mutant survived my whole suite for exactly that reason. To see the cursor
  // itself, the outstanding delivery has to be gone: that is the real-world case
  // of a lot whose row was rolled back or pruned while its messages were never
  // acked, and it is precisely when a take-time cursor loses them forever.
  const db = tmpBus(t);
  seed(db, ['m1', 'm2', 'm3']);

  const taken = check(db, RUN, 'worker-1');
  assert.deepEqual(taken.messages.map((m) => m.sequence), [1, 2, 3]);

  // The direct assertion on the invariant: taking a lot writes NO cursor.
  const cursorAfterTake = db
    .prepare('SELECT acked_seq FROM cursors WHERE run_id=? AND reader=?')
    .get(RUN, 'worker-1') as { acked_seq: number } | undefined;
  assert.equal(
    cursorAfterTake,
    undefined,
    'check() must not write a cursor row — the ack is what advances it',
  );

  // Now lose the delivery row without an ack, and confirm nothing was skipped.
  db.prepare('DELETE FROM deliveries WHERE id=?').run(taken.delivery!.id);
  const after = check(db, RUN, 'worker-1');
  assert.deepEqual(
    after.messages.map((m) => m.sequence),
    [1, 2, 3],
    'an unacked lot must be redelivered IN FULL — a take-time cursor would lose it',
  );
  assert.equal(after.replay, false, 'the old delivery row is gone, so this is a fresh take');

  // Positive control: the ack path still works, so this test is not merely
  // asserting "check() always returns everything".
  assert.equal(ack(db, RUN, 'worker-1', after.delivery!.id), true);
  assert.deepEqual(check(db, RUN, 'worker-1').messages, [], 'and after the ack, nothing repeats');
});

test('N concurrent PROCESSES checking as the same reader still open exactly ONE lot', async (t) => {
  // WHAT THIS TEST IS, STATED HONESTLY. It closes an open item on spike #109's
  // NOT VERIFIED list — "Multi-consumer concurrency: two consumers of the same
  // run checking simultaneously ... no concurrent-consumer race was run" — by
  // running 8 real processes released on a barrier. Result: all 8 succeed, ONE
  // delivery row, one shared lot id, zero errors.
  //
  // IT IS NOT A MUTATION-GATED TEST, AND I CHECKED RATHER THAN ASSUMED. It stays
  // GREEN with the unique partial index dropped, and green again with the index
  // dropped AND check()'s transaction weakened from immediate() to deferred().
  // The reason is structural: check() does its read-then-insert inside ONE
  // transaction, and SQLite allows only one writer at a time, so the double-take
  // this test looks for cannot be constructed from the public API no matter
  // which guard is removed. The index's load-bearing role is proven by the
  // dedicated raw-insert test above, which DOES go red when its WHERE clause is
  // dropped; that is the mutation gate for this invariant, not this test.
  //
  // Kept anyway, because it answers a different question from every other test
  // here — "does this survive real cross-process contention" — and because a
  // future change to check()'s transaction shape would show up here first.
  //
  // The control that makes the count meaningful is the second arm: with DISTINCT
  // readers the same rig produces N rows. Without it, "1 row" would be equally
  // consistent with a rig that cannot count past one — and my first version of
  // this test used spawnSync, which ran the children SEQUENTIALLY and measured
  // no concurrency at all under a name that claimed it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-concurrent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus.sqlite');
  const seeded = openBus(file);
  seed(seeded, Array.from({ length: 50 }, (_, i) => `m${i}`));
  seeded.close();

  const kid = path.join(dir, 'kid.ts');
  const busModule = JSON.stringify(path.resolve(import.meta.dirname, 'bus.ts'));
  fs.writeFileSync(
    kid,
    `import { openBus, check } from ${busModule};\n` +
      `import fs from 'node:fs';\n` +
      `const barrier = process.argv[3];\n` +
      `while (!fs.existsSync(barrier)) {}\n` +
      `const db = openBus(${JSON.stringify(file)});\n` +
      `const reader = process.argv[2] === 'same' ? 'one-reader' : 'reader-' + process.pid;\n` +
      `try { const lot = check(db, '${RUN}', reader, 10);\n` +
      `  process.stdout.write(JSON.stringify({ ok: true, id: lot.delivery && lot.delivery.id })); }\n` +
      `catch (e) { process.stdout.write(JSON.stringify({ ok: false, err: String(e.code || e.message) })); }\n` +
      `db.close();\n`,
  );

  // TRULY CONCURRENT, and this detail is the whole test. My first version used
  // spawnSync, which runs the children ONE AT A TIME — so check()'s replay
  // branch handled every call and no race ever happened. It stayed GREEN with
  // the unique index dropped, i.e. it was decoration under a name that claimed
  // concurrency. Launch all N first, then collect; and have each child park on
  // a barrier file so they contend on the same instant rather than on spawn
  // latency (~65 ms apart is not concurrency either).
  const N = 8;
  const barrier = path.join(dir, 'GO');
  const spawnAll = (mode: string) => {
    const cwd = path.resolve(import.meta.dirname, '..', '..');
    const kids = Array.from({ length: N }, () =>
      spawn('node', ['--experimental-strip-types', kid, mode, barrier], { cwd, encoding: 'utf8' }),
    );
    const done = kids.map(
      (c) =>
        new Promise<{ ok: boolean; id?: number; err?: string }>((resolve) => {
          let out = '';
          c.stdout.on('data', (d) => (out += d));
          // Await EXIT, never the stdout chunk alone: reading a child's buffer
          // in the same tick as its death yields '' and reads as "nothing ran".
          c.on('exit', (code) =>
            resolve(out ? JSON.parse(out) : { ok: false, err: `exit ${code}` }),
          );
        }),
    );
    return { done: Promise.all(done) };
  };

  const sameRun = spawnAll('same');
  // Release every child at once.
  fs.writeFileSync(barrier, 'go');
  const same = await sameRun.done;
  fs.rmSync(barrier, { force: true });
  const failures = same.filter((r) => !r.ok);
  assert.deepEqual(failures, [], `every concurrent check must succeed, got: ${JSON.stringify(failures)}`);

  const check2 = open(file);
  t.after(() => {
    try { check2.close(); } catch { /* already closed */ }
  });
  const outstanding = (
    check2.prepare("SELECT COUNT(*) c FROM deliveries WHERE reader='one-reader' AND acked_at IS NULL").get() as { c: number }
  ).c;
  assert.equal(outstanding, 1, `${N} concurrent processes must open exactly ONE lot, not ${outstanding}`);
  assert.equal(
    new Set(same.map((r) => r.id)).size,
    1,
    'and every process must have been handed that same lot id',
  );

  // THE CONTROL: distinct readers on the same rig must produce N rows. If this
  // also produced 1, the assertion above would be measuring the rig, not the index.
  const distinctRun = spawnAll('distinct');
  fs.writeFileSync(barrier, 'go');
  const distinct = await distinctRun.done;
  fs.rmSync(barrier, { force: true });
  assert.deepEqual(distinct.filter((r) => !r.ok), []);
  const manyRows = (
    check2.prepare("SELECT COUNT(*) c FROM deliveries WHERE reader LIKE 'reader-%' AND acked_at IS NULL").get() as { c: number }
  ).c;
  assert.equal(manyRows, N, `control: ${N} DISTINCT readers must open ${N} lots (got ${manyRows})`);
});

// ─── durability across a reopen ─────────────────────────────────────────────

test('an outstanding lot survives closing and reopening the database', (t) => {
  // The whole point of putting deliveries in SQLite rather than in memory: a
  // reader that died (or an app that restarted) must find its lot still
  // outstanding. This is the in-process stand-in for spike #109 arm 2-s SIGKILL;
  // the cross-process arm lives in scripts/verify-bus-contention.mjs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-reopen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bus.sqlite');

  const a = openBus(file);
  seed(a, ['m1', 'm2']);
  const taken = check(a, RUN, 'worker-1');
  assert.deepEqual(taken.messages.map((m) => m.sequence), [1, 2]);
  a.close(); // the reader "dies" without acking

  const b = openBus(file);
  const replayed = check(b, RUN, 'worker-1');
  assert.equal(replayed.replay, true, 'the lot must still be outstanding after a reopen');
  assert.equal(replayed.delivery!.id, taken.delivery!.id);
  assert.deepEqual(replayed.messages, taken.messages, 'and replay identically');
  assert.equal(ack(b, RUN, 'worker-1', replayed.delivery!.id), true);
  assert.deepEqual(check(b, RUN, 'worker-1').messages, []);
  b.close();
});
