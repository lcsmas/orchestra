// #695 — the relay against a scripted daemon: limits stamped on a create, the clamp, the member and host-wide budgets (a refused create is NEVER forwarded),
// the fail-open on an unreadable daemon, the OOM escalation, and the keeper wiring. One daemon per test: the host-wide budget counts every labelled container.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createDockerRelay, type DockerRelay } from './docker-relay.ts';
import { watchDockerOoms } from './docker-oom.ts';
import { startFakeDaemon, type FakeDaemon, type SeenRequest } from './fake-docker-daemon.ts';
import { GIB, type DockerLimits } from '../shared/docker-limits.ts';
import { dockerOomRecord, parseOomEventLine } from '../shared/docker-oom.ts';
import { memBusBody, memNoticeText, formatMemKillLine } from '../shared/memory-scope.ts';
import { memCapRowOf } from '../shared/mem-notice.ts';
import { parseMemNotice } from '../shared/mem-notice-file.ts';

const LIMITS: DockerLimits = { memoryCeilingBytes: 6 * GIB, memoryDefaultBytes: 1.5 * GIB, budgetBytes: 6 * GIB, pidsLimit: 1024, nanoCpus: 4e9, nanoCpusDefault: 1e9, memberCpuBudget: 4e9, cpuShares: 256, hostMemBudgetBytes: 18 * GIB, hostCpuBudget: 16e9 };
const SMALL = 1e8; // a scripted container's NanoCpus: small, so only the budget under test can trip

interface Env {
  dir: string;
  daemon: FakeDaemon;
  logs: string[];
  relay(ws: string, limits?: DockerLimits | null, lock?: boolean): Promise<DockerRelay>;
  call(r: DockerRelay, url: string, body: string): Promise<{ status: number; body: string }>;
  creates(ws: string): SeenRequest[];
  sentHostConfig(ws: string): Record<string, unknown>;
}

async function withEnv(fn: (e: Env) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaylim-'));
  const daemon = await startFakeDaemon(path.join(dir, 'd.sock'), { trackCreates: true });
  const logs: string[] = [];
  const relays: DockerRelay[] = [];
  let n = 0;
  const e: Env = {
    dir,
    daemon,
    logs,
    async relay(ws, limits = LIMITS, lock = false) {
      const r = createDockerRelay({ sockPath: path.join(dir, `r${n++}.sock`), upstream: daemon.sockPath, ws, run: 'run-9', log: (m) => logs.push(m), ...(limits ? { limits } : {}), ...(lock ? { budgetLockDir: path.join(dir, 'budget.lock') } : {}) });
      relays.push(r);
      assert.equal(await r.start(), true);
      return r;
    },
    call: (r, url, body) =>
      new Promise((resolve, reject) => {
        const req = http.request({ socketPath: r.sockPath, method: 'POST', path: url, headers: { 'content-type': 'application/json' }, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body);
      }),
    creates: (ws) => daemon.seen.filter((s) => s.method === 'POST' && /containers\/create/.test(s.url) && s.body.toString().includes(`"${ws}"`)),
    sentHostConfig: (ws) => (JSON.parse(e.creates(ws).at(-1)!.body.toString()) as { HostConfig: Record<string, unknown> }).HostConfig,
  };
  try {
    await fn(e);
  } finally {
    for (const r of relays) r.stop();
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const mine = (ws: string, extra: Record<string, unknown> = {}) => ({ labels: { 'orchestra.ws': ws }, nanoCpus: SMALL, ...extra });
const MEM = (gib: number): string => `{"HostConfig":{"Memory":${gib * GIB}}}`;

test('a create with no HostConfig reaches the daemon with Memory / MemorySwap / PidsLimit / NanoCpus / CpuShares', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-a');
    const res = await e.call(r, '/containers/create?name=pl-node', '{"Image":"node:10"}');
    assert.equal(res.status, 201);
    assert.deepEqual(e.sentHostConfig('ws-a'), { Memory: 1.5 * GIB, MemorySwap: 1.5 * GIB, PidsLimit: 1024, NanoCpus: 1e9, CpuShares: 256 });
  }));

test('a versioned URL is rewritten too, and the relay\'s own budget read keeps the version prefix', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-v');
    const res = await e.call(r, '/v1.43/containers/create', '{"Image":"alpine","HostConfig":{"Binds":["/a:/b"]}}');
    assert.equal(res.status, 201);
    const hc = e.sentHostConfig('ws-v');
    assert.equal(hc.Memory, 1.5 * GIB);
    assert.deepEqual(hc.Binds, ['/a:/b']);
    assert.ok(e.daemon.seen.find((s) => /containers\/json/.test(s.url))!.url.startsWith('/v1.43/containers/json?'));
  }));

