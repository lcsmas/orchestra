// #134 G7 — the wake sweep fires (or counts) based on the flag FROZEN ON THE RUN
// ROW, through the REAL production accessor.
//
// The gap #134 closes: `setWakeSwitchReader` was never wired in production, so
// the sweep's `readWakeSwitch` stayed `() => false` and every run — even one
// frozen wake=ON — was COUNTED, never fired. The existing bus-wake-sweep tests
// pin the switch with `__freezeSwitchForTests(<boolean>)`, which BYPASSES that
// accessor entirely; a build with the accessor unwired passes them all. So this
// file wires the SAME accessor index.ts wires —
//
//     setWakeSwitchReader((runId) => busSwitch(getBus?, runId, 'wake'))
//
// — pointed at a real bus with a real `startRun`-frozen run row, and drives a
// `send` under the wave's run id. It asserts the OBSERVABLE (a turn handed to
// the deliver seam), never "no error". Its must-FAIL twin freezes the run OFF
// and requires fired=0 / counted=1 (carry-forward 3: a positive terminator on
// both arms).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, check, ack, type BusDb } from './bus.ts';
import { startRun, busSwitch } from './bus-runs.ts';
import {
  sweepBusWake,
  busWakeCounters,
  readPendingReaders,
  setWakeRoster,
  setWakeDeliver,
  setWakeSwitchReader,
  setAskGateSwitchReader,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __armStartedForTests,
} from './bus-wake.ts';
import { isWakeOrder, wakeOrderRuns } from '../shared/bus-wake.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const RUN = 'wave-lead';
const R1 = 'impl-1';

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-wake-runswitch-'));
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

function sw(over: Partial<BusSwitches>): BusSwitches {
  return { ...DEFAULT_BUS_SWITCHES, ...over };
}

/** Arm the sweep with the PRODUCTION accessor (the one index.ts wires) reading
 *  the flag off the run row via `busSwitch`, and a recorder at the deliver seam. */
function rig(db: BusDb): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  // THE #134 WIRING under test — identical to index.ts. Reads the FROZEN flag
  // off the run row for the reader's run, never a live/hand-set boolean.
  setWakeSwitchReader((runId) => busSwitch(db, runId, 'wake'));
  setAskGateSwitchReader((runId) => busSwitch(db, runId, 'ask_gate'));
  // Arm the sweep (started=true) WITHOUT overwriting the real accessors just
  // wired — sweepBusWake early-returns unless started.
  __armStartedForTests();
  return wakes;
}

test('G7 — a run FROZEN wake=ON fires the wake for its recipient (real accessor + run row)', async (t) => {
  const db = tmpDb(t);
  const wakes = rig(db);
  // The run is started ON — exactly what maybeStartRunAtAnchor does at the
  // anchor. The sweep must read THIS frozen flag, not a default OFF.
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'lead' }, sw({ wake: true }));
  assert.equal(busSwitch(db, RUN, 'wake'), true, 'precondition: run frozen wake=ON');
  // Mail lands under the WAVE run id (what $ORCHESTRA_RUN_ID now plumbs).
  send(db, { runId: RUN, sender: 'lead', kind: 'dispatch', body: 'do X', recipient: R1 });

  await sweepBusWake();

  assert.equal(wakes.length, 1, 'the recipient was woken');
  assert.equal(wakes[0].reader, R1);
  assert.ok(isWakeOrder(wakes[0].text), 'a valid run-naming order (#134 D2)');
  assert.deepEqual(wakeOrderRuns(wakes[0].text), [RUN], 'names the reader own run');
  assert.equal(busWakeCounters().fired, 1);
  assert.equal(busWakeCounters().counted, 0);
});

test('G7 must-FAIL twin — a run FROZEN wake=OFF is COUNTED, not fired (fired=0)', async (t) => {
  const db = tmpDb(t);
  const wakes = rig(db);
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'lead' }, sw({ wake: false }));
  assert.equal(busSwitch(db, RUN, 'wake'), false, 'precondition: run frozen wake=OFF');
  send(db, { runId: RUN, sender: 'lead', kind: 'dispatch', body: 'do X', recipient: R1 });

  await sweepBusWake();

  // The load-bearing pair: nothing fired AND the would-have-woken is counted.
  // `counted === 1` distinguishes "the frozen switch suppressed it" from "the
  // feature is absent" — asserting only length 0 passes on a build with no wake.
  assert.equal(wakes.length, 0, 'OFF: nothing fires');
  assert.equal(busWakeCounters().fired, 0);
  assert.equal(busWakeCounters().counted, 1, 'OFF: the wake is COUNTED, not fired');
});

