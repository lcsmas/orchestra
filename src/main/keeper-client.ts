// App-side half of the detached session keeper (src/keeper/index.ts).
//
// The keeper is a tiny detached daemon that owns a structured session's
// `claude` subprocess and relays its stdio over a unix socket, so the session
// survives Orchestra quitting (spike: docs/spikes/keeper-findings.md). This
// module gives agent-sdk.ts a `spawnClaudeCodeProcess` implementation
// (`makeKeeperSpawn`) that transparently launches-or-attaches, plus the
// lifecycle helpers (install, probe, kill, orphan listing, quit gating).
//
// Key invariants:
// - The bridge handle's `kill()` is a NO-OP: the SDK's process-exit sweep
//   SIGTERMs every registered child handle at app quit, and surviving that
//   sweep IS the feature. Real termination authority lives in the keeper
//   (stdinEnd → EOF → SIGTERM → SIGKILL escalation), reached via the SDK's
//   graceful close (stdin end) or an explicit `killKeeper`.
// - On win32 the same sweep calls `stdin.end()` instead of `kill()`, so the
//   stdinEnd frame is gated on `setAppQuitting()` (set in before-quit).
// - The keeper runtime is COPIED OUT of the install dir to
//   $ORCHESTRA_HOME/bin/keeper.js so a live keeper never depends on the app
//   install (asar / AppImage FUSE mount) after quit.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable, type Readable } from 'node:stream';
import {
  createLineSplitter,
  encodeKeeperFrame,
  parseKeeperFrame,
  type KeeperClientFrame,
  type KeeperDaemonFrame,
} from '../shared/keeper-protocol';
import { isKeeperCmdline, isSameLiveProcess } from '../shared/resource-monitor';
import { parseProcStatLine } from '../shared/resources';
import { orchestraHome } from './platform';
import { APPIMAGE_PATH } from './app-image';
import { log } from './logger';

type KeeperExitListener = (code: number | null, signal: string | null) => void;
type KeeperErrorListener = (error: Error) => void;

/** Mirror of the SDK's SpawnedProcess interface (sdk.d.ts) — declared locally
 *  so this module doesn't import the ESM-only SDK. */
export interface KeeperSpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit' | 'error', listener: KeeperExitListener | KeeperErrorListener): void;
  once(event: 'exit' | 'error', listener: KeeperExitListener | KeeperErrorListener): void;
  off(event: 'exit' | 'error', listener: KeeperExitListener | KeeperErrorListener): void;
}

interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

let appQuitting = false;

/** Called from the app's before-quit hook: from here on, an SDK-initiated
 *  `stdin.end()` (the win32 exit sweep) must NOT reach the keeper as a
 *  stdinEnd frame — quit means detach, not shutdown. */
export function setAppQuitting(): void {
  appQuitting = true;
}

export function keeperDir(): string {
  return path.join(orchestraHome(), 'keepers');
}

/** Unix-socket path (named pipe on win32) for a workspace's keeper. POSIX
 *  sun_path is ~104 bytes — fall back to a hashed name when the home path is
 *  exotic enough to blow the budget. */
