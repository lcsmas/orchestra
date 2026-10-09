// Plafond mémoire — resolve / read a member's kernel scope (#320, ledger FI-1 a/b/c/d). Electron-free: node --test drives it against a fake cgroup tree.
// Pure half: src/shared/memory-scope.ts. The kill WATCH is the keeper's (src/keeper/memory-watch.ts); this module only READS sysfs, so it answers the
// same after an app restart and after the keeper died (Reliquats only): the directory under the user manager's app.slice is the truth, there is no registry.

import fs from 'node:fs';
import path from 'node:path';
import { orchestraHome } from './platform/index.ts';
import { parseKeeperArgv } from '../shared/resource-monitor.ts';
import {
  MEMORY_SCOPE_PREFIX_ENV,
  classifyScopeMembers,
  parseCgroupLimit,
  parseMemoryEvents,
  parseMemoryStat,
  parseProcCgroupV2,
  sanitizeScopePrefix,
  scopeGenForWorkspace,
  parseMemoryScopeUnit,
  swapLimitApplied,
  workingSetBytes,
  type ClassifiedMember,
  type ScopeMember,
  type ScopeMemory,
  type TreeOutsideScope,
} from '../shared/memory-scope.ts';

// FI-1 v1.3: consumers import everything scope-related from THIS module (re-exports of the pure half).
export { classifyScopeMembers } from '../shared/memory-scope.ts';
export type { ClassifiedMember, ScopeMember, ScopeMemory, ScopeRole, TreeOutsideScope } from '../shared/memory-scope.ts';

export interface ScopeEnv {
  platform: string;
  uid: number | null;
  cgroupRoot: string;
  procRoot: string;
  env: Record<string, string | undefined>;
  readFile(p: string): string;
  readdir(p: string): string[];
  exists(p: string): boolean;
  pageSize: number;
  /** Where the keeper of `wsId` writes its pid file (identity: the file names the owner). */
  keeperPidFile(wsId: string): string;
}

export function realScopeEnv(): ScopeEnv {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    cgroupRoot: process.env.ORCHESTRA_CGROUP_ROOT || '/sys/fs/cgroup',
    procRoot: '/proc',
    env: process.env,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    readdir: (p) => fs.readdirSync(p),
    exists: (p) => fs.existsSync(p),
    pageSize: 4096, // refined lazily below (a member's rss is in pages)
    keeperPidFile: (wsId) => path.join(orchestraHome(), 'keepers', `${wsId}.pid`),
  };
}

let cachedPage: number | null = null;
function systemPageSize(e: ScopeEnv): number {
  if (e.pageSize !== 4096) return e.pageSize;
  if (cachedPage === null) {
    try {
      const pages = Number(e.readFile(`${e.procRoot}/self/statm`).split(' ')[1]);
      const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(e.readFile(`${e.procRoot}/self/status`))?.[1]);
      const raw = (kb * 1024) / pages;
      let p2 = 1024;
      while (Number.isFinite(raw) && p2 * 1.5 < raw) p2 *= 2;
      cachedPage = Number.isFinite(raw) && raw >= 1024 ? p2 : 4096;
    } catch {
      cachedPage = 4096;
    }
  }
  return cachedPage;
}

/** The unit prefix in force (production, or a rig's `ORCHESTRA_MEMORY_SCOPE_PREFIX`). */
export function scopePrefix(e: ScopeEnv = realScopeEnv()): string {
  return sanitizeScopePrefix(e.env[MEMORY_SCOPE_PREFIX_ENV]);
}

/** `/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service` — the user manager's own cgroup. The scope of every member lives under its `app.slice`. */
export function userManagerDir(e: ScopeEnv = realScopeEnv()): string | null {
  if (e.uid === null) return null;
  return path.join(e.cgroupRoot, 'user.slice', `user-${e.uid}.slice`, `user@${e.uid}.service`);
}

export function appSliceDir(e: ScopeEnv = realScopeEnv()): string | null {
  const um = userManagerDir(e);
  return um ? path.join(um, 'app.slice') : null;
}

export type ScopeSupport = { ok: true } | { ok: false; reason: string };

function onPath(bin: string, e: ScopeEnv): boolean {
  for (const dir of (e.env.PATH ?? '').split(path.delimiter)) {
    if (dir && e.exists(path.join(dir, bin))) return true;
  }
  return false;
}