test('a client Memory above the ceiling is clamped before the daemon sees it, with one log line', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-c');
    await e.call(r, '/containers/create', '{"HostConfig":{"Memory":34359738368,"PidsLimit":100000}}');
    const hc = e.sentHostConfig('ws-c');
    assert.equal(hc.Memory, 6 * GIB);
    assert.equal(hc.PidsLimit, 1024);
    const lines = e.logs.filter((l) => /create limits/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Memory 34359738368 → 6442450944 \(clamped/);
  }));

test('a compose-style create (explicit zeros / nulls) is limited in place', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-m');
    await e.call(r, '/v1.47/containers/create?name=p-web-1', '{"Image":"x","HostConfig":{"Memory":0,"MemorySwap":0,"NanoCpus":0,"PidsLimit":null,"NetworkMode":"p_default"}}');
    assert.deepEqual(e.sentHostConfig('ws-m'), { Memory: 1.5 * GIB, MemorySwap: 1.5 * GIB, NanoCpus: 1e9, PidsLimit: 1024, NetworkMode: 'p_default', CpuShares: 256 });
  }));

test('member budget: a create that would pass it is REFUSED (403, Docker-shaped) and never forwarded', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-b');
    e.daemon.setContainer('b1', mine('ws-b', { running: true, memory: 4 * GIB, name: 'pl-mongo' }));
    const res = await e.call(r, '/containers/create?name=pl-node', '{"Image":"node:10","Cmd":["x-refused-marker"],"HostConfig":{"Memory":3221225472}}');
    assert.equal(res.status, 403);
    const msg = (JSON.parse(res.body) as { message: string }).message;
    assert.match(msg, /memory budget exceeded/);
    assert.match(msg, /6\.00 GiB/);
    assert.match(msg, /4\.00 GiB is already reserved/);
    assert.match(msg, /pl-mongo/);
    assert.match(msg, /docker rm -f/);
    assert.equal(e.daemon.seen.some((s) => s.body.toString().includes('x-refused-marker')), false, 'the daemon never saw the refused create');
    assert.equal(e.logs.filter((l) => /create REFUSED/.test(l)).length, 1);
  }));

test('member budget: a create that fits goes through, up to exactly the budget', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-f');
    e.daemon.setContainer('f1', mine('ws-f', { running: true, memory: 4 * GIB }));
    assert.equal((await e.call(r, '/containers/create', MEM(1))).status, 201);
    assert.equal((await e.call(r, '/containers/create', MEM(1))).status, 201); // 4 + 1 + 1 = 6
    assert.equal((await e.call(r, '/containers/create', MEM(1))).status, 403);
  }));

test('member budget: only THIS workspace\'s containers count; a stopped one does not; a created-not-started one does', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-o');
    e.daemon.setContainer('o1', mine('ws-ELSE', { running: true, memory: 6 * GIB }));
    e.daemon.setContainer('o2', mine('ws-o', { running: false, memory: 6 * GIB })); // exited
    assert.equal((await e.call(r, '/containers/create', MEM(6))).status, 201, 'other ws + exited do not count against the member');
    assert.equal((await e.call(r, '/containers/create', MEM(1))).status, 403, 'a created container counts');
  }));

test('member budget: a container created without a limit counts as the ceiling', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-u');
    e.daemon.setContainer('u1', { labels: { 'orchestra.ws': 'ws-u' }, running: true, memory: 0, nanoCpus: SMALL, name: 'old-unlimited' });
    const res = await e.call(r, '/containers/create', MEM(0.001));
    assert.equal(res.status, 403);
    assert.match(res.body, /old-unlimited/);
  }));

test('member budget: parallel creates are counted one after the other (the second sees the first)', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-p');
    const [a, b] = await Promise.all([e.call(r, '/containers/create', MEM(4)), e.call(r, '/containers/create', MEM(4))]);
    assert.deepEqual([a.status, b.status].sort(), [201, 403]);
  }));

test('member CPU: the sum of NanoCpus of the member\'s containers may not pass its CPU budget', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-cpu');
    e.daemon.setContainer('c1', mine('ws-cpu', { running: true, memory: GIB, nanoCpus: 3e9 }));
    assert.equal((await e.call(r, '/containers/create', '{"HostConfig":{"Memory":1073741824,"NanoCpus":1000000000}}')).status, 201); // 3 + 1 = 4 CPU
    const res = await e.call(r, '/containers/create', '{"HostConfig":{"Memory":1073741824,"NanoCpus":1000000000}}');
    assert.equal(res.status, 403);
    assert.match(res.body, /cpu budget exceeded/);
    assert.match(res.body, /4 CPU is already reserved/);
  }));

