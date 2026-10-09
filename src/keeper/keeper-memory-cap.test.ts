// #320 — the built keeper daemon's Plafond mémoire handshake WITHOUT a scope (a plain launch): it must say `no-scope`, start no watch, leave the CLI env exactly as the
// client sent it, and a spawn frame WITHOUT memoryCap must leave helloAck byte-identical to before. The real scope (limit applied, tools wrapped, kills named) is
// scripts/e2e-memory-cap.mjs. Rebuilds the bundle when ANY of its sources is newer (a stale bundle reproduces perfectly in isolation).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLineSplitter, encodeKeeperFrame, parseKeeperFrame, type KeeperClientFrame, type KeeperDaemonFrame } from '../shared/keeper-protocol.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
const FAKE_CLI = `
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.env) process.stdout.write(JSON.stringify({ type: 'assistant', env: { prefix: process.env.CLAUDE_CODE_SHELL_PREFIX ?? null, inner: process.env.ORCHESTRA_INNER_SHELL_PREFIX ?? null, marker: process.env.MARKER ?? null } }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;

before(() => {
  const srcs = ['src/keeper/index.ts', 'src/keeper/memory-watch.ts', 'src/shared/keeper-protocol.ts', 'src/shared/memory-scope.ts'].map((s) => path.join(REPO, s));
  if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dirs: string[] = [];
const pids: number[] = [];

// TEARDOWN BY IDENTITY (D2): the keeper is spawned detached, so SIGKILL of its pid ALONE leaves its fake CLI orphaned (ppid 1, `setInterval` forever) whenever the keeper did not get to stop it first — measured at
// ~2 orphans per full-suite run (wave H). The whole process group goes first, then anything still carrying a test dir is killed with its identity (pid + /proc start time) re-read at signal time.
const readSafe = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const startTicks = (pid: number): string | null => { const t = readSafe(`/proc/${pid}/stat`); return t ? t.slice(t.lastIndexOf(')') + 2).split(' ')[19] ?? null : null; };
/** The processes whose argv or environment carries `dir` (every test process embeds its own scratch dir), with the identity to re-check before a signal. */
function carrying(dir: string): Array<{ pid: number; ticks: string }> {
  const out: Array<{ pid: number; ticks: string }> = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const cmd = readSafe(`/proc/${name}/cmdline`);
    const env = cmd?.includes(dir) ? '' : readSafe(`/proc/${name}/environ`);
    if ((cmd?.includes(dir) || env?.includes(dir)) && startTicks(Number(name)) !== null) out.push({ pid: Number(name), ticks: startTicks(Number(name))! });
  }
  return out;
}
/** Kill everything the suite started; returns the survivors (must be []). Idempotent. */
async function teardownAll(): Promise<Array<{ pid: number; ticks: string }>> {
  for (const p of pids) {
    try { process.kill(-p, 'SIGKILL'); } catch { /* group gone */ }
    try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  }
  for (let round = 0; round < 20; round++) {
    const left = dirs.flatMap(carrying);
    if (left.length === 0) break;
    for (const s of left) if (startTicks(s.pid) === s.ticks) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(100);
  }
  return dirs.flatMap(carrying);
}
after(async () => {
  const left = await teardownAll();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  assert.equal(left.length, 0, `the suite left ${left.length} process(es) behind: ${left.map((x) => x.pid).join(' ')}`);
});

interface Peer { frames: KeeperDaemonFrame[]; send(f: KeeperClientFrame): void; wait<T extends KeeperDaemonFrame>(pred: (f: KeeperDaemonFrame) => f is T, ms?: number): Promise<T>; close(): void }

async function startKeeper(): Promise<{ peer: Peer; dir: string; cli: string; wsId: string }> {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'kmc-'));
  dirs.push(dir);
  const wsId = `ws-${path.basename(dir)}`;
  const sock = path.join(dir, 'k.sock');
  const cli = path.join(dir, 'cli.cjs');
  fs.writeFileSync(cli, FAKE_CLI);
  const child = spawn(process.execPath, [KEEPER_JS, wsId, sock, path.join(dir, 'k.pid'), path.join(dir, 'k.log')], { detached: true, stdio: 'ignore', env: { ...process.env, ORCHESTRA_KEEPER_LINGER_MS: '60000' } });
  child.unref();
  if (child.pid) pids.push(child.pid);
  let s: net.Socket | null = null;
  for (let i = 0; i < 60 && !s; i++) {
    s = await new Promise<net.Socket | null>((res) => { const c = net.connect(sock); c.once('connect', () => res(c)); c.once('error', () => res(null)); });
    if (!s) await sleep(100);
  }
  assert.ok(s, 'keeper never came up');
  const frames: KeeperDaemonFrame[] = [];
  s.on('data', createLineSplitter((line) => { const f = parseKeeperFrame(line); if (f) frames.push(f as KeeperDaemonFrame); }));
  s.on('error', () => {});
  const peer: Peer = {
    frames,
    send: (f) => s!.write(encodeKeeperFrame(f)),
    async wait(pred, ms = 5000) {
      const t0 = Date.now();
      for (;;) { const hit = frames.find(pred); if (hit) return hit; if (Date.now() - t0 > ms) throw new Error('timeout waiting for frame'); await sleep(40); }
    },
    close: () => s!.destroy(),
  };
  peer.send({ t: 'hello', wsId });
  await peer.wait((f): f is Extract<KeeperDaemonFrame, { t: 'helloAck' }> => f.t === 'helloAck');
  return { peer, dir, cli, wsId };
}

const isAck = (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'helloAck' }> => f.t === 'helloAck';
const envLine = (f: KeeperDaemonFrame): f is Extract<KeeperDaemonFrame, { t: 'stdout' }> => f.t === 'stdout' && Buffer.from(f.b64, 'base64').toString().includes('"env"');
const stdin = (o: unknown): KeeperClientFrame => ({ t: 'stdin', b64: Buffer.from(JSON.stringify(o) + '\n').toString('base64') });

test('memoryCap asked but the keeper was launched PLAIN (not in the named scope) ⇒ cap.state "no-scope", no wrapper in the CLI env, the user\'s own prefix untouched', async () => {
  const { peer, dir, cli, wsId } = await startKeeper();
  peer.send({ t: 'spawn', command: process.execPath, args: [cli], cwd: dir, env: { PATH: process.env.PATH, MARKER: 'm1', CLAUDE_CODE_SHELL_PREFIX: '/users/own-prefix.sh' }, memoryCap: { unit: 'orchestra-ws-nope-abcdef.scope', hardBytes: 256 * 1024 * 1024, wrapper: '/x/oom-tool-wrapper.sh' } });
  await sleep(300);
  peer.send({ t: 'hello', wsId });
  peer.frames.length = 0;
  peer.send({ t: 'hello', wsId });
  const ack = await peer.wait(isAck);
  assert.equal(ack.running, true);
  assert.deepEqual(ack.cap, { unit: 'orchestra-ws-nope-abcdef.scope', state: 'no-scope', hardBytes: 256 * 1024 * 1024 });
  assert.equal(ack.memKills, undefined);
  peer.send(stdin({ env: 1 }));
  const out = await peer.wait(envLine);
  const env = JSON.parse(Buffer.from(out.b64, 'base64').toString().trim()).env;
  assert.deepEqual(env, { prefix: '/users/own-prefix.sh', inner: null, marker: 'm1' }, 'the CLI env is exactly what the client sent');
  peer.send({ t: 'kill', signal: 'SIGKILL' });
  peer.close();
});

test('a spawn frame WITHOUT memoryCap ⇒ helloAck has no cap and no memKills (byte-identical to a pre-#320 keeper)', async () => {
  const { peer, dir, cli, wsId } = await startKeeper();
  peer.send({ t: 'spawn', command: process.execPath, args: [cli], cwd: dir, env: { PATH: process.env.PATH } });
  await sleep(300);
  peer.frames.length = 0;
  peer.send({ t: 'hello', wsId });
  const ack = await peer.wait(isAck);
  assert.ok(!('cap' in ack) && !('memKills' in ack), JSON.stringify(ack));
  peer.send({ t: 'kill', signal: 'SIGKILL' });
  peer.close();
});

test('teardown (D2): a keeper killed WITHOUT the chance to stop its CLI leaves no orphan — positive control: the old keeper-pid-only SIGKILL DOES leave one; then 0 survivors, printed', async () => {
  const { peer, dir, cli } = await startKeeper();
  peer.send({ t: 'spawn', command: process.execPath, args: [cli], cwd: dir, env: { PATH: process.env.PATH } });
  await sleep(400);
  const keeperPid = pids[pids.length - 1];
  process.kill(keeperPid, 'SIGKILL'); // what the OLD `after` hook did: the keeper pid alone
  await sleep(300);
  const orphans = carrying(dir).filter((p) => p.pid !== keeperPid && startTicks(p.pid) !== null);
  assert.ok(orphans.length >= 1, 'the instrument sees the orphaned fake CLI that the old teardown left behind');
  const orphan = orphans[0];
  peer.close();
  const left = await teardownAll();
  assert.equal(startTicks(orphan.pid) === orphan.ticks, false, 'the orphan is gone');
  console.log(`# kmc teardown: orphans before=${orphans.length} survivors after=${left.length}`);
  assert.equal(left.length, 0);
});

test('the suite leaves 0 survivors: no process carries any scratch dir of this file (printed)', async () => {
  const left = await teardownAll();
  console.log(`# kmc SURVIVORS procs=${left.length} dirs=${dirs.length}`);
  assert.equal(left.length, 0);
});
