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

function makeCtx(env?: Record<string, string>, cliBody: string = FAKE_CLI): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-test-'));
  const ctx: Ctx = {
    dir,
    wsId: 'ws-' + path.basename(dir),
    sock: path.join(dir, 'k.sock'),
    pidFile: path.join(dir, 'k.pid'),
    logFile: path.join(dir, 'k.log'),
    fakeCli: path.join(dir, 'fake-cli.cjs'),
  };
  fs.writeFileSync(ctx.fakeCli, cliBody);
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
const isErr = (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'err' }> => f.t === 'err';
const errWithMsg =
  (needle: string) =>
  (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'err' }> =>
    f.t === 'err' && f.msg.includes(needle);

/** A fake CLI that IGNORES SIGTERM and stays alive until SIGKILL — models a CLI
 *  that ignores the graceful signal so the keeper's escalation must fire (D5).
 *  Never exits its stdin `end` handler either, so `shuttingDown` stays observable
 *  for the whole escalation window. */
const SIGTERM_IGNORING_CLI = `
process.on('SIGTERM', () => { /* deliberately ignored */ });
process.stdin.on('data', (d) => {
  const s = d.toString('utf8');
  for (const line of s.split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo }) + '\\n');
  }
});
// Keep the event loop alive forever (until SIGKILL).
setInterval(() => {}, 1000);
`;
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

/** Pids whose argv runs `file` (Linux /proc; elsewhere nothing — the leak was measured here). */
function pidsRunning(file: string): number[] {
  const out: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0').includes(file)) out.push(Number(e));
    } catch {
      /* gone */
    }
  }
  return out;
}

after(() => {
  // Belt-and-braces: kill any keeper the tests leaked, then rm temp dirs.
  for (const ctx of ctxs) {
    try {
      process.kill(pidOf(ctx), 'SIGKILL');
    } catch {
      /* already gone */
    }
    // Also the fake CLI: SIGTERM_IGNORING_CLI never exits on its own, and killing its
    // keeper orphans it forever (588 leaked processes / 10 GB measured 2026-09-30).
    for (const pid of pidsRunning(ctx.fakeCli)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
  // LEAK ASSERTION: after the reap above NO keeper daemon / fake CLI of any ctx may still be running (a
  // SIGSTOPped or SIGTERM-ignoring fake is killed by SIGKILL too). Fails the file rather than orphaning to init.
  const live = (): number[] =>
    ctxs.flatMap((ctx) => [...pidsRunning(ctx.fakeCli), ...pidsRunning(ctx.sock)]).filter((p) => alive(p) && !isZombie(p));
  const t0 = Date.now();
  while (live().length && Date.now() - t0 < 3000) {
    for (const p of live()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  assert.deepEqual(live(), [], 'keeper / fake-CLI processes leaked past teardown');
});

function isZombie(pid: number): boolean {
  try {
    return /^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

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

// ── D1: helloAck.shuttingDown + stdin-during-shutdown err ────────────────────
// A dying CLI still reports running:true until its exit lands. helloAck must
// carry `shuttingDown` so an attaching client refuses it (facade) instead of
// writing its wake prompt into a frame the keeper drops. And a stdin frame that
// arrives during shutdown must be answered with an `err`, never silently lost.

test('D1 — probe during shutdown reports shuttingDown:true (SIGTERM-ignoring CLI)', async () => {
  const ctx = makeCtx(undefined, SIGTERM_IGNORING_CLI);
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  const ack0 = await c.wait(isAck);
  assert.notEqual(ack0.shuttingDown, true, 'not shutting down before stdinEnd');
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'up' }));
  await c.wait(stdoutContaining('"echo":"up"'));
  const keeperPid = pidOf(ctx);
  // Begin the graceful shutdown; the CLI ignores SIGTERM so the escalation
  // window (10s SIGTERM → 5s SIGKILL) stays open — probe inside it.
  c.send({ t: 'stdinEnd' });
  await sleep(300);
  const p = await connect(ctx);
  p.send({ t: 'probe', wsId: ctx.wsId });
  const ack = await p.wait((f): f is Extract<KeeperDaemonFrame, { t: 'helloAck' }> => isAck(f) && f.shuttingDown === true);
  assert.equal(ack.shuttingDown, true, 'a shutting-down keeper surfaces it in helloAck');
  assert.equal(ack.running, true, 'CLI still running while it ignores SIGTERM');
  p.destroy();
  c.destroy();
  process.kill(keeperPid, 'SIGKILL');
});

test('D1 — a stdin frame during shutdown is answered with err, not dropped', async () => {
  const ctx = makeCtx(undefined, SIGTERM_IGNORING_CLI);
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'up' }));
  await c.wait(stdoutContaining('"echo":"up"'));
  const keeperPid = pidOf(ctx);
  c.send({ t: 'stdinEnd' });
  await sleep(300);
  // The same still-attached client now tries to push more input — the keeper is
  // shutting down, so it must reply `err: shutting down` (audit D1) rather than
  // silently discarding the frame (the old behavior that lost the wake prompt).
  c.send(stdinLine({ echo: 'too-late' }));
  const err = await c.wait(errWithMsg('shutting down'));
  assert.match(err.msg, /shutting down/);
  c.destroy();
  process.kill(keeperPid, 'SIGKILL');
});