/** Can a keeper be launched in its own user scope with a memory limit on this host? Linux + systemd-run + a reachable user manager that delegates `memory`. */
export function scopeSupport(e: ScopeEnv = realScopeEnv()): ScopeSupport {
  if (e.platform !== 'linux') return { ok: false, reason: `not linux (${e.platform})` };
  if (!onPath('systemd-run', e)) return { ok: false, reason: 'systemd-run not found on PATH' };
  const rt = e.env.XDG_RUNTIME_DIR;
  if (!rt) return { ok: false, reason: 'XDG_RUNTIME_DIR unset — no user manager to talk to' };
  if (!e.exists(path.join(rt, 'bus')) && !e.exists(path.join(rt, 'systemd', 'private'))) return { ok: false, reason: `no user manager socket under ${rt}` };
  const um = userManagerDir(e);
  if (!um || !e.exists(um)) return { ok: false, reason: 'no user@<uid>.service cgroup (cgroup v2 / user manager absent)' };
  let controllers = '';
  try {
    controllers = e.readFile(path.join(um, 'cgroup.controllers'));
  } catch {
    return { ok: false, reason: 'user manager cgroup.controllers unreadable' };
  }
  if (!controllers.split(/\s+/).includes('memory')) return { ok: false, reason: 'the memory controller is not delegated to the user manager' };
  return { ok: true };
}

let supportCache: { at: number; value: ScopeSupport } | null = null;
/** {@link scopeSupport} cached for 30 s (it is asked at every session start). */
export function scopeSupportCached(now = Date.now()): ScopeSupport {
  if (!supportCache || now - supportCache.at > 30_000) supportCache = { at: now, value: scopeSupport() };
  return supportCache.value;
}
export function resetScopeSupportCache(): void {
  supportCache = null;
}

export interface MemberScope {
  unit: string;
  gen: string;
  cgroupDir: string;
  /** The pid-file keeper iff it is a live member of THIS scope (identity re-read from /proc at call time); null otherwise. */
  keeperPid: number | null;
}

function keeperPidIn(wsId: string, cgroupDir: string, e: ScopeEnv): number | null {
  // 1. The pid file's keeper, iff /proc says it lives in THIS scope (a recycled pid in another cgroup is UNKNOWN, not the keeper).
  try {
    const pid = (JSON.parse(e.readFile(e.keeperPidFile(wsId))) as { pid?: unknown }).pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      const cg = parseProcCgroupV2(e.readFile(`${e.procRoot}/${pid}/cgroup`));
      if (cg !== null && path.join(e.cgroupRoot, cg) === cgroupDir) return pid;
    }
  } catch {
    /* no / unreadable pid file, or the pid is gone — fall through */
  }
  // 2. The keeper writes its pid file only AFTER it listens: until then the pid file is absent and a naive resolver would call the keeper AND its CLI Reliquats
  //    (H2's pre-review hazard). The scope's main process IS the keeper (systemd-run exec'd into it), so a member whose argv is `…/keeper.js <wsId> …` is it.
  try {
    for (const raw of e.readFile(path.join(cgroupDir, 'cgroup.procs')).split('\n')) {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      let argv: string[];
      try {
        argv = e.readFile(`${e.procRoot}/${pid}/cmdline`).split('\0').filter(Boolean);
      } catch {
        continue; // vanished between the list and the read
      }
      if (parseKeeperArgv(argv, e.keeperPidFile) === wsId) return pid; // anchored on THIS home's pid-file argument: a dev/other-home keeper never matches
    }
  } catch {
    /* unreadable scope */
  }
  return null; // unknown stays unknown: a consumer that kills must fail closed on it
}

/** FI-1 (a): every scope of `wsId` that still exists — `[]` = "not tracked". Several generations can coexist (an old one kept alive by Reliquats). */
export function memberScopes(wsId: string, e: ScopeEnv = realScopeEnv()): MemberScope[] {
  const slice = appSliceDir(e);
  if (!slice) return [];
  const prefix = scopePrefix(e);
  let names: string[];
  try {
    names = e.readdir(slice);
  } catch {
    return [];
  }
  const out: MemberScope[] = [];
  for (const unit of names) {
    const gen = scopeGenForWorkspace(prefix, wsId, unit);
    if (gen === null) continue;
    const cgroupDir = path.join(slice, unit);
    out.push({ unit, gen, cgroupDir, keeperPid: keeperPidIn(wsId, cgroupDir, e) });
  }
  return out.sort((a, b) => a.gen.localeCompare(b.gen));
}

