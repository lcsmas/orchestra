// #292 — the Reprise restarts EXACTLY the containers the Pause stopped, BEFORE any coordinator is released (ledger #295 FI-1.7), over a REAL bus.
// The begin PARKS the coordinators while a restart is owed (gate closed, no `reprise` row); the host's container step restarts them, then the sweep releases.
// Every arm names the clause an in-place mutant breaks (scripts/docker-relay-mutants.mjs "P*").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { beginReprise, getRunPause, pausedCarrierForWorkspace, setRunPause } from './bus-pause.ts';
import { bilanForMember, insertBilan } from './bus-pause-records.ts';
import { containersOwed, finishRepriseIfDone, readCarrierColumns, readRoster, releaseMembers, setLiveTreeSource, sweepReprise } from './pause-reprise.ts';
import { restartOwedContainers } from './pause-containers.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import type { BilanContainers, ContainerStopEntry } from '../shared/pause-containers.ts';
import type { WaveNode } from './wave-run-id.ts';
import { FakeDocker } from './fake-docker.ts';

const ROOT = path.join(os.homedir(), '.cache', `pause-containers-reprise-${process.pid}`);
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const ON = { ...DEFAULT_BUS_SWITCHES, pause: true };

const NODES: WaveNode[] = [
  { id: 'L', kind: 'orchestrator' },
  { id: 'O', kind: 'orchestrator', parentId: 'L' },
  { id: 'o1', parentId: 'O' },
];
const byId = new Map(NODES.map((w) => [w.id, w]));
const stop = (id: string, outcome: ContainerStopEntry['outcome'] = 'stopped', name = id): ContainerStopEntry => ({ id, name, image: 'mysql:8', run: 'O', outcome, atMs: 1 });

function rig(containersByWs: Record<string, BilanContainers | undefined>) {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `r${n++}.sqlite`));
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  setLiveTreeSource(() => ({ get: (id) => byId.get(id), ids: () => NODES.map((w) => w.id) }));
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O']] as const) {
    insertBilan(db, {
      runId: 'L',
      wsId: ws,
      pausedAt,
      activity: { surface: 'sdk', memberRun: run, branch: `br-${ws}`, head: `h${ws}0000000000`, ...(containersByWs[ws] ? { containers: containersByWs[ws] } : {}) },
      snapshotRef: `refs/orchestra/pause/L/${ws}/1`,
      dirty: false,
      killed: { killed: [], survivors: [], refused: [], spared: [] },
      error: null,
    });
  }
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 5, 'L');
  const sweepDeps = { getBus: () => db, members: () => [], subtree: (_d: bus.BusDb, id: string) => (id === 'L' ? ['L', 'O'] : [id]), storeReady: () => true };
  return { db, pausedAt, sweepDeps };
}
const repriseRows = (db: bus.BusDb) => db.prepare("SELECT recipient, sender, body FROM messages WHERE kind = 'reprise' ORDER BY sequence").all() as Array<{ recipient: string; sender: string; body: string }>;
const containersOf = (db: bus.BusDb, ws: string, pausedAt: number) => bilanForMember(db, 'L', ws, pausedAt)!.activity!.containers!;
const stoppedDocker = () => new FakeDocker([{ id: 'db', name: 'g-db', running: false }, { id: 'web', name: 'g-web', running: false }, { id: 'rm', name: 'once', running: true, autoRemove: true }, { id: 'human', name: 'mine', running: false /* the human's own, stopped by the human */ }]);

test('NOTHING stopped ⇒ NOTHING deferred: the begin releases the coordinators at once, exactly as before #292 (switch-OFF / no-container runs are untouched)', () => {
  const { db } = rig({});
  assert.equal(containersOwed(db, 'L'), false);
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  assert.equal(repriseRows(db).length, 2, 'both coordinators got their reprise row in the begin');
  assert.ok(readRoster(db, 'L', getRunPause(db, 'L')!.pausedAt).filter((r) => r.role === 'coordinator').every((r) => r.releasedAt !== null));
  db.close();
});

