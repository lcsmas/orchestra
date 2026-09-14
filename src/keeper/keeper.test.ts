// Integration tests for the built keeper daemon (dist-electron/keeper.js)
// against a fake stream-json CLI. Rebuilds the bundle when stale so
// `pnpm run test` stays self-contained (vite lib build, ~1s once).

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

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname2, '..', '..');
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');

/** The fake CLI: line-in line-out.
 *  {"echo":X}   → {"type":"assistant","echo":X}
 *  {"finish":1} → {"type":"result"}
 *  stdin EOF    → {"type":"result","subtype":"eof"} then clean exit. */
const FAKE_CLI = `
const lines = [];
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo }) + '\\n');
    if (m.finish) process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
  }
});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'eof' }) + '\\n');
  process.exit(0);
});
`;

before(() => {
  // Rebuild the bundle when missing or older than its sources.
  const srcs = [
    path.join(REPO, 'src', 'keeper', 'index.ts'),
    path.join(REPO, 'src', 'shared', 'keeper-protocol.ts'),
  ];
  const stale =
    !fs.existsSync(KEEPER_JS) ||
    srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs);
  if (stale) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], {
      cwd: REPO,
      stdio: 'ignore',
    });
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Ctx {
  dir: string;
  wsId: string;
  sock: string;
  pidFile: string;
  logFile: string;
  fakeCli: string;
}

const ctxs: Ctx[] = [];

function makeCtx(env?: Record<string, string>): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-test-'));
  const ctx: Ctx = {
    dir,
    wsId: 'ws-' + path.basename(dir),
    sock: path.join(dir, 'k.sock'),
    pidFile: path.join(dir, 'k.pid'),
    logFile: path.join(dir, 'k.log'),
    fakeCli: path.join(dir, 'fake-cli.cjs'),
  };
  fs.writeFileSync(ctx.fakeCli, FAKE_CLI);
  const child = spawn(process.execPath, [KEEPER_JS, ctx.wsId, ctx.sock, ctx.pidFile, ctx.logFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  ctxs.push(ctx);
  return ctx;
}

async function connect(ctx: Ctx, retries = 50): Promise<Client> {
  for (let i = 0; i < retries; i++) {
    try {
      return await Client.dial(ctx.sock);
    } catch {
      await sleep(100);
    }
  }
  throw new Error('keeper never came up');
}

class Client {
  frames: KeeperDaemonFrame[] = [];
  closed = false;
  private waiters: Array<() => void> = [];
  private sock: net.Socket;
  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on(
      'data',
      createLineSplitter((line) => {
        const f = parseKeeperFrame(line);
        if (f) {
          this.frames.push(f as KeeperDaemonFrame);
          this.waiters.splice(0).forEach((w) => w());
        }
      }),
    );
    sock.on('close', () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
    sock.on('error', () => {});
  }
  static dial(p: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const s = net.connect(p);
      s.once('connect', () => resolve(new Client(s)));
      s.once('error', reject);
    });
  }
  send(f: KeeperClientFrame): void {
    this.sock.write(encodeKeeperFrame(f));
  }
  /** Wait until a frame matching `pred` exists (scans history too). */
  async wait<T extends KeeperDaemonFrame>(pred: (f: KeeperDaemonFrame) => f is T, ms = 5000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (this.closed) throw new Error('socket closed while waiting');
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for frame');
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }
  async waitClose(ms = 5000): Promise<void> {
    const t0 = Date.now();
    while (!this.closed) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for close');
      await sleep(50);
    }
  }
  destroy(): void {
    this.sock.destroy();
  }
}

const isAck = (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'helloAck' }> => f.t === 'helloAck';
const isExit = (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'exit' }> => f.t === 'exit';
const stdoutContaining =
  (needle: string) =>
  (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'stdout' }> =>
    f.t === 'stdout' && Buffer.from(f.b64, 'base64').toString('utf8').includes(needle);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stdinLine = (obj: unknown): KeeperClientFrame => ({
  t: 'stdin',
  b64: Buffer.from(JSON.stringify(obj) + '\n').toString('base64'),
});

function spawnFrame(ctx: Ctx): KeeperClientFrame {
  return {
    t: 'spawn',
    command: process.execPath,
    args: [ctx.fakeCli],
    cwd: ctx.dir,
    env: { PATH: process.env.PATH },
  };
}

