import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openBus,
  send,
  check,
  ack,
  openGate,
  resolveGate,
  type BusDb,
} from './bus.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  readWaitingReaders,
  readPendingReaders,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
} from './bus-wake.ts';
import { decideWake, type ReaderPendingState } from '../shared/bus-wake.ts';

// #119 — asks + decision gates, driven end to end over a real SQLite bus.
//
// Every sweep arm counts TURNS DELIVERED at the wake-delivery seam — the same
// observable #117's suite counts, deliberately NOT the dedup ledger or the
// pending predicate (a bug in either would move both together; the #112 lesson).
// Each arm names its production clause and its mutant, and each is shown RED
// under that mutant before it was left GREEN (C3 / carry-forwards 1+3).

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-asksgates-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    __resetBusWakeForTests();
  });
  return db;
}

const RUN = 'run-AG';
const ASKER = 'ws-asker';
const R = 'ws-R'; // the recipient / target
const OTHER = 'ws-other';

/** Arm the sweep over `db`, recording every wake. `wake`/`askGate` are the two
 *  frozen switches (#119). A roster entry per named reader, all wakeable. */
function rig(
  db: BusDb,
  opts: {
    wake: boolean | ((runId: string) => boolean);
    askGate?: boolean | ((runId: string) => boolean);
    readers?: string[];
  },
) {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() =>
    (opts.readers ?? [R]).map((reader) => ({ reader, wakeable: true, runId: RUN })),
  );
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(opts.wake, opts.askGate ?? false);
  return wakes;
}

// ══ T119.1 — the ask re-wake loop (acceptance 1) ═════════════════════════════

test('T119.1 ask → target woken → target acks WITHOUT answering → target RE-woken → answers → asker woken', async (t) => {
  // The full loop. `wake` ON so the question wake FIRES.
  //
  // MUTANT that turns the SECOND-wake half red: make the question predicate
  //   cursor-based again (clear on ack) — the recipient is woken once and never
  //   re-woken after acking, so `wakes for R` stays 1. The answer-based predicate
  //   + cursor-advance re-arm is what produces the 2.
  const db = tmpDb(t);
  const wakes = rig(db, { wake: true, readers: [ASKER, R] });

  // ── the ask: ASKER parks a question for R and ends its turn ──
  const askSeq = send(db, {
    runId: RUN,
    sender: ASKER,
    kind: 'question',
    body: 'ship or hold?',
    recipient: R,
  });

  // 1st wake: R is woken for the ask (bounded drive-until, not sleep-then-read).
  await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === R).length, 1, 'R is woken for the ask');
  // The ASKER is NOT woken by its own outgoing question.
  assert.equal(wakes.filter((w) => w.reader === ASKER).length, 0, 'the asker is not woken by its own ask');

  // ── R reads and acks WITHOUT answering ──
  const lot = check(db, RUN, R);
  assert.equal(
    lot.messages.some((m) => m.sequence === askSeq && m.kind === 'question'),
    true,
    'the ask is surfaced to R in its lot',
  );
  assert.equal(ack(db, RUN, R, lot.delivery!.id), true);

  // 2nd wake: the ask is still unanswered, so acking re-arms and R is re-woken.
  // Bounded: drive a fixed number of sweeps and require the count to REACH 2.
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(
    wakes.filter((w) => w.reader === R).length,
    2,
    'R is RE-woken after acking without answering — exactly one more (bounded by the ack, not by sweeps)',
  );

  // ── R answers via send --thread <ask-id> ──
  send(db, {
    runId: RUN,
    sender: R,
    kind: 'status',
    body: 'ship',
    recipient: ASKER,
    threadId: String(askSeq),
  });

  // The asker is woken with the answer in its lot.
  await sweepBusWake();
  assert.equal(
    wakes.filter((w) => w.reader === ASKER).length,
    1,
    'the asker is woken once the answer lands',
  );
  const askerLot = check(db, RUN, ASKER);
  assert.equal(
    askerLot.messages.some((m) => m.body === 'ship' && m.thread_id === String(askSeq)),
    true,
    "the answer is in the asker's lot",
  );

  // And R is no longer re-woken: the ask is answered, so its pending clears.
  ack(db, RUN, R, check(db, RUN, R).delivery?.id ?? -1);
  const before = wakes.filter((w) => w.reader === R).length;
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(
    wakes.filter((w) => w.reader === R).length,
    before,
    'an ANSWERED ask stops re-waking R',
  );
});

