// The Docker relay against a scripted daemon (fake-docker-daemon.ts): every case asserts what a docker client
// observes THROUGH the relay — labels on the daemon side, bytes intact, streams flushed, hijack working, recovery.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createDockerRelay, superviseDockerRelay, type DockerRelay } from './docker-relay.ts';
import { startFakeDaemon, type FakeDaemon } from './fake-docker-daemon.ts';

let dir: string;
let daemon: FakeDaemon;
const logs: string[] = [];
const relays: DockerRelay[] = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  daemon = await startFakeDaemon(path.join(dir, 'd.sock'));
});
after(async () => {
  for (const r of relays) r.stop();
  await daemon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function newRelay(over: { upstream?: string } = {}): Promise<DockerRelay> {
  const r = createDockerRelay({
    sockPath: path.join(dir, `r${n++}.sock`),
    upstream: over.upstream ?? daemon.sockPath,
    ws: 'ws-1',
    run: 'run-9',
    log: (m) => logs.push(m),
  });
  relays.push(r);
  assert.equal(await r.start(), true);
  return r;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function call(r: DockerRelay, method: string, url: string, body?: Buffer | string, headers: http.OutgoingHttpHeaders = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: r.sockPath, method, path: url, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
const lastSeen = () => daemon.seen[daemon.seen.length - 1];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ── labels ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('a container create reaches the daemon carrying orchestra.ws and orchestra.run', async () => {
  const r = await newRelay();
  const res = await call(r, 'POST', '/v1.47/containers/create?name=rig-a', JSON.stringify({ Image: 'alpine', Labels: { keep: 'me' } }), {
    'content-type': 'application/json',
  });
  assert.equal(res.status, 201);
  assert.equal((JSON.parse(res.body.toString()) as { Id: string }).Id, 'fake0123456789'); // the daemon's own answer, unmodified
  const seen = lastSeen();
  assert.equal(seen.url, '/v1.47/containers/create?name=rig-a');
  const sent = JSON.parse(seen.body.toString()) as { Image: string; Labels: Record<string, string> };
  assert.deepEqual(sent.Labels, { keep: 'me', 'orchestra.ws': 'ws-1', 'orchestra.run': 'run-9' });
  assert.equal(sent.Image, 'alpine');
  assert.equal(seen.headers['content-length'], String(seen.body.length)); // framing recomputed for the stamped body
});

test('a chunked create body is stamped too (client libraries stream it)', async () => {
  const r = await newRelay();
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ socketPath: r.sockPath, method: 'POST', path: '/containers/create', headers: { 'transfer-encoding': 'chunked' }, agent: false }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write('{"Image":"al');
    setTimeout(() => req.end('pine"}'), 30);
  });
  const sent = JSON.parse(lastSeen().body.toString()) as { Image: string; Labels: Record<string, string> };
  assert.equal(sent.Image, 'alpine');
  assert.equal(sent.Labels['orchestra.ws'], 'ws-1');
  assert.equal(lastSeen().headers['transfer-encoding'], undefined);
});

test('create body integrity: a 1 MB body with 64-bit integers differs from the original only by the inserted Labels', async () => {
  const r = await newRelay();
  const pad = 'x'.repeat(1024 * 1024);
  const original = `{"Image":"a","Pad":"${pad}","HostConfig":{"Memory":9223372036854775807}}`;
  await call(r, 'POST', '/containers/create', original);
  const got = lastSeen().body.toString();
  assert.equal(got.replace(/"Labels":\{[^}]*\},/, ''), original);
  assert.ok(got.includes('9223372036854775807'));
});

test('an unstampable create body is forwarded UNTOUCHED (never a failing docker run because of the relay)', async () => {
  const r = await newRelay();
  const weird = '{"Labels":["not","an","object"],"Image":"a"}';
  const res = await call(r, 'POST', '/containers/create', weird);
  assert.equal(res.status, 201);
  assert.equal(lastSeen().body.toString(), weird);
  assert.ok(logs.some((l) => l.includes('not stampable')));
});

test('non-create calls are forwarded byte-for-byte: path, query, headers, body, no labels', async () => {
  const r = await newRelay();
  const body = '{"Detach":false,"Tty":true}';
  await call(r, 'POST', '/v1.47/containers/abc/exec', body, { 'content-type': 'application/json', 'x-registry-auth': 'tok' });
  const seen = lastSeen();
  assert.equal(seen.url, '/v1.47/containers/abc/exec');
  assert.equal(seen.body.toString(), body);
  assert.equal(seen.headers['x-registry-auth'], 'tok');
  const ping = await call(r, 'GET', '/_ping');
  assert.equal(ping.body.toString(), 'OK');
  assert.equal(ping.headers['api-version'], '1.47');
});