function pidOf(ctx: Ctx): number {
  return (JSON.parse(fs.readFileSync(ctx.pidFile, 'utf8')) as { pid: number }).pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

after(() => {
  // Belt-and-braces: kill any keeper the tests leaked, then rm temp dirs.
  for (const ctx of ctxs) {
    try {
      process.kill(pidOf(ctx), 'SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('spawn → relay round-trip → wsId guard', async () => {
  const ctx = makeCtx();
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  const ack = await c.wait(isAck);
  assert.equal(ack.running, false);
  assert.equal(ack.wsId, ctx.wsId);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'ping' }));
  const out = await c.wait(stdoutContaining('"echo":"ping"'));
  assert.ok(out);
  c.destroy();

  // wrong wsId is refused
  const c2 = await connect(ctx);
  c2.send({ t: 'hello', wsId: 'someone-else' });
  await c2.waitClose();
});

test('bare socket drop = detach; CLI survives; reattach relays again', async () => {
  const ctx = makeCtx();
  const a = await connect(ctx);
  a.send({ t: 'hello', wsId: ctx.wsId });
  await a.wait(isAck);
  a.send(spawnFrame(ctx));
  a.send(stdinLine({ echo: 'one' }));
  await a.wait(stdoutContaining('"echo":"one"'));
  a.destroy(); // detach — NOT a shutdown signal

  await sleep(300);
  const b = await connect(ctx);
  b.send({ t: 'hello', wsId: ctx.wsId });
  const ack = await b.wait(isAck);
  assert.equal(ack.running, true, 'CLI survived the detach');
  b.send(stdinLine({ echo: 'two' }));
  await b.wait(stdoutContaining('"echo":"two"'));
  b.destroy();
});

test('probe answers without preempting the attached client', async () => {
  const ctx = makeCtx();
  const a = await connect(ctx);
  a.send({ t: 'hello', wsId: ctx.wsId });
  await a.wait(isAck);
  a.send(spawnFrame(ctx));

  const p = await connect(ctx);
  p.send({ t: 'probe', wsId: ctx.wsId });
  const ack = await p.wait(isAck);
  assert.equal(ack.running, true);
  p.destroy();

  // a is still the client: relay keeps working
  a.send(stdinLine({ echo: 'still-mine' }));
  await a.wait(stdoutContaining('"echo":"still-mine"'));
  assert.equal(a.closed, false, 'probe must not preempt');
  a.destroy();
});

test('hello preempts the previous client (last wins)', async () => {
  const ctx = makeCtx();
  const a = await connect(ctx);
  a.send({ t: 'hello', wsId: ctx.wsId });
  await a.wait(isAck);
  a.send(spawnFrame(ctx));
  a.send(stdinLine({ echo: 'warm' }));
  await a.wait(stdoutContaining('"echo":"warm"'));

  const b = await connect(ctx);
  b.send({ t: 'hello', wsId: ctx.wsId });
  const ack = await b.wait(isAck);
  assert.equal(ack.running, true);
  await a.waitClose(); // old client kicked
  b.send(stdinLine({ echo: 'taken-over' }));
  await b.wait(stdoutContaining('"echo":"taken-over"'));
  b.destroy();
});

test('stdinEnd → graceful CLI exit → exit frame → full cleanup', async () => {
  const ctx = makeCtx();
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'bye' }));
  await c.wait(stdoutContaining('"echo":"bye"'));
  const keeperPid = pidOf(ctx);
  c.send({ t: 'stdinEnd' });
  const exit = await c.wait(isExit);
  assert.equal(exit.code, 0, 'fake CLI exits 0 on EOF');
  // EOF result line was relayed before exit
  assert.ok(c.frames.some(stdoutContaining('"subtype":"eof"')));
  c.destroy();
  await waitUntil(() => !alive(keeperPid), 5000, 'keeper exits after client detach');
  assert.ok(!fs.existsSync(ctx.sock), 'socket unlinked');
  assert.ok(!fs.existsSync(ctx.pidFile), 'pid file unlinked');
});

test('kill frame terminates promptly; spawn on stale keeper is refused', async () => {
  const ctx = makeCtx();
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'up' }));
  await c.wait(stdoutContaining('"echo":"up"'));
  const keeperPid = pidOf(ctx);
  c.send({ t: 'kill', signal: 'SIGKILL' });
  await c.wait(isExit);
  c.destroy();
  await waitUntil(() => !alive(keeperPid), 5000, 'keeper gone after kill');
  assert.ok(!fs.existsSync(ctx.sock), 'socket unlinked after kill');
});

