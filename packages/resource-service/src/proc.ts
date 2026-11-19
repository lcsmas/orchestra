// Process identity and signalling. A process is `pid + /proc/<pid>/stat starttime` (pids are reused); EVERY signal re-reads that identity right before
// sending. Never `pgrep -f`, never pid <= 1, never the caller's own process group.
import fs from 'node:fs';

export type Identity = { pid: number; startTime: number };
export type Stat = { pid: number; state: string; ppid: number; pgrp: number; startTime: number };
export type SignalResult = 'sent' | 'gone' | 'refused';

/** Parse `/proc/<pid>/stat`; null when the process does not exist. `comm` may hold spaces and parens, so cut at the LAST `)`. */
export function readStat(pid: number): Stat | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const f = raw.slice(close + 2).split(' '); // f[0] = state (field 3)
  const startTime = Number(f[19]); // field 22
  if (!Number.isFinite(startTime)) return null;
  return { pid, state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), startTime };
}

/** Identity of a running process, or null when it is gone (a zombie counts as gone). */
export function identityOf(pid: number): Identity | null {
  const s = readStat(pid);
  return s && s.state !== 'Z' && s.state !== 'X' ? { pid, startTime: s.startTime } : null;
}

/** The very process this identity names is still running. */
export function isAlive(id: Identity): boolean {
  const s = readStat(id.pid);
  return !!s && s.startTime === id.startTime && s.state !== 'Z' && s.state !== 'X';
}

let boot: string | null | undefined;
/** The kernel boot id (stable until reboot), or null when unreadable. */
export function bootId(): string | null {
  if (boot === undefined) {
    try {
      boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      boot = null;
    }
  }
  return boot;
}

export function ownPgid(): number {
  return readStat(process.pid)?.pgrp ?? -1;
}

/** Numeric entries of /proc. */
export function listPids(): number[] {
  try {
    return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
  } catch {
    return [];
  }
}

/** The environment of a process (initial exec env), or null when unreadable. */
export function readEnviron(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    return null;
  }
}

/** Is it ever OK to signal this process? Refuses init, the caller and anything in the caller's own group. */
function mayTouch(s: Stat): boolean {
  return s.pid > 1 && s.pgrp > 1 && s.pid !== process.pid && s.pgrp !== ownPgid();
}

/** May the caller ever signal this process (not init, not itself, not in its own group)? */
export function touchable(id: Identity): boolean {
  const s = readStat(id.pid);
  return !!s && s.startTime === id.startTime && mayTouch(s);
}

/** Signal ONE process, only if it is still the process `id` names and it is safe to touch. */
export function signalIfSame(id: Identity, sig: NodeJS.Signals): SignalResult {
  const s = readStat(id.pid);
  if (!s || s.startTime !== id.startTime || s.state === 'Z' || s.state === 'X') return 'gone';
  if (!mayTouch(s)) return 'refused';
  try {
    process.kill(id.pid, sig);
    return 'sent';
  } catch {
    return 'gone';
  }
}

/** A recorded lane leader's group is ours to signal: the leader is the same process and still leads its group, or it is gone while members remain. */
export function groupIsOurs(leader: Identity): 'ours' | 'empty' | 'foreign' {
  const s = readStat(leader.pid);
  if (s && s.state !== 'X' && s.state !== 'Z') { // a zombie leader leads nothing: only its members count (below)
    if (s.startTime !== leader.startTime || s.pgrp !== leader.pid) return 'foreign'; // pid reused, or the leader left its group
    return 'ours';
  }
  // Leader gone: the kernel never reuses a pid that is still a group id, so a group `leader.pid` that still has members is the old one.
  return groupMembers(leader.pid).length > 0 ? 'ours' : 'empty';
}

/** Identities of every live process whose process group is one of `pgids` (one /proc pass). */
export function groupMembers(...pgids: number[]): Identity[] {
  const want = new Set(pgids);
  const out: Identity[] = [];
  if (want.size === 0) return out;
  for (const pid of listPids()) {
    const s = readStat(pid);
    if (s && want.has(s.pgrp) && s.state !== 'Z' && s.state !== 'X') out.push({ pid, startTime: s.startTime });
  }
  return out;
}

/** Signal a whole recorded lane group in one atomic `kill(-pgid)` — only when the group is verifiably ours and not the caller's. */
export function signalGroupIfOurs(leader: Identity, sig: NodeJS.Signals): SignalResult {
  if (leader.pid <= 1 || leader.pid === ownPgid()) return 'refused';
  const v = groupIsOurs(leader);
  if (v === 'empty') return 'gone';
  if (v === 'foreign') return 'refused';
  try {
    process.kill(-leader.pid, sig);
    return 'sent';
  } catch {
    return 'gone';
  }
}

/** Every live process whose initial environment carries `KEY=value` (the run marker). Skips the caller. */
export function findByEnv(key: string, value: string): Identity[] {
  const needle = `${key}=${value}`;
  const out: Identity[] = [];
  for (const pid of listPids()) {
    if (pid === process.pid) continue;
    const env = readEnviron(pid);
    if (!env || !env.includes(needle)) continue;
    const s = readStat(pid);
    if (s && s.state !== 'Z' && s.state !== 'X') out.push({ pid, startTime: s.startTime });
  }
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
