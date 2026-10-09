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

// ── R13 (ledger #329): the daemon is never the FIRST to close ───────────────────────────────────────────────────────────────────────
// Measured on the host's real dockerd 29.5.3 (probe + raw sockets): a request sent with `Connection: close` (node's agent:false default) is answered AND the connection closed as soon as the body is complete; the empty write node
// queues behind a slow flush then fails with EPIPE and the relay answered 502 for a call dockerd had RUN (a volume that exists, a container that was created): 74 of 960 with `close`, 0 of 960 with `keep-alive`.

test('R13: every upstream request asks for keep-alive — the daemon has no reason to close before the relay\'s last write (GET, body POST, buffered create, chunked create)', async () => {
  const r = await newRelay();
  const created: Array<[string, string]> = [];
  await call(r, 'GET', '/_ping');
  await call(r, 'POST', '/v1.41/volumes/create', '{"Name":"v"}', { 'content-type': 'application/json' });
  await call(r, 'POST', '/containers/abc/start');
  await call(r, 'POST', '/containers/create', '{"Image":"x"}', { 'content-type': 'application/json' });
  const chunked = http.request({ socketPath: r.sockPath, method: 'POST', path: '/containers/create', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, agent: false });
  await new Promise<void>((resolve, reject) => {
    chunked.on('response', (res) => { res.resume(); res.on('end', () => resolve()); });
    chunked.on('error', reject);
    chunked.write('{"Image":');
    chunked.end('"y"}');
  });
  for (const s of daemon.seen.slice(-5)) created.push([`${s.method} ${s.url}`, String(s.headers.connection)]);
  assert.equal(created.length, 5);
  for (const [what, conn] of created) assert.equal(conn, 'keep-alive', `${what} reached the daemon with Connection: ${conn}`);
  await until(() => daemon.openConnections() === 0, 2000); // let the relay close what it opened: the next case counts connections
});

test('R13: keep-alive upstream leaks nothing — the relay closes the daemon connection after each response (agent:false)', async () => {
  const r = await newRelay();
  const before = daemon.openConnections();
  for (let i = 0; i < 12; i++) {
    await call(r, 'POST', '/v1.41/volumes/create', `{"Name":"v${i}"}`, { 'content-type': 'application/json' });
    await call(r, 'GET', '/_ping');
  }
  assert.equal(await until(() => daemon.openConnections() <= before, 2000), true, `${daemon.openConnections()} daemon connections still open after 24 calls (before: ${before})`);
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

test('a 40 KB request header (X-Registry-Config on a legacy build) passes — node\'s 16 KB default cap must not apply', async () => {
  const r = await newRelay();
  const cfg = 'a'.repeat(40_000);
  const res = await call(r, 'GET', '/_ping', undefined, { 'x-registry-config': cfg });
  assert.equal(res.status, 200);
  assert.equal(lastSeen().headers['x-registry-config'], cfg);
});

test('a client that aborts mid-stream does not leak the daemon-side connection', async () => {
  const r = await newRelay();
  await until(() => daemon.openConnections() === 0, 1000); // keep-alive upstream (R13): the relay closes the PREVIOUS call's daemon connection ~1 ms after the client got its response
  const before = daemon.openConnections();
  await new Promise<void>((resolve) => {
    const req = http.request({ socketPath: r.sockPath, path: '/events', agent: false }, (res) => {
      res.once('data', () => {
        assert.ok(daemon.openConnections() > before, 'the stream must be open daemon-side while the client reads it');
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => {});
    req.end();
  });
  assert.equal(await until(() => daemon.openConnections() <= before, 2000), true, 'the relay kept the daemon connection open after the client left');
});

test('a daemon that dies mid-response aborts the client call (no hang) and the relay keeps serving', async () => {
  const r = await newRelay();
  const outcome = await new Promise<string>((resolve) => {
    const req = http.request({ socketPath: r.sockPath, path: '/containers/x/abort', agent: false }, (res) => {
      res.on('data', () => {});
      res.on('aborted', () => resolve('aborted'));
      res.on('error', () => resolve('error'));
      res.on('end', () => resolve('clean-end'));
    });
    req.on('error', () => resolve('error'));
    req.end();
    setTimeout(() => resolve('HUNG'), 3000);
  });
  assert.notEqual(outcome, 'HUNG');
  assert.notEqual(outcome, 'clean-end', 'a truncated response must not look complete');
  assert.equal((await call(r, 'GET', '/_ping')).status, 200);
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

test('hijack half-close: the daemon answers only AFTER the client\'s EOF and the answer still reaches the client', { timeout: 8000 }, async () => {
  const r = await newRelay();
  const { sock, response } = await rawUpgrade(r, 'POST /exec/eof/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n');
  await new Promise((res) => setTimeout(res, 100));
  sock.write('input\n');
  sock.end(); // CloseWrite
  const text = await response;
  assert.match(text, /^HTTP\/1\.1 101 UPGRADED/);
  assert.ok(text.endsWith('DONE'), JSON.stringify(text));
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

test('daemon absent: a client that writes a big BODY FIRST (docker-py / python http.client style) gets the 502 and a CLOSED connection promptly — never a hang to its own timeout', { timeout: 10000 }, async () => {
  const r = await newRelay({ upstream: path.join(dir, 'still-not-there.sock') });
  const t0 = Date.now();
  const outcome = await new Promise<{ head: string; closedAfterMs: number | null }>((resolve) => {
    const sock = net.connect(r.sockPath);
    let head = '';
    sock.on('data', (d: Buffer) => {
      head += d.toString('latin1');
    });
    const done = (): void => resolve({ head, closedAfterMs: Date.now() - t0 });
    sock.on('close', done);
    sock.on('error', () => {}); // EPIPE / ECONNRESET while still writing is a FAST error, which is exactly the point
    sock.once('connect', () => {
      const body = Buffer.alloc(4 * 1024 * 1024, 0x61);
      sock.write(`POST /v1.47/images/load HTTP/1.1\r\nHost: docker\r\nContent-Length: ${body.length}\r\n\r\n`);
      sock.write(body);
    });
    setTimeout(() => {
      sock.destroy();
      resolve({ head, closedAfterMs: null });
    }, 4000);
  });
  assert.notEqual(outcome.closedAfterMs, null, 'the relay left the connection open after the 502 — a body-first client hangs');
  assert.ok((outcome.closedAfterMs as number) < 2500, `closed after ${outcome.closedAfterMs} ms`);
  assert.match(outcome.head, /^HTTP\/1\.1 502 /);
  assert.match(outcome.head, /connection: close/i);
  assert.equal((await call(await newRelay(), 'GET', '/_ping')).status, 200, 'the relay keeps serving other connections');
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

test('healthy() is false when the socket file was REPLACED by another file (same path, different inode)', async () => {
  const r = await newRelay();
  assert.equal(r.healthy(), true);
  fs.unlinkSync(r.sockPath);
  fs.writeFileSync(r.sockPath, '');
  assert.equal(r.healthy(), false);
});

test('kill() drops connections already in flight (a crashed relay does not leave streams half-alive)', async () => {
  const r = await newRelay();
  const closed = await new Promise<boolean>((resolve) => {
    const req = http.request({ socketPath: r.sockPath, path: '/events', agent: false }, (res) => {
      res.once('data', () => {
        r.kill();
        res.on('close', () => resolve(true));
        res.on('aborted', () => resolve(true));
        setTimeout(() => resolve(false), 1500);
      });
    });
    req.on('error', () => resolve(true));
    req.end();
  });
  assert.equal(closed, true);
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