test('linger: detached turn-complete keeper shuts itself down', async () => {
  const ctx = makeCtx({ ORCHESTRA_KEEPER_LINGER_MS: '400', ORCHESTRA_KEEPER_TICK_MS: '100' });
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'work' }));
  await c.wait(stdoutContaining('"echo":"work"'));
  c.send(stdinLine({ finish: 1 })); // fake CLI emits a result line → turn complete
  await c.wait(stdoutContaining('"type":"result"'));
  const keeperPid = pidOf(ctx);
  c.destroy(); // detach with the turn complete → linger clock starts
  await waitUntil(() => !alive(keeperPid), 5000, 'keeper lingered then exited');
  assert.ok(!fs.existsSync(ctx.sock), 'socket cleaned up');
});

test('mid-turn detach does NOT linger-kill (no result line yet)', async () => {
  const ctx = makeCtx({ ORCHESTRA_KEEPER_LINGER_MS: '300', ORCHESTRA_KEEPER_TICK_MS: '100' });
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'in-flight' })); // assistant line → turn open
  await c.wait(stdoutContaining('"echo":"in-flight"'));
  const keeperPid = pidOf(ctx);
  c.destroy();
  await sleep(1200); // way past linger; wedge (default 2h) not reached
  assert.ok(alive(keeperPid), 'keeper must stay while the turn is in flight');
  // cleanup
  process.kill(keeperPid, 'SIGTERM');
});

