import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, ack, check, openGate, resolveGate, getGate, type BusDb } from './bus.ts';
import {
  withReceipt,
  lookupReceipt,
  receiptRowCount,
  busReceiptCounters,
  resetBusReceiptCounters,
} from './bus-receipts.ts';

// Drives a REAL SQLite database (bus-binding.ts loads the ABI-127 build for
// `pnpm run test`). The bug class is idempotency — "does a retry re-apply the
// mutation" — which an in-memory stand-in for SQLite could not answer, since the
// whole guard is a PRIMARY KEY collision the DB enforces.
//
// EACH TEST NAMES THE PRODUCTION CLAUSE IT COVERS + its C3 mutant, so a test that
// survives its own mutant is caught.

const RUN = 'run-R';
const FP = 'ops@host';

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-receipts-test-'));
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

// ─── T130.1 — idempotent replay, both arms (switch ON) ──────────────────────

test('T130.1a: same (fingerprint, request_id) replayed → ONE row, SAME receipt, exec runs ONCE', (t) => {
  // COVERS: withReceipt's `if (existing) { … if (switchOn) return stored }`
  //   short-circuit AND the `INSERT OR IGNORE` PK guard.
  // MUTANT: change the short-circuit to `return { value: exec(), … }` (re-run
  //   exec on replay) → the second call sends a SECOND message, two rows, RED.
  const db = tmpBus(t);
  let execCount = 0;
  const call = () =>
    withReceipt(
      db,
      { callerFingerprint: FP, requestId: 'req-1', mutation: 'send', runId: RUN, switchOn: true },
      () => {
        execCount++;
        return send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'hello' });
      },
    );

  const first = call();
  const second = call();

  assert.equal(first.value, second.value, 'replay returns the SAME receipt (sequence)');
  assert.equal(first.replayed, false, 'first call is not a replay');
  assert.equal(second.replayed, true, 'second call fired the short-circuit');
  assert.equal(execCount, 1, 'exec ran exactly ONCE — the replay did not re-send');
  assert.equal(receiptRowCount(db, RUN), 1, 'exactly ONE receipt row for the key');

  // And exactly one messages row landed for the run.
  const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as {
    n: number;
  };
  assert.equal(msgs.n, 1, 'one send executed, not two');
});

test('T130.1b: a DIFFERENT request_id → TWO rows, TWO executions', (t) => {
  // COVERS: the composite PK's request_id column — a distinct id is a distinct key.
  // MUTANT: drop request_id from the PK (PK on caller_fingerprint alone) → the
  //   second id collides with the first, one row, and its exec is treated as a
  //   replay → RED (expects two rows / two sends).
  const db = tmpBus(t);
  let execCount = 0;
  const call = (reqId: string, body: string) =>
    withReceipt(
      db,
      { callerFingerprint: FP, requestId: reqId, mutation: 'send', runId: RUN, switchOn: true },
      () => {
        execCount++;
        return send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body });
      },
    );

  const a = call('req-1', 'first');
  const b = call('req-2', 'second');

  assert.notEqual(a.value, b.value, 'two distinct request ids → distinct receipts');
  assert.equal(execCount, 2, 'exec ran twice — two distinct mutations');
  assert.equal(receiptRowCount(db, RUN), 2, 'TWO receipt rows');
  const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as {
    n: number;
  };
  assert.equal(msgs.n, 2, 'two sends executed');
});

// ─── T130.2 — covers send / ack / gate_resolve ──────────────────────────────

test('T130.2: ack is idempotent under a receipt (switch ON) — replay does not re-ack', (t) => {
  // COVERS: withReceipt wrapping ack() (a nested transaction — savepoint-safe).
  // MUTANT: short-circuit re-runs exec → the second ack returns false (lot
  //   already closed) instead of the stored `true` → RED.
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'm1' });
  const lot = check(db, RUN, 'reader-1');
  assert.ok(lot.delivery, 'a lot was taken');
  const lotId = lot.delivery!.id;

  let execCount = 0;
  const call = () =>
    withReceipt(
      db,
      { callerFingerprint: 'reader-1', requestId: 'ack-1', mutation: 'ack', runId: RUN, switchOn: true },
      () => {
        execCount++;
        return ack(db, RUN, 'reader-1', lotId);
      },
    );

  const first = call();
  const second = call();
  assert.equal(first.value, true, 'first ack closed the lot');
  assert.equal(second.value, true, 'replay returns the STORED true, not a fresh false');
  assert.equal(second.replayed, true);
  assert.equal(execCount, 1, 'ack executed once');
});

