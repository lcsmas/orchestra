// #321 — the relay's HOLD seam against a scripted daemon: a container create/start the relay is about to forward waits for the gate and goes out only when it is admitted; what it adds to the answer when it
// waited; what is NEVER held (an unattributed / running / unknown container, any other call, a relay with no gate); a client that leaves is never forwarded; a failing gate never breaks a call.
// Each arm names the clause it protects (in-place mutants: scripts/docker-hold-mutants.list.mjs, run by scripts/docker-relay-mutants.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createDockerRelay, type DockerRelay } from './docker-relay.ts';
import { createHoldGate, type HeldKind, type HoldAdmitted, type HoldGate } from './docker-hold.ts';
import { startFakeDaemon, type FakeDaemon } from './fake-docker-daemon.ts';
import type { AdmissionState } from '../shared/docker-hold.ts';

let dir: string;
let daemon: FakeDaemon;
const relays: DockerRelay[] = [];
const logs: string[] = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hold-'));
  daemon = await startFakeDaemon(path.join(dir, 'd.sock'));
});
after(async () => {
  for (const r of relays) r.stop();
  await daemon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A gate the test drives by hand: every `admit` waits until `release(i)` (or its signal aborts). */
class ManualGate implements HoldGate {
  calls: Array<{ kind: HeldKind; signal: AbortSignal; release: (v: HoldAdmitted | null) => void }> = [];
  throwOnAdmit = false;
  holdingNow = true;
  admit(kind: HeldKind, signal: AbortSignal): Promise<HoldAdmitted | null> {
    if (this.throwOnAdmit) return Promise.reject(new Error('gate exploded'));
    return new Promise((resolve) => {
      this.calls.push({ kind, signal, release: resolve });
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }
  waiting = (): number => this.calls.length;
  holding = (): boolean => this.holdingNow;
  stop = (): void => {};
}

let n = 0;
async function newRelay(hold?: HoldGate, extra: { inspectTimeoutMs?: number } = {}): Promise<DockerRelay> {
  const r = createDockerRelay({ sockPath: path.join(dir, `r${n++}.sock`), upstream: daemon.sockPath, ws: 'ws-1', run: 'run-9', log: (m) => logs.push(m), ...(hold ? { hold } : {}), ...extra });
  relays.push(r);
  assert.equal(await r.start(), true);
  return r;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function start(r: DockerRelay, method: string, url: string, body?: string): { done: Promise<Res>; abort: () => void } {
  let abort = (): void => {};
  const done = new Promise<Res>((resolve, reject) => {
    const req = http.request({ socketPath: r.sockPath, method, path: url, headers: body ? { 'content-type': 'application/json' } : {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    abort = () => req.destroy();
    req.setTimeout(10_000, () => req.destroy(new Error('the relay did not answer within 10 s')));
    req.on('error', reject);
    req.end(body);
  });
  return { done, abort };
}
const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));
const posts = (re: RegExp): number => daemon.seen.filter((s) => s.method === 'POST' && re.test(s.url)).length;
const CREATE = JSON.stringify({ Image: 'alpine' });
const ATTRIBUTED = { 'orchestra.ws': 'ws-1', 'orchestra.run': 'run-9' };

test('a create WAITS for the gate: the daemon sees NOTHING until it is admitted; then the stamped create goes out and the answer says it waited (Warnings + X-Orchestra-Hold)', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const before = posts(/containers\/create/);
  const c = start(r, 'POST', '/v1.47/containers/create?name=held-a', CREATE);
  await settle();
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].kind, 'create');
  assert.equal(posts(/containers\/create/), before, 'held: nothing reached the daemon');
  gate.calls[0].release({ waitedMs: 4_000, reason: 'Admission hold: MemAvailable 5.50 GB < 6.00 GB (reopens above 7.00 GB; episode 2)' });
  const res = await c.done;
  assert.equal(res.status, 201);
  assert.equal(posts(/containers\/create/), before + 1);
  const sent = JSON.parse(daemon.seen[daemon.seen.length - 1].body.toString()) as { Labels: Record<string, string> };
  assert.deepEqual(sent.Labels, ATTRIBUTED, 'still stamped');
  const j = JSON.parse(res.body.toString()) as { Id: string; Warnings: string[] };
  assert.equal(j.Id, 'fake0123456789', 'the daemon\'s own Id is intact');
  assert.equal(j.Warnings.length, 1);
  assert.match(j.Warnings[0], /^orchestra: this container call waited 4 s under the Admission hold \(Admission hold: MemAvailable 5\.50 GB/);
  assert.match(String(res.headers['x-orchestra-hold']), /^waited=4s; Admission hold: MemAvailable 5\.50 GB/);
  assert.equal(res.headers['content-length'], String(res.body.length), 'the rebuilt body is re-framed');
});

test('a create that never waited (waitedMs 0) is answered UNTOUCHED: no Warnings added, no hold header', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const c = start(r, 'POST', '/containers/create?name=free-a', CREATE);
  await settle();
  gate.calls[0].release({ waitedMs: 0, reason: null });
  const res = await c.done;
  assert.deepEqual(JSON.parse(res.body.toString()), { Id: 'fake0123456789', Warnings: [] });
  assert.equal(res.headers['x-orchestra-hold'], undefined);
});

test('a START of a container THIS relay stamped (stopped) WAITS too; the daemon sees the start only once admitted, and the 204 carries X-Orchestra-Hold', async () => {
  daemon.setContainer('web-1', { labels: ATTRIBUTED, running: false });
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const before = posts(/\/start/);
  const s = start(r, 'POST', '/v1.47/containers/web-1/start');
  await settle();
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].kind, 'start');
  assert.equal(posts(/\/start/), before, 'held');
  assert.ok(daemon.seen.some((q) => q.method === 'GET' && q.url === '/v1.47/containers/web-1/json'), 'the relay inspected it (same API version prefix) to know whether it is ours');
  gate.calls[0].release({ waitedMs: 2_000, reason: 'why' });
  const res = await s.done;
  assert.equal(res.status, 204);
  assert.equal(posts(/\/start/), before + 1);
  assert.match(String(res.headers['x-orchestra-hold']), /^waited=2s; why$/);
});

test('NEVER held: a START of a container created AROUND the relay (no orchestra.ws), of another workspace\'s, of a running one, of an unknown one — and the gate is not even asked', async () => {
  daemon.setContainer('human-db', { labels: { 'com.docker.compose.project': 'stack' }, running: false });
  daemon.setContainer('other-ws', { labels: { 'orchestra.ws': 'ws-OTHER' }, running: false });
  daemon.setContainer('mine-running', { labels: ATTRIBUTED, running: true });
  const gate = new ManualGate();
  const r = await newRelay(gate);
  for (const id of ['human-db', 'other-ws', 'mine-running', 'no-such-container']) {
    const before = posts(new RegExp(`/containers/${id}/start`));
    const res = await start(r, 'POST', `/containers/${id}/start`).done;
    assert.equal(res.status, 204, id);
    assert.equal(posts(new RegExp(`/containers/${id}/start`)), before + 1, `${id} went straight through`);
    assert.equal(res.headers['x-orchestra-hold'], undefined);
  }
  assert.equal(gate.calls.length, 0, 'the gate was never consulted');
});

test('every OTHER call is forwarded without ever touching the gate (ps, exec, logs, stop, build, a GET on start)', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  for (const [m, u] of [['GET', '/containers/json'], ['POST', '/containers/web-1/stop'], ['POST', '/containers/web-1/exec'], ['GET', '/containers/web-1/start'], ['POST', '/build'], ['GET', '/containers/web-1/json']] as const) {
    await start(r, m, u, m === 'POST' ? '{}' : undefined).done;
  }
  assert.equal(gate.calls.length, 0);
});

