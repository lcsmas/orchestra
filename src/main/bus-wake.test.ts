import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, check, ack, openGate, type BusDb } from './bus.ts';
import { readPendingReaders } from './bus-wake.ts';

// `readPendingReaders` against a REAL SQLite bus (#117, ledger #123).
//
// The predicate is the part of this ticket most able to be silently wrong. A
// wake mechanism whose pending test is too NARROW fires nothing and looks
// exactly like a quiet fleet; one that is too BROAD wakes every reader every
// sweep and looks like a busy fleet. Neither failure raises anything, so both
// are tested here in both directions against durable rows, not a mock — an
// in-memory stand-in would only re-encode the answer I already believed.
//
// Runtime note (inherited from bus.test.ts): `pnpm run test` is system node
// (ABI 127) and bus-binding.ts loads the ABI-127 build from build/bus-abi/, so
// these construct a genuine database. `pnpm run build:bus-abi` produces it.

const RUN = 'run-W';
const READER = 'ws-reader';
const OTHER = 'ws-other';

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-buswake-test-'));
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

function pendingFor(db: BusDb, reader: string, runId = RUN) {
  const rows = readPendingReaders(db, [{ reader, runId }]);
  assert.equal(rows.length, 1);
  return rows[0];
}

// ── The zero arm FIRST: the instrument must be able to report nothing ───────

test('an empty bus reports NOT pending — the instrument can return zero', (t) => {
  // Carry-forward 4, and it goes first deliberately. Every "pending" assertion
  // below is only evidence if this predicate is capable of saying no; without
  // this arm a hardcoded `pending: true` would pass the entire file.
  const db = tmpBus(t);
  const p = pendingFor(db, READER);
  assert.equal(p.pending, false);
  assert.equal(p.pendingThroughSeq, 0);
});

// ── A reader that has NEVER checked is the one most in need of waking ───────

test('a reader with no cursor and no delivery row IS pending', (t) => {
  // COVERS: expressing the lot half as "anything past the durable cursor",
  // NOT as "an outstanding deliveries row exists".
  // MUTANT: rewrite readPendingReaders' lot query to key on an outstanding
  //   `deliveries` row → this test goes RED.
  // WHY IT MATTERS: a brand-new reader has no delivery row at all, so an
  //   outstanding-row predicate reports "nothing pending" for precisely the
  //   reader that has never read anything. The mechanism would then work for
  //   every reader except the ones it is for.
  const db = tmpBus(t);
  const seq = send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'hello', recipient: READER });
  const p = pendingFor(db, READER);
  assert.equal(p.pending, true);
  assert.equal(p.pendingThroughSeq, seq);
});

// ── Addressing: a message for someone else is not mine ─────────────────────

test('a message addressed to ANOTHER reader does not make me pending', (t) => {
  // MUTANT: drop the `m.recipient = ?` clause → red.
  // WHY IT MATTERS: without it every insert wakes the whole fleet, and the
  //   "one wake per reader" property is met while being useless.
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'for you', recipient: OTHER });
  assert.equal(pendingFor(db, READER).pending, false);
  // Positive control in the SAME test: the row IS pending for its addressee, so
  // a predicate that simply answered `false` for everything cannot pass this.
  assert.equal(pendingFor(db, OTHER).pending, true);
});

test('a BROADCAST (recipient IS NULL) makes every reader pending', (t) => {
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'all hands' });
  assert.equal(pendingFor(db, READER).pending, true);
  assert.equal(pendingFor(db, OTHER).pending, true);
});

// ── #168: a sender's OWN broadcast must NOT pend for itself (self-wake loop) ──

test("#168 a sender's OWN broadcast does NOT make the SENDER pending, but DOES wake every OTHER reader", (t) => {
  // THE #168 DEFECT (canary-6 rows 539→549): an agent whose protocol is "send a
  // status broadcast after each wake" self-loops — its own broadcast pends for
  // ITSELF → wake → serve → status → new broadcast → re-wake, ≥8 cycles, each a
  // full turn, zero external mail. Root: the own-run scope's NULL branch matched
  // the reader even when the reader WAS the broadcast's sender.
  //
  // MUTANT: revert ownRunRecipientSql's NULL branch to `${col} IS NULL` (drop the
  //   `AND sender != ?`) → the SENDER arm below flips true and reddens.
  // POSITIVE CONTROL in the SAME test: OTHER (not the sender) is STILL woken by
  //   the exact same broadcast, so the exclusion is proven to cut ONLY the sender,
  //   not to have quietly killed the broadcast for everyone (which would also make
  //   the sender arm pass, vacuously).
  const db = tmpBus(t);
  const seq = send(db, { runId: RUN, sender: READER, kind: 'status', body: 'status after wake' });
  assert.equal(
    pendingFor(db, READER).pending,
    false,
    "the sender's own broadcast must NOT pend for itself (#168 self-loop)",
  );
  const other = pendingFor(db, OTHER);
  assert.equal(other.pending, true, 'a DIFFERENT reader IS still woken by that broadcast');
  assert.equal(other.pendingThroughSeq, seq, 'and it names the broadcast as the pending high-water');
});

