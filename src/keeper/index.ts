// orchestra-keeper — detached per-workspace session host.
// (No shebang here — the vite banner adds it to the built bundle.)
//
// Owns a `claude` CLI subprocess and relays its stream-json stdio over a unix
// socket (named pipe on win32) so the structured SDK session survives Orchestra
// quitting: app quit just drops the socket (detach) and the turn keeps running;
// relaunch reconnects and the SDK re-initializes against the live CLI (proven
// in docs/spikes/keeper-findings.md). Spawned by src/main/keeper-client.ts with
//
//   node keeper.js <wsId> <sockPath> <pidPath> <logPath>
//
// detached + unref'd, stdio ignored. Policy knobs via env:
// ORCHESTRA_KEEPER_LINGER_MS / ORCHESTRA_KEEPER_WEDGE_MS.
//
// Design rules (see docs/codebase-map/session-keeper.md):
// - ONE client at a time; a new connection preempts the old (a stale client
//   that never closed cleanly must not brick reattach).
// - Child stdout is ALWAYS drained; discarded while detached (the CLI's own
//   on-disk transcript is the catch-up story — no ring buffer).
// - Only `stdinEnd`/`kill` frames terminate the child. A bare socket drop is a
//   detach. Termination escalates EOF → SIGTERM → SIGKILL on the keeper's own
//   clock, which is what lets the app-side bridge no-op its `kill()`.
// - Shutdown policy (linger after turn end / wedge backstop) lives in the pure
//   shared state machine; the daemon just feeds it events and polls it.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createLineSplitter,
  encodeKeeperFrame,
  parseKeeperFrame,
  createKeeperState,
  DEFAULT_KEEPER_POLICY,
  type KeeperDaemonFrame,
} from '../shared/keeper-protocol.ts';

const [, , wsId, sockPath, pidPath, logPath] = process.argv;
if (!wsId || !sockPath || !pidPath || !logPath) {
  process.stderr.write('usage: keeper.js <wsId> <sockPath> <pidPath> <logPath>\n');
  process.exit(2);
}

