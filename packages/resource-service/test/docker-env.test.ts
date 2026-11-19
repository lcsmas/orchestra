// docker-env + the cleanup step `remove-containers`, driven through the real CLI / reaper against a FAKE Docker daemon (the real-daemon acceptance is docker-real.test.ts).
// Run ids stay short: a unix socket path is limited to 107 bytes and the rig's state dir already takes ~60.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { isAlive, Rig, BIN, waitFor, within } from './lib/rig.ts';
import { endRun } from './lib/cli-async.ts';
import { FakeDocker } from './lib/fake-docker.ts';
import { request } from './lib/http.ts';
import { closeRelay, relaySocketPath, relayOf, type RelayRecord } from '../src/relay-host.ts';
import { bootId, readEnviron, readStat, sleep } from '../src/proc.ts';
import { withState } from '../src/state.ts';

/** End every open run of a rig WITHOUT blocking the event loop (rig.dispose uses spawnSync, which would starve a fake daemon hosted in this process until its 60 s timeout, turning a red assertion into a hang). */
async function endOpenRuns(rig: Rig): Promise<void> {
  try {
    for (const r of Object.values(rig.state().runs)) if (r.state !== 'cleaned') await endRun(rig, r.id);
  } catch {
    /* no state file */
  }
}

describe('docker-env and remove-containers', () => {
  let rig: Rig;
  let daemon: FakeDocker;
  let n = 0;
  const newId = (): string => `e${++n}`;

  before(async () => {
    rig = new Rig({ grace: '2s' });
    daemon = await FakeDocker.start(rig.dir);
    rig.env.RESCTL_DOCKER_SOCKET = daemon.sock;
  });
  after(async () => {
    await endOpenRuns(rig);
    await daemon.stop();
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });
  beforeEach(() => {
    daemon.deleteStatus = () => undefined;
    daemon.deleteDelayMs = 0;
    daemon.afterList = () => {};
    daemon.onDelete = () => {};
  });

  const start = (id: string) => {
    const c = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', id, '--owner', String(c.pid)]).status, 0);
    return c;
  };
  /** `env` reaches the relay it starts: RESCTL_TICK=600s switches its self-expiry watch off, so a test sees ONLY the cleanup's own stop. */
  const endpoint = (id: string, env: NodeJS.ProcessEnv = {}): string => {
    const r = rig.cli(['docker-env', '--run', id], env);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().replace(/^export DOCKER_HOST=unix:\/\//, '');
  };
  const create = async (sock: string, labels: Record<string, string> = {}): Promise<string> => {
    const r = await request(sock, 'POST', '/containers/create', { body: JSON.stringify({ Image: 'a', Labels: labels }) });
    assert.equal(r.status, 201, r.body);
    return (JSON.parse(r.body) as { Id: string }).Id;
  };
  /** The two labels a relay of this run instance stamps. */
  const own = (id: string): Record<string, string> => ({ 'resctl.run': id, 'resctl.token': rig.run(id)!.token });
  const relay = (id: string): RelayRecord => relayOf(rig.run(id))!;
  const relayAlive = (id: string): boolean => {
    const r = relay(id);
    return r.pid !== undefined && isAlive({ pid: r.pid, startTime: r.startTime! });
  };

  it('prints the export line for the stable per-run socket; a second call reuses the same relay', async () => {
    const id = newId();
    start(id);
    const r1 = rig.cli(['docker-env', '--run', id]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.stdout, `export DOCKER_HOST=unix://${relaySocketPath(rig.dir, id)}\n`);
    assert.equal((await request(relaySocketPath(rig.dir, id), 'GET', '/_ping')).body, 'OK', 'the relay answers the instant docker-env returns');
    const pid = relay(id).pid;
    const r2 = rig.cli(['docker-env', '--run', id]);
    assert.equal(r2.stdout, r1.stdout, 'the same path every time');
    assert.equal(relay(id).pid, pid, 'the same relay process, not a second one');
    assert.equal((await request(relaySocketPath(rig.dir, id), 'GET', '/_ping')).body, 'OK');
    assert.equal(relay(id).upstream, daemon.sock, 'the state records the daemon it forwards to');
    assert.deepEqual(relay(id).upstreams, [daemon.sock]);
    assert.equal(relay(id).startTime, readStat(pid!)!.startTime, 'the relay process registered its own identity');
    assert.equal(relay(id).bootId, bootId() ?? undefined);
  });

  it('refuses an unknown or cleaned run and a missing --run', async () => {
    assert.equal(rig.cli(['docker-env', '--run', 'nope']).status, 3);
    assert.equal(rig.cli(['docker-env']).status, 2);
    const id = newId();
    start(id);
    assert.equal((await endRun(rig, id)).status, 0);
    const r = rig.cli(['docker-env', '--run', id]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /cleaned/);
  });

  it('a container created through the endpoint carries resctl.run; one made around it does not', async () => {
    const id = newId();
    start(id);
    const sock = endpoint(id);
    const through = await create(sock, { app: 'x' });
    const around = daemon.add({ app: 'x' });
    assert.deepEqual(daemon.containers.get(through)!.labels, { app: 'x', 'resctl.run': id, 'resctl.token': rig.run(id)!.token });
    assert.equal(daemon.containers.get(around.id)!.labels['resctl.run'], undefined);
  });

  it('a relay that died is replaced by the next docker-env, at the same path', () => {
    const id = newId();
    start(id);
    const sock = endpoint(id);
    const old = relay(id).pid!;
    process.kill(old, 'SIGKILL');
    assert.equal(rig.cli(['docker-env', '--run', id]).stdout, `export DOCKER_HOST=unix://${sock}\n`);
    assert.notEqual(relay(id).pid, old);
    assert.ok(relayAlive(id));
  });

  it('refuses (exit 1) when there is no daemon to forward to, and leaves no relay behind', () => {
    const id = newId();
    start(id);
    const r = rig.cli(['docker-env', '--run', id], { RESCTL_DOCKER_SOCKET: path.join(rig.dir, 'no-such.sock') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not exist/);
    assert.equal(rig.run(id)!.relay, undefined);
    assert.ok(!fs.existsSync(relaySocketPath(rig.dir, id)));
  });

  it('the relay does not carry the run marker (docker-env called from inside a lane): the sweep does not own it, the lane ending does not stop it', async () => {
    const id = newId();
    start(id);
    const r = rig.cli(['exec', '--run', id, '--', process.execPath, BIN, 'docker-env', '--run', id]);
    assert.equal(r.status, 0, r.stderr);
    const env = readEnviron(relay(id).pid!)!;
    assert.ok(env.includes(`RESCTL_STATE_DIR=${rig.dir}`), 'it IS marked with the state dir (leak scans)');
    assert.deepEqual(env.filter((e) => /^RESCTL_RUN(_TOKEN)?=/.test(e)), []);
    assert.ok(relayAlive(id), 'the lane that started it has exited; the relay lives on');
  });

  it('run end removes the run\'s containers and stops its relay; another run\'s and an unlabelled one stay', async () => {
    const [a, b] = [newId(), newId()];
    start(a);
    start(b);
    const sa = endpoint(a, { RESCTL_TICK: '600s' });
    const sb = endpoint(b);
    const ca = [await create(sa), await create(sa, { x: '1' })];
    const cb = await create(sb);
    const unlabelled = daemon.add({}).id;
    const relayPid = relay(a).pid!;
    assert.ok(daemon.withLabel('resctl.run', a).length === 2);

    const r = await endRun(rig, a);
    assert.equal(r.status, 0, r.stderr);
    for (const c of ca) assert.ok(!daemon.containers.has(c), 'the run\'s container is gone');
    assert.ok(daemon.containers.has(cb), 'another run\'s container stays');
    assert.ok(daemon.containers.has(unlabelled), 'an unlabelled container stays');
    assert.ok(!isAlive({ pid: relayPid, startTime: relay(a).startTime! }), 'the relay process is gone');
    assert.ok(!fs.existsSync(sa), 'and its socket file');
    assert.ok(relayAlive(b) && fs.existsSync(sb), 'run b\'s relay is untouched');
    const del = daemon.callsTo('DELETE', /containers/).find((c) => c.url.includes(ca[0]))!;
    assert.match(del.url, /force=1/, 'force-removed');
    assert.match(del.url, /[?&]v=1/, 'with its anonymous volumes');
    assert.equal((await endRun(rig, b)).status, 0);
    assert.ok(!daemon.containers.has(cb));
  });

  it('ending run "ab" does not remove run "abc"', async () => {
    const [x, y] = ['ab' + (++n), 'ab' + n + 'c'];
    start(x);
    start(y);
    const cx = await create(endpoint(x));
    const cy = await create(endpoint(y));
    assert.equal((await endRun(rig, x)).status, 0);
    assert.ok(!daemon.containers.has(cx));
    assert.ok(daemon.containers.has(cy), 'a longer id with the same prefix is another run');
    assert.equal((await endRun(rig, y)).status, 0);
  });

  it('the relay is closed BEFORE the first removal; a docker-env during the cleanup is refused', async () => {
    const id = newId();
    start(id);
    const sock = endpoint(id, { RESCTL_TICK: '600s' });
    await create(sock);
    const seen: { socket: boolean; closed: boolean | undefined; alive: boolean }[] = [];
    daemon.onDelete = () => seen.push({ socket: fs.existsSync(sock), closed: relay(id).closed, alive: relayAlive(id) });
    daemon.deleteDelayMs = 1200;
    const deletes = daemon.callsTo('DELETE', /containers/).length;
    const ending = rig.spawnCli(['run', 'end', '--id', id]);
    await waitFor('the first DELETE reaches the daemon', () => daemon.callsTo('DELETE', /containers/).length > deletes);
    const during = rig.cli(['docker-env', '--run', id]);
    assert.equal(during.status, 3, during.stderr);
    assert.match(during.stderr, /being cleaned/);
    assert.equal((await within('run end', ending.exited)).code, 0, ending.stderr());
    assert.deepEqual(seen, [{ socket: false, closed: true, alive: false }], 'no relay, flagged closed, at the moment containers are removed');
  });

  it('a create that lands between two listings is still removed (two empty listings in a row)', async () => {
    const id = newId();
    start(id);
    await create(endpoint(id));
    let late = '';
    daemon.afterList = (k) => {
      if (k === daemon.listCount && late === '' && daemon.withLabel('resctl.run', id).length === 0) late = daemon.add(own(id)).id; // after the listing that found nothing
    };
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(late !== '', 'the late create happened');
    assert.ok(!daemon.containers.has(late), 'and was removed');
  });

  it('a container that will not go: run end fails, the run is NOT marked cleaned, a retry finishes it', async () => {
    const id = newId();
    start(id);
    const c = await create(endpoint(id));
    daemon.deleteStatus = () => 500;
    const r = await endRun(rig, id);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /remove-containers/);
    assert.match(r.stderr, /still there/);
    assert.notEqual(rig.run(id)!.state, 'cleaned');
    daemon.deleteStatus = () => undefined;
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(!daemon.containers.has(c));
    assert.equal(rig.run(id)!.state, 'cleaned');
  });

  it('a daemon that cannot be reached fails the cleanup (never "no daemon = nothing to remove")', async () => {
    const id = newId();
    start(id);
    const c = await create(endpoint(id));
    await daemon.down();
    const r = await endRun(rig, id);
    assert.equal(r.status, 1, r.stderr);
    assert.notEqual(rig.run(id)!.state, 'cleaned');
    await daemon.up();
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(!daemon.containers.has(c));
  });

  it('a run that never asked for a relay: run end never contacts Docker', async () => {
    const id = newId();
    start(id);
    const before = daemon.calls.length;
    assert.equal((await endRun(rig, id)).status, 0);
    assert.equal(daemon.calls.length, before);
  });

  it('the reaper does it when the coordinator dies: container removed, relay stopped, after the grace', async () => {
    const id = newId();
    const coord = start(id);
    const other = daemon.add({ 'resctl.run': 'someone-else' }).id;
    const c = await create(endpoint(id));
    const d = rig.startDaemon();
    await coord.kill();
    const ends = await waitFor('grace', () => rig.run(id)?.state === 'grace' && rig.run(id)!.graceEndsAt);
    assert.ok(daemon.containers.has(c) && relayAlive(id), 'both still there inside the grace');
    await waitFor('run cleaned', () => rig.run(id)?.state === 'cleaned', 15_000);
    assert.ok(Date.now() >= ends);
    assert.ok(!daemon.containers.has(c), 'container removed by the reaper');
    assert.ok(daemon.containers.has(other));
    assert.ok(!relayAlive(id) && !fs.existsSync(relaySocketPath(rig.dir, id)));
    d.child.kill('SIGTERM');
  });

  it('the relay outlives a restart of the serve daemon', async () => {
    const id = newId();
    start(id);
    const sock = endpoint(id);
    const d = rig.startDaemon();
    await sleep(300);
    d.child.kill('SIGKILL');
    await d.exited;
    assert.ok(relayAlive(id));
    assert.equal((await request(sock, 'GET', '/_ping')).status, 200);
  });

  it('a relay whose run instance is cleaned stops by itself (the belt behind the cleanup step)', async () => {
    const id = newId();
    start(id);
    endpoint(id);
    const rec = relay(id);
    await withState((s) => {
      s.runs[id].state = 'cleaned';
    }, rig.dir);
    await waitFor('the relay exits', () => !isAlive({ pid: rec.pid!, startTime: rec.startTime! }), 5000);
    assert.ok(!fs.existsSync(rec.sock!), 'and removes its socket');
  });

  it('a relay whose state is gone stops by itself', async () => {
    const rig2 = new Rig({ env: { RESCTL_DOCKER_SOCKET: daemon.sock } });
    try {
      const c = rig2.coordinator();
      assert.equal(rig2.cli(['run', 'start', '--id', 'z1', '--owner', String(c.pid)]).status, 0);
      assert.equal(rig2.cli(['docker-env', '--run', 'z1']).status, 0);
      const rec = relayOf(rig2.run('z1'))!;
      fs.rmSync(path.join(rig2.dir, 'state.json'));
      await waitFor('the relay exits', () => !isAlive({ pid: rec.pid!, startTime: rec.startTime! }), 5000);
    } finally {
      await rig2.dispose();
    }
  });

  it('a recorded relay whose pid now belongs to another process is never signalled', async () => {
    const id = newId();
    start(id);
    const by = rig.bystander();
    await withState((s) => {
      s.runs[id].relay = { sock: relaySocketPath(rig.dir, id), upstream: daemon.sock, pid: by.id.pid, startTime: by.id.startTime + 1, startedAt: Date.now() } satisfies RelayRecord;
    }, rig.dir);
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(isAlive(by.id), 'the bystander (same pid, other start time) was left alone');
    by.kill();
  });

  it('a relay process started for a CLOSED run never listens; for an open one it registers itself, then listens', async () => {
    const id = newId();
    start(id);
    const sock = relaySocketPath(rig.dir, id);
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    const token = rig.run(id)!.token;
    const entry = fileURLToPath(new URL('../src/relay-proc.ts', import.meta.url));
    const launch = () => spawn(process.execPath, [entry, id, token, sock, daemon.sock], { env: { ...rig.env, RESCTL_STATE_DIR: rig.dir }, stdio: 'ignore' });
    const planted = (extra: object) => withState((st) => void (st.runs[id].relay = { sock, upstream: daemon.sock, upstreams: [daemon.sock], startedAt: Date.now(), ...extra } satisfies RelayRecord), rig.dir);

    await planted({ closed: true });
    const closed = launch();
    const code = await within('closed relay exits', new Promise<number | null>((r) => closed.once('exit', (c) => r(c))));
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(sock), 'it never bound');
    assert.equal(relay(id).pid, undefined, 'and never registered');

    await planted({});
    const open = launch();
    await waitFor('the relay registers and listens', () => relay(id).pid === open.pid && fs.existsSync(sock));
    assert.equal((await request(sock, 'GET', '/_ping')).status, 200);
    assert.equal(relay(id).startTime, readStat(open.pid!)!.startTime);
    open.kill('SIGTERM');
    await within('relay stops', new Promise((r) => open.once('exit', r)));
  });

  it('a relay that cannot start fails docker-env (exit 1) but its upstream stays recorded, so a cleanup still clears that daemon', async () => {
    const id = newId();
    start(id);
    const sock = relaySocketPath(rig.dir, id);
    fs.mkdirSync(sock, { recursive: true }); // a directory where the socket must go: the relay cannot bind
    const r = rig.cli(['docker-env', '--run', id]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exited at start/);
    assert.equal(relay(id).upstream, daemon.sock, 'recorded before the relay was spawned');
    assert.ok(!relayAlive(id), 'the relay that could not bind is gone');
    fs.rmSync(sock, { recursive: true });
    const c = daemon.add(own(id)).id;
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(!daemon.containers.has(c));
  });

  it('a docker-env that died before its relay existed: the recorded upstream is still cleared by the cleanup', async () => {
    const id = newId();
    start(id);
    const c = daemon.add(own(id)).id; // a container created through a relay whose record has no process (the command was killed in between)
    await withState((st) => void (st.runs[id].relay = { sock: relaySocketPath(rig.dir, id), upstream: daemon.sock, upstreams: [daemon.sock], startedAt: Date.now() } satisfies RelayRecord), rig.dir);
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(!daemon.containers.has(c));
    assert.equal(relay(id).removed, true);
  });

  it('every daemon a relay of the run ever forwarded to is cleared (a respawn with another DOCKER_HOST), an older one that is gone is skipped', async () => {
    const id = newId();
    start(id);
    const fake2 = await FakeDocker.start(rig.dir, 'fake2.sock');
    const c1 = await create(endpoint(id)); // relay 1 -> daemon
    const first = relay(id);
    process.kill(first.pid!, 'SIGKILL');
    await waitFor('relay 1 gone', () => !isAlive({ pid: first.pid!, startTime: first.startTime! }));
    assert.equal(rig.cli(['docker-env', '--run', id], { RESCTL_DOCKER_SOCKET: fake2.sock }).status, 0);
    assert.deepEqual([relay(id).upstream, relay(id).upstreams], [fake2.sock, [daemon.sock, fake2.sock]]);
    const c2 = await create(relaySocketPath(rig.dir, id)); // relay 2 -> fake2
    assert.ok(fake2.containers.has(c2) && daemon.containers.has(c1));
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(!daemon.containers.has(c1) && !fake2.containers.has(c2), 'both daemons cleared');

    // the older upstream is gone: skipped (nothing there to hold a container); the current one is still required
    const id2 = newId();
    start(id2);
    await create(endpoint(id2));
    const r1 = relay(id2);
    process.kill(r1.pid!, 'SIGKILL');
    await waitFor('relay gone', () => !isAlive({ pid: r1.pid!, startTime: r1.startTime! }));
    const dead = await FakeDocker.start(rig.dir, 'fake3.sock');
    assert.equal(rig.cli(['docker-env', '--run', id2], { RESCTL_DOCKER_SOCKET: dead.sock }).status, 0);
    const r2 = relay(id2);
    process.kill(r2.pid!, 'SIGKILL');
    await waitFor('relay 2 gone', () => !isAlive({ pid: r2.pid!, startTime: r2.startTime! }));
    assert.equal(rig.cli(['docker-env', '--run', id2]).status, 0); // back on `daemon`
    await dead.stop(); // an OLDER upstream, its socket removed
    assert.equal((await endRun(rig, id2)).status, 0, 'a vanished older daemon does not wedge the cleanup');
    await fake2.stop();
  });

  it('a removal already in progress (409) is waited out, not counted as a failure', async () => {
    const id = newId();
    start(id);
    const c = await create(endpoint(id));
    let tries = 0;
    daemon.deleteStatus = () => (++tries <= 2 ? 409 : undefined);
    const r = await endRun(rig, id);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(tries >= 3 && !daemon.containers.has(c));
  });

  it('a relay record from ANOTHER boot never signals its pid, even when pid and starttime match a live process', async () => {
    const id = newId();
    start(id);
    const by = rig.bystander();
    await withState((st) => void (st.runs[id].relay = { sock: relaySocketPath(rig.dir, id), upstream: daemon.sock, upstreams: [daemon.sock], pid: by.id.pid, startTime: by.id.startTime, bootId: 'a-previous-boot', startedAt: 1 } satisfies RelayRecord), rig.dir);
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(isAlive(by.id), 'the bystander (identical pid + starttime, other boot) was left alone');
    by.kill();
  });

  it('two state dirs on ONE daemon that use the same run id: ending X never removes Y\'s container (the run token is a second label)', async () => {
    const id = newId();
    start(id);
    const rigY = new Rig({ env: { RESCTL_DOCKER_SOCKET: daemon.sock } });
    try {
      const cy = rigY.coordinator();
      assert.equal(rigY.cli(['run', 'start', '--id', id, '--owner', String(cy.pid)]).status, 0);
      const ry = rigY.cli(['docker-env', '--run', id]);
      assert.equal(ry.status, 0, ry.stderr);
      const cX = await create(endpoint(id));
      const cYid = await create(ry.stdout.trim().replace(/^export DOCKER_HOST=unix:\/\//, ''));
      assert.equal(daemon.containers.get(cX)!.labels['resctl.run'], daemon.containers.get(cYid)!.labels['resctl.run'], 'same id label');
      assert.notEqual(daemon.containers.get(cX)!.labels['resctl.token'], daemon.containers.get(cYid)!.labels['resctl.token'], 'different instance token');
      assert.equal((await endRun(rig, id)).status, 0);
      assert.ok(!daemon.containers.has(cX), 'X\'s container is gone');
      assert.ok(daemon.containers.has(cYid), 'Y\'s container (same id, another state dir) stays');
      assert.equal((await endRun(rigY, id)).status, 0);
      assert.ok(!daemon.containers.has(cYid));
    } finally {
      await endOpenRuns(rigY);
      await rigY.dispose();
    }
  });

  it('a container labelled with the id but another instance\'s token (an earlier run of the same id) is not removed', async () => {
    const id = newId();
    start(id);
    await create(endpoint(id));
    const older = daemon.add({ 'resctl.run': id, 'resctl.token': 'an-earlier-instance' }).id;
    const idOnly = daemon.add({ 'resctl.run': id }).id;
    assert.equal((await endRun(rig, id)).status, 0);
    assert.ok(daemon.containers.has(older) && daemon.containers.has(idOnly), 'only containers of THIS instance go');
  });

  it('closing is per run INSTANCE: an older instance\'s cleanup does not touch a restarted run', async () => {
    const id = newId();
    start(id);
    endpoint(id);
    const run = rig.run(id)!;
    assert.equal(await closeRelay(rig.dir, { ...run, token: 'an-older-instance' }), null);
    assert.equal(relay(id).closed, undefined, 'not flagged');
    assert.ok(relayAlive(id), 'not stopped');
    assert.ok((await closeRelay(rig.dir, run))?.pid);
    assert.equal(relay(id).closed, true);
  });
});

describe('a reboot closes every open run on load: the containers it left are still removed', () => {
  it('the serve daemon sweeps a cleaned run whose containers were never removed, and never signals a record of another boot', async () => {
    const rig = new Rig({ grace: '2s' });
    const daemon = await FakeDocker.start(rig.dir);
    rig.env.RESCTL_DOCKER_SOCKET = daemon.sock;
    try {
      const by = rig.bystander();
      const kept = daemon.add({ 'resctl.run': 'other-run' }).id;
      const orphan = daemon.add({ 'resctl.run': 'rb1', 'resctl.token': 'tok-rb1' }).id; // restart=always: came back with the daemon after the reboot
      const relay = { sock: relaySocketPath(rig.dir, 'rb1'), upstream: daemon.sock, upstreams: [daemon.sock], pid: by.id.pid, startTime: by.id.startTime, bootId: 'a-previous-boot', startedAt: 1 };
      fs.writeFileSync(path.join(rig.dir, 'state.json'), JSON.stringify({ version: 1, bootId: 'a-previous-boot', runs: { rb1: { id: 'rb1', token: 'tok-rb1', owner: { pid: 1, startTime: 1 }, state: 'alive', startedAt: 1, lanes: [], relay } } }));
      rig.startDaemon();
      await waitFor('the sweep removes the container and marks it', () => !daemon.containers.has(orphan) && (rig.run('rb1')?.relay as RelayRecord | undefined)?.removed === true, 15_000);
      assert.equal(rig.run('rb1')!.state, 'cleaned', 'the load closed the run (A1)');
      assert.ok(daemon.containers.has(kept), 'another run\'s container stays');
      assert.ok(isAlive(by.id), 'a relay record of another boot signals nothing');
      by.kill();
    } finally {
      await endOpenRuns(rig);
      await daemon.stop();
      assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
    }
  });
});

