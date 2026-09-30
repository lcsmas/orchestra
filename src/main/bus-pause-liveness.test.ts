import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { pauseRefusalWith, setRunPause } from './bus-pause.ts';
import {
  sweepBusLiveness,
  setLivenessRoster,
  setLivenessSwitchReader,
  __setBusReaderForTests,
  __setNowForTests,
  __resetBusLivenessForTests,
  __armForTests,
} from './bus-liveness.ts';
import { buildLivenessRoster, type LivenessRosterStore } from './bus-liveness-roster.ts';
import { noteAppStart } from './hibernation-activity.ts';
import { nearestOrchestratorId } from './wave-run-id.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import type { Workspace } from '../shared/types.ts';

// #252 row 15 — liveness SILENCE through the SHIPPED roster builder (`buildLivenessRoster`, the code index.ts wires) and the REAL sweep over a
// REAL bus (btrfs home, never the live bus). The roster asks the SAME live-tree decision the gates use (review D1a F2): the fleet includes an
// orchestrator attached under the paused OPS AFTER creation (its run row's parent_run_id stays NULL). Expectations are literals.

const T0 = 1_700_000_000_000;
const UP_2H = T0 + 2 * 3_600_000;
const ROOT = path.join(os.homedir(), '.cache', `pause-d1a-liveness-${process.pid}`);
const ON = { ...DEFAULT_BUS_SWITCHES, pause: true, liveness: true };
let clock = T0;
let n = 0;

const w = (id: string, over: Partial<Workspace> = {}): Workspace =>
  ({ id, name: id, repoPath: '/r', worktreePath: '/wt', branch: id, baseBranch: 'main', createdAt: T0, status: 'idle', agent: 'claude', ...over }) as Workspace;

/** L ⊃ O ⊃ {m1, S ⊃ m3} ; X ⊃ xm. S was created top-level and attached under O later. Members carry a task (silent 2 h = stale). */
const FLEET: Workspace[] = [
  w('L', { kind: 'orchestrator' }),
  w('O', { kind: 'orchestrator', parentId: 'L' }),
  w('m1', { parentId: 'O', lastTask: 'do' }),
  w('S', { kind: 'orchestrator', parentId: 'O' }),
  w('m3', { parentId: 'S', lastTask: 'do' }),
  w('X', { kind: 'orchestrator' }),
  w('xm', { parentId: 'X', lastTask: 'do' }),
];
const store: LivenessRosterStore = { workspaces: FLEET, getWorkspace: (id) => FLEET.find((x) => x.id === id) };

function setup(t: TestContext, sw = ON): bus.BusDb {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `b${n++}.sqlite`));
  for (const id of ['L', 'O', 'X']) busRuns.startRun(db, { id, kind: 'vague', coordinator: id }, sw);
  busRuns.startRun(db, { id: 'S', kind: 'vague', coordinator: 'S' }, sw); // parent_run_id NULL: attached under O only in the live store
  t.mock.method(Date, 'now', () => clock);
  t.after(() => { __resetBusLivenessForTests(); try { db.close(); } catch { /* */ } fs.rmSync(ROOT, { recursive: true, force: true }); });
  return db;
}

/** Sweep once with the real roster; returns escalation rows per silent member. */
function sweep(db: bus.BusDb): Record<string, number> {
  clock = T0; noteAppStart(); clock = UP_2H;
  const deps = { getWorkspace: (id: string) => store.getWorkspace(id), getBus: () => db };
  const runOf = (ws: Workspace) => nearestOrchestratorId(ws, (id) => store.getWorkspace(id));
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => clock);
  setLivenessSwitchReader(() => true);
  setLivenessRoster(buildLivenessRoster(store, runOf, (ws) => pauseRefusalWith(deps, ws, 'auto') !== null));
  __armForTests();
  sweepBusLiveness();
  const out: Record<string, number> = {};
  for (const m of ['m1', 'm3', 'xm']) {
    out[m] = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE kind='escalation' AND sender=?`).get(m) as { n: number }).n;
  }
  return out;
}

test('SILENCE: members of a paused run — incl. an orchestrator attached under it AFTER creation — are silenced; an unrelated run escalates; the lift re-enables', (t) => {
  const db = setup(t);
  assert.deepEqual(sweep(db), { m1: 1, m3: 1, xm: 1 }, 'control (no pause): every silent member escalates — the instrument can see an escalation');
  db.exec('DELETE FROM messages');
  assert.equal(setRunPause(db, 'O', true, 'O'), 'paused');
  assert.deepEqual(sweep(db), { m1: 0, m3: 0, xm: 1 }, 'm1 (own run) and m3 (re-parented sub-run, live tree) silenced; xm (unrelated) escalates');
  db.exec('DELETE FROM messages');
  assert.equal(setRunPause(db, 'O', false, 'O'), 'lifted');
  assert.deepEqual(sweep(db), { m1: 1, m3: 1, xm: 1 }, 'after the lift every silent member escalates again');
});

test('SWITCH OFF ⇒ INERT: a paused_at on a run whose frozen pause switch is OFF silences nothing (byte-identical to today)', (t) => {
  const db = setup(t, { ...DEFAULT_BUS_SWITCHES, liveness: true });
  assert.equal(setRunPause(db, 'O', true, 'O'), 'switch-off');
  db.prepare("UPDATE runs SET paused_at = 5 WHERE id = 'O'").run();
  assert.deepEqual(sweep(db), { m1: 1, m3: 1, xm: 1 });
});

test('an unreadable pause read silences NOTHING (over-escalate, never hide a stall) and does not throw', (t) => {
  const db = setup(t);
  setRunPause(db, 'O', true, 'O');
  db.exec('ALTER TABLE runs RENAME COLUMN paused_at TO paused_at_renamed'); // the pause read now throws
  assert.deepEqual(sweep(db), { m1: 1, m3: 1, xm: 1 });
});

test('a roster built WITHOUT the pause seam never silences by pause (the pre-#252 roster is unchanged)', (t) => {
  const db = setup(t);
  setRunPause(db, 'O', true, 'O');
  clock = T0; noteAppStart(); clock = UP_2H;
  __resetBusLivenessForTests(); __setBusReaderForTests(() => db); __setNowForTests(() => clock); setLivenessSwitchReader(() => true);
  setLivenessRoster(buildLivenessRoster(store, (ws) => nearestOrchestratorId(ws, (id) => store.getWorkspace(id))));
  __armForTests();
  sweepBusLiveness();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE kind='escalation' AND sender='m1'`).get() as { n: number }).n, 1);
});
