// Always-on resource monitor + reaper (issue #198 D11 / track T8) — platform I/O.
//
// A MAIN-PROCESS sampler that ticks every 60s regardless of whether any window
// is open (unlike the pull-only Resources page, which polls only while visible).
// Each tick:
//   1. reads the local process table from /proc (Linux) — NO child process is
//      spawned, so the sampler itself never adds to the load it measures;
//   2. finds every live keeper's process tree (keeper → CLI → MCP children),
//      keyed by workspace id, plus Electron's own processes;
//   3. REAPS any session tree whose workspace is provably absent from the store
//      (detector a — the destructive one, gated hard, see decideReap), reading
//      the store AT KILL TIME;
//   4. appends ONE JSON line to <ORCHESTRA_HOME>/logs/resources.jsonl (bounded:
//      rotate at 50 MB, drop a backup older than 7 days);
//   5. emits an advisory WARN for any tree/Electron process over threshold
//      (detector b — never kills).
//
// The pure decision + line-shape logic lives in ../shared/resource-monitor.ts;
// this module owns the I/O and is structured around an injectable `deps` object
// so a rig (scripts/verify-resource-monitor.mjs) can drive the REAL sampleTick
// over a faked /proc table + store fixture through the real append + reap path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { orchestraHome, platform } from './platform';
import { scoped } from './logger';
import { store } from './store';
import { listKeeperRoots } from './keeper-client';
import {
  computeCpuPcts,
  parseProcStatLine,
  parsePsOutput,
  type ProcSample,
} from '../shared/resources';
import {
  buildResourceLogLine,
  decideReap,
  decideThresholdWarnings,
  shouldRotate,
  RETENTION_MS,
  type KeeperRoot,
  type ResourceLogElectronProc,
  type ResourceLogLine,
} from '../shared/resource-monitor';

const rlog = scoped('resources');
const execFileP = promisify(execFile);

/** Read the full local process table — the SAME cheap read the Resources page
 *  uses, kept here (rather than imported from ./resources) so this always-on
 *  module does not transitively drag in the PTY/transport stack. Linux reads
 *  /proc directly (NO child process spawned); other platforms shell out to
 *  `ps`. */
