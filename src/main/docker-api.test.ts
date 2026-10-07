// #291 / FI-1.2 — the app's real-socket Docker client against a scripted daemon on a unix socket, and with an injected
// transport. Asserts what the daemon was ASKED (path, filters) and how each status maps to an outcome.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDockerApi, dockerApiForMember, DockerApiError, readRelayUpstream, resolveRealDockerSocket, type DockerTransport } from './docker-api.ts';

let dir: string;
let server: http.Server;
const seen: Array<{ method: string; url: string }> = [];
let sock: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dapi-'));
  sock = path.join(dir, 'd.sock');
  server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    const u = req.url ?? '';
    const json = (code: number, o: unknown) => {
      const b = JSON.stringify(o);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
      res.end(b);
    };
    const bare = (code: number) => {
      res.writeHead(code, { 'content-length': 0 });
      res.end();
    };
    if (u === '/_ping') return void res.writeHead(200, { 'content-length': 2 }).end('OK');
    if (u.startsWith('/containers/json')) {
      return json(200, [
        { Id: 'aaa', Names: ['/g-web'], Image: 'alpine', State: 'running', Status: 'Up 1 minute', Created: 1700000000, Labels: { 'orchestra.ws': 'ws-1', 'orchestra.run': 'run-1' } },
        { Id: 'bbb', Names: ['/g-db'], Image: 'mysql', State: 'exited', Status: 'Exited (0)', Created: 1700000001, Labels: null },
      ]);
    }
    if (u === '/containers/aaa/json') return json(200, { Id: 'aaa', Name: '/g-web', Config: { Image: 'alpine', Labels: { 'orchestra.ws': 'ws-1' } }, State: { Running: true }, HostConfig: { AutoRemove: true } });
    if (u === '/containers/gone/json') return json(404, { message: 'No such container: gone' });
    if (u === '/containers/boom/json') return json(500, { message: 'daemon exploded' });
    if (u === '/containers/aaa/stop?t=10') return bare(204);
    if (u === '/containers/bbb/stop?t=10') return bare(304);
    if (u.startsWith('/containers/gone/stop')) return json(404, { message: 'No such container: gone' });
    if (u === '/containers/aaa/start') return bare(204);
    if (u === '/containers/bbb/start') return bare(304);
    if (u === '/containers/gone/start') return json(404, { message: 'No such container: gone' });
    if (u.startsWith('/containers/aaa/stats')) return json(200, { memory_stats: { usage: 1234 } });
    if (u.startsWith('/containers/gone/stats')) return json(404, { message: 'No such container: gone' });
    return json(500, { message: `unscripted ${u}` });
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listContainers: label + status filters reach the daemon as its filters JSON; rows are normalised', async () => {
  const api = createDockerApi({ socketPath: sock });
  seen.length = 0;
  const rows = await api.listContainers({ labels: ['orchestra.ws=ws-1'], status: ['running'] });
  const url = new URL('http://x' + seen[0].url);
  assert.equal(url.pathname, '/containers/json');
  assert.equal(url.searchParams.get('all'), '0');
  assert.deepEqual(JSON.parse(url.searchParams.get('filters')!), { label: ['orchestra.ws=ws-1'], status: ['running'] });
  assert.equal(rows[0].name, 'g-web');
  assert.equal(rows[0].labels['orchestra.run'], 'run-1');
  assert.deepEqual(rows[1].labels, {}); // a null Labels from the daemon reads as {}
  assert.equal(rows[1].state, 'exited');
});

test('listContainers {all:true} asks for stopped ones too', async () => {
  const api = createDockerApi({ socketPath: sock });
  seen.length = 0;
  await api.listContainers({ all: true });
  assert.match(seen[0].url, /all=1/);
  assert.doesNotMatch(seen[0].url, /filters=/);
});

test('inspectContainer: AutoRemove is read (a --rm container must not be stopped); 404 → null; 500 → http error', async () => {
  const api = createDockerApi({ socketPath: sock });
  const c = await api.inspectContainer('aaa');
  assert.deepEqual(c, { id: 'aaa', name: 'g-web', image: 'alpine', running: true, autoRemove: true, labels: { 'orchestra.ws': 'ws-1' } });
  assert.equal(await api.inspectContainer('gone'), null);
  await assert.rejects(api.inspectContainer('boom'), (e: DockerApiError) => e instanceof DockerApiError && e.kind === 'http' && e.status === 500 && /daemon exploded/.test(e.message));
});

