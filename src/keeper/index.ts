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
// - Plafond mémoire (#320, ADR 0005): a keeper the app launched inside its own systemd scope (`spawn` carries `memoryCap`) checks that the
//   scope's limit is really applied, watches `memory.events` to NAME each kill (memory-watch.ts), reports it (`memKill` frame, `helloAck`), and
//   points the CLI's CLAUDE_CODE_SHELL_PREFIX at the oom wrapper so tool commands — not the keeper or the CLI — are the kernel's preferred victims.
// - Docker relay (#291, ADR 0004): a `spawn` frame carrying `dockerRelay` makes this keeper host a unix-socket
//   Docker proxy that stamps `orchestra.ws`/`orchestra.run` on every container and point the CLI's DOCKER_HOST at
//   it. Absent ⇒ none of that code runs and the CLI env is exactly what the client sent.

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
  type KeeperClientFrame,
  type KeeperDaemonFrame,
} from '../shared/keeper-protocol.ts';
import { maxSocketPathBytes, relaySocketPath, relayUpstreamFile, resolveRelayUpstream } from '../shared/docker-relay.ts';
import { realUpstreamDeps } from '../shared/docker-endpoint.ts';
import { createDockerRelay, superviseDockerRelay, type DockerRelay, type RelaySupervisor } from './docker-relay.ts';
import { startMemoryWatch, type MemoryWatch } from './memory-watch.ts';
import { INNER_SHELL_PREFIX_ENV, formatMemKillLine, parseCgroupLimit, parseProcCgroupV2, wrapperPathUsable, type MemKillRecord } from '../shared/memory-scope.ts';

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

/** Identity of the socket file THIS keeper bound (null until listening). */
let ownedSock: { ino: number; ctimeMs: number } | null = null;