test('OWED ⇒ the begin PARKS the coordinators: no reprise row, gate still closed, roster released_at NULL; the run stays RESUMING (FI-1.7: containers first)', () => {
  const { db, pausedAt } = rig({ o1: { stopped: [stop('db'), stop('web')] } });
  assert.equal(containersOwed(db, 'L'), true);
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  assert.equal(repriseRows(db).length, 0, 'no Consigne goes out before the containers are back');
  const coords = readRoster(db, 'L', pausedAt).filter((r) => r.role === 'coordinator');
  assert.ok(coords.length > 0 && coords.every((r) => r.releasedAt === null), 'the gate for the coordinators is still closed');
  assert.notEqual(pausedCarrierForWorkspace(db, byId.get('O')!, (id) => byId.get(id)), null, 'O is still blocked by the Pause');
  // the periodic sweep alone must NOT release them while a restart is owed
  sweepReprise(sweepDepsOf(db));
  assert.equal(repriseRows(db).length, 0);
  assert.notEqual(readCarrierColumns(db, 'L')!.resumeStartedAt, null, 'still RESUMING');
  db.close();
});

function sweepDepsOf(db: bus.BusDb) {
  return { getBus: () => db, members: () => [], subtree: (_d: bus.BusDb, id: string) => (id === 'L' ? ['L', 'O'] : [id]), storeReady: () => true };
}

test('the host\'s container step starts EXACTLY the outcome:stopped entries (not --rm/failed ones, not unattributed), records `restarted`, and ONLY THEN are the coordinators released with a Consigne naming them', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [stop('db', 'stopped', 'g-db'), stop('web', 'stopped', 'g-web'), stop('rm', 'skipped-autoremove'), stop('bad', 'failed')] } });
  beginReprise(db, 'L', 'L');
  const d = stoppedDocker();
  const started = await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.equal(started, 2);
  assert.deepEqual(d.calls.filter((c) => c.startsWith('start')).sort(), ['start db', 'start web'], 'exactly the stopped ones');
  assert.equal(d.running('human'), false, 'an unattributed container is never started');
  assert.deepEqual(containersOf(db, 'o1', pausedAt).restarted!.map((x) => [x.id, x.outcome]).sort(), [['db', 'started'], ['web', 'started']]);
  assert.equal(containersOwed(db, 'L'), false);
  assert.equal(repriseRows(db).length, 0, 'the container step itself releases nobody');
  sweepReprise(sweepDepsOf(db));
  assert.equal(repriseRows(db).length, 2, 'now both coordinators are released');
  assert.ok(readRoster(db, 'L', pausedAt).filter((r) => r.role === 'coordinator').every((r) => r.releasedAt !== null && !String(r.releasedBy).startsWith('pending')));
  // a worker's Consigne (sent when its coordinator releases it) lists its containers
  const rel = releaseMembers(db, 'L', 'O', ['o1']);
  assert.deepEqual(rel.released, ['o1']);
  const body = repriseRows(db).find((r) => r.recipient === 'o1')!.body;
  assert.match(body, /Containers the Pause STOPPED for you \(2/);
  assert.match(body, /g-db \(mysql:8\) — restarted by the Reprise/);
  assert.match(body, /Nothing was restarted for you except the containers listed below/);
  assert.match(body, /\(mysql:8\) — .*\n.*g-web/s);
  db.close();
});

test('a container REMOVED BY HAND during the Pause does not break the Reprise: 404 → `gone` (reported, skipped), the others start, the coordinators are released', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [stop('db'), stop('ghost', 'stopped', 'removed-by-hand')] } });
  beginReprise(db, 'L', 'L');
  const d = stoppedDocker();
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.deepEqual(containersOf(db, 'o1', pausedAt).restarted!.map((x) => [x.id, x.outcome]).sort(), [['db', 'started'], ['ghost', 'gone']]);
  sweepReprise(sweepDepsOf(db));
  assert.equal(repriseRows(db).length, 2, 'the Reprise went on');
  releaseMembers(db, 'L', 'O', ['o1']);
  assert.match(repriseRows(db).find((r) => r.recipient === 'o1')!.body, /GONE \(removed while the Pause lasted\)/);
  db.close();
});