const policy = {
  lingerMs: intEnv('ORCHESTRA_KEEPER_LINGER_MS', DEFAULT_KEEPER_POLICY.lingerMs),
  wedgeMs: intEnv('ORCHESTRA_KEEPER_WEDGE_MS', DEFAULT_KEEPER_POLICY.wedgeMs),
  initGraceMs: intEnv('ORCHESTRA_KEEPER_INIT_GRACE_MS', DEFAULT_KEEPER_POLICY.initGraceMs),
};
const LOG_CAP_BYTES = 4 * 1024 * 1024;
const TICK_MS = intEnv('ORCHESTRA_KEEPER_TICK_MS', 30_000);
const ESCALATE_TERM_MS = 10_000;
const ESCALATE_KILL_MS = 5_000;

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function klog(msg: string): void {
  try {
    // Cheap cap: rotate once to .old when oversized (keeper logs are tiny
    // unless the CLI floods stderr; the cap bounds the flood case).
    try {
      if (fs.statSync(logPath).size > LOG_CAP_BYTES) fs.renameSync(logPath, logPath + '.old');
    } catch {
      /* stat on missing file */
    }
    fs.appendFileSync(logPath, `[keeper ${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging must never kill the keeper */
  }
}

let child: ChildProcess | null = null;
let childExited = false;
let client: net.Socket | null = null;
let shuttingDown = false;
const state = createKeeperState(policy, Date.now());

function send(frame: KeeperDaemonFrame): void {
  if (client && !client.destroyed) client.write(encodeKeeperFrame(frame));
}

function cleanupAndExit(code: number): void {
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(pidPath);
  } catch {
    /* already gone */
  }
  klog(`exit code=${code}`);
  process.exit(code);
}

/** EOF → SIGTERM → SIGKILL. Idempotent; the child's 'exit' handler finishes. */
function beginShutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  klog(`shutdown: ${reason}`);
  if (!child || childExited) {
    cleanupAndExit(0);
    return;
  }
  try {
    child.stdin?.end();
  } catch {
    /* broken pipe */
  }
  const term = setTimeout(() => {
    if (!childExited) {
      klog('escalate SIGTERM');
      child?.kill('SIGTERM');
    }
  }, ESCALATE_TERM_MS);
  const kill = setTimeout(() => {
    if (!childExited) {
      klog('escalate SIGKILL');
      child?.kill('SIGKILL');
    }
  }, ESCALATE_KILL_MS + ESCALATE_TERM_MS);
  term.unref();
  kill.unref();
}

function startChild(command: string, args: string[], cwd: string, env: Record<string, string | undefined>): void {
  klog(`spawn ${command} cwd=${cwd}`);
  child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  state.onSpawn(Date.now());

  const splitStdout = createLineSplitter((line) => state.onStdoutLine(line, Date.now()));
  child.stdout?.on('data', (d: Buffer) => {
    // Always drain; forward only when attached. Line-split a copy for the
    // policy state machine regardless (turn detection must work detached).
    splitStdout(d);
    send({ t: 'stdout', b64: d.toString('base64') });
  });
  child.stderr?.on('data', (d: Buffer) => {
    try {
      fs.appendFileSync(logPath, d);
    } catch {
      /* ignore */
    }
  });
  child.on('exit', (code, signal) => {
    klog(`child exit code=${code} signal=${signal}`);
    childExited = true;
    if (client && !client.destroyed) {
      send({ t: 'exit', code, signal: signal ?? null });
      // Let the client observe the exit; cleanup happens when it disconnects.
    } else {
      cleanupAndExit(0);
    }
  });
  child.on('error', (e) => {
    klog(`child error: ${e.message}`);
    send({ t: 'err', msg: e.message });
    if (!child?.pid) {
      // spawn itself failed — nothing will ever exit; report and die.
      childExited = true;
      send({ t: 'exit', code: 127, signal: null });
      if (!client || client.destroyed) cleanupAndExit(1);
    }
  });
}

const server = net.createServer((sock) => {
  // A connection is anonymous until it sends `hello` (claim) — a `probe` gets
  // its answer and goes away without disturbing the attached client.
  const reply = (frame: KeeperDaemonFrame): void => {
    if (!sock.destroyed) sock.write(encodeKeeperFrame(frame));
  };
  const ack = (): KeeperDaemonFrame => {
    const snap = state.snapshot();
    return {
      t: 'helloAck',
      wsId,
      running: !!child && !childExited,
      pid: child?.pid,
      everStarted: snap.everStarted,
      turnInFlight: snap.everStarted && !snap.turnComplete,
    };
  };

  sock.on(
    'data',
    createLineSplitter((line) => {
      const f = parseKeeperFrame(line);
      if (!f) return;
      switch (f.t) {
        case 'probe':
          reply(ack());
          return;
        case 'hello':
          if (f.wsId !== wsId) {
            reply({ t: 'err', msg: `wsId mismatch: keeper owns ${wsId}` });
            sock.destroy();
            return;
          }
          if (client && !client.destroyed && client !== sock) {
            klog('preempting previous client');
            client.destroy();
          }
          client = sock;
          state.onAttach();
          klog('client attached');
          reply(ack());
          return;
        default:
          break;
      }
      // Everything below requires the claimed client slot.
      if (sock !== client) return;
      switch (f.t) {
        case 'spawn':
          if (child && !childExited) {
            send({ t: 'err', msg: 'already running' });
          } else if (childExited) {
            // Stale keeper (CLI already exited) — the client should kill us
            // and launch a fresh keeper; never reuse a dead child slot.
            send({ t: 'err', msg: 'stale keeper: child already exited' });
          } else {
            startChild(f.command, f.args, f.cwd, f.env);
          }
          break;
        case 'stdin':
          if (child && !childExited && !shuttingDown) {
            child.stdin?.write(Buffer.from(f.b64, 'base64'));
          }
          break;
        case 'stdinEnd':
          beginShutdown('stdinEnd from client');
          break;
        case 'kill':
          klog(`kill frame signal=${f.signal ?? 'SIGTERM'}`);
          shuttingDown = true;
          if (child && !childExited) child.kill(f.signal ?? 'SIGTERM');
          else cleanupAndExit(0);
          break;
      }
    })
  );
  sock.on('close', () => {
    if (client === sock) {
      client = null;
      state.onDetach(Date.now());
      klog(`client detached; child ${child && !childExited ? 'running' : 'gone'}`);
      // NOTE: even when shuttingDown, wait for the child's 'exit' before
      // cleanup — exiting early would orphan the CLI mid-escalation.
      if (childExited || !child) cleanupAndExit(0);
    }
  });
  sock.on('error', () => {
    /* close handler does the work */
  });
});

// Poll the shutdown policy on a coarse clock (unref'd so it never holds the
// process open once the server/child are gone).
setInterval(() => {
  if (!shuttingDown && state.shouldShutdown(Date.now())) {
    const snap = state.snapshot();
    beginShutdown(
      !snap.everStarted ? 'init grace (session never started)' : snap.turnComplete ? 'linger expired' : 'wedge backstop',
    );
  }
}, TICK_MS).unref();

process.on('SIGTERM', () => {
  klog('SIGTERM');
  if (child && !childExited) child.kill('SIGTERM');
  cleanupAndExit(0);
});
// A keeper must never die from an EPIPE/socket hiccup while a turn runs.
process.on('uncaughtException', (e) => klog(`uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => klog(`unhandled rejection: ${String(e)}`));

fs.mkdirSync(path.dirname(sockPath), { recursive: true });
try {
  fs.unlinkSync(sockPath);
} catch {
  /* no stale socket */
}
server.listen(sockPath, () => {
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, wsId, startedAt: Date.now() }));
  klog(`listening ${sockPath} pid=${process.pid}`);
});
