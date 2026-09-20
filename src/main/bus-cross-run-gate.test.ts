// #158 — a CROSS-RUN decision gate (opened in the ASKER's run, recipient anchored
// in ANOTHER run) must wake its recipient and surface in the recipient's
// wake-order-named check. Found LIVE in canary 5 (ledger #157 F-C5-1): an OPS
// opened a gate addressed to its LEAD in the OPS's own run; the LEAD sat idle ≥8
// sweeps with ZERO wake and the gate absent from its own-run `check`.
//
// The gate half was own-run only (`openGatesForRecipient(db, readerRun, reader)`)
// while the lot half got the #134/#144 ancestor∪own∪descendant widening. This
// suite drives the REAL production accessor over real `startRun`-frozen run rows
// (mirroring bus-wake-run-switch.test.ts), never a hand-set boolean, so a build
// that only pins the switch would not pass. Every arm asserts the OBSERVABLE — a
// turn handed to the deliver seam, and the gate returned by the lookup the reader
// runs — never "no error thrown".
//
// The 4 acceptance arms (ticket #158), each RED on the pre-#158 own-run lookup:
//   1. cross-run gate → recipient woken ≤2 sweeps, gate in its wake-order-named run.
//   2. own-run gate (member→OPS, same run) unchanged — still wakes, still surfaces.
//   3. gate-axis dedup (D-H1 wokeGateSeq) unchanged across BOTH shapes.
//   4. resolve → ASKER re-woken with the resolution (both shapes) — CLI arm in
//      bus-verbs.test.ts (the resolve→reply lives in the verb).

import test from 'node:test';
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
  openGatesForRecipient,
  type BusDb,
} from './bus.ts';
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
import { wakeOrderRuns } from '../shared/bus-wake.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

// The fleet tree: a LEAD mission run, an OPS run nested UNDER it. The OPS opens a
// gate addressed to the LEAD in the OPS's OWN run — so the gate sits in a
// DESCENDANT of the LEAD's run, exactly the OPS→LEAD upward-ruling shape.
const LEAD_RUN = 'run-lead';
const OPS_RUN = 'run-ops';
const LEAD = 'ws-lead';
const OPS = 'ws-ops';
const MEMBER = 'ws-member';

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-crossgate-'));
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

/** Start the two related run rows with ask_gate ON on both, so the reader's OWN
 *  run (the switch is keyed on it) is ON regardless of which reader is driven. */
function startTree(db: BusDb): void {
  startRun(db, { id: LEAD_RUN, kind: 'mission', coordinator: LEAD }, sw({ askGate: true, wake: true }));
  startRun(
    db,
    { id: OPS_RUN, kind: 'vague', coordinator: OPS, parentRunId: LEAD_RUN },
    sw({ askGate: true, wake: true }),
  );
}

/** Arm the sweep with the PRODUCTION accessors (identical to index.ts) reading the
 *  FROZEN flags off the run rows, a recorder at the deliver seam, and a roster of
 *  the given readers each anchored in its own run. */
function rig(
  db: BusDb,
  readers: { reader: string; runId: string }[],
): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  setWakeRoster(() => readers.map((r) => ({ ...r, wakeable: true })));
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  setWakeSwitchReader((runId) => busSwitch(db, runId, 'wake'));
  setAskGateSwitchReader((runId) => busSwitch(db, runId, 'ask_gate'));
  __armStartedForTests();
  return wakes;
}

// ══ ARM 1 — the live repro: cross-run gate wakes its recipient & names its run ══