async function sampleProcTable(): Promise<ProcSample[]> {
  if (process.platform === 'linux') {
    const out: ProcSample[] = [];
    let names: string[];
    try {
      names = fs.readdirSync('/proc');
    } catch {
      return out;
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const p = parseProcStatLine(text);
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

/** How often the monitor samples. Matches the brief (issue #198 D11): 60s. */
export const TICK_MS = 60_000;

/** Path of the active sample log. */
export function resourcesLogPath(): string {
  return path.join(orchestraHome(), 'logs', 'resources.jsonl');
}
function resourcesLogBackupPath(): string {
  return `${resourcesLogPath()}.1`;
}

// ─── Injectable platform seam (real defaults; a rig overrides them) ───────────

export interface ResourceMonitorDeps {
  now(): number;
  procTable(): Promise<ProcSample[]>;
  keeperRoots(): KeeperRoot[];
  /** Workspace ids present in the store, read FRESH each call (kill-time read). */
  liveWorkspaceIds(): Set<string>;
  /** A workspace's store status, or null when absent. */
  statusFor(wsId: string): string | null;
  /** True once the store parsed a real store.json off disk. */
  storeLoadedFromDisk(): boolean;
  electronProcs(): ResourceLogElectronProc[];
  cpuCores(): number;
  memTotalBytes(): number;
  /** total − MemAvailable in bytes, or null if unreadable. */
  memUsedBytes(): number | null;
  /** Append one JSONL line (handles rotation). */
  appendLine(line: ResourceLogLine): void;
  /** SIGKILL one pid. Returns true if the signal was delivered. */
  kill(pid: number): boolean;
  /** Emit a WARN with the `resources:` scope. */
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
}

/** Read total − MemAvailable from /proc/meminfo (Linux). null elsewhere / on
 *  failure — never a fabricated figure. */
export function readMemUsedBytes(): number | null {
  if (process.platform !== 'linux') {
    // os.freemem() is closer to MemFree than MemAvailable, but it is the only
    // cross-platform figure; used = total − free.
    const free = os.freemem();
    const total = os.totalmem();
    return Number.isFinite(free) && Number.isFinite(total) ? total - free : null;
  }
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
    const avail = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (!total || !avail) return null;
    return (Number(total[1]) - Number(avail[1])) * 1024;
  } catch {
    return null;
  }
}

/** Append one line, rotating the file first when it has grown past the cap and
 *  dropping a backup older than the retention window. Best-effort — a logging
 *  failure must never crash the tick. */
function appendLineToDisk(line: ResourceLogLine): void {
  const file = resourcesLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* absent → size 0 */
    }
    if (shouldRotate(size)) {
      // Move the full file aside; a single .1 backup is kept.
      try {
        fs.renameSync(file, resourcesLogBackupPath());
      } catch {
        /* fine — next append recreates */
      }
    }
    // Drop a backup older than the retention window (age-based bound, ≤7 days).
    try {
      const st = fs.statSync(resourcesLogBackupPath());
      if (Date.now() - st.mtimeMs > RETENTION_MS) fs.unlinkSync(resourcesLogBackupPath());
    } catch {
      /* no backup → nothing to prune */
    }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch (e) {
    rlog.swallow('resources.jsonl append', e);
  }
}

const defaultDeps: ResourceMonitorDeps = {
  now: () => Date.now(),
  procTable: () => sampleProcTable(),
  keeperRoots: () => listKeeperRoots(),
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
  appendLine: appendLineToDisk,
  kill: (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  },
  warn: (message, meta) => rlog.warn(message, meta),
  info: (message, meta) => rlog.info(message, meta),
};

// The CPU percent is a jiffy delta between two samples, so the monitor keeps its
// OWN previous-ticks map (independent of the Resources page's, which ticks at a
// different cadence). The first tick after start reports 0% CPU; the second is
// real.
let prevTicks = new Map<number, number>();
let prevAt = 0;

/**
 * One sample + detect + reap + log cycle. Exported and dependency-injected so a
 * rig drives the REAL decision/append/reap through a faked /proc + store.
 *
 * ## Reaper ordering — dry-run then kill, store read at kill time
 * The store snapshot (`liveWorkspaceIds`) is read HERE, immediately before the
 * decision, so a workspace re-created between two ticks is never reaped on a
 * stale snapshot. The decision itself (decideReap) refuses to act at all unless
 * the store loaded from disk. Every killed pid is a descendant of a keeper pid
 * (collectTree under a keeper root) — never an Electron or unrelated process.
 * We LOG what and why BEFORE issuing any kill.
 */
export async function sampleTick(d: ResourceMonitorDeps = defaultDeps): Promise<ResourceLogLine> {
  const now = d.now();
  const table = await d.procTable();
  const elapsed = prevAt === 0 ? 0 : now - prevAt;
  const cpuPcts = computeCpuPcts(table, prevTicks, elapsed);
  prevTicks = new Map(table.filter((p) => p.cpuPct === null).map((p) => [p.pid, p.cpuTicks]));
  prevAt = now;

  const keeperRoots = d.keeperRoots();
  const liveWorkspaceIds = d.liveWorkspaceIds(); // kill-time store read
  const storeLoaded = d.storeLoadedFromDisk();

  // ── Detector (a): reap orphaned trees ──────────────────────────────────────
  const reap = decideReap(keeperRoots, table, liveWorkspaceIds, storeLoaded);
  const reapedWorkspaceIds = new Set<string>();
  if (reap.refusedStoreNotLoaded && keeperRoots.length > 0) {
    d.info(
      `resources: reap skipped — store not loaded from disk; ` +
        `${keeperRoots.length} keeper tree(s) left untouched (absence-from-store is not proof of deletion)`,
    );
  }
  for (const target of reap.targets) {
    const memberDesc = target.members.map((m) => `${m.comm}(${m.pid})`).join(', ');
    // Log what + why BEFORE killing (the destructive act is auditable even if a
    // later kill throws).
    d.warn(
      `resources: reaping orphaned session tree for workspace ${target.workspaceId} ` +
        `(absent from store) — keeper pid ${target.keeperPid}, ${target.pids.length} process(es): ${memberDesc}`,
    );
    let killed = 0;
    for (const pid of target.pids) {
      if (d.kill(pid)) killed++;
    }
    reapedWorkspaceIds.add(target.workspaceId);
    d.warn(
      `resources: reaped workspace ${target.workspaceId} — sent SIGKILL to ${killed}/${target.pids.length} process(es)`,
    );
  }

  // ── Build the sample line ───────────────────────────────────────────────────
  const electron = d.electronProcs();
  const line = buildResourceLogLine(
    {
      at: now,
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

  // ── Detector (b): advisory over-threshold WARNs ────────────────────────────
  for (const w of decideThresholdWarnings(line.sessions, electron)) {
    const val =
      w.kind.endsWith('rss')
        ? `${(w.value / (1024 * 1024)).toFixed(0)} MB`
        : `${w.value.toFixed(0)}% cpu`;
    d.warn(
      `resources: ${w.kind} over threshold — ${w.subject} (pid ${w.pid}) at ${val} (advisory, not killed)`,
    );
  }

  return line;
}

let timer: NodeJS.Timeout | null = null;

/** Start the always-on monitor (idempotent). */
export function startResourceMonitor(): void {
  if (timer) return;
  prevTicks = new Map();
  prevAt = 0;
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
  prevTicks = new Map();
  prevAt = 0;
}

/** Test seam: reset the CPU-delta baseline so a rig drives ticks from a known
 *  start instead of inheriting a previous run's ticks. */
export function __resetResourceMonitorForTest(): void {
  prevTicks = new Map();
  prevAt = 0;
}
