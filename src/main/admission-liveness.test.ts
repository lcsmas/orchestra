import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
import { sweepBusLiveness, setLivenessRoster, setLivenessSwitchReader, __setBusReaderForTests, __setNowForTests, __resetBusLivenessForTests, __armForTests, STALE_AFTER_MS } from './bus-liveness.ts';
import { buildLivenessRoster, type LivenessRosterStore } from './bus-liveness-roster.ts';
import { noteAppStart } from './hibernation-activity.ts';
import { __rebuildAdmissionForTests, admissionGate, heldStartFor, stopAdmission } from './admission.ts';
import { GIB, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import type { Workspace } from '../shared/types.ts';

// G3 review F3 — a member whose start is HELD for memory is not "silent": the OPS was told "accepted, held", and the 10-min liveness escalation
// would be exactly the false stall the HELD marker exists to prevent. The REAL roster builder + the REAL sweep over a REAL bus, with the roster's
// silence predicate wired the way index.ts wires it (pinned on source text in admission-wiring.test.ts), and the REAL admission queue.

const RUN = 'run-g3';
const T0 = 1_700_000_000_000;
const MIN = 60_000;
let clock = T0;
const at = (ms: number): void => { clock = ms; };

const w = (over: Partial<Workspace>): Workspace =>
  ({ name: 'n', repoPath: '/r', worktreePath: '/wt', baseBranch: 'main', createdAt: T0 - 3 * 24 * 3_600_000, status: 'idle', agent: 'claude', ...over, branch: over.id }) as Workspace;
const OPS = w({ id: 'g3-ops', lastTask: undefined });
const M1 = w({ id: 'g3-m1', parentId: 'g3-ops', lastTask: 'do' });
const STORE: LivenessRosterStore = { workspaces: [OPS, M1], getWorkspace: (id) => [OPS, M1].find((x) => x.id === id) };

function tmpBus(t: TestContext): BusDb {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'g3-liveness-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    stopAdmission();
    __resetBusLivenessForTests();
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => clock);
  return db;
}

function snap(memGb: number): MemoryGuardSnapshot {
  return {
    sampled: true, measured: true, availBytes: memGb * GIB, readAt: 1, admission: memGb < 6 ? 'held' : 'open', admissionEnabled: true, pause: 'none', episode: 1, pauseCycle: 0,
    mayReleaseOneStart: memGb > 7, heldSince: null, pauseSince: null, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, sampleIntervalMs: 10_000,
  };
}

function wire(db: BusDb, silencedByHeld: boolean): void {
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => clock);
  setLivenessSwitchReader(() => true);
  // index.ts: `(ws) => pauseRefusal(ws, 'auto') !== null || heldStartFor(ws.id) !== null` — the pause half is irrelevant here (no run is paused).
  setLivenessRoster(buildLivenessRoster(STORE, () => RUN, silencedByHeld ? (ws) => heldStartFor(ws.id) !== null : undefined));
  __armForTests();
}

const escalations = (db: BusDb): number =>
  Number((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND kind='escalation' AND recipient='g3-ops' AND sender='g3-m1'").get(RUN) as { n: number }).n);

function holdM1(): void {
  __rebuildAdmissionForTests({ sample: () => snap(4), now: () => clock, schedule: () => ({}), cancel: () => {}, sleep: async () => {}, info: () => {}, warn: () => {} });
  const r = admissionGate({ wsId: 'g3-m1', ws: { parentId: 'g3-ops' }, origin: 'auto', kind: 'spawn', coordinator: false, run: async () => ({ ok: true }), stillOwed: () => true });
  assert.equal(r.held, true, 'control: the start really is held');
}

test('F3 control: WITHOUT the held predicate a silent member (11 min, live coordinator) IS escalated — the sweep can see a stall', (t) => {
  const db = tmpBus(t);
  at(T0); noteAppStart(); at(T0 + STALE_AFTER_MS + MIN);
  holdM1();
  wire(db, false);
  sweepBusLiveness();
  assert.equal(escalations(db), 1);
});

test('F3: a member whose start is HELD for memory is NOT escalated as silent (the real roster predicate, the real sweep, the real queue)', (t) => {
  const db = tmpBus(t);
  at(T0); noteAppStart(); at(T0 + STALE_AFTER_MS + MIN);
  holdM1();
  wire(db, true);
  sweepBusLiveness();
  assert.equal(escalations(db), 0, 'held for memory → not a stall');
  at(T0 + 3 * STALE_AFTER_MS);
  sweepBusLiveness();
  assert.equal(escalations(db), 0, 'still none a long time later while it stays held');
});

test('F3: once the held start is released (or dropped) the member is an ordinary silent member again', (t) => {
  const db = tmpBus(t);
  at(T0); noteAppStart(); at(T0 + STALE_AFTER_MS + MIN);
  holdM1();
  wire(db, true);
  sweepBusLiveness();
  assert.equal(escalations(db), 0);
  stopAdmission(); // the queue is gone (released / deleted)
  assert.equal(heldStartFor('g3-m1'), null);
  sweepBusLiveness();
  assert.equal(escalations(db), 1, 'no longer held → the stall is real and escalates');
});
