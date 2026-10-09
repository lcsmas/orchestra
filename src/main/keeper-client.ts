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
import { relayHoldFile, relaySocketPath, relayUpstreamFile, type DockerRelaySpec } from '../shared/docker-relay';
import {
  OOM_TOOL_WRAPPER_FILE,
  OOM_TOOL_WRAPPER_SCRIPT,
  buildScopeLaunchArgv,
  launcherExecedKeeper,
  describeCapState,
  formatMemKillLine,
  formatMemSoftLine,
  isSoftRecord,
  wrapperPathUsable,
  type MemKillRecord,
  type MemNoticeRecord,
  type MemSoftRecord,
  type MemoryCapLaunch,
} from '../shared/memory-scope';
import { pruneVerdict, readMemNoticesChecked } from '../shared/mem-notice-file';
import { parseProcIdentity } from '../shared/resources';
import { orchestraHome } from './platform';
import { createMemKillCursor, type MemKillCursor } from './memkill-cursor';
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

/** The keeper's Docker relay socket (#291) — beside the keeper's own, derived from it. */
export function keeperRelaySocketPath(wsId: string): string {
  return relaySocketPath(keeperSocketPath(wsId));
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

/** #322 m1: where the keeper appends every kill / warning-level record BEFORE it tells anyone (survives the keeper — `listLiveKeepers`' stale-file prune never touches it). */
export function memNoticeFilePath(wsId: string): string {
  return path.join(keeperDir(), `${wsId}.memnotices.jsonl`);
}

/** Where the copied-out keeper bundle lives (same orchestra-owned bin dir the
 *  agent CLI shim uses — see cli-shim.ts agentCliBinDir). */
function installedKeeperPath(): string {
  return path.join(orchestraHome(), 'bin', 'keeper.js');
}

/** Where the Plafond mémoire tool wrapper lives (#320) — beside keeper.js, so a live keeper never depends on the install dir either. */
export function oomWrapperPath(): string {
  return path.join(orchestraHome(), 'bin', OOM_TOOL_WRAPPER_FILE);
}

/** Install the CLAUDE_CODE_SHELL_PREFIX target (idempotent, content-compared). Best-effort: without it a capped keeper still caps,
 *  but its tool commands are not the kernel's preferred victims (the keeper reports `unprotected`). */
function installOomWrapper(): void {
  try {
    const dst = oomWrapperPath();
    try {
      if (fs.readFileSync(dst, 'utf8') === OOM_TOOL_WRAPPER_SCRIPT && (fs.statSync(dst).mode & 0o111) !== 0) return;
    } catch {
      /* absent → write */
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, OOM_TOOL_WRAPPER_SCRIPT, { mode: 0o755 });
    fs.renameSync(tmp, dst); // atomic: a CLI exec'ing the wrapper never sees a torn file
  } catch (e) {
    log.warn('failed to install the memory-cap tool wrapper', e);
  }
}

// ── Plafond mémoire kills (#320) ─────────────────────────────────────────────────────────────────────────────────

export type MemoryKillListener = (wsId: string, rec: MemKillRecord) => void;
const memKillListeners: MemoryKillListener[] = [];
/** Which kills this app already delivered, per scope unit — PERSISTED (keepers/memkill-cursor.json): an app restart must not replay the keeper's last 20 records as new. */
let memKillCursor: MemKillCursor | null = null;
const cursor = (): MemKillCursor => (memKillCursor ??= createMemKillCursor(path.join(keeperDir(), 'memkill-cursor.json'), (m) => log.warn(m)));

/** Subscribe to kills by the Plafond mémoire (#322 builds the member notice + the coordinator's bus message on this). The app-log line is written
 *  here, once per record, whatever the listeners do. Returns the unsubscribe. */
export function onMemoryKill(fn: MemoryKillListener): () => void {
  memKillListeners.push(fn);
  return () => {
    const i = memKillListeners.indexOf(fn);
    if (i >= 0) memKillListeners.splice(i, 1);
  };
}

export type MemorySoftListener = (wsId: string, rec: MemSoftRecord) => void;
const memSoftListeners: MemorySoftListener[] = [];
/** Subscribe to warning-level crossings (#322, ledger D-Q2): the soft level is a keeper-watched threshold, never a kernel limit — nothing was killed or slowed. Returns the unsubscribe. */
export function onMemorySoft(fn: MemorySoftListener): () => void {
  memSoftListeners.push(fn);
  return () => {
    const i = memSoftListeners.indexOf(fn);
    if (i >= 0) memSoftListeners.splice(i, 1);
  };
}

/** A listener that throws (the bus is down) leaves the record UNDELIVERED (cursor not marked) so the next drain retries it, every {@link RETRY_DRAIN_MS} — ~10 min of outage, then it is dropped with a log line
 *  (a listener that ALWAYS throws is a bug, not an outage). */
const MAX_DELIVERY_ATTEMPTS = 20;
const RETRY_DRAIN_MS = 30_000;
const deliveryAttempts = new Map<string, number>();
/** Units whose earliest undelivered record failed: later records wait for the in-order drain (the cursor is a HIGH-WATER mark — marking seq 5 would silently drop a failed seq 4). */
const stalledUnits = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Records whose delivery failed and that may exist ONLY in memory (the keeper could not write its notice file): the next drain retries them too (review F3). Keyed `${unit}:${seq}`. */
const owedRecords = new Map<string, { wsId: string; rec: MemNoticeRecord }>();

function scheduleMemDrain(wsId: string): void {
  if (retryTimers.has(wsId)) return;
  const t = setTimeout(() => {
    retryTimers.delete(wsId);
    drainMemNotices(wsId);
  }, RETRY_DRAIN_MS);
  t.unref?.();
  retryTimers.set(wsId, t);
}

/** Deliver a record once per scope unit across app restarts (a push frame, a helloAck catch-up and the notice file can all carry the same one). At-least-once: the cursor is written after the listeners ran.
 *  Returns false when the record is still owed (a listener failed, or an earlier record of its unit did). */
function deliverMemRecord(wsId: string, rec: MemNoticeRecord, fromDrain = false): boolean {
  if (rec.seq <= cursor().seen(rec.unit)) return true;
  if (!fromDrain && stalledUnits.has(rec.unit)) return false;
  const key = `${rec.unit}:${rec.seq}`;
  const attempt = (deliveryAttempts.get(key) ?? 0) + 1;
  let ok = true;
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      ok = false;
      log.warn(`memory-cap[${wsId}]: ${isSoftRecord(rec) ? 'warning' : 'kill'} listener failed (attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS})`, e);
    }
  };
  if (isSoftRecord(rec)) {
    if (attempt === 1) log.warn(formatMemSoftLine(wsId, rec));
    for (const fn of [...memSoftListeners]) guard(() => fn(wsId, rec));
  } else {
    if (attempt === 1) log.warn(formatMemKillLine(wsId, rec));
    for (const fn of [...memKillListeners]) guard(() => fn(wsId, rec));
  }
  if (!ok && attempt < MAX_DELIVERY_ATTEMPTS) {
    deliveryAttempts.set(key, attempt);
    owedRecords.set(key, { wsId, rec });
    stalledUnits.add(rec.unit);
    scheduleMemDrain(wsId);
    return false;
  }
  if (!ok) {
    log.warn(`memory-cap[${wsId}]: giving up on ${key} after ${MAX_DELIVERY_ATTEMPTS} attempts`);
    stalledUnits.delete(rec.unit); // a record we gave up on must not hold its unit's later records for ever
  }
  owedRecords.delete(key);
  deliveryAttempts.delete(key);
  cursor().mark(rec.unit, rec.seq);
  return true;
}

