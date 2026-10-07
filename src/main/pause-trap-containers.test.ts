// #292 — the HOST TRAP stops each member's ATTRIBUTED containers (ledger #295 FI-1.3–1.6): over a REAL bus, the process/session layer faked (as in pause-trap.test.ts),
// Docker = an in-memory daemon that filters by label like the real one. Each arm names the clause it protects (in-place mutants: scripts/docker-relay-mutants.mjs, "P*").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
import { startRun } from './bus-runs.ts';
import { setRunPause, getRunPause, beginReprise } from './bus-pause.ts';
import { bilanForMember, updateBilanContainers } from './bus-pause-records.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { __resetPauseTrapForTests, runPauseTrap, sweepPauseTrap, trapMember, type TrapDeps, type TrapMember } from './pause-trap.ts';
import { FakeDocker } from './fake-docker.ts';
import type { KillReport } from './pause-kill.ts';

const ROOT = path.join(os.homedir(), '.cache', `pause-trap-containers-${process.pid}`);
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

interface Rig {
  db: BusDb;
  deps: TrapDeps;
  calls: string[];
  docker: FakeDocker;
  roster: TrapMember[];
  cliResult: { cli: { pid: number; startTicks: number }; keeperPid: number | null } | { error: string };
}

const member = (wsId: string, extra: Partial<TrapMember> = {}): TrapMember => ({ wsId, runId: 'W', worktreePath: `/w/${wsId}`, remote: false, status: null, lastTask: null, ...extra });

function newRig(docker: FakeDocker | null = new FakeDocker([])): Rig {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = openBus(path.join(ROOT, `b${n++}.sqlite`));
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
  startRun(db, { id: 'M', kind: 'mission', coordinator: 'lead' }, sw);
  startRun(db, { id: 'W', kind: 'vague', coordinator: 'ops-w', parentRunId: 'M' }, sw);
  const calls: string[] = [];
  const rig: Rig = { db, calls, docker: docker as FakeDocker, roster: [member('m1')], cliResult: { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 }, deps: undefined as unknown as TrapDeps };
  const killReport: KillReport = { cliPid: 100, cli: { pid: 100, startTicks: 1000 }, killed: [], refused: [], spared: [], survivors: [], rounds: 1 };
  let clock = 10_000;
  rig.deps = {
    getBus: () => db,
    now: () => clock++,
    members: (runIds) => rig.roster.filter((m) => runIds.includes(m.runId)),
    activityOf: async () => ({ surface: 'sdk', turnRunning: false, inFlightTools: [], bgTasks: [] }),
    interrupt: async () => 'idle',
    cliOf: async () => rig.cliResult,
    snapshot: async (i) => ({ ref: `refs/orchestra/pause/${i.runId}/${i.wsId}/1`, commit: 'c', tree: 't', head: 'h', branch: 'b', dirty: false, changed: { modified: 0, added: 0, deleted: 0 }, skippedLarge: [], skippedLargeCount: 0, notes: [], warnings: [], submodules: [] }),
    killTrees: async () => {
      calls.push('killTrees');
      return killReport;
    },
    sleep: async () => {},
    settleMs: 0,
    originWaitMs: 0,
    ...(docker ? { containers: new Proxy(docker, { get: (t, k) => (typeof (t as never)[k] === 'function' ? (...a: unknown[]) => { calls.push(String(k)); return (t as never)[k](...a); } : (t as never)[k]) }) as unknown as FakeDocker } : {}),
  };
  return rig;
}

function pause(rig: Rig): ReturnType<typeof getRunPause> & object {
  assert.equal(setRunPause(rig.db, 'W', true, 'ops-w'), 'paused');
  return getRunPause(rig.db, 'W')!;
}

const labelled = (ws: string, id: string, name = id, extra = {}) => ({ id, name, labels: { 'orchestra.ws': ws, 'orchestra.run': 'W' }, ...extra });

test('a Pause dure STOPS the member\'s attributed container AFTER the tool-tree kill and records it in the Bilan (activity.containers.stopped, FI-1.6); the data volume is never touched (stop only)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db', 'g-db', { image: 'mysql:8' })]));
  const c = pause(rig);
  const out = await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.equal(out, 'complete');
  assert.ok(rig.calls.indexOf('killTrees') >= 0 && rig.calls.indexOf('killTrees') < rig.calls.indexOf('stopContainer'), `order: tool-tree kill THEN docker stop — ${rig.calls.join(' > ')}`);
  assert.equal(rig.docker.running('db'), false);
  const row = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.equal(row.killed !== null, true, 'the trap is stamped complete for the member');
  assert.deepEqual(row.activity!.containers!.stopped.map((x) => ({ id: x.id, name: x.name, image: x.image, run: x.run, outcome: x.outcome })), [{ id: 'db', name: 'g-db', image: 'mysql:8', run: 'W', outcome: 'stopped' }]);
  assert.equal(rig.docker.containers.length, 1, 'never removed');
  assert.ok(!rig.calls.some((x) => /remove|kill|pause/i.test(x.replace('killTrees', ''))), 'only stop');
});