export function keeperSocketPath(wsId: string): string {
  if (process.platform === 'win32') {
    const h = crypto.createHash('sha256').update(`${orchestraHome()}:${wsId}`).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\orchestra-keeper-${h}`;
  }
  const full = path.join(keeperDir(), `${wsId}.sock`);
  if (full.length <= 100) return full;
  const h = crypto.createHash('sha256').update(wsId).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `okeeper-${h}.sock`);
}

function keeperPidPath(wsId: string): string {
  return path.join(keeperDir(), `${wsId}.pid`);
}

/** The pid file path a keeper for `wsId` is launched with (argv[3] of the daemon). */
export function keeperPidFilePath(wsId: string): string {
  return keeperPidPath(wsId);
}

function keeperLogPath(wsId: string): string {
  return path.join(keeperDir(), `${wsId}.log`);
}

/** Where the copied-out keeper bundle lives (same orchestra-owned bin dir the
 *  agent CLI shim uses — see cli-shim.ts agentCliBinDir). */
function installedKeeperPath(): string {
  return path.join(orchestraHome(), 'bin', 'keeper.js');
}

/**
 * Copy dist-electron/keeper.js out of the install dir. Idempotent + self-
 * updating (content compare). Best-effort: a failure only disables detach
 * survival, never GUI startup. Safe while keepers run — node reads the whole
 * file at startup, so overwriting doesn't touch live processes.
 */
export function installKeeper(): void {
  try {
    const src = path.join(__dirname, 'keeper.js');
    if (!fs.existsSync(src)) {
      log.warn(`keeper bundle missing at ${src} — detached sessions disabled`);
      return;
    }
    const dst = installedKeeperPath();
    const body = fs.readFileSync(src);
    try {
      if (fs.existsSync(dst) && fs.readFileSync(dst).equals(body)) return;
    } catch {
      /* unreadable → rewrite */
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body, { mode: 0o755 });
    log.info(`installed keeper runtime at ${dst}`);
  } catch (e) {
    log.warn('failed to install keeper runtime', e);
  }
}

/**
 * Pick the node runtime for the keeper. AppImage: prefer a PATH `node` (the
 * mount vanishes at quit; Claude Code users virtually always have node), else
 * fall back to the AppImage's own binary accepting lazy-unmount semantics.
 * Everything else: this very executable with ELECTRON_RUN_AS_NODE (stable on
 * disk, guaranteed node version).
 */
function resolveKeeperRuntime(): { cmd: string; env: NodeJS.ProcessEnv } {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (APPIMAGE_PATH) {
    const pathNode = findOnPath('node');
    if (pathNode) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      return { cmd: pathNode, env };
    }
    log.warn('AppImage without a PATH node — keeper rides the mount and may die at quit');
  }
  return { cmd: process.execPath, env: baseEnv };
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

function connectSock(sockPath: string, timeoutMs = 2000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error('keeper connect timeout'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(to);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}

/** One request/response exchange on a throwaway connection. */
async function oneShot(
  sockPath: string,
  frame: KeeperClientFrame,
  awaitReply: boolean,
): Promise<KeeperDaemonFrame | null> {
  const sock = await connectSock(sockPath);
  try {
    return await new Promise<KeeperDaemonFrame | null>((resolve, reject) => {
      const to = setTimeout(() => resolve(null), 2000);
      if (awaitReply) {
        sock.on(
          'data',
          createLineSplitter((line) => {
            const f = parseKeeperFrame(line);
            if (f) {
              clearTimeout(to);
              resolve(f as KeeperDaemonFrame);
            }
          }),
        );
      }
      sock.on('error', (e) => {
        clearTimeout(to);
        reject(e);
      });
      sock.write(encodeKeeperFrame(frame), () => {
        if (!awaitReply) {
          clearTimeout(to);
          resolve(null);
        }
      });
    });
  } finally {
    sock.destroy();
  }
}

/** Read-only liveness probe. Never disturbs an attached client (probe frame,
 *  not hello). Null → no live keeper. */
export interface KeeperProbe {
  running: boolean;
  pid?: number;
  /** False = the CLI never streamed turn activity — still in session INIT. A
   *  client death in that window wedges init (orphaned MCP handshake), so
   *  callers must NOT attach to such a CLI: kill it and spawn fresh.
   *  `undefined` = pre-field keeper daemon (treat as started — legacy). */
  everStarted?: boolean;
  turnInFlight?: boolean;
  /** True once the keeper has begun tearing its CLI down (stdinEnd/kill/linger
   *  escalation). The CLI is dying but may still read `running:true`; callers
   *  must NOT attach to it (audit D1) — kill + spawn fresh. `undefined` =
   *  pre-field keeper daemon (legacy: treat as not shutting down). */
  shuttingDown?: boolean;
}

export async function probeKeeper(wsId: string): Promise<KeeperProbe | null> {
  try {
    const reply = await oneShot(keeperSocketPath(wsId), { t: 'probe', wsId }, true);
    if (reply && reply.t === 'helloAck') {
      return {
        running: reply.running,
        pid: reply.pid,
        everStarted: reply.everStarted,
        turnInFlight: reply.turnInFlight,
        shuttingDown: reply.shuttingDown,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-workspace serialization (#202): connect-or-launch and kill for ONE wsId never interleave, so N
// concurrent starts can't each launch a daemon and a kill's file sweep can't clobber a successor.
// ---------------------------------------------------------------------------

const keeperOps = new Map<string, Promise<void>>();

/** Workspaces whose delete has begun: no keeper is launched or attached for them (a wake racing the
 *  delete — A3 review F4 — would otherwise orphan a keeper/CLI). Ids are unique, so never cleared. */
const deletedWorkspaces = new Set<string>();
export function forbidKeeperLaunch(wsId: string): void {
  deletedWorkspaces.add(wsId);
}

function serializeKeeperOp<T>(wsId: string, op: () => Promise<T>): Promise<T> {
  const prev = keeperOps.get(wsId) ?? Promise.resolve();
  const run = prev.then(op);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  keeperOps.set(wsId, tail);
  void tail.then(() => {
    if (keeperOps.get(wsId) === tail) keeperOps.delete(wsId);
  });
  return run;
}

/** argv of a live pid; null = unreadable. Linux /proc, macOS `ps`; win32 cannot → null. */
function readProcArgv(pid: number): string[] | null {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a.length > 0);
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
      return out.trim().split(/\s+/).filter((a) => a.length > 0);
    }
  } catch {
    /* gone / unreadable */
  }
  return null;
}

/** Identity of the process a pid file names, read NOW: 'keeper' (argv is this workspace's keeper),
 *  'other' (alive but not it — a reused pid), 'gone', 'unknown' (alive, argv unreadable → never signal). */
export function keeperPidState(pid: number, wsId: string): 'keeper' | 'other' | 'gone' | 'unknown' {
  if (!isAlive(pid)) return 'gone';
  const argv = readProcArgv(pid);
  if (!argv) return isAlive(pid) ? 'unknown' : 'gone';
  return isKeeperCmdline(argv, wsId) ? 'keeper' : 'other';
}

/** Identity-stamped descendants (pid + /proc start-time) of `rootPid`, read NOW; Linux only ([] elsewhere). */
function snapshotDescendants(rootPid: number): Array<{ pid: number; comm: string; startTicks: number }> {
  if (process.platform !== 'linux') return [];
  const byPpid = new Map<number, Array<{ pid: number; comm: string; startTicks: number }>>();
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const p = parseProcStatLine(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (p && p.startTicks !== undefined) {
        byPpid.set(p.ppid, [...(byPpid.get(p.ppid) ?? []), { pid: p.pid, comm: p.comm, startTicks: p.startTicks }]);
      }
    } catch {
      /* exited mid-scan */
    }
  }
  const out: Array<{ pid: number; comm: string; startTicks: number }> = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const c of byPpid.get(queue.shift() as number) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

/** Is `d` still the SAME live process (pid + start-time, not a zombie)? Identity decision = the shared pure fn. */
function descendantAlive(d: { pid: number; startTicks: number }): boolean {
  let text: string | null = null;
  try {
    text = fs.readFileSync(`/proc/${d.pid}/stat`, 'utf8');
  } catch {
    /* gone */
  }
  return isSameLiveProcess(d.startTicks, text);
}

/** The keeper's identity-stamped descendants, read NOW (before anything is killed). [] when there is no verified keeper. */
export function snapshotKeeperTree(wsId: string): Array<{ pid: number; comm: string; startTicks: number }> {
  const pid = readKeeperPidFile(wsId);
  return pid && keeperPidState(pid, wsId) === 'keeper' ? snapshotDescendants(pid) : [];
}

/** SIGKILL the still-same-identity members of a {@link snapshotKeeperTree} snapshot and wait for them to die. */
export async function killKeeperTree(
  wsId: string,
  tree: Array<{ pid: number; comm: string; startTicks: number }>,
  reason: string,
): Promise<void> {
  await killSurvivingDescendants(wsId, tree, reason);
}

/** SIGKILL snapshot members that are STILL the same process (pid + start-time) — the orphaned CLI/MCP a
 *  SIGKILLed (wedged) keeper leaves behind (ppid 1, no keeper root for anyone to reach it) — then wait
 *  (≤1 s) until they are gone, so `killKeeper` resolving means the CLI is dead too. Leaf-first. */
async function killSurvivingDescendants(
  wsId: string,
  tree: Array<{ pid: number; comm: string; startTicks: number }>,
  reason: string,
): Promise<void> {
  const signalled: typeof tree = [];
  for (const d of [...tree].reverse()) {
    if (!descendantAlive(d)) continue; // gone, recycled, or already dead
    log.warn(`keeper[${wsId}] killing orphaned descendant pid=${d.pid} (${d.comm}) of the killed keeper, reason=${reason}`);
    try {
      process.kill(d.pid, 'SIGKILL');
      signalled.push(d);
    } catch {
      /* gone */
    }
  }
  for (let i = 0; i < 20 && signalled.some(descendantAlive); i++) await new Promise((r) => setTimeout(r, 50));
}

function readKeeperPidFile(wsId: string): number | null {
  try {
    const pid = (JSON.parse(fs.readFileSync(keeperPidPath(wsId), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The pid-file keeper for `wsId` iff it is alive (the TRACKED keeper — the one holding the socket). */
export function readTrackedKeeperPid(wsId: string): number | null {
  const pid = readKeeperPidFile(wsId);
  return pid !== null && isAlive(pid) ? pid : null;
}

/** True when a live server accepts connections on the workspace's socket. */
function socketAnswers(sockPath: string): Promise<boolean> {
  return connectSock(sockPath, 500).then(
    (s) => {
      s.destroy();
      return true;
    },
    () => false,
  );
}

/** Takeover-claim leftovers of a crashed daemon: `<ws>.pid.claim` and its `.<pid>.tmp` / `.stale.<pid>` siblings are
 *  removed only when the pid they name is DEAD (a live daemon's claim is never touched) — review D7. */
function sweepDeadClaims(wsId: string): void {
  const prefix = `${wsId}.pid.claim`;
  let names: string[];
  try {
    names = fs.readdirSync(keeperDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (name !== prefix && !name.startsWith(`${prefix}.`)) continue;
    const full = path.join(keeperDir(), name);
    const m = /\.(?:stale\.)?(\d+)(?:\.tmp)?$/.exec(name.slice(prefix.length));
    let owner: number | null = m ? Number(m[1]) : null;
    if (name === prefix) {
      try {
        owner = Number(fs.readFileSync(full, 'utf8'));
      } catch {
        owner = null;
      }
    }
    if (!owner || !Number.isInteger(owner) || owner <= 0 || isAlive(owner)) continue; // unknown/live owner: leave it
    try {
      fs.unlinkSync(full);
    } catch {
      /* fine */
    }
  }
}

/** Remove keeper files that have NO live owner (#202): the pid file when its pid is gone or is not a
 *  keeper, the socket when nobody answers on it. A successor's live files are never touched. */
export async function sweepStaleKeeperFiles(wsId: string): Promise<void> {
  const pid = readKeeperPidFile(wsId);
  const state = pid === null ? 'gone' : keeperPidState(pid, wsId);
  const sockPath = keeperSocketPath(wsId);
  let sockLive = await socketAnswers(sockPath);
  // Owner provably gone yet the socket still answers = its fds are closing (a dying thread group): wait, bounded.
  for (let i = 0; i < 10 && sockLive && (state === 'gone' || state === 'other'); i++) {
    await new Promise((r) => setTimeout(r, 50));
    sockLive = await socketAnswers(sockPath);
  }
  const unlink = (p: string): void => {
    try {
      fs.unlinkSync(p);
    } catch {
      /* fine */
    }
  };
  if (state === 'gone' || state === 'other') unlink(keeperPidPath(wsId));
  if (!sockLive) unlink(sockPath);
  sweepDeadClaims(wsId);
}

/**
 * Terminate a workspace's keeper + CLI (explicit-stop path: sdkStop, delete,
 * clear, hibernate…). Socket kill frame first (hello claims the slot — fine,
 * we're killing); falls back to SIGTERM via the pid file — but ONLY to a pid whose argv is
 * verified, at signal time, to be this workspace's keeper (a stale pid file can name a reused
 * pid). Resolves only once the keeper PROCESS is actually gone (bounded wait) — callers that
 * respawn right after (the pending-prompt recovery, the facade's stale path) must not race a
 * dying keeper still holding the socket: that exact race bridged a fresh query onto a
 * SIGTERM'd child ("exited with code 143") in testing. Serialized per workspace.
 */
export function killKeeper(wsId: string, reason = 'explicit-stop'): Promise<void> {
  return serializeKeeperOp(wsId, () => killKeeperUnlocked(wsId, reason));
}

/** A HEALTHY kill (restart / clear / MCP refresh) never touches the agent's background jobs: the keeper's descendants
 *  are only swept when the keeper had to be SIGKILLed (wedged) — a delete sweeps its own snapshot (see workspaces.ts). */
async function killKeeperUnlocked(wsId: string, reason: string): Promise<void> {
  const sockPath = keeperSocketPath(wsId);
  const pid = readKeeperPidFile(wsId) ?? undefined;
  // Read the keeper's tree BEFORE any kill: a SIGKILLed keeper orphans its CLI to init and nothing can find it after.
  const tree = pid && keeperPidState(pid, wsId) === 'keeper' ? snapshotDescendants(pid) : [];
  let escalated = false;
  let signalled = false;
  try {
    const sock = await connectSock(sockPath);
    sock.write(encodeKeeperFrame({ t: 'hello', wsId }));
    sock.write(encodeKeeperFrame({ t: 'kill', signal: 'SIGTERM' }));
    signalled = true;
    log.info(`keeper[${wsId}] killing keeper (kill frame; pid=${pid ?? '?'}, reason=${reason})`);
    // The keeper answers a kill with an `exit` frame and only cleans up once its client disconnects — drop the
    // socket at once instead of idling out the 3 s bound below (was ~3 s per delete).
    sock.on(
      'data',
      createLineSplitter((line) => {
        const f = parseKeeperFrame(line);
        if (f && f.t === 'exit') sock.destroy();
      }),
    );
    await new Promise<void>((resolve) => {
      const to = setTimeout(() => resolve(), 3000);
      sock.once('close', () => {
        clearTimeout(to);
        resolve();
      });
    });
    sock.destroy();
  } catch {
    /* no socket — pid fallback below */
  }
  if (!signalled && pid && keeperPidState(pid, wsId) === 'keeper') {
    log.info(`keeper[${wsId}] killing keeper (SIGTERM via pid file; pid=${pid}, reason=${reason})`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Deterministic handoff: wait (bounded) for the process to actually die — while it still
  // verifies as OUR keeper (a recycled pid must neither be waited on nor SIGKILLed).
  if (pid) {
    const waiting = (): boolean => {
      const st = keeperPidState(pid, wsId);
      return st === 'keeper' || st === 'unknown';
    };
    for (let i = 0; i < 50 && waiting(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (keeperPidState(pid, wsId) === 'keeper') {
      log.warn(`keeper[${wsId}] SIGKILL pid=${pid} (still alive after SIGTERM grace, reason=${reason})`);
      escalated = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      // SIGKILL is asynchronous (a stopped process still has to be scheduled to die): resolve only once it is.
      for (let i = 0; i < 20 && waiting(); i++) await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (escalated) await killSurvivingDescendants(wsId, tree, reason);
  // Sweep stale artifacts so probes stop seeing ghosts — never a live successor's files.
  await sweepStaleKeeperFiles(wsId);
}

/** Workspace ids with a live keeper (pid alive). Prunes stale pid/sock files
 *  for dead ones as a side effect. Synchronous — used inside startup paths. */
export function listLiveKeepers(): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(keeperDir());
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.pid')) continue;
    const wsId = name.slice(0, -'.pid'.length);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(keeperDir(), name), 'utf8')) as { pid?: number };
      if (meta.pid && isAlive(meta.pid)) {
        out.push(wsId);
        continue;
      }
    } catch {
      /* unreadable → stale */
    }
    for (const p of [path.join(keeperDir(), name), keeperSocketPath(wsId), keeperLogPath(wsId)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* fine */
      }
    }
  }
  return out;
}

/** Every live keeper's workspace id AND keeper daemon pid — the ROOT of the
 *  keeper → CLI → MCP process tree. Used by the resource monitor (issue #198
 *  T8) to walk and, for an orphaned workspace, reap that tree. Read-only: unlike
 *  {@link listLiveKeepers} it does NOT prune stale files as a side effect, so the
 *  monitor's sampling never mutates keeper state. A pid that is not alive is
 *  skipped. */
export function listKeeperRoots(): Array<{ workspaceId: string; keeperPid: number }> {
  const out: Array<{ workspaceId: string; keeperPid: number }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(keeperDir());
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.pid')) continue;
    const wsId = name.slice(0, -'.pid'.length);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(keeperDir(), name), 'utf8')) as { pid?: number };
      if (meta.pid && isAlive(meta.pid)) out.push({ workspaceId: wsId, keeperPid: meta.pid });
    } catch {
      /* unreadable → skip (listLiveKeepers prunes it on its own pass) */
    }
  }
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The SpawnedProcess bridge
// ---------------------------------------------------------------------------

async function launchKeeperDaemon(wsId: string): Promise<net.Socket> {
  const sockPath = keeperSocketPath(wsId);
  const runtime = resolveKeeperRuntime();
  const script = installedKeeperPath();
  const target = fs.existsSync(script) ? script : path.join(__dirname, 'keeper.js');
  fs.mkdirSync(keeperDir(), { recursive: true });
  const child = spawn(runtime.cmd, [target, wsId, sockPath, keeperPidPath(wsId), keeperLogPath(wsId)], {
    detached: true,
    stdio: 'ignore',
    env: runtime.env,
  });
  child.unref();
  let lastErr: unknown = null;
  for (let i = 0; i < 50; i++) {
    try {
      return await connectSock(sockPath, 500);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`keeper failed to start for ${wsId}: ${String(lastErr)}`);
}

/**
 * Build the `spawnClaudeCodeProcess` implementation for a workspace. The
 * returned function is called SYNCHRONOUSLY by the SDK's query(); the
 * connect-or-launch dance happens behind the facade (stdin buffers until the
 * socket is ready, so the SDK's initialize request simply arrives late —
 * verified fine in the spike).
 *
 * `onAttached` fires (asynchronously) when the facade found a LIVE CLI and
 * attached to it instead of spawning — agent-sdk uses it for logging and to
 * skip fresh-session-only concerns.
 */
export function makeKeeperSpawn(
  wsId: string,
  onAttached?: (pid: number | undefined, turnInFlight: boolean) => void,
): (opts: SdkSpawnOptions) => KeeperSpawnedProcess {
  return (opts: SdkSpawnOptions): KeeperSpawnedProcess => {
    const ev = new EventEmitter();
    const stdout = new PassThrough();
    const sockPath = keeperSocketPath(wsId);
    let sock: net.Socket | null = null;
    let ready = false;
    let exited = false;
    const buffered: string[] = [];

    const push = (f: KeeperClientFrame): void => {
      const line = encodeKeeperFrame(f);
      if (ready && sock && !sock.destroyed) sock.write(line);
      else buffered.push(line);
    };

    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        push({ t: 'stdin', b64: Buffer.from(chunk).toString('base64') });
        cb();
      },
      final(cb) {
        // The SDK ends stdin both on graceful close (sdkStop → keeper should
        // shut the CLI down) and from its win32 exit sweep (quit → must NOT).
        if (!appQuitting) push({ t: 'stdinEnd' });
        cb();
      },
    });

    const handle: KeeperSpawnedProcess & { killed: boolean; exitCode: number | null } = {
      stdin,
      stdout,
      killed: false,
      exitCode: null,
      kill(signal: NodeJS.Signals): boolean {
        // Deliberate no-op — surviving the SDK's exit sweep IS the feature.
        // Real termination: keeper escalation via stdinEnd, or killKeeper().
        log.debug(`keeper[${wsId}] handle.kill(${signal}) ignored`);
        return true;
      },
      on: (e, l) => void ev.on(e, l),
      once: (e, l) => void ev.once(e, l),
      off: (e, l) => void ev.off(e, l),
    };

    // One persistent frame router per socket, installed BEFORE hello is sent —
    // an attached CLI can start streaming stdout the instant the claim lands,
    // and a listener gap would silently drop those frames (flowing-mode data
    // with no listener is lost, not buffered).
    type Ack = { running: boolean; pid?: number; everStarted?: boolean; turnInFlight?: boolean; shuttingDown?: boolean };
    let ackWaiter: { resolve: (a: Ack) => void; reject: (e: Error) => void } | null = null;
    const wireSocket = (s: net.Socket): void => {
      s.on(
        'data',
        createLineSplitter((line) => {
          const f = parseKeeperFrame(line);
          if (!f) return;
          if (f.t === 'helloAck') {
            ackWaiter?.resolve({
              running: f.running,
              pid: f.pid,
              everStarted: f.everStarted,
              turnInFlight: f.turnInFlight,
              shuttingDown: f.shuttingDown,
            });
            ackWaiter = null;
          } else if (f.t === 'stdout') {
            stdout.write(Buffer.from(f.b64, 'base64'));
          } else if (f.t === 'exit') {
            exited = true;
            handle.exitCode = f.code;
            stdout.end();
            ev.emit('exit', f.code, f.signal);
            // Drop the socket NOW: the keeper only cleans up (unlink sock/pid,
            // exit) once its client disconnects — holding the connection open
            // after the child died left a zombie keeper serving a dead slot
            // (caught by verify-keeper-detach.mjs's /clear phase).
            s.destroy();
          } else if (f.t === 'err') {
            const err = new Error(f.msg);
            if (ackWaiter) {
              ackWaiter.reject(err);
              ackWaiter = null;
            } else {
              ev.emit('error', err);
            }
          }
        }),
      );
      s.on('close', () => {
        if (s !== sock) return; // superseded socket (stale-keeper path)
        // Keeper vanished under a live session (crash / external kill). The
        // CLI is orphaned-or-dead; end the stream so consume() closes the
        // ledger, and let resume-by-id recover the conversation.
        if (!exited && !appQuitting) {
          exited = true;
          stdout.end();
          ev.emit('exit', -1, null);
        }
      });
      s.on('error', () => {
        /* close handler follows */
      });
    };
    const helloOn = (s: net.Socket): Promise<Ack> =>
      new Promise((resolve, reject) => {
        const to = setTimeout(() => {
          ackWaiter = null;
          reject(new Error('helloAck timeout'));
        }, 3000);
        ackWaiter = {
          resolve: (a) => {
            clearTimeout(to);
            resolve(a);
          },
          reject: (e) => {
            clearTimeout(to);
            reject(e);
          },
        };
        s.write(encodeKeeperFrame({ t: 'hello', wsId }));
      });

    void (async () => {
      try {
        // Serialized per workspace (#202): N concurrent starts run connect-or-launch ONE at a time,
        // so the 2nd..Nth see the 1st's keeper instead of each launching a daemon.
        await serializeKeeperOp(wsId, async () => {
          if (deletedWorkspaces.has(wsId)) throw new Error(`workspace ${wsId} was deleted — keeper start refused`);
          let attached = false;
          let attachedPid: number | undefined;
          let attachedTurnInFlight = false;
          try {
            sock = await connectSock(sockPath);
          } catch {
            sock = null;
          }
          if (sock) {
            wireSocket(sock);
            const ack = await helloOn(sock);
            // Attach only to a CLI that has genuinely RUN (everStarted) and is
            // NOT shutting down. A running-but-never-started CLI is init-wedged
            // (its init handshake died with a previous client) — sending into it
            // queues the message behind a ~60s timeout. A `shuttingDown` CLI is
            // mid-teardown (a graceful stop/kill/linger escalation in flight):
            // attaching to it (audit D1) writes the wake prompt into a `stdin`
            // frame the keeper rejects, then the CLI exits 0 with the prompt
            // lost, so treat it as stale too. `undefined` on either field
            // (pre-field keeper) keeps the legacy attach behavior.
            if (ack.running && ack.everStarted !== false && ack.shuttingDown !== true) {
              attached = true;
              attachedPid = ack.pid;
              attachedTurnInFlight = ack.turnInFlight === true;
            } else {
              // Stale keeper (child gone, never spawned by us, a
              // never-started/init-wedged CLI, or one already shutting down):
              // clear it out and start fresh — never reuse a dead-or-wedged or
              // dying child slot. killKeeper resolves only once the keeper
              // PROCESS is gone, so the fresh launch below can't race a dying
              // keeper still holding the socket path.
              const stale = sock;
              sock = null; // detach the router's close semantics first
              stale.destroy();
              await killKeeperUnlocked(wsId, 'stale-keeper');
            }
          }
          if (!sock) {
            sock = await launchKeeperDaemon(wsId);
            wireSocket(sock);
            await helloOn(sock);
            sock.write(
              encodeKeeperFrame({
                t: 'spawn',
                command: opts.command,
                args: opts.args,
                cwd: opts.cwd ?? process.cwd(),
                env: opts.env,
              }),
            );
          }
          ready = true;
          for (const line of buffered) sock.write(line);
          buffered.length = 0;
          if (attached) onAttached?.(attachedPid, attachedTurnInFlight);
        });
      } catch (e) {
        ev.emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    })();

    return handle;
  };
}