test('a relay with NO gate never holds anything (a create goes straight out, unmodified answer)', async () => {
  const r = await newRelay();
  const res = await start(r, 'POST', '/containers/create?name=nogate', CREATE).done;
  assert.deepEqual(JSON.parse(res.body.toString()), { Id: 'fake0123456789', Warnings: [] });
  assert.equal(res.headers['x-orchestra-hold'], undefined);
});

test('a client that LEAVES while held: the gate sees it go and the daemon NEVER receives its create', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const before = posts(/containers\/create/);
  const c = start(r, 'POST', '/containers/create?name=leaver', CREATE);
  c.done.catch(() => {});
  await settle();
  assert.equal(gate.calls.length, 1);
  c.abort();
  await settle(150);
  assert.ok(gate.calls[0].signal.aborted, 'the abort reached the gate');
  assert.equal(posts(/containers\/create/), before);
});

test('a gate that THROWS never breaks the call: the create is forwarded (logged)', async () => {
  const gate = new ManualGate();
  gate.throwOnAdmit = true;
  const r = await newRelay(gate);
  const res = await start(r, 'POST', '/containers/create?name=boom', CREATE).done;
  assert.equal(res.status, 201);
  assert.ok(logs.some((l) => /hold gate threw: gate exploded — forwarding/.test(l)));
});