function readPidFileOwner(): number | null {
  try {
    const pid = (JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

/** Unlink sock/pid ONLY when they are ours (#202) — a sibling that took the
 *  paths over must not be orphaned by our exit. The pid file names the owner;
 *  the sock's (ino, ctime) is the fallback while no pid file exists. */
function unlinkOwnedFiles(): void {
  const owner = readPidFileOwner();
  let ownsSock = owner === process.pid;
  if (!ownsSock && owner === null && ownedSock) {
    try {
      const st = fs.statSync(sockPath);
      ownsSock = st.ino === ownedSock.ino && st.ctimeMs === ownedSock.ctimeMs;
    } catch {
      /* gone */
    }
  }
  if (ownsSock) {
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* already gone */
    }
  }
  if (owner === process.pid) {
    try {
      fs.unlinkSync(pidPath);
    } catch {
      /* already gone */
    }
  }
}

function cleanupAndExit(code: number): void {
  memWatch?.stop();
  relaySupervisor?.stop();
  if (relay) {
    relay.stop();
    try {
      fs.unlinkSync(relayUpstreamFile(sockPath));
    } catch {
      /* none */
    }
  }
  unlinkOwnedFiles();
  klog(`exit code=${code}`);
  process.exit(code);
}

/** `firstSignal` now → SIGKILL after `afterMs`. Idempotent-safe (guarded by
 *  `childExited`); the child's own 'exit' handler does cleanup. Shared by the
 *  graceful `stdinEnd` path and the hard `kill` frame so BOTH escalate to
 *  SIGKILL — a CLI that ignores SIGTERM must never be left alive (audit D5). */
function escalateKill(afterMs: number, firstSignal: 'SIGTERM' | 'SIGKILL'): void {
  if (!childExited) {
    klog(`escalate ${firstSignal}`);
    child?.kill(firstSignal);
  }
  if (firstSignal === 'SIGKILL') return;
  const kill = setTimeout(() => {
    if (!childExited) {
      klog('escalate SIGKILL');
      child?.kill('SIGKILL');
    }
  }, afterMs);
  kill.unref();
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
  const term = setTimeout(() => escalateKill(ESCALATE_KILL_MS, 'SIGTERM'), ESCALATE_TERM_MS);
  term.unref();
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

// ── Plafond mémoire (#320) ───────────────────────────────────────────────────────────────────────────────────────────

type CapInfo = NonNullable<Extract<KeeperDaemonFrame, { t: 'helloAck' }>['cap']>;
let capInfo: CapInfo | null = null;
let memWatch: MemoryWatch | null = null;
const memKills: MemKillRecord[] = [];
const CGROUP_ROOT = process.env.ORCHESTRA_CGROUP_ROOT || '/sys/fs/cgroup';
/** The kernel rounds a limit to its page size (16 KiB on Asahi): "applied" means within one 64 KiB page of what was asked. */
const LIMIT_SLACK_BYTES = 64 * 1024;

/** Verify the scope the launcher put us in, start the kill watch, and return the CLI env (with the tool wrapper when the limit is real). */
function setupMemoryCap(cap: NonNullable<Extract<KeeperClientFrame, { t: 'spawn' }>['memoryCap']>, env: Record<string, string | undefined>): Record<string, string | undefined> {
  let cgPath: string | null = null;
  try {
    cgPath = parseProcCgroupV2(fs.readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {
    /* no /proc */
  }
  if (!cgPath || path.basename(cgPath) !== cap.unit) {
    capInfo = { unit: cap.unit, state: 'no-scope', hardBytes: cap.hardBytes };
    klog(`memory cap: NOT in scope ${cap.unit} (cgroup ${cgPath ?? 'unreadable'}) — the keeper was launched plain; no cap, no watch`);
    return env;
  }
  const dir = path.join(CGROUP_ROOT, cgPath);
  let limit: number | null = null;
  try {
    limit = parseCgroupLimit(fs.readFileSync(path.join(dir, 'memory.max'), 'utf8'));
  } catch {
    /* unreadable */
  }
  const applied = limit !== null && limit <= cap.hardBytes && limit >= cap.hardBytes - LIMIT_SLACK_BYTES;
  if (!applied) {
    capInfo = { unit: cap.unit, state: 'not-applied', hardBytes: cap.hardBytes };
    klog(`memory cap: in scope ${cap.unit} but memory.max=${limit ?? 'max'} (asked ${cap.hardBytes}) — the limit is NOT applied (memory controller not delegated?); tools are not wrapped`);
    return env;
  }
  let wrapperOk = false;
  if (cap.wrapper && !wrapperPathUsable(cap.wrapper)) {
    klog(`memory cap: tool wrapper path ${JSON.stringify(cap.wrapper)} is not usable as CLAUDE_CODE_SHELL_PREFIX (relative or contains whitespace) — tool commands keep oom_score_adj 0`);
  } else if (cap.wrapper) {
    try {
      fs.accessSync(cap.wrapper, fs.constants.X_OK);
      wrapperOk = true;
    } catch {
      klog(`memory cap: tool wrapper ${cap.wrapper} is missing or not executable — tool commands keep oom_score_adj 0`);
    }
  }
  capInfo = { unit: cap.unit, state: wrapperOk ? 'active' : 'unprotected', hardBytes: cap.hardBytes };
  memWatch = startMemoryWatch({
    cgroupDir: dir,
    unit: cap.unit,
    log: klog,
    onKill: (rec) => {
      memKills.push(rec);
      if (memKills.length > 20) memKills.shift();
      klog(formatMemKillLine(wsId, rec));
      send({ t: 'memKill', rec });
    },
  });
  klog(`memory cap: ${capInfo.state.toUpperCase()} unit=${cap.unit} memory.max=${limit} cgroup=${dir}`);
  if (!wrapperOk || !cap.wrapper) return env;
  const out: Record<string, string | undefined> = { ...env, CLAUDE_CODE_SHELL_PREFIX: cap.wrapper };
  // The user's own prefix keeps working: our wrapper chains it exactly as the CLI would have called it.
  if (env.CLAUDE_CODE_SHELL_PREFIX && env.CLAUDE_CODE_SHELL_PREFIX !== cap.wrapper) out[INNER_SHELL_PREFIX_ENV] = env.CLAUDE_CODE_SHELL_PREFIX;
  return out;
}

// ── Docker relay (#291) ──────────────────────────────────────────────────────────────────────────────────────────

let relay: DockerRelay | null = null;
let relaySupervisor: RelaySupervisor | null = null;
/** True from a relay-carrying `spawn` frame until the CLI is started: frames that arrive meanwhile (the client
 *  buffers stdin right behind `spawn`) are held and replayed in order, never dropped. */
let spawnInFlight = false;
const deferredFrames: KeeperClientFrame[] = [];

/** Publish the resolved upstream beside the relay socket (tmp + rename): the app's Pause asks THIS file which daemon holds the member's attributed containers. Best effort. */
function publishUpstream(upstream: string): void {
  const file = relayUpstreamFile(sockPath);
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, upstream, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    klog(`docker relay: could not publish the upstream (${(e as Error).message})`);
  }
}

/** Start the relay and return the CLI env to use: the client's env + `DOCKER_HOST` at the relay — or the client's env
 *  UNTOUCHED when the relay cannot start (the member then uses the real socket; its containers count as unattributed). */
async function withDockerRelay(runId: string, env: Record<string, string | undefined>): Promise<Record<string, string | undefined>> {
  try {
    const up = await resolveRelayUpstream(env, realUpstreamDeps);
    if (!up.ok) {
      klog(`docker relay disabled: ${up.reason}`);
      return env;
    }
    const relaySock = relaySocketPath(sockPath);
    if (Buffer.byteLength(relaySock) > maxSocketPathBytes()) {
      klog(`docker relay disabled: socket path too long (${relaySock})`);
      return env;
    }
    const r = createDockerRelay({ sockPath: relaySock, upstream: up.socketPath, ws: wsId, run: runId, log: klog });
    if (!(await r.start())) {
      r.stop();
      klog('docker relay disabled: could not start');
      return env;
    }
    relay = r;
    relaySupervisor = superviseDockerRelay(r, { checkMs: intEnv('ORCHESTRA_KEEPER_RELAY_CHECK_MS', 1000), log: klog });
    // SIGUSR2 = "the relay crashed" (operator/rig kill switch); registered only now, so a keeper with no relay keeps
    // SIGUSR2's default action exactly as before.
    process.on('SIGUSR2', () => relay?.kill());
    klog(`docker relay listening ${relaySock} -> ${up.socketPath} (via ${up.via}) ws=${wsId} run=${runId}`);
    if (!up.daemonUp) klog(`docker relay: no daemon at ${up.socketPath} yet — calls answer 502 until it appears`);
    publishUpstream(up.socketPath);
    return { ...env, DOCKER_HOST: `unix://${relaySock}` };
  } catch (e) {
    klog(`docker relay disabled: ${(e as Error).message}`);
    return env;
  }
}

/** The frames that need the claimed client slot. `spawn` is the only one that can be asynchronous. */
function handleClientFrame(f: KeeperClientFrame): void {
  switch (f.t) {
    case 'spawn':
      if (child && !childExited) {
        send({ t: 'err', msg: 'already running' });
      } else if (childExited) {
        // Stale keeper (CLI already exited) — the client should kill us
        // and launch a fresh keeper; never reuse a dead child slot.
        send({ t: 'err', msg: 'stale keeper: child already exited' });
      } else if (f.dockerRelay) {
        spawnInFlight = true;
        const capEnv = f.memoryCap ? setupMemoryCap(f.memoryCap, f.env) : f.env;
        void withDockerRelay(f.dockerRelay.runId, capEnv).then((env) => {
          try {
            startChild(f.command, f.args, f.cwd, env);
          } finally {
            spawnInFlight = false;
            for (const d of deferredFrames.splice(0)) handleClientFrame(d);
          }
        });
      } else {
        startChild(f.command, f.args, f.cwd, f.memoryCap ? setupMemoryCap(f.memoryCap, f.env) : f.env);
      }
      break;
    case 'stdin':
      if (child && !childExited && !shuttingDown) {
        child.stdin?.write(Buffer.from(f.b64, 'base64'));
      } else if (shuttingDown) {
        // The CLI is dying; do NOT silently drop the frame (audit D1: a
        // client that attached to a shutting-down keeper would think its
        // wake prompt landed). Tell it so it can kill + respawn instead.
        send({ t: 'err', msg: 'shutting down' });
      }
      break;
    case 'stdinEnd':
      beginShutdown('stdinEnd from client');
      break;
    case 'kill': {
      const signal = f.signal ?? 'SIGTERM';
      klog(`kill frame signal=${signal}`);
      shuttingDown = true;
      if (child && !childExited) escalateKill(ESCALATE_KILL_MS, signal);
      else cleanupAndExit(0);
      break;
    }
  }
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
      // A dying CLI (stdinEnd/kill/linger escalation in flight) still reports
      // `running:true` until its 'exit' lands — surface the shutdown so an
      // attaching client refuses it (audit D1); else it writes into a dropped
      // `stdin` frame and the CLI exits 0 with the prompt lost.
      shuttingDown,
      ...(capInfo ? { cap: capInfo } : {}),
      ...(memKills.length ? { memKills: memKills.slice() } : {}),
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
      if (spawnInFlight) {
        deferredFrames.push(f as KeeperClientFrame);
        return;
      }
      handleClientFrame(f as KeeperClientFrame);
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

/** True when a LIVE keeper answers a probe on sockPath (#202). Stale socket
 *  files (ECONNREFUSED/ENOENT) read false; a connect that never answers reads
 *  true — fail closed rather than launch a second CLI. */
function liveKeeperServing(): Promise<boolean> {
  const attempt = (): Promise<'live' | 'stale'> =>
    new Promise((resolve) => {
      const s = net.connect(sockPath);
      const to = setTimeout(() => {
        s.destroy();
        resolve('live');
      }, 1500);
      s.once('connect', () => s.write(encodeKeeperFrame({ t: 'probe', wsId })));
      s.on('data', () => {
        clearTimeout(to);
        s.destroy();
        resolve('live');
      });
      s.once('error', () => {
        clearTimeout(to);
        resolve('stale');
      });
    });
  return (async () => {
    // A bind()→listen() gap on a racing daemon reads ECONNREFUSED briefly.
    for (let i = 0; i < 3; i++) {
      if ((await attempt()) === 'live') return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
}

function refuseAndExit(): never {
  klog('live keeper already serving this socket — refusing to start (files untouched)');
  process.exit(0);
}

function listenOnce(): Promise<'ok' | 'inuse'> {
  return new Promise((resolve) => {
    const onErr = (e: NodeJS.ErrnoException): void => {
      if (e.code === 'EADDRINUSE') return resolve('inuse');
      klog(`listen failed: ${e.message}`);
      process.exit(1);
    };
    server.once('error', onErr);
    server.listen(sockPath, () => {
      server.off('error', onErr);
      resolve('ok');
    });
  });
}

const claimPath = `${pidPath}.claim`;

/** Exclusive stale-socket takeover claim (L1): two daemons that both read a stale socket as "stale" must not both
 *  unlink+relisten. The claim is created ATOMICALLY WITH ITS CONTENT (write a tmp file, `link` it into place —
 *  EEXIST = held), so a contender never reads a half-written claim as a dead holder. A claim older than 5 s or held
 *  by a dead pid is broken; an unreadable one is only broken by age. */
async function claimTakeover(): Promise<boolean> {
  const tmp = `${claimPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, String(process.pid));
  } catch {
    return false;
  }
  try {
    for (let i = 0; i < 60; i++) {
      try {
        // The claim's age must count from ACQUISITION, not from when `tmp` was written (we may have waited seconds).
        const now = new Date();
        fs.utimesSync(tmp, now, now);
        fs.linkSync(tmp, claimPath);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
      breakStaleClaim();
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
}

/** Is the claim file at `p` stale — its holder pid dead, or older than 5 s? (An unreadable claim only by age.) */
function claimIsStale(p: string): boolean {
  try {
    const holder = Number(fs.readFileSync(p, 'utf8'));
    if (holder > 0) {
      try {
        process.kill(holder, 0);
      } catch {
        return true;
      }
    }
    return Date.now() - fs.statSync(p).mtimeMs > 5000;
  } catch {
    return false; // released or raced
  }
}

/** Break a stale claim by renaming it ASIDE (atomic: only one breaker gets the inode), then re-verify WHAT we moved —
 *  if it was a live claim a racing holder had just taken, link it back instead of destroying it. */
function breakStaleClaim(): void {
  if (!claimIsStale(claimPath)) return;
  const aside = `${claimPath}.stale.${process.pid}`;
  try {
    fs.renameSync(claimPath, aside);
  } catch {
    return; // someone else broke or released it first
  }
  try {
    if (!claimIsStale(aside)) {
      try {
        fs.linkSync(aside, claimPath); // not stale after all: give the live claim back
      } catch {
        /* path already re-taken */
      }
    }
  } finally {
    try {
      fs.unlinkSync(aside);
    } catch {
      /* gone */
    }
  }
}

function releaseClaim(): void {
  try {
    if (fs.readFileSync(claimPath, 'utf8') === String(process.pid)) fs.unlinkSync(claimPath);
  } catch {
    /* gone */
  }
}

void (async () => {
  // bind-first: EADDRINUSE is the atomic "somebody owns this path" signal.
  let r = await listenOnce();
  if (r === 'inuse') {
    if (await liveKeeperServing()) refuseAndExit();
    klog('socket looks stale — claiming the takeover');
    if (!(await claimTakeover())) refuseAndExit(); // fail closed: could not get exclusive rights
    klog('takeover claim acquired');
    try {
      // Re-probe UNDER the claim: the previous claimant may have finished binding.
      if (await liveKeeperServing()) {
        releaseClaim();
        refuseAndExit();
      }
      try {
        fs.unlinkSync(sockPath); // provably stale (nobody answers)
      } catch {
        /* raced */
      }
      r = await listenOnce();
      klog(`takeover listen → ${r}`);
    } finally {
      releaseClaim();
    }
    if (r === 'inuse') refuseAndExit();
  }
  try {
    const st = fs.statSync(sockPath);
    ownedSock = { ino: st.ino, ctimeMs: st.ctimeMs };
  } catch {
    /* win32 named pipe has no file */
  }
  const tmp = `${pidPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, wsId, startedAt: Date.now() }));
  fs.renameSync(tmp, pidPath);
  klog(`listening ${sockPath} pid=${process.pid}`);
})();
