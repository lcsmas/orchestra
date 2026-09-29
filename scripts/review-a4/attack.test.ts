import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
const W = '/home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340/src';
const bus: any = await import(`${W}/main/bus.ts`);
const runs: any = await import(`${W}/main/bus-runs.ts`);
const L: any = await import(`${W}/main/bus-liveness.ts`);
const NOW = 1_700_000_000_000;
const ON = { delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true };
let dirs: string[] = [];
function tmp(t: any) {
  const dir = fs.mkdtempSync('/home/lmas/rev-a4-scratch/db-'); const db = bus.openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); L.__resetBusLivenessForTests(); });
  return { db, dir };
}
const m = (o: any = {}) => ({ reader: 'ws-worker', coordinator: 'ws-ops', hasTask: true, lastActivityAt: NOW - 11 * 60000, running: false, waiting: false, runId: 'R', ...o });
function arm(db: any, roster: () => any[], now = () => NOW) {
  L.__resetBusLivenessForTests(); L.__setBusReaderForTests(() => db); L.__setNowForTests(now); L.setLivenessSwitchReader(() => true); L.setLivenessRoster(roster); L.__armForTests();
}
const esc = (db: any, run: string, to: string, from: string) => Number((db.prepare(`SELECT COUNT(*) n FROM messages WHERE run_id=? AND kind='escalation' AND recipient=? AND sender=?`).get(run, to, from) as any).n);

test('A1 wedged member: running, NO in-flight tool, silent 6h, shields its idle OPS forever', (t) => {
  const { db } = tmp(t);
  const idleOps = m({ reader: 'ws-ops', coordinator: 'ws-lead', lastActivityAt: NOW - 6 * 3600e3 });
  const wedged = m({ reader: 'w-wedged', coordinator: 'ws-ops', running: true, inFlightTools: [], lastActivityAt: NOW - 6 * 3600e3 });
  arm(db, () => [idleOps, wedged]); L.sweepBusLiveness();
  console.log('A1 wedged: OPS->lead escalations =', esc(db, 'R', 'ws-lead', 'ws-ops'), ' wedged->OPS =', esc(db, 'R', 'ws-ops', 'w-wedged'));
  // control: same OPS, member merely idle (not running) → escalates
  const { db: db2 } = tmp(t);
  arm(db2, () => [idleOps, { ...wedged, running: false }]); L.sweepBusLiveness();
  console.log('A1 control (member idle): OPS->lead =', esc(db2, 'R', 'ws-lead', 'ws-ops'));
});

test('A2 churn: worker flaps idle/running; OPS silence unchanged → re-escalations for the SAME silence', (t) => {
  const { db } = tmp(t);
  let workerRunning = false;
  arm(db, () => [m({ reader: 'ws-ops', coordinator: 'ws-lead' }), m({ reader: 'w', coordinator: 'ws-ops', running: workerRunning, lastActivityAt: NOW - 30000 })]);
  const seq: number[] = [];
  for (const r of [false, true, false, true, false, true, false]) { workerRunning = r; L.sweepBusLiveness(); seq.push(esc(db, 'R', 'ws-lead', 'ws-ops')); }
  console.log('A2 cumulative OPS->lead rows over sweeps [idle,run,idle,run,idle,run,idle] =', JSON.stringify(seq));
});

test('A3 hold→resume re-escalates the SAME silence (ledger pruned while held)', (t) => {
  const { db } = tmp(t);
  runs.startRun(db, { id: 'R', kind: 'vague', coordinator: 'ws-ops' }, ON);
  arm(db, () => [m()]); L.sweepBusLiveness();
  const a = esc(db, 'R', 'ws-ops', 'ws-worker');
  runs.setRunHold(db, 'R', true); L.sweepBusLiveness(); const b = esc(db, 'R', 'ws-ops', 'ws-worker');
  runs.setRunHold(db, 'R', false); L.sweepBusLiveness(); const c = esc(db, 'R', 'ws-ops', 'ws-worker');
  console.log(`A3 rows: before hold=${a} during hold=${b} after resume=${c}`);
});

test('A4 hold of the PARENT run does not cascade to a child OPS run', (t) => {
  const { db } = tmp(t);
  runs.startRun(db, { id: 'LEADRUN', kind: 'mission', coordinator: 'ws-lead' }, ON);
  runs.startRun(db, { id: 'OPSRUN', kind: 'vague', coordinator: 'ws-ops', parentRunId: 'LEADRUN' }, ON);
  runs.setRunHold(db, 'LEADRUN', true);
  arm(db, () => [m({ reader: 'ws-ops', coordinator: 'ws-lead', runId: 'OPSRUN' }), m({ reader: 'w', coordinator: 'ws-ops', runId: 'OPSRUN' })]);
  L.sweepBusLiveness();
  console.log('A4 hold LEADRUN; OPS(OPSRUN)->lead =', esc(db, 'OPSRUN', 'ws-lead', 'ws-ops'), ' w->OPS =', esc(db, 'OPSRUN', 'ws-ops', 'w'));
});

test('A9 running member with hasTask=false (hand-nested UI ws) shields OPS', (t) => {
  const { db } = tmp(t);
  arm(db, () => [m({ reader: 'ws-ops', coordinator: 'ws-lead' }), m({ reader: 'ui', coordinator: 'ws-ops', hasTask: false, running: true, lastActivityAt: NOW - 1000 })]);
  L.sweepBusLiveness();
  console.log('A9 OPS->lead with running no-task child =', esc(db, 'R', 'ws-lead', 'ws-ops'));
});

test('A10 sibling arm: an IDLE silent worker beside a RUNNING sibling under the same OPS still escalates', (t) => {
  const { db } = tmp(t);
  arm(db, () => [m({ reader: 'ws-ops', coordinator: 'ws-lead', lastActivityAt: NOW - 30000 }), m({ reader: 'w-run', coordinator: 'ws-ops', running: true, lastActivityAt: NOW - 30000 }), m({ reader: 'w-idle', coordinator: 'ws-ops' })]);
  L.sweepBusLiveness();
  console.log('A10 idle silent sibling->OPS =', esc(db, 'R', 'ws-ops', 'w-idle'), '(want 1)');
});

test('A7 any process can hold/resume ANY run via the built CLI (no authorization)', (t) => {
  const home = fs.mkdtempSync('/home/lmas/rev-a4-scratch/home-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = bus.openBus(path.join(home, 'bus.sqlite')); runs.startRun(db, { id: 'run-victim', kind: 'vague', coordinator: 'ops-v' }, ON); runs.startRun(db, { id: 'run-mine', kind: 'vague', coordinator: 'ops-m' }, ON); db.close();
  const cli = (args: string[], run: string) => { try { return { rc: 0, out: execFileSync(process.execPath, ['/home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340/dist-electron/cli.js', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: path.join(home, 'no.sock'), ORCHESTRA_WS_ID: 'some-unrelated-worker', ORCHESTRA_RUN_ID: run }, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e: any) { return { rc: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') }; } };
  const r1 = cli(['run', 'hold', '--run', 'run-victim'], 'run-mine');
  const d2 = bus.openBus(path.join(home, 'bus.sqlite')); const held = [...runs.heldRunIds(d2)]; d2.close();
  console.log('A7 worker of run-mine: `run hold --run run-victim` rc=', r1.rc, JSON.stringify(r1.out.trim()), ' held=', JSON.stringify(held));
});
