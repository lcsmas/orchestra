import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, check, ack, type BusDb } from './bus.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
} from './bus-wake.ts';
import { WAKE_ORDER, isWakeOrder } from '../shared/bus-wake.ts';

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
  setWakeRoster(() => (opts.readers ?? [R1]).map((reader) => ({ reader, wakeable: true })));
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
  assert.equal(wakes[0].text, WAKE_ORDER);
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
  setWakeRoster(() => [{ reader: R1, wakeable: false }]);
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
