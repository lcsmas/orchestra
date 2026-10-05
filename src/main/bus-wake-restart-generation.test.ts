import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import {
  openBus,
  send,
  openGate,
  bumpCoordinatorGeneration,
  type BusDb,
} from './bus.ts';
import { log } from './logger.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  __setBusReaderForTests,
  __setNowForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
  type WakeableReader,
} from './bus-wake.ts';
import { isWakeOrder } from '../shared/bus-wake.ts';

// #200 — after an OPS/LEAD coordinator `orchestra restart`, the process-global
// in-memory FIRE ledger keeps the SUPERSEDED coordinator's entry: its
// `(wokeRunId, wokeLotSeq, lastWakeAt)` high-water. That stale entry makes the
// fresh coordinator (a) latch `already-woken` on new mail its reset turn never
// acked — until the #183 5-min bound — and (b) report a stale/cross-run
// `wokeLotSeq` in the wake log (live: `woke 0d4e3866 through seq 15`, a 2-week-old
// unrelated run, while the trigger was dispatch seq 1995).
//
// The durable, per-run marker of a coordinator restart is the run's
// `coordinator_generation` (#128/#166 bump it on a coordinator-replacement
// relaunch — verified live: OPS run 0d4e3866 read generation 1 post-restart, the
// mail's mission run 0524718f still 0). So the reader's OWN run generation
// advancing past the ledger entry's recorded generation is exactly "this
// coordinator restarted since its last wake" → re-arm.
//
// Rig contract (same as bus-wake-restart.test.ts): the roster is the restart's
// observable at this layer (the sweep re-reads it each tick); the run tree and its
// generation are durable `runs` rows; the delivered wake captured at the seam is
// the observable, not an internal the dedup bug moves in lockstep. Temp bus on
// $HOME (btrfs, contract rule 4) — the live bus is never touched.

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = mkHomeScratch('wake-restart-gen-test-');
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

