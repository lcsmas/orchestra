import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, check, ack, type BusDb } from './bus.ts';
import { log } from './logger.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
  stopBusWake,
  type WakeableReader,
} from './bus-wake.ts';
import { isWakeOrder } from '../shared/bus-wake.ts';

// #159 — a reader that was woken, then RESTARTED (`orchestra restart`), then went
// idle, must wake on same-run NEW mail within ≤2 sweeps. Found LIVE twice
// (canary-5 F-C5-3, ~19 min; canary-6 F-C6, ~8 min): ZERO `bus-wake: woke` lines
// while sibling readers woke sub-second, until an OLD-CHANNEL poke started a turn.
//
// ── The mechanism, driven end to end over a REAL SQLite bus ─────────────────
//
// The wake FIRE ledger records `wokeRunId` = the run the last wake's mail sat in
// (src/main/bus-wake.ts). `orchestra restart` rebuilds the reader's env, re-running
// `resolveWaveRunId(ws)` (= nearestOrchestratorId over the LIVE tree), so the run a
// reader belongs to — and therefore its `getRelatedRunIds` set — can SHIFT across a
// restart (the reason `reconcileRunAfterReparent` exists, workspaces.ts). When the
// run the ledger's high-water was recorded against DROPS OUT of the reader's new
// related set, `readPendingReaders` builds `cursorByRun` over the CURRENT related
// set only, so it has NO key for that orphaned run. Pre-fix `lotAxisReArmed` read
// the absent key as cursor 0 → `0 >= wokeLotSeq` false → `decideWake` returned
// `already-woken` — the ONE skip with no log line (bus-wake.ts:563) — every sweep,
// forever. Post-fix an orphaned `wokeRunId` RE-ARMS (a stale high-water is not
// "not yet acked").
//
// Rig contract: the roster is the seam that models the restart (a restart is a new
// env, so a new roster read); the run tree is the durable `runs` rows. Nothing here
// touches the live bus — a temp file on $HOME (btrfs, same FS as prod, contract
// rule 4). The observable is the DELIVERED WAKE captured at the delivery seam, not
// an internal the dedup bug would move in lockstep (the #112 lesson).

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  // $HOME (btrfs), NOT os.tmpdir() (tmpfs): a bus rig must run on the same FS as
  // prod (contract rule 4). This arm does not depend on WAL inode behaviour, but
  // the whole file follows the rule so no arm is silently substrate-dependent.
  const base = process.env.HOME || os.homedir();
  const dir = fs.mkdtempSync(path.join(base, '.orchestra-wake-restart-test-'));
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

const READER = 'ws-restarted';
// The run the reader belonged to BEFORE restart, and the run it belongs to AFTER.
// Deliberately UNRELATED in the tree (no ancestor/descendant edge) — that is the
// orphaning a re-resolved anchor produces (an OPS row appears, a parent edge moves).
const RUN_PRE = 'run-pre-restart';
const RUN_POST = 'run-post-restart';

/** Arm the sweep with a MUTABLE roster (`rosterRun` models the restart re-resolve)
 *  recording every delivered wake. Switch frozen ON for every run (wave 7/7). */
function armRig(db: BusDb, state: { rosterRun: string }) {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster((): WakeableReader[] => [
    { reader: READER, wakeable: true, runId: state.rosterRun },
  ]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);
  return wakes;
}

// ── The load-bearing arm: wake → restart (run re-resolves) → idle → NEW mail ──

