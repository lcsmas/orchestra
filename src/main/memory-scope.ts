// Plafond mémoire — resolve / read a member's kernel scope (#320, ledger FI-1 a/b/c/d). Electron-free: node --test drives it against a fake cgroup tree.
// Pure half: src/shared/memory-scope.ts. The kill WATCH is the keeper's (src/keeper/memory-watch.ts); this module only READS sysfs, so it answers the
// same after an app restart and after the keeper died (Reliquats only): the directory under the user manager's app.slice is the truth, there is no registry.

import fs from 'node:fs';
import path from 'node:path';
import { orchestraHome } from './platform/index.ts';
import {
  MEMORY_SCOPE_PREFIX_ENV,
  classifyScopeMembers,
  parseCgroupLimit,
  parseMemoryEvents,
  parseProcCgroupV2,
  sanitizeScopePrefix,
  scopeGenForWorkspace,
  parseMemoryScopeUnit,
  type ClassifiedMember,
  type ScopeMember,
  type ScopeMemory,
} from '../shared/memory-scope.ts';

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
  try {
    const pid = (JSON.parse(e.readFile(e.keeperPidFile(wsId))) as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    const cg = parseProcCgroupV2(e.readFile(`${e.procRoot}/${pid}/cgroup`));
    return cg !== null && path.join(e.cgroupRoot, cg) === cgroupDir ? pid : null;
  } catch {
    return null; // gone / not ours / unreadable = UNKNOWN, never "the keeper"
  }
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

/** How many member scopes exist right now (any workspace) — the `bus-status` count. */
export function countMemberScopes(e: ScopeEnv = realScopeEnv()): number | null {
  const slice = appSliceDir(e);
  if (!slice) return null;
  const prefix = scopePrefix(e);
  try {
    return e.readdir(slice).filter((u) => parseMemoryScopeUnit(prefix, u) !== null).length;
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
    events: events ?? { high: 0, max: 0, oom: 0, oomKill: 0, oomGroupKill: 0 },
  };
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
  return classifyScopeMembers(members, scope.keeperPid, cliPid);
}