test('UNATTRIBUTED containers beside them are NEVER touched; another member\'s neither (selection is by the member\'s own orchestra.ws label)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'mine'), labelled('m2', 'theirs'), { id: 'human', name: 'my-own-db' }]));
  const c = pause(rig);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.equal(rig.docker.running('mine'), false);
  assert.equal(rig.docker.running('theirs'), true);
  assert.equal(rig.docker.running('human'), true);
  assert.ok(!rig.docker.calls.some((x) => /^(stop|inspect) (theirs|human)/.test(x)));
});

test('Docker UNAVAILABLE never blocks the trap or keeps it incomplete: the member is complete, the error is recorded', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db')]));
  rig.docker.down = true;
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  const row = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.match(row.activity!.containers!.error ?? '', /^list:/);
  assert.notEqual(row.killed, null);
});

test('a container whose stop FAILS is recorded failed and the trap still completes (the Consigne tells the member)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db'), labelled('m1', 'web')]));
  rig.docker.failStop.add('web');
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  const st = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers!.stopped;
  assert.deepEqual(st.map((x) => [x.id, x.outcome]).sort(), [['db', 'stopped'], ['web', 'failed']]);
});

test('`docker run --rm` is NOT stopped (a stop would delete it) — skipped-autoremove in the Bilan, still running', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'rm', 'once', { autoRemove: true }), labelled('m1', 'db')]));
  const c = pause(rig);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.equal(rig.docker.running('rm'), true);
  const st = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers!.stopped;
  assert.equal(st.find((x) => x.id === 'rm')!.outcome, 'skipped-autoremove');
});

test('a remote/sandbox member is never given a docker step; a member with NO attributed container records no `containers` at all; no deps.containers ⇒ Docker untouched', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('sbx', 'x')]));
  rig.roster = [member('sbx', { remote: true }), member('plain')];
  const c = pause(rig);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.deepEqual(rig.docker.calls, [], 'remote member: no docker call');
  await trapMember(rig.deps, rig.db, c, rig.roster[1]);
  assert.equal(bilanForMember(rig.db, 'W', 'plain', c.pausedAt)!.activity!.containers?.stopped.length ?? 0, 0);
  const off = newRig(null); // no containers dep at all
  const c2 = pause(off);
  assert.equal(await trapMember(off.deps, off.db, c2, off.roster[0]), 'complete');
  assert.equal(bilanForMember(off.db, 'W', 'm1', c2.pausedAt)!.activity!.containers, undefined);
});

test('a trap RETRY (member incomplete: CLI unproven) merges BY ID — the first attempt\'s stop is kept and the container is never stopped twice; the stop happens even while the trap is incomplete', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db')]));
  rig.cliResult = { error: 'keeper did not answer' };
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'incomplete');
  assert.equal(rig.docker.running('db'), false, 'stopped on the first (incomplete) attempt — memory is freed at once');
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  const stopsBefore = rig.docker.calls.filter((x) => x.startsWith('stop ')).length;
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  assert.equal(rig.docker.calls.filter((x) => x.startsWith('stop ')).length, stopsBefore, 'not stopped again');
  const st = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers!.stopped;
  assert.deepEqual(st.map((x) => [x.id, x.outcome]), [['db', 'stopped']]);
});

test('LIFT MID-TRAP: a Reprise that begins while containers are being stopped touches no further container, and what THIS attempt stopped is restarted at once (the Reprise\'s own read may have missed it)', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db'), labelled('m1', 'web')]));
  const c = pause(rig);
  rig.docker.beforeStop = (id) => {
    if (id === 'db') assert.equal(beginReprise(rig.db, 'W', 'ops-w', { host: true }), 'resuming'); // the Reprise lands while db is being stopped
  };
  const out = await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.equal(out, 'lifted');
  assert.ok(!rig.docker.calls.some((x) => x.startsWith('stop web')), 'no further container after the lift');
  assert.equal(rig.docker.running('web'), true);
  assert.equal(rig.docker.running('db'), true, 'the one this attempt stopped was restarted by the trap itself');
  const row = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!;
  assert.deepEqual(row.activity!.containers!.restarted?.map((x) => [x.id, x.outcome]), [['db', 'started']]);
});