test('the REAL gate end to end: held ⇒ the create waits and a hold file appears; the guard reopens ⇒ it goes out by itself', async () => {
  const stateFile = path.join(dir, 'admission.state');
  const holdFile = path.join(dir, 'ws.docker.hold');
  const GIB = 1024 ** 3;
  const st = (held: boolean): AdmissionState => ({ v: 1, ts: Date.now(), held, enabled: true, heldSince: held ? Date.now() - 1000 : null, episode: 1, availBytes: 5 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB });
  fs.writeFileSync(stateFile, JSON.stringify(st(true)));
  const gate = createHoldGate({
    stateFile, holdFile, now: Date.now, readMem: () => 8 * GIB, readText: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
    writeFile: (f, t) => fs.writeFileSync(f, t), removeFile: (f) => fs.rmSync(f, { force: true }), sleep: (ms) => new Promise((x) => setTimeout(x, ms)), pollMs: 30, settleMs: 10, log: () => {},
  });
  const r = await newRelay(gate);
  const before = posts(/containers\/create/);
  const c = start(r, 'POST', '/containers/create?name=real-gate', CREATE);
  await settle(200);
  assert.equal(posts(/containers\/create/), before, 'held');
  assert.equal(JSON.parse(fs.readFileSync(holdFile, 'utf8')).create, 1, 'visible: one create waiting');
  fs.writeFileSync(stateFile, JSON.stringify(st(false)));
  const res = await c.done;
  assert.equal(res.status, 201);
  assert.equal(posts(/containers\/create/), before + 1);
  assert.match((JSON.parse(res.body.toString()) as { Warnings: string[] }).Warnings[0], /waited/);
  assert.equal(fs.existsSync(holdFile), false, 'the hold file is gone once nothing waits');
  gate.stop();
});

test('NOTHING held right now ⇒ a START is forwarded WITHOUT the inspect round trip and without the gate (it costs nothing while the fleet has memory)', async () => {
  daemon.setContainer('idle-web', { labels: ATTRIBUTED, running: false });
  const gate = new ManualGate();
  gate.holdingNow = false;
  const r = await newRelay(gate);
  const seenBefore = daemon.seen.length;
  const res = await start(r, 'POST', '/containers/idle-web/start').done;
  assert.equal(res.status, 204);
  assert.equal(gate.calls.length, 0);
  assert.deepEqual(daemon.seen.slice(seenBefore).map((q) => `${q.method} ${q.url}`), ['POST /containers/idle-web/start'], 'no GET …/json before it');
});

test('a SLOW inspect: within the timeout the stamped start is still held; past it the start fails open (forwarded, not held)', async () => {
  daemon.setContainer('slow-web', { labels: ATTRIBUTED, running: false });
  const gate = new ManualGate();
  const r = await newRelay(gate, { inspectTimeoutMs: 700 });
  daemon.setInspectDelay(150);
  const held = start(r, 'POST', '/containers/slow-web/start');
  held.done.catch(() => {});
  await settle(500);
  assert.equal(gate.calls.length, 1, 'inspect answered in time ⇒ held');
  gate.calls[0].release({ waitedMs: 1_000, reason: 'r' });
  assert.equal((await held.done).status, 204);
  daemon.setInspectDelay(2_500);
  const t0 = Date.now();
  const res = await start(r, 'POST', '/containers/slow-web/start').done;
  daemon.setInspectDelay(0);
  assert.equal(res.status, 204);
  assert.equal(gate.calls.length, 1, 'inspect timed out ⇒ unknown ⇒ not held');
  assert.ok(Date.now() - t0 < 2_400, 'it did not wait for the slow inspect');
});