/** #322 m1: deliver what the keeper recorded in its notice file and the app has not seen — whether the keeper is still alive, was reattached, or is gone. One report per record (the persisted cursor).
 *  Called at app start, at every attach, when the keeper's connection ends, and by the retry timer. Prunes the file once everything in it is delivered and no live keeper owns it. */
export function drainMemNotices(wsId: string): void {
  const file = memNoticeFilePath(wsId);
  const deliver = (recs: MemNoticeRecord[]): void => {
    const byUnit = new Map<string, MemNoticeRecord[]>();
    for (const r of recs) (byUnit.get(r.unit) ?? byUnit.set(r.unit, []).get(r.unit)!).push(r);
    for (const [unit, list] of byUnit) {
      stalledUnits.delete(unit);
      list.sort((a, b) => a.seq - b.seq);
      for (const r of list) if (!deliverMemRecord(wsId, r, true)) break;
    }
  };
  const first = readMemNoticesChecked(file);
  if (!first.ok) log.warn(`memory-cap[${wsId}]: cannot read ${file} (${first.error}) — left in place, nothing is deleted on an unknown`);
  const owed = [...owedRecords.values()].filter((o) => o.wsId === wsId).map((o) => o.rec);
  const merged = new Map<string, MemNoticeRecord>();
  for (const r of [...(first.ok ? first.recs : []), ...owed]) merged.set(`${r.unit}:${r.seq}`, r);
  deliver([...merged.values()]);
  if (!first.ok || !fs.existsSync(file) || readTrackedKeeperPid(wsId) !== null) return; // unreadable = unknown; a live keeper still appends: its file is never pruned
  // The keeper is gone, so the file is FINAL now. Re-read it: a record the keeper appended between our first read and its exit (its exit flush) must not be unlinked unseen (review F4).
  const fresh = readMemNoticesChecked(file);
  if (fresh.ok && fresh.recs.length !== first.recs.length) deliver(fresh.recs);
  const verdict = pruneVerdict(fresh, (u) => cursor().seen(u));
  if (verdict !== 'keep' && ![...owedRecords.values()].some((o) => o.wsId === wsId)) {
    try {
      if (verdict === 'prune') fs.unlinkSync(file);
      else {
        const aside = `${file}.unparsed.${Date.now()}`; // everything we understand is delivered, but a line was not (a crash-torn tail): keep the evidence, free the name
        fs.renameSync(file, aside);
        log.warn(`memory-cap[${wsId}]: ${file} held lines that are not records - moved to ${aside}`);
      }
    } catch {
      /* already gone */
    }
  }
}