test('a POST with no body keeps an explicit empty framing (docker start / stop)', async () => {
  const r = await newRelay();
  const res = await call(r, 'POST', '/containers/abc/start');
  assert.equal(res.status, 200);
  assert.equal(lastSeen().headers['content-length'], '0');
});

test('daemon errors pass through with their status and body', async () => {
  const r = await newRelay();
  const res = await call(r, 'GET', '/containers/missing/missing');
  assert.equal(res.status, 404);
  assert.match(res.body.toString(), /No such container/);
});

// ── streams ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('a streaming response is flushed while the daemon holds it open (docker events / logs -f)', async () => {
  const r = await newRelay();
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ socketPath: r.sockPath, path: '/events', agent: false }, (res) => {
      const got: string[] = [];
      res.on('data', (c: Buffer) => {
        got.push(c.toString());
        if (got.join('') === '{"n":1}\n') daemon.releaseEvent(); // only after chunk 1 ARRIVED through the relay
      });
      res.on('end', () => {
        try {
          assert.equal(got.join(''), '{"n":1}\n{"n":2}\n');
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
});

test('response HEADERS reach the client while the daemon has sent no body yet (docker wait / quiet events)', async () => {
  const r = await newRelay();
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ socketPath: r.sockPath, path: '/containers/x/wait', agent: false }, (res) => {
      resolve(res.statusCode ?? 0); // fires on HEADERS — before releaseWait() below
      res.resume();
    });
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('headers were held back until the body started')), 3000);
  });
  assert.equal(status, 200);
  daemon.releaseWait();
});

test('a 4 MB response arrives intact; a chunked 3 MB upload is reassembled by the daemon', async () => {
  const r = await newRelay();
  const big = await call(r, 'GET', '/containers/x/big');
  assert.equal(big.body.length, 4 * 1024 * 1024);
  assert.equal(sha(big.body), sha(Buffer.alloc(4 * 1024 * 1024, 0x61)));

  const payload = Buffer.alloc(3 * 1024 * 1024, 0x62);
  const out = await new Promise<{ bytes: number; te: string | null }>((resolve, reject) => {
    const req = http.request({ socketPath: r.sockPath, method: 'POST', path: '/build', headers: { 'transfer-encoding': 'chunked' }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as { bytes: number; te: string | null }));
    });
    req.on('error', reject);
    for (let i = 0; i < payload.length; i += 64 * 1024) req.write(payload.subarray(i, i + 64 * 1024));
    req.end();
  });
  assert.equal(out.bytes, payload.length);
  assert.equal(out.te, 'chunked');
});

test('keep-alive: a create AFTER other calls on the SAME connection is still stamped', async () => {
  const r = await newRelay();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const go = (method: string, url: string, body?: string): Promise<{ reused: boolean }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath: r.sockPath, method, path: url, agent, headers: body ? { 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
        res.resume();
        res.on('end', () => resolve({ reused: req.reusedSocket }));
      });
      req.on('error', reject);
      req.end(body);
    });
  await go('GET', '/_ping');
  await go('POST', '/containers/abc/exec', '{"Detach":true}');
  const third = await go('POST', '/containers/create', '{"Image":"alpine"}');
  agent.destroy();
  assert.equal(third.reused, true, 'the rig must actually reuse one connection for this arm to mean anything');
  const sent = JSON.parse(lastSeen().body.toString()) as { Labels: Record<string, string> };
  assert.equal(sent.Labels['orchestra.run'], 'run-9');
});

// ── hijack ───────────────────────────────────────────────────────────────────────────────────────────────────────

function rawUpgrade(r: DockerRelay, head: string, bodyAfterHead = ''): Promise<{ sock: net.Socket; response: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(r.sockPath);
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.write(head + bodyAfterHead);
      resolve({
        sock,
        response: new Promise((res) => {
          let acc = '';
          sock.on('data', (d: Buffer) => {
            acc += d.toString('latin1');
          });
          sock.on('end', () => res(acc));
        }),
      });
    });
  });
}

test('hijacked attach: 101 comes back, then bytes flow BOTH ways until the client half-closes', { timeout: 8000 }, async () => {
  const r = await newRelay();
  const { sock, response } = await rawUpgrade(
    r,
    'POST /v1.47/containers/abc/attach?stream=1&stdin=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n',
  );
  await new Promise((res) => setTimeout(res, 100));
  sock.write('hello ');
  await new Promise((res) => setTimeout(res, 100));
  sock.write('world');
  await new Promise((res) => setTimeout(res, 100));
  sock.end(); // CloseWrite: the daemon must see EOF and finish
  const text = await response;
  assert.match(text, /^HTTP\/1\.1 101 UPGRADED/);
  assert.ok(text.endsWith('HELLO WORLD'), JSON.stringify(text));
  assert.equal(lastSeen().url, '/v1.47/containers/abc/attach?stream=1&stdin=1');
});

