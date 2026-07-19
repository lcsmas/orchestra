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

/** LD_LIBRARY_PATH additions for the rootless localdeps build. The binary links
 *  gtksourceview5 / webkit6 / vte / gstreamer from native/.localdeps/prefix
 *  (which has no system -devel), so those .so's must be findable at run time.
 *  Returns '' on a system-lib box (CI) where the prefix doesn't exist — there
 *  the system loader already resolves everything. Mirrors native/env.sh. */
export function localdepsLibPath() {
  const lib64 = path.join(REPO_ROOT, 'native', '.localdeps', 'prefix', 'usr', 'lib64');
  return fs.existsSync(lib64) ? lib64 : '';
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

  // Wait for sway to create a NEW wayland-N socket — and prove it's LIVE.
  // A crashed/killed compositor leaves its socket file behind, so "the file
  // appeared" is not enough: a stale socket refuses connections, and handing it
  // to the app yields a silent "Failed to open display" and a hung scenario.
  let waylandDisplay = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const fresh = waylandSockets(runtimeDir).filter((s) => !before.has(s));
    for (const cand of fresh) {
      if (await socketAccepts(path.join(runtimeDir, cand))) {
        waylandDisplay = cand;
        break;
      }
    }
    if (waylandDisplay) break;
    if (child.exitCode !== null) {
      throw new Error(`sway exited (${child.exitCode}) before creating a display:\n${swayLog.join('')}`);
    }
    await sleep(150);
  }
  if (!waylandDisplay) throw new Error(`headless sway never created a live wayland socket:\n${swayLog.join('')}`);

  const sockFile = path.join(runtimeDir, waylandDisplay);
  const handle = {
    waylandDisplay,
    runtimeDir,
    stop() {
      // Reap the compositor and remove its socket + lock, so a dead compositor
      // can't leave a stale display behind for the next run to pick up.
      killGroup(child);
      for (const f of [sockFile, `${sockFile}.lock`]) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
  registerCleanup(() => handle.stop());
  return handle;
}

/** True if something is actually listening on this unix socket (a stale socket
 *  file from a dead compositor refuses with ECONNREFUSED). */
function socketAccepts(sockPath) {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
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
  // Prepend the localdeps lib path so a rootless build finds its .so's
  // (gtksourceview5/webkit6/vte/gstreamer); no-op on a system-lib box.
  const ldExtra = localdepsLibPath();
  const ldPath = [ldExtra, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const child = spawn(bin, ['--remote-control', rcSock, ...args], {
    env: {
      ...process.env,
      WAYLAND_DISPLAY: sway.waylandDisplay,
      GDK_BACKEND: 'wayland',
      ...(ldPath ? { LD_LIBRARY_PATH: ldPath } : {}),
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
  registerCleanup(() => stopChild(child, rc));
  return {
    rc,
    logs,
    logText: () => logs.join(''),
    stop() {
      stopChild(child, rc);
    },
  };
}

/** Close the RC connection and reap the app's whole process group, escalating
 *  SIGTERM → SIGKILL. A GTK app that ignores SIGTERM (or dies mid-handshake)
 *  otherwise survives the run and leaks into the next one. */
function stopChild(child, rc) {
  try {
    rc.close();
  } catch {
    /* ignore */
  }
  killGroup(child);
}

/** SIGTERM a detached child's process group. Only ever targets `-child.pid`
 *  (its own group, created by `detached: true`) and NEVER a bare negative pid
 *  we didn't spawn — signalling the wrong group would take down the runner
 *  itself. Already-dead children raise ESRCH, which is fine. */
function killGroup(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

// Last-resort reaping: whatever a scenario forgot (or an exception skipped)
// still dies when the runner exits, so runs never accumulate stray compositors
// or app processes. Mirrors the atexit pattern the bash e2e scripts use.
const cleanups = new Set();
function registerCleanup(fn) {
  cleanups.add(fn);
}
let cleanupInstalled = false;
export function installExitCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const runAll = () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* best effort */
      }
    }
    cleanups.clear();
  };
  process.on('exit', runAll);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      runAll();
      process.exit(1);
    });
  }
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
