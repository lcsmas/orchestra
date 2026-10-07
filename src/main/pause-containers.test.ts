// #292 — the Docker half of a Pause dure against an in-memory daemon that FILTERS BY LABEL like the real one: selection, never-remove, --rm, errors, lift mid-stop, retry merge, restart outcomes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocker } from './fake-docker.ts';
import { restartContainers, stopAttributedContainers, STOP_TIMEOUT_SEC } from './pause-containers.ts';
import type { ContainerStopEntry } from '../shared/pause-containers.ts';

const WS = 'ws-member';
const mk = () =>
  new FakeDocker([
    { id: 'db', name: 'g-db', image: 'mysql:8', labels: { 'orchestra.ws': WS, 'orchestra.run': 'run-1' } },
    { id: 'web', name: 'g-web', image: 'nginx', labels: { 'orchestra.ws': WS, 'orchestra.run': 'run-1' } },
    { id: 'other-ws', name: 'o', labels: { 'orchestra.ws': 'ws-someone-else' } }, // another member's
    { id: 'human', name: 'my-own-stack' }, // unlabelled: the human's
    { id: 'exited', name: 'old', labels: { 'orchestra.ws': WS }, running: false }, // not running: nothing to stop
    { id: 'rm', name: 'once', labels: { 'orchestra.ws': WS }, autoRemove: true },
  ]);
const base = { stillPaused: () => true, now: () => 42 };

test('SELECTION: only RUNNING containers labelled orchestra.ws=<member>; the daemon is asked by label+status; unattributed and other members\' containers are never stopped', async () => {
  const d = mk();
  const r = await stopAttributedContainers(d, WS, base);
  assert.equal(d.calls[0], `list labels=["orchestra.ws=${WS}"] status=["running","restarting"]`);
  assert.deepEqual(r.containers.stopped.map((x) => [x.id, x.outcome]).sort(), [['db', 'stopped'], ['rm', 'skipped-autoremove'], ['web', 'stopped']]);
  assert.equal(d.running('human'), true, 'the human\'s own container is untouched');
  assert.equal(d.running('other-ws'), true, 'another member\'s container is untouched');
  assert.ok(!d.calls.some((c) => /other-ws|human|exited/.test(c) && /stop|inspect/.test(c)), d.calls.join('\n'));
});

test('STOP, never remove/kill/pause: stop with t=10; --rm is skipped (a stop would delete it) and STAYS running; the entry carries id/name/image/run/outcome/atMs (FI-1.6)', async () => {
  const d = mk();
  const r = await stopAttributedContainers(d, WS, base);
  assert.equal(STOP_TIMEOUT_SEC, 10);
  assert.ok(d.calls.includes('stop db t=10'));
  assert.ok(!d.calls.some((c) => c.startsWith('stop rm')), '--rm container must not be stopped');
  assert.equal(d.running('rm'), true);
  assert.equal(d.containers.length, 6, 'nothing was removed');
  assert.deepEqual(r.containers.stopped.find((x) => x.id === 'db'), { id: 'db', name: 'g-db', image: 'mysql:8', run: 'run-1', outcome: 'stopped', atMs: 42 });
  assert.equal(r.containers.stopped.find((x) => x.id === 'rm')!.run, null, 'a container with no orchestra.run label records run null');
  assert.deepEqual(r.stoppedNow.sort(), ['db', 'web']);
});

test('a stop that fails is RECORDED (failed + error) and the others still stop; 404/304 between list and stop are NOT ours (not recorded, never restarted)', async () => {
  const d = mk();
  d.failStop.add('web');
  const r = await stopAttributedContainers(d, WS, base);
  const web = r.containers.stopped.find((x) => x.id === 'web')!;
  assert.equal(web.outcome, 'failed');
  assert.match(web.error ?? '', /500/);
  assert.equal(r.containers.stopped.find((x) => x.id === 'db')!.outcome, 'stopped');
  const d2 = mk();
  d2.beforeStop = (id) => {
    if (id === 'db') d2.remove('db'); // removed by hand between the list and the stop
    if (id === 'web') d2.containers.find((c) => c.id === 'web')!.running = false; // stopped by someone else first
  };
  const r2 = await stopAttributedContainers(d2, WS, base);
  assert.deepEqual(r2.containers.stopped.map((x) => x.id), ['rm'], 'only what THIS call stopped (or consciously skipped) is recorded: gone / already-stopped are not ours');
});