test('#168 the exclusion survives ≥3 sweeps — the sender never re-wakes on its own broadcast', (t) => {
  // ACCEPTANCE arm 1: "agent sends a broadcast, idles → NOT woken across ≥3
  // sweeps". readPendingReaders is deterministic over durable rows, so re-reading
  // it N times with no intervening write models N idle sweeps exactly. Pre-fix
  // every sweep returned pending:true → a wake per sweep = the loop.
  // MUTANT: same as above (drop `AND sender != ?`) → sweep 1 already reddens.
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: READER, kind: 'status', body: 'my status' });
  for (let sweep = 1; sweep <= 3; sweep++) {
    assert.equal(
      pendingFor(db, READER).pending,
      false,
      `sweep ${sweep}: the sender is still not woken by its own broadcast`,
    );
  }
});

test('#168 a DIRECTED self-note (recipient = self) is UNCHANGED — still pending', (t) => {
  // ACCEPTANCE arm 3, decided EXPLICITLY: the exclusion is scoped to the NULL
  // (broadcast) branch only. An explicit `--to self` directed message is a
  // deliberate self-note and MUST remain wakeable — it matches `recipient = ?`,
  // never the NULL branch, so the sender!=reader guard never applies to it.
  // MUTANT: broaden the guard to `AND sender != ?` OUTSIDE the NULL branch (i.e.
  //   apply it to the whole predicate) → this arm reddens, catching an
  //   over-broad fix that would also swallow legitimate directed self-mail.
  const db = tmpBus(t);
  const seq = send(db, { runId: RUN, sender: READER, kind: 'dispatch', body: 'note to self', recipient: READER });
  const p = pendingFor(db, READER);
  assert.equal(p.pending, true, 'a directed message to self is still pending (unchanged)');
  assert.equal(p.pendingThroughSeq, seq);
});

test("#168 OTHER's broadcast still wakes the reader — the exclusion keys on THIS message's sender, not the reader's own past sends", (t) => {
  // Guards against a mis-scoped fix that excludes a reader from ANY broadcast once
  // it has ever sent one. The reader sends its own broadcast (not pending for it),
  // THEN OTHER broadcasts — the reader MUST be woken by OTHER's, because the guard
  // is per-message (`m.sender != reader`), not per-reader.
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: READER, kind: 'status', body: 'mine' });
  assert.equal(pendingFor(db, READER).pending, false, 'not woken by own broadcast');
  const seq = send(db, { runId: RUN, sender: OTHER, kind: 'status', body: 'theirs' });
  const p = pendingFor(db, READER);
  assert.equal(p.pending, true, "woken by OTHER's broadcast");
  assert.equal(p.pendingThroughSeq, seq, "and the pending high-water is OTHER's broadcast");
});

test('#144 THE CANARY: a SHORT-handle recipient never wakes the full-id reader; the full id does', (t) => {
  // THE EXACT canary defect (rows 444–448): the fleet sent `--to 0a5c25bb` and
  // the row stored `recipient='0a5c25bb'`, but the reader is identified on the
  // wake predicate by its FULL uuid — so the exact-match never fired and the OPS
  // was never woken. The #144 fix is `send` canonicalizing the handle to the
  // full id BEFORE the row exists; this test proves the wake predicate's side of
  // that contract: only a full-id recipient matches a full-id reader.
  const FULL = 'b3f55639-1d61-4d21-b6bf-0d701445dc12';
  const SHORT = 'b3f55639';
  const db = tmpBus(t);
  // Pre-fix behavior: a short-handle recipient row does NOT make the full-id
  // reader pending. This is the must-FAIL the canonicalizer removes upstream.
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'report', recipient: SHORT });
  assert.equal(pendingFor(db, FULL).pending, false, 'a short handle never wakes the full-id reader');
  // Post-fix behavior: the canonicalized full-id recipient DOES wake it. Same
  // command as the negative, so the predicate is proven able to say yes here.
  const seq = send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'report2', recipient: FULL });
  assert.equal(pendingFor(db, FULL).pending, true, 'the full-id recipient wakes the reader');
  assert.equal(pendingFor(db, FULL).pendingThroughSeq, seq);
});

// ── The ack path — T117.4's mechanism, at the durable layer ────────────────