test('T119.1 positive control — the re-wake is bounded by ACKS, not fired every sweep', async (t) => {
  // Without acking, R must be woken EXACTLY once and not spammed: the dedup holds
  // until the cursor advances. This is the disproof of a naive "unanswered ⇒ wake
  // every sweep" implementation, which would be a wake storm.
  const db = tmpDb(t);
  const wakes = rig(db, { wake: true, readers: [R] });
  send(db, { runId: RUN, sender: ASKER, kind: 'question', body: 'q?', recipient: R });

  for (let i = 0; i < 6; i++) await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === R).length, 1, 'no ack, no cursor advance → exactly one wake');
});

// ══ T119.3 — the MUST-FAIL gate-wake arm (LEAD D2 mandate) ════════════════════

test('T119.3 an open gate addressed to R produces EXACTLY ONE wake for R and ZERO for anyone else', async (t) => {
  // The core #119 reversal of wave-B D2. `askGate` ON so the gate wake fires.
  //
  // MUTANT: remove the gate half from readPendingReaders (or pass recipient=null
  //   in openGate) → R gets ZERO gate wakes → red. That is the pre-#119 predicate,
  //   exercised directly in the arm below.
  const db = tmpDb(t);
  const wakes = rig(db, { wake: true, askGate: true, readers: [R, OTHER] });
  openGate(db, RUN, 'lead', 'ship?', R); // addressed to R

  for (let i = 0; i < 4; i++) await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === R).length, 1, 'exactly ONE wake for the recipient');
  assert.equal(wakes.filter((w) => w.reader === OTHER).length, 0, 'ZERO for a non-recipient');
  assert.equal(busWakeCounters().fired, 1, 'exactly one fire total');
});

test('T119.3 MUST-FAIL on the PRE-#119 predicate: an open gate produces ZERO gate wakes', async (t) => {
  // The arm that must FAIL on old code, then GREEN on new. The pre-#119 predicate
  // is exactly `readPendingReaders` WITHOUT the gate half — reconstructed here by
  // stripping the gate fields, so this arm runs THROUGH the same rig and shows the
  // old answer was zero. On the new predicate the gate half is present and the arm
  // above proves the one wake; here we assert the OLD shape yields none.
  const db = tmpDb(t);
  openGate(db, RUN, 'lead', 'ship?', R);

  // The NEW predicate DOES report R gate-pending (the fix):
  const nowPending = readPendingReaders(db, [{ reader: R, runId: RUN }])[0];
  assert.equal(nowPending.gatePending, true, 'new predicate: an addressed gate makes R gate-pending');

  // The OLD predicate (gate half stripped) reports NOTHING — feed it to the pure
  // decision and require ZERO fire even with BOTH switches ON.
  const oldShape: ReaderPendingState = {
    reader: R,
    pendingThroughSeq: 0,
    pending: false,
    // gatePending intentionally absent — this IS the pre-#119 state.
  };
  const oldAction = decideWake(oldShape, { wakeable: true }, undefined, true, true);
  assert.equal(oldAction.kind, 'skip', 'pre-#119: an open gate is invisible → skip, ZERO wakes');
});

test('T119.3 switch OFF: the gate is COUNTED, not FIRED, and counts EXACTLY ONE (no over-increment)', async (t) => {
  // C5 for #119. askGate OFF → the gate wake is counted, never fired, and the
  // shadow counter increments EXACTLY once for the one gate — the over-count Q-B3
  // warned the promotion bar would read.
  // MUTANT: gate the gate arm on `wake` instead of `askGate` → with wake ON below
  //   it would FIRE, turning `fired===0` red.
  const db = tmpDb(t);
  const wakes = rig(db, { wake: true, askGate: false, readers: [R] });
  openGate(db, RUN, 'lead', 'ship?', R);

  for (let i = 0; i < 4; i++) await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === R).length, 0, 'askGate OFF: NOTHING fires');
  assert.equal(busWakeCounters().fired, 0);
  assert.equal(busWakeCounters().counted, 1, 'exactly ONE counted — no over-increment beyond the one gate');
});

