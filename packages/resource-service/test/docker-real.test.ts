// Acceptance of #450 against a REAL Docker daemon (no skip: without a reachable daemon this suite FAILS, a green run must mean the containers were really labelled and removed).
// Every test container carries `resctl.test=<token>`; `after` sweeps by that label and asserts nothing is left (`docker ps -a --filter label=resctl.test`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { endRun } from './lib/cli-async.ts';
import { request } from './lib/http.ts';
import { Rig, waitFor } from './lib/rig.ts';
import { realUpstreamDeps, resolveUpstream } from '../src/relay-host.ts';

const TOKEN = randomBytes(4).toString('hex');
const IMAGE = process.env.RESCTL_TEST_IMAGE || 'alpine:3';
const TEST_LABEL = `resctl.test=${TOKEN}`;

let upstream = '';
/** The docker CLI. `host` = a relay socket; default = the real daemon the relay forwards to. */
function docker(args: string[], host: string = upstream, input?: string): { status: number | null; out: string; err: string } {
  const r = spawnSync('docker', args, { env: { ...process.env, DOCKER_HOST: `unix://${host}` }, encoding: 'utf8', input, timeout: 120_000 });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const ok = (r: { status: number | null; out: string; err: string }): string => {
  assert.equal(r.status, 0, r.err);
  return r.out;
};
const exists = (ref: string): boolean => docker(['container', 'inspect', ref]).status === 0;
const labelOf = (ref: string, key: string): string => ok(docker(['container', 'inspect', '--format', `{{index .Config.Labels "${key}"}}`, ref]));
const sweep = (): string[] => ok(docker(['ps', '-a', '-q', '--filter', `label=${TEST_LABEL}`])).split('\n').filter(Boolean);
const volumesToDrop: string[] = [];

describe('real Docker: containers carry the run id and leave with the run', () => {
  let rig: Rig;
  let n = 0;
  const newRun = (): { id: string; coord: ReturnType<Rig['coordinator']>; host: string } => {
    const id = `d${TOKEN.slice(0, 3)}${++n}`;
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', id, '--owner', String(coord.pid)]).status, 0);
    return { id, coord, host: '' };
  };
  const endpoint = (id: string): string => {
    const r = rig.cli(['docker-env', '--run', id]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().replace(/^export DOCKER_HOST=unix:\/\//, '');
  };
  /** `docker run -d` through `host`: a tiny labelled container that sleeps. */
  const run = (host: string, name: string, extra: string[] = []): string => ok(docker(['run', '-d', '--pull', 'never', '--label', TEST_LABEL, '--name', `resctl-t-${TOKEN}-${name}`, ...extra, IMAGE, 'sleep', '300'], host));

  before(() => {
    return resolveUpstream(process.env, realUpstreamDeps).then((u) => {
      assert.ok(u.ok, `this suite needs a reachable Docker daemon: ${u.ok ? '' : u.reason}`);
      upstream = u.socketPath;
      assert.equal(docker(['version', '--format', '{{.Server.Version}}']).status, 0, 'docker daemon not answering');
      if (docker(['image', 'inspect', IMAGE]).status !== 0) ok(docker(['pull', IMAGE]));
      assert.deepEqual(sweep(), [], 'test containers of an earlier run are still there');
      rig = new Rig({ grace: '2s' });
    });
  });
  after(async () => {
    const left = sweep();
    if (left.length) docker(['rm', '-f', '-v', ...left]);
    for (const v of volumesToDrop) docker(['volume', 'rm', '-f', v]);
    const leaked = await rig.dispose();
    assert.deepEqual(sweep(), [], 'test containers left behind (swept)');
    assert.deepEqual(leaked, [], 'a process was left behind');
  });

  it('a real container created through the endpoint carries the run label — docker run, docker create, compose, a client library', async () => {
    const { id } = newRun();
    const host = endpoint(id);
    assert.match(host, /\.resctl-docker\.sock$/);

    const viaRun = run(host, 'run');
    assert.equal(labelOf(viaRun, 'resctl.run'), id, 'docker run');
    assert.equal(labelOf(viaRun, 'resctl.test'), TOKEN, 'the caller\'s own labels are kept');

    const viaCreate = ok(docker(['create', '--pull', 'never', '--label', TEST_LABEL, '--name', `resctl-t-${TOKEN}-create`, IMAGE, 'true'], host));
    assert.equal(labelOf(viaCreate, 'resctl.run'), id, 'docker create (never started)');

    const yaml = `services:\n  s:\n    image: ${IMAGE}\n    pull_policy: never\n    network_mode: none\n    command: sleep 300\n    labels:\n      resctl.test: "${TOKEN}"\n`;
    ok(docker(['compose', '-p', `resctl-t-${TOKEN}-c`, '-f', '-', 'up', '-d'], host, yaml));
    const composed = ok(docker(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=resctl-t-${TOKEN}-c`])).split('\n').filter(Boolean);
    assert.equal(composed.length, 1, 'compose made its container');
    assert.equal(labelOf(composed[0], 'resctl.run'), id, 'docker compose up');

    // a client library: versioned path, chunked body, no docker CLI
    const lib = await request(host, 'POST', `/v1.43/containers/create?name=resctl-t-${TOKEN}-lib`, { chunks: [`{"Image":"${IMAGE}","Cmd":["true"],`, `"Labels":{"resctl.test":"${TOKEN}"}}`], headers: { 'content-type': 'application/json' } });
    assert.equal(lib.status, 201, lib.body);
    assert.equal(labelOf((JSON.parse(lib.body) as { Id: string }).Id, 'resctl.run'), id, 'client library');

    // a container made AROUND the endpoint (straight on the daemon) has no run label
    const around = run(upstream, 'around');
    assert.equal(labelOf(around, 'resctl.run'), '', 'unlabelled');
    ok(docker(['rm', '-f', around]));
    assert.equal((await endRun(rig, id)).status, 0);
  });

  it('after the run\'s cleanup its containers are gone; another run\'s container and an unlabelled one stay', async () => {
    const A = newRun();
    const B = newRun();
    const hostA = endpoint(A.id);
    const hostB = endpoint(B.id);
    const a1 = run(hostA, 'a1', ['-v', '/resctl-anon']); // an anonymous volume: removed with the container
    const volume = ok(docker(['container', 'inspect', '--format', '{{range .Mounts}}{{.Name}}{{end}}', a1]));
    volumesToDrop.push(volume);
    assert.ok(volume, 'the container has an anonymous volume');
    const a2 = ok(docker(['create', '--pull', 'never', '--label', TEST_LABEL, '--name', `resctl-t-${TOKEN}-a2`, IMAGE, 'true'], hostA)); // created, never started
    const b1 = run(hostB, 'b1');
    const u1 = run(upstream, 'u1'); // no relay: unlabelled
    assert.equal(labelOf(a1, 'resctl.run'), A.id);
    assert.equal(labelOf(b1, 'resctl.run'), B.id);
    assert.equal(labelOf(u1, 'resctl.run'), '');

    const t0 = Date.now();
    const r = await endRun(rig, A.id);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!exists(a1) && !exists(a2), 'run A\'s containers (running and created) are gone');
    assert.notEqual(docker(['volume', 'inspect', volume]).status, 0, 'its anonymous volume went with it');
    assert.ok(exists(b1), 'run B\'s container stays');
    assert.equal(ok(docker(['inspect', '--format', '{{.State.Running}}', b1])), 'true');
    assert.ok(exists(u1), 'the unlabelled container stays');
    assert.ok(Date.now() - t0 < 30_000);

    assert.equal((await endRun(rig, B.id)).status, 0);
    assert.ok(!exists(b1));
    assert.ok(exists(u1), 'still the unlabelled one');
  });

  it('must-FAIL arm — the relay off: a container made around it carries no label and the cleanup leaves it (same flow, relay on removes it)', async () => {
    const R = newRun();
    const on = run(endpoint(R.id), 'on');
    const off = run(upstream, 'off'); // the same `docker run`, but the caller bypassed the relay
    assert.equal(labelOf(on, 'resctl.run'), R.id);
    assert.equal(labelOf(off, 'resctl.run'), '');
    assert.equal((await endRun(rig, R.id)).status, 0);
    assert.ok(!exists(on), 'relay ON: removed');
    assert.ok(exists(off), 'relay OFF: the unlabelled container is left');
    ok(docker(['rm', '-f', off]));
  });

  it('a run that never started a relay: its cleanup does not touch any container', async () => {
    const R = newRun();
    const around = run(upstream, 'norelay');
    assert.equal((await endRun(rig, R.id)).status, 0);
    assert.ok(exists(around));
    ok(docker(['rm', '-f', around]));
  });

  it('review (delta): docker exec and docker attach through the endpoint work (an Upgrade request with a body, then a raw pipe)', () => {
    const R = newRun();
    const host = endpoint(R.id);
    const c = run(host, 'exec');
    assert.equal(ok(docker(['exec', c, 'echo', 'through-the-relay'], host)), 'through-the-relay');
    assert.equal(ok(docker(['exec', '-i', c, 'sh', '-c', 'cat; echo done'], host, 'stdin-through-the-relay\n')), 'stdin-through-the-relay\ndone');
    const a = ok(docker(['run', '--pull', 'never', '--rm', '--label', TEST_LABEL, '--name', `resctl-t-${TOKEN}-att`, IMAGE, 'echo', 'attached'], host));
    assert.match(a, /attached/);
    ok(docker(['rm', '-f', c]));
  });

  it('review M1: a version segment with a trailing dot (`/v1.54./`) is routed by the daemon and stamped by the relay', async () => {
    const R = newRun();
    const host = endpoint(R.id);
    const api = ok(docker(['version', '--format', '{{.Server.APIVersion}}']));
    for (const [i, seg] of [`v${api}.`, `v${api}..`].entries()) {
      const r = await request(host, 'POST', `/${seg}/containers/create?name=resctl-t-${TOKEN}-v${i}`, { body: `{"Image":"${IMAGE}","Cmd":["true"],"Labels":{"resctl.test":"${TOKEN}"}}`, headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 201, `${seg}: ${r.body}`);
      assert.equal(labelOf((JSON.parse(r.body) as { Id: string }).Id, 'resctl.run'), R.id, seg);
    }
    assert.equal((await endRun(rig, R.id)).status, 0);
    assert.deepEqual(sweep().filter((c) => labelOf(c, 'resctl.run') === R.id), [], 'both are gone after the cleanup');
  });

  it('review M2: an Upgrade request dockerd does not hijack (GET /_ping), then a create on the SAME connection: no unlabelled container', async () => {
    const R = newRun();
    const host = endpoint(R.id);
    const body = `{"Image":"${IMAGE}","Cmd":["true"],"Labels":{"resctl.test":"${TOKEN}"}}`;
    const post = `POST /containers/create?name=resctl-t-${TOKEN}-up HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const ping = 'GET /_ping HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n';
    for (const sameWrite of [true, false]) {
      const known = new Set(sweep()); // fixtures of the other tests stay out of this arm
      await new Promise<void>((resolve) => {
        const s = net.connect(host);
        let buf = '';
        let sent = false;
        s.on('connect', () => s.write(sameWrite ? ping + post : ping));
        s.on('data', (d) => {
          buf += d.toString();
          if (!sameWrite && !sent && buf.includes('OK')) {
            sent = true;
            s.write(post);
          }
        });
        s.on('close', () => resolve());
        s.on('error', () => resolve());
        setTimeout(() => s.destroy(), 2500);
      });
      const fresh = sweep().filter((c) => !known.has(c));
      const unlabelled = fresh.filter((c) => labelOf(c, 'resctl.run') === '');
      assert.deepEqual(unlabelled, [], `no unlabelled container (${sameWrite ? 'same write' : 'after the answer'})`);
      for (const c of fresh) ok(docker(['rm', '-f', c])); // whatever got through (labelled) goes
    }
    assert.equal((await endRun(rig, R.id)).status, 0);
  });

  it('review M3: two state dirs on the real daemon that reuse one run id — ending X leaves Y\'s container', async () => {
    const X = newRun();
    const rigY = new Rig({ grace: '2s' });
    try {
      const cy = rigY.coordinator();
      assert.equal(rigY.cli(['run', 'start', '--id', X.id, '--owner', String(cy.pid)]).status, 0);
      const ry = rigY.cli(['docker-env', '--run', X.id]);
      assert.equal(ry.status, 0, ry.stderr);
      const cX = run(endpoint(X.id), 'sx');
      const cY = run(ry.stdout.trim().replace(/^export DOCKER_HOST=unix:\/\//, ''), 'sy');
      assert.equal(labelOf(cX, 'resctl.run'), labelOf(cY, 'resctl.run'), 'same id');
      assert.notEqual(labelOf(cX, 'resctl.token'), labelOf(cY, 'resctl.token'), 'another instance');
      assert.equal((await endRun(rig, X.id)).status, 0);
      assert.ok(!exists(cX));
      assert.ok(exists(cY), 'Y\'s container stays');
      assert.equal((await endRun(rigY, X.id)).status, 0);
      assert.ok(!exists(cY));
    } finally {
      await rigY.dispose();
    }
  });

  it('the reaper removes the container when the coordinator dies, after the grace', async () => {
    const R = newRun();
    const c = run(endpoint(R.id), 'reap');
    const d = rig.startDaemon();
    await R.coord.kill();
    await waitFor('run cleaned by the reaper', () => rig.run(R.id)?.state === 'cleaned', 20_000);
    assert.ok(!exists(c), 'container removed by the reaper');
    d.child.kill('SIGTERM');
  });
});