test('Docker DOWN at the Reprise: every owed restart is recorded `failed` (never retried forever, never a stuck Reprise) and the coordinators are released; a start that throws → failed with the error', async () => {
  const a = rig({ o1: { stopped: [stop('db')] } });
  beginReprise(a.db, 'L', 'L');
  await restartOwedContainers({ getBus: () => a.db, api: null, now: () => 5 }); // the host has no Docker
  assert.deepEqual(containersOf(a.db, 'o1', a.pausedAt).restarted!.map((x) => [x.id, x.outcome]), [['db', 'failed']]);
  assert.match(containersOf(a.db, 'o1', a.pausedAt).restarted![0].error ?? '', /not available/);
  sweepReprise(sweepDepsOf(a.db));
  assert.equal(repriseRows(a.db).length, 2);
  releaseMembers(a.db, 'L', 'O', ['o1']);
  assert.match(repriseRows(a.db).find((r) => r.recipient === 'o1')!.body, /restart FAILED .* start it yourself: docker start db/);
  a.db.close();
  const b = rig({ o1: { stopped: [stop('db'), stop('web')] } });
  beginReprise(b.db, 'L', 'L');
  const d = stoppedDocker();
  d.failStart.add('web');
  await restartOwedContainers({ getBus: () => b.db, api: d, now: () => 5 });
  assert.deepEqual(containersOf(b.db, 'o1', b.pausedAt).restarted!.map((x) => [x.id, x.outcome]).sort(), [['db', 'started'], ['web', 'failed']]);
  b.db.close();
});

test('IDEMPOTENT: a second container step restarts nothing again; a begin\'s attribution survives the deferral — a HUMAN Reprise releases AS the human, an auto/host one as host', async () => {
  const h = rig({ o1: { stopped: [stop('db')] } });
  assert.equal(beginReprise(h.db, 'L', 'humain', { human: true }), 'resuming');
  const d = stoppedDocker();
  await restartOwedContainers({ getBus: () => h.db, api: d, now: () => 1 });
  const first = d.calls.length;
  await restartOwedContainers({ getBus: () => h.db, api: d, now: () => 2 });
  assert.equal(d.calls.length, first, 'nothing started a second time');
  sweepReprise(sweepDepsOf(h.db));
  assert.ok(repriseRows(h.db).every((r) => r.sender === 'humain'), `the human's Reprise is attributed to the human: ${repriseRows(h.db).map((r) => r.sender)}`);
  assert.ok(readRoster(h.db, 'L', h.pausedAt).filter((r) => r.role === 'coordinator').every((r) => r.releasedBy === 'humain'));
  h.db.close();
  const a = rig({ o1: { stopped: [stop('db')] } });
  assert.equal(beginReprise(a.db, 'L', 'host', { host: true, reason: 'usage_limit' }), 'resuming'); // the automatic Reprise: same path
  await restartOwedContainers({ getBus: () => a.db, api: stoppedDocker(), now: () => 1 });
  sweepReprise(sweepDepsOf(a.db));
  assert.ok(repriseRows(a.db).every((r) => r.sender === 'host'));
  a.db.close();
});

test('only the coordinators PARKED at the begin are released by the container step — a pending run with a restart still owed releases NOBODY, even through the sweep\'s late pass', () => {
  const { db, pausedAt } = rig({ o1: { stopped: [stop('db')] }, O: { stopped: [stop('cache')] } });
  beginReprise(db, 'L', 'L');
  for (let i = 0; i < 3; i++) sweepReprise(sweepDepsOf(db));
  assert.equal(repriseRows(db).length, 0);
  assert.ok(readRoster(db, 'L', pausedAt).every((r) => r.releasedAt === null));
  db.close();
});

test('the run does NOT go active while a restart is owed — members released early (the human, an outer coordinator) cannot close the Reprise over stopped containers; once the host\'s step ran it finishes', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [stop('db')] } });
  beginReprise(db, 'L', 'L');
  releaseMembers(db, 'L', 'L', ['o1', 'O']); // an early release by the carrier's coordinator, before the container step
  assert.equal(finishRepriseIfDone(db, 'L'), false, 'owed ⇒ never active');
  assert.notEqual(readCarrierColumns(db, 'L')!.resumeStartedAt, null);
  const d = stoppedDocker();
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 1 });
  sweepReprise(sweepDepsOf(db));
  releaseMembers(db, 'L', 'L', 'all');
  releaseMembers(db, 'L', 'O', 'all');
  assert.equal(finishRepriseIfDone(db, 'L') || readCarrierColumns(db, 'L')!.pausedAt === null, true, 'closed once nothing is owed');
  assert.equal(containersOwed(db, 'L'), false);
  assert.equal(pausedAt > 0, true);
  db.close();
});

