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
  /** Snapshot cadence: `hotMs` while the scope uses > 50 % of its limit, `fastMs` above 25 %, `idleMs` otherwise (defaults 100 / 250 / 500 ms). */
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
  /** Look now (the inotify callback and the tick both land here). Resolves when the look — including its grace wait — is done. */
  check(): Promise<void>;
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
/** The kernel bumps `oom_kill` just BEFORE the victim dies: when a look sees the counter move but fewer members gone than kills, it waits this long and looks once more. */
const VICTIM_DEATH_GRACE_MS = 30;
/** The kernel counts the memcg OOM event (`oom`) BEFORE it counts the kill (`oom_kill`): a look may fall between the two. The `oom` credit therefore CARRIES to the look that sees the kill; one that
 *  never produces a kill (nothing to kill) expires after this long, so it cannot later turn an outside-OOM kill into a «hard» one. */
const OOM_CREDIT_TTL_MS = 10_000;
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
  /** Per-pid static facts (cmdline, adj) keyed by pid, valid while the start time matches. */
  const statics = new Map<number, { startTicks: number; comm: string; cmdline: string; adj: number }>();
  const recs: MemKillRecord[] = [];
  let seq = o.seqStart ?? 1;
  let last: MemoryEvents | null = parseMemoryEvents(readSafe(eventsFile) ?? '');
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  /** Refresh the snapshot from cgroup.procs (adds/updates the live members, removes nothing); returns the keys alive now. */
  function snapshot(): Set<string> {
    const alive = new Set<string>();
    const alivePids = new Set<number>();
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
      alivePids.add(pid);
    }
    for (const pid of statics.keys()) if (!alivePids.has(pid)) statics.delete(pid);
    return alive;
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let busy = false;
  /** Timestamps of `oom` events not yet attributed to a kill (the carried credit, see {@link OOM_CREDIT_TTL_MS}). */
  let oomCredits: number[] = [];

  /**
   * ONE look. Order matters: the members are snapshotted FIRST and `memory.events` read AFTER — the kernel bumps `oom_kill` before the victim dies, so a death this
   * snapshot saw is already counted in this read. A member that left since the previous look is a candidate for THIS look's kills only (then forgotten): a command that
   * exited normally minutes ago can never be named as a victim later. A look that arrives while another is waiting is dropped — the counter delta accumulates to the next.
   */
  async function look(): Promise<void> {
    if (stopped || busy) return;
    busy = true;
    try {
      const before = new Map(snap); // the live members as of the PREVIOUS look
      let alive = snapshot();
      let cur = parseMemoryEvents(readSafe(eventsFile) ?? '');
      if (cur && last && cur.oomKill > last.oomKill) {
        const delta = cur.oomKill - last.oomKill;
        const gone = [...before.keys()].filter((k) => !alive.has(k));
        if (gone.length < delta) {
          await sleep(VICTIM_DEATH_GRACE_MS); // the counter moved just before the victim died
          if (stopped) return;
          alive = snapshot();
          cur = parseMemoryEvents(readSafe(eventsFile) ?? '') ?? cur;
        }
      }
      // Level credit (F1 of the gate): every `oom` event this look saw joins the carried credit; each kill spends one. A look that sees the `oom` bump but not yet the kill leaves the credit for the next.
      const t = now();
      if (cur && last) for (let i = 0; i < cur.oom - last.oom; i++) oomCredits.push(t);
      oomCredits = oomCredits.filter((at) => t - at <= OOM_CREDIT_TTL_MS);
      if (cur && last && cur.oomKill > last.oomKill) {
        const killsNow = cur.oomKill - last.oomKill;
        const hardCredit = Math.min(killsNow, oomCredits.length);
        oomCredits = oomCredits.slice(hardCredit); // the oldest credits are spent
        const made = inferKillRecords({
          before,
          aliveKeys: alive,
          delta: { oomKill: killsNow, hardCredit },
          maxBytes: maxBytes(),
          unit: o.unit,
          seqNext: seq,
          nowMs: now(),
          pageSize: PAGE,
        });
        seq += made.length;
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
      for (const k of before.keys()) if (!alive.has(k)) snap.delete(k); // forgotten, named or not
      if (cur) last = cur;
    } finally {
      busy = false;
    }
  }

  function tick(): void {
    if (stopped) return;
    void look().catch((e) => o.log(`memory watch: look failed (${(e as Error).message})`));
    const cur = Number((readSafe(path.join(o.cgroupDir, 'memory.current')) ?? '0').trim());
    const max = maxBytes();
    const frac = max !== null && Number.isFinite(cur) ? cur / max : 0;
    const base = frac > 0.5 ? (o.hotMs ?? 100) : frac > 0.25 ? (o.fastMs ?? 250) : (o.idleMs ?? 500);
    // A scope with hundreds of members (a Chromium swarm) costs ~3 /proc reads each per look: stretch the cadence so the watch stays cheap (≈2 ms per member, ≤ 800 ms at the 400-member cap).
    timer = setTimeout(tick, Math.max(base, Math.min(800, snap.size * 2)));
    timer.unref();
  }

  try {
    // inotify on a cgroupfs file fires within milliseconds of the counter moving (measured); the tick is the safety net.
    watcher = fs.watch(eventsFile, () => void look().catch(() => {}));
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
    check: look,
    records: () => recs.slice(),
  };
}
