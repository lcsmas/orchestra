import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { setRunPause } from './bus-pause.ts';
import {
  sweepBusLiveness,
  setLivenessRoster,
  setLivenessSwitchReader,
  __setBusReaderForTests,
  __setNowForTests,
  __resetBusLivenessForTests,
  __armForTests,
  type LivenessMember,
} from './bus-liveness.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// #252 row 15 — liveness SILENCE: a paused run AND its descendant runs are held exactly like `run hold`; an unrelated
// run still escalates (positive control); the lift re-enables. Driven through the REAL sweep over a REAL bus
// (btrfs home, never the live bus). Expectations are literals.

const NOW = 1_700_000_000_000;
const ROOT = path.join(os.homedir(), '.cache', `pause-d1a-liveness-${process.pid}`);
const ON = { ...DEFAULT_BUS_SWITCHES, pause: true, liveness: true };
test.after(() => { __resetBusLivenessForTests(); fs.rmSync(ROOT, { recursive: true, force: true }); });

function setup(name: string, sw = ON): bus.BusDb {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `${name}.sqlite`));
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'ops' }, sw);
  busRuns.startRun(db, { id: 'S', kind: 'vague', coordinator: 'sub', parentRunId: 'O' }, sw);
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'xops' }, sw);
  return db;
}

/** One silent (11 min) tasked member per run; returns escalation rows per run. */
function sweep(db: bus.BusDb): Record<string, number> {
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => NOW);
  setLivenessSwitchReader(() => true);
  setLivenessRoster(() =>
    ['O', 'S', 'X'].map((r): LivenessMember => ({
      reader: `w-${r}`, coordinator: `c-${r}`, hasTask: true, lastActivityAt: NOW - 11 * 60 * 1000,
      running: false, waiting: false, runId: r,
    })),
  );
  __armForTests();
  sweepBusLiveness();
  const out: Record<string, number> = {};
  for (const r of ['O', 'S', 'X']) {
    out[r] = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND kind='escalation' AND sender=?`).get(r, `w-${r}`) as { n: number }).n;
  }
  return out;
}

test('SILENCE: a paused run and its DESCENDANT run are silenced; an unrelated run escalates; the lift re-enables', () => {
  const db = setup('silence');
  assert.equal(setRunPause(db, 'O', true, 'ops'), 'paused');
  assert.deepEqual(sweep(db), { O: 0, S: 0, X: 1 }, 'paused O + descendant S silenced, X (positive control) escalates');
  assert.equal(setRunPause(db, 'O', false, 'ops'), 'lifted');
  const db2 = setup('silence-after');
  assert.deepEqual(sweep(db2), { O: 1, S: 1, X: 1 }, 'control: with no pause every silent member escalates (the instrument can see an escalation)');
  db.close();
  db2.close();
});

test('SWITCH OFF ⇒ INERT: a paused_at on a run whose frozen pause switch is OFF silences nothing (byte-identical to today)', () => {
  const db = setup('off', { ...DEFAULT_BUS_SWITCHES, liveness: true });
  assert.equal(setRunPause(db, 'O', true, 'ops'), 'switch-off');
  db.prepare("UPDATE runs SET paused_at = 5 WHERE id = 'O'").run();
  assert.deepEqual(sweep(db), { O: 1, S: 1, X: 1 });
  db.close();
});

test('an unreadable pause read silences NOTHING (over-escalate, never hide a stall) and does not throw', () => {
  const db = setup('broken');
  setRunPause(db, 'O', true, 'ops');
  db.exec('ALTER TABLE runs RENAME COLUMN paused_at TO paused_at_renamed'); // the pause read now throws
  assert.deepEqual(sweep(db), { O: 1, S: 1, X: 1 });
  db.close();
});
