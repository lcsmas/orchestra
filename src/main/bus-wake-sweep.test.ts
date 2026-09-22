import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, check, ack, openGate, resolveGate, type BusDb } from './bus.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
  __setNowForTests,
  stopBusWake,
} from './bus-wake.ts';
import { isWakeOrder, wakeOrderRuns, REWAKE_BOUND_MS } from '../shared/bus-wake.ts';

// The SWEEP, driven end to end over a real SQLite bus (#117 acceptance 1-5,
// ledger #123 T117.1-T117.5).
//
// ── What is counted, and why it is not an internal ──────────────────────────
//
// Every arm counts TURNS DELIVERED, captured at the wake-delivery seam — the
// last thing this module does before the reader's session has the order. That
// is the closest observable to "the reader saw a turn" that exists without an
// Electron main process, and it is deliberately NOT the dedup ledger or the
// pending predicate: both are bookkeeping this module's own code writes, so a
// bug in the dedup would move them TOGETHER and every arm would stay green
// (the #112 lesson — count the rendered turn, not an internal the bug touches).
//
// The remaining honest gap: this proves the order is handed to the delivery
// seam, not that a turn RENDERS. `sdkStartAndDeliver` is production-wired at
// index.ts and is exercised by the packaged boot gate, but the rendered-turn
// assertion belongs to the E2E arm, and is listed NOT VERIFIED here.

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-wakesweep-'));
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

const RUN = 'run-S';
const R1 = 'ws-1';

/** Arm the sweep over `db` with a one-reader roster, recording every wake. */
function rig(db: BusDb, opts: { switchOn: boolean; readers?: string[]; deliver?: boolean }) {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => (opts.readers ?? [R1]).map((reader) => ({ reader, wakeable: true, runId: RUN })));
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return opts.deliver ?? true;
  });
  __freezeSwitchForTests(opts.switchOn);
  return wakes;
}

// ── T117.1 — an idle reader is woken, and the switch-off arm is DISTINCT ───

test('T117.1 switch ON: an insert wakes the reader with the ORDER', async (t) => {
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'do the thing', recipient: R1 });

  await sweepBusWake();

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].reader, R1);
  assert.equal(busWakeCounters().fired, 1);
  assert.equal(busWakeCounters().counted, 0);
});

test('T117.1 must-FAIL arm — switch OFF: NO wake, and the counter INCREMENTS', async (t) => {
  // C7. The second assertion is the load-bearing one: `counted === 1` is what
  // distinguishes "the switch suppressed it" from "the feature is not there".
  // Asserting only `wakes.length === 0` passes on a build with no wake code at
  // all, which is exactly the disproof C7 names for itself.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: false });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'do the thing', recipient: R1 });

  await sweepBusWake();

  assert.equal(wakes.length, 0, 'the switch is OFF — nothing may fire');
  assert.equal(busWakeCounters().counted, 1, 'but the would-have-woken IS counted');
  assert.equal(busWakeCounters().fired, 0);
});

// ── T117.5 — the wake carries the ORDER and never the BODY ─────────────────

test('T117.5 the wake carries the order and NOT the message body', async (t) => {
  // Both directions (carry-forward 2): the order must be present AND the body
  // must be absent. A one-directional check passes on a wake that pastes the
  // body in after the order.
  const db = tmpDb(t);
  const BODY = 'SECRET-BODY-c3a91f';
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: BODY, recipient: R1 });

  await sweepBusWake();

  assert.equal(wakes.length, 1);
  const hits = wakes.filter((w) => w.text.includes(BODY)).length;
  assert.equal(hits, 0, 'the body must appear ZERO times in the wake');
  assert.equal(wakes.filter((w) => isWakeOrder(w.text)).length, 1, 'the order appears exactly once');
  // #134 D2: the order NAMES the run to check (own run here) — one `check --run`.
  assert.ok(isWakeOrder(wakes[0].text), 'the wake is a valid run-naming order');
  assert.deepEqual(wakeOrderRuns(wakes[0].text), [RUN], 'and it names the reader run');
});

// ── T117.2 — coalescing: 3 inserts = exactly ONE wake ──────────────────────

test('T117.2 three inserts before the reader checks produce EXACTLY 1 wake', async (t) => {
  // The literal count 1, not "at least one". Three sweeps are driven between
  // the inserts so this also covers the timer firing repeatedly — the shape a
  // real mid-turn window has, where the reader is busy and the sweep keeps
  // running.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });

  for (const body of ['one', 'two', 'three']) {
    send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body, recipient: R1 });
    await sweepBusWake();
  }

  assert.equal(wakes.length, 1, `expected exactly 1 wake, got ${wakes.length}`);
  assert.equal(busWakeCounters().fired, 1);
});

test('T117.2 positive control — the rig CAN record more than one wake', async (t) => {
  // Carry-forward 4. Without this, a recorder that silently dropped every wake
  // after the first would make the arm above pass while proving nothing about
  // the dedup. Two readers with independent pending state must give 2.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true, readers: [R1, 'ws-2'] });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'a', recipient: R1 });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'b', recipient: 'ws-2' });

  await sweepBusWake();

  assert.equal(wakes.length, 2);
  assert.deepEqual(wakes.map((w) => w.reader).sort(), [R1, 'ws-2']);
});

// ── T117.4 — the reader's ack clears pending; no further wake ──────────────