test('host-wide: two members each under their own budget but together over the host budget → the second create is refused, naming the top users', () =>
  withEnv(async (e) => {
    const host: DockerLimits = { ...LIMITS, hostMemBudgetBytes: 8 * GIB };
    const a = await e.relay('ws-A', host);
    const b = await e.relay('ws-B', host);
    assert.equal((await e.call(a, '/containers/create?name=a-db', MEM(5))).status, 201); // A: 5 ≤ its 6 GiB budget
    const res = await e.call(b, '/containers/create?name=b-app', MEM(4)); // B: 4 ≤ its own 6 GiB, but 5 + 4 > 8
    assert.equal(res.status, 403);
    const msg = (JSON.parse(res.body) as { message: string }).message;
    assert.match(msg, /ALL workspaces together \(the host-wide budget\) may hold 8\.00 GiB/);
    assert.match(msg, /5\.00 GiB is already reserved/);
    assert.match(msg, /tracked-0 of ws-A/);
    assert.equal(e.creates('ws-B').length, 0, 'B\'s create never reached the daemon');
  }));

test('host-wide CPU: members together may not pass the host CPU budget', () =>
  withEnv(async (e) => {
    const host: DockerLimits = { ...LIMITS, hostCpuBudget: 4e9 };
    const b = await e.relay('ws-B', host);
    e.daemon.setContainer('x', { labels: { 'orchestra.ws': 'ws-A' }, running: true, memory: GIB, nanoCpus: 3e9, name: 'a-x' });
    const res = await e.call(b, '/containers/create', '{"HostConfig":{"Memory":1073741824,"NanoCpus":2000000000}}');
    assert.equal(res.status, 403);
    assert.match(res.body, /host-wide budget/);
    assert.match(res.body, /a-x of ws-A/);
  }));

test('host-wide: two keepers\' parallel creates take turns through the shared lock directory (both see each other)', () =>
  withEnv(async (e) => {
    const host: DockerLimits = { ...LIMITS, hostMemBudgetBytes: 8 * GIB };
    const a = await e.relay('ws-A', host, true);
    const b = await e.relay('ws-B', host, true);
    const [x, y] = await Promise.all([e.call(a, '/containers/create', MEM(5)), e.call(b, '/containers/create', MEM(5))]);
    assert.deepEqual([x.status, y.status].sort(), [201, 403]);
    assert.equal(fs.existsSync(path.join(e.dir, 'budget.lock')), false, 'the lock is released');
  }));

test('a daemon that cannot list fails OPEN (logged), the limits still apply', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-x');
    e.daemon.failNextList();
    const res = await e.call(r, '/containers/create', '{"Image":"x"}');
    assert.equal(res.status, 201);
    assert.equal(e.sentHostConfig('ws-x').Memory, 1.5 * GIB);
    assert.ok(e.logs.some((l) => /budget not checked/.test(l)));
  }));

test('no limits option: the relay is the #291 labels-only stamp (HostConfig untouched, no budget read)', () =>
  withEnv(async (e) => {
    const r = await e.relay('ws-n', null);
    await e.call(r, '/containers/create', '{"Image":"x","HostConfig":{"Memory":0}}');
    assert.deepEqual((JSON.parse(e.creates('ws-n').at(-1)!.body.toString()) as { HostConfig: unknown }).HostConfig, { Memory: 0 });
    assert.equal(e.daemon.seen.some((s) => /containers\/json/.test(s.url)), false);
  }));

// ── the OOM escalation ──────────────────────────────────────────────────────────────────────────────────────────

const oomLine = (id: string, name: string, ws: string, timeNano: number): string => JSON.stringify({ Type: 'container', Action: 'oom', Actor: { ID: id, Attributes: { name, 'orchestra.ws': ws } }, time: Math.floor(timeNano / 1e9), timeNano });

test('parseOomEventLine: only a container oom event; a torn or other line is null', () => {
  assert.deepEqual(parseOomEventLine(oomLine('abc123', 'pl-node', 'ws-1', 1_700_000_000_123_000_000)), { id: 'abc123', name: 'pl-node', at: 1_700_000_000_123 });
  assert.equal(parseOomEventLine(JSON.stringify({ Type: 'container', Action: 'die', Actor: { ID: 'x' } })), null);
  assert.equal(parseOomEventLine(JSON.stringify({ Type: 'network', Action: 'oom', Actor: { ID: 'x' } })), null);
  assert.equal(parseOomEventLine('{"Type":"cont'), null);
});