test('G7 must-FAIL twin (defect repro) — an UNWIRED accessor never fires even a wake=ON run', async (t) => {
  // This is the master state #134 fixes: the accessor left at its default
  // `() => false`. Even a run frozen ON reads OFF, so the wake is only counted.
  // Proves the WIRING is load-bearing, not merely the run row.
  const db = tmpDb(t);
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests(); // resets readWakeSwitch to the shipped default () => false
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  // Deliberately DO NOT call setWakeSwitchReader — this is the unwired defect.
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'lead' }, sw({ wake: true }));
  send(db, { runId: RUN, sender: 'lead', kind: 'dispatch', body: 'do X', recipient: R1 });

  __armStartedForTests();
  await sweepBusWake();

  assert.equal(wakes.length, 0, 'unwired accessor: a wake=ON run still never fires');
  assert.equal(busWakeCounters().counted, 1, 'it is only counted — the exact reproduced defect');
});

// ─── G4a (D1a, OQ2 ruling A) — innermost-run wake routing, digest UP ─────────
//
// Topology: LEAD mission run 'lead' ← OPS wave run 'ops' (parent_run_id='lead').
// The OPS sends a digest UP to the LEAD; the store-less CLI writes it in the
// OPS's (sender's) run — a DESCENDANT of the LEAD's run. Two D1a rules under test:
//   (1) the LEAD is woken AT ALL only because readPendingReaders widens to
//       descendant runs (drop the widening → the LEAD never sees the mail);
//   (2) fire-vs-count reads the wake switch of the MAIL'S run (the OPS wave),
//       NOT the LEAD's mission run (read the reader's run → the fire arm reddens).

const LEAD_RUN = 'lead-mission';
const OPS_RUN = 'ops-wave';
const LEAD = 'lead-ws';

/** Arm the sweep with the LEAD as the reader (its roster run = the mission run),
 *  the REAL production wake accessor, and a recorder. The OPS wave is nested
 *  under the LEAD via parent_run_id. */
function rigDigestUp(db: BusDb): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: LEAD, wakeable: true, runId: LEAD_RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  setWakeSwitchReader((runId) => busSwitch(db, runId, 'wake'));
  setAskGateSwitchReader((runId) => busSwitch(db, runId, 'ask_gate'));
  __armStartedForTests();
  return wakes;
}

/** Start the nested runs with explicit frozen flags, and send an OPS→LEAD digest
 *  (written in the OPS's run, addressed to the LEAD). */
function seedDigestUp(db: BusDb, leadWake: boolean, opsWake: boolean) {
  startRun(db, { id: LEAD_RUN, kind: 'mission', coordinator: LEAD }, sw({ wake: leadWake }));
  startRun(db, { id: OPS_RUN, kind: 'vague', coordinator: 'ops', parentRunId: LEAD_RUN }, sw({ wake: opsWake }));
  // The digest UP: written in the OPS's (sender's) run, addressed to the LEAD.
  send(db, { runId: OPS_RUN, sender: 'ops', kind: 'dispatch', body: 'digest', recipient: LEAD });
}

test('G4a (i) — OPS wave wake=ON + LEAD mission wake=OFF → the LEAD is FIRED (innermost governs)', async (t) => {
  const db = tmpDb(t);
  const wakes = rigDigestUp(db);
  // The load-bearing D1a case: mission OFF, wave ON. The switch of the MAIL's run
  // (the OPS wave, ON) must govern → the LEAD fires. Reading the LEAD's own
  // mission run (OFF) would COUNT — the mutant this arm forbids.
  seedDigestUp(db, /*leadWake*/ false, /*opsWake*/ true);
  assert.equal(busSwitch(db, LEAD_RUN, 'wake'), false, 'precondition: mission wake=OFF');
  assert.equal(busSwitch(db, OPS_RUN, 'wake'), true, 'precondition: wave wake=ON');

  await sweepBusWake();

  assert.equal(wakes.length, 1, 'the LEAD is woken for the digest in the descendant OPS run');
  assert.equal(wakes[0].reader, LEAD);
  // #134 D2: the order names the run the mail SITS in (the OPS descendant run),
  // NOT the LEAD's own run — so a plain `check` would miss it; the reader must
  // `check --run ops-wave`.
  assert.ok(isWakeOrder(wakes[0].text), 'a valid run-naming order');
  assert.deepEqual(wakeOrderRuns(wakes[0].text), [OPS_RUN], 'the order names the OPS (mail) run');
  assert.equal(busWakeCounters().fired, 1, 'FIRED — the innermost (OPS) wake flag is ON');
  assert.equal(busWakeCounters().counted, 0);
});