test('a client that LEAVES while its LARGE create body is held is still noticed (the body is read before the wait): the daemon never sees the create', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const before = posts(/containers\/create/);
  const big = JSON.stringify({ Image: 'alpine', Labels: { big: 'x'.repeat(300_000) } });
  const c = start(r, 'POST', '/containers/create?name=big-leaver', big);
  c.done.catch(() => {});
  await settle(300);
  assert.equal(gate.calls.length, 1);
  c.abort();
  await settle(300);
  assert.ok(gate.calls[0].signal.aborted, 'the abort reached the gate although 300 KB of body had to be read first');
  gate.calls[0].release({ waitedMs: 1_000, reason: 'r' }); // even a late release must not send it
  await settle(200);
  assert.equal(posts(/containers\/create/), before);
});

test('keep-alive: after a held create is released, the SAME connection serves the next call', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const call = (method: string, p: string, body?: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const q = http.request({ socketPath: r.sockPath, method, path: p, agent, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (x: Buffer) => chunks.push(x));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      q.on('error', reject);
      q.end(body);
    });
  const first = call('POST', '/containers/create?name=ka-1', CREATE);
  await settle(100);
  gate.calls[0].release({ waitedMs: 2_000, reason: 'r' });
  assert.equal((await first).status, 201);
  const second = await call('GET', '/containers/json');
  assert.equal(second.status, 200);
  const third = call('POST', '/containers/create?name=ka-2', CREATE);
  await settle(100);
  gate.calls[1].release({ waitedMs: 0, reason: null });
  assert.equal((await third).status, 201);
  agent.destroy();
});

test('a held create the daemon REFUSES (409 after the wait), answers gzip, or answers non-JSON reaches the member BYTE FOR BYTE (only the hold header is added)', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ Id: 'zz', Warnings: [] })));
  const cases: Array<{ what: string; resp: { status: number; headers: Record<string, string>; body: string | Buffer }; want: Buffer }> = [
    { what: '409', resp: { status: 409, headers: { 'content-type': 'application/json' }, body: '{"message":"Conflict. The container name is already in use"}' }, want: Buffer.from('{"message":"Conflict. The container name is already in use"}') },
    { what: 'gzip', resp: { status: 201, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gz }, want: gz },
    { what: 'text/plain', resp: { status: 201, headers: { 'content-type': 'text/plain' }, body: '{"Id":"x","Warnings":[]}' }, want: Buffer.from('{"Id":"x","Warnings":[]}') },
  ];
  for (const c of cases) {
    daemon.nextCreate(c.resp);
    const p = start(r, 'POST', '/containers/create?name=odd', CREATE);
    await settle(80);
    gate.calls[gate.calls.length - 1].release({ waitedMs: 3_000, reason: 'r' });
    const res = await p.done;
    assert.equal(res.status, c.resp.status, c.what);
    assert.ok(res.body.equals(c.want), `${c.what}: body untouched`);
    assert.match(String(res.headers['x-orchestra-hold']), /^waited=3s/, c.what);
  }
});

test('a create released because the state stopped being authoritative says so in its Warning (not "memory was back")', async () => {
  const gate = new ManualGate();
  const r = await newRelay(gate);
  const p = start(r, 'POST', '/containers/create?name=flushed', CREATE);
  await settle(80);
  gate.calls[0].release({ waitedMs: 3_000, reason: 'Admission hold: …', flushed: true });
  const res = await p.done;
  assert.match((JSON.parse(res.body.toString()) as { Warnings: string[] }).Warnings[0], /released because the Admission state is no longer published/);
});