test('check() alone does NOT clear pending; the reader ACK does', (t) => {
  // COVERS: reading `cursors.acked_seq`, which only ack() advances.
  // MUTANT: compute the cursor from `deliveries.to_seq` regardless of acked_at
  //   → the check-only arm goes RED.
  // WHY IT MATTERS: this is the ADR's "the ack belongs to the reader". If a
  //   host-side take cleared pending, a reader SIGKILLed between check and ack
  //   would never be woken about a lot it never read — the lying "Delivered"
  //   the bus exists to kill, rebuilt in the wake layer.
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: READER });

  const lot = check(db, RUN, READER);
  assert.ok(lot.delivery, 'the rig must actually produce a lot, or the arms below prove nothing');
  assert.equal(pendingFor(db, READER).pending, true, 'still pending: taken is not read');

  assert.equal(ack(db, RUN, READER, lot.delivery.id), true);
  assert.equal(pendingFor(db, READER).pending, false, 'the reader acked — pending clears');
});

test('new mail arriving AFTER an ack makes the reader pending again', (t) => {
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'one', recipient: READER });
  const lot = check(db, RUN, READER);
  ack(db, RUN, READER, lot.delivery!.id);
  assert.equal(pendingFor(db, READER).pending, false);

  const seq2 = send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'two', recipient: READER });
  const p = pendingFor(db, READER);
  assert.equal(p.pending, true);
  assert.equal(p.pendingThroughSeq, seq2);
});

// ── D2 (ledger #123 Q-B3): an open GATE does NOT wake; a QUESTION message does ─

test('D2 must-FAIL arm — an open GATE does NOT make a reader pending', (t) => {
  // LEAD §Decisions D2: gate-driven wakes are dropped from #117 and move to
  // #119. The order a wake carries is `orchestra check`, which reads `messages`
  // only — a gate has no recipient column and no `gate list` verb, so a gate can
  // never be surfaced by the order. Waking on it would order the reader to look
  // where the gate is invisible, ack nothing, loop forever, and over-count the
  // shadow `counted` signal the promotion bar reads.
  // MUTANT: restore the `decision_gates`/`asks` half of the predicate → red.
  const db = tmpBus(t);
  assert.equal(pendingFor(db, READER).pending, false, 'baseline: quiet');
  openGate(db, RUN, OTHER, 'ship it?');
  assert.equal(pendingFor(db, READER).pending, false, 'a gate must be INVISIBLE to the wake predicate (D2)');
  // Positive control, same command: a QUESTION message addressed to the reader
  // — which `check` CAN surface — DOES make it pending, so the zero above is D2
  // in force, not a dead predicate that says no to everything.
  send(db, { runId: RUN, sender: OTHER, kind: 'question', body: 'still ship it?', recipient: READER });
  assert.equal(pendingFor(db, READER).pending, true, 'a question message the order can surface DOES wake');
});

test('an open QUESTION message keeps a reader pending with no unread lot', (t) => {
  // COVERS: the openQuestion half — the "ask addressed to the reader" D2 keeps.
  // MUTANT: delete the openQuestion query / its qhi contribution → red.
  // WHY IT MATTERS: "a reader parked on a question is waiting, never stale"
  //   (#117 Intent). A question has a recipient and `check` returns it, so
  //   unlike a gate it is genuinely surfaceable by the wake order.
  const db = tmpBus(t);
  assert.equal(pendingFor(db, READER).pending, false, 'baseline: quiet');
  send(db, { runId: RUN, sender: OTHER, kind: 'question', body: 'ship it?', recipient: READER });
  assert.equal(pendingFor(db, READER).pending, true);
  // Negative control, same command: a question addressed to READER does NOT make
  // OTHER pending — the predicate is recipient-scoped, not a blanket "any question".
  assert.equal(pendingFor(db, OTHER).pending, false);
});

// ── Batch shape ────────────────────────────────────────────────────────────

test('readPendingReaders answers per reader in one pass, not one answer for all', (t) => {
  const db = tmpBus(t);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'yours', recipient: READER });
  const rows = readPendingReaders(db, [
    { reader: READER, runId: RUN },
    { reader: OTHER, runId: RUN },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.reader, r.pending]),
    [[READER, true], [OTHER, false]],
  );
});

test('an open QUESTION in ANOTHER run does not make this reader pending', (t) => {
  // COVERS: `run_id = ?` in the openQuestion query.
  // MUTANT: replace it with `? IS NOT NULL` → red.
  // WHY IT MATTERS: run-scoping is what keeps the per-run switch coherent — a
  // question leaking across runs would wake a reader to `orchestra check`,
  // which — scoped to ITS run by the CLI — returns an empty lot, so the reader
  // acks nothing and is woken every sweep forever.
  const db = tmpBus(t);
  send(db, { runId: 'a-different-run', sender: OTHER, kind: 'question', body: 'ship it?', recipient: READER });
  assert.equal(pendingFor(db, READER, RUN).pending, false);
  // Positive control, same command: the SAME question read from ITS run does
  // make the reader pending, so the zero above is scoping, not a blind query.
  assert.equal(pendingFor(db, READER, 'a-different-run').pending, true);
});