test('T117.4 after the reader ACKS, no further wake arrives', async (t) => {
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });

  await sweepBusWake();
  assert.equal(wakes.length, 1, 'the first wake must actually happen, or the negative is vacuous');

  // The reader obeys: it checks and acks with its OWN ack, as the CLI would.
  const lot = check(db, RUN, R1);
  assert.equal(ack(db, RUN, R1, lot.delivery!.id), true);

  // Bounded drive-until-or-fail, not sleep-then-read: run the sweep a fixed
  // number of times and require the count to stay put across every one.
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'no second wake for a lot the reader already acked');
});

test('T117.4 after an ack, genuinely NEW mail DOES wake again', async (t) => {
  // The other direction. Without it, a bug that simply stopped waking after the
  // first wake would pass the arm above and break the mechanism permanently.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'first', recipient: R1 });
  await sweepBusWake();
  const lot = check(db, RUN, R1);
  ack(db, RUN, R1, lot.delivery!.id);
  await sweepBusWake();
  assert.equal(wakes.length, 1);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'second', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'new mail after an ack must wake');
});

test('#150 F1 CROSS-RUN — acked the woken run, NEW mail in a related run RE-WAKES (real bus)', async (t) => {
  // review-150 F1, through the REAL readPendingReaders + sweepBusWake (the layer
  // the pure suite is structurally blind to: the cross-run cursor SELECTION lives
  // in src/main/bus-wake.ts, not decideWake). The reader's own run is B, nested
  // under A, so A is a RELATED (ancestor) run and exact-recipient mail in A wakes
  // it. Between sweeps the NEWEST pending item flips A→B, so `mailRunId`/`cursorSeq`
  // flip too — the exact input that made the pre-fix single-run compare skip.
  //   MUTANT: in readerAckedThroughLastWake compare `pending.cursorSeq >= …`
  //   (ignore wokeRunId/cursorByRun) → the second wake never arrives → RED.
  const db = tmpDb(t);
  const RUN_A = 'run-A-anc';
  const RUN_B = 'run-B-own';
  const READER = 'ws-crossrun';
  // Two related runs (B child of A). Bare rows are enough — the freeze fn is
  // injected, and getRelatedRunIds only needs the parent edge.
  db.prepare(
    `INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(RUN_A, 'mission', 'lead', null, null, Date.now());
  db.prepare(
    `INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(RUN_B, 'wave', 'ops', RUN_A, null, Date.now());

  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: READER, wakeable: true, runId: RUN_B }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);

  // Sweep 1's NEWEST pending item must sit in run A, so the wake's run (recorded
  // as wokeRunId) is A. A single unacked item in A does that. B gets its (older)
  // mail only AFTER, so between sweeps the newest flips A→B — the run flip the
  // single-run compare is blind to.
  send(db, { runId: RUN_A, sender: 'lead', kind: 'dispatch', body: 'a-1', recipient: READER });

  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake must happen or the negative is vacuous');

  // The reader OBEYS: checks + acks run A (the woken run). Now A has no pending.
  const lotA = check(db, RUN_A, READER);
  assert.equal(ack(db, RUN_A, READER, lotA.delivery!.id), true);

  // NEW mail lands in run B at a HIGHER global seq → sweep 2's mailRunId flips to
  // B, and cursorSeq becomes B's cursor (0 — never acked in B). B's older-nothing
  // means the entry would have pruned; but the reader is STILL pending in B, so the
  // entry survives from A. Pre-fix (single-run compare): 0 (B cursor) >= A's seq →
  // false → SKIP forever (the F1 starvation). Post-fix: reads A's cursor (acked) →
  // re-arm → wake for B's mail.
  send(db, { runId: RUN_B, sender: 'ops', kind: 'dispatch', body: 'b-new', recipient: READER });
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'acked woken run A, newer mail in run B → must RE-WAKE (F1)');
});

// ── T117.3 — level-triggered: the sweep alone reconciles durable state ─────

test('T117.3 a sweep with NO prior event still fires for an insert it never saw', async (t) => {
  // This is the level-triggered proof at unit level: the insert lands with no
  // watcher armed and no sweep running — the state a crash between insert and
  // wake leaves behind — and the very first sweep afterwards fires. An
  // edge-triggered design (watch event -> wake) passes every other arm in this
  // file and fails exactly here.
  const db = tmpDb(t);
  // Insert BEFORE the rig exists, so nothing could have observed the write.
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'pre-crash', recipient: R1 });
  const wakes = rig(db, { switchOn: true });

  await sweepBusWake();

  assert.equal(wakes.length, 1, 'the sweep must reconcile state it never saw arrive');
});

// ── D1 — getBus() === null must not throw, and must not lose the wake ──────

test('D1 a null bus is tolerated, and the wake is NOT lost — the next sweep fires it', async (t) => {
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });

  // Bus down: must not throw into the host path, and must not fire.
  __setBusReaderForTests(() => null);
  await sweepBusWake(); // would reject if it threw — the test awaits it
  assert.equal(wakes.length, 0);

  // Bus back: nothing was lost, because nothing was stored in an event.
  __setBusReaderForTests(() => db);
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'a bus that comes back is not a bus that dropped anything');
});

// ── A failed delivery is not a silent success ──────────────────────────────

test('a wake the delivery seam REFUSES is counted failed and RETRIED', async (t) => {
  // `sdkStartAndDeliver` returns false (never throws) when the SDK module has
  // not registered or the start failed. Treating that as success would mark the
  // ledger and suppress every future wake for this lot — a permanent silent
  // loss whose only symptom is a reader that never hears anything again.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true, deliver: false });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });

  await sweepBusWake();
  assert.equal(wakes.length, 1, 'it was attempted');
  assert.equal(busWakeCounters().fired, 0, 'but not fired');
  assert.equal(busWakeCounters().failed, 1);

  // The retry is the point: the ledger entry must have been withdrawn.
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'a failed wake is retried on the next sweep');
});