/** A `runs` row so `getRelatedRunIds`/`coordinatorGeneration` see it. */
function insertRun(db: BusDb, id: string, parent: string | null, kind = parent ? 'vague' : 'mission'): void {
  db.prepare(
    `INSERT INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(id, kind, 'x', parent, null, Date.now());
}

// The OPS coordinator: its OWN run is `OPS_RUN` (a vague it anchors), under the
// mission `MISSION`. Mail arrives IN the OPS's own run (the shape that latches).
const OPS = 'ws-ops-coordinator';
const MISSION = 'mission-run';
const OPS_RUN = 'ops-run';

/** Arm the sweep against a real bus, capturing delivered wakes. Switch ON (7/7).
 *  `clock` is a mutable box so a test can advance the #183 bound clock explicitly
 *  and PROVE the re-arm is generation-driven, not the 5-min bound. */
function armRig(db: BusDb, clock: { t: number }) {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => clock.t);
  setWakeRoster((): WakeableReader[] => [
    { reader: OPS, wakeable: true, runId: OPS_RUN },
  ]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);
  return wakes;
}

// ── The must-FAIL arm (D9 / #200): restart → latched on the fresh mail pre-fix ──

test('#200 a coordinator restart re-arms the stale wake latch on the CURRENT mail', async (t) => {
  const db = tmpDb(t);
  insertRun(db, MISSION, null, 'mission');
  insertRun(db, OPS_RUN, MISSION, 'vague'); // generation 0

  const clock = { t: 1_000_000 };
  const wakes = armRig(db, clock);

  // Sweep 1: OPS is woken for the first mail in its own run → the FIRE ledger
  // records (wokeRunId=OPS_RUN, wokeLotSeq=seq1, wokeGeneration=0). OPS does NOT
  // ack (its turn is about to be reset by the restart), so its cursor stays 0.
  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'pre-restart mail', recipient: OPS });
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first wake must fire or the negative is vacuous');

  // `orchestra restart` of the coordinator: #166 bumps its OWN run generation.
  // The in-memory FIRE ledger survives (a SESSION restart, not an app restart),
  // still holding the pre-restart entry at generation 0. The clock is UNMOVED, so
  // the #183 5-min bound is provably NOT what could rescue this.
  const gen = bumpCoordinatorGeneration(db, OPS_RUN);
  assert.equal(gen, 1, 'restart bumps the coordinator run generation to 1');

  // NEW mail arrives (the real trigger — the #200 live seq 1995). Its seq is ABOVE
  // the pre-restart high-water, but the fresh coordinator never acked seq1, so its
  // cursor is still 0 < seq1: the lot axis does NOT re-arm on the cursor, the woken
  // run is still related (not orphaned), and the bound has not elapsed. Pre-fix →
  // `already-woken`, silently, forever (the ~2min live latch, bounded only by #183).
  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'the trigger mail', recipient: OPS });

  // Two sweeps, clock unchanged (NOT past REWAKE_BOUND_MS): the ONLY thing that can
  // wake OPS here is the generation-advance re-arm.
  await sweepBusWake();
  await sweepBusWake();

  assert.equal(
    wakes.length,
    2,
    'a restarted coordinator MUST wake on the fresh mail via the generation re-arm (pre-fix: stays 1, latched already-woken until the #183 bound)',
  );
  assert.ok(isWakeOrder(wakes[1].text), 'the second wake is a valid run-naming order');
  assert.equal(busWakeCounters().fired, 2);
});

// ── The report-correctness half: the re-armed wake reports the CURRENT seq ──────

test('#200 the post-restart wake reports the CURRENT triggering seq, not the stale high-water', async (t) => {
  const db = tmpDb(t);
  insertRun(db, MISSION, null, 'mission');
  insertRun(db, OPS_RUN, MISSION, 'vague');

  const clock = { t: 2_000_000 };
  const wakes = armRig(db, clock);
  const logged: string[] = [];
  const origInfo = log.info;
  log.info = (m: string, meta?: unknown) => {
    if (m.startsWith('bus-wake: woke ')) logged.push(m);
    return origInfo(m, meta);
  };
  t.after(() => {
    log.info = origInfo;
  });

  // Read seqs from `messages` directly, NOT via `check`: an un-acked outstanding
  // lot is REPLAYED byte-identical (frozen to_seq), so a second `check` would NOT
  // surface the new mail and would read the STALE seq — the very confusion this arm
  // must avoid. `send`'s row is the authoritative seq.
  const seqOf = (body: string): number =>
    (db.prepare('SELECT sequence FROM messages WHERE body = ?').get(body) as { sequence: number }).sequence;

  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'pre', recipient: OPS });
  await sweepBusWake();
  const firstSeq = seqOf('pre');
  // Do NOT ack — model the reset turn.

  bumpCoordinatorGeneration(db, OPS_RUN);
  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'trigger', recipient: OPS });
  const triggerSeq = seqOf('trigger');
  assert.ok(triggerSeq > firstSeq, 'the trigger mail is above the pre-restart high-water');

  await sweepBusWake();

  assert.equal(wakes.length, 2, 'the re-arm fired');
  const lastWoke = logged[logged.length - 1];
  assert.ok(
    lastWoke.includes(`through seq ${triggerSeq}`),
    `the wake must report the CURRENT trigger seq ${triggerSeq}, got: ${JSON.stringify(lastWoke)}`,
  );
  assert.ok(
    !lastWoke.includes(`through seq ${firstSeq}`),
    'and NOT the stale pre-restart high-water',
  );
});

// ── Positive dedup control: the restart re-arm fires ONCE, then dedups ──────────

test('#200 the restart re-arm fires exactly ONCE then dedups (no wake storm)', async (t) => {
  const db = tmpDb(t);
  insertRun(db, MISSION, null, 'mission');
  insertRun(db, OPS_RUN, MISSION, 'vague');
  const clock = { t: 3_000_000 };
  const wakes = armRig(db, clock);

  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'pre', recipient: OPS });
  await sweepBusWake();
  bumpCoordinatorGeneration(db, OPS_RUN);
  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'trigger', recipient: OPS });

  // Many sweeps with NO ack and NO further generation bump: the re-arm records the
  // new wokeGeneration (=1), so subsequent sweeps see current==recorded → dedup the
  // ordinary way. One additional wake total, not one per sweep.
  for (let i = 0; i < 6; i++) await sweepBusWake();
  assert.equal(wakes.length, 2, 'restart re-arm wakes exactly once, then the normal dedup holds');
  assert.equal(busWakeCounters().fired, 2);
});

// ── Negative control: a NON-coordinator reader (generation never bumps) DEDUPS ──

test('#200 a reader whose run generation never advances is NOT re-woken (fix scoped)', async (t) => {
  // Same shape, but generation stays 0 (a plain member/operator run never bumps).
  // With no ack, no new-run orphaning, no generation advance and the clock frozen,
  // the ordinary dedup must suppress — proving the re-arm is the generation advance,
  // not a blanket "always re-arm" that would reintroduce the T117.2 storm.
  const db = tmpDb(t);
  insertRun(db, MISSION, null, 'mission');
  insertRun(db, OPS_RUN, MISSION, 'vague');
  const clock = { t: 4_000_000 };
  const wakes = armRig(db, clock);

  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'pre', recipient: OPS });
  await sweepBusWake();
  assert.equal(wakes.length, 1);
  // NO generation bump. New mail, but no ack, no restart.
  send(db, { runId: OPS_RUN, sender: 'lead', kind: 'dispatch', body: 'more', recipient: OPS });
  for (let i = 0; i < 5; i++) await sweepBusWake();
  assert.equal(
    wakes.length,
    1,
    'no generation advance → ordinary already-woken dedup holds (T117.2 intact)',
  );
});

// ── The GATE-axis clause: a restart re-arms a pending-gate latch too ────────────

test('#200 a coordinator restart re-arms a latched GATE-axis wake (gate clause)', async (t) => {
  // A coordinator parked on an OPEN gate is latched on the gate axis after its
  // first wake (`gateAxisReArmed` re-arms only on a genuinely NEW gate). Across a
  // restart it inherits the stale gate high-water and stays `already-woken` on the
  // same open gate. The gate-axis restart clause re-arms it once. Both wake and
  // askGate switches ON.
  const db = tmpDb(t);
  insertRun(db, MISSION, null, 'mission');
  insertRun(db, OPS_RUN, MISSION, 'vague');
  const clock = { t: 5_000_000 };
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => clock.t);
  setWakeRoster((): WakeableReader[] => [{ reader: OPS, wakeable: true, runId: OPS_RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true, true); // wake ON + askGate ON

  // A gate addressed to OPS in its own run → pending on the gate axis.
  openGate(db, OPS_RUN, 'lead', 'ruling?', OPS);
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'first gate wake must fire or the negative is vacuous');

  // Restart bumps the coordinator run generation. The SAME gate is still open (no
  // new gate) — the gate axis alone cannot re-arm.
  bumpCoordinatorGeneration(db, OPS_RUN);

  await sweepBusWake();
  await sweepBusWake();
  assert.equal(
    wakes.length,
    2,
    'a restarted coordinator MUST re-wake on its still-open gate (pre-fix: latched already-woken)',
  );
});