test('#159 restarted reader wakes on same-run NEW mail ≤2 sweeps (pre-fix: silent)', async (t) => {
  const db = tmpDb(t);
  // Both runs exist as UNRELATED tree rows (no parent edge between them).
  insertRun(db, RUN_PRE, null);
  insertRun(db, RUN_POST, null);

  const state = { rosterRun: RUN_PRE };
  const wakes = armRig(db, state);

  // Sweep 1: the reader is woken for mail in RUN_PRE — so the ledger records
  // wokeRunId = RUN_PRE. It obeys and ACKS RUN_PRE (cursor in RUN_PRE advances).
  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'pre-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake must happen or the negative is vacuous');
  const lotPre = check(db, RUN_PRE, READER);
  assert.equal(ack(db, RUN_PRE, READER, lotPre.delivery!.id), true);

  // `orchestra restart`: the env is rebuilt, resolveWaveRunId re-resolves the reader
  // to RUN_POST, which is UNRELATED to RUN_PRE. Modelled as a fresh roster read —
  // the sweep re-reads the roster every tick, so flipping state.rosterRun IS the
  // restart's observable at this layer. The ledger (process-global) survives, still
  // holding wokeRunId = RUN_PRE.
  state.rosterRun = RUN_POST;

  // NEW mail arrives in the reader's CURRENT (post-restart) run → the reader is
  // genuinely pending (this is NOT the self-healing no-pending case). RUN_PRE is no
  // longer in the reader's related set, so cursorByRun has no key for it.
  send(db, { runId: RUN_POST, sender: 'ops', kind: 'dispatch', body: 'post-1', recipient: READER });

  // ≤2 sweeps to wake (the ticket's bound). Pre-fix: 0 additional wakes across
  // both (already-woken, silent). Post-fix: exactly 1 more.
  await sweepBusWake();
  await sweepBusWake();

  assert.equal(wakes.length, 2, 'restarted+idle reader MUST wake on new same-run mail (pre-fix: stays 1 forever)');
  assert.ok(isWakeOrder(wakes[1].text), 'and the second wake is a valid run-naming order');
  assert.equal(busWakeCounters().fired, 2);
});

// ── Positive dedup control: the orphan re-arm must fire ONCE, not storm ──────

test('#159 the orphan re-arm fires exactly ONCE then dedups (no wake storm)', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN_PRE, null);
  insertRun(db, RUN_POST, null);
  const state = { rosterRun: RUN_PRE };
  const wakes = armRig(db, state);

  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'pre-1', recipient: READER });
  await sweepBusWake();
  const lotPre = check(db, RUN_PRE, READER);
  ack(db, RUN_PRE, READER, lotPre.delivery!.id);

  state.rosterRun = RUN_POST;
  send(db, { runId: RUN_POST, sender: 'ops', kind: 'dispatch', body: 'post-1', recipient: READER });

  // Drive MANY sweeps with NO ack of the post mail. The re-arm records a fresh
  // ledger entry keyed on RUN_POST (now a live related run), so subsequent sweeps
  // dedup the ordinary way — one wake total, not one per sweep.
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'orphan re-arm wakes exactly once, then the normal cursor dedup holds');
  assert.equal(busWakeCounters().fired, 2);
});

// ── Negative control: a NON-orphaned woken run still DEDUPS (the fix is scoped) ──

test('#159 a still-related woken run with no ack is NOT re-woken (fix does not weaken dedup)', async (t) => {
  // Same shape, but the reader does NOT restart: its run stays RUN_PRE, so the
  // woken run is still in cursorByRun. With no ack and no new mail the ordinary
  // dedup must suppress — proving the orphan branch is what fires above, not a
  // blanket "always re-arm".
  const db = tmpDb(t);
  insertRun(db, RUN_PRE, null);
  const state = { rosterRun: RUN_PRE };
  const wakes = armRig(db, state);

  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'pre-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1);
  // No ack, no restart, no new mail — the woken run RUN_PRE stays related.
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(wakes.length, 1, 'a still-related, un-acked woken run must NOT re-wake (T117.2 intact)');
});

// ── Subsystem-restart parity: the ledger survives a teardown, orphan still re-arms ──

