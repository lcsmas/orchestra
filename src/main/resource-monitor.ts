// Always-on resource monitor + reaper — I/O half (issue #198 T8). Pure half:
// src/shared/resource-monitor.ts; design + gates: docs/codebase-map/resources.md.
// A 60s main-process timer (no window needed): /proc read (no child spawned) →
// reap orphaned keeper trees → append one line to <ORCHESTRA_HOME>/logs/resources.jsonl
// → advisory threshold WARNs. `sampleTick` takes an injectable `deps` so a rig
// (scripts/verify-resource-monitor.mjs) drives the REAL path over a faked /proc + store.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { orchestraHome, platform } from './platform';
import { scoped } from './logger';
import { store } from './store';
import { keeperPidFilePath, listKeeperRoots, readTrackedKeeperPid } from './keeper-client';
import { hostPageSize, onPageSizeFallback } from './host-page-size';
import { parseMemUsedBytes } from '../shared/memory-guard';
import {
  computeCpuPcts,
  parseProcStatLine,
  parsePsOutput,
  type ProcSample,
} from '../shared/resources';
import {
  buildResourceLogLine,
  classifySurvivors,
  decideDuplicateReap,
  decideReap,
  decideThresholdWarnings,
  firstSampleAt,
  isKeeperCmdline,
  parseKeeperArgv,
  shouldDropBackup,
  shouldRotate,
  verifyReapIdentity,
  type KeeperProc,
  type KeeperRoot,
  type ReapMember,
  type ReapTarget,
  type ResourceLogElectronProc,
  type ResourceLogLine,
} from '../shared/resource-monitor';

const rlog = scoped('resources');
onPageSizeFallback((m) => rlog.warn(m));
const execFileP = promisify(execFile);

export const TICK_MS = 60_000;
/** SIGTERM → SIGKILL grace; mirrors the keeper's own 5 s escalation (session-keeper.md). */
export const REAP_GRACE_MS = 5_000;

export function resourcesLogPath(): string {
  return path.join(orchestraHome(), 'logs', 'resources.jsonl');
}
function resourcesLogBackupPath(): string {
  return `${resourcesLogPath()}.1`;
}

/** Local process table. Kept here (not imported from ./resources) so this always-on
 *  module doesn't drag in the PTY/transport stack. Linux: /proc, NO child spawned. */
async function sampleProcTable(): Promise<ProcSample[]> {
  if (process.platform === 'linux') {
    const out: ProcSample[] = [];
    let names: string[];
    try {
      names = fs.readdirSync('/proc');
    } catch {
      return out;
    }
    const pageSize = hostPageSize();
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const p = parseProcStatLine(fs.readFileSync(`/proc/${name}/stat`, 'utf8'), pageSize);
        if (p) out.push(p);
      } catch {
        /* process exited mid-scan — skip */
      }
    }
    return out;
  }
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm=']);
    return parsePsOutput(stdout);
  } catch {
    return [];
  }
}

// ─── Injectable platform seam (real defaults; a rig overrides them) ───────────

export interface ResourceMonitorDeps {
  now(): number;
  procTable(): Promise<ProcSample[]>;
  keeperRoots(): KeeperRoot[];
  /** Every process whose argv is a keeper daemon of THIS home (/proc scan) — finds duplicates a pid file hides. */
  keeperProcs(): KeeperProc[];
  /** The pid-file keeper of a workspace iff alive, read FRESH (kill-time tracked-keeper re-check). */
  trackedKeeperPid(wsId: string): number | null;
  /** Workspace ids present in the store, read FRESH each call (kill-time read). */
  liveWorkspaceIds(): Set<string>;
  statusFor(wsId: string): string | null;
  /** True once the store parsed a real store.json off disk. */
  storeLoadedFromDisk(): boolean;
  electronProcs(): ResourceLogElectronProc[];
  cpuCores(): number;
  memTotalBytes(): number;
  memUsedBytes(): number | null;
  appendLine(line: ResourceLogLine): void;
  /** Fresh single-pid /proc/<pid>/stat read; null = gone/unreadable/non-Linux. */
  readProcStat(pid: number): ProcSample | null;
  /** /proc/<pid>/cmdline argv; null = gone/unreadable/non-Linux. */
  readCmdline(pid: number): string[] | null;
  /** Deliver a signal; false when it wasn't delivered (ESRCH, EPERM). */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean;
  sleep(ms: number): Promise<void>;
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
}