test('G4a (ii) — reverse (wave OFF, mission ON) → COUNTED not fired (fired=0)', async (t) => {
  const db = tmpDb(t);
  const wakes = rigDigestUp(db);
  // Mission ON, wave OFF. The innermost (OPS) flag is OFF → COUNTED. Reading the
  // LEAD's mission run (ON) would wrongly FIRE — the same mutant, other direction.
  seedDigestUp(db, /*leadWake*/ true, /*opsWake*/ false);

  await sweepBusWake();

  assert.equal(wakes.length, 0, 'the innermost (OPS) flag is OFF — nothing fires');
  assert.equal(busWakeCounters().fired, 0);
  assert.equal(busWakeCounters().counted, 1, 'COUNTED — governed by the innermost run, not the mission');
});

test('G4a must-FAIL (descendant widening) — WITHOUT the parent_run_id nesting the LEAD is never woken', async (t) => {
  // The precondition mutant: if the OPS run were NOT a descendant of the LEAD's
  // (no parent_run_id), the digest-up mail would be invisible to the LEAD's sweep
  // — the exact OQ2 defect. Prove the widening is load-bearing by breaking the
  // nesting and showing the LEAD is not woken at all.
  const db = tmpDb(t);
  const wakes = rigDigestUp(db);
  startRun(db, { id: LEAD_RUN, kind: 'mission', coordinator: LEAD }, sw({ wake: false }));
  // OPS run started with NO parentRunId → NOT a descendant of the LEAD.
  startRun(db, { id: OPS_RUN, kind: 'vague', coordinator: 'ops' }, sw({ wake: true }));
  send(db, { runId: OPS_RUN, sender: 'ops', kind: 'dispatch', body: 'digest', recipient: LEAD });

  await sweepBusWake();

  assert.equal(wakes.length, 0, 'no nesting ⇒ the mail is not in a descendant run ⇒ the LEAD is NOT woken');
  assert.equal(busWakeCounters().fired, 0);
  assert.equal(busWakeCounters().counted, 0, 'not even counted — the LEAD never saw the mail');
});

// ─── G4a DOWNWARD (D1a-bis) — a LEAD→OPS ruling wakes the OPS via ANCESTOR mail ─
//
// The LEAD sends a ruling DOWN to the OPS; the store-less CLI writes it in the
// LEAD's mission run — an ANCESTOR of the OPS's wave run. The OPS reader (roster
// run = the OPS wave) must be woken via the ancestor widening, and the GOVERNING
// switch is the DEEPER of (mail=LEAD mission, reader=OPS wave) = the OPS wave (the
// reader's run) — the opposite deeper-run from the upward case.