test('Docker unavailable: recorded as containers.error, nothing thrown (the trap never blocks on it)', async () => {
  const d = mk();
  d.down = true;
  const r = await stopAttributedContainers(d, WS, base);
  assert.match(r.containers.error ?? '', /^list: .*unavailable.*ECONNREFUSED/);
  assert.deepEqual(r.containers.stopped, []);
  assert.equal(r.lifted, false);
});

test('LIFT MID-STOP: stillPaused is re-read before EVERY container — once false nothing more is touched, what was stopped is reported (stoppedNow)', async () => {
  const d = mk();
  let paused = true;
  d.beforeStop = (id) => {
    if (id === 'db') paused = false; // the Reprise begins while db is being stopped
  };
  const r = await stopAttributedContainers(d, WS, { ...base, stillPaused: () => paused });
  assert.equal(r.lifted, true);
  assert.deepEqual(r.stoppedNow, ['db']);
  assert.ok(!d.calls.some((c) => c.startsWith('stop web')), 'no container is touched after the lift');
  assert.equal(d.running('web'), true);
});

test('RETRY MERGES BY ID: a container an earlier attempt stopped is not touched again; a failed one is retried; progress is reported after each stop', async () => {
  const d = mk();
  const prior = { stopped: [{ id: 'db', name: 'g-db', image: 'mysql:8', run: 'run-1', outcome: 'stopped', atMs: 1 }, { id: 'web', name: 'g-web', image: 'nginx', run: 'run-1', outcome: 'failed', error: 'earlier', atMs: 1 }] as ContainerStopEntry[] };
  d.containers.find((c) => c.id === 'db')!.running = true; // listed RUNNING again (someone started it): the earlier entry still wins — the same container is never handled twice
  const seen: Array<Array<[string, string]>> = [];
  const r = await stopAttributedContainers(d, WS, { ...base, prior, onProgress: (c) => seen.push(c.stopped.map((x) => [x.id, x.outcome])) });
  assert.ok(!d.calls.some((c) => c.startsWith('stop db')), 'never stopped twice');
  assert.ok(d.calls.includes('stop web t=10'), 'the failed one is tried again');
  assert.equal(r.containers.stopped.find((x) => x.id === 'web')!.outcome, 'stopped');
  assert.equal(r.containers.stopped.find((x) => x.id === 'db')!.atMs, 1, 'the earlier entry is kept as is');
  assert.deepEqual(seen[0]?.find((x) => x[0] === 'web'), ['web', 'stopping'], 'the write-ahead entry is persisted BEFORE the stop call');
  assert.deepEqual(seen[seen.length - 1], r.containers.stopped.map((x) => [x.id, x.outcome]), 'the LAST progress write is the final state: each stop is durable at once, not only at the end of the step');
});

test('a row whose label is not the member\'s is never acted on even if a daemon returned it (the stop is destructive: the label is re-asserted)', async () => {
  const d = mk();
  const orig = d.listContainers.bind(d);
  d.listContainers = async (o) => [...(await orig(o)), { id: 'other-ws', name: 'o', image: 'alpine', state: 'running', status: '', created: 0, labels: { 'orchestra.ws': 'ws-someone-else' } }];
  await stopAttributedContainers(d, WS, base);
  assert.ok(!d.calls.some((c) => c.includes('other-ws') && /stop|inspect/.test(c)));
  assert.equal(d.running('other-ws'), true);
});

test('restartContainers reports EVERY outcome: started · already-running · gone (404) · failed — and the others still start', async () => {
  const d = mk();
  d.containers.find((c) => c.id === 'db')!.running = false;
  d.containers.find((c) => c.id === 'web')!.running = true;
  d.failStart.add('exited');
  const entries = ['db', 'web', 'ghost', 'exited'].map((id): ContainerStopEntry => ({ id, name: id, image: 'x', run: null, outcome: 'stopped', atMs: 1 }));
  const r = await restartContainers(d, entries, () => 7);
  assert.deepEqual(r.map((x) => [x.id, x.outcome]), [['db', 'started'], ['web', 'already-running'], ['ghost', 'gone'], ['exited', 'failed']]);
  assert.match(r[3].error ?? '', /no space/);
  assert.equal(d.running('db'), true);
  assert.ok(r.every((x) => x.atMs === 7));
});

