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
after(() => {
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
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
