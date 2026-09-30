// #252 D1b — `orchestra run status`: the Bilan de pause a coordinator reads. Real bus + migrations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from '../main/bus.ts';
import { startRun, getRun } from '../main/bus-runs.ts';
import * as busPause from '../main/bus-pause.ts';
import * as records from '../main/bus-pause-records.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { gatherRunStatus, renderRunStatus, type RunStatusDeps } from './run-status.ts';

const deps: RunStatusDeps = {
  getRunPause: busPause.getRunPause,
  activePauseFor: busPause.activePauseFor,
  listBilanForRun: records.listBilanForRun,
  runExists: (d, id) => getRun(d, id) !== null,
};

function rig(t: { after: (f: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-status-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
  startRun(db, { id: 'M', kind: 'mission', coordinator: 'lead' }, sw);
  startRun(db, { id: 'W', kind: 'vague', coordinator: 'ops', parentRunId: 'M' }, sw);
  return db;
}

test('not paused: says so, no Bilan', (t) => {
  const db = rig(t);
  const st = gatherRunStatus(db, 'W', deps);
  assert.equal(st.pause, null);
  assert.match(renderRunStatus(st), /Run W: not paused\./);
});

test('unknown run: says it has no row (never a silent "not paused")', (t) => {
  const db = rig(t);
  assert.match(renderRunStatus(gatherRunStatus(db, 'nope', deps)), /no row in the bus 'runs' table/);
});

test('paused + trap owed: says the host trap is NOT FINISHED; paused + done: DONE', (t) => {
  const db = rig(t);
  assert.equal(busPause.setRunPause(db, 'W', true, 'ops'), 'paused');
  assert.match(renderRunStatus(gatherRunStatus(db, 'W', deps)), /PAUSED \(hard\).*by ops.*\nHost trap: NOT FINISHED/s);
  const p = busPause.getRunPause(db, 'W')!;
  records.markTrapDone(db, 'W', p.pausedAt, p.pausedAt + 5);
  assert.match(renderRunStatus(gatherRunStatus(db, 'W', deps)), /Host trap: DONE at /);
});

test('the Bilan renders: dirty tree, snapshot ref, what it was doing, killed commands, survivors, notes, error', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W',
    wsId: 'ws-impl',
    pausedAt: p.pausedAt,
    activity: {
      surface: 'sdk', memberRun: 'W', turnRunning: true, branch: 'feature-x', head: 'abcdef1234567',
      changed: { modified: 2, added: 1, deleted: 0 },
      inFlightTools: [{ tool: 'Bash', toolUseId: 't', sinceMs: 42_000 }],
      bgTasks: [{ id: 'b', type: 'shell', description: 'pnpm test rig', status: 'running' }],
      interrupt: 'interrupted', notes: ['turn started while paused at X'],
    },
    snapshotRef: 'refs/orchestra/pause/W/ws-impl/123',
    dirty: true,
    killed: { killed: [{ pid: 7, cmd: 'sleep 600', signal: 'SIGTERM', outcome: 'exited' }], survivors: [{ pid: 9, cmd: 'stuck', reason: 'unreadable' }], refused: [], spared: [{ pid: 3, cmd: 'lazy-mcp.mjs' }] },
    error: 'kill: 1 tool process(es) still alive after the trap',
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  for (const needle of [
    'ws-impl [feature-x] — dirty tree: yes (2 modified, 1 added, 0 deleted)',
    'snapshot: refs/orchestra/pause/W/ws-impl/123',
    'git diff abcdef123 refs/orchestra/pause/W/ws-impl/123',
    'was doing: turn running · in-flight Bash 42s · background shell "pnpm test rig" (running)',
    'interrupt: interrupted',
    'killed: 1 tool process(es) — sleep 600 (pid 7)',
    'STILL ALIVE: stuck (pid 9: unreadable)',
    'left running (not tool processes): lazy-mcp.mjs',
    'note: turn started while paused at X',
    'error: kill: 1 tool process(es) still alive after the trap',
    'nothing restarts on its own',
  ]) assert.ok(text.includes(needle), `missing: ${needle}\n${text}`);
});

test('a DESCENDANT run reads the ANCESTOR pause, names the carrier to lift, and sees only its own members', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'M', true, 'lead');
  const p = busPause.getRunPause(db, 'M')!;
  const mk = (ws: string, run: string) => records.insertBilan(db, { runId: 'M', wsId: ws, pausedAt: p.pausedAt, activity: { surface: 'none', memberRun: run }, snapshotRef: null, dirty: false, killed: { skipped: 'x' }, error: null });
  mk('lead-ws', 'M');
  mk('w1', 'W');
  const st = gatherRunStatus(db, 'W', deps);
  assert.equal(st.inherited, true);
  assert.deepEqual(st.bilan.map((r) => r.wsId), ['w1']);
  assert.match(renderRunStatus(st), /carried by ancestor run M; lift it with: orchestra run resume --run M/);
});

test('--json shape is the RunStatus object (machine-readable Bilan)', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const st = JSON.parse(JSON.stringify(gatherRunStatus(db, 'W', deps)));
  assert.deepEqual(Object.keys(st).sort(), ['bilan', 'inherited', 'pause', 'runExists', 'runId']);
  assert.equal(st.pause.runId, 'W');
});