// ── An unwakeable reader ───────────────────────────────────────────────────

test('an archived (unwakeable) reader is never woken, even with pending mail', async (t) => {
  const db = tmpDb(t);
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: false, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });

  await sweepBusWake();

  assert.equal(wakes.length, 0);
  assert.equal(busWakeCounters().fired, 0);
});

// ── Q1: the switch is frozen PER RUN, and two runs can differ ──────────────

test('Q1 two runs in ONE process: run A OFF only COUNTS, run B ON FIRES', async (t) => {
  // THE ARM ONE BOOT-SCOPED BOOLEAN CANNOT PASS. Every gate in this ticket
  // exercises a single run, so a single cached flag answers all of them
  // correctly; the defect is not in any clause a mutant could delete, it is in
  // WHICH EVENT the value binds to (boot, vs the run being swept).
  //
  // Both readers have pending mail in the same sweep. The switch says OFF for
  // run A and ON for run B, so the correct behaviour is: exactly one turn, for
  // B's reader, and exactly one counted, for A's.
  const db = tmpDb(t);
  const RUN_OFF = 'run-A-off';
  const RUN_ON = 'run-B-on';
  const READER_OFF = 'ws-in-run-A';
  const READER_ON = 'ws-in-run-B';

  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [
    { reader: READER_OFF, wakeable: true, runId: RUN_OFF },
    { reader: READER_ON, wakeable: true, runId: RUN_ON },
  ]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests((runId: string) => runId === RUN_ON);

  send(db, { runId: RUN_OFF, sender: 'ops', kind: 'dispatch', body: 'a', recipient: READER_OFF });
  send(db, { runId: RUN_ON, sender: 'ops', kind: 'dispatch', body: 'b', recipient: READER_ON });

  await sweepBusWake();

  assert.deepEqual(wakes.map((w) => w.reader), [READER_ON], 'only the ON run fires');
  assert.equal(busWakeCounters().fired, 1);
  assert.equal(busWakeCounters().counted, 1, "the OFF run's wake is counted, not fired");
});

test('Q1 an app RESTART does not change a running run\'s frozen flags', async (t) => {
  // The freeze lives in the STORAGE (#118 writes the flags onto the run row when
  // the run starts), not in this process's uptime. So a restart mid-run must
  // re-read the same row and behave identically — which is only expressible
  // because the switch is read per sweep from the run rather than cached at boot.
  //
  // Simulated as: full teardown + re-arm (a new "process"), with the run row's
  // answer unchanged. The reader must still only be COUNTED, never fired.
  const db = tmpDb(t);
  const RUN_OFF = 'run-frozen-off';
  const wakes: { reader: string; text: string }[] = [];
  const rowSaysOff = (runId: string) => runId !== RUN_OFF; // OFF for our run

  const arm = () => {
    __setBusReaderForTests(() => db);
    setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN_OFF }]);
    setWakeDeliver(async (reader, text) => {
      wakes.push({ reader, text });
      return true;
    });
    __freezeSwitchForTests(rowSaysOff);
  };

  __resetBusWakeForTests();
  arm();
  send(db, { runId: RUN_OFF, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 0);
  assert.equal(busWakeCounters().counted, 1);

  // ── "restart": tear the whole subsystem down and bring it back up ──
  stopBusWake();
  __resetBusWakeForTests();
  arm();

  await sweepBusWake();
  assert.equal(wakes.length, 0, "the running run's flag survived the restart — still OFF");
  assert.equal(busWakeCounters().counted, 1, 'and it is still COUNTED, not silently skipped');
});

test('#118-F1 blast radius: a mid-wave switch flip is read per-sweep, never latched', async (t) => {
  // #118-F1 (ledger #123): #118's freeze storage could let a run be frozen LATE
  // and its wake flag flip mid-wave. The freeze fix is #118's; THIS asserts my
  // CONSUMPTION is correct no matter what the stored flag does — read per sweep,
  // never a boot cache, and a transient flip cannot spam a reader already handled.
  //
  // A boot-scoped cache cannot pass the FIRE half below: cached OFF would count
  // forever even after the row says ON. A per-sweep read fires the moment the
  // flag reads ON for a re-armed reader — and only then.
  const db = tmpDb(t);
  let flag = false; // the run row's wake flag, as #118 would (mis)mutate it
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests((runId: string) => runId === RUN && flag);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'flag OFF: counted, not fired');
  assert.equal(busWakeCounters().counted, 1);

  // OPTION A (LEAD ruling GATE-1, ledger D-C5-2, #153): the flag flips ON while the
  // reader is still mid-pending-window (never acked). A COUNTED reader was NEVER
  // delivered a wake, so the ON-sweep MUST fire it ONCE — it has real pending mail
  // nobody handed over. DISPROOF: the pre-#153 assertion here was `wakes.length===0`
  // ("do not re-fire an already-handled reader"), which encoded count==fire in ONE
  // ledger — the exact canary-4 F-C4-1 starvation #153 removes (a counted reader is
  // not a handled reader). It fires exactly ONCE: the fire records wokeLotSeq, so the
  // ack-based re-arm keeps the dedup at one wake across every subsequent sweep.
  flag = true;
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'OFF→ON flip delivers the ONE wake OFF suppressed (Option A)');
  assert.equal(busWakeCounters().fired, 1, 'fired exactly once — not per sweep (wokeLotSeq dedups)');

  // The DISCRIMINATING half a boot-OFF cache cannot pass: the reader acks, a
  // sweep observes the cleared pending state and prunes the ledger entry (the
  // only re-arm — level-triggered, see decideWake), new mail arrives, and NOW
  // the flag reads ON — so the next sweep FIRES again for the fresh lot.
  const lot = check(db, RUN, R1);
  ack(db, RUN, R1, lot.delivery!.id);
  await sweepBusWake(); // the reconciling sweep that prunes the ledger after ack
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'more', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'per-sweep read: a re-armed reader fires again for new mail while ON');
  assert.equal(busWakeCounters().fired, 2);

  // And the inverse latch: flip back OFF with the reader re-armed, new mail →
  // counted again, never a fire left latched from the previous ON.
  flag = false;
  const lot2 = check(db, RUN, R1);
  ack(db, RUN, R1, lot2.delivery!.id);
  await sweepBusWake(); // reconcile again before the next lot
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'off-again', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'flag OFF again: no further fire — the ON was not latched');
  assert.equal(busWakeCounters().counted, 2);
});

