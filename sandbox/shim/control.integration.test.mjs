/**
 * End-to-end integration test for the shim's cross-machine ownership lock
 * (P4 item C).
 *
 * Boots the real compiled shim (dist/shim.js) and attaches TWO real WS
 * clients — "desktop" and "laptop" — asserting the brokered behavior over the
 * actual wire:
 *
 *   1. first hello wins the drive; both sides receive control broadcasts with
 *      per-recipient isDriver
 *   2. both clients receive session data (observers watch live)
 *   3. an observer's write is dropped; the driver's write reaches the PTY
 *   4. takeControl flips ownership on both sides; write rights flip with it
 *   5. driver disconnect promotes the remaining identified client
 *
 * Run with: node sandbox/shim/control.integration.test.mjs   (needs
 * `npm install` + `npm run build` first). Exits 0 on success.
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder } from './dist/sandbox-protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(here, 'dist', 'shim.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ctl-it-'));
const PORT = 8797;

const log = (...a) => console.log('[it]', ...a);
let shim;
const sockets = [];

function fail(msg, err) {
  console.error('FAIL:', msg, err ?? '');
  cleanup();
  process.exit(1);
}

function cleanup() {
  for (const ws of sockets) {
    try { ws.close(); } catch {}
  }
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

/** A framed client: records every inbound frame, tracks the latest control. */
function connectClient(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  sockets.push(ws);
  const client = {
    label,
    ws,
    inbound: [],
    control: null,
    send: (frame) => ws.send(encodeFrame(frame)),
    dataFor: (session) =>
      client.inbound.filter((f) => f.t === 'data' && f.session === session).map((f) => f.data).join(''),
  };
  const decoder = new FrameDecoder();
  ws.on('message', (data) => {
    for (const f of decoder.push(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
      client.inbound.push(f);
      if (f.t === 'control') client.control = f;
    }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

async function main() {
  shim = spawn(process.execPath, [SHIM], {
    env: {
      ...process.env,
      ORCHESTRA_SHIM_PORT: String(PORT),
      ORCHESTRA_EVENTS_DIR: path.join(tmp, 'events'),
      ORCHESTRA_SOCK: path.join(tmp, 'hooks.sock'),
      ORCHESTRA_WORKSPACE_DIR: path.join(tmp, 'workspace'),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  shim.on('exit', (code) => {
    if (code !== null && code !== 0) fail(`shim exited early with ${code}`);
  });
  await waitFor(() => false, 400, 'shim boot grace').catch(() => {});

  // ── 1. first hello wins ────────────────────────────────────────────────────
  const desktop = await connectClient('desktop');
  desktop.send({ t: 'hello', clientId: 'machine-desktop', name: 'Desktop' });
  await waitFor(() => desktop.control?.isDriver === true, 3000, 'desktop becomes driver');

  const laptop = await connectClient('laptop');
  laptop.send({ t: 'hello', clientId: 'machine-laptop', name: 'Laptop' });
  await waitFor(
    () => laptop.control && laptop.control.isDriver === false && laptop.control.driverId === 'machine-desktop',
    3000,
    'laptop sees desktop driving',
  );
  log('✓ first hello wins the drive; broadcasts carry per-recipient isDriver');

  // ── 2. both clients watch the same session ────────────────────────────────
  const SESSION = 'ws-ctl-1';
  desktop.send({
    t: 'spawn',
    session: SESSION,
    command: 'bash',
    args: ['--noprofile', '--norc', '-i'],
    cwd: tmp,
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', PS1: 'P$ ' },
    cols: 80,
    rows: 24,
  });
  desktop.send({ t: 'write', session: SESSION, data: 'echo drv-$((20+22))\r' });
  await waitFor(() => desktop.dataFor(SESSION).includes('drv-42'), 5000, 'driver sees output');
  await waitFor(() => laptop.dataFor(SESSION).includes('drv-42'), 5000, 'observer sees output');
  log('✓ observers receive live session data');

  // ── 3. observer writes are dropped ────────────────────────────────────────
  laptop.send({ t: 'write', session: SESSION, data: 'echo obs-$((20+23))\r' });
  await waitFor(() => false, 600, 'grace').catch(() => {});
  assert.ok(!desktop.dataFor(SESSION).includes('obs-43'), 'observer write must not reach the PTY');
  log('✓ observer write dropped');

  // ── 4. explicit take-over flips ownership and write rights ───────────────
  laptop.send({ t: 'takeControl' });
  await waitFor(() => laptop.control?.isDriver === true, 3000, 'laptop takes the drive');
  await waitFor(
    () => desktop.control?.isDriver === false && desktop.control?.driverId === 'machine-laptop',
    3000,
    'desktop demoted',
  );
  laptop.send({ t: 'write', session: SESSION, data: 'echo new-$((40+4))\r' });
  await waitFor(() => laptop.dataFor(SESSION).includes('new-44'), 5000, 'new driver writes');
  desktop.send({ t: 'write', session: SESSION, data: 'echo old-$((40+5))\r' });
  await waitFor(() => false, 600, 'grace').catch(() => {});
  assert.ok(!laptop.dataFor(SESSION).includes('old-45'), 'demoted driver write must be dropped');
  log('✓ takeControl flips ownership and write rights');

  // ── 5. driver disconnect promotes the survivor ────────────────────────────
  laptop.ws.close();
  await waitFor(
    () => desktop.control?.isDriver === true && desktop.control?.driverId === 'machine-desktop',
    3000,
    'desktop promoted after driver detach',
  );
  desktop.send({ t: 'write', session: SESSION, data: 'echo back-$((40+6))\r' });
  await waitFor(() => desktop.dataFor(SESSION).includes('back-46'), 5000, 'promoted driver writes');
  log('✓ driver disconnect promotes the remaining identified client');

  desktop.send({ t: 'kill', session: SESSION });
  log('ALL CONTROL INTEGRATION CHECKS PASSED');
  cleanup();
  process.exit(0);
}

main().catch((e) => fail('unexpected error', e));
