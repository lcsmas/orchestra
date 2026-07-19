// Shared E2E harness for the native GTK app (plan §8.5/§8.6).
//
// Drives a REAL orchestra-gtk binary through its --remote-control debug socket
// (src/remote_control.rs) inside a headless sway compositor — the same recipe
// the repo's `verify` skill uses for the Electron app, adapted for GTK4:
// GDK_BACKEND=wayland on a private WAYLAND_DISPLAY, so windows realize and the
// harness's offscreen GSK screenshots work without touching a real desktop.
//
// Everything is dependency-free Node (net/child_process/fs) so `node
// native/e2e/run.mjs` runs it with no install step.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const GTK_BIN = path.join(REPO_ROOT, 'native', 'target', 'release', 'orchestra-gtk');
export const GTK_BIN_DEBUG = path.join(REPO_ROOT, 'native', 'target', 'debug', 'orchestra-gtk');

/** Resolve the orchestra-gtk binary, preferring release, then debug. */
export function resolveGtkBin() {
  if (fs.existsSync(GTK_BIN)) return GTK_BIN;
  if (fs.existsSync(GTK_BIN_DEBUG)) return GTK_BIN_DEBUG;
  throw new Error(
    `orchestra-gtk binary not found (looked in target/release and target/debug).\n` +
      `Build it first: (cd native && cargo build -p orchestra-gtk)`,
  );
}

let tmpCounter = 0;
export function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-e2e-${prefix}-${process.pid}-${tmpCounter++}-`));
  return dir;
}

/** Launch a private headless sway and return { waylandDisplay, stop() }.
 *  Resolves once the app-facing WAYLAND_DISPLAY socket exists. */
export async function startHeadlessSway() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const before = new Set(waylandSockets(runtimeDir));
  const swaySock = path.join(mkTmp('sway'), 'sway.sock');
  const cfg = path.join(path.dirname(swaySock), 'sway.conf');
  fs.writeFileSync(cfg, 'output HEADLESS-1 resolution 1600x1000\n');

  const child = spawn('sway', ['-c', cfg], {
    env: {
      ...process.env,
      WLR_BACKENDS: 'headless',
      WLR_LIBINPUT_NO_DEVICES: '1',
      WAYLAND_DISPLAY: '',
      SWAYSOCK: swaySock,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const swayLog = [];
  child.stdout.on('data', (d) => swayLog.push(d.toString()));
  child.stderr.on('data', (d) => swayLog.push(d.toString()));

  // Wait for sway to create a NEW wayland-N socket.
  let waylandDisplay = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const now = waylandSockets(runtimeDir).filter((s) => !before.has(s));
    if (now.length) {
      waylandDisplay = now[0];
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`sway exited (${child.exitCode}) before creating a display:\n${swayLog.join('')}`);
    }
    await sleep(150);
  }
  if (!waylandDisplay) throw new Error(`headless sway never created a wayland socket:\n${swayLog.join('')}`);

  return {
    waylandDisplay,
    runtimeDir,
    stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

function waylandSockets(runtimeDir) {
  try {
    return fs
      .readdirSync(runtimeDir)
      .filter((f) => /^wayland-\d+$/.test(f))
      .map((f) => f);
  } catch {
    return [];
  }
}

/** Launch orchestra-gtk under the given sway display with a remote-control
 *  socket, and return a connected RemoteControl plus a stop(). `env` is merged
 *  over the process env (set ORCHESTRA_HOME, ORCHESTRA_UI_SOCK, etc. here). */
export async function launchGtk({ sway, env = {}, args = [], label = 'gtk' }) {
  const bin = resolveGtkBin();
  const rcSock = path.join(mkTmp(`${label}-rc`), 'rc.sock');
  const logs = [];
  const child = spawn(bin, ['--remote-control', rcSock, ...args], {
    env: {
      ...process.env,
      WAYLAND_DISPLAY: sway.waylandDisplay,
      GDK_BACKEND: 'wayland',
      // Never DBus-activate a sibling; every run is its own process.
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  // Wait for the remote-control socket to appear (window realized).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(rcSock)) break;
    if (child.exitCode !== null) {
      throw new Error(`${label} exited (${child.exitCode}) before opening its RC socket:\n${logs.join('')}`);
    }
    await sleep(150);
  }
  if (!fs.existsSync(rcSock)) {
    throw new Error(`${label} never opened its RC socket:\n${logs.join('')}`);
  }

  const rc = await RemoteControl.connect(rcSock);
  return {
    rc,
    logs,
    logText: () => logs.join(''),
    stop() {
      rc.close();
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

/** Newline-JSON client for src/remote_control.rs. One response line per op. */
export class RemoteControl {
  constructor(sock) {
    this.sock = sock;
    this.buf = '';
    this.queue = [];
    this.waiters = [];
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(JSON.parse(line));
        else this.queue.push(JSON.parse(line));
      }
    });
  }

  static connect(sockPath) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(sockPath);
      sock.once('connect', () => resolve(new RemoteControl(sock)));
      sock.once('error', reject);
    });
  }

  send(op) {
    return new Promise((resolve) => {
      const queued = this.queue.shift();
      if (queued) return resolve(queued);
      this.waiters.push(resolve);
      this.sock.write(JSON.stringify(op) + '\n');
    });
  }

  listWidgets() {
    return this.send({ op: 'list_widgets' });
  }
  click(name) {
    return this.send({ op: 'click', name });
  }
  type(text, name) {
    return this.send(name ? { op: 'type', text, name } : { op: 'type', text });
  }
  key(name) {
    return this.send({ op: 'key', name });
  }
  get(name, prop) {
    return this.send({ op: 'get', name, prop });
  }
  screenshot(pathOut, name) {
    return this.send(name ? { op: 'screenshot', path: pathOut, name } : { op: 'screenshot', path: pathOut });
  }

  close() {
    try {
      this.sock.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** Poll `fn` until it returns truthy or `timeoutMs` elapses. Returns the value
 *  or throws with `desc`. */
export async function waitFor(fn, { timeoutMs = 8000, intervalMs = 150, desc = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${desc} (last value: ${JSON.stringify(last)})`);
}

export { sleep };