/** total − MemAvailable from /proc/meminfo; null when unreadable — never a fabricated figure. */
export function readMemUsedBytes(): number | null {
  if (process.platform !== 'linux') {
    const free = os.freemem();
    const total = os.totalmem();
    return Number.isFinite(free) && Number.isFinite(total) ? total - free : null;
  }
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    return parseMemUsedBytes(text); // the same parsers the memory guard reads (#285); pinned by shared/memory-guard.test.ts
  } catch {
    return null;
  }
}

// ─── The bounded log (≤7 d / ≤50 MB) — review F4 ─────────────────────────────

/** In-memory first-sample times of the two files, read from disk once (lazily). */
const logState: { loaded: boolean; activeStartedAt: number | null; backupStartedAt: number | null } = {
  loaded: false,
  activeStartedAt: null,
  backupStartedAt: null,
};

function readFirstSampleAt(file: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    return firstSampleAt(buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fine */
      }
    }
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Append one line; rotate/prune by SAMPLE age + size first. Best-effort — never throws. */
export function appendResourceLogLine(line: ResourceLogLine): void {
  const file = resourcesLogPath();
  const backup = resourcesLogBackupPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!logState.loaded) {
      logState.activeStartedAt = fileSize(file) > 0 ? readFirstSampleAt(file) : null;
      logState.backupStartedAt = fileSize(backup) > 0 ? readFirstSampleAt(backup) : null;
      logState.loaded = true;
    }
    let size = fileSize(file);
    if (shouldRotate(size, logState.activeStartedAt, line.at)) {
      fs.renameSync(file, backup);
      logState.backupStartedAt = logState.activeStartedAt;
      logState.activeStartedAt = null;
      size = 0;
    }
    if (fileSize(backup) > 0 && shouldDropBackup(logState.backupStartedAt, line.at)) {
      fs.unlinkSync(backup);
      logState.backupStartedAt = null;
    }
    if (size === 0) logState.activeStartedAt = line.at;
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch (e) {
    rlog.swallow('resources.jsonl append', e);
  }
}

/** Linux /proc argv scan for keeper daemons of this home; other platforms → [] (reap needs /proc anyway). */
function scanKeeperProcs(): KeeperProc[] {
  if (process.platform !== 'linux') return [];
  const out: KeeperProc[] = [];
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter((a) => a.length > 0);
      const ws = parseKeeperArgv(argv, keeperPidFilePath);
      if (ws) out.push({ pid: Number(name), workspaceId: ws });
    } catch {
      /* exited mid-scan / not readable */
    }
  }
  return out;
}

const defaultDeps: ResourceMonitorDeps = {
  now: () => Date.now(),
  procTable: () => sampleProcTable(),
  keeperRoots: () => listKeeperRoots(),
  keeperProcs: () => scanKeeperProcs(),
  trackedKeeperPid: (wsId) => readTrackedKeeperPid(wsId),
  liveWorkspaceIds: () => new Set(store.workspaces.map((w) => w.id)),
  statusFor: (wsId) => store.getWorkspace(wsId)?.status ?? null,
  storeLoadedFromDisk: () => store.loadedFromDisk,
  electronProcs: () =>
    platform.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpuPct: m.cpuPct,
      rssBytes: m.memBytes,
    })),
  cpuCores: () => os.cpus().length || 1,
  memTotalBytes: () => os.totalmem(),
  memUsedBytes: () => readMemUsedBytes(),
  appendLine: appendResourceLogLine,
  readProcStat: (pid) => {
    if (process.platform !== 'linux') return null;
    try {
      return parseProcStatLine(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), hostPageSize());
    } catch {
      return null;
    }
  },
  readCmdline: (pid) => {
    if (process.platform !== 'linux') return null;
    try {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter((s) => s.length > 0);
    } catch {
      return null;
    }
  },
  signal: (pid, sig) => {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  warn: (message, meta) => rlog.warn(message, meta),
  info: (message, meta) => rlog.info(message, meta),
};