/** How many member scopes exist on this HOST right now (any workspace, any run — scopes carry no run), and how many of them have NO memory limit applied (not a cap) — the `bus-status` figures. */
export function countMemberScopes(e: ScopeEnv = realScopeEnv()): { total: number; unlimited: number } | null {
  const slice = appSliceDir(e);
  if (!slice) return null;
  const prefix = scopePrefix(e);
  try {
    const mine = e.readdir(slice).filter((u) => parseMemoryScopeUnit(prefix, u) !== null);
    let swapTotalKb: number | null = null;
    try {
      const m = /^SwapTotal:\s+(\d+)\s+kB/m.exec(e.readFile(`${e.procRoot}/meminfo`));
      swapTotalKb = m ? Number(m[1]) : null;
    } catch {
      /* unknown */
    }
    // «Not a cap» = no memory.max, OR the swap escape open (review m4 / re-gate): the keeper reports such a scope `not-applied`, so bus-status must not count it as healthy.
    let unlimited = 0;
    let total = 0;
    for (const u of mine) {
      const dir = path.join(slice, u);
      const mem = readScopeMemory({ cgroupDir: dir }, e);
      let swapText: string | null = null;
      try {
        swapText = e.readFile(path.join(dir, 'memory.swap.max'));
      } catch {
        /* no swap accounting */
      }
      if (!e.exists(dir)) continue; // listed, then gone before/while its files were read (the member exited): neither a scope nor a leak
      total++;
      if (mem === null || mem.maxBytes === null || !swapLimitApplied(swapText, swapTotalKb)) unlimited++; // mem null on a scope that still exists = no memory controller there: not a cap either
    }
    return { total, unlimited };
  } catch {
    return null;
  }
}