test('#153 acceptance 1b (Option A, LEAD D-C5-2): counted through N, flip ON, NO ack + NO new mail → exactly 1 wake', async (t) => {
  // The Option-A must-FAIL arm: a counted reader with pending-through-N, on the
  // OFF→ON flip, must be delivered the ONE wake OFF suppressed — even with NO new
  // mail and NO ack. Pre-fix (count writes the fire ledger) the reader's fire-dedup
  // entry is already at N and the ack-based re-arm can never fire (cursor 0 < N), so
  // it stays SKIPPED across ≥3 ON-sweeps = the live starvation. Post-fix the fire
  // ledger is EMPTY for a counted reader, so the flip fires ONCE and then dedups.
  //   MUTANT (revert): count writes the FIRE ledger → 0 wakes here across 3 sweeps.
  const db = tmpDb(t);
  let wakeOn = false;
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests((runId: string) => runId === RUN && wakeOn);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'through-N', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'OFF: counted, not fired');
  assert.equal(busWakeCounters().counted, 1);

  // Flip ON. NO ack, NO new mail — the exact case the ruling names.
  wakeOn = true;
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'counted reader gets its ONE suppressed wake on the flip (pre-fix: 0)');
  assert.equal(busWakeCounters().fired, 1, 'and exactly once across 3 sweeps — wokeLotSeq dedups');
  assert.ok(isWakeOrder(wakes[0].text));
  assert.deepEqual(wakeOrderRuns(wakes[0].text), [RUN]);
});

// ── #153 — a switch-OFF COUNT must NOT arm the FIRE dedup ───────────────────
//
// The live repro (canary-4, ledger #152 F-C4-1): a boot sweep with wake OFF
// COUNTS a pending reader and — pre-fix — records the fire-dedup high-water as if
// it had really woken. After a mid-process OFF→ON flip the counted reader was
// never delivered a wake, never acked, so its cursor never reaches that mark and
// the ack-based re-arm (#150 F1) can never fire: every ON-sweep skips it
// `already-woken`. New mail lands and the reader sleeps forever (the C5 shape).

test('#153 acceptance 1: counted under OFF, flip ON + NEW mail → FIRES the full pending (real bus)', async (t) => {
  // The load-bearing arm. Pre-fix (count writes the fire ledger): the reader is
  // counted at seq N; the flip-ON sweep with new mail at seq M>N reads
  // lotAxisReArmed = cursor(0) >= N → false → SKIP already-woken across every
  // later sweep — the exact live starvation. Post-fix (separate count ledger):
  // the fire ledger is EMPTY for a counted reader, so the first ON-sweep fires
  // through the full pending.
  //   MUTANT (revert the fix): move ledger.set back before the count branch, or
  //   feed decideWake the count entry as `previousFire` → this arm goes RED.
  const db = tmpDb(t);
  let wakeOn = false; // the run row's wake flag; flips ON mid-process
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests((runId: string) => runId === RUN && wakeOn);

  // Boot sweep: switch OFF, reader pending → COUNTED, not fired.
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'boot-mail', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'switch OFF at boot: nothing fires');
  assert.equal(busWakeCounters().counted, 1, 'but the would-have-woken is counted');

  // Mid-process OFF→ON flip (delivery+wake turned ON by the operator, run frozen ON).
  wakeOn = true;

  // Drive ≥3 sweeps with NO new mail first — this is the pre-fix "skipped across
  // ≥3 sweeps" repro window. (Under contract A a same-seq flip may fire; this arm
  // does not assert on that — it asserts the NEW-mail case below, which BOTH
  // contracts require to fire.)
  for (let i = 0; i < 3; i++) await sweepBusWake();

  // NEW mail arrives at a HIGHER seq — the live 764→784 transition. The reader was
  // NEVER delivered a wake, so this MUST fire a real wake through the full pending.
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'new-mail-784', recipient: R1 });
  for (let i = 0; i < 3; i++) await sweepBusWake();

  const firedToR1 = wakes.filter((w) => w.reader === R1);
  assert.ok(firedToR1.length >= 1, 'after OFF→ON + new mail the reader MUST be woken (F-C4-1)');
  assert.equal(busWakeCounters().fired, firedToR1.length, 'and the fired counter matches');
  // The wake is a real order naming the run.
  assert.ok(isWakeOrder(firedToR1[0].text), 'the delivered wake is a valid run-naming order');
  assert.deepEqual(wakeOrderRuns(firedToR1[0].text), [RUN]);
});

