// Plafond mémoire — the keeper's kill watch (#320, ledger FI-1 b). Runs INSIDE the member's scope, so it works while the app is down.
//
// The kernel counts kills (`memory.events` oom_kill) but does not name its victim. So: wake on `memory.events` (inotify, ms) and keep a
// light snapshot of the scope's members (pid, start time, cmdline, rss, oom_score_adj); on an oom_kill increment, the members that
// vanished since the last look are the victims, ranked by the kernel's own badness estimate (shared/memory-scope.ts inferKillRecords).
// A process that lived less than one snapshot interval is counted but not named (`command: null`) — never a made-up name.

import fs from 'node:fs';
import path from 'node:path';
import {
  inferKillRecords,
  parseCgroupLimit,
  parseMemoryEvents,
  snapKey,
  type MemKillRecord,
  type MemoryEvents,
  type VictimSnap,
} from '../shared/memory-scope.ts';

export interface MemoryWatchOpts {
  /** Absolute cgroup directory of OUR scope. */
  cgroupDir: string;
  unit: string;
  onKill(rec: MemKillRecord): void;
  log(msg: string): void;
  /** Snapshot cadence: `hotMs` while the scope uses > 50 % of its limit, `fastMs` above 25 %, `idleMs` otherwise (defaults 100 / 250 / 1500 ms). */
  hotMs?: number;
  fastMs?: number;
  idleMs?: number;
  now?: () => number;
  /** First `seq` to hand out (a keeper's records are numbered 1, 2, …). */
  seqStart?: number;
  /** Kernel page size (default: detected). */
  pageSize?: number;
  /** Test seam: replaces every file read (cgroup files and /proc). */
  readFile?: (p: string) => string;
}

export interface MemoryWatch {
  stop(): void;
  /** Look now (the inotify callback and the tick both land here). */
  check(): void;
  records(): MemKillRecord[];
}

/** The kernel's page size, derived from our own /proc (statm pages × size = VmRSS) — 16 KiB on Asahi, 4 KiB elsewhere; 4096 if unreadable. */
export function detectPageSize(read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): number {
  try {
    const pages = Number(read('/proc/self/statm').split(' ')[1]);
    const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(read('/proc/self/status'))?.[1]);
    const raw = (kb * 1024) / pages;
    if (Number.isFinite(raw) && raw >= 1024) {
      let p2 = 1024;
      while (p2 * 1.5 < raw) p2 *= 2;
      return p2;
    }
  } catch {
    /* unreadable */
  }
  return 4096;
}
/** A vanished member stays in the snapshot this long: the kill's inotify may land one tick AFTER the tick that noticed the death. */
const FORGET_VANISHED_MS = 3_000;
const MAX_MEMBERS = 400;