/** Arm with the OPS as the reader (roster run = the OPS wave). */
function rigRulingDown(db: BusDb): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => [{ reader: 'ops-ws', wakeable: true, runId: OPS_RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  setWakeSwitchReader((runId) => busSwitch(db, runId, 'wake'));
  setAskGateSwitchReader((runId) => busSwitch(db, runId, 'ask_gate'));
  __armStartedForTests();
  return wakes;
}

/** Start the nested runs and send a LEAD→OPS ruling (written in the LEAD's
 *  mission run, addressed to the OPS). */
function seedRulingDown(db: BusDb, leadWake: boolean, opsWake: boolean) {
  startRun(db, { id: LEAD_RUN, kind: 'mission', coordinator: 'lead-ws' }, sw({ wake: leadWake }));
  startRun(db, { id: OPS_RUN, kind: 'vague', coordinator: 'ops-ws', parentRunId: LEAD_RUN }, sw({ wake: opsWake }));
  send(db, { runId: LEAD_RUN, sender: 'lead-ws', kind: 'dispatch', body: 'ruling', recipient: 'ops-ws' });
}

test('G4a DOWNWARD (i) — OPS-wave wake=ON + mission OFF → the OPS is FIRED (reader run governs)', async (t) => {
  const db = tmpDb(t);
  const wakes = rigRulingDown(db);
  // Mail is in the LEAD (ancestor) run; the GOVERNING run is the DEEPER = the OPS
  // wave (reader's run), which is ON → FIRE. Reading the mail's (LEAD) run, OFF,
  // would COUNT — the downward mutant this arm forbids.
  seedRulingDown(db, /*leadWake*/ false, /*opsWake*/ true);

  await sweepBusWake();

  assert.equal(wakes.length, 1, 'the OPS is woken for the ruling in its ancestor (LEAD) run');
  assert.equal(wakes[0].reader, 'ops-ws');
  assert.equal(busWakeCounters().fired, 1, 'FIRED — the innermost (OPS reader) wake flag governs');
  assert.equal(busWakeCounters().counted, 0);
});

test('G4a DOWNWARD (ii) — reverse (OPS-wave OFF, mission ON) → COUNTED not fired', async (t) => {
  const db = tmpDb(t);
  const wakes = rigRulingDown(db);
  seedRulingDown(db, /*leadWake*/ true, /*opsWake*/ false);

  await sweepBusWake();

  assert.equal(wakes.length, 0, 'the innermost (OPS reader) flag is OFF — nothing fires');
  assert.equal(busWakeCounters().fired, 0);
  assert.equal(busWakeCounters().counted, 1, 'COUNTED — governed by the reader run, not the mission mail run');
});

// ─── G4a ROUND-TRIP (OQ3) — fire → check → ack → pending clears → NOT re-woken ─
//
// The MANDATORY arm OPS-F required regardless of the OQ3 mechanism: a fire-only
// assertion is latent-green over a permanent wake loop. This drives the reader's
// FULL round-trip against the real bus, retrieving the mail from the run it
// SITS in (`pendingRunId`, per OQ3(B) the wake order names it), acking it, and
// asserting the next sweep does NOT re-wake. The single-run-retrieval must-FAIL
// (reader checks its OWN run only) shows the loop as RED.

test('G4a ROUND-TRIP — upward digest: LEAD fires, checks the MAIL run, acks, is NOT re-woken', async (t) => {
  const db = tmpDb(t);
  const wakes = rigDigestUp(db);
  seedDigestUp(db, /*leadWake*/ false, /*opsWake*/ true); // wave ON governs → fire

  // Sweep 1: the LEAD is FIRED.
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'sweep 1 wakes the LEAD');

  // The reader obeys the ORDER LITERALLY (OQ3 D2): it runs each `check --run <r>`
  // the wake named, and acks each lot. Parse the runs OUT of the emitted order
  // string — the round-trip is driven by what the wake actually said, not by a
  // run the test knew out of band.
  const namedRuns = wakeOrderRuns(wakes[0].text);
  assert.deepEqual(namedRuns, [OPS_RUN], 'the order names exactly the OPS (mail) run');
  for (const r of namedRuns) {
    const lot = check(db, r, LEAD);
    assert.equal(lot.messages.length, 1, `checking the named run ${r} returns the digest`);
    assert.ok(lot.delivery, 'a lot was opened');
    ack(db, r, LEAD, lot.delivery!.id);
  }

  // Sweep 2: pending has cleared (the reader's cursor in the OPS run advanced) →
  // NOT re-woken. This is what proves there is no permanent loop.
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'sweep 2 does NOT re-wake — pending cleared after the ack');
  const pendAfter = readPendingReaders(db, [{ reader: LEAD, runId: LEAD_RUN }]);
  assert.equal(pendAfter[0].pending, false, 'the reader is no longer pending after ack');
});

test('G4a ROUND-TRIP must-FAIL — checking only the reader OWN run never clears → the LOOP', async (t) => {
  // The single-run-retrieval defect (OQ3): the reader checks its OWN run (the
  // pre-D1a behaviour / a build without the run-naming order). The cross-run mail
  // is never returned, never acked, so pending PERSISTS and the reader is re-woken
  // on the next sweep — the permanent loop shown RED here as a positive assertion.
  const db = tmpDb(t);
  const wakes = rigDigestUp(db);
  seedDigestUp(db, /*leadWake*/ false, /*opsWake*/ true);

  await sweepBusWake();
  assert.equal(wakes.length, 1, 'sweep 1 wakes the LEAD');

  // The BROKEN retrieval: check the reader's OWN run, not the mail run.
  const lot = check(db, LEAD_RUN, LEAD);
  assert.equal(lot.messages.length, 0, 'checking the OWN run returns NOTHING — the mail is in the OPS run');
  // Nothing to ack; pending is unchanged. The reader stays pending → re-woken.
  const stillPending = readPendingReaders(db, [{ reader: LEAD, runId: LEAD_RUN }]);
  assert.equal(stillPending[0].pending, true, 'THE LOOP: own-run check left the reader still pending');
});
