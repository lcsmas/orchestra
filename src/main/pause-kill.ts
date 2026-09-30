// Pause trap — process-kill I/O half (#252 D1b, LEAD ruling D4). Decisions live in
// src/shared/pause-procs.ts; this file reads /proc FRESH, signals, and reports. It
// never signals the CLI, its keeper or the app, and every signal is preceded by an
// identity re-read of THAT pid (pid + start-time + lineage under the CLI). Linux only:
// elsewhere there is no start-time identity, so it fails closed and kills nothing.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  killOrder,
  parseProcIdent,
  planToolTrees,
  verifyAtSignal,
  type FreshRead,
  type ProcIdent,
  type RootRef,
  type SparedProc,
  type ToolPlan,
  type ToolProc,
} from '../shared/pause-procs.ts';

export interface KillDeps {
  /** Full process table, read NOW. [] when unsupported. */
  readTable(): ProcIdent[];
  /** ONE pid, read NOW (the signal-time identity re-read). */
  read(pid: number): FreshRead;
  /** `/proc/<pid>/cwd`, read NOW (null = unreadable/gone). */
  readCwd(pid: number): string | null;
  /** `CLAUDE_PID` from /proc/<pid>/environ, read NOW (null = absent, 'unreadable' = fail closed). */
  readClaudePid(pid: number): number | null | 'unreadable';
  /** Epoch ms a process with this /proc start-time began (boot time + ticks / CLK_TCK). */
  startMs(startTicks: number): number;
  /** Deliver a signal; false when it was not delivered (ESRCH/EPERM). */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  selfPid: number;
  supported: boolean;
}

export interface KilledProc {
  pid: number;
  comm: string;
  cmd: string;
  startTicks: number;
  /** Working directory read at plan time (before the signal). */
  cwd: string | null;
  /** What the signal-time identity re-read proved for THIS process — the Bilan's "reason matched". */
  evidence: string;
  /** The last signal sent (SIGKILL only when SIGTERM left it alive). */
  signal: 'SIGTERM' | 'SIGKILL';
  via: string;
  /** exited = gone or zombie at the final census; survived = still the same live process. */
  outcome: 'exited' | 'survived';
}

export interface KillReport {
  cliPid: number;
  /** The CLI identity every provenance proof was made against (pid + /proc start-time). */
  cli: RootRef;
  killed: KilledProc[];
  /** Planned tool processes the identity re-read REFUSED to signal (reused/unreadable/…): never killed. */
  refused: Array<{ pid: number; comm: string; cmd: string; reason: string }>;
  /** Children of the CLI that are not tool shells (MCP servers etc.): left alone. */
  spared: SparedProc[];
  /** Tool-tree members still alive after the last round (same identity). */
  survivors: Array<{ pid: number; comm: string; cmd: string; reason: string }>;
  rounds: number;
  /** The pause was lifted/re-written while killing: the remaining signals were NOT sent. */
  aborted?: 'lifted';
  error?: string;
}

export interface KillOptions {
  termGraceMs?: number;
  maxRounds?: number;
  /** Re-checked before EVERY round and every signal: false ⇒ stop at once (a lift/re-pause must not cost the released turn its first tool — review F8). */
  stillPaused?: () => boolean;
  /** Only processes that started BEFORE this epoch-ms are targets (a HUMAN turn that began during the trap is allowed to run — D9, review F2). */
  startedBeforeMs?: number;
  /** Tool-shell roots whose whole tree is SPARED (the tree that contains the `orchestra run pause` call — pauser exemption, review F5). */
  spareRoots?: readonly number[];
}

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_ROUNDS = 3;
const POLL_MS = 50;

let bootMs: number | null = null;
let clkTck = 100;
function startMsOf(startTicks: number): number {
  if (bootMs === null) {
    try {
      const m = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
      bootMs = m ? Number(m[1]) * 1000 : 0;
    } catch {
      bootMs = 0;
    }
    try {
      const t = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }).trim());
      if (Number.isFinite(t) && t > 0) clkTck = t;
    } catch {
      /* 100 is the Linux default */
    }
  }
  return bootMs + (startTicks * 1000) / clkTck;
}

function readCwdOf(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function readClaudePidOf(pid: number): number | null | 'unreadable' {
  try {
    const m = /(?:^|\0)CLAUDE_PID=(\d+)(?:\0|$)/.exec(fs.readFileSync(`/proc/${pid}/environ`, 'latin1'));
    return m ? Number(m[1]) : null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? null : 'unreadable';
  }
}

function readOne(pid: number): FreshRead {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unreadable';
  }
  let cmd: string | null = null;
  try {
    cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    cmd = null;
  }
  const p = parseProcIdent(stat, cmd);
  return p ?? 'unreadable';
}

