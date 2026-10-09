// Pause canary 1b (#324) — OS-level readers shared by the stand-in driver (memhog.mjs) and the packaged-app exercise (drive.mjs `memhog-app`): facts read from /proc, cgroupfs and systemd, never from the subject's own opinion.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
/** /proc start time in ticks: with the pid it is the process IDENTITY (a recycled pid has another start time). */
export const ticks = (pid) => { const s = readSafe(`/proc/${pid}/stat`); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] : null; };
export const ident = (pid) => (pid ? `${pid}:${ticks(pid)}` : null);
/** alive = exists and not a zombie */
export const alive = (pid) => { if (!pid) return false; const s = readSafe(`/proc/${pid}/stat`); return !!s && s.slice(s.lastIndexOf(')') + 2)[0] !== 'Z'; };
export const cgOf = (pid) => { const t = readSafe(`/proc/${pid}/cgroup`); const l = t?.split('\n').find((x) => x.startsWith('0::')); return l ? l.slice(3) : null; };
export const cgDir = (pid) => { const c = cgOf(pid); return c ? path.join('/sys/fs/cgroup', c) : null; };
export const eventsOf = (dir) => Object.fromEntries((readSafe(path.join(dir, 'memory.events')) ?? '').trim().split('\n').filter(Boolean).map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
export const unitsNow = (glob) => (spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
export const unitActive = (unit) => !!unit && spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).stdout.trim() === 'active';
export const hostAvailGB = () => Number(/MemAvailable:\s+(\d+) kB/.exec(readSafe('/proc/meminfo') ?? '')?.[1] ?? 0) / 1048576;

/** The scope facts of a keeper pid (null fields when it is in no scope / the pid is gone): what `scopeWhy` in memhog-bars.mjs judges. `unitPrefix` = the rig prefix a scope must carry. */
export function scopeFactsOf(keeperPid, unitPrefix) {
  const dir = keeperPid && alive(keeperPid) ? cgDir(keeperPid) : null;
  const unit = dir && dir.endsWith('.scope') ? path.basename(dir) : null;
  const rd = (f) => (dir ? readSafe(path.join(dir, f))?.trim() ?? null : null);
  return {
    inRig: !!unit && unit.startsWith(unitPrefix), unit, cgroup: dir ? cgOf(keeperPid) : null,
    memoryMax: dir && rd('memory.max') !== null ? Number(rd('memory.max')) : null, swapMax: rd('memory.swap.max'), high: rd('memory.high'),
    policy: unit ? spawnSync('systemctl', ['--user', 'show', '-p', 'OOMPolicy', '--value', unit], { encoding: 'utf8' }).stdout.trim() : null,
  };
}
/** `oom_kill` of the keeper's cgroup (hierarchical memory.events), or null when unreadable. */
export const oomKillOf = (keeperPid) => { const d = keeperPid && alive(keeperPid) ? cgDir(keeperPid) : null; return d ? eventsOf(d).oom_kill ?? null : null; };

/** The pid chain from `pid` up to init (the processes that LAUNCHED us — a wrapper carrying the scratch path in its argv is one of them and is never ours to signal). */
export function ancestorsOf(pid = process.pid) {
  const out = new Set();
  for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
    out.add(p);
    const s = readSafe(`/proc/${p}/stat`);
    if (!s) break;
    p = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return out;
}

/** The rig's own processes: those whose ENVIRONMENT carries exactly `ORCHESTRA_HOME=<home>` — the marker every process the drill starts (keeper, CLI, tools, their children) inherits. NOT a substring match on argv/environ: a wrapper
 *  (`timeout`, `bash -c`, `pnpm`) or a sibling rig whose directory merely CONTAINS this path must never be signalled. Returns [{pid, ticks}] (identity: pid + /proc start time); our own pid, our ancestors and `except` are left out. */
export function rigProcesses(home, except = new Set()) {
  const skip = new Set([...ancestorsOf(), ...except]);
  const want = `ORCHESTRA_HOME=${home}`;
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    const env = readSafe(`/proc/${pid}/environ`);
    if (env && env.split('\0').includes(want)) out.push({ pid, ticks: ticks(pid) });
  }
  return out;
}

/** SIGKILL each listed process whose identity (pid + start time) AND marker are still the same right now. Returns the pids signalled. */
export function killByIdentity(list, home) {
  const want = `ORCHESTRA_HOME=${home}`;
  const done = [];
  for (const { pid, ticks: t } of list) {
    if (ticks(pid) !== t || !(readSafe(`/proc/${pid}/environ`) ?? '').split('\0').includes(want)) continue;
    try { process.kill(pid, 'SIGKILL'); done.push(pid); } catch { /* gone */ }
  }
  return done;
}