/** App start (after the store and the bus are up): drain every workspace's notice file — kills and warnings recorded while the app was closed. A file whose workspace no longer exists is dropped. */
export function drainAllMemNotices(isKnownWorkspace: (wsId: string) => boolean): void {
  let names: string[];
  try {
    names = fs.readdirSync(keeperDir());
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^(.+)\.memnotices\.jsonl$/.exec(name);
    if (!m) continue;
    const wsId = m[1];
    if (!isKnownWorkspace(wsId)) {
      if (readTrackedKeeperPid(wsId) === null) {
        try {
          fs.unlinkSync(path.join(keeperDir(), name));
        } catch {
          /* fine */
        }
      }
      continue;
    }
    try {
      drainMemNotices(wsId);
    } catch (e) {
      log.warn(`memory-cap[${wsId}]: draining the notice file failed`, e);
    }
  }
}

/** A moment after a scoped keeper got its spawn frame, ask it what it really is and SAY it in the app log: a scope whose limit is not applied or whose tools are not wrapped is not the promised cap. */
async function reportCapState(wsId: string, cap: MemoryCapLaunch): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 400 : 800));
    const pr = await probeKeeper(wsId);
    if (!pr) continue;
    if (pr.cap === undefined && i < 3) continue; // the spawn frame may not have been processed yet
    const d = describeCapState(pr.cap?.state, cap.unit, cap.limits?.hardBytes ?? 0);
    (d.level === 'info' ? log.info : log.warn)(`memory-cap[${wsId}]: ${d.text}`);
    return;
  }
}

