// The BUILT keeper daemon (dist-electron/keeper.js) hosting the Docker relay (#291) — real keeper process, a fake
// CLI that makes docker API calls through the DOCKER_HOST the keeper gave it, and a scripted daemon behind the relay.
// Every case asserts what the CLI's environment and the daemon observed, never the keeper's internals.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createLineSplitter,
  encodeKeeperFrame,
  parseKeeperFrame,
  type KeeperClientFrame,
  type KeeperDaemonFrame,
} from '../shared/keeper-protocol.ts';
import { startFakeDaemon, type FakeDaemon } from './fake-docker-daemon.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');

/** CLI: `{"env":1}` → its env; `{"create":1}` → POST /containers/create through $DOCKER_HOST; `{"echo":n}` → echo. */
const FAKE_CLI = `
const http = require('http');
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(Object.assign({ type: 'assistant' }, o)) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) out({ echo: m.echo });
    if (m.env) out({ env: Object.fromEntries(Object.entries(process.env).sort()) });
    if (m.create) {
      const host = process.env.DOCKER_HOST || '';
      const req = http.request({ socketPath: host.replace(/^unix:\\/\\//, ''), method: 'POST', path: '/v1.47/containers/create', agent: false,
        headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => out({ created: res.statusCode, n: m.create })); });
      req.on('error', (e) => out({ created: 0, err: String(e.message), n: m.create }));
      req.end(JSON.stringify({ Image: 'alpine' }));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`;

before(() => {
  const srcs = ['src/keeper/index.ts', 'src/keeper/docker-relay.ts', 'src/shared/keeper-protocol.ts', 'src/shared/docker-relay.ts'].map((s) => path.join(REPO, s));
  if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  }
});

interface Ctx {
  dir: string;
  wsId: string;
  sock: string;
  relaySock: string;
  pidFile: string;
  logFile: string;
  fakeCli: string;
  daemon: FakeDaemon;
}
const ctxs: Ctx[] = [];
const clients: Client[] = [];

async function makeCtx(env?: Record<string, string>): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdr-'));
  const ctx: Ctx = {
    dir,
    wsId: 'ws-' + path.basename(dir),
    sock: path.join(dir, 'k.sock'),
    relaySock: path.join(dir, 'k.docker.sock'),
    pidFile: path.join(dir, 'k.pid'),
    logFile: path.join(dir, 'k.log'),
    fakeCli: path.join(dir, 'cli.cjs'),
    daemon: await startFakeDaemon(path.join(dir, 'd.sock')),
  };
  fs.writeFileSync(ctx.fakeCli, FAKE_CLI);
  // KEEPER_NODE=<electron binary> re-runs this suite with the keeper on Electron-as-node, as a packaged build launches it
  const keeperNode = process.env.KEEPER_NODE ?? process.execPath;
  spawn(keeperNode, [KEEPER_JS, ctx.wsId, ctx.sock, ctx.pidFile, ctx.logFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ORCHESTRA_KEEPER_RELAY_CHECK_MS: '100', ...(process.env.KEEPER_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...env },
  }).unref();
  ctxs.push(ctx);
  return ctx;
}