test('#153 acceptance 2: steady-state ON dedup unchanged — woken through N, no ack/no new mail → not re-woken', async (t) => {
  // The count ledger must not weaken the FIRE dedup. Always ON: one wake, then
  // silence until an ack or new mail — exactly T117.2's guarantee, re-asserted to
  // prove the two-ledger split did not open a fire-storm.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'the first wake fires');

  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'no ack, no new mail → not re-woken (fire dedup intact)');
  assert.equal(busWakeCounters().fired, 1);
});

test('#153 acceptance 3: counting mode still COUNTS and still does NOT deliver, and dedups vs counts', async (t) => {
  // Shadow metrics keep working: a pending reader under OFF counts ONCE (not once
  // per sweep — the count ledger dedups counts against counts) and fires nothing.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: false });
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'shadow', recipient: R1 });

  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 0, 'switch OFF: nothing is ever delivered');
  assert.equal(busWakeCounters().fired, 0);
  assert.equal(busWakeCounters().counted, 1, 'counted exactly once across 5 sweeps (counts dedup vs counts)');

  // NEW mail under OFF re-arms the count (the shadow signal tracks fresh events).
  const lot = check(db, RUN, R1);
  ack(db, RUN, R1, lot.delivery!.id);
  await sweepBusWake(); // reconcile: pending cleared → count ledger prunes
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'shadow-2', recipient: R1 });
  await sweepBusWake();
  assert.equal(busWakeCounters().counted, 2, 'new mail after ack counts again (shadow keeps measuring)');
  assert.equal(wakes.length, 0, 'and still nothing fired');
});

test('a reader is NOT woken for mail in a run it does not belong to', async (t) => {
  // Run-scoping of the PENDING PREDICATE, which the per-run switch depends on.
  // Unscoped, this reader is reported pending for another run's traffic and gets
  // ordered to `orchestra check` — which, scoped to ITS run by the CLI, returns
  // an empty lot. Nothing is acked, pending never clears, and the reader is
  // woken again every sweep: a permanent loop whose only symptom is an agent
  // repeatedly told to check an empty mailbox.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  send(db, { runId: 'some-other-run', sender: 'ops', kind: 'dispatch', body: 'not yours', recipient: R1 });

  await sweepBusWake();
  assert.equal(wakes.length, 0, 'another run\'s mail must not wake this reader');

  // Positive control, same command: mail in the reader's OWN run does wake it,
  // so the zero above is a scoping decision and not a dead rig.
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'yours', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1);
});

test('a switch accessor that THROWS is treated as OFF, and does not kill the sweep', async (t) => {
  // COVERS: the `let switchOn = false` initialiser guarding the try/catch.
  // MUTANT: initialise it to `true` → red here.
  // WHY IT MATTERS: the accessor is #118's code reached through a seam. If it
  // throws, the two wrong answers are opposite and unequal: defaulting ON fires
  // real wakes on a flag nobody could read (a coexistence violation, and the
  // standing ruling's exact prohibition), while an unguarded throw takes the
  // whole sweep down for every OTHER reader too. Safe direction is OFF, counted.
  // (Caught by mutation: this initialiser survived its first mutant.)
  const db = tmpDb(t);
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [
    { reader: R1, wakeable: true, runId: RUN },
    { reader: 'ws-2', wakeable: true, runId: 'run-ok' },
  ]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests((runId: string) => {
    if (runId === RUN) throw new Error('#118 switch storage unavailable');
    return true;
  });

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'a', recipient: R1 });
  send(db, { runId: 'run-ok', sender: 'ops', kind: 'dispatch', body: 'b', recipient: 'ws-2' });

  await sweepBusWake();

  assert.equal(
    wakes.filter((w) => w.reader === R1).length,
    0,
    'an unreadable flag must NOT fire — OFF is the safe direction',
  );
  assert.equal(busWakeCounters().counted, 1, 'it is COUNTED, not silently dropped');
  // The sweep survived: the OTHER reader, whose switch reads fine, still fired.
  assert.equal(
    wakes.filter((w) => w.reader === 'ws-2').length,
    1,
    'one reader\'s broken switch must not take the whole sweep down',
  );
});

test('D2 must-FAIL arm — an open GATE fires 0 wakes AND counts 0 (ledger #123 Q-B3)', async (t) => {
  // LEAD §Decisions D2: gate-driven wakes are dropped from #117 (they move to
  // #119). Asserted at the SWEEP with the switch ON, because a gate must be
  // invisible to the WHOLE mechanism, not just the predicate: 0 fired AND
  // 0 counted. The counter half is load-bearing — a gate that merely didn't fire
  // but still COUNTED would feed a false divergence into the promotion bar (the
  // exact over-count Q-B3 raised).
  // MUTANT: restore the `decision_gates` half of readPendingReaders → this arm
  //   fires 1 (switch ON) and the OFF variant would count 1 → red.
  const db = tmpDb(t);
  const wakes = rig(db, { switchOn: true });
  openGate(db, RUN, 'ws-asker', 'ship it?'); // a gate addressed at the run, not R1
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'an open gate must fire NO wake (D2 — check cannot surface a gate)');
  assert.equal(busWakeCounters().counted, 0, 'and it must NOT be counted — no false divergence to the promotion bar');
  assert.equal(busWakeCounters().fired, 0);

  // Positive control, same command: a QUESTION message the order CAN surface
  // DOES wake — so the zeros above are D2 in force, not a dead sweep.
  send(db, { runId: RUN, sender: 'ws-asker', kind: 'question', body: 'still?', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'a question message addressed to the reader still wakes');
  assert.equal(busWakeCounters().fired, 1);
});