/** The wrapper a capped keeper needs to protect itself: an absolute, whitespace-free, executable path. Without it the scope would kill the CLI first — so no scope. */
function oomWrapperReady(): boolean {
  const p = oomWrapperPath();
  if (!wrapperPathUsable(p)) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy dist-electron/keeper.js out of the install dir. Idempotent + self-
 * updating (content compare). Best-effort: a failure only disables detach
 * survival, never GUI startup. Safe while keepers run — node reads the whole
 * file at startup, so overwriting doesn't touch live processes.
 */
export function installKeeper(): void {
  installOomWrapper();
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
  /** #320: this keeper's Plafond mémoire state (see the protocol); undefined = launched without one. */
  cap?: { unit: string; state: 'active' | 'unprotected' | 'not-applied' | 'no-scope'; hardBytes: number };
  /** #320: the kills it has recorded (last ≤ 20). */
  memKills?: MemKillRecord[];
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
        ...(reply.cap ? { cap: reply.cap } : {}),
        ...(reply.memKills ? { memKills: reply.memKills } : {}),
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

/** Run `op` in the workspace's keeper queue (launches, kills and — #327 — the scope stop never interleave). `op` must not itself call killKeeper or start a keeper: it would wait on itself. */
export function withKeeperLock<T>(wsId: string, op: () => Promise<T>): Promise<T> {
  return serializeKeeperOp(wsId, op);
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
      const p = parseProcIdentity(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
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
  // The relay socket (#291) is the keeper's: with no live keeper on the workspace nobody serves it any more.
  if (!sockLive && (state === 'gone' || state === 'other')) {
    unlink(keeperRelaySocketPath(wsId));
    unlink(relayUpstreamFile(keeperSocketPath(wsId)));
    unlink(relayHoldFile(keeperSocketPath(wsId)));
  }
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

/** #327: kill the keeper ONLY if it is still THE one (`expectedPid`, read before the stop began) — a successor a wake launched meanwhile has another pid and is left alone. Call it with the keeper lock HELD ({@link withKeeperLock}). */
export async function killKeeperIfHeld(wsId: string, expectedPid: number | null, reason = 'explicit-stop'): Promise<void> {
  if (expectedPid === null || readTrackedKeeperPid(wsId) !== expectedPid) return;
  await killKeeperUnlocked(wsId, reason);
}

/** {@link killKeeperIfHeld} under its own hold of the keeper lock (the check and the kill cannot be split by a launch). */
export function killKeeperIf(wsId: string, expectedPid: number | null, reason = 'explicit-stop'): Promise<void> {
  return serializeKeeperOp(wsId, () => killKeeperIfHeld(wsId, expectedPid, reason));
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
    for (const p of [path.join(keeperDir(), name), keeperSocketPath(wsId), keeperRelaySocketPath(wsId), relayUpstreamFile(keeperSocketPath(wsId)), relayHoldFile(keeperSocketPath(wsId)), keeperLogPath(wsId)]) {
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

/** `/proc/<pid>/<file>` or '' (gone / unreadable) — the caller passes only a pid it owns (an un-reaped direct child). */
function readSafeProc(pid: number, file: string): string {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return '';
  }
}

async function launchKeeperDaemon(wsId: string, cap?: MemoryCapLaunch): Promise<net.Socket> {
  drainMemNotices(wsId); // #322 m1: deliver what the previous keeper recorded (and prune its file) before a new generation starts appending
  const sockPath = keeperSocketPath(wsId);
  const runtime = resolveKeeperRuntime();
  const script = installedKeeperPath();
  const target = fs.existsSync(script) ? script : path.join(__dirname, 'keeper.js');
  fs.mkdirSync(keeperDir(), { recursive: true });
  const keeperArgs = [target, wsId, sockPath, keeperPidPath(wsId), keeperLogPath(wsId)];
  const waitForSocket = async (aborted: () => boolean, tries = 50): Promise<net.Socket | { err: unknown }> => {
    let lastErr: unknown = null;
    for (let i = 0; i < tries; i++) {
      if (aborted()) return { err: lastErr ?? new Error('launcher exited') };
      try {
        return await connectSock(sockPath, 500);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return { err: lastErr };
  };
  if (cap) {
    // Plafond mémoire (#320): `systemd-run --scope` makes the keeper the MAIN process of a NEW user scope (never moves an existing
    // process). If the launcher itself fails (no systemd-run, no user manager) the keeper never ran: launch it plain — an uncapped
    // session is better than none — and the keeper's `cap.state` will say `no-scope`.
    const launch = buildScopeLaunchArgv({ unit: cap.unit, limits: cap.limits, description: `Orchestra member ${wsId} (keeper + session)`, cmd: runtime.cmd, args: keeperArgs });
    let launcherFailed: string | null = null;
    // systemd-run's own stderr goes to the keeper's log (append) so a failure carries its REASON; the exec'd keeper inherits the same fd (its klog appends to the file too).
    const logFd = fs.openSync(keeperLogPath(wsId), 'a');
    const child = spawn(launch.cmd, launch.args, { detached: true, stdio: ['ignore', 'ignore', logFd], env: runtime.env });
    fs.closeSync(logFd);
    child.once('error', (e) => (launcherFailed = e.message));
    child.once('exit', (code, signal) => {
      if (code !== 0 && launcherFailed === null) launcherFailed = `exit ${code ?? signal}`; // the launcher exec'd into the keeper: any exit before the socket is up is a failure (the FIRST reason wins: a hung launcher we killed ourselves stays "hung")
    });
    child.unref();
    let r = await waitForSocket(() => launcherFailed !== null, 100); // 10 s, not 5: the user manager may be slow to create a scope under fleet load (a FAILED launcher aborts at once)
    if (!(r instanceof net.Socket) && launcherFailed === null && child.pid !== undefined && launcherExecedKeeper(readSafeProc(child.pid, 'cmdline'), target, wsId)) {
      // systemd-run already exec'd INTO the keeper (same pid, our own un-reaped child): it is slow to listen under fleet load, not hung — wait longer rather than kill a healthy capped keeper (pre-review m6).
      r = await waitForSocket(() => launcherFailed !== null, 200);
    }
    if (r instanceof net.Socket) {
      log.info(`memory-cap[${wsId}]: keeper launched in scope ${cap.unit}${cap.limits ? ` (hard ${cap.limits.hardBytes} B, swap ${cap.limits.swapMaxBytes})` : ' (no limits)'}`);
      return r;
    }
    if (launcherFailed === null) {
      // The launcher is still running and no keeper answered in 10 s: systemd-run HUNG (a stuck user manager / D-Bus). Review m5: that must not fail the session start — kill OUR direct child
      // and fall back to a plain keeper. (systemd-run --scope execs INTO the keeper under the same pid: a launcher merely slower than 10 s loses its cap here, by design — the keeper it
      // would have become is the process killed. `child.kill` refuses an already-reaped child, so a recycled pid is never signalled.)
      launcherFailed = 'no keeper socket within 10 s (systemd-run hung?)';
      child.kill('SIGKILL');
      await new Promise((res) => setTimeout(res, 300));
    }
    let why = '';
    try {
      const tail = fs.readFileSync(keeperLogPath(wsId), 'utf8').trim().split('\n').slice(-2).join(' | ').slice(-300);
      if (tail) why = ` — ${tail}`; // no dangling dash when the launcher said nothing
    } catch {
      /* no log */
    }
    log.warn(`memory-cap[${wsId}]: could not start the keeper in scope ${cap.unit} (${launcherFailed}${why}) — launching it WITHOUT a scope`);
  }
  const child = spawn(runtime.cmd, keeperArgs, {
    detached: true,
    stdio: 'ignore',
    env: runtime.env,
  });
  child.unref();
  const r = await waitForSocket(() => false);
  if (r instanceof net.Socket) return r;
  throw new Error(`keeper failed to start for ${wsId}: ${String(r.err)}`);
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
  /** #291: ask the keeper to host the Docker relay for this member (absent = the spawn frame is today's, byte for byte). */
  dockerRelay?: DockerRelaySpec,
  /** #320: launch the keeper (when this start has to launch one) in its own scope with these limits. Absent = today's launch, byte for byte. */
  memoryCap?: MemoryCapLaunch,
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
    const deliverCatchUp = (kills: MemKillRecord[] | undefined, softs: MemSoftRecord[] | undefined): void => {
      // kills AND warnings share one seq counter: deliver them in seq order (the cursor is a high-water mark) — the host used to read only the kills (review F3)
      for (const rec of [...(kills ?? []), ...(softs ?? [])].sort((a, b) => a.seq - b.seq)) deliverMemRecord(wsId, rec);
    };
    let ackWaiter: { resolve: (a: Ack) => void; reject: (e: Error) => void } | null = null;
    const wireSocket = (s: net.Socket): void => {
      s.on(
        'data',
        createLineSplitter((line) => {
          const f = parseKeeperFrame(line);
          if (!f) return;
          if (f.t === 'helloAck') {
            drainMemNotices(wsId); // #322 m1: the keeper's durable file first (kills AND warnings, in order) …
            deliverCatchUp(f.memKills, f.memSofts); // #320: … then the in-memory catch-up of an older keeper (already-delivered records are skipped by the cursor)
            ackWaiter?.resolve({
              running: f.running,
              pid: f.pid,
              everStarted: f.everStarted,
              turnInFlight: f.turnInFlight,
              shuttingDown: f.shuttingDown,
            });
            ackWaiter = null;
          } else if (f.t === 'memKill') {
            deliverMemRecord(wsId, f.rec);
          } else if (f.t === 'memSoft') {
            deliverMemRecord(wsId, f.rec);
          } else if (f.t === 'stdout') {
            stdout.write(Buffer.from(f.b64, 'base64'));
          } else if (f.t === 'exit') {
            drainMemNotices(wsId); // #322 m1: a kill that ended the CLI is in the file by now (the keeper's stop() flushes a pending kill before it exits — review F2)
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
        drainMemNotices(wsId); // #322 m1: the keeper's connection ended — anything it recorded is in its file
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
            // #320: no usable tool wrapper ⇒ NO scope. With the limit applied and the tools at adj 0 the kernel kills the biggest process — the CLI, i.e. the session.
            let cap = memoryCap;
            if (cap && !oomWrapperReady()) {
              log.warn(`memory-cap[${wsId}]: the tool wrapper ${oomWrapperPath()} is missing or unusable — NOT creating the scope (without it the kernel would kill the CLI first); this member runs uncapped`);
              cap = undefined;
            }
            sock = await launchKeeperDaemon(wsId, cap);
            wireSocket(sock);
            await helloOn(sock);
            sock.write(
              encodeKeeperFrame({
                t: 'spawn',
                command: opts.command,
                args: opts.args,
                cwd: opts.cwd ?? process.cwd(),
                env: opts.env,
                ...(dockerRelay ? { dockerRelay } : {}),
                ...(cap?.limits
                  ? {
                      memoryCap: {
                        unit: cap.unit,
                        hardBytes: cap.limits.hardBytes,
                        wrapper: oomWrapperPath(),
                        ...(cap.limits.softBytes !== null && cap.limits.softBytes < cap.limits.hardBytes ? { softBytes: cap.limits.softBytes } : {}),
                        noticeFile: memNoticeFilePath(wsId),
                      },
                    }
                  : {}),
              }),
            );
            if (cap?.limits) void reportCapState(wsId, cap).catch(() => {});
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
