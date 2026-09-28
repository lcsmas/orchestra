import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASKER_DELETED_RESOLUTION,
  ack,
  check,
  expireAllOrphanedAsks,
  expireOrphanedAsks,
  getGate,
  openBus,
  openGate,
  resolveGate,
  send,
  type BusDb,
} from './bus.ts';
import { readPendingReaders, readWaitingReaders } from './bus-wake.ts';

// #187: deleting the ASKER workspace must expire its open asks/gates in ALL
// runs, so the wake/liveness predicates stop treating them as pending/waiting.
// Each arm names the production clause it kills.
//
// These drive a REAL SQLite bus through the SHIPPED wake predicates
// (readPendingReaders / readWaitingReaders) — the observable the #185 storm
// acts on — not a hand-rolled re-encoding of "is it answered".
//
// FS: temp bus on $HOME (btrfs, same FS as prod), NOT os.tmpdir() (tmpfs), per
// the bus-rig contract rule. No arm here depends on WAL inode behaviour, but the
// rule is uniform.

const base = process.env.HOME || os.homedir();

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(base, '.orchestra-orphaned-asks-test-'));
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

// Two well-formed workspace UUIDs (randomUUID shape) — the backfill discriminant
// only touches this shape.
const ASKER = 'bddbca9a-6a6c-4b2a-ad1f-b4d8f5d914ae';
const RECIPIENT = '36773f53-1111-4111-8111-111111111111';
const PEER = 'aaaaaaaa-2222-4222-8222-222222222222';
const RUN = ASKER; // a member's run anchor is a UUID; the ask lives in this run

function isRecipientPending(db: BusDb, runId = RUN): boolean {
  const [state] = readPendingReaders(db, [{ reader: RECIPIENT, runId }]);
  return !!state?.pending;
}

/** Drain the recipient's lot so the ONLY thing left pending is the answer-based
 *  re-arm — the #185 storm shape (cursor past the question, question unanswered).
 *  Without this the un-acked question is itself an unread LOT and `pending` is
 *  true for a reason expiry does not (and should not) touch. */
function drainRecipientLot(db: BusDb, runId: string): void {
  const lot = check(db, runId, RECIPIENT);
  if (lot.delivery) ack(db, runId, RECIPIENT, lot.delivery.id);
}

// ── A1: the 1458 shape — an orphaned QUESTION closes on asker delete ──────────
// Kills: the synthetic-reply INSERT in expireOrphanedAsks. Remove it and the
// recipient stays pending forever (the #185 re-wake-every-boot bug).
test('A1 orphaned question: recipient pending before delete, answered after', (t) => {
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: ASKER, kind: 'question', body: 'q?', recipient: RECIPIENT });
  drainRecipientLot(db, RUN); // recipient read+acked; only the unanswered ask remains

  assert.equal(
    isRecipientPending(db),
    true,
    'recipient still pending on the unanswered ask (the storm shape)',
  );

  const res = expireOrphanedAsks(db, ASKER);
  assert.equal(res.questions, 1, 'one question expired');
  assert.equal(res.gates, 0);
  assert.equal(isRecipientPending(db), false, 'recipient no longer pending post-expire');
});

// ── A2: an orphaned GATE resolves as "asker deleted", system ─────────────────
// Kills: the decision_gates UPDATE. Remove it and readWaitingReaders keeps the
// (now-deleted) asker flagged waiting and the gate stays open.
test('A2 orphaned gate: resolved asker-deleted, opener no longer waiting', (t) => {
  const db = tmpBus(t);
  const gateId = openGate(db, RUN, ASKER, 'ruling?', RECIPIENT);

  assert.ok(
    readWaitingReaders(db, [{ reader: ASKER, runId: RUN }]).has(ASKER),
    'opener must be waiting pre-delete',
  );

  const res = expireOrphanedAsks(db, ASKER);
  assert.equal(res.gates, 1, 'one gate expired');
  const gate = getGate(db, gateId)!;
  assert.equal(gate.resolution, ASKER_DELETED_RESOLUTION);
  assert.equal(gate.resolved_by, 'system');
  assert.ok(gate.resolved_at && gate.resolved_at > 0, 'resolved_at stamped');
  assert.equal(
    readWaitingReaders(db, [{ reader: ASKER, runId: RUN }]).has(ASKER),
    false,
    'opener no longer waiting',
  );
});

// ── A3: a LIVING asker's ask survives deletion of an unrelated peer ──────────
// Kills: the `sender=?` / `asked_by=?` scoping. Widen it and a peer-delete would
// wrongly close the living asker's ask.
test('A3 living asker untouched when an unrelated peer is deleted', (t) => {
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: ASKER, kind: 'question', body: 'q?', recipient: RECIPIENT });
  const gateId = openGate(db, RUN, ASKER, 'ruling?', RECIPIENT);

  const res = expireOrphanedAsks(db, PEER); // delete the PEER, not the asker
  assert.equal(res.questions, 0, 'no question closed for a peer delete');
  assert.equal(res.gates, 0, 'no gate closed for a peer delete');
  assert.equal(isRecipientPending(db), true, "living asker's question still pending");
  assert.equal(getGate(db, gateId)!.resolved_at, null, "living asker's gate still open");
});

