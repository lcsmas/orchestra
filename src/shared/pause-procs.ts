// Pause trap — PURE process-tree half (#252 D1b, LEAD ruling D4). Dependency-free so
// `node --test` covers the decisions without a real /proc.
//
// D4: kill ONLY tool process trees, by identity re-read AT SIGNAL TIME (pid + /proc
// start-time + ancestry under the session's CLI), fail closed when unreadable, and
// NEVER the CLI or its keeper. A "tool" = a direct child of the CLI that is a shell
// run with `-c` (how the CLI runs Bash-tool commands, background tasks and hooks) and
// everything in its tree. MCP servers and other non-shell sidecars are SPARED and listed.
//
// Orphans: a job a tool backgrounded (`cmd &`, `nohup cmd &`) that outlived its shell is
// reparented away from the CLI, so the ppid chain cannot prove it is ours. Two lineage
// proofs survive that (each re-read at signal time): (1) SESSION — each tool shell leads
// its own session (sid == pid, measured) and the kernel never reuses a pid number while
// it is still a session id of a live process, so `sid == root.pid` keeps proving it while
// the root is alive or known from an earlier round; (2) ENV — the CLI exports
// `CLAUDE_PID=<its pid>` to every tool it runs (measured, inherited by all descendants,
// immutable after exec), and the orphan must have started AFTER the CLI. A process with
// neither proof (scrubbed env, root long dead) is left alone: fail closed.

import { parseProcIdentity } from './resources.ts';

export interface ProcIdent {
  pid: number;
  ppid: number;
  /** Session id (/proc stat field 6). */
  sid: number;
  /** /proc stat field 22 — with `pid` the process identity (a recycled pid differs). */
  startTicks: number;
  comm: string;
  /** One-letter /proc state; `Z` = zombie (already dead, nothing to signal). */
  state: string;
  argv: string[] | null;
}

/** The CLI whose tool trees are planned (pid + start-time, verified by the caller). */
export interface RootRef {
  pid: number;
  startTicks: number;
}

export interface ToolProc {
  pid: number;
  ppid: number;
  sid: number;
  startTicks: number;
  comm: string;
  cmd: string;
  /** Pid of the tool shell that roots this process's tree (itself for a root). */
  rootPid: number;
  /** True when the root is its own session leader (sid == pid) — enables the session lineage. */
  rootIsSessionLeader: boolean;
  /** The root's /proc start-time as it was PLANNED (also for a root that is dead by now): the session lineage is only provable against it (review F9). */
  rootStartTicks: number | undefined;
  isRoot: boolean;
  /** Distance below the root (0 = root); orphans that only match by session/env get a large depth. */
  depth: number;
  /** How the planner attached it: the ppid tree under a tool shell, a session orphan, or an env-proven orphan. */
  via: 'tree' | 'session' | 'env';
  /** `/proc/<pid>/cwd` read at PLAN time (before any signal), for the Bilan. */
  cwd: string | null;
  /** Why the planner attached it (the evidence string the Bilan lists; the signal-time re-read adds its own). */
  matched: string;
}

/**
 * Another SESSION's supervisor — never a tool. The Orchestra keeper daemon (`keeper.js`), a `claude` CLI and the Orchestra/Electron binary:
 * a daemonized app launched from a tool (no `env -i`) carries `CLAUDE_PID=<paused CLI>` into every keeper/CLI/helper it spawns, so the
 * orphan provenance proofs would reach them. They are spared and listed (review F1, LEAD D4 "never the CLI or keeper" for EVERY session).
 */
export function isSupervisorProc(p: Pick<ProcIdent, 'argv' | 'comm'>): boolean {
  const argv = p.argv ?? [];
  if (argv.some((a) => baseName(a) === 'keeper.js')) return true;
  const a0 = baseName(argv[0] ?? '').replace(/^-/, '');
  if (a0 === 'claude' || p.comm === 'claude') return true;
  if (/^(orchestra|Orchestra\.AppImage|electron)$/i.test(a0) || /\.mount_Orches/.test(argv[0] ?? '')) {
    // `Orchestra.AppImage cli <verb>` is the `orchestra` CLI CLIENT (a short-lived tool of some session), not the app's main process (review: pre-review M2).
    return argv.slice(1).find((a) => !a.startsWith('-')) !== 'cli';
  }
  return false;
}

/**
 * Does `p` sit UNDER another session's supervisor (keeper / claude CLI / Orchestra app)? Walks the ppid chain hop by hop through `read`
 * (a fresh /proc read at signal time, the planner's table at plan time). The paused member's own CLI is skipped. 'unknown' = a hop could
 * not be read (fail closed: treated as "yes" by callers that refuse on anything but 'no'). Bounded depth.
 */