function num(e: ScopeEnv, p: string): number | null {
  try {
    const v = e.readFile(p).trim();
    return /^\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

/** FI-1 (b): the scope's memory, read straight from sysfs. `currentBytes` includes page cache (the kernel's own limit decisions use it too). Null = the scope is gone / unreadable. */
export function readScopeMemory(scope: Pick<MemberScope, 'cgroupDir'>, e: ScopeEnv = realScopeEnv()): ScopeMemory | null {
  const d = scope.cgroupDir;
  const current = num(e, path.join(d, 'memory.current'));
  if (current === null) return null;
  let events = null;
  try {
    events = parseMemoryEvents(e.readFile(path.join(d, 'memory.events')));
  } catch {
    /* unreadable */
  }
  const lim = (f: string): number | null => {
    try {
      return parseCgroupLimit(e.readFile(path.join(d, f)));
    } catch {
      return null;
    }
  };
  return {
    currentBytes: current,
    peakBytes: num(e, path.join(d, 'memory.peak')),
    maxBytes: lim('memory.max'),
    highBytes: lim('memory.high'),
    swapMaxBytes: lim('memory.swap.max'),
    swapCurrentBytes: num(e, path.join(d, 'memory.swap.current')),
    workingSetBytes: (() => {
      try {
        const stat = parseMemoryStat(e.readFile(path.join(d, 'memory.stat')));
        return Number.isFinite(stat.inactive_file) ? workingSetBytes(current, stat) : null; // a readable stat WITHOUT inactive_file is not a reading (empty/partial file): unknown, never the raw bill (review)
      } catch {
        return null; // unreadable ⇒ unknown, not « the raw figure »
      }
    })(),
    events: events ?? { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 },
  };
}

/** The parent of any pid on the host, read from /proc (cached per call); null when unreadable / a kernel root. */
function hostParentOf(e: ScopeEnv): (pid: number) => number | null {
  const cache = new Map<number, number | null>();
  return (pid) => {
    if (cache.has(pid)) return cache.get(pid)!;
    let v: number | null = null;
    try {
      const stat = e.readFile(`${e.procRoot}/${pid}/stat`);
      const n = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      v = Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      v = null;
    }
    cache.set(pid, v);
    return v;
  };
}

/**
 * FI-1 v1.9: the processes of the keeper's tree (ppid chain from `scope.keeperPid`, across the WHOLE host) that live OUTSIDE `scope` — they escaped it. Measured: Chromium moves its main process into its own
 * transient scope `app-org.chromium.Chromium-<pid>.scope` through the session bus, leaving the member's cap. [] when the keeper is unknown OR is no longer a member of `scope` (a stale/recycled pid never
 * bills another process's tree). Identity = (pid, startTicks); nothing is signalled here. Cost: one `stat` read per host pid per call — sample it on a slow cadence, not per member per tick.
 */
export function listKeeperTreeOutsideScope(scope: Pick<MemberScope, 'cgroupDir' | 'keeperPid'>, e: ScopeEnv = realScopeEnv()): TreeOutsideScope[] {
  if (scope.keeperPid === null) return [];
  const scopeCg = '/' + path.relative(e.cgroupRoot, scope.cgroupDir);
  try {
    if (parseProcCgroupV2(e.readFile(`${e.procRoot}/${scope.keeperPid}/cgroup`)) !== scopeCg) return [];
  } catch {
    return []; // the keeper is gone
  }
  const kids = new Map<number, number[]>();
  let names: string[];
  try {
    names = e.readdir(e.procRoot);
  } catch {
    return [];
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    try {
      const stat = e.readFile(`${e.procRoot}/${pid}/stat`);
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (Number.isInteger(ppid) && ppid > 0) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
    } catch {
      /* gone */
    }
  }
  const page = systemPageSize(e);
  const out: TreeOutsideScope[] = [];
  const seen = new Set<number>([scope.keeperPid]);
  const queue = [scope.keeperPid];
  while (queue.length && seen.size < 5000) {
    const cur = queue.shift()!;
    for (const kid of kids.get(cur) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      try {
        const stat = e.readFile(`${e.procRoot}/${kid}/stat`);
        const rp = stat.lastIndexOf(')');
        const f = stat.slice(rp + 2).split(' ');
        if (Number(f[1]) !== cur) continue; // the pid was recycled since the ppid snapshot: not a child of the node we walked from
        queue.push(kid);
        const cg = parseProcCgroupV2(e.readFile(`${e.procRoot}/${kid}/cgroup`));
        if (cg === null || cg === scopeCg) continue;
        const statm = e.readFile(`${e.procRoot}/${kid}/statm`).split(' ');
        let cmdline = '';
        try {
          cmdline = e.readFile(`${e.procRoot}/${kid}/cmdline`).replace(/\0/g, ' ').trim();
        } catch {
          /* gone */
        }
        out.push({ pid: kid, startTicks: Number(f[19]), ppid: Number(f[1]), comm: stat.slice(stat.indexOf('(') + 1, rp), cmdline, rssBytes: (Number(statm[1]) || 0) * page, cgroup: cg });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/** FI-1 (c): the scope's processes with their role. Identity = (pid, startTicks); a process that vanishes mid-read is skipped. `cliPid` is the keeper's CLI child when the caller knows it (helloAck.pid). */
export function listScopeProcs(scope: Pick<MemberScope, 'cgroupDir' | 'keeperPid'>, cliPid: number | null = null, e: ScopeEnv = realScopeEnv()): ClassifiedMember[] {
  let pids: number[];
  try {
    pids = e.readFile(path.join(scope.cgroupDir, 'cgroup.procs')).split('\n').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
  const page = systemPageSize(e);
  const members: ScopeMember[] = [];
  for (const pid of pids) {
    try {
      const stat = e.readFile(`${e.procRoot}/${pid}/stat`);
      const rp = stat.lastIndexOf(')');
      const f = stat.slice(rp + 2).split(' ');
      const statm = e.readFile(`${e.procRoot}/${pid}/statm`).split(' ');
      let cmdline = '';
      try {
        cmdline = e.readFile(`${e.procRoot}/${pid}/cmdline`).replace(/\0/g, ' ').trim();
      } catch {
        /* kernel thread / gone */
      }
      members.push({ pid, startTicks: Number(f[19]), ppid: Number(f[1]), comm: stat.slice(stat.indexOf('(') + 1, rp), cmdline, rssBytes: (Number(statm[1]) || 0) * page });
    } catch {
      /* vanished between the list and the read */
    }
  }
  // FI-1 (c): the CLI is the keeper's direct child. The caller may know it (helloAck.pid); otherwise it is the keeper's ONLY direct child in this scope (two or none ⇒ unknown, never a guess).
  let cli = cliPid;
  if (cli === null && scope.keeperPid !== null) {
    const kids = members.filter((m) => m.ppid === scope.keeperPid);
    if (kids.length === 1) cli = kids[0].pid;
  }
  // v1.9: the chain is walked across the WHOLE host (a helper whose parent left the scope is still the session's), not only inside the member set.
  return classifyScopeMembers(members, scope.keeperPid, cli, hostParentOf(e));
}