test('D5 — kill frame escalates SIGTERM → SIGKILL for a CLI that ignores SIGTERM', async () => {
  const ctx = makeCtx(undefined, SIGTERM_IGNORING_CLI);
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'up' }));
  await c.wait(stdoutContaining('"echo":"up"'));
  const keeperPid = pidOf(ctx);
  // Default kill signal is SIGTERM, which this CLI ignores. Without the D5
  // escalation the CLI (and keeper) would live forever; escalation SIGKILLs it
  // after ESCALATE_KILL_MS (5s). Bound the wait above that.
  c.send({ t: 'kill' });
  await c.wait(isExit, 12000);
  c.destroy();
  await waitUntil(() => !alive(keeperPid), 12000, 'keeper gone after SIGTERM→SIGKILL escalation');
  assert.ok(!fs.existsSync(ctx.sock), 'socket unlinked after escalated kill');
});

/** Launch a keeper by hand on ctx's paths (a racing/second launch). */
function launchOn(ctx: Ctx): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, [KEEPER_JS, ctx.wsId, ctx.sock, ctx.pidFile, ctx.logFile], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

test('#202 — a second keeper on a live keeper\'s socket refuses to start and touches nothing', { timeout: 60_000 }, async () => {
  const ctx = makeCtx();
  const c = await connect(ctx);
  const pids: number[] = [];
  try {
    c.send({ t: 'hello', wsId: ctx.wsId });
    await c.wait(isAck);
    c.send(spawnFrame(ctx));
    c.send(stdinLine({ echo: 'one' }));
    await c.wait(stdoutContaining('"echo":"one"'));
    const k1 = pidOf(ctx);
    pids.push(k1);
    const second = launchOn(ctx);
    pids.push(second.pid as number);
    await waitUntil(() => !alive(second.pid as number), 8000, 'second keeper exits (refuses)');
    // K1 still owns the paths and still relays.
    assert.equal(pidOf(ctx), k1, 'pid file still names the first keeper');
    assert.ok(fs.existsSync(ctx.sock), 'socket untouched');
    c.send(stdinLine({ echo: 'two' }));
    assert.ok(await c.wait(stdoutContaining('"echo":"two"')), 'first keeper still serves its client');
  } finally {
    // A failing arm must not leave an open socket / live daemon (node --test would hang on it).
    c.destroy();
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

test('#202 — a keeper\'s exit unlinks only the files it owns (a takeover survives it)', { timeout: 60_000 }, async () => {
  const ctx = makeCtx();
  const c = await connect(ctx);
  const pids: number[] = [];
  let c2: Client | null = null;
  try {
    c.send({ t: 'hello', wsId: ctx.wsId });
    await c.wait(isAck);
    c.send(spawnFrame(ctx));
    c.send(stdinLine({ echo: 'up' }));
    await c.wait(stdoutContaining('"echo":"up"')); // a live CLI keeps K1 alive across the detach
    const k1 = pidOf(ctx);
    pids.push(k1);
    c.destroy();
    fs.unlinkSync(ctx.sock); // an older build's race removed K1's paths…
    fs.unlinkSync(ctx.pidFile);
    const k2 = launchOn(ctx); // …and K2 took them over
    pids.push(k2.pid as number);
    await waitUntil(() => fs.existsSync(ctx.pidFile) && pidOf(ctx) === k2.pid, 8000, 'K2 owns the pid file');
    process.kill(k1, 'SIGTERM'); // K1's cleanup runs
    await waitUntil(() => !alive(k1), 8000, 'K1 gone');
    assert.equal(pidOf(ctx), k2.pid, 'pid file still names K2');
    c2 = await connect(ctx, 5);
    c2.send({ t: 'probe', wsId: ctx.wsId });
    assert.ok(await c2.wait(isAck), 'K2 still reachable on the socket K1 exited from');
  } finally {
    c.destroy();
    c2?.destroy();
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(100);
  }
}