test('a RE-PAUSE between the begin and the container step opens a new epoch — the EARLIER epoch\'s stopped container is still owed and is restarted (once) at the next Reprise, the result recorded on each row that owed it', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [stop('db', 'stopped', 'g-db')] } });
  beginReprise(db, 'L', 'L'); // E1: parked, restart owed
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused'); // re-Pause while RESUMING → a NEW epoch (the old Bilan stays as history)
  const e2 = getRunPause(db, 'L')!.pausedAt;
  assert.notEqual(e2, pausedAt, 'a new epoch');
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O']] as const) {
    insertBilan(db, { runId: 'L', wsId: ws, pausedAt: e2, activity: { surface: 'sdk', memberRun: run, ...(ws === 'o1' ? { containers: { stopped: [stop('db', 'stopped', 'g-db')] } } : {}) }, snapshotRef: 'r', dirty: false, killed: { killed: [], survivors: [], refused: [], spared: [] }, error: null }); // E2's trap stopped it AGAIN (someone restarted it)
  }
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(e2 + 1, 'L');
  assert.equal(containersOwed(db, 'L'), true, 'carrier-wide: the old epoch still owes');
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  const d = stoppedDocker();
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.equal(d.calls.filter((c) => c === 'start db').length, 1, 'one container id is started ONCE although two epochs owe it');
  assert.equal(containersOf(db, 'o1', pausedAt).restarted![0].outcome, 'started');
  assert.equal(containersOf(db, 'o1', e2).restarted![0].outcome, 'started');
  assert.equal(containersOwed(db, 'L'), false);
  // an old epoch that only the NEW trap forgot: with no E2 entry at all it is still restarted
  db.close();
  const x = rig({ o1: { stopped: [stop('old')] } });
  beginReprise(x.db, 'L', 'L');
  setRunPause(x.db, 'L', true, 'L');
  const e3 = getRunPause(x.db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O']] as const) insertBilan(x.db, { runId: 'L', wsId: ws, pausedAt: e3, activity: { surface: 'sdk', memberRun: run }, snapshotRef: 'r', dirty: false, killed: { killed: [], survivors: [], refused: [], spared: [] }, error: null }); // E2 trap listed nothing (the container was already down)
  x.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(e3 + 1, 'L');
  beginReprise(x.db, 'L', 'L');
  const d2 = new FakeDocker([{ id: 'old', name: 'old', running: false }]);
  await restartOwedContainers({ getBus: () => x.db, api: d2, now: () => 5 });
  assert.equal(d2.running('old'), true, 'orphaned by the epoch change in the old code: now restarted');
  x.db.close();
});

test('the Reprise restarts each container through the client of the member that OWNED it (apiFor), falling back to the app\'s client', async () => {
  const { db } = rig({ o1: { stopped: [stop('db')] }, O: { stopped: [stop('cache')] } });
  beginReprise(db, 'L', 'L');
  const forO1 = new FakeDocker([{ id: 'db', name: 'db', running: false }]);
  const dflt = new FakeDocker([{ id: 'cache', name: 'cache', running: false }]);
  await restartOwedContainers({ getBus: () => db, api: dflt, apiFor: (ws) => (ws === 'o1' ? forO1 : null), now: () => 1 });
  assert.equal(forO1.running('db'), true);
  assert.deepEqual(forO1.calls, ['start db']);
  assert.equal(dflt.running('cache'), true);
  assert.deepEqual(dflt.calls, ['start cache']);
  db.close();
});

// ── G8 follow-up (review #1–#4) ─────────────────────────────────────────────────────────────────────────────────────────

test('#4 the Reprise restarts in the REVERSE of the stop order — across members too (what the dependents need comes up first)', async () => {
  const { db } = rig({
    o1: { stopped: [{ ...stop('app'), atMs: 10 }, { ...stop('cache'), atMs: 15 }] },
    O: { stopped: [{ ...stop('db'), atMs: 20 }] },
  });
  beginReprise(db, 'L', 'L');
  const d = new FakeDocker([{ id: 'app', name: 'app', running: false }, { id: 'cache', name: 'cache', running: false }, { id: 'db', name: 'db', running: false }]);
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 99 });
  assert.deepEqual(d.calls.filter((c) => c.startsWith('start')), ['start db', 'start cache', 'start app']);
  db.close();
});

