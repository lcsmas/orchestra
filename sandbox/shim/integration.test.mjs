/**
 * End-to-end integration test for the sandbox shim.
 *
 * Boots the real compiled shim (dist/shim.js) as a child process with a temp
 * events dir, temp unix socket, and a test WS port, then drives it from a real
 * `ws` client wrapped in the host-side framing — exercising all three channels
 * over the actual wire:
 *
 *   1. terminal:  spawn a real PTY (`bash -lc 'echo … '`), collect `data`,
 *                 await `exit` with the right code; verify `write` reaches it.
 *   2. activity:  append a line to the spool file → expect an `event` frame.
 *   3. control:   POST the shim's unix socket (/peers) → expect an `rpc` frame
 *                 at the client; reply; verify the curl/POST gets the reply.
 *
 * Run with: node sandbox/shim/integration.test.mjs   (needs `npm install` +
 * `npm run build` first — uses dist/shim.js and the `ws` dependency). Exits 0 on
 * success, non-zero with a message on failure.
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  FrameDecoder,
} from './dist/sandbox-protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(here, 'dist', 'shim.js');

// Unique-ish temp paths without Date.now/Math.random (kept deterministic-ish by pid).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-it-'));
const EVENTS_DIR = path.join(tmp, 'events');
const SOCK = path.join(tmp, 'hooks.sock');
const PORT = 8799;
fs.mkdirSync(EVENTS_DIR, { recursive: true });

const log = (...a) => console.log('[it]', ...a);
let shim;
let ws;

function fail(msg, err) {
  console.error('FAIL:', msg, err ?? '');
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { ws?.close(); } catch {}
  try { shim?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const tick = () => {
      if (pred()) return resolve();
      if (Number(process.hrtime.bigint() - start) / 1e6 > timeoutMs) {
        return reject(new Error(`timeout waiting for: ${label}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ── client-side frame plumbing ──────────────────────────────────────────────
const decoder = new FrameDecoder();
const inbound = []; // every frame the shim sent us
let onFrame = () => {};

function send(frame) {
  ws.send(encodeFrame(frame));
}

// POST the shim's unix socket like the agent's curl does.
function postSock(route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { socketPath: SOCK, path: '/' + route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // 1. boot the shim
  shim = spawn(process.execPath, [SHIM], {
    env: { ...process.env, ORCHESTRA_EVENTS_DIR: EVENTS_DIR, ORCHESTRA_SOCK: SOCK, ORCHESTRA_SHIM_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  shim.on('exit', (code) => { if (code) log(`shim exited early code=${code}`); });

  // 2. wait for the socket + port to come up, then connect
  await waitFor(() => fs.existsSync(SOCK), 5000, 'shim hook socket').catch((e) => fail('shim never bound socket', e));
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.binaryType = 'nodebuffer';
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }).catch((e) => fail('ws never opened', e));
  ws.on('message', (buf) => {
    for (const f of decoder.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))) {
      inbound.push(f);
      onFrame(f);
    }
  });
  log('connected to shim');

  // ── test 1: terminal spawn → data → exit ──────────────────────────────────
  const session = 'ws-it-1';
  send({
    t: 'spawn',
    session,
    command: 'bash',
    args: ['-lc', 'echo HELLO_FROM_PTY; cat'], // `cat` keeps it alive so we can test write→exit
    cwd: tmp,
    env: { TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
  });

  await waitFor(
    () => inbound.some((f) => f.t === 'data' && f.session === session && f.data.includes('HELLO_FROM_PTY')),
    5000,
    'pty data echo',
  ).catch((e) => fail('did not receive pty data', e));
  log('✓ terminal data flows');

  // write into the pty's stdin (cat will echo it), then EOF to make it exit 0
  send({ t: 'write', session, data: 'PING\n' });
  await waitFor(
    () => inbound.some((f) => f.t === 'data' && f.session === session && f.data.includes('PING')),
    5000,
    'pty echo of written input',
  ).catch((e) => fail('write did not reach pty', e));
  log('✓ write reaches the pty');

  send({ t: 'write', session, data: '\x04' }); // Ctrl-D → cat EOF → bash exits
  await waitFor(() => inbound.some((f) => f.t === 'exit' && f.session === session), 5000, 'pty exit')
    .catch((e) => fail('pty never exited', e));
  const exitFrame = inbound.find((f) => f.t === 'exit' && f.session === session);
  assert.equal(exitFrame.exitCode, 0, `expected clean exit, got ${exitFrame.exitCode}`);
  log('✓ exit frame with code 0');

  // ── test 2: spool line → event frame ───────────────────────────────────────
  // The shim only watches a session's spool once it has been spawned (it is, above).
  const spoolFile = path.join(EVENTS_DIR, `${session}.jsonl`);
  fs.appendFileSync(spoolFile, JSON.stringify({ event: 'pretool', tool: 'Bash' }) + '\n');
  await waitFor(
    () => inbound.some((f) => f.t === 'event' && f.session === session && f.event === 'pretool' && f.tool === 'Bash'),
    5000,
    'activity event frame',
  ).catch((e) => fail('spool append did not produce an event frame', e));
  log('✓ spool line → event frame');

  // ── test 3: hook socket POST → rpc frame → rpcReply → HTTP response ─────────
  // Answer the next rpc the shim forwards.
  onFrame = (f) => {
    if (f.t === 'rpc') {
      send({ t: 'rpcReply', id: f.id, payload: { ok: true, peers: [{ id: 'peer-1' }], echoedRoute: f.route } });
    }
  };
  const resp = await postSock('peers', { from: session });
  assert.equal(resp.status, 200, `peers POST status ${resp.status}`);
  const parsed = JSON.parse(resp.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.echoedRoute, 'peers');
  assert.deepEqual(parsed.peers, [{ id: 'peer-1' }]);
  log('✓ hook socket POST → rpc → rpcReply round-trip');

  // ── test 4: a non-forwarded route is acked locally (not turned into an rpc) ─
  const before = inbound.filter((f) => f.t === 'rpc').length;
  const evResp = await postSock('event', { id: session, event: 'stop' });
  assert.equal(evResp.status, 200);
  const after = inbound.filter((f) => f.t === 'rpc').length;
  assert.equal(after, before, 'the /event route must NOT produce an rpc frame');
  log('✓ non-forwarded /event route acked locally');

  log('ALL INTEGRATION CHECKS PASSED');
  cleanup();
  process.exit(0);
}

main().catch((e) => fail('unexpected error', e));
