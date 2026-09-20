import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, type BusDb } from './bus.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  rollbackWakeForWithdrawnOrder,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
  __peekWakeLedgerForTests,
  type WakeableReader,
} from './bus-wake.ts';
import { isWakeOrder, wakeOrderRuns } from '../shared/bus-wake.ts';

// #172 — a bus wake whose QUEUED turn is WITHDRAWN unstarted (delivery timeout /
// #90 wedge / tray cancel / Escape / session-end) still marked the FIRE ledger
// woken, so the reader STARVED on `already-woken` with zero served turns. The
// sweep marks the ledger BEFORE `deliverWake` resolves, and that resolve is the
// QUEUE PUSH, not the turn START (#57: 'live' means the turn started). Fix: on
// withdrawal of a wake-order turn (agent-sdk.ts), roll back the ledger mark so the
// next sweep RE-fires — bounded by the WITHDRAWAL event, not by sweeps.
//
// ── What these arms drive, and where the SEAM is ────────────────────────────
//
// The withdrawal itself happens in agent-sdk.ts (`session.queue`), which is
// un-importable under the strip-types runner (`./platform` dir-import). The
// rollback it performs is `rollbackWakeForWithdrawnOrder` (src/main/bus-wake.ts),
// which IS importable and owns the ledger — so agent-sdk calls ONE implementation
// these arms drive directly (the #132/#162 pattern: the test never re-implements
// the rule it certifies; agent-sdk's `rollbackWakeIfOrderWithdrawn` is a thin
// `isWakeOrder`-gate over this exact call). The withdrawal is simulated by calling
// it after a REAL sweep marked the ledger over a REAL on-disk SQLite bus.
//
// The observable is the DELIVERED WAKE captured at the delivery seam AND the
// ledger mark read through `__peekWakeLedgerForTests` — not an internal the dedup
// bug would move in lockstep (#112 lesson). The starvation case is driven with NO
// ack and NO new mail: the ONLY thing that lets the next sweep re-fire is the
// rollback un-marking the ledger, so a mutant that skips the rollback stays
// `already-woken` across ≥3 sweeps (arm 1), which is the exact live repro.
//
// FS note: temp bus on $HOME (btrfs, same FS as prod, contract rule 4). No arm
// here depends on WAL inode behaviour (no fs.watch), so this rig is substrate-
// independent — the $HOME pin is convention-parity with the sibling bus tests.

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const base = process.env.HOME || os.homedir();
  const dir = fs.mkdtempSync(path.join(base, '.orchestra-wake-withdrawal-test-'));
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