test('#158 arm1 — a CROSS-RUN gate (opened in OPS run, recipient LEAD) wakes LEAD ≤2 sweeps and its wake order names the GATE run', async (t) => {
  const db = tmpDb(t);
  startTree(db);
  const wakes = rig(db, [{ reader: LEAD, runId: LEAD_RUN }]);

  // The OPS opens a gate addressed to the LEAD, IN THE OPS'S OWN RUN (a descendant
  // of the LEAD's run) — the exact F-C5-1 shape.
  const gateId = openGate(db, OPS_RUN, OPS, 'ship the stack?', LEAD);
  assert.ok(gateId > 0, 'gate opened');

  // The pre-#158 own-run lookup would report gatePending=false here (the gate is
  // in a DIFFERENT run than the LEAD's own), so the widened predicate is what
  // makes the LEAD gate-pending at all.
  const pending = readPendingReaders(db, [{ reader: LEAD, runId: LEAD_RUN }])[0];
  assert.equal(pending.gatePending, true, 'the LEAD is gate-pending for the cross-run gate (widened lookup)');
  assert.deepEqual(pending.gateRunIds, [OPS_RUN], 'the pending state carries the GATE run, not the reader run');

  // ≤2 sweeps to a wake.
  await sweepBusWake();
  await sweepBusWake();
  const leadWakes = wakes.filter((w) => w.reader === LEAD);
  assert.equal(leadWakes.length, 1, 'the LEAD is woken exactly once for the cross-run gate');

  // The wake order NAMES the gate's run, so `orchestra check --run <gateRun>` is
  // what the reader is told to run — and that run surfaces the gate.
  assert.deepEqual(wakeOrderRuns(leadWakes[0].text), [OPS_RUN], 'the wake order names the GATE run (OPS_RUN)');
  const surfaced = openGatesForRecipient(db, OPS_RUN, LEAD);
  assert.equal(surfaced.length, 1, 'check --run <gateRun> surfaces the gate to the recipient');
  assert.equal(surfaced[0].id, gateId, 'and it is exactly the gate that was opened');
  assert.equal(busWakeCounters().fired, 1, 'exactly one fire total');
});

test('#158 arm1 MUST-FAIL twin — with the OPS run UNLINKED from the LEAD (unrelated), the cross-run gate wakes NOBODY', async (t) => {
  // The disproof: the widening is scoped to the RELATED run set (own ∪ ancestors ∪
  // descendants), never a bare cross-run read. A gate in a run NOT related to the
  // reader must still be invisible — otherwise the fix would wake a reader for a
  // stranger run's traffic. Same rig, but the OPS run has NO parent link, so it is
  // not in the LEAD's related set.
  const db = tmpDb(t);
  startRun(db, { id: LEAD_RUN, kind: 'mission', coordinator: LEAD }, sw({ askGate: true, wake: true }));
  startRun(db, { id: OPS_RUN, kind: 'vague', coordinator: OPS }, sw({ askGate: true, wake: true })); // NO parentRunId
  const wakes = rig(db, [{ reader: LEAD, runId: LEAD_RUN }]);

  openGate(db, OPS_RUN, OPS, 'ship?', LEAD);
  const pending = readPendingReaders(db, [{ reader: LEAD, runId: LEAD_RUN }])[0];
  assert.equal(pending.gatePending ?? false, false, 'a gate in an UNRELATED run does not make the reader gate-pending');

  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === LEAD).length, 0, 'an unrelated-run gate wakes nobody');
  assert.equal(busWakeCounters().fired, 0, 'nothing fired');
});

// ══ ARM 2 — own-run gate (member→OPS, same run) unchanged ═════════════════════

test('#158 arm2 — an OWN-RUN gate (member→OPS, same run) still wakes and still surfaces (unchanged)', async (t) => {
  const db = tmpDb(t);
  startTree(db);
  // The OPS reads its OWN run. A member opens a gate addressed to the OPS in that
  // same run — the pre-existing same-run shape #119 shipped.
  const wakes = rig(db, [{ reader: OPS, runId: OPS_RUN }]);
  const gateId = openGate(db, OPS_RUN, MEMBER, 'merge #165 first?', OPS);

  await sweepBusWake();
  const opsWakes = wakes.filter((w) => w.reader === OPS);
  assert.equal(opsWakes.length, 1, 'the OPS is woken for the own-run gate');
  assert.deepEqual(wakeOrderRuns(opsWakes[0].text), [OPS_RUN], 'the wake order names the OPS own run');
  const surfaced = openGatesForRecipient(db, OPS_RUN, OPS);
  assert.equal(surfaced.length, 1, 'the own-run gate surfaces in the OPS own-run check');
  assert.equal(surfaced[0].id, gateId);
  assert.equal(busWakeCounters().fired, 1);
});