test('stop / start map 204/304/404 to outcomes and use the frozen verbs (stop?t=10, start)', async () => {
  const api = createDockerApi({ socketPath: sock });
  seen.length = 0;
  assert.equal(await api.stopContainer('aaa'), 'stopped');
  assert.equal(await api.stopContainer('bbb'), 'already-stopped');
  assert.equal(await api.stopContainer('gone'), 'gone');
  assert.equal(await api.startContainer('aaa'), 'started');
  assert.equal(await api.startContainer('bbb'), 'already-running');
  assert.equal(await api.startContainer('gone'), 'gone');
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [
    'POST /containers/aaa/stop?t=10',
    'POST /containers/bbb/stop?t=10',
    'POST /containers/gone/stop?t=10',
    'POST /containers/aaa/start',
    'POST /containers/bbb/start',
    'POST /containers/gone/start',
  ]);
  // never remove / kill / pause
  assert.ok(!seen.some((s) => /\/kill|\/pause|\/remove|DELETE/.test(`${s.method} ${s.url}`)));
});

test('containerStats returns the daemon JSON as is; unknown container → null', async () => {
  const api = createDockerApi({ socketPath: sock });
  assert.deepEqual(await api.containerStats('aaa'), { memory_stats: { usage: 1234 } });
  assert.equal(await api.containerStats('gone'), null);
});

test('available(): true with a daemon, false without — never throws', async () => {
  assert.equal(await createDockerApi({ socketPath: sock }).available(), true);
  assert.equal(await createDockerApi({ socketPath: path.join(dir, 'nope.sock') }).available(), false);
  assert.equal(await createDockerApi({ socketPath: null }).available(), false);
});

test('no daemon → DockerApiError kind unavailable (callers record it, never crash)', async () => {
  const api = createDockerApi({ socketPath: path.join(dir, 'nope.sock') });
  await assert.rejects(api.listContainers(), (e: DockerApiError) => e instanceof DockerApiError && e.kind === 'unavailable');
  await assert.rejects(createDockerApi({ socketPath: null }).stopContainer('x'), (e: DockerApiError) => e.kind === 'unavailable');
});

test('a daemon that never answers → kind timeout', async () => {
  const hang = http.createServer(() => {});
  const p = path.join(dir, 'hang.sock');
  await new Promise<void>((r) => hang.listen(p, r));
  const api = createDockerApi({ socketPath: p, timeoutMs: 100 });
  await assert.rejects(api.listContainers(), (e: DockerApiError) => e.kind === 'timeout');
  hang.closeAllConnections();
  hang.close();
});

test('injectable transport: no socket involved', async () => {
  const calls: string[] = [];
  const transport: DockerTransport = async (r) => {
    calls.push(`${r.method} ${r.path}`);
    return { status: 204, body: Buffer.alloc(0) };
  };
  const api = createDockerApi({ transport });
  assert.equal(api.socketPath, null);
  assert.equal(await api.stopContainer('c1', 3), 'stopped');
  assert.deepEqual(calls, ['POST /containers/c1/stop?t=3']);
});

// ── socket resolution: the REAL socket, never a relay ───────────────────────────────────────────────────────────

// ── F2: the app resolves the daemon through the SAME function the relay forwards through ─────────────────────────

import { resolveRelayUpstream, type UpstreamDeps } from '../shared/docker-relay.ts';

const depsFor = (o: { sockets?: string[]; ctx?: string | null } = {}): UpstreamDeps => ({
  dockerContextHost: () => (o.ctx === undefined ? 'unix:///var/run/docker.sock' : o.ctx),
  pathKind: (p) => ((o.sockets ?? ['/var/run/docker.sock']).includes(p) ? 'socket' : 'missing'),
});

test('F2: ORCHESTRA_DOCKER_SOCKET (the relay honours it) is honoured by the app client too', async () => {
  assert.equal(await resolveRealDockerSocket({ ORCHESTRA_DOCKER_SOCKET: '/x/alt.sock' }, depsFor({ sockets: ['/x/alt.sock', '/var/run/docker.sock'] })), '/x/alt.sock');
});