test('T130.2: gate_resolve is idempotent under a receipt (switch ON)', (t) => {
  // COVERS: withReceipt wrapping resolveGate().
  // MUTANT: short-circuit re-runs exec → the second resolve returns false
  //   (already resolved) instead of the stored `true` → RED.
  const db = tmpBus(t);
  const gateId = openGate(db, RUN, 'ops', 'ship it?', 'lead');

  let execCount = 0;
  const call = () =>
    withReceipt(
      db,
      { callerFingerprint: 'lead', requestId: 'gr-1', mutation: 'gate_resolve', runId: RUN, switchOn: true },
      () => {
        execCount++;
        return resolveGate(db, gateId, 'lead', 'yes');
      },
    );

  const first = call();
  const second = call();
  assert.equal(first.value, true, 'first resolve succeeded');
  assert.equal(second.value, true, 'replay returns stored true, not a fresh false');
  assert.equal(execCount, 1, 'resolveGate executed once');
  // The gate carries the FIRST ruling, unchanged.
  assert.equal(getGate(db, gateId)?.resolution, 'yes');
});

// ─── T130.3 — COUNTED-not-FIRED while the switch is OFF ──────────────────────

test('T130.3: switch OFF → replay is COUNTED but NOT fired; the mutation re-executes (v1)', (t) => {
  // COVERS: the `if (!input.switchOn) { const value = exec(); return {…replayed:false} }`
  //   coexistence branch + the counters.
  // MUTANT: fire the short-circuit regardless of switchOn (delete the `if
  //   (input.switchOn)` guard) → with the switch OFF the second send would be
  //   suppressed → only ONE messages row → RED (expects two).
  const db = tmpBus(t);
  resetBusReceiptCounters();
  let execCount = 0;
  const call = () =>
    withReceipt(
      db,
      { callerFingerprint: FP, requestId: 'req-off', mutation: 'send', runId: RUN, switchOn: false },
      () => {
        execCount++;
        return send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'shadow' });
      },
    );

  const first = call();
  const second = call();

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, false, 'switch OFF: the short-circuit did NOT fire');
  assert.equal(second.counted, true, 'but the retry WAS counted (a prior receipt existed)');
  assert.equal(execCount, 2, 'v1 behaviour: the mutation re-executed under the switch OFF');

  // The row is still RECORDED (the shadow signal) — exactly ONE, because the PK
  // ignores the second insert.
  assert.equal(receiptRowCount(db, RUN), 1, 'exactly one receipt row recorded (shadow count)');
  // Two messages: the OLD channel stayed authoritative.
  const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as {
    n: number;
  };
  assert.equal(msgs.n, 2, 'two sends: the old channel is authoritative while OFF');

  const c = busReceiptCounters();
  assert.equal(c.recorded, 1, 'one row recorded');
  assert.equal(c.countedReplays, 1, 'one retry counted');
  assert.equal(c.firedReplays, 0, 'ZERO fired while the switch is OFF');
});

// ─── request-id reuse across DIFFERENT verbs is refused ─────────────────────

test('a request id reused for a DIFFERENT mutation is refused, not handed the wrong receipt', (t) => {
  // COVERS: the `existing.mutation !== input.mutation` throw.
  // MUTANT: drop the mismatch check → the second call returns a `send`'s numeric
  //   receipt as an `ack`'s boolean → the assert.throws below goes RED.
  const db = tmpBus(t);
  withReceipt(
    db,
    { callerFingerprint: FP, requestId: 'dup', mutation: 'send', runId: RUN, switchOn: true },
    () => send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'x' }),
  );
  assert.throws(
    () =>
      withReceipt(
        db,
        { callerFingerprint: FP, requestId: 'dup', mutation: 'ack', runId: RUN, switchOn: true },
        () => true,
      ),
    /is per-mutation/,
    'a request id is bound to its first mutation kind',
  );
});

// ─── input validation ───────────────────────────────────────────────────────