// CPU% is a jiffy delta between two samples: the monitor keeps its OWN baseline
// (independent of the Resources page's). The first tick reads 0%; the second is real.
let prevTicks = new Map<number, number>();
let prevAt = 0;

function readFresh(d: ResourceMonitorDeps, pids: number[]): Map<number, ProcSample | null> {
  return new Map(pids.map((pid) => [pid, d.readProcStat(pid)]));
}

/**
 * Reap orphaned trees, identity-safe (review F1). Phase 1 re-verifies each tree
 * against FRESH /proc reads + re-reads the store, then SIGTERMs leaf-first; ONE
 * grace; phase 2 SIGKILLs only survivors still the same (pid, start-time).
 * Residual: a pid can still be reused in the microseconds between the read and
 * the signal (no pidfd in Node) — vs the ~60 s stale window before this fix.
 */
async function reapTargets(d: ResourceMonitorDeps, targets: ReapTarget[]): Promise<Set<string>> {
  const reaped = new Set<string>();
  const armed: Array<{ target: ReapTarget; sent: ReapMember[] }> = [];
  for (const target of targets) {
    const ws = target.workspaceId;
    const kind = target.kind ?? 'orphan';
    const check = verifyReapIdentity(
      target,
      readFresh(d, target.pids),
      d.readCmdline(target.keeperPid),
    );
    if (check.treeRefusal) {
      d.warn(`resources: reap WITHHELD for workspace ${ws} — ${check.treeRefusal}`);
      continue;
    }
    for (const w of check.withheld) {
      d.warn(`resources: reap skipped pid ${w.pid} of workspace ${ws} — ${w.reason}`);
    }
    if (check.signalable.length === 0) continue;
    if (!d.storeLoadedFromDisk() || (kind !== 'duplicate' && d.liveWorkspaceIds().has(ws))) {
      d.warn(`resources: reap ABORTED for workspace ${ws} — present in the store at kill time`);
      continue;
    }
    if (kind === 'duplicate') {
      // #203: a duplicate is only a duplicate while the tracked keeper is STILL the same live keeper
      // (not for an absent workspace: there the tracked one is reaped too, possibly just before this).
      const tracked = target.trackedPid ?? null;
      const now = d.trackedKeeperPid(ws);
      const trackedOk =
        now === tracked &&
        now !== target.keeperPid &&
        (tracked === null ||
          (d.readProcStat(tracked) !== null && isKeeperCmdline(d.readCmdline(tracked), ws)));
      if (!trackedOk) {
        d.warn(`resources: reap ABORTED for workspace ${ws} — tracked keeper changed since classification (was ${tracked}, now ${now})`);
        continue;
      }
    }
    const members = check.signalable.map((m) => `${m.comm}(${m.pid})`).join(', ');
    const why =
      kind === 'duplicate'
        ? `reaping duplicate keeper tree for workspace ${ws} (tracked keeper pid ${target.trackedPid} kept; identity verified)`
        : kind === 'orphan-untracked'
          ? `reaping untracked orphan keeper tree for workspace ${ws} (absent from store; identity verified)`
          : `reaping orphaned session tree for workspace ${ws} (absent from store; identity verified)`;
    d.warn(`resources: ${why} — keeper pid ${target.keeperPid}, ${check.signalable.length} process(es): ${members}`);
    const sent = check.signalable.filter((m) => d.signal(m.pid, 'SIGTERM'));
    if (sent.length > 0) {
      reaped.add(ws);
      armed.push({ target, sent });
    }
  }
  if (armed.length === 0) return reaped;
  await d.sleep(REAP_GRACE_MS);
  for (const { target, sent } of armed) {
    const s = classifySurvivors(sent, readFresh(d, sent.map((m) => m.pid)));
    const killed = s.kill.filter((m) => d.signal(m.pid, 'SIGKILL')).length;
    d.warn(
      `resources: reaped workspace ${target.workspaceId} keeper pid ${target.keeperPid} — SIGTERM ${sent.length}, exited within grace ` +
        `${s.gone.length}, SIGKILL ${killed}` +
        (s.reused.length ? `, pid reused (left alone) ${s.reused.join(',')}` : ''),
    );
  }
  return reaped;
}

/** Classify (orphans by pid file + duplicates by argv scan) then reap, identity-safe. Shared by the
 *  60 s tick and the boot pass so both apply the same store guard and log lines. */
