// #291 / FI-1.2 — the app's real-socket Docker client against a scripted daemon on a unix socket, and with an injected
// transport. Asserts what the daemon was ASKED (path, filters) and how each status maps to an outcome.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDockerApi, DockerApiError, resolveRealDockerSocket, type DockerTransport } from './docker-api.ts';

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

test('resolveRealDockerSocket: own DOCKER_HOST (unix) wins; a RELAY DOCKER_HOST is ignored; default and rootless fall-backs', () => {
  const only = (...ps: string[]) => (p: string) => ps.includes(p);
  assert.equal(resolveRealDockerSocket({ DOCKER_HOST: 'unix:///custom/d.sock' }, only('/custom/d.sock', '/var/run/docker.sock')), '/custom/d.sock');
  // inherited from a relay-ON member's shell: must NOT be used even though it exists
  assert.equal(resolveRealDockerSocket({ DOCKER_HOST: 'unix:///h/.orchestra/keepers/ws.docker.sock' }, only('/h/.orchestra/keepers/ws.docker.sock', '/var/run/docker.sock')), '/var/run/docker.sock');
  // …including the tmpdir-fallback relay name keeperSocketPath produces for long homes
  assert.equal(resolveRealDockerSocket({ DOCKER_HOST: 'unix:///tmp/okeeper-0123456789abcdef.docker.sock' }, only('/tmp/okeeper-0123456789abcdef.docker.sock', '/var/run/docker.sock')), '/var/run/docker.sock');
  assert.equal(resolveRealDockerSocket({ DOCKER_HOST: 'tcp://h:2375' }, only('/var/run/docker.sock')), '/var/run/docker.sock');
  assert.equal(resolveRealDockerSocket({ XDG_RUNTIME_DIR: '/run/user/1000' }, only('/run/user/1000/docker.sock')), '/run/user/1000/docker.sock');
  assert.equal(resolveRealDockerSocket({}, only()), null);
});