test('D-H1 GATE AXIS re-wake — gate 1 woken, reads-not-resolves, gate 2 opens → RE-WAKES (real bus)', async (t) => {
  // The D-H1 must-FAIL arm through the REAL readPendingReaders + sweepBusWake. A
  // reader is woken for an addressed gate; it reads but does NOT resolve; a SECOND
  // addressed gate opens → the gate high-water rises → a fresh wake is owed. This
  // is the C5 starvation class on the GATE axis (askGate/P3 will ride it).
  //   MUTANT: single-axis `if (previous) skip` (or the gatePending EXCLUSION) →
  //   sweep after the 2nd gate SKIPS → no 2nd wake → RED.
  const db = tmpDb(t);
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  // wake OFF, askGate ON: the gate axis FIRES; the lot axis is irrelevant here.
  __freezeSwitchForTests(false, true);

  // Gate 1 addressed TO the reader (recipient R1) → gatePending.
  openGate(db, RUN, 'ws-asker', 'ship gate 1?', R1);
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'the first gate wake must happen, or the negative is vacuous');

  // The reader reads but does NOT resolve gate 1 (it stays open). A SECOND gate
  // opens, also addressed to R1 → the max open gate id (gateThroughSeq) rises.
  openGate(db, RUN, 'ws-asker', 'ship gate 2?', R1);
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'a new gate opened → the gate axis must RE-WAKE (D-H1)');

  // Dedup: no further gate → no third wake.
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'no new gate → no further wake, gate-axis dedup holds');
});

test('D-H1 rider — a re-armed gate under askGate OFF is COUNTED (real bus, not skip-before-count)', async (t) => {
  // review-150's counter finding, closed end to end: pre-fix the re-armed gate hit
  // `skip` BEFORE the count branch, so the OFF-state shadow counter undercounted
  // re-armed gates. With askGate OFF a gate whose high-water rose must COUNT.
  const db = tmpDb(t);
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(false, false); // BOTH OFF — the shadow state canary 4 measures

  openGate(db, RUN, 'ws-asker', 'gate 1?', R1);
  await sweepBusWake();
  assert.equal(busWakeCounters().counted, 1, 'first gate wake counted (askGate OFF)');
  assert.equal(wakes.length, 0, 'and nothing fired');

  openGate(db, RUN, 'ws-asker', 'gate 2?', R1); // new gate → axis rises
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(busWakeCounters().counted, 2, 'the RE-ARMED gate is COUNTED, not skipped (rider)');
  assert.equal(busWakeCounters().fired, 0);
});

// ── #183 D1 — the BOUNDED level-triggered re-wake (the fleet-stopper) ────────
//
// Field: THREE latches in one evening (4h/6h/14h) against HEALTHY active sessions
// whose turns were not wake-driven — they consumed one wake, never ran check/ack
// for that run, and neither the LOT axis (re-arms on ACK) nor the GATE axis
// (re-arms on a NEW gate) could ever re-fire. The class-wide backstop: a reader
// latched `already-woken` whose pending has not cleared re-fires after
// REWAKE_BOUND_MS, level-triggered. Every arm drives the injectable sweep clock
// (`__setNowForTests`) so the 5-min bound is exercised without a real wait, and
// counts TURNS DELIVERED at the seam (never an internal the bug also moves).

/** A clock a test advances by hand. Returns a getter + a `set(ms)` mutator. */
function fakeClock(startMs = 1_000_000_000_000) {
  let t = startMs;
  return {
    now: () => t,
    set: (ms: number) => {
      t = ms;
    },
    advance: (deltaMs: number) => {
      t += deltaMs;
    },
    get value() {
      return t;
    },
  };
}

test('#183 D5 field-replay — lot woken once, reader NEVER acks → NO re-wake until the bound, then RE-WAKES', async (t) => {
  // The incident, replayed: a reader woken for a lot whose turns are not
  // wake-driven (never runs check/ack for this run). On CURRENT code the latch
  // holds FOREVER (the lot axis re-arms only on ack, which never comes). With the
  // fix, the reader re-wakes once REWAKE_BOUND_MS elapses.
  //   MUTANT (sever the D1 bound): `boundedReArmed` → `return false` → this arm
  //   stalls at 1 wake forever → RED.
  const db = tmpDb(t);
  const clock = fakeClock();
  const wakes = rig(db, { switchOn: true });
  __setNowForTests(clock.now);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'order 1', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake fires (else the latch below is vacuous — #90 barrier)');

  // The reader does NOT ack. Sweeps within the bound must NOT re-fire: this is the
  // fast-path dedup holding — an outstanding order on an un-advanced axis is not
  // re-issued. THIS is the "latched already-woken at trigger" assertion the #90
  // barrier lesson requires: prove the reader is stuck BEFORE the bound trigger.
  clock.advance(REWAKE_BOUND_MS - 1_000); // just under 5 min
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'ARMED STATE: within the bound and un-acked, the reader is latched already-woken — NO re-wake');

  // The bound elapses. LEVEL-TRIGGERED: the next sweep re-fires the still-pending lot.
  clock.advance(2_000); // now past REWAKE_BOUND_MS since the last wake
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'past the bound with pending un-acked → the D1 backstop RE-WAKES');
  assert.ok(isWakeOrder(wakes[1].text), 'the re-wake is a valid run-naming order, not a body');

  // And it does not storm: the re-fire reset the clock, so the immediate next
  // sweeps (still within the fresh bound) do NOT double-fire.
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'the re-fire reset the clock — no storm within the fresh bound');
});

