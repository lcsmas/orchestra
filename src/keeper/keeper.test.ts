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
import { carrying, groupOf, identOf, killIdent, reap, statOf, type Ident } from './test-teardown.ts';

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
    path.join(REPO, 'src', 'keeper', 'memory-watch.ts'),
    path.join(REPO, 'src', 'shared', 'keeper-protocol.ts'),
    path.join(REPO, 'src', 'shared', 'memory-scope.ts'),
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
/** A keeper whose runner died (no `after`) ends itself within ~1 min instead of lingering 15 min / wedging 2 h; a test that needs other values overrides them. */
const BOUNDED_KEEPER_ENV = { ORCHESTRA_KEEPER_LINGER_MS: '60000', ORCHESTRA_KEEPER_WEDGE_MS: '60000', ORCHESTRA_KEEPER_TICK_MS: '2000' };
/** Every keeper this file launched, with the identity (pid + start time) read right after the spawn — teardown signals nothing it cannot match to these. */
const keepers: Ident[] = [];
function track(pid: number | undefined): void {
  const id = pid ? identOf(pid) : null;
  if (id) keepers.push(id);
}

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
    env: { ...process.env, ...BOUNDED_KEEPER_ENV, ...env },
  });
  child.unref();
  track(child.pid);
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
const SIGTERM_IGNORING_BODY = `
process.on('SIGTERM', () => { /* deliberately ignored */ });
process.stdin.on('data', (d) => {
  const s = d.toString('utf8');
  for (const line of s.split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo }) + '\\n');
  }
});
`;
/** NO tie to its keeper — the shape that outlived a test runner killed before `after` ran (ppid 1, wave H). Only the teardown witness uses it; a 30 s lifetime cap keeps the witness itself from leaking if ITS runner dies (pre-review F1). */
const SIGTERM_IGNORING_CLI_BARE = SIGTERM_IGNORING_BODY + `setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000);\n`;
/** Same, but it exits once its keeper is gone (reparented ⇒ ppid changes): it still ignores SIGTERM and stdin EOF while the keeper lives, so D1/D5 are unchanged, yet it can never outlive a dead runner. */
const SIGTERM_IGNORING_CLI = SIGTERM_IGNORING_BODY + `const KEEPER = process.ppid; setInterval(() => { if (process.ppid !== KEEPER) process.exit(0); }, 200);\n`;
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

after(async () => {
  // TEARDOWN BY IDENTITY (D2): every keeper's process group, then anything still carrying a scratch dir — each signal only after its start time is re-read (test-teardown.ts).
  const left = await reap(keepers, ctxs.map((c) => c.dir));
  for (const ctx of ctxs) fs.rmSync(ctx.dir, { recursive: true, force: true });
  assert.equal(left.length, 0, `keeper / fake-CLI processes leaked past teardown: ${left.map((x) => x.pid).join(' ')}`);
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
  await sleep(1200); // way past linger; the wedge (60 s here, BOUNDED_KEEPER_ENV) not reached
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
  const child = spawn(process.execPath, [KEEPER_JS, ctx.wsId, ctx.sock, ctx.pidFile, ctx.logFile], { detached: true, stdio: 'ignore', env: { ...process.env, ...BOUNDED_KEEPER_ENV } });
  child.unref();
  track(child.pid);
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
      const rec = keepers.find((k) => k.pid === p); // by identity: the start time recorded at launch (a pid we never recorded is not signalled)
      if (rec) killIdent(rec);
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
      const rec = keepers.find((k) => k.pid === p); // by identity: the start time recorded at launch (a pid we never recorded is not signalled)
      if (rec) killIdent(rec);
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

// ── Teardown by identity (D2) ────────────────────────────────────────────────
// The leak: a SIGTERM-ignoring fake CLI outlives a keeper that was SIGKILLed (D1 does exactly that), and ONLY a deferred `after` reaped it — when the runner died first (timeout, Pause dure, ^C) it stayed
// forever (ppid 1). Measured on master: killing the runner's group once the D5 test started left 2 such orphans. Fixture self-reaps now; teardown signals by identity; these tests pin both.
async function startIgnoringCli(cliBody: string): Promise<{ ctx: Ctx; keeper: Ident; cli: ReturnType<typeof carrying>[number]; c: Client }> {
  const ctx = makeCtx(undefined, cliBody);
  const keeper = keepers[keepers.length - 1];
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'up' }));
  await c.wait(stdoutContaining('"echo":"up"'));
  const cli = carrying(ctx.dir).find((p) => p.ppid === keeper.pid && p.cmd.includes('fake-cli.cjs'));
  assert.ok(cli, 'the fake CLI is running under its keeper');
  return { ctx, keeper, cli, c };
}

test('teardown witness: SIGKILL of the keeper pid ALONE (the old teardown) orphans a CLI that has no tie to its keeper; the identity teardown reaps it', async () => {
  const { ctx, keeper, cli, c } = await startIgnoringCli(SIGTERM_IGNORING_CLI_BARE);
  process.kill(keeper.pid, 'SIGKILL'); // what the old teardown did: the keeper pid alone
  c.destroy();
  await waitUntil(() => statOf(cli.pid)?.ppid !== keeper.pid, 3000, 'the CLI is reparented (its keeper is dead)');
  await sleep(600);
  assert.equal(identOf(cli.pid)?.ticks, cli.ticks, 'witness: the orphan is STILL running 600 ms after its keeper died');
  const left = await reap(keepers, [ctx.dir]);
  assert.equal(identOf(cli.pid)?.ticks === cli.ticks, false, 'the identity teardown reaped it');
  console.log(`# keeper.test teardown witness: orphan pid=${cli.pid} survived old-kill=yes survivors after reap=${left.length}`);
  assert.equal(left.length, 0);
});