// ── A4: an ALREADY-resolved gate is not overwritten ──────────────────────────
// Kills: the `resolved_at IS NULL` guard on the UPDATE. Drop it and a human's
// earlier ruling gets clobbered with "asker deleted".
test('A4 already-resolved gate is left intact', (t) => {
  const db = tmpBus(t);
  const gateId = openGate(db, RUN, ASKER, 'ruling?', RECIPIENT);
  assert.equal(resolveGate(db, gateId, 'lucas', 'approved'), true);

  const res = expireOrphanedAsks(db, ASKER);
  assert.equal(res.gates, 0, 'a resolved gate is not re-counted');
  const gate = getGate(db, gateId)!;
  assert.equal(gate.resolution, 'approved', 'human ruling preserved');
  assert.equal(gate.resolved_by, 'lucas', 'human resolver preserved');
});

// ── A5: BOOT BACKFILL — orphaned by shape+absence, non-workspace ids spared ──
// Kills: the `WORKSPACE_ID_RE.test(id) && !isLiveWorkspace(id)` discriminant.
//  - a UUID asker absent from the store  → closed (the prod 1458 case)
//  - a live UUID asker                   → untouched (fails !isLiveWorkspace)
//  - a host-… asker (non-workspace id)   → untouched (fails the UUID shape)
test('A5 backfill closes deleted-workspace orphans only', (t) => {
  const db = tmpBus(t);
  const liveAsker = PEER;
  const hostAsker = 'host-abc123'; // a run-anchor / per-boot host id, not a ws
  send(db, { runId: RUN, sender: ASKER, kind: 'question', body: 'q?', recipient: RECIPIENT });
  send(db, {
    runId: liveAsker,
    sender: liveAsker,
    kind: 'question',
    body: 'alive?',
    recipient: RECIPIENT,
  });
  send(db, {
    runId: 'default',
    sender: hostAsker,
    kind: 'question',
    body: 'host?',
    recipient: RECIPIENT,
  });

  // Store liveness: only `liveAsker` exists; ASKER + hostAsker are absent.
  const live = new Set([liveAsker]);
  const r = expireAllOrphanedAsks(db, (id) => live.has(id), /* storeLoaded */ true);

  assert.deepEqual(r.askers, [ASKER], 'only the deleted-workspace asker expired');
  assert.equal(r.questions, 1, 'exactly the one orphan closed');
  // The live asker's question is still pending for the recipient…
  assert.equal(
    !!readPendingReaders(db, [{ reader: RECIPIENT, runId: liveAsker }])[0]?.pending,
    true,
    'live asker question untouched',
  );
  // …and the host-… asker's question is untouched (still open).
  assert.equal(
    !!readPendingReaders(db, [{ reader: RECIPIENT, runId: 'default' }])[0]?.pending,
    true,
    'host-… asker question untouched (wrong shape for a workspace)',
  );
});

// ── A6: closes across ALL runs, not just the asker's anchor run ──────────────
// Kills: any run-scoping on expireOrphanedAsks. The cross-fleet #187 ask lives
// in ANOTHER mission's run; a run filter would leave it eternal.
test('A6 orphaned ask in a foreign run is still closed', (t) => {
  const db = tmpBus(t);
  const foreignRun = 'cccccccc-3333-4333-8333-333333333333';
  send(db, {
    runId: foreignRun,
    sender: ASKER,
    kind: 'question',
    body: 'cross?',
    recipient: RECIPIENT,
  });

  drainRecipientLot(db, foreignRun); // storm shape: acked, still unanswered
  assert.equal(
    isRecipientPending(db, foreignRun),
    true,
    'pending in the foreign run pre-expire',
  );
  const res = expireOrphanedAsks(db, ASKER);
  assert.equal(res.questions, 1, 'the foreign-run orphan is closed');
  assert.equal(
    isRecipientPending(db, foreignRun),
    false,
    'no longer pending in the foreign run',
  );
});

// ── A7: EMPTY-STORE FALLBACK closes NOTHING (review #187 F1) ──────────────────
// Kills: the `if (!storeLoaded) return …` gate. An absent/corrupt store.json falls
// back to empty defaults, under which isLiveWorkspace is false for EVERY id — so
// without the gate the backfill would close a LIVING asker's ask/gate. Simulates
// exactly that: storeLoaded=false + isLiveWorkspace()=>false + an open ask/gate.
test('A7 empty-store fallback: backfill is a no-op (does not close live askers)', (t) => {
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: ASKER, kind: 'question', body: 'q?', recipient: RECIPIENT });
  const gateId = openGate(db, RUN, ASKER, 'ruling?', RECIPIENT);
  drainRecipientLot(db, RUN);

  // storeLoaded=false is the empty/corrupt fallback; isLiveWorkspace()=>false is
  // what an empty DEFAULT store returns for every asker (the exact hazard).
  const r = expireAllOrphanedAsks(db, () => false, /* storeLoaded */ false);
  assert.deepEqual(r, { askers: [], questions: 0, gates: 0 }, 'nothing closed');
  assert.equal(isRecipientPending(db), true, 'ask still pending — asker not misread as deleted');
  assert.equal(getGate(db, gateId)!.resolved_at, null, 'gate still open');
});