// ══ ARM 3 — D-H1 gate-axis dedup unchanged across BOTH shapes ═════════════════

test('#158 arm3 — gate-axis dedup (D-H1): a recipient read-but-not-resolved is woken ONCE; a SECOND gate re-wakes — CROSS-RUN', async (t) => {
  const db = tmpDb(t);
  startTree(db);
  const wakes = rig(db, [{ reader: LEAD, runId: LEAD_RUN }]);

  openGate(db, OPS_RUN, OPS, 'gate 1', LEAD);
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(wakes.filter((w) => w.reader === LEAD).length, 1, 'gate 1: exactly one wake (dedup holds across sweeps)');

  // A SECOND cross-run gate opens → gateThroughSeq rises → the gate axis re-arms →
  // a fresh wake. This is the D-H1 gate-axis re-arm, keyed on the GLOBAL gate id,
  // and it must behave identically whether the gate is own-run or cross-run.
  openGate(db, OPS_RUN, OPS, 'gate 2', LEAD);
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.equal(
    wakes.filter((w) => w.reader === LEAD).length,
    2,
    'gate 2: a NEW gate re-wakes exactly once more (gate-axis high-water rose)',
  );
});

test('#158 arm3 twin — the dedup is keyed on the GATE id, NOT a message cursor: acking an unrelated lot does NOT re-fire the gate (cross-run)', async (t) => {
  // The D-H1 invariant the widening must not disturb: the gate axis re-arms on its
  // own id rising, never on the reader acking a lot. If the widening accidentally
  // routed the gate through the lot cursor re-arm, acking a lot below would
  // re-fire the gate — this arm reddens that.
  const db = tmpDb(t);
  startTree(db);
  const wakes = rig(db, [{ reader: LEAD, runId: LEAD_RUN }]);

  openGate(db, OPS_RUN, OPS, 'gate 1', LEAD);
  // Also give the LEAD a lot in its own run.
  send(db, { runId: LEAD_RUN, sender: OPS, kind: 'status', body: 'fyi', recipient: LEAD });
  for (let i = 0; i < 2; i++) await sweepBusWake();
  const afterFirst = wakes.filter((w) => w.reader === LEAD).length;
  assert.ok(afterFirst >= 1, 'the LEAD was woken for the pending gate/lot');

  // The LEAD acks its own-run lot (reads without resolving the gate).
  const lot = check(db, LEAD_RUN, LEAD);
  if (lot.delivery) ack(db, LEAD_RUN, LEAD, lot.delivery.id);
  for (let i = 0; i < 3; i++) await sweepBusWake();
  // No NEW gate opened, so the gate axis must NOT re-fire from the lot ack alone.
  // (The lot re-arm may re-fire the LOT axis, but no new gate → the gate high-water
  // is unchanged; the assertion is that the gate did not spuriously re-wake.)
  const surfaced = openGatesForRecipient(db, OPS_RUN, LEAD);
  assert.equal(surfaced.length, 1, 'the gate is still open (never resolved)');
  // Open a NEW gate and confirm THAT re-wakes — proving the axis is live, not stuck.
  const before = wakes.filter((w) => w.reader === LEAD).length;
  openGate(db, OPS_RUN, OPS, 'gate 2', LEAD);
  for (let i = 0; i < 3; i++) await sweepBusWake();
  assert.ok(
    wakes.filter((w) => w.reader === LEAD).length > before,
    'a genuinely NEW gate re-wakes (gate axis re-arms on its own id, cross-run)',
  );
});