test('the SIGTERM-ignoring fixture dies WITH its keeper — no teardown involved (a dead runner cannot leave it behind)', async () => {
  const { keeper, cli, c } = await startIgnoringCli(SIGTERM_IGNORING_CLI);
  process.kill(keeper.pid, 'SIGKILL');
  c.destroy();
  await waitUntil(() => identOf(cli.pid)?.ticks !== cli.ticks, 3000, 'the CLI exits once its keeper is gone');
});

test('teardown identity guard: a record whose start time no longer matches is NEVER signalled (a recycled pid is a stranger); a matching one is', async () => {
  const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const stranger = idle();
  const target = idle();
  stranger.unref();
  target.unref();
  const strangerId = identOf(stranger.pid as number) as Ident;
  const targetId = identOf(target.pid as number) as Ident;
  try {
    const wrong = { pid: strangerId.pid, ticks: String(Number(strangerId.ticks) + 1) };
    assert.equal(killIdent(wrong), false, 'killIdent refuses a mismatching start time');
    assert.deepEqual(groupOf(wrong), [], 'groupOf yields nothing for a leader that is no longer the recorded process');
    await reap([wrong, targetId], []);
    await waitUntil(() => identOf(targetId.pid)?.ticks !== targetId.ticks, 3000, 'the matching record is killed');
    assert.equal(identOf(strangerId.pid)?.ticks, strangerId.ticks, 'the stranger was left alone');
  } finally {
    killIdent(strangerId);
    killIdent(targetId);
  }
});

test('teardown reports what it could NOT kill: a respawner keeps carrying the dir ⇒ survivors > 0; once the respawner is gone ⇒ 0 (the survivor count is measured, not assumed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-test-respawn-'));
  // the respawner does NOT carry `dir` in its argv; every child it forks does (`sh -c 'sleep 1; :' <dir>/x`: $0 stays in the argv — a bare `sleep 1` would be exec'd over it) — `reap` kills a child, a new one is there next round
  const respawner = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');setInterval(()=>{spawn('sh',['-c','sleep 1; :',process.env.RESPAWN_DIR+'/x'],{stdio:'ignore'}).unref()},50)`], { detached: true, stdio: 'ignore', env: { ...process.env, RESPAWN_DIR: dir } }); // the dir is in its ENVIRONMENT only: carrying(dir) reads argv, so the respawner itself is not swept
  respawner.unref();
  const id = identOf(respawner.pid as number) as Ident;
  try {
    await sleep(300);
    const left = await reap([], [dir]);
    assert.ok(left.length > 0, 'a respawner defeats the sweep: reap must say so');
    killIdent(id);
    await waitUntil(() => identOf(id.pid)?.ticks !== id.ticks, 3000, 'the respawner is gone');
    const after = await reap([], [dir]);
    assert.equal(after.length, 0, 'nothing left once the respawner is gone');
  } finally {
    killIdent(id);
    await reap([], [dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the suite leaves 0 survivors: no process carries any scratch dir of this file (printed)', async () => {
  const dirs = ctxs.map((c) => c.dir);
  assert.ok(keepers.length >= ctxs.length, `every keeper launched was recorded (${keepers.length} identities for ${ctxs.length} ctxs)`);
  const before = dirs.flatMap((d) => carrying(d)).length;
  const left = await reap(keepers, dirs);
  console.log(`# keeper.test SURVIVORS procs=${left.length} (before this final reap: ${before}) keepers=${keepers.length} dirs=${dirs.length}`);
  assert.equal(left.length, 0);
});

// The `after` hook is the net for a test that FAILS mid-way. Nothing else exercises it, so with KEEPER_TEST_LEAVE_CANARY=1 (set only by scripts/keeper-test-leak-mutants.mjs) this last test leaves a live
// keeper + CLI behind on purpose: the harness's post-run census must still find 0 — a no-op `after` shows as a survivor there. Without the variable it does nothing.
test('after-hook canary (opt-in: KEEPER_TEST_LEAVE_CANARY=1 — leaves one live keeper for the `after` hook to reap)', async () => {
  if (process.env.KEEPER_TEST_LEAVE_CANARY !== '1') return;
  const ctx = makeCtx();
  const c = await connect(ctx);
  c.send({ t: 'hello', wsId: ctx.wsId });
  await c.wait(isAck);
  c.send(spawnFrame(ctx));
  c.send(stdinLine({ echo: 'canary' }));
  await c.wait(stdoutContaining('"echo":"canary"'));
  assert.ok(carrying(ctx.dir).length >= 2, 'a keeper and its CLI are alive and are left for the after hook');
  c.destroy(); // no open handle: a runner whose `after` does NOT reap must still EXIT (rc 0) so the harness census sees the leftover — an attached socket to a live keeper would hang it
});