test('#1 a re-Pause that lands MID-STEP stops the step before the next container: later ones stay OWED (no result recorded) and nothing starts under the new Pause', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [{ ...stop('c1'), atMs: 30 }, { ...stop('c2'), atMs: 20 }, { ...stop('c3'), atMs: 10 }] } });
  beginReprise(db, 'L', 'L');
  const d = new FakeDocker([{ id: 'c1', name: 'c1', running: false }, { id: 'c2', name: 'c2', running: false }, { id: 'c3', name: 'c3', running: false }]);
  d.beforeStart = (id) => {
    if (id === 'c2') assert.equal(setRunPause(db, 'L', true, 'L'), 'paused'); // the human re-Pauses while c2 is being started
  };
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.deepEqual(d.calls.filter((c) => c.startsWith('start')), ['start c1', 'start c2']);
  assert.equal(d.running('c3'), false, 'c3 stays down under the new Pause');
  assert.deepEqual(containersOf(db, 'o1', pausedAt).restarted!.map((x) => x.id).sort(), ['c1', 'c2'], 'only what was started is recorded');
  assert.equal(containersOwed(db, 'L'), true, 'c3 is still owed to the NEXT Reprise');
  db.close();
});

const containersOfCarrier = (db: bus.BusDb, carrier: string, ws: string, pausedAt: number) => bilanForMember(db, carrier, ws, pausedAt)!.activity!.containers!;

/** Carrier O (a child run) paused first with a stopped DB, then its parent L paused on top; each carrier has its own Bilan rows (what each trap wrote). */
function nested(): { db: bus.BusDb; oAt: number; lAt: number } {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `n${n++}.sqlite`));
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  setLiveTreeSource(() => ({ get: (id) => byId.get(id), ids: () => NODES.map((w) => w.id) }));
  const rows = (carrier: string, at: number, members: Array<[string, string]>, withDb: boolean): void => {
    for (const [ws, run] of members) {
      insertBilan(db, { runId: carrier, wsId: ws, pausedAt: at, activity: { surface: 'sdk', memberRun: run, ...(withDb && ws === 'o1' ? { containers: { stopped: [stop('db', 'stopped', 'g-db')] } } : {}) }, snapshotRef: 'r', dirty: false, killed: { killed: [], survivors: [], refused: [], spared: [] }, error: null });
    }
    db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(at + 1, carrier);
  };
  assert.equal(setRunPause(db, 'O', true, 'O'), 'paused');
  const oAt = getRunPause(db, 'O')!.pausedAt;
  rows('O', oAt, [['O', 'O'], ['o1', 'O']], true); // O's trap stopped the DB
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const lAt = getRunPause(db, 'L')!.pausedAt;
  rows('L', lAt, [['L', 'L'], ['O', 'O'], ['o1', 'O']], false); // L's trap found it already down: nothing in L's Bilan
  return { db, oAt, lAt };
}

test('#2 NESTED Pauses: the child\'s Reprise under a STANDING ancestor Pause restarts NOTHING (no container runs under the outer Pause) and does not park its coordinators; the ancestor\'s Reprise then restarts it', async () => {
  const { db, oAt } = nested();
  assert.equal(beginReprise(db, 'O', 'O'), 'resuming');
  assert.equal(containersOwed(db, 'O'), false, 'not restartable now ⇒ not owed: the child\'s Reprise is not held for it');
  assert.ok(repriseRows(db).some((r) => r.recipient === 'O'), 'the child\'s coordinator was released by the begin (not parked)');
  const d = new FakeDocker([{ id: 'db', name: 'g-db', running: false }]);
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.deepEqual(d.calls, [], 'a container restarted under the outer Pause dure would be the bug');
  assert.equal(d.running('db'), false);
  // the ancestor's Reprise begins: now nothing covers O any more
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 6 });
  assert.equal(d.running('db'), true, 'restarted by the Reprise of the Pause that was covering it');
  assert.equal(containersOfCarrier(db, 'O', 'o1', oAt).restarted![0].outcome, 'started', 'recorded on the row of the carrier that stopped it');
  db.close();
});