async function reapPass(
  d: ResourceMonitorDeps,
  table: ProcSample[],
  keeperRoots: KeeperRoot[],
  liveWorkspaceIds: Set<string>,
): Promise<Set<string>> {
  const loaded = d.storeLoadedFromDisk();
  const reap = decideReap(keeperRoots, table, liveWorkspaceIds, loaded);
  const dup = decideDuplicateReap(keeperRoots, d.keeperProcs(), table, liveWorkspaceIds, loaded);
  if (reap.refusedStoreNotLoaded && keeperRoots.length > 0) {
    d.info(
      `resources: reap skipped — store not loaded from disk; ` +
        `${keeperRoots.length} keeper tree(s) left untouched (absence-from-store is not proof of deletion)`,
    );
  }
  for (const r of [...reap.refused, ...dup.refused]) {
    d.warn(`resources: reap WITHHELD for workspace ${r.workspaceId} — ${r.reason}`);
  }
  return reapTargets(d, [...reap.targets, ...dup.targets]);
}

/** Boot pass (#203): the same reap the 60 s tick runs, right after the store loads. */
export async function reapKeepersNow(d: ResourceMonitorDeps = defaultDeps): Promise<Set<string>> {
  return reapPass(d, await d.procTable(), d.keeperRoots(), d.liveWorkspaceIds());
}

/** The real (non-faked) deps — a rig overrides only the store/clock seams it needs. */
export function realResourceMonitorDeps(): ResourceMonitorDeps {
  return { ...defaultDeps };
}

/** One sample + detect + reap + log cycle (what the 60s timer runs). */
export async function sampleTick(d: ResourceMonitorDeps = defaultDeps): Promise<ResourceLogLine> {
  const now = d.now();
  const table = await d.procTable();
  const cpuPcts = computeCpuPcts(table, prevTicks, prevAt === 0 ? 0 : now - prevAt);
  prevTicks = new Map(table.filter((p) => p.cpuPct === null).map((p) => [p.pid, p.cpuTicks]));
  prevAt = now;

  const keeperRoots = d.keeperRoots();
  const liveWorkspaceIds = d.liveWorkspaceIds();
  const reapedWorkspaceIds = await reapPass(d, table, keeperRoots, liveWorkspaceIds);

  // Electron CPU from the monitor's own jiffy deltas: app.getAppMetrics() shares one
  // process-wide cursor with the Resources page, so its percent is garbage when both poll (F3).
  const electron = d.electronProcs().map((e) => ({ ...e, cpuPct: cpuPcts.get(e.pid) ?? 0 }));
  const line = buildResourceLogLine(
    {
      at: now,
      pageSize: hostPageSize(),
      cpuCores: d.cpuCores(),
      memTotalBytes: d.memTotalBytes(),
      memUsedBytes: d.memUsedBytes(),
      table,
      cpuPcts,
      keeperRoots,
      liveWorkspaceIds,
      electron,
      reapedWorkspaceIds,
    },
    d.statusFor,
  );
  d.appendLine(line);

  for (const w of decideThresholdWarnings(line.sessions, electron)) {
    const val = w.kind.endsWith('rss')
      ? `${(w.value / (1024 * 1024)).toFixed(0)} MB`
      : `${w.value.toFixed(0)}% cpu`;
    d.warn(`resources: ${w.kind} over threshold — ${w.subject} (pid ${w.pid}) at ${val} (advisory, not killed)`);
  }
  return line;
}

let timer: NodeJS.Timeout | null = null;

/** Start the always-on monitor (idempotent). */
export function startResourceMonitor(): void {
  if (timer) return;
  resetState();
  timer = setInterval(() => {
    void sampleTick().catch((e) => rlog.swallow('resource-monitor tick', e));
  }, TICK_MS);
  if (timer.unref) timer.unref();
  rlog.info('resource-monitor: started (issue #198 T8) — sampling /proc every 60s');
}

export function stopResourceMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  resetState();
}

function resetState(): void {
  prevTicks = new Map();
  prevAt = 0;
  logState.loaded = false;
  logState.activeStartedAt = null;
  logState.backupStartedAt = null;
}

/** Test seam: reset the CPU baseline and the log-state cache. */
export const __resetResourceMonitorForTest = resetState;