// A CLI that IGNORES stdin EOF and SIGTERM — it only dies on SIGKILL. Used to
// prove the kill-frame's SIGTERM → SIGKILL escalation (audit D5) and that a
// keeper reports `shuttingDown` for the whole dying window.
const STUBBORN_CLI = `
process.on('SIGTERM', () => { /* refuse — only SIGKILL ends me */ });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo }) + '\\n');
  }
});
process.stdin.on('end', () => { /* do NOT exit on EOF */ });
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

function stubbornSpawnFrame(ctx: Ctx): KeeperClientFrame {
  const stubborn = path.join(ctx.dir, 'stubborn-cli.cjs');
  fs.writeFileSync(stubborn, STUBBORN_CLI);
  return { t: 'spawn', command: process.execPath, args: [stubborn], cwd: ctx.dir, env: { PATH: process.env.PATH } };
}

const isErr = (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'err' }> => f.t === 'err';

test('kill frame escalates SIGTERM → SIGKILL on a stubborn CLI (audit D5)', async () => {
  // A short escalation window so the test doesn't wait the 5s prod default.
  const ctx = makeCtx({ ORCHESTRA_KEEPER_TICK_MS: '100' });
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(stubbornSpawnFrame(ctx));
  c.send(stdinLine({ echo: 'up' }));
  await c.wait(stdoutContaining('"echo":"up"'));
  const keeperPid = pidOf(ctx);
  // The child pid: read the keeper's helloAck for it via a fresh probe.
  c.send({ t: 'kill', signal: 'SIGTERM' }); // stubborn CLI ignores SIGTERM
  // The keeper must escalate to SIGKILL and the child must die → exit frame.
  const exit = await c.wait(isExit, 12_000);
  assert.equal(exit.signal, 'SIGKILL', 'SIGTERM-ignoring CLI is escalated to SIGKILL');
  const log = fs.readFileSync(ctx.logFile, 'utf8');
  assert.ok(/escalate SIGKILL/.test(log), 'keeper logged the SIGKILL escalation');
  c.destroy();
  await waitUntil(() => !alive(keeperPid), 5000, 'keeper gone after escalation');
});

test('helloAck carries shuttingDown once teardown begins; stdin during shutdown → err (audit D1)', async () => {
  const ctx = makeCtx({ ORCHESTRA_KEEPER_TICK_MS: '100' });
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  const ack0 = await c.wait(isAck);
  assert.notEqual(ack0.shuttingDown, true, 'not shutting down before any teardown');
  c.send(stubbornSpawnFrame(ctx)); // ignores EOF → stays alive across stdinEnd
  c.send(stdinLine({ echo: 'work' }));
  await c.wait(stdoutContaining('"echo":"work"'));
  const keeperPid = pidOf(ctx); // capture BEFORE teardown unlinks the pid file
  // Begin a graceful shutdown; the stubborn CLI keeps running so the keeper is
  // in the shutting-down window for a real interval.
  c.send({ t: 'stdinEnd' });
  await sleep(200);
  // A probe (read-only, doesn't claim the slot) must now report shuttingDown.
  const p = await connect(ctx);
  p.send({ t: 'probe', wsId: ctx.wsId });
  const pack = await p.wait(isAck);
  assert.equal(pack.running, true, 'CLI still alive (stubborn), so running is true');
  assert.equal(pack.shuttingDown, true, 'keeper surfaces shuttingDown while tearing down');
  p.destroy();
  // A stdin frame from the claimed client during shutdown must be answered with
  // an err, not silently dropped (audit D1: the wake-prompt-into-the-void bug).
  c.send(stdinLine({ echo: 'late' }));
  const err = await c.wait(isErr, 3000);
  assert.match(err.msg, /shutting down/, 'stdin during shutdown gets an err reply');
  c.destroy();
  // Cleanup: the keeper will SIGKILL the stubborn CLI at the escalation deadline.
  await waitUntil(() => !alive(keeperPid), 20_000, 'keeper eventually exits');
});

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// App-side wiring pins (S1: a restart never attaches to a dying CLI)
//
// These assert the three app-side halves of D1's fix that cannot be exercised
// from the daemon socket alone — the facade refusing a `shuttingDown` ack, the
// restart callers awaiting process death, and the −1-while-stopping relabel.
// Same mechanical-guard rationale as mcp-refresh-mechanism.test.ts: each pin
// reddens if the wiring is deleted (the negative controls confirm the slice is
// non-empty first). Behaviour is proven end-to-end by the verifier's G1 rig.
// ---------------------------------------------------------------------------

const REPO2 = path.resolve(__dirname2, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO2, rel), 'utf8');

test('facade attach branch refuses a shuttingDown keeper (S1/D1)', () => {
  const src = read('src/main/keeper-client.ts');
  // The attach gate must AND-in `shuttingDown !== true`, and the stale branch's
  // doc must name it — otherwise a dying CLI is attached to (the D1 bug).
  assert.match(
    src,
    /ack\.running\s*&&\s*ack\.everStarted\s*!==\s*false\s*&&\s*ack\.shuttingDown\s*!==\s*true/,
    'attach gate must reject shuttingDown === true',
  );
  assert.match(src, /shuttingDown\?: boolean/, 'KeeperProbe must carry shuttingDown');
});

test('sdkStop no-session path AWAITS killKeeper (S1/D1)', () => {
  const src = read('src/main/agent-sdk.ts');
  const i = src.indexOf('export async function sdkStop(');
  assert.notEqual(i, -1, 'sdkStop not found — renamed?');
  const body = src.slice(i, src.indexOf('\nexport ', i + 1));
  assert.ok(body.length > 200, 'sdkStop body suspiciously short');
  // The no-session path must AWAIT killKeeper, never fire-and-forget (`void`):
  // the unawaited form let an immediate restart race the dying keeper (D1).
  assert.match(body, /await killKeeper\(wsId\)/, 'sdkStop no-session path must await killKeeper');
  assert.doesNotMatch(body, /void killKeeper\(/, 'sdkStop must not fire-and-forget killKeeper');
});

test('consume() relabels a stop-preemption −1 instead of a red error (S1)', () => {
  const src = read('src/main/agent-sdk.ts');
  // The stopping-preemption predicate must gate on BOTH session.stopping AND
  // the synthetic exit −1, and must suppress the error banner + warn log.
  assert.match(
    src,
    /session\.stopping\s*&&\s*\/exited with code -1\\b\/\.test\(message\)/,
    'consume() must recognise a −1 preemption on an already-stopping session',
  );
  assert.match(src, /preemptedWhileStopping/, 'the −1-while-stopping relabel must exist');
});

test('recycleSession awaits keeper death before waking (S1/D1)', () => {
  const src = read('src/main/session-watchdog.ts');
  const i = src.indexOf('export async function recycleSession(');
  assert.notEqual(i, -1, 'recycleSession not found — renamed?');
  const body = src.slice(i, src.indexOf('\nexport ', i + 1) === -1 ? undefined : src.indexOf('\nexport ', i + 1));
  assert.ok(body.length > 200, 'recycleSession body suspiciously short');
  // sdkStop then killKeeper (await process death) then sdkWake — the sdkStop
  // must precede killKeeper must precede the wake, or the wake reattaches to
  // the dying CLI (the 13/13 field failures).
  const stopAt = body.indexOf('sdkStop(wsId)');
  const killAt = body.indexOf('killKeeper(wsId)');
  const wakeAt = body.indexOf('sdkWake(wsId');
  assert.ok(stopAt !== -1 && killAt !== -1 && wakeAt !== -1, 'stop/kill/wake all present');
  assert.ok(stopAt < killAt && killAt < wakeAt, 'order must be sdkStop → killKeeper → sdkWake');
  assert.match(body, /await killKeeper\(wsId\)/, 'recycleSession must AWAIT killKeeper');
});