export function supervisorAncestorOf(
  p: Pick<ProcIdent, 'ppid'>,
  read: (pid: number) => ProcIdent | 'gone' | 'unreadable',
  ownCliPid: number,
): 'yes' | 'no' | 'unknown' {
  let pid = p.ppid;
  for (let hops = 0; hops < 64; hops++) {
    if (pid <= 1 || pid === ownCliPid) return 'no';
    const q = read(pid);
    if (q === 'unreadable') return 'unknown';
    if (q === 'gone') return 'no'; // reparented past a dead hop: nothing above it is this process's parent any more
    if (isSupervisorProc(q)) return 'yes';
    pid = q.ppid;
  }
  return 'unknown';
}

export interface SparedProc {
  pid: number;
  comm: string;
  cmd: string;
  reason: string;
}

export interface ToolPlan {
  cli: RootRef;
  members: ToolProc[];
  spared: SparedProc[];
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'ash']);

function baseName(s: string): string {
  return s.split('/').pop() ?? s;
}

export function cmdOf(argv: string[] | null, comm: string): string {
  const s = argv && argv.length > 0 ? argv.join(' ') : `[${comm}]`;
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

/** Parse /proc/<pid>/stat (+ optional NUL-separated cmdline) into a ProcIdent. */
export function parseProcIdent(statText: string, cmdlineText: string | null): ProcIdent | null {
  const p = parseProcIdentity(statText);
  if (!p || p.startTicks === undefined) return null;
  const close = statText.lastIndexOf(')');
  const rest = statText.slice(close + 1).trim().split(/\s+/);
  const sid = Number(rest[3]);
  if (!Number.isFinite(sid)) return null;
  const argv = cmdlineText === null ? null : cmdlineText.split('\0').filter((a) => a.length > 0);
  return { pid: p.pid, ppid: p.ppid, sid, startTicks: p.startTicks, comm: p.comm, state: rest[0] ?? '?', argv };
}

/** A shell invoked with `-c` (incl. `-lc`/`-ic`): the CLI's way of running a command. */
export function isToolShell(p: ProcIdent): boolean {
  const argv = p.argv;
  if (!argv || argv.length < 2) return false;
  const shell = baseName(argv[0]).replace(/^-/, '');
  if (!SHELLS.has(shell) && !SHELLS.has(p.comm)) return false;
  return argv.slice(1).some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
}

/**
 * Plan the tool trees under `cli` from a FRESH process table. Membership of a root R =
 * R + its ppid-descendants + every process whose sid is R.pid (when R leads its session).
 * `cli` itself and anything not under a shell root are never members.
 */
export interface PlanOptions {
  /** `CLAUDE_PID` from the process's environ (null = absent/unreadable). Omitted ⇒ no env-proven orphans. */
  claudePidOf?: (p: ProcIdent) => number | null;
  /** `/proc/<pid>/cwd` (null = unreadable): recorded per member for the Bilan. */
  cwdOf?: (p: ProcIdent) => string | null;
  /** Tool-shell roots found in EARLIER rounds (possibly dead now): their session orphans are still ours. */
  priorRoots?: readonly RootRef[];
}

export function planToolTrees(table: readonly ProcIdent[], cli: RootRef, opts: PlanOptions = {}): ToolPlan {
  const byPid = new Map<number, ProcIdent>();
  const children = new Map<number, ProcIdent[]>();
  for (const p of table) {
    if (p.state === 'Z') continue; // already dead
    byPid.set(p.pid, p);
    const l = children.get(p.ppid);
    if (l) l.push(p);
    else children.set(p.ppid, [p]);
  }
  const cliNow = byPid.get(cli.pid);
  const members = new Map<number, ToolProc>();
  const spared: SparedProc[] = [];
  if (!cliNow || cliNow.startTicks !== cli.startTicks) return { cli, members: [], spared }; // CLI gone/recycled: plan nothing
  const roots: ProcIdent[] = [];
  for (const c of children.get(cli.pid) ?? []) {
    if (isToolShell(c)) roots.push(c);
    else spared.push({ pid: c.pid, comm: c.comm, cmd: cmdOf(c.argv, c.comm), reason: 'not-a-shell-command (sidecar/MCP)' });
  }
  const supervisorMemo = new Map<number, boolean>();
  const hasSupervisor = (pid: number, seen = new Set<number>()): boolean => {
    if (supervisorMemo.has(pid)) return supervisorMemo.get(pid) as boolean;
    if (seen.has(pid)) return false;
    seen.add(pid);
    const me = byPid.get(pid);
    let hit = !!me && isSupervisorProc(me);
    if (!hit) for (const k of children.get(pid) ?? []) if (hasSupervisor(k.pid, seen)) { hit = true; break; }
    supervisorMemo.set(pid, hit);
    return hit;
  };
  const add = (p: ProcIdent, root: ProcIdent | null, depth: number, via: ToolProc['via'] = 'tree'): void => {
    if (p.pid === cli.pid || members.has(p.pid)) return;
    if (via !== 'tree' && (hasSupervisor(p.pid) || supervisorAncestorOf(p, (pid) => byPid.get(pid) ?? 'gone', cli.pid) !== 'no')) {
      // an orphan proven only by session/env that IS (or has a descendant) another session's keeper/CLI/app: never a tool
      if (!spared.some((x) => x.pid === p.pid)) spared.push({ pid: p.pid, comm: p.comm, cmd: cmdOf(p.argv, p.comm), reason: `${via}-proven orphan that is, has a descendant or has an ANCESTOR that is a keeper / claude CLI / Orchestra app — another session's supervisor tree, never a tool` });
      return;
    }
    const matched =
      via === 'env'
        ? `CLAUDE_PID=${cli.pid} names this member's CLI (pid ${cli.pid}, start-time ${cli.startTicks}); started after it (start-time ${p.startTicks})`
        : via === 'session'
          ? `same session (sid ${p.sid}) as tool shell ${root?.pid}`
          : root && p.pid === root.pid
            ? `direct child of CLI ${cli.pid}, a shell run with -c`
            : `descendant of tool shell ${root?.pid}`;
    members.set(p.pid, {
      pid: p.pid,
      ppid: p.ppid,
      sid: p.sid,
      startTicks: p.startTicks,
      comm: p.comm,
      cmd: cmdOf(p.argv, p.comm),
      rootPid: root ? root.pid : 0,
      rootIsSessionLeader: root ? root.sid === root.pid : false,
      rootStartTicks: root ? root.startTicks : undefined,
      isRoot: root ? p.pid === root.pid : false,
      depth,
      via,
      cwd: opts.cwdOf ? opts.cwdOf(p) : null,
      matched,
    });
  };
  for (const root of roots) {
    const queue: Array<[ProcIdent, number]> = [[root, 0]];
    const seen = new Set<number>();
    while (queue.length) {
      const [p, d] = queue.shift() as [ProcIdent, number];
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      add(p, root, d);
      for (const k of children.get(p.pid) ?? []) queue.push([k, d + 1]);
    }
    if (root.sid === root.pid) {
      for (const p of byPid.values()) if (p.sid === root.pid && p.pid !== cli.pid) add(p, root, 99, 'session');
    }
  }
  // Session orphans of tool shells seen in an earlier round (the shell itself may be dead now).
  for (const pr of opts.priorRoots ?? []) {
    for (const p of byPid.values()) {
      if (p.sid === pr.pid && p.pid !== pr.pid && p.pid !== cli.pid && p.startTicks > pr.startTicks) {
        add(p, { ...p, pid: pr.pid, sid: pr.pid, startTicks: pr.startTicks }, 99, 'session');
      }
    }
  }
  // Env-proven orphans: started after the CLI, exported CLAUDE_PID=<cli pid>, and NOT inside a sidecar's subtree.
  if (opts.claudePidOf) {
    const sidecar = new Set<number>();
    for (const s of spared) {
      const q = [s.pid];
      while (q.length) {
        const x = q.pop() as number;
        if (sidecar.has(x)) continue;
        sidecar.add(x);
        for (const k of children.get(x) ?? []) q.push(k.pid);
      }
    }
    for (const p of byPid.values()) {
      if (members.has(p.pid) || p.pid === cli.pid || p.pid === cliNow.ppid || p.pid <= 1 || sidecar.has(p.pid) || p.startTicks <= cli.startTicks) continue;
      if (opts.claudePidOf(p) === cli.pid) add(p, null, 99, 'env');
    }
  }
  return { cli, members: [...members.values()], spared };
}

/** Kill order: deepest first, tool roots last. */
export function killOrder(members: readonly ToolProc[]): ToolProc[] {
  return [...members].sort((a, b) => Number(a.isRoot) - Number(b.isRoot) || b.depth - a.depth);
}

export type FreshRead = ProcIdent | 'gone' | 'unreadable';
export type SignalVerdict =
  | { ok: true; via: 'root-under-cli' | 'chain' | 'session' | 'env'; /** what the signal-time re-read actually proved (listed in the Bilan) */ evidence: string }
  | { ok: false; reason: string };

/**
 * THE signal-time identity check (D4). `read` must do a FRESH /proc read on every call;
 * `readClaudePid` a fresh environ read (null = absent, 'unreadable' = fail closed).
 * Fail closed: anything not positively proven the planned tool process is refused.
 * Proof order: root under the CLI → ppid chain → session → env provenance.
 */
export function verifyAtSignal(
  target: ToolProc,
  plan: ToolPlan,
  protect: { keeperPid: number | null; selfPid: number },
  read: (pid: number) => FreshRead,
  readClaudePid: (pid: number) => number | null | 'unreadable' = () => 'unreadable',
): SignalVerdict {
  if (target.pid <= 1 || target.pid === plan.cli.pid || target.pid === protect.keeperPid || target.pid === protect.selfPid) {
    return { ok: false, reason: 'protected-pid (cli/keeper/app/init)' };
  }
  const fresh = read(target.pid);
  if (fresh === 'gone') return { ok: false, reason: 'gone' };
  if (fresh === 'unreadable') return { ok: false, reason: 'unreadable' };
  if (fresh.startTicks !== target.startTicks) return { ok: false, reason: 'reused (start-time changed)' };
  if (fresh.state === 'Z') return { ok: false, reason: 'zombie' };
  const cli = read(plan.cli.pid);
  if (cli === 'gone' || cli === 'unreadable' || cli.startTicks !== plan.cli.startTicks || cli.state === 'Z') {
    // Without a provable CLI there is no ancestry to prove: fail closed.
    return { ok: false, reason: 'cli-identity-unprovable' };
  }
  if (target.isRoot) {
    return fresh.ppid === plan.cli.pid
      ? { ok: true, via: 'root-under-cli', evidence: `re-read now: direct child of CLI ${plan.cli.pid} (start-time ${plan.cli.startTicks}), start-time ${fresh.startTicks} unchanged` }
      : { ok: false, reason: 'root-not-under-cli' };
  }
  let reason = 'no-lineage-proof';
  // 1. ppid chain up to a planned root under the CLI (every hop identity-checked).
  if (target.via === 'tree') {
    const chain = chainToRoot(fresh, plan, read);
    if (chain === true) return { ok: true, via: 'chain', evidence: `re-read now: ppid chain to tool shell ${target.rootPid}, every hop's start-time identity-checked` };
    reason = chain;
  }
  // 2. session lineage: still in the planned root's session (root alive = same identity, or dead).
  if (target.via !== 'tree' && isSupervisorProc(fresh)) return { ok: false, reason: 'supervisor (keeper / claude CLI / Orchestra app of another session)' };
  // ...nor anything UNDER such a supervisor (its MCP servers, helpers): fresh ppid chain, fail closed on an unreadable hop (pre-review M1).
  if (target.via !== 'tree' && supervisorAncestorOf(fresh, read, plan.cli.pid) !== 'no') return { ok: false, reason: 'under another session\'s supervisor (keeper / claude CLI / Orchestra app)' };
  if (target.rootIsSessionLeader && fresh.sid === target.rootPid && target.via !== 'env') {
    const root = read(target.rootPid);
    // The root's planned start-time is REQUIRED: a dead root's pid may have been recycled by an innocent session leader, and an unknown
    // start-time cannot tell them apart ⇒ refuse (D4 fail-closed; review F9).
    const rootStart = target.rootStartTicks;
    const rootOk = rootStart !== undefined && (root === 'gone' || (root !== 'unreadable' && root.startTicks === rootStart));
    if (rootOk) return { ok: true, via: 'session', evidence: `re-read now: sid ${fresh.sid} == tool shell ${target.rootPid}'s session (root ${root === 'gone' ? 'dead' : 'alive, same identity'})` };
    reason = 'session-root-mismatch';
  }
  // 3. env provenance: CLAUDE_PID == this CLI's pid (re-read now) and started after the CLI.
  const env = readClaudePid(target.pid);
  if (env === 'unreadable') return { ok: false, reason: reason === 'no-lineage-proof' ? 'environ-unreadable' : reason };
  if (env === plan.cli.pid && fresh.startTicks > plan.cli.startTicks) {
    return {
      ok: true,
      via: 'env',
      evidence: `re-read now: environ CLAUDE_PID=${env} == CLI ${plan.cli.pid} whose start-time ${plan.cli.startTicks} was just re-verified; process started after it (${fresh.startTicks} > ${plan.cli.startTicks})`,
    };
  }
  return { ok: false, reason };
}

function chainToRoot(fresh: ProcIdent, plan: ToolPlan, read: (pid: number) => FreshRead): true | string {
  const byPid = new Map(plan.members.map((m) => [m.pid, m]));
  let cur: ProcIdent = fresh;
  for (let hop = 0; hop < 64; hop++) {
    if (cur.ppid === plan.cli.pid) return byPid.get(cur.pid)?.isRoot ? true : 'chain-ends-at-cli-without-root';
    const parentPlan = byPid.get(cur.ppid);
    if (!parentPlan) return 'reparented (parent not a planned tool process)';
    const parent = read(cur.ppid);
    if (parent === 'gone' || parent === 'unreadable') return `parent-${parent}`;
    if (parent.startTicks !== parentPlan.startTicks || parent.state === 'Z') return 'parent-identity-changed';
    cur = parent;
  }
  return 'chain-too-deep';
}