test('#183 healthy cycle — a reader that ACKS re-arms via the CURSOR (fast path), the bound NEVER double-fires', async (t) => {
  // The fast-path dedup preserved (D1): a reader woken, then acking, re-arms
  // immediately on the CURSOR — long before REWAKE_BOUND_MS. The bound must add NO
  // extra fire on a healthy check+ack cycle. A single wake per lot, no double.
  //   This arm reddens on the CURSOR/prune re-arm regressing, NOT on the bound: an
  //   acked+drained lot is PRUNED from the ledger, so decideWake sees no latch and
  //   the bound block is never reached — a bound-fires-unconditionally mutant stays
  //   GREEN here. That mutant is caught by arm25's "no storm within the fresh bound"
  //   assertion, not this one.
  const db = tmpDb(t);
  const clock = fakeClock();
  const wakes = rig(db, { switchOn: true });
  __setNowForTests(clock.now);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'lot A', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake');

  // The reader OBEYS: check + ack, WITHIN the bound. Its cursor advances past the
  // woken lot — the lot axis re-arm, not the time bound. No NEW mail, so the entry
  // prunes and the reader is idle.
  clock.advance(10_000); // 10s — well under the bound
  const lot = check(db, RUN, R1);
  assert.ok(lot.delivery, 'the reader has a lot to ack');
  ack(db, RUN, R1, lot.delivery!.id);

  // Sweeps for well past the bound: nothing pending, so nothing fires — the bound
  // must not resurrect an ACKED, drained lot.
  clock.advance(REWAKE_BOUND_MS * 2);
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'acked+drained → the bound adds NO second wake (fast path preserved)');
  assert.equal(busWakeCounters().fired, 1, 'exactly one fire across the whole healthy cycle');

  // NEW mail after the ack still wakes ONCE, on the cursor re-arm — the bound is
  // not needed for the healthy path and does not add a duplicate.
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'lot B', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'new mail after ack re-wakes once (cursor re-arm, within the bound)');
});

test('#183 gate axis — a pending decision_gate re-wakes until RESOLVED (the #119 promise, via the bound)', async (t) => {
  // The gate half of the field incident: an open decision_gate addressed to the
  // reader (seq 1407 in the field), woken once, the reader reads but never
  // resolves and never opens a new gate → the gate axis (re-arms only on a NEW
  // gate) can never re-fire. The D1 bound is what re-wakes a STILL-OPEN gate
  // every REWAKE_BOUND_MS until it is resolved — closing the #119 promise the
  // field broke.
  //   MUTANT (sever the gate arm of the bound: force the gate branch off in the
  //   bounded block, e.g. `gateFires = false` there / drop `gatePending`): the
  //   still-open gate never re-wakes past the bound → RED, while the lot D5 arm
  //   stays green.
  const db = tmpDb(t);
  const clock = fakeClock();
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(false, true); // wake OFF, askGate ON — the gate axis is what's under test
  __setNowForTests(clock.now);

  const gateId = openGate(db, RUN, 'ws-asker', 'ship gate 1407?', R1);
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first gate wake fires (else the latch is vacuous — #90 barrier)');

  // The reader reads the gate but does NOT resolve it, and opens NO new gate.
  // Within the bound: no new gate → the gate axis is dead → latched already-woken.
  clock.advance(REWAKE_BOUND_MS - 1_000);
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'ARMED STATE: gate still open, no new gate, within the bound → latched already-woken');

  // Past the bound: the still-open gate re-wakes (the #119 promise, via D1).
  clock.advance(2_000);
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'past the bound with the gate STILL OPEN → RE-WAKES (the #119 promise)');

  // RESOLVE the gate. It drops out of pending, prunes, and never re-wakes again —
  // the bound is bounded by resolution, not an eternal alarm.
  resolveGate(db, gateId, 'ws-asker', 'shipped');
  clock.advance(REWAKE_BOUND_MS * 2);
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'a RESOLVED gate is no longer pending → the bound stops (no eternal alarm)');
});