test('a CRASH-LOOPING (restarting) attributed container is stopped too — it holds memory under a Pause', async () => {
  const d = new FakeDocker([{ id: 'loop', name: 'looper', labels: { 'orchestra.ws': WS }, running: true, restarting: true }]);
  const r = await stopAttributedContainers(d, WS, base);
  assert.deepEqual(r.containers.stopped.map((x) => [x.id, x.outcome]), [['loop', 'stopped']]);
  assert.equal(d.running('loop'), false);
});

test('a stop that ERRORS after taking effect (client-side timeout) is re-inspected: a container that IS down is recorded stopped (the Reprise restarts it), one still up stays failed', async () => {
  const d = mk();
  d.stopThrowsAfterEffect.add('db'); // the daemon stopped it, the answer was lost
  d.failStop.add('web'); // a real failure: still running
  const r = await stopAttributedContainers(d, WS, base);
  assert.equal(r.containers.stopped.find((x) => x.id === 'db')!.outcome, 'stopped');
  assert.equal(r.containers.stopped.find((x) => x.id === 'web')!.outcome, 'failed');
  assert.ok(r.stoppedNow.includes('db'));
});

test('the Bilan cap: past 200 entries the Pause stops ACTING (an unrecorded stop would never be restarted) and says so', async () => {
  const many = Array.from({ length: 205 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, labels: { 'orchestra.ws': WS } }));
  const d = new FakeDocker(many);
  const r = await stopAttributedContainers(d, WS, base);
  assert.equal(r.containers.stopped.length, 200);
  assert.equal(d.calls.filter((c) => c.startsWith('stop ')).length, 200, 'no container beyond the cap was stopped');
  assert.match(r.containers.error ?? '', /more than 200 attributed containers: the rest were NOT stopped/);
});

test('Docker ABSENT (no socket / ENOENT — not installed or not started) records NOTHING and alarms nobody; Docker that EXISTS but refuses/times out is a recorded error', async () => {
  const { DockerApiError } = await import('./docker-api.ts');
  const absent = mk();
  absent.listContainers = async () => {
    throw new DockerApiError('no Docker socket found', 'unavailable');
  };
  const a = await stopAttributedContainers(absent, WS, base);
  assert.equal(a.containers.error, undefined);
  assert.deepEqual(a.containers.stopped, []);
  const enoent = mk();
  enoent.listContainers = async () => {
    throw new DockerApiError('docker unavailable: connect ENOENT /var/run/docker.sock', 'unavailable');
  };
  assert.equal((await stopAttributedContainers(enoent, WS, base)).containers.error, undefined);
  for (const e of [new DockerApiError('docker unavailable: connect ECONNREFUSED', 'unavailable'), new DockerApiError('docker unavailable: connect EACCES /var/run/docker.sock', 'unavailable'), new DockerApiError('docker GET timed out', 'timeout'), new DockerApiError('HTTP 500', 'http', 500)]) {
    const d = mk();
    d.listContainers = async () => {
      throw e;
    };
    assert.match((await stopAttributedContainers(d, WS, base)).containers.error ?? '', /^list:/, e.message);
  }
});

