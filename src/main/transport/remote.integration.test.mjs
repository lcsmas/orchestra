/**
 * Host-side end-to-end integration test: drives the REAL app transport modules
 * (SandboxConnection + RemoteTransport + the ws→SandboxSocket adapter) against
 * the REAL compiled shim over a real WebSocket. Where integration.test.mjs in
 * sandbox/shim/ exercises the wire from raw frames, this proves the host code
 * path callers actually use: a RemoteTransport that looks exactly like a local
 * one to pty.ts.
 *
 * SandboxConnection / remote.ts import only the wire protocol (no Electron), so
 * we load them with --experimental-strip-types. We do NOT load sandbox-manager.ts
 * (it imports activity/workspaces → Electron); instead we replicate its tiny
 * ws→socket adapter here and wire onEvent/onRpc to local spies.
 *
 * Run: node --experimental-strip-types \
 *        src/main/transport/remote.integration.test.mjs
 * (requires the shim built at sandbox/shim/dist and the app's `ws` dep.)
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { SandboxConnection } from './sandbox-connection.ts';
import { createRemoteTransport } from './remote.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const SHIM = path.join(repoRoot, 'sandbox', 'shim', 'dist', 'shim.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-it-'));
const EVENTS_DIR = path.join(tmp, 'events');
const SOCK = path.join(tmp, 'hooks.sock');
const PORT = 8801;
fs.mkdirSync(EVENTS_DIR, { recursive: true });

const log = (...a) => console.log('[host-it]', ...a);
let shim, ws;

function cleanup() {
  try { ws?.close(); } catch {}
  try { shim?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
function fail(msg, err) { console.error('FAIL:', msg, err ?? ''); cleanup(); process.exit(1); }
function waitFor(pred, ms, label) {
  return new Promise((res, rej) => {
    const start = process.hrtime.bigint();
    const tick = () => {
      if (pred()) return res();
      if (Number(process.hrtime.bigint() - start) / 1e6 > ms) return rej(new Error(`timeout: ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// The same adapter sandbox-manager.ts uses.
function adaptSocket(sock) {
  sock.binaryType = 'nodebuffer';
  return {
    send: (d) => sock.send(d),
    close: (c, r) => sock.close(c, r),
    on: (ev, l) => sock.on(ev, l),
    get readyState() { return sock.readyState; },
  };
}

function postSock(route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { socketPath: SOCK, path: '/' + route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); },
    );
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function main() {
  shim = spawn(process.execPath, [SHIM], {
    env: { ...process.env, ORCHESTRA_EVENTS_DIR: EVENTS_DIR, ORCHESTRA_SOCK: SOCK, ORCHESTRA_SHIM_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(() => fs.existsSync(SOCK), 5000, 'shim socket').catch((e) => fail('shim boot', e));

  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }).catch((e) => fail('ws open', e));

  const events = [];
  const rpcs = [];
  const conn = new SandboxConnection(adaptSocket(ws), {
    onEvent: (session, event, tool) => events.push({ session, event, tool }),
    onRpc: (route, payload, reply) => { rpcs.push({ route, payload }); reply({ ok: true, peers: [], sawRoute: route }); },
    onClose: () => log('conn closed'),
    onError: (e) => fail('conn error', e),
  });
  log('SandboxConnection established over real ws');

  // ── RemoteTransport: spawn, data, write, exit — the SessionTransport surface ─
  const session = 'ws-host-1';
  const data = [];
  let exitCode = null;
  const transport = await createRemoteTransport(conn, session, {
    command: 'bash',
    args: ['-lc', 'echo READY; cat'],
    cwd: tmp,
    env: { TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
  });
  transport.onData((d) => data.push(d));
  transport.onExit((e) => { exitCode = e.exitCode; });
  assert.equal(transport.pid, undefined, 'remote transport has no local pid');

  await waitFor(() => data.join('').includes('READY'), 5000, 'data via RemoteTransport').catch((e) => fail('no data', e));
  log('✓ RemoteTransport.onData receives pty output');

  transport.write('ECHOED\n');
  await waitFor(() => data.join('').includes('ECHOED'), 5000, 'write echo').catch((e) => fail('write lost', e));
  log('✓ RemoteTransport.write reaches the pty');

  transport.write('\x04'); // EOF → exit
  await waitFor(() => exitCode !== null, 5000, 'exit').catch((e) => fail('no exit', e));
  assert.equal(exitCode, 0);
  log('✓ RemoteTransport.onExit fires with code 0');

  // ── onEvent: spool line → connection callback ──────────────────────────────
  fs.appendFileSync(path.join(EVENTS_DIR, `${session}.jsonl`), JSON.stringify({ event: 'submit' }) + '\n');
  await waitFor(() => events.some((e) => e.session === session && e.event === 'submit'), 5000, 'onEvent')
    .catch((e) => fail('no onEvent', e));
  log('✓ SandboxConnection.onEvent fires from a spool append');

  // ── onRpc: agent POST → connection callback → reply back to the POST ────────
  const resp = await postSock('peers', { from: session });
  assert.equal(resp.status, 200);
  const parsed = JSON.parse(resp.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sawRoute, 'peers');
  assert.ok(rpcs.some((r) => r.route === 'peers'), 'onRpc should have seen the peers call');
  log('✓ SandboxConnection.onRpc dispatches and replies to the agent POST');

  // ── connection-lost: closing the socket synthesizes exits for live sessions ─
  const s2 = 'ws-host-2';
  let s2exit = null;
  const t2 = await createRemoteTransport(conn, s2, { command: 'bash', args: ['-lc', 'sleep 30'], cwd: tmp, env: {}, cols: 80, rows: 24 });
  t2.onExit((e) => { s2exit = e.exitCode; });
  await waitFor(() => true, 200, 'settle');
  conn.close();
  await waitFor(() => s2exit !== null, 3000, 'connection-lost exit').catch((e) => fail('no synth exit on close', e));
  assert.equal(s2exit, -1, 'EXIT_CONNECTION_LOST');
  log('✓ socket close synthesizes connection-lost exit for live sessions');

  log('ALL HOST-SIDE INTEGRATION CHECKS PASSED');
  cleanup();
  process.exit(0);
}

main().catch((e) => fail('unexpected', e));