test('withReceipt requires a fingerprint, a request id, and a known mutation', (t) => {
  const db = tmpBus(t);
  const base = { callerFingerprint: FP, requestId: 'r', mutation: 'send' as const, runId: RUN, switchOn: true };
  assert.throws(
    () => withReceipt(db, { ...base, callerFingerprint: '  ' }, () => 1),
    /callerFingerprint is required/,
  );
  assert.throws(() => withReceipt(db, { ...base, requestId: '' }, () => 1), /requestId is required/);
  assert.throws(
    // @ts-expect-error — deliberately an invalid mutation kind
    () => withReceipt(db, { ...base, mutation: 'nope' }, () => 1),
    /unknown mutation/,
  );
});

test('lookupReceipt reads a stored receipt back and returns null for an unknown key', (t) => {
  const db = tmpBus(t);
  assert.equal(lookupReceipt(db, RUN, FP, 'absent'), null);
  withReceipt(
    db,
    { callerFingerprint: FP, requestId: 'r1', mutation: 'send', runId: RUN, switchOn: true },
    () => send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'x' }),
  );
  const row = lookupReceipt(db, RUN, FP, 'r1');
  assert.ok(row, 'the receipt is readable back');
  assert.equal(row!.mutation, 'send');
  assert.equal(row!.run_id, RUN);
  // The key is run-scoped: the SAME fingerprint+request_id in a DIFFERENT run
  // does not resolve (review #130 F1).
  assert.equal(lookupReceipt(db, 'other-run', FP, 'r1'), null, 'a receipt is scoped to its run');
});

test('F1: same (fingerprint, request_id) in a DIFFERENT run does NOT collide — BOTH execute (switch ON)', (t) => {
  // COVERS: run_id in the PK + in getExisting/lookup (review #130 F1). Without
  // run_id in the key, run B's send would short-circuit to run A's stored receipt
  // and vanish, handing the caller run A's stale sequence.
  // MUTANT: drop run_id from the PK (or from getExisting) → run B execRan=false,
  //   0 rows in run B, B.value == A's seq → this arm goes RED.
  const db = tmpBus(t);
  let execA = 0;
  let execB = 0;
  // Same handle FP, same request_id 'r1', switch ON — but two distinct runs.
  const a = withReceipt(
    db,
    { callerFingerprint: FP, requestId: 'r1', mutation: 'send', runId: 'run-A', switchOn: true },
    () => {
      execA++;
      return send(db, { runId: 'run-A', sender: 'ops', kind: 'dispatch', body: 'a' });
    },
  );
  const b = withReceipt(
    db,
    { callerFingerprint: FP, requestId: 'r1', mutation: 'send', runId: 'run-B', switchOn: true },
    () => {
      execB++;
      return send(db, { runId: 'run-B', sender: 'ops', kind: 'dispatch', body: 'b' });
    },
  );
  assert.equal(execA, 1, 'run A executed');
  assert.equal(execB, 1, 'run B ALSO executed — the key is run-scoped, not global');
  assert.equal(b.replayed, false, 'run B is not a replay of run A');
  assert.notEqual(a.value, b.value, 'each run got its own sequence');
  // One message landed per run; one receipt row per run.
  const msgsA = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id='run-A'").get() as { n: number }).n;
  const msgsB = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id='run-B'").get() as { n: number }).n;
  assert.equal(msgsA, 1, 'run A has its message');
  assert.equal(msgsB, 1, 'run B has its message — did NOT vanish');
  assert.equal(receiptRowCount(db, 'run-A'), 1);
  assert.equal(receiptRowCount(db, 'run-B'), 1);
  // And WITHIN a run the same key is still idempotent (the property F1 preserves).
  const aReplay = withReceipt(
    db,
    { callerFingerprint: FP, requestId: 'r1', mutation: 'send', runId: 'run-A', switchOn: true },
    () => {
      execA++;
      return send(db, { runId: 'run-A', sender: 'ops', kind: 'dispatch', body: 'a' });
    },
  );
  assert.equal(execA, 1, 'the in-run replay still short-circuits (exec not re-run)');
  assert.equal(aReplay.replayed, true);
  assert.equal(aReplay.value, a.value, 'the in-run replay returns run A original seq');
});