test('hijacked exec start with a JSON body: the body reaches the daemon BEFORE it answers 101', { timeout: 8000 }, async () => {
  const r = await newRelay();
  const body = '{"Detach":false,"Tty":true}';
  const { sock, response } = await rawUpgrade(
    r,
    `POST /exec/e1/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
    body,
  );
  await new Promise((res) => setTimeout(res, 100));
  sock.write('ls\n');
  await new Promise((res) => setTimeout(res, 100));
  sock.end();
  const text = await response;
  assert.match(text, /^HTTP\/1\.1 101 UPGRADED/);
  assert.ok(text.endsWith('LS\n'), JSON.stringify(text));
  assert.equal(lastSeen().body.toString(), body);
});

// ── failure behaviour ────────────────────────────────────────────────────────────────────────────────────────────

test('daemon unreachable → a clean 502 JSON error, relay stays up', async () => {
  const r = await newRelay({ upstream: path.join(dir, 'nope.sock') });
  const res = await call(r, 'GET', '/_ping');
  assert.equal(res.status, 502);
  assert.match(res.body.toString(), /cannot reach the Docker daemon/);
  assert.equal(r.healthy(), true);
});

test('the socket is owner-only (it is full docker access)', async () => {
  const r = await newRelay();
  assert.equal(fs.statSync(r.sockPath).mode & 0o777, 0o600);
});

test('a client that vanishes mid-stream leaves the relay serving the next call', async () => {
  const r = await newRelay();
  await new Promise<void>((resolve) => {
    const req = http.request({ socketPath: r.sockPath, path: '/events', agent: false }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => {});
    req.end();
  });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await call(r, 'GET', '/_ping')).status, 200);
});

// ── supervision ──────────────────────────────────────────────────────────────────────────────────────────────────

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

test('supervisor: a killed relay is back within the check interval, and the next create is labelled', async () => {
  const r = await newRelay();
  const sup = superviseDockerRelay(r, { checkMs: 50, log: (m) => logs.push(m) });
  r.kill();
  assert.equal(r.healthy(), false);
  assert.equal(fs.existsSync(r.sockPath), false);
  assert.equal(await until(() => r.healthy(), 3000), true, 'relay was not restarted');
  await call(r, 'POST', '/containers/create', '{"Image":"alpine"}');
  assert.equal((JSON.parse(lastSeen().body.toString()) as { Labels: Record<string, string> }).Labels['orchestra.ws'], 'ws-1');
  sup.stop();
});

test('supervisor: a deleted socket file is restored', async () => {
  const r = await newRelay();
  const sup = superviseDockerRelay(r, { checkMs: 50, log: () => {} });
  fs.unlinkSync(r.sockPath);
  assert.equal(await until(() => r.healthy() && fs.existsSync(r.sockPath), 3000), true);
  assert.equal((await call(r, 'GET', '/_ping')).status, 200);
  sup.stop();
});

test('supervisor control: with NO supervisor a killed relay stays dead (the arm above can fail)', async () => {
  const r = await newRelay();
  r.kill();
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.healthy(), false);
});

test('start fails cleanly when the socket path is unusable (a directory in the way) and recovers once it is cleared', async () => {
  const p = path.join(dir, 'blocked.sock');
  fs.mkdirSync(path.join(p, 'sub'), { recursive: true });
  const r = createDockerRelay({ sockPath: p, upstream: daemon.sockPath, ws: 'ws-1', run: 'run-9', log: (m) => logs.push(m) });
  relays.push(r);
  assert.equal(await r.start(), false);
  assert.equal(r.healthy(), false);
  const sup = superviseDockerRelay(r, { checkMs: 50, log: () => {} });
  fs.rmSync(p, { recursive: true });
  assert.equal(await until(() => r.healthy(), 5000), true, 'never recovered after the obstacle was removed');
  sup.stop();
});

test('a stale socket file left by a SIGKILLed keeper is replaced, not an EADDRINUSE', async () => {
  const p = path.join(dir, 'stale.sock');
  fs.writeFileSync(p, ''); // what a killed keeper leaves behind
  const r = createDockerRelay({ sockPath: p, upstream: daemon.sockPath, ws: 'ws-1', run: 'run-9', log: () => {} });
  relays.push(r);
  assert.equal(await r.start(), true);
  assert.equal((await call(r, 'GET', '/_ping')).status, 200);
});

test('an over-long socket path fails to start (false), it does not throw', async () => {
  const r = createDockerRelay({ sockPath: '/tmp/' + 'a'.repeat(200) + '.sock', upstream: daemon.sockPath, ws: 'w', run: 'r', log: () => {} });
  assert.equal(await r.start(), false);
});
