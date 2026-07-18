// Live resource sampling for the Resources page. Pulled on demand over the
// `resources:sample` IPC while the page is open — there is no standing poller
// in main, so a closed page costs nothing. The pure math (stat parsing, tree
// walking, jiffy→percent) lives in ../shared/resources.ts; this module owns
// the platform I/O: /proc (Linux) or `ps` (elsewhere), the backend's own
// process metrics (via the platform seam — Electron's app metrics, or the
// daemon's self-sample), and a cached `du` pass over Orchestra's data dirs.
import { platform } from './platform';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listPtySessions } from './pty';
import { getEventsDir } from './events-spool';
import {
  aggregateSession,
  computeCpuPcts,
  parseProcStatLine,
  parsePsOutput,
  type DiskStats,
  type ProcSample,
  type ResourceSnapshot,
} from '../shared/resources';

const execFileP = promisify(execFile);

/** Read the full local process table. Linux reads /proc directly (no child
 *  process per tick); other platforms shell out to `ps`, whose pcpu column is
 *  used as-is instead of tick deltas. */
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

// Previous sample's pid → cumulative cpuTicks, for the Linux delta path. The
// first sample after launch (or after the page reopens following a long gap)
// has no baseline, so it reports 0% CPU; the second tick, ~2s later, is real.
let prevTicks = new Map<number, number>();
let prevAt = 0;

// du over the data dirs is far too heavy to run per 2s tick — cache it and
// refresh in the background at most once a minute. The page shows the cached
// figures with their measuredAt stamp.
const DISK_TTL_MS = 60_000;
let diskCache: DiskStats | null = null;
let diskInFlight: Promise<void> | null = null;

async function refreshDiskStats(): Promise<void> {
  const home = path.join(os.homedir(), '.orchestra');
  const dirs: Array<[keyof Omit<DiskStats, 'measuredAt'>, string]> = [
    ['scratchBytes', path.join(home, 'scratch')],
    ['logsBytes', path.join(home, 'logs')],
    ['backupsBytes', path.join(home, 'backups')],
    ['eventsBytes', getEventsDir()],
  ];
  const next: DiskStats = {
    scratchBytes: null,
    logsBytes: null,
    backupsBytes: null,
    eventsBytes: null,
    measuredAt: Date.now(),
  };
  const existing = dirs.filter(([, dir]) => fs.existsSync(dir));
  if (existing.length) {
    let out = '';
    try {
      ({ stdout: out } = await execFileP('du', ['-sk', ...existing.map(([, d]) => d)]));
    } catch (e) {
      // du exits non-zero if an entry vanishes mid-scan but still prints the
      // rest — salvage whatever it emitted (same recovery as worktree sizes).
      out = (e as { stdout?: string }).stdout ?? '';
    }
    const byPath = new Map<string, number>();
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const kib = Number(line.slice(0, tab));
      if (Number.isFinite(kib)) byPath.set(line.slice(tab + 1), kib * 1024);
    }
    for (const [key, dir] of existing) {
      next[key] = byPath.get(dir) ?? null;
    }
  }
  diskCache = next;
}

function maybeRefreshDisk(): void {
  if (diskInFlight) return;
  if (diskCache && Date.now() - diskCache.measuredAt < DISK_TTL_MS) return;
  diskInFlight = refreshDiskStats()
    .catch(() => {})
    .finally(() => {
      diskInFlight = null;
    });
}

/** One full sample: every live PTY session's process tree, Electron's own
 *  processes, and the (cached) disk footprint. Called by the `resources:sample`
 *  IPC handler each time the Resources page ticks. */
export async function sampleResources(): Promise<ResourceSnapshot> {
  const now = Date.now();
  const table = await sampleProcTable();
  const cpuPcts = computeCpuPcts(table, prevTicks, now - prevAt);
  prevTicks = new Map(table.filter((p) => p.cpuPct === null).map((p) => [p.pid, p.cpuTicks]));
  prevAt = now;

  const sessions = listPtySessions().map((s) =>
    aggregateSession({ ptyId: s.id, remote: s.remote, pid: s.pid }, table, cpuPcts),
  );

  // The backend's own processes (Electron's app metrics, or the daemon's
  // single self-sample). Both measure CPU since the previous call, which
  // matches the page's own tick cadence.
  const metrics = platform.getAppMetrics();

  maybeRefreshDisk(); // fire-and-forget; this tick serves the cached figures

  return {
    at: now,
    cpuCores: os.cpus().length || 1,
    memTotalBytes: os.totalmem(),
    sessions,
    app: metrics,
    disk: diskCache,
  };
}