export function realKillDeps(): KillDeps {
  const supported = process.platform === 'linux';
  return {
    supported,
    selfPid: process.pid,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    read: (pid) => (supported ? readOne(pid) : 'unreadable'),
    readClaudePid: (pid) => (supported ? readClaudePidOf(pid) : 'unreadable'),
    readCwd: (pid) => (supported ? readCwdOf(pid) : null),
    startMs: startMsOf,
    readTable: () => {
      if (!supported) return [];
      const out: ProcIdent[] = [];
      let names: string[];
      try {
        names = fs.readdirSync('/proc');
      } catch {
        return out;
      }
      for (const n of names) {
        if (!/^\d+$/.test(n)) continue;
        const r = readOne(Number(n));
        if (r !== 'gone' && r !== 'unreadable') out.push(r);
      }
      return out;
    },
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function isAlive(m: ToolProc, deps: KillDeps): boolean {
  const f = deps.read(m.pid);
  return f !== 'gone' && f !== 'unreadable' && f.startTicks === m.startTicks && f.state !== 'Z';
}

async function waitUntilGone(members: ToolProc[], deps: KillDeps, graceMs: number): Promise<void> {
  const until = deps.now() + graceMs;
  while (deps.now() < until && members.some((m) => isAlive(m, deps))) await deps.sleep(POLL_MS);
}

/**
 * Kill every tool process tree under `cli` (a caller-verified CLI identity). `keeperPid` is
 * protected along with the CLI and the app. Re-plans each round from a fresh table so a tool
 * the model started while we were killing is caught; bounded by `maxRounds`.
 */
export async function killToolTrees(
  cli: RootRef,
  keeperPid: number | null,
  deps: KillDeps,
  opts: KillOptions = {},
): Promise<KillReport> {
  const report: KillReport = { cliPid: cli.pid, cli, killed: [], refused: [], spared: [], survivors: [], rounds: 0 };
  if (!deps.supported) {
    report.error = 'process identity (/proc start-time) unavailable on this platform — nothing killed (fail closed)';
    return report;
  }
  const protect = { keeperPid, selfPid: deps.selfPid };
  const killed = new Map<string, KilledProc>(); // key pid:startTicks
  const refused = new Map<string, KillReport['refused'][number]>();
  const spared = new Map<number, SparedProc>();
  const maxRounds = opts.maxRounds ?? DEFAULT_ROUNDS;
  const grace = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const priorRoots = new Map<number, RootRef>();
  const planOpts = () => ({
    priorRoots: [...priorRoots.values()],
    claudePidOf: (p: ProcIdent) => {
      const r = deps.readClaudePid(p.pid);
      return typeof r === 'number' ? r : null;
    },
    cwdOf: (p: ProcIdent) => deps.readCwd(p.pid),
  });
  const planNow = (): ToolPlan => {
    const pl = planToolTrees(deps.readTable(), cli, planOpts());
    for (const m of pl.members) if (m.isRoot) priorRoots.set(m.pid, { pid: m.pid, startTicks: m.startTicks });
    if (opts.spareRoots?.length) {
      const sp = new Set(opts.spareRoots);
      const keep: ToolProc[] = [];
      for (const m of pl.members) {
        if (sp.has(m.pid) || sp.has(m.rootPid)) pl.spared.push({ pid: m.pid, comm: m.comm, cmd: m.cmd, reason: 'the tool tree that issued `orchestra run pause` (pauser exemption by process ancestry)' });
        else keep.push(m);
      }
      pl.members = keep;
    }
    if (opts.startedBeforeMs !== undefined) {
      const before = opts.startedBeforeMs;
      const keep: ToolProc[] = [];
      for (const m of pl.members) {
        if (deps.startMs(m.startTicks) < before) keep.push(m);
        else pl.spared.push({ pid: m.pid, comm: m.comm, cmd: m.cmd, reason: 'started after a HUMAN turn began during the trap — the human prompt is allowed (D9)' });
      }
      pl.members = keep;
    }
    return pl;
  };
  const paused = (): boolean => {
    if (opts.stillPaused && !opts.stillPaused()) {
      report.aborted = 'lifted';
      return false;
    }
    return true;
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (!paused()) break;
    const plan: ToolPlan = planNow();
    for (const s of plan.spared) spared.set(s.pid, s);
    if (plan.members.length === 0) break;
    report.rounds = round;
    let signalled = 0;
    const termed: ToolProc[] = [];
    for (const m of killOrder(plan.members)) {
      if (!paused()) break;
      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);
      if (!v.ok) {
        if (v.reason !== 'gone' && v.reason !== 'zombie') {
          refused.set(`${m.pid}:${m.startTicks}`, { pid: m.pid, comm: m.comm, cmd: m.cmd, reason: v.reason });
        }
        continue;
      }
      if (deps.signal(m.pid, 'SIGTERM')) {
        signalled++;
        termed.push(m);
        killed.set(`${m.pid}:${m.startTicks}`, {
          pid: m.pid, comm: m.comm, cmd: m.cmd, startTicks: m.startTicks, cwd: m.cwd, evidence: `${m.matched} | ${v.evidence}`, signal: 'SIGTERM', via: v.via, outcome: 'exited',
        });
      }
    }
    await waitUntilGone(termed, deps, grace);
    for (const m of killOrder(termed)) {
      if (!isAlive(m, deps)) continue;
      if (!paused()) break;
      // SIGTERM was ignored/slow: escalate — after a SECOND identity re-read of this pid.
      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);
      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {
        const k = killed.get(`${m.pid}:${m.startTicks}`);
        if (k) k.signal = 'SIGKILL';
      }
    }
    await waitUntilGone(termed, deps, 500);
    if (signalled === 0) break; // nothing provable to signal: more rounds cannot change that
  }

  const finalPlan = planNow();
  for (const s of finalPlan.spared) spared.set(s.pid, s);
  const aliveKeys = new Set(finalPlan.members.map((m) => `${m.pid}:${m.startTicks}`));
  for (const [key, k] of killed) k.outcome = aliveKeys.has(key) ? 'survived' : 'exited';
  report.killed = [...killed.values()];
  report.refused = [...refused.values()];
  report.spared = [...spared.values()];
  report.survivors = finalPlan.members.map((m) => ({
    pid: m.pid,
    comm: m.comm,
    cmd: m.cmd,
    reason: refused.get(`${m.pid}:${m.startTicks}`)?.reason ?? 'still-alive-after-kill',
  }));
  return report;
}
