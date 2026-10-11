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

// ── the scope's LAYOUT (#332, Q9): a scope is flat (the keeper sits in it, one limit) or has two LEAVES — `k` (keeper + CLI, no limit) and `w` (the tool commands; carries the member's HARD level and its kill counters, the scope's own
//    limit being only a backstop). Every reader below accepts BOTH: the keeper's cgroup is the scope or one of its leaves; the cgroup that CARRIES the cap is `<scope>/w` when it exists, else the scope.
//    The leaf names are pinned against src/shared/memory-scope.ts (SCOPE_LEAVES) by pause-canary-memhog-os.test.ts as soon as that module has them.
export const SCOPE_LEAVES = ['k', 'w'];
export const WORK_LEAF = 'w';
export const KEEPER_LEAF = 'k';
/** `.../<unit>.scope/<leaf>` → the scope's own directory; any other path is returned as is (a flat scope, a plain cgroup, null). */
export const scopeDirOf = (dir) => (dir && SCOPE_LEAVES.includes(path.basename(dir)) && path.basename(path.dirname(dir)).endsWith('.scope') ? path.dirname(dir) : dir ?? null);
/** The cgroup that carries the member's hard level and its `oom_kill` counter: the work leaf when the scope has one, else the scope itself. */
export const capCarrierOf = (scopeDir, exists = fs.existsSync) => (scopeDir && exists(path.join(scopeDir, WORK_LEAF)) ? path.join(scopeDir, WORK_LEAF) : scopeDir ?? null);
/** The scope directory of a (live) keeper pid, whether the keeper sits in the scope or in its keeper leaf; null when the pid is gone. */
export const scopeDirOfPid = (pid) => { const d = pid && alive(pid) ? cgDir(pid) : null; return d ? scopeDirOf(d) : null; };

/** The scope facts of a scope directory (null fields when it is in no scope): what `scopeWhy` in memhog-bars.mjs judges. `memoryMax` is the limit of the cgroup that CARRIES the cap (the work leaf when there is one), `swapMax`/`high`/policy
 *  are the scope's (systemd sets them on the unit). `unitPrefix` = the rig prefix a scope must carry; `read`/`exists`/`policyOf` are injectable for the unit test. */
export function scopeFactsFromDir(dir, unitPrefix, { read = readSafe, exists = fs.existsSync, policyOf = (u) => spawnSync('systemctl', ['--user', 'show', '-p', 'OOMPolicy', '--value', u], { encoding: 'utf8' }).stdout.trim() } = {}) {
  const unit = dir && dir.endsWith('.scope') ? path.basename(dir) : null;
  const carrier = capCarrierOf(dir, exists);
  const rd = (f, d = dir) => (d ? read(path.join(d, f))?.trim() ?? null : null);
  const max = rd('memory.max', carrier);
  return {
    inRig: !!unit && unit.startsWith(unitPrefix), unit, cgroup: dir ? dir.replace(/^\/sys\/fs\/cgroup/, '') : null,
    memoryMax: max !== null ? Number(max) : null, swapMax: rd('memory.swap.max'), high: rd('memory.high'),
    layout: !dir ? null : carrier === dir ? 'flat' : 'leaves',
    policy: unit ? policyOf(unit) : null,
  };
}
export const scopeFactsOf = (keeperPid, unitPrefix, deps) => scopeFactsFromDir(scopeDirOfPid(keeperPid), unitPrefix, deps);
/** `oom_kill` of the cgroup that carries the cap (hierarchical `memory.events`), or null when unreadable — a flat scope's own counter, or the work leaf's (the keeper leaf's would always read 0). */
/** #343: the `oom_kill` counters that tell a SCOPE-BACKSTOP episode from the work leaf's hard-level kills — {k (keeper leaf), scope (hierarchical: includes k and w), work (the cap carrier)}; null = any counter unreadable. A flat scope has no keeper leaf: k is 0 and the scope's counter IS the work one. */
export function backstopCountersFromDir(scopeDir, exists = fs.existsSync) {
  if (!scopeDir) return null;
  const kills = (d) => { const v = eventsOf(d).oom_kill; return Number.isFinite(v) ? v : null; };
  const leaves = exists(path.join(scopeDir, WORK_LEAF));
  const scope = kills(scopeDir);
  const c = { k: leaves ? kills(path.join(scopeDir, KEEPER_LEAF)) : 0, scope, work: leaves ? kills(path.join(scopeDir, WORK_LEAF)) : scope, layout: leaves ? 'leaves' : 'flat' };
  return [c.k, c.scope, c.work].every(Number.isFinite) ? c : null;   // COMPLETE or nothing: a half reading must never replace the last good one (review 4, m1)
}
export const oomKillFromDir = (scopeDir) => { const d = capCarrierOf(scopeDir); return d ? eventsOf(d).oom_kill ?? null : null; };
export const oomKillOf = (keeperPid) => oomKillFromDir(scopeDirOfPid(keeperPid));

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