export function startMemoryWatch(o: MemoryWatchOpts): MemoryWatch {
  const read = o.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const PAGE = o.pageSize ?? detectPageSize(o.readFile);
  const now = o.now ?? Date.now;
  const eventsFile = path.join(o.cgroupDir, 'memory.events');
  const procsFile = path.join(o.cgroupDir, 'cgroup.procs');
  const readSafe = (p: string): string | null => {
    try {
      return read(p);
    } catch {
      return null;
    }
  };
  const maxBytes = (): number | null => {
    const t = readSafe(path.join(o.cgroupDir, 'memory.max'));
    return t === null ? null : parseCgroupLimit(t);
  };

  const snap = new Map<string, VictimSnap>();
  const vanishedAt = new Map<string, number>();
  /** Per-pid static facts (cmdline, adj) keyed by pid, valid while the start time matches. */
  const statics = new Map<number, { startTicks: number; comm: string; cmdline: string; adj: number }>();
  const recs: MemKillRecord[] = [];
  let seq = o.seqStart ?? 1;
  let last: MemoryEvents | null = parseMemoryEvents(readSafe(eventsFile) ?? '');
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  /** Refresh the snapshot from cgroup.procs; returns the keys alive now. */
  function snapshot(): Set<string> {
    const alive = new Set<string>();
    const text = readSafe(procsFile);
    if (text === null) return alive;
    const pids = text.split('\n').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_MEMBERS);
    for (const pid of pids) {
      let st = statics.get(pid);
      const stat = readSafe(`/proc/${pid}/stat`);
      if (stat === null) continue;
      const rp = stat.lastIndexOf(')');
      if (rp < 0) continue;
      const f = stat.slice(rp + 2).split(' ');
      const startTicks = Number(f[19]);
      if (!Number.isFinite(startTicks)) continue;
      if (!st || st.startTicks !== startTicks) {
        const comm = stat.slice(stat.indexOf('(') + 1, rp);
        const cmdline = (readSafe(`/proc/${pid}/cmdline`) ?? '').replace(/\0/g, ' ').trim();
        const adj = Number((readSafe(`/proc/${pid}/oom_score_adj`) ?? '0').trim());
        st = { startTicks, comm, cmdline, adj: Number.isFinite(adj) ? adj : 0 };
        statics.set(pid, st);
      }
      const statm = readSafe(`/proc/${pid}/statm`);
      const rssPages = statm ? Number(statm.split(' ')[1]) || 0 : 0;
      const key = snapKey(pid, startTicks);
      snap.set(key, { pid, startTicks, comm: st.comm, cmdline: st.cmdline, rssPages, adj: st.adj });
      alive.add(key);
      vanishedAt.delete(key);
    }
    const t = now();
    for (const key of snap.keys()) {
      if (alive.has(key)) continue;
      const since = vanishedAt.get(key) ?? t;
      vanishedAt.set(key, since);
      if (t - since > FORGET_VANISHED_MS) {
        snap.delete(key);
        vanishedAt.delete(key);
      }
    }
    for (const [pid, st] of statics) if (!snap.has(snapKey(pid, st.startTicks)) && !alive.has(snapKey(pid, st.startTicks))) statics.delete(pid);
    return alive;
  }

  function check(): void {
    if (stopped) return;
    const cur = parseMemoryEvents(readSafe(eventsFile) ?? '');
    if (!cur) return;
    if (last && cur.oomKill > last.oomKill) {
      const before = new Map(snap); // what we saw BEFORE this look refreshes it
      const alive = snapshot();
      const made = inferKillRecords({
        before,
        aliveKeys: alive,
        delta: { oomKill: cur.oomKill - last.oomKill, oom: cur.oom - last.oom },
        maxBytes: maxBytes(),
        unit: o.unit,
        seqNext: seq,
        nowMs: now(),
        pageSize: PAGE,
      });
      seq += made.length;
      // The vanished members are consumed by this look: they must not be named again by a later kill.
      for (const k of before.keys()) {
        if (!alive.has(k)) {
          snap.delete(k);
          vanishedAt.delete(k);
        }
      }
      for (const rec of made) {
        recs.push(rec);
        if (recs.length > 50) recs.shift();
        try {
          o.onKill(rec);
        } catch (e) {
          o.log(`memory watch: onKill failed (${(e as Error).message})`);
        }
      }
    }
    last = cur;
  }

  function tick(): void {
    if (stopped) return;
    try {
      snapshot();
      check();
    } catch (e) {
      o.log(`memory watch: tick failed (${(e as Error).message})`);
    }
    const cur = Number((readSafe(path.join(o.cgroupDir, 'memory.current')) ?? '0').trim());
    const max = maxBytes();
    const frac = max !== null && Number.isFinite(cur) ? cur / max : 0;
    timer = setTimeout(tick, frac > 0.5 ? (o.hotMs ?? 100) : frac > 0.25 ? (o.fastMs ?? 250) : (o.idleMs ?? 1500));
    timer.unref();
  }

  try {
    // inotify on a cgroupfs file fires within milliseconds of the counter moving (measured); the tick is the safety net.
    watcher = fs.watch(eventsFile, () => check());
    watcher.on('error', () => {});
    watcher.unref?.();
  } catch (e) {
    o.log(`memory watch: fs.watch unavailable (${(e as Error).message}) — polling only`);
  }
  tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* closed */
      }
    },
    check,
    records: () => recs.slice(),
  };
}