test('runPauseTrap over the whole roster: every member\'s attributed containers are stopped before the trap is stamped, and the stamp waits for them', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'a'), labelled('m2', 'b'), { id: 'human', name: 'mine' }]));
  rig.roster = [member('m1'), member('m2')];
  const c = pause(rig);
  const sum = await runPauseTrap(rig.deps, c);
  assert.equal(sum.done, true);
  assert.equal(rig.docker.running('a'), false);
  assert.equal(rig.docker.running('b'), false);
  assert.equal(rig.docker.running('human'), true);
  const trapAt = rig.db.prepare('SELECT pause_trap_at FROM runs WHERE id = ?').get('W') as { pause_trap_at: number | null };
  assert.notEqual(trapAt.pause_trap_at, null);
});

test('Docker ABSENT (not installed / not started): no error, no `containers` key at all — the member\'s Bilan row is byte-identical to before #292 and its Consigne says nothing about Docker', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db')]));
  rig.docker.absent = true;
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  assert.equal(bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers, undefined);
});

test('a LATER attempt that succeeds does not inherit the earlier attempt\'s "Docker down" error', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db')]));
  rig.cliResult = { error: 'keeper did not answer' };
  rig.docker.down = true;
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'incomplete');
  assert.match(bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers!.error ?? '', /^list:/);
  rig.docker.down = false;
  rig.cliResult = { cli: { pid: 100, startTicks: 1000 }, keeperPid: 90 };
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  const cont = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers!;
  assert.equal(cont.error, undefined, 'the stale error is gone');
  assert.deepEqual(cont.stopped.map((x) => x.id), ['db']);
});

test('a lift mid-stop never overwrites what a concurrent writer (the Reprise\'s container step) recorded on the row meanwhile', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db'), labelled('m1', 'web')]));
  const c = pause(rig);
  rig.docker.beforeStop = (id) => {
    if (id !== 'db') return;
    beginReprise(rig.db, 'W', 'ops-w', { host: true });
    updateBilanContainers(rig.db, 'W', 'm1', c.pausedAt, (cur) => ({ stopped: cur?.stopped ?? [], restarted: [{ id: 'recorded-by-reprise', outcome: 'started', atMs: 9 }] }));
  };
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'lifted');
  const ids = bilanForMember(rig.db, 'W', 'm1', c.pausedAt)!.activity!.containers!.restarted!.map((x) => x.id).sort();
  assert.deepEqual(ids, ['db', 'recorded-by-reprise']);
});

test('the SWEEP does the container step before it releases anyone: one sweepPauseTrap restarts the owed container FIRST (no reprise row exists at that instant), then the coordinator gets its Consigne', async () => {
  __resetPauseTrapForTests();
  const rig = newRig(new FakeDocker([labelled('m1', 'db')]));
  const c = pause(rig);
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.equal(rig.docker.running('db'), false);
  rig.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(c.pausedAt + 1, 'W'); // the trap is done: the Reprise's roster is complete
  assert.equal(beginReprise(rig.db, 'W', 'ops-w'), 'resuming');
  const repriseRows = (): number => (rig.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'reprise'").get() as { n: number }).n;
  assert.equal(repriseRows(), 0, 'parked: nobody released by the begin');
  let rowsAtStart = -1;
  rig.docker.beforeStart = () => {
    rowsAtStart = repriseRows();
  };
  await sweepPauseTrap(rig.deps);
  assert.equal(rig.docker.running('db'), true, 'the container is back');
  assert.equal(rowsAtStart, 0, 'FI-1.7: it was started BEFORE any Consigne existed');
  assert.ok(repriseRows() >= 1, 'and the coordinator was released right after, in the SAME sweep');
});

test('containersFor: each member is trapped on the daemon ITS relay stamps on — the app\'s own default daemon is not touched (the keeper\'s published upstream beats the app\'s resolution)', async () => {
  __resetPauseTrapForTests();
  const mine = new FakeDocker([labelled('m1', 'db')]); // the daemon m1's relay stamped on
  const appDefault = new FakeDocker([labelled('m1', 'db-elsewhere')]); // what the app's own resolution (a moved context) would see
  const rig = newRig(appDefault);
  rig.deps = { ...rig.deps, containersFor: (ws) => (ws === 'm1' ? mine : null) };
  const c = pause(rig);
  assert.equal(await trapMember(rig.deps, rig.db, c, rig.roster[0]), 'complete');
  assert.equal(mine.running('db'), false, 'stopped on the member\'s own daemon');
  assert.equal(appDefault.running('db-elsewhere'), true, 'the app\'s default daemon was never asked');
  assert.deepEqual(appDefault.calls, []);
  // a member with no published upstream falls back to the app's client
  rig.roster = [member('m2')];
  appDefault.containers.push({ id: 'x', name: 'x', image: 'alpine', labels: { 'orchestra.ws': 'm2' }, running: true, restarting: false, autoRemove: false });
  await trapMember(rig.deps, rig.db, c, rig.roster[0]);
  assert.equal(appDefault.running('x'), false);
});
