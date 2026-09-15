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
import { openBus, send, type BusDb } from './bus.ts';
import { startRun, busSwitch } from './bus-runs.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  setWakeSwitchReader,
  setAskGateSwitchReader,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __armStartedForTests,
} from './bus-wake.ts';
import { WAKE_ORDER } from '../shared/bus-wake.ts';
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
  assert.equal(wakes[0].text, WAKE_ORDER);
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