/** Insert a bare `runs` row so `getRelatedRunIds` sees its tree edge. */
function insertRun(db: BusDb, id: string, parent: string | null): void {
  db.prepare(
    `INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(id, parent ? 'wave' : 'mission', 'x', parent, null, Date.now());
}

const READER = 'ws-woken';
const RUN = 'run-1';

/** Arm the sweep recording every delivered wake, switch frozen ON (wave 7/7). */
function armRig(db: BusDb, runId: string) {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster((): WakeableReader[] => [{ reader: READER, wakeable: true, runId }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);
  return wakes;
}

// ── ARM 1: the load-bearing arm — fire → withdraw → next sweep RE-fires ───────

test('#172 arm 1: a withdrawn wake-turn un-marks the ledger and the next sweep RE-fires', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN, null);
  const wakes = armRig(db, RUN);

  // Sweep 1: mail pending → the wake FIRES and marks the ledger. The reader does
  // NOT ack (its turn is about to be withdrawn — it never ran the check).
  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake must fire or the negative is vacuous');
  assert.ok(isWakeOrder(wakes[0].text), 'the fired wake is a valid run-naming order');
  assert.ok(__peekWakeLedgerForTests(READER), 'the fire marked the ledger');

  // The queued wake turn is WITHDRAWN unstarted (delivery timeout / #90 wedge).
  // agent-sdk gates this on isWakeOrder(text) — assert that gate holds for the
  // exact text that was fired, then perform the rollback it performs.
  assert.ok(isWakeOrder(wakes[0].text), 'withdrawal gate: the withdrawn turn IS a wake order');
  rollbackWakeForWithdrawnOrder(READER);
  assert.equal(__peekWakeLedgerForTests(READER), undefined, 'the ledger mark is rolled back');
  assert.equal(busWakeCounters().withdrawn, 1, 'the withdrawal is counted (never silent)');

  // The reader STILL has not acked and NO new mail arrived — the starvation state.
  // Pre-fix (no rollback) the ledger stays marked → `already-woken` forever. With
  // the rollback, the very next sweep re-fires. Drive 3 sweeps: the ticket's
  // "already-woken skip across ≥3 sweeps" is the pre-fix behaviour this kills.
  await sweepBusWake();
  await sweepBusWake();
  await sweepBusWake();
  assert.equal(
    wakes.length,
    2,
    'the withdrawn wake RE-fires exactly once (pre-fix: stays 1 across ≥3 sweeps — the live starvation)',
  );
  assert.ok(isWakeOrder(wakes[1].text), 'the re-fired wake names the same pending run');
  assert.deepEqual(wakeOrderRuns(wakes[1].text), [RUN]);
});

// ── ARM 1 MUTANT PROOF: without the rollback, the reader STAYS already-woken ───
//
// This is the pre-fix behaviour driven through the SAME rig, so the fix boundary
// is non-vacuous: SKIP the rollback call (the mutant = agent-sdk never wired
// `rollbackWakeIfOrderWithdrawn`) and the reader is never re-woken across ≥3
// sweeps despite pending mail — the exact zero-served-turns starvation.

test('#172 arm 1 mutant: NO rollback → reader stays already-woken across ≥3 sweeps (the defect)', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN, null);
  const wakes = armRig(db, RUN);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake fires');
  assert.ok(__peekWakeLedgerForTests(READER), 'ledger marked');

  // The turn is withdrawn but the rollback is NOT performed (mutant). The mark
  // survives; the reader never acked, so the cursor never reaches wokeLotSeq.
  // (rollback intentionally omitted here.)
  assert.ok(__peekWakeLedgerForTests(READER), 'mutant: ledger STAYS marked after withdrawal');

  await sweepBusWake();
  await sweepBusWake();
  await sweepBusWake();
  assert.equal(
    wakes.length,
    1,
    'mutant: the reader STARVES on already-woken — zero served turns despite pending mail',
  );
});

// ── ARM 2: the NEGATIVE control — a wake that STARTS marks exactly ONCE ────────
//
// A turn that STARTS is shift()ed off session.queue before yielding, so it is
// never in the queue when a withdrawal path runs — the rollback can never touch
// it. Modelled here as: fire (mark once), the reader ACKS (it ran the check), and
// no withdrawal occurs. The ledger stays consistent, exactly one fire, no double
// wake — #112's duplicate-prompt guard intact. The normal path is NEVER relabelled.

test('#172 arm 2: a wake whose turn STARTS is marked exactly once, no double-wake', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN, null);
  const wakes = armRig(db, RUN);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'fires once');
  assert.ok(__peekWakeLedgerForTests(READER), 'marked once');

  // The turn STARTED and ran — no withdrawal. Drive many sweeps with NO new mail
  // and NO ack (the busy-turn window, T117.2): the dedup must hold at ONE.
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'exactly one wake — a started turn is never re-fired (T117.2 / #112 intact)');
  assert.equal(busWakeCounters().fired, 1);
  assert.equal(busWakeCounters().withdrawn, 0, 'no withdrawal happened — the normal path is never rolled back');
});

// ── ARM 2b: an ORDINARY prompt withdrawal never touches the ledger ────────────
//
// The rollback in agent-sdk is gated on isWakeOrder(text). A non-wake-order turn
// (a human prompt, a peer message) being withdrawn must NOT roll back any wake
// mark — otherwise a queued prompt cancel could re-storm a correctly-dedup'd wake.
// Here a wake is marked, then a NON-order withdrawal is simulated (the gate fails,
// so rollback is never called): the mark must survive.

test('#172 arm 2b: withdrawing a NON-wake-order turn leaves the wake ledger untouched', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN, null);
  const wakes = armRig(db, RUN);

  send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'work-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1);
  assert.ok(__peekWakeLedgerForTests(READER), 'ledger marked');

  // An ordinary prompt is withdrawn. agent-sdk's gate is `if (isWakeOrder(text))`,
  // and a human prompt is NOT a wake order, so the rollback is never invoked.
  const ordinaryText = 'please refactor the parser';
  assert.equal(isWakeOrder(ordinaryText), false, 'a human prompt is not a wake order');
  // (gate fails → rollback NOT called)
  assert.ok(__peekWakeLedgerForTests(READER), 'the wake mark survives a non-order withdrawal');

  // And a direct rollback for a reader with no mark is a harmless no-op.
  rollbackWakeForWithdrawnOrder('some-other-reader-with-no-mark');
  assert.equal(busWakeCounters().withdrawn, 0, 'no-op rollback does not increment the counter');
});

// ── ARM 3: the #162 COALESCED path — withdrawal un-marks for ALL runs covered ──
//
// A coalesced wake order is ONE turn for ONE reader covering the UNION of several
// runs (#162). Its withdrawal must re-arm EVERY run it covered. The FIRE ledger is
// keyed by READER (one entry per wsId regardless of run count), so a single
// rollback drops the union — this arm proves it by firing a wake that names TWO
// runs, withdrawing it, and asserting the next sweep re-fires naming BOTH runs.

test('#172 arm 3: withdrawing a coalesced (multi-run) wake re-arms ALL its runs', async (t) => {
  const db = tmpDb(t);
  // Reader's own run + a DESCENDANT run: mail in each makes the reader pending in
  // both, so one wake order names both (buildWakeOrder unions them).
  const OWN = 'run-own';
  const CHILD = 'run-child';
  insertRun(db, OWN, null);
  insertRun(db, CHILD, OWN); // CHILD is a descendant of OWN → in the related set
  const wakes = armRig(db, OWN);

  // Pending mail in BOTH runs → one coalesced wake order naming both.
  send(db, { runId: OWN, sender: 'ops', kind: 'dispatch', body: 'own-1', recipient: READER });
  send(db, { runId: CHILD, sender: 'sub', kind: 'dispatch', body: 'child-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'one wake covers both runs');
  const firstRuns = wakeOrderRuns(wakes[0].text).sort();
  assert.deepEqual(firstRuns, [CHILD, OWN].sort(), 'the fired order names BOTH pending runs');
  assert.ok(__peekWakeLedgerForTests(READER), 'the coalesced fire marks the single per-reader entry');

  // The coalesced turn is withdrawn unstarted. ONE rollback drops the per-reader
  // entry → both runs are re-armed (no per-run bookkeeping needed).
  rollbackWakeForWithdrawnOrder(READER);
  assert.equal(__peekWakeLedgerForTests(READER), undefined, 'the single entry covering both runs is dropped');

  // No ack, no new mail: the next sweep must re-fire naming BOTH runs again — if
  // the rollback only re-armed one run, the re-fired order would name a subset.
  await sweepBusWake();
  await sweepBusWake();
  assert.equal(wakes.length, 2, 'the coalesced wake re-fires after withdrawal');
  const reRuns = wakeOrderRuns(wakes[1].text).sort();
  assert.deepEqual(
    reRuns,
    [CHILD, OWN].sort(),
    'the re-fired order covers ALL runs the withdrawn coalesced turn covered (arm 3)',
  );
});