test('#2 …and when the child already FINISHED its Reprise under the ancestor, the ANCESTOR\'s Reprise owns the deferred restart: its begin parks for it, its step starts it and records it on the child\'s row', async () => {
  const { db, oAt } = nested();
  beginReprise(db, 'O', 'O');
  releaseMembers(db, 'O', 'O', 'all'); // the child's Reprise runs to the end: O is ACTIVE again (L's Pause still covers it)
  assert.equal(readCarrierColumns(db, 'O')!.pausedAt, null, 'O finished its own Reprise');
  const before = repriseRows(db).length;
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  assert.equal(containersOwed(db, 'L'), true, 'L covered O: the container O could not restart is owed by L\'s Reprise');
  assert.equal(repriseRows(db).length, before, 'L\'s coordinators are parked until it is back');
  const d = new FakeDocker([{ id: 'db', name: 'g-db', running: false }]);
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.equal(d.running('db'), true);
  assert.equal(containersOfCarrier(db, 'O', 'o1', oAt).restarted![0].outcome, 'started', 'the result lands on O\'s row');
  sweepReprise(sweepDepsOf(db));
  assert.ok(repriseRows(db).length > before, 'and then L\'s coordinators are released');
  db.close();
});

test('#3 a left-over `stopping` marker (the app was killed mid-stop) makes the Reprise restart the container; one that never stopped is a harmless already-running', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [{ ...stop('db'), outcome: 'stopping' }, { ...stop('web'), outcome: 'stopping' }] } });
  assert.equal(containersOwed(db, 'L'), true);
  beginReprise(db, 'L', 'L');
  const d = new FakeDocker([{ id: 'db', name: 'db', running: false /* the daemon finished the stop */ }, { id: 'web', name: 'web', running: true /* it never did */ }]);
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.deepEqual(containersOf(db, 'o1', pausedAt).restarted!.map((x) => [x.id, x.outcome]).sort(), [['db', 'started'], ['web', 'already-running']]);
  assert.equal(containersOwed(db, 'L'), false);
  db.close();
});

test('#1 …and a re-Pause mid-step never turns what was NOT attempted into a recorded `failed` (a member whose daemon client is unavailable would otherwise lose its restart for good)', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [{ ...stop('c1'), atMs: 30 }] }, O: { stopped: [{ ...stop('x'), atMs: 20 }] } });
  beginReprise(db, 'L', 'L');
  const d = new FakeDocker([{ id: 'c1', name: 'c1', running: false }, { id: 'x', name: 'x', running: false }]);
  d.beforeStart = (id) => {
    if (id === 'c1') assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  };
  await restartOwedContainers({ getBus: () => db, api: null, apiFor: (ws) => (ws === 'o1' ? d : null), now: () => 5 });
  assert.equal(bilanForMember(db, 'L', 'O', pausedAt)!.activity!.containers!.restarted, undefined, 'x was never attempted: no result (not a `failed`) on its row');
  assert.equal(containersOwed(db, 'L'), true);
  db.close();
});

test('F2-Z16 a later restart step MERGES into the row\'s earlier `restarted` results (never overwrites them): an earlier step\'s `started` survives the next one', async () => {
  const { db, pausedAt } = rig({ o1: { stopped: [{ ...stop('c1'), atMs: 30 }, { ...stop('c2'), atMs: 20 }], restarted: [{ id: 'c1', outcome: 'started', atMs: 3 }] } });
  beginReprise(db, 'L', 'L');
  const d = new FakeDocker([{ id: 'c1', name: 'c1', running: true }, { id: 'c2', name: 'c2', running: false }]);
  await restartOwedContainers({ getBus: () => db, api: d, now: () => 5 });
  assert.deepEqual(d.calls.filter((c) => c.startsWith('start')), ['start c2'], 'c1 already has its result: not started again');
  assert.deepEqual(containersOf(db, 'o1', pausedAt).restarted!.map((x) => [x.id, x.outcome]).sort(), [['c1', 'started'], ['c2', 'started']], 'both results are on the row');
  db.close();
});