test('an oom event of a labelled container reaches onOom with the container\'s limit; the stream asks for THIS workspace only', () =>
  withEnv(async (e) => {
    e.daemon.setContainer('ctr1', mine('ws-oom', { running: true, memory: 2 * GIB, name: 'pl-node' }));
    const got: Array<{ name: string; limit: number | null }> = [];
    const w = watchDockerOoms({ upstream: e.daemon.sockPath, ws: 'ws-oom', log: (m) => e.logs.push(m), onOom: (ev, limit) => got.push({ name: ev.name, limit }) });
    try {
      for (let i = 0; i < 100 && !e.daemon.seen.some((s) => /\/events\?/.test(s.url)); i++) await new Promise((r) => setTimeout(r, 20));
      const url = decodeURIComponent(e.daemon.seen.find((s) => /\/events\?/.test(s.url))!.url);
      assert.match(url, /"event":\["oom"\]/);
      assert.match(url, /"label":\["orchestra\.ws=ws-oom"\]/);
      e.daemon.emitEvent(oomLine('ctr1', 'pl-node', 'ws-oom', Date.now() * 1e6));
      for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(got, [{ name: 'pl-node', limit: 2 * GIB }]);
    } finally {
      w.stop();
    }
  }));

test('the oom watch re-opens a dropped stream and delivers an event seen twice once', () =>
  withEnv(async (e) => {
    const got: string[] = [];
    const w = watchDockerOoms({ upstream: e.daemon.sockPath, ws: 'ws-r', log: () => {}, retryMs: 20, onOom: (ev) => got.push(ev.name) });
    try {
      const streams = (): number => e.daemon.seen.filter((s) => /\/events\?/.test(s.url)).length;
      for (let i = 0; i < 100 && streams() < 1; i++) await new Promise((r) => setTimeout(r, 20));
      e.daemon.dropEventStreams();
      for (let i = 0; i < 150 && streams() < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(streams() >= 2, 'the watch re-opened the stream');
      assert.match(e.daemon.seen.filter((s) => /\/events\?/.test(s.url)).at(-1)!.url, /&since=\d+$/, 'and asks for what it missed');
      const line = oomLine('gone', 'once', 'ws-r', Date.now() * 1e6);
      e.daemon.emitEvent(line);
      e.daemon.emitEvent(line);
      for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(got, ['once']);
    } finally {
      w.stop();
    }
  }));

test('the container-kill record reads as a Plafond-style escalation (row, coordinator message, log line, notice file round trip)', () => {
  const rec = dockerOomRecord('ws-1', 1_700_000_000_123, { id: 'abc', name: 'pl-node', at: 1_700_000_000_123 }, 2 * GIB);
  assert.match(memNoticeText(rec), /container pl-node KILLED at its Docker limit 2 GB/);
  assert.match(memBusBody('agent (ws-1)', rec), /Plafond mémoire — workspace agent \(ws-1\): container pl-node KILLED at its Docker limit 2 GB/);
  assert.match(formatMemKillLine('ws-1', rec), /container pl-node KILLED at its Docker limit 2 GB/);
  const row = memCapRowOf(rec);
  assert.equal(row.tone, 'hard');
  assert.ok(JSON.stringify(row.segments).includes('pl-node'));
  assert.deepEqual(parseMemNotice(JSON.parse(JSON.stringify(rec))), rec, 'the keeper\'s notice file keeps the container');
});

test('the keeper wires the limits, the lock, the member cap and the oom watch (static wiring)', () => {
  const w = fs.readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8');
  assert.match(w, /dockerLimitsFor\(\{ capHardBytes, hostTotalBytes: os\.totalmem\(\)/, 'limits derive from the member cap + the host');
  assert.match(w, /createDockerRelay\(\{[^}]*\.\.\.\(gate \? \{ hold: gate \} : \{\}\), limits, budgetLockDir: [^}]*\}\)/, 'the relay gets the limits and the cross-keeper lock');
  assert.match(w, /withDockerRelay\(f\.dockerRelay\.runId, capEnv, f\.dockerRelay\.holdState, f\.memoryCap\?\.hardBytes, f\.dockerRelay\.limits\)/, 'the frame\'s memoryCap.hardBytes + the settings reach it');
  assert.match(w, /watchDockerOoms\(\{[\s\S]*send\(\{ t: 'memKill', rec \}\)/, 'an oom event is sent to the host as a kill record');
});