test('F2: a non-default docker context (Docker Desktop, colima…) is honoured; a non-unix endpoint resolves to null, never to the local daemon', async () => {
  assert.equal(await resolveRealDockerSocket({}, depsFor({ ctx: 'unix:///Users/u/.docker/run/docker.sock', sockets: ['/Users/u/.docker/run/docker.sock', '/var/run/docker.sock'] })), '/Users/u/.docker/run/docker.sock');
  assert.equal(await resolveRealDockerSocket({}, depsFor({ ctx: 'tcp://remote:2376' })), null);
  assert.equal(await resolveRealDockerSocket({ DOCKER_HOST: 'ssh://me@box' }, depsFor()), null);
});

test('F2: the app and the relay can NEVER disagree — same inputs, same socket, across the whole resolution matrix', async () => {
  const cases: Array<[string, Record<string, string>, UpstreamDeps]> = [
    ['default', {}, depsFor()],
    ['no docker CLI', {}, depsFor({ ctx: null })],
    ['own unix DOCKER_HOST', { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, depsFor({ sockets: ['/run/user/1000/docker.sock'] })],
    ['relay-shaped DOCKER_HOST', { DOCKER_HOST: 'unix:///h/.orchestra/keepers/ws.docker.sock' }, depsFor({ sockets: ['/var/run/docker.sock', '/h/.orchestra/keepers/ws.docker.sock'] })],
    ['explicit override', { ORCHESTRA_DOCKER_SOCKET: '/x/alt.sock', DOCKER_HOST: 'tcp://h:1' }, depsFor({ sockets: ['/x/alt.sock'] })],
    ['desktop context', {}, depsFor({ ctx: 'unix:///d/docker.sock', sockets: ['/d/docker.sock'] })],
    ['tcp context', {}, depsFor({ ctx: 'tcp://r:1' })],
    ['daemon not up yet', {}, depsFor({ sockets: [] })],
  ];
  for (const [name, env, deps] of cases) {
    const relay = await resolveRelayUpstream(env, deps);
    const app = await resolveRealDockerSocket(env, deps);
    assert.equal(app, relay.ok ? relay.socketPath : null, name);
  }
});

test('F2: the default client resolves PER USE with the injected env/deps — a socket that appears later is used, no restart', async () => {
  const late = path.join(dir, 'late-d.sock');
  const api = createDockerApi({ env: { ORCHESTRA_DOCKER_SOCKET: late }, deps: depsFor({ sockets: [] }) });
  assert.equal(api.socketPath, null, 'nothing pinned: it resolves per use');
  assert.equal(await api.resolveSocket(), late);
  assert.equal(await api.available(), false); // dockerd not started yet
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': 2 });
    res.end('OK');
  });
  await new Promise<void>((r) => srv.listen(late, r));
  try {
    assert.equal(await api.available(), true);
  } finally {
    srv.close();
  }
});

test('F2: a relay-shaped DOCKER_HOST inherited by the app is never used by the client', async () => {
  const r = await resolveRealDockerSocket({ DOCKER_HOST: 'unix:///h/.orchestra/keepers/ws-1.docker.sock' }, depsFor({ sockets: ['/var/run/docker.sock', '/h/.orchestra/keepers/ws-1.docker.sock'] }));
  assert.equal(r, '/var/run/docker.sock');
  assert.equal(await resolveRealDockerSocket({ DOCKER_HOST: 'unix:///tmp/okeeper-0123456789abcdef.docker.sock' }, depsFor()), '/var/run/docker.sock');
});

// ── review #2/#8/#3: the per-use resolution is cached SHORT when it is a guess / no daemon yet, deduped, invalidated on a dead socket, and a keeper's published upstream wins ──

import { relayUpstreamFile } from '../shared/docker-relay.ts';

function counting(ctx: () => string | null, sockets: () => string[]): { deps: UpstreamDeps; calls: { ctx: number } } {
  const calls = { ctx: 0 };
  return {
    calls,
    deps: {
      dockerContextHost: async () => {
        calls.ctx++;
        return ctx();
      },
      pathKind: (p) => (sockets().includes(p) ? 'socket' : 'missing'),
    },
  };
}