test('#185 ask-storm — an OBEYED (acked) unanswered question does NOT storm past the bound (real bus)', async (t) => {
  // The live #185 repro at the sweep: a `question` addressed to the reader is
  // answer-based (`reWakeUntilAnswered`). The reader is woken, OBEYS the order (runs
  // check + ack → cursor advances past the ask), but never ANSWERS. Once obeyed, a
  // re-`check` order is a no-op the reader cannot silence — pre-#185 the #183 bound
  // re-fired it every REWAKE_BOUND_MS FOREVER (the 5-min storm: field cursor 1688 >=
  // ask 1458). The revalidated bound must NOT re-fire an obeyed ask.
  //   MUTANT (drop the `askObeyed` revalidation → re-fire the ask regardless): the
  //   sweep past the bound fires again and again → RED (storm). The mirror arm below
  //   and the #183 D5 lot arm both stay green.
  const db = tmpDb(t);
  const clock = fakeClock();
  const wakes = rig(db, { switchOn: true }); // wake ON — questions ride the wake switch
  __setNowForTests(clock.now);

  send(db, { runId: RUN, sender: 'ws-asker', kind: 'question', body: 'Q4?', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake fires (else the latch below is vacuous — #90 barrier)');

  // The reader OBEYS: check + ack (cursor advances past the ask), but does NOT
  // answer. The ack triggers the ask's own `cursorAtWake` re-arm exactly ONCE (the
  // #119 "read-without-answer re-wakes once" promise), so a single extra wake here
  // is EXPECTED and correct. After that its cursor is stable at the ask seq.
  const lot = check(db, RUN, R1);
  assert.ok(lot.delivery, 'the reader has the question to ack');
  ack(db, RUN, R1, lot.delivery!.id);
  clock.advance(1_000);
  await sweepBusWake();
  const afterObey = wakes.length; // 2 (initial + the one cursorAtWake re-arm)
  assert.ok(afterObey <= 2, 'obeying re-wakes at most once (the #119 cursor-advance re-arm)');

  // Now the reader is OBEYED (cursor >= ask seq) and stops acking. PAST the bound,
  // many sweeps: the revalidated bound must NOT re-fire — the storm is silenced.
  clock.advance(REWAKE_BOUND_MS * 6);
  for (let i = 0; i < 6; i++) await sweepBusWake();
  assert.equal(wakes.length, afterObey, '#185: an OBEYED unanswered ask is NOT re-fired by the #183 bound (no storm)');
});

test('#185 MIRROR — a NEVER-acking (unobeyed) unanswered question STILL re-wakes past the bound (no pre-#183 silent latch)', async (t) => {
  // LEAD's blocking mirror question, at the sweep: excluding the ask axis outright
  // would re-latch a reader that never runs check/ack — the pre-#183 defect (both
  // ask re-arms fail: `cursorAtWake` needs an ack that never comes; prune-on-clear
  // needs an answer that never comes). REVALIDATE, don't exclude: an UNOBEYED ask
  // (cursor < ask seq) STILL rides the #183 bound.
  //   MUTANT (exclude the ask axis instead of revalidating): the never-acking reader
  //   never re-wakes → stalls at 1 → RED (the reintroduced silent latch).
  const db = tmpDb(t);
  const clock = fakeClock();
  const wakes = rig(db, { switchOn: true });
  __setNowForTests(clock.now);

  send(db, { runId: RUN, sender: 'ws-asker', kind: 'question', body: 'Q?', recipient: R1 });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake fires (else the latch is vacuous — #90 barrier)');

  // The reader NEVER acks and NEVER answers (cursor stays 0 < ask seq). Within the
  // bound: latched. Past the bound: the bound RE-WAKES (the genuinely-stuck ask).
  clock.advance(REWAKE_BOUND_MS - 1_000);
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'ARMED STATE: unobeyed ask within the bound → latched already-woken');

  clock.advance(2_000);
  await sweepBusWake();
  assert.equal(wakes.length, 2, '#185 mirror: past the bound an UNOBEYED ask RE-WAKES (no silent latch)');
  assert.ok(isWakeOrder(wakes[1].text), 'the re-wake is a valid run-naming order');

  // And it does not storm within the fresh bound (the re-fire reset the clock).
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'the re-fire reset the clock — no storm within the fresh bound');
});

test('#185 co-pending — an un-acked LOT in a related run is NOT starved by an obeyed newer ask (real bus)', async (t) => {
  // review-185's cross-run gap, end to end: reader R has an un-acked ordinary LOT in
  // a DESCENDANT run B (older seq) AND an unanswered ask in its own run A (newer
  // seq). R obeys the ask (check+ack run A) but leaves the run-B lot un-acked and
  // never answers. Per-run cursors mean the run-B lot genuinely stays pending; a
  // cursor-vs-max-only discriminator would drop the bound and STARVE it (measured:
  // the lot stayed pending forever with no re-wake). The fix keeps the bound while
  // an un-acked lot exists → R is re-woken for run B past the bound.
  //   MUTANT (drop the `hasUnackedLot` term): the run-B lot never re-wakes → RED.
  const db = tmpDb(t);
  const RUNA = 'run-A185', RUNB = 'run-B185', R = 'ws-cop';
  db.prepare(
    'INSERT INTO runs (id,kind,coordinator,parent_run_id,created_at,coordinator_generation) VALUES (?,?,?,?,?,0)',
  ).run(RUNA, 'mission', R, null, 1);
  db.prepare(
    'INSERT INTO runs (id,kind,coordinator,parent_run_id,created_at,coordinator_generation) VALUES (?,?,?,?,?,0)',
  ).run(RUNB, 'vague', 'wkr', RUNA, 2);
  const clock = fakeClock();
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R, wakeable: true, runId: RUNA }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);
  __setNowForTests(clock.now);

  // LOT in run B (older), then ASK in run A (newer). Both pend for R (B is related).
  send(db, { runId: RUNB, sender: 'wkr', kind: 'dispatch', body: 'LOT-B', recipient: R });
  send(db, { runId: RUNA, sender: 'asker', kind: 'question', body: 'ASK-A?', recipient: R });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake fires (barrier)');

  // R OBEYS only the ask in run A: check + ack run A (cursor A past the ask). The
  // ack triggers the ask's one-shot cursorAtWake re-arm (expected). Leaves LOT-B.
  const lotA = check(db, RUNA, R);
  assert.ok(lotA.delivery, 'the reader has run-A mail to ack');
  ack(db, RUNA, R, lotA.delivery!.id);
  clock.advance(1_000);
  await sweepBusWake();
  const afterObey = wakes.length; // 2 (initial + one cursorAtWake re-arm naming both runs)

  // R does NOT ack run B and does NOT answer. Past the bound: the un-acked run-B lot
  // MUST re-wake (it is cursor-clearable and genuinely unobeyed) — no starvation.
  clock.advance(REWAKE_BOUND_MS * 2);
  await sweepBusWake();
  assert.ok(wakes.length > afterObey, '#185: the un-acked run-B lot RE-WAKES past the bound (not starved)');
  // And the re-wake order names run B (where the lot sits).
  const last = wakes[wakes.length - 1];
  assert.ok(wakeOrderRuns(last.text).includes(RUNB), 'the re-wake order names the run-B lot');
});