/** The environment the stand-in CLI is spawned with (through the keeper, which passes EXACTLY this env on): it MUST carry `ORCHESTRA_HOME=<home>` — the marker `rigProcesses` / `killByIdentity` / the survivors count select on — or the CLI and every tool
 *  it runs are invisible to teardown and to `bar:no_survivors` (#324 review 2, finding 4). */
export const standinCliEnv = (home, rssMb) => ({ PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, SHELL: process.env.SHELL ?? '/bin/bash', STANDIN_CLI_RSS_MB: String(rssMb) });

/** The keeper's own log of a workspace (`<ORCHESTRA_HOME>/keepers/<ws>.log`, with the rotated `.log.old` first): where the post-boot cap-state flips are written (#332-fu). */
export const keeperLogText = (orchestraHome, wsId, read = readSafe) => ['.log.old', '.log'].map((x) => read(path.join(orchestraHome, 'keepers', `${wsId}${x}`)) ?? '').join('\n');

/** The hog tools of a rig, for the FLOOR guard (review 4, M1): processes whose working directory lies under the rig dir (the workers' worktrees) and whose argv runs `swarm.py` — [{pid, ticks}]. */
export function hogProcesses(rigDir, { readCmd = (pid) => readSafe(`/proc/${pid}/cmdline`), cwdOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }, ticksOf = ticks } = {}) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const cwd = cwdOf(pid);
    if (!cwd || !(cwd + path.sep).startsWith(rigDir + path.sep)) continue;
    if ((readCmd(pid) ?? '').split('\0').some((a) => /(^|\/)swarm\.py$/.test(a))) out.push({ pid, ticks: ticksOf(pid) });
  }
  return out;
}
/** SIGKILL the rig's hog tools — identity (pid + start time) re-read at signal time. Returns the pids signalled. */
export function killHogs(rigDir, deps = {}) {
  const done = [];
  const ticksOf = deps.ticksOf ?? ticks;
  for (const { pid, ticks: t } of hogProcesses(rigDir, deps)) {
    if (ticksOf(pid) !== t) continue;
    try { process.kill(pid, 'SIGKILL'); done.push(pid); } catch { /* gone */ }
  }
  return done;
}
/** Am I inside a capped member's WORK leaf, or at oom_score_adj > 0? Then a rig started from here would sit in that leaf's limit / be the kernel's first victim (review 4, m6): null = fine, else why not. */
export function ownPlacementWhy({ cgroupText = readSafe('/proc/self/cgroup'), adjText = readSafe('/proc/self/oom_score_adj') } = {}) {
  const cg = (cgroupText ?? '').split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? '';
  if (SCOPE_LEAVES.includes(path.basename(cg)) && path.basename(path.dirname(cg)).endsWith('.scope')) return `this process runs inside ${cg}: a rig started from here would live in that member scope's leaf`;
  const adjRaw = String(adjText ?? '').trim();
  if (!/^-?\d+$/.test(adjRaw)) return 'oom_score_adj unreadable';
  const adj = Number(adjRaw);
  return adj > 0 ? `oom_score_adj is ${adj}: the rig's processes would inherit it and be the kernel's first victims` : null;
}