test('restart: a transient `unavailable` is retried ONCE; a permanent error is not; a deadline records the rest failed (a hung daemon never parks the coordinators for ever)', async () => {
  const { DockerApiError } = await import('./docker-api.ts');
  const d = mk();
  d.containers.find((c) => c.id === 'db')!.running = false;
  let tries = 0;
  const orig = d.startContainer.bind(d);
  d.startContainer = async (id: string) => {
    if (id === 'db' && ++tries === 1) throw new DockerApiError('docker unavailable: socket hang up', 'unavailable');
    return orig(id);
  };
  const entry = (id: string): ContainerStopEntry => ({ id, name: id, image: 'x', run: null, outcome: 'stopped', atMs: 1 });
  const naps: number[] = [];
  const sleep = async (ms: number) => void naps.push(ms);
  assert.deepEqual((await restartContainers(d, [entry('db')], () => 1, { sleep })).map((x) => x.outcome), ['started']);
  assert.equal(tries, 2);
  assert.deepEqual(naps, [1000]);
  d.failStart.add('web'); // an HTTP-500 start is permanent: one attempt
  d.containers.find((c) => c.id === 'web')!.running = false;
  let webTries = 0;
  const o2 = d.startContainer.bind(d);
  d.startContainer = async (id: string) => (id === 'web' && ++webTries, o2(id));
  assert.equal((await restartContainers(d, [entry('web')], () => 1, { sleep }))[0].outcome, 'failed');
  assert.equal(webTries, 1);
  const late = await restartContainers(d, [entry('a'), entry('b')], () => 100, { deadlineAt: 50, sleep });
  assert.deepEqual(late.map((x) => [x.outcome, x.error]), [['failed', 'restart deadline exceeded'], ['failed', 'restart deadline exceeded']]);
});

test('#3 WRITE-AHEAD: a `stopping` entry is on the Bilan BEFORE the stop call returns (the app may die in that window); the final outcome replaces it; a container that turns out not to be ours leaves no marker', async () => {
  const d = new FakeDocker([{ id: 'db', name: 'g-db', labels: { 'orchestra.ws': WS } }, { id: 'web', name: 'g-web', labels: { 'orchestra.ws': WS } }]);
  let lastProgress: ContainerStopEntry[] = [];
  const atStop: Record<string, string | undefined> = {};
  d.beforeStop = (id) => {
    atStop[id] = lastProgress.find((x) => x.id === id)?.outcome; // what the Bilan says the instant the stop call is made
    if (id === 'web') d.containers.find((c) => c.id === 'web')!.running = false; // someone else stops it first: 'already-stopped' → not ours
  };
  const r = await stopAttributedContainers(d, WS, { ...base, onProgress: (c) => (lastProgress = c.stopped) });
  assert.equal(atStop.db, 'stopping');
  assert.equal(atStop.web, 'stopping');
  assert.deepEqual(r.containers.stopped.map((x) => [x.id, x.outcome]), [['db', 'stopped']], 'no stale marker for the container that was not ours');
  assert.deepEqual(lastProgress.map((x) => [x.id, x.outcome]), [['db', 'stopped']], 'and the persisted view agrees');
});

test('#3 a retry that finds an earlier `stopping` marker for a container still RUNNING stops it again (the daemon never finished); a `stopped` one is still never touched twice', async () => {
  const d = mk();
  const prior = { stopped: [{ id: 'db', name: 'g-db', image: 'mysql:8', run: 'run-1', outcome: 'stopping', atMs: 1 }, { id: 'web', name: 'g-web', image: 'nginx', run: 'run-1', outcome: 'stopped', atMs: 1 }] as ContainerStopEntry[] };
  const r = await stopAttributedContainers(d, WS, { ...base, prior });
  assert.ok(d.calls.includes('stop db t=10'), 'the interrupted stop is redone');
  assert.ok(!d.calls.some((c) => c.startsWith('stop web')), 'a recorded stop is never repeated');
  assert.equal(r.containers.stopped.find((x) => x.id === 'db')!.outcome, 'stopped');
});

test('#1 restartContainers stops BEFORE the next container once the Reprise is no longer current — what was not started leaves no result (it stays owed)', async () => {
  const d = new FakeDocker([{ id: 'a', name: 'a', running: false }, { id: 'b', name: 'b', running: false }, { id: 'c', name: 'c', running: false }]);
  const entry = (id: string): ContainerStopEntry => ({ id, name: id, image: 'x', run: null, outcome: 'stopped', atMs: 1 });
  let current = true;
  d.beforeStart = (id) => {
    if (id === 'b') current = false; // a re-Pause lands while b is being started
  };
  const out = await restartContainers(d, [entry('a'), entry('b'), entry('c')], () => 1, { stillResuming: () => current });
  assert.deepEqual(out.map((x) => [x.id, x.outcome]), [['a', 'started'], ['b', 'started']], 'b was already in flight; c is not touched');
  assert.equal(d.running('c'), false);
});