test('#159 orphan re-arm survives a full bus-wake subsystem restart', async (t) => {
  // The real app restart tears down and rebuilds the wake subsystem too. Assert the
  // orphan re-arm is a property of durable state + the (rebuilt) roster, not of a
  // ledger entry that happened to survive in memory.
  const db = tmpDb(t);
  insertRun(db, RUN_PRE, null);
  insertRun(db, RUN_POST, null);
  const state = { rosterRun: RUN_PRE };
  let wakes = armRig(db, state);

  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'pre-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1);
  const lotPre = check(db, RUN_PRE, READER);
  ack(db, RUN_PRE, READER, lotPre.delivery!.id);

  // Full subsystem restart: teardown + reset clears the in-memory ledger. After a
  // real restart the reader is on RUN_POST and RUN_PRE is unrelated; a fresh sweep
  // has an EMPTY ledger, so this must fire normally (there is nothing stale to
  // suppress). This is the coexistence-safe direction and proves the fix does not
  // depend on ledger survival.
  stopBusWake();
  state.rosterRun = RUN_POST;
  wakes = armRig(db, state);
  send(db, { runId: RUN_POST, sender: 'ops', kind: 'dispatch', body: 'post-1', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'post-restart reader with new mail wakes (empty ledger, nothing stale)');
});

// ── OBSERVABILITY (#159 deliverable 2): log ONCE per wakeable-state transition ──
//
// The 19-min window was diagnosable only by elimination because a `skip` logs
// nothing. A PENDING reader that is being skipped must emit ONE line on entry and
// ONE on recovery — never one per sweep. Driven through a `not-wakeable` reader (a
// PERSISTENT silent skip the re-arm fix does not touch), so this arm isolates the
// LOG mechanism from the re-arm fix.

/** Capture log.info/log.warn lines matching a substring, restoring on teardown. */
function captureLog(t: { after: (fn: () => void) => void }, needle: string): string[] {
  const hits: string[] = [];
  const origInfo = log.info;
  const origWarn = log.warn;
  log.info = (m: string, meta?: unknown) => {
    if (m.includes(needle)) hits.push(m);
    return origInfo(m, meta);
  };
  log.warn = (m: string, meta?: unknown) => {
    if (m.includes(needle)) hits.push(m);
    return origWarn(m, meta);
  };
  t.after(() => {
    log.info = origInfo;
    log.warn = origWarn;
  });
  return hits;
}

test('#159 obs: a pending-but-skipped reader is logged ONCE on entry, not per sweep', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN_PRE, null);
  const lines = captureLog(t, READER);

  // A not-wakeable reader with pending mail = the persistent silent skip.
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  const state = { wakeable: false };
  setWakeRoster((): WakeableReader[] => [
    { reader: READER, wakeable: state.wakeable, runId: RUN_PRE },
  ]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);

  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'work', recipient: READER });
  for (let i = 0; i < 6; i++) await sweepBusWake();

  assert.equal(wakes.length, 0, 'not-wakeable: nothing fires (the silent skip)');
  const entryLines = lines.filter((l) => l.includes("not being woken"));
  assert.equal(
    entryLines.length,
    1,
    `the skip must be logged EXACTLY once across 6 sweeps, got ${entryLines.length}: ${JSON.stringify(entryLines)}`,
  );
  assert.ok(entryLines[0].includes("'not-wakeable'"), 'and it names the skip reason');
});

test('#159 obs: recovery to wakeable is logged once, and the wake then fires', async (t) => {
  const db = tmpDb(t);
  insertRun(db, RUN_PRE, null);
  const lines = captureLog(t, READER);

  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  const state = { wakeable: false };
  setWakeRoster((): WakeableReader[] => [
    { reader: READER, wakeable: state.wakeable, runId: RUN_PRE },
  ]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);

  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'work', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'skipped while not-wakeable');

  // Becomes wakeable (the roster now reports it) → recovery transition + wake.
  state.wakeable = true;
  for (let i = 0; i < 3; i++) await sweepBusWake();

  assert.equal(wakes.length, 1, 'once wakeable, the pending wake is delivered');
  const recovery = lines.filter((l) => l.includes('wakeable again'));
  assert.equal(recovery.length, 1, `recovery logged exactly once, got ${recovery.length}`);
});

test('#159 obs: the ACTUAL already-woken defect path is logged once (F2)', async (t) => {
  // REVIEW-159 F2: the two arms above drive `not-wakeable` (a proxy silent skip);
  // the ticket's real defect is `already-woken`. Assert the transition log fires on
  // THAT reason too, so narrowing the log condition to `not-wakeable` only (or
  // dropping `already-woken`) reddens here. A still-related, un-acked woken reader
  // sits in `already-woken` from its second sweep on — the exact steady state of the
  // #159 starvation before the re-arm fix would clear it.
  const db = tmpDb(t);
  insertRun(db, RUN_PRE, null);
  const lines = captureLog(t, READER);
  const state = { rosterRun: RUN_PRE };
  const wakes = armRig(db, state);

  send(db, { runId: RUN_PRE, sender: 'ops', kind: 'dispatch', body: 'work', recipient: READER });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake fires (then the reader is idle, un-acked → already-woken)');

  // No ack, no new mail: every subsequent sweep decides `already-woken`.
  for (let i = 0; i < 5; i++) await sweepBusWake();
  const alreadyWoken = lines.filter((l) => l.includes("skip reason 'already-woken'"));
  assert.equal(
    alreadyWoken.length,
    1,
    `already-woken must be logged EXACTLY once across 5 idle sweeps, got ${alreadyWoken.length}`,
  );
});