class Client {
  frames: KeeperDaemonFrame[] = [];
  closed = false;
  private sock: net.Socket;
  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on(
      'data',
      createLineSplitter((line) => {
        const f = parseKeeperFrame(line);
        if (f) this.frames.push(f as KeeperDaemonFrame);
      }),
    );
    sock.on('close', () => (this.closed = true));
    sock.on('error', () => {});
  }
  static async dial(p: string): Promise<Client> {
    for (let i = 0; i < 60; i++) {
      try {
        const c = await new Promise<Client>((resolve, reject) => {
          const s = net.connect(p);
          s.once('connect', () => resolve(new Client(s)));
          s.once('error', reject);
        });
        clients.push(c);
        return c;
      } catch {
        await sleep(100);
      }
    }
    throw new Error('keeper never came up');
  }
  send(f: KeeperClientFrame): void {
    this.sock.write(encodeKeeperFrame(f));
  }
  /** The assistant lines the CLI printed, parsed. */
  lines(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const f of this.frames) {
      if (f.t !== 'stdout') continue;
      for (const l of Buffer.from(f.b64, 'base64').toString('utf8').split('\n')) {
        if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
      }
    }
    return out;
  }
  async waitLine(pred: (l: Record<string, unknown>) => boolean, ms = 8000): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.lines().find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timeout; saw ${JSON.stringify(this.lines())}`);
      await sleep(30);
    }
  }
  destroy(): void {
    this.sock.destroy();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const line = (obj: unknown): KeeperClientFrame => ({ t: 'stdin', b64: Buffer.from(JSON.stringify(obj) + '\n').toString('base64') });
const pidOf = (ctx: Ctx): number => (JSON.parse(fs.readFileSync(ctx.pidFile, 'utf8')) as { pid: number }).pid;

async function start(ctx: Ctx, env: Record<string, string | undefined>, relay: boolean): Promise<Client> {
  const c = await Client.dial(ctx.sock);
  c.send({ t: 'hello', wsId: ctx.wsId });
  c.send({
    t: 'spawn',
    command: process.execPath,
    args: [ctx.fakeCli],
    cwd: ctx.dir,
    env,
    ...(relay ? { dockerRelay: { runId: 'run-7' } } : {}),
  });
  return c;
}

after(async () => {
  for (const c of clients) c.destroy();
  for (const ctx of ctxs) {
    try {
      process.kill(pidOf(ctx), 'SIGKILL');
    } catch {
      /* gone */
    }
    await ctx.daemon.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const lastBody = (ctx: Ctx) => JSON.parse(ctx.daemon.seen[ctx.daemon.seen.length - 1].body.toString()) as { Labels?: Record<string, string> };

test('relay ON: the CLI gets DOCKER_HOST at the relay and a create through it reaches the daemon stamped', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath }, true);
  c.send(line({ env: 1 }));
  const env = (await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>;
  assert.equal(env.DOCKER_HOST, `unix://${ctx.relaySock}`);
  c.send(line({ create: 1 }));
  await c.waitLine((l) => l.created === 201);
  assert.deepEqual(lastBody(ctx).Labels, { 'orchestra.ws': ctx.wsId, 'orchestra.run': 'run-7' });
});