test('cache: a daemon that is UP on a path the context named is trusted for 60 s (one `docker context inspect`), then re-read', async () => {
  let t = 1000;
  const c = counting(() => 'unix:///d/docker.sock', () => ['/d/docker.sock']);
  const api = createDockerApi({ env: {}, deps: c.deps, now: () => t });
  assert.equal(await api.resolveSocket(), '/d/docker.sock');
  t += 59_000;
  assert.equal(await api.resolveSocket(), '/d/docker.sock');
  assert.equal(c.calls.ctx, 1, 'within the TTL: no second lookup');
  t += 2_000;
  await api.resolveSocket();
  assert.equal(c.calls.ctx, 2, 'past the TTL it is re-read (a docker context switch is noticed)');
});

test('cache: NOT-UP-YET and GUESSED resolutions are re-read after 2 s, never cached for a minute (a daemon that appears / a flaky context lookup recovers)', async () => {
  let t = 1000;
  let daemonUp = false;
  const c = counting(() => 'unix:///d/docker.sock', () => (daemonUp ? ['/d/docker.sock'] : []));
  const api = createDockerApi({ env: {}, deps: c.deps, now: () => t });
  await api.resolveSocket(); // path named by the context, no daemon yet
  t += 2_500;
  daemonUp = true;
  await api.resolveSocket();
  assert.equal(c.calls.ctx, 2, 'a no-daemon-yet resolution is short-lived');
  // a default GUESS (the context lookup failed) is short-lived too
  let ctxOk = false;
  const g = counting(() => (ctxOk ? 'unix:///real/docker.sock' : null), () => ['/var/run/docker.sock', '/real/docker.sock']);
  const api2 = createDockerApi({ env: {}, deps: g.deps, now: () => t });
  assert.equal(await api2.resolveSocket(), '/var/run/docker.sock');
  ctxOk = true;
  t += 2_500;
  assert.equal(await api2.resolveSocket(), '/real/docker.sock', 'the flaky lookup recovered within seconds, not a minute');
});

test('cache: N concurrent cold callers share ONE lookup (the Pause fans out over every member)', async () => {
  const c = counting(() => 'unix:///d/docker.sock', () => ['/d/docker.sock']);
  const api = createDockerApi({ env: {}, deps: c.deps });
  const all = await Promise.all(Array.from({ length: 10 }, () => api.resolveSocket()));
  assert.ok(all.every((p) => p === '/d/docker.sock'));
  assert.equal(c.calls.ctx, 1);
});

test('cache: a call that finds the resolved socket DEAD drops the resolution — the next call re-resolves (a context switch / a moved daemon)', async () => {
  let ctx = 'unix:///old/docker.sock';
  const c = counting(() => ctx, () => ['/old/docker.sock', '/new/docker.sock']);
  const api = createDockerApi({ env: {}, deps: c.deps, now: () => 1000 });
  assert.equal(await api.resolveSocket(), '/old/docker.sock');
  await assert.rejects(api.listContainers(), (e: DockerApiError) => e.kind === 'unavailable'); // nothing really listens on /old/docker.sock
  ctx = 'unix:///new/docker.sock';
  assert.equal(await api.resolveSocket(), '/new/docker.sock', 'resolved afresh even though the TTL has not elapsed');
});

test('readRelayUpstream / dockerApiForMember: the daemon the keeper\'s relay STAMPS ON beats the app\'s own resolution; junk and relay-shaped content are ignored', () => {
  const keeperSock = path.join(dir, 'kws.sock');
  assert.equal(readRelayUpstream(keeperSock), null, 'no keeper published one');
  const file = relayUpstreamFile(keeperSock);
  fs.writeFileSync(file, '/stamped/on/docker.sock\n');
  assert.equal(readRelayUpstream(keeperSock), '/stamped/on/docker.sock');
  const fallback = createDockerApi({ socketPath: '/app/own.sock' });
  assert.equal(dockerApiForMember(keeperSock, fallback).socketPath, '/stamped/on/docker.sock');
  for (const junk of ['relative/path.sock', '', '   ', '/h/keepers/other.docker.sock']) {
    fs.writeFileSync(file, junk);
    assert.equal(readRelayUpstream(keeperSock), null, JSON.stringify(junk));
    assert.equal(dockerApiForMember(keeperSock, fallback), fallback, 'falls back to the app\'s own client');
  }
});