test('T119.3 an unaddressed gate (recipient NULL) wakes and counts NOBODY, both switches ON', async (t) => {
  // The coexistence-safe default preserved: a gate with no --to matches no reader.
  const db = tmpDb(t);
  const wakes = rig(db, { wake: true, askGate: true, readers: [R, OTHER] });
  openGate(db, RUN, 'lead', 'ship?'); // NO recipient

  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 0, 'an unaddressed gate wakes nobody');
  assert.equal(busWakeCounters().counted, 0, 'and counts nobody — no false divergence');
  assert.equal(busWakeCounters().fired, 0);
});

// ══ T119.4 — `waiting` excluded from staleness (acceptance 3) ════════════════

test('T119.4 an ASKER parked on an open ask is `waiting`; the ANSWERER-silent working member is not', async (t) => {
  // readWaitingReaders is the SENDER/opener side #120 consumes to exclude askers
  // from staleness. The negative control is a member with no open ask/gate — it is
  // NOT waiting, so #120 will treat its silence as staleness.
  // MUTANT: match on `recipient` instead of `sender`/`asked_by` → the asker drops
  //   out of the set and the recipient wrongly enters → both assertions red.
  const db = tmpDb(t);

  const askSeq = send(db, { runId: RUN, sender: ASKER, kind: 'question', body: 'q?', recipient: R });
  openGate(db, RUN, 'lead', 'gate?', R); // 'lead' is the opener → waiting

  const readers = [
    { reader: ASKER, runId: RUN },
    { reader: 'lead', runId: RUN },
    { reader: R, runId: RUN },
    { reader: OTHER, runId: RUN },
  ];
  let waiting = readWaitingReaders(db, readers);
  assert.equal(waiting.has(ASKER), true, 'the asker of an open ask is waiting');
  assert.equal(waiting.has('lead'), true, 'the opener of an open gate is waiting');
  assert.equal(waiting.has(R), false, 'the RECIPIENT is not waiting — it is the one who must answer');
  assert.equal(waiting.has(OTHER), false, 'a member with no open ask/gate is not waiting');

  // Answer the ask → the asker is no longer waiting.
  send(db, {
    runId: RUN,
    sender: R,
    kind: 'status',
    body: 'ship',
    recipient: ASKER,
    threadId: String(askSeq),
  });
  waiting = readWaitingReaders(db, readers);
  assert.equal(waiting.has(ASKER), false, 'an ANSWERED ask no longer marks the asker waiting');
  assert.equal(waiting.has('lead'), true, 'the gate is still open → lead still waiting');

  // Resolve the gate → the opener is no longer waiting either.
  const gateId = readPendingReaders(db, [{ reader: R, runId: RUN }])[0].gateThroughSeq!;
  resolveGate(db, gateId, 'lead', 'ship');
  waiting = readWaitingReaders(db, readers);
  assert.equal(waiting.has('lead'), false, 'a RESOLVED gate no longer marks the opener waiting');
});

test('T119.4 run-scoped: an ask in another run does not mark the asker waiting HERE', async (t) => {
  // Same run-scoping the pending predicate has. Without it, #120 would exclude a
  // genuinely-silent member from staleness because it is waiting in an unrelated
  // run.
  const db = tmpDb(t);
  send(db, { runId: 'some-other-run', sender: ASKER, kind: 'question', body: 'q?', recipient: R });
  const waiting = readWaitingReaders(db, [{ reader: ASKER, runId: RUN }]);
  assert.equal(waiting.has(ASKER), false, 'an ask in another run does not make the asker waiting here');
  // Positive control, same command: scoped to ITS run, the asker IS waiting.
  const there = readWaitingReaders(db, [{ reader: ASKER, runId: 'some-other-run' }]);
  assert.equal(there.has(ASKER), true);
});

// ══ D1 — getBus() null tolerance for the CLI verb path is covered by
//    bus-verbs (describeBusOpenFailure) and the sweep-null arm in
//    bus-wake-sweep.test.ts; the gate/ask additions ride the SAME sweep, so a
//    null bus is already exercised there. This file adds the arm that a gate
//    pending under a null bus does not throw. ═══════════════════════════════════

test('D1 a gate pending under a null bus does not throw into the host path', async (t) => {
  const db = tmpDb(t);
  const wakes = rig(db, { wake: true, askGate: true, readers: [R] });
  openGate(db, RUN, 'lead', 'ship?', R);

  __setBusReaderForTests(() => null);
  await sweepBusWake(); // must not reject
  assert.equal(wakes.length, 0, 'no wake while the bus is down');

  __setBusReaderForTests(() => db);
  await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === R).length, 1, 'the gate wake is not lost — it fires when the bus returns');
});