test('control: a create that goes AROUND the relay (straight to the daemon) is unlabelled', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath }, true);
  c.send(line({ env: 1 }));
  await c.waitLine((l) => l.env !== undefined);
  await new Promise<void>((resolve, reject) => {
    const req = net.connect(ctx.daemon.sockPath, () => {
      const body = '{"Image":"alpine"}';
      req.write(`POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
    req.on('data', () => {});
    req.on('close', resolve);
    req.on('error', reject);
  });
  assert.equal(lastBody(ctx).Labels, undefined);
});

test('stdin frames sent right behind a relay spawn are neither dropped nor reordered', async () => {
  const ctx = await makeCtx();
  const c = await Client.dial(ctx.sock);
  c.send({ t: 'hello', wsId: ctx.wsId });
  c.send({ t: 'spawn', command: process.execPath, args: [ctx.fakeCli], cwd: ctx.dir, env: { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath }, dockerRelay: { runId: 'run-7' } });
  for (let n = 1; n <= 5; n++) c.send(line({ echo: n }));
  await c.waitLine((l) => l.echo === 5);
  assert.deepEqual(c.lines().filter((l) => l.echo !== undefined).map((l) => l.echo), [1, 2, 3, 4, 5]);
});

test('switch OFF (no dockerRelay in the frame): the CLI env is EXACTLY the frame env — byte-identical to today', async () => {
  const ctx = await makeCtx();
  const sent = { PATH: process.env.PATH as string, FOO: 'bar', ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath };
  const c = await start(ctx, sent, false);
  c.send(line({ env: 1 }));
  const env = (await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>;
  assert.deepEqual(env, Object.fromEntries(Object.entries(sent).sort()));
  assert.equal(env.DOCKER_HOST, undefined);
  assert.equal(fs.existsSync(ctx.relaySock), false, 'no relay socket may exist while the switch is off');
  assert.ok(!fs.readFileSync(ctx.logFile, 'utf8').includes('docker relay'));
});

test('switch OFF keeps an inherited DOCKER_HOST untouched', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, DOCKER_HOST: 'tcp://10.1.2.3:2375' }, false);
  c.send(line({ env: 1 }));
  assert.equal(((await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>).DOCKER_HOST, 'tcp://10.1.2.3:2375');
});

test('relay cannot start (real docker socket missing): DOCKER_HOST stays UNSET and the CLI still runs', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: path.join(ctx.dir, 'nonexistent.sock') }, true);
  c.send(line({ env: 1 }));
  const env = (await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>;
  assert.equal(env.DOCKER_HOST, undefined);
  assert.match(fs.readFileSync(ctx.logFile, 'utf8'), /docker relay disabled: upstream .* is not a socket/);
});

test('relay cannot start (its socket path is blocked): DOCKER_HOST stays UNSET', async () => {
  const ctx = await makeCtx();
  fs.mkdirSync(path.join(ctx.relaySock, 'blocker'), { recursive: true });
  const c = await start(ctx, { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath }, true);
  c.send(line({ env: 1 }));
  const env = (await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>;
  assert.equal(env.DOCKER_HOST, undefined);
  assert.match(fs.readFileSync(ctx.logFile, 'utf8'), /docker relay disabled/);
});

test('a member whose DOCKER_HOST is not a unix socket is never redirected to the local daemon', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, DOCKER_HOST: 'tcp://10.1.2.3:2375' }, true);
  c.send(line({ env: 1 }));
  assert.equal(((await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>).DOCKER_HOST, 'tcp://10.1.2.3:2375');
  assert.match(fs.readFileSync(ctx.logFile, 'utf8'), /is not a unix socket/);
});

test('relay killed mid-session (SIGUSR2): the keeper restarts it and the next create is labelled', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath }, true);
  c.send(line({ create: 1 }));
  await c.waitLine((l) => l.created === 201 && l.n === 1);
  const before = fs.statSync(ctx.relaySock).ino;
  process.kill(pidOf(ctx), 'SIGUSR2');
  for (let i = 0; i < 100 && fs.existsSync(ctx.relaySock) && fs.statSync(ctx.relaySock).ino === before; i++) await sleep(10);
  c.send(line({ create: 2 }));
  // calls racing the restart may fail once (connection refused); the keeper must have it back within ~1 s
  for (let k = 3; k < 40 && !c.lines().some((l) => l.created === 201 && Number(l.n) >= 2); k++) {
    await sleep(100);
    c.send(line({ create: k }));
  }
  assert.ok(c.lines().some((l) => l.created === 201 && Number(l.n) >= 2), `no create succeeded after the kill: ${JSON.stringify(c.lines())}`);
  assert.notEqual(fs.statSync(ctx.relaySock).ino, before, 'the socket must be a NEW listener');
  assert.deepEqual(lastBody(ctx).Labels, { 'orchestra.ws': ctx.wsId, 'orchestra.run': 'run-7' });
  assert.match(fs.readFileSync(ctx.logFile, 'utf8'), /docker relay: restarted/);
});

test('a SLOW `docker context inspect` does not stop the keeper answering probes, and the relay still comes up from its answer', async () => {
  const ctx = await makeCtx();
  const bin = path.join(ctx.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nsleep 2\necho unix://${ctx.daemon.sockPath}\n`, { mode: 0o755 });
  const c = await Client.dial(ctx.sock);
  c.send({ t: 'hello', wsId: ctx.wsId });
  c.send({ t: 'spawn', command: process.execPath, args: [ctx.fakeCli], cwd: ctx.dir, env: { PATH: `${bin}:${process.env.PATH}` }, dockerRelay: { runId: 'run-7' } });
  await sleep(300); // the relay lookup is now mid-flight
  const probe = await Client.dial(ctx.sock);
  const t0 = Date.now();
  probe.send({ t: 'probe', wsId: ctx.wsId });
  while (!probe.frames.some((f) => f.t === 'helloAck') && Date.now() - t0 < 5000) await sleep(10);
  const answeredMs = Date.now() - t0;
  assert.ok(answeredMs < 800, `probe answered after ${answeredMs} ms — the keeper's event loop was blocked by the context lookup`);
  c.send(line({ env: 1 }));
  const env = (await c.waitLine((l) => l.env !== undefined)).env as Record<string, string>;
  assert.equal(env.DOCKER_HOST, `unix://${ctx.relaySock}`);
  c.send(line({ create: 1 }));
  await c.waitLine((l) => l.created === 201);
  assert.equal(lastBody(ctx).Labels?.['orchestra.ws'], ctx.wsId); // forwarded to the daemon the SHIM named
});

test('the relay socket is removed when the keeper exits', async () => {
  const ctx = await makeCtx();
  const c = await start(ctx, { PATH: process.env.PATH, ORCHESTRA_DOCKER_SOCKET: ctx.daemon.sockPath }, true);
  c.send(line({ echo: 1 }));
  await c.waitLine((l) => l.echo === 1);
  assert.equal(fs.existsSync(ctx.relaySock), true);
  const pid = pidOf(ctx);
  c.send({ t: 'kill', signal: 'SIGTERM' });
  for (let i = 0; i < 100 && !c.frames.some((f) => f.t === 'exit'); i++) await sleep(30);
  c.destroy(); // the keeper only cleans up once its client drops (the app's facade does exactly this on `exit`)
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await sleep(50);
  }
  assert.equal(fs.existsSync(ctx.relaySock), false);
});
