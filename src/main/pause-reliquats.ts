// Pause trap — Reliquat kill, I/O half (#325, wave H ledger #329, FI-1 v1 of the member scope #320). Electron-free.
// A Pause dure kills the tool process trees (pause-kill.ts) and then THIS: every process of the member's kernel scope(s) whose role is
// `reliquat` (its ppid chain reaches no live keeper of the scope — a detached browser, a double-forked daemon, an `env -i` worker), which no
// tree walk, session id or environment marker can reach. Decisions live in src/shared/pause-reliquats.ts (`judgeReliquat`); this file
// reads the scope FRESH, signals SIGTERM → grace → SIGKILL, and reports. The scope is resolved ONLY through the injected `ReliquatScopeDeps`
// (production: `memberScopes` / `listScopeProcs` of src/main/memory-scope.ts, FI-1 v1.3) — never a hard-coded slice path — and a process is
// signalled only when a listing read immediately before THAT signal still holds it, with the same start-time, as a Reliquat (FI-1 v1.4).

import type { KillDeps } from './pause-kill.ts';
import { cmdOf } from '../shared/pause-procs.ts';
import {
  MAX_RELIQUATS_RECORDED,
  depthsOf,
  emptyReliquatReport,
  isOwnKeeperProc,
  judgeReliquat,
  reliquatKillOrder,
  type ReliquatKilled,
  type ReliquatLeft,
  type ReliquatProtect,
  type ReliquatReport,
  type ScopeListing,
  type ScopeRef,
} from '../shared/pause-reliquats.ts';

export interface ReliquatScopeDeps {
  /** FI-1 `memberScopes(wsId)`: the member's scopes (every generation). [] = NOT TRACKED (the Pause keeps today's behaviour); a throw = UNKNOWN. */
  scopes(wsId: string): ScopeRef[];
  /** FI-1 `listScopeProcs(scope)` + `classifyScopeMembers`, read NOW. 'gone' = the scope no longer exists; 'unreadable' = UNKNOWN. */
  list(scope: ScopeRef): ScopeListing;
}

export interface ReliquatKillOptions {
  /** The member's proven keeper / CLI (from the trap's `cliOf`), null when the member has none alive. Never signalled, whatever the scope's classification says. */
  keeperPid: number | null;
  cliPid: number | null;
  /** The process chain of the `orchestra run pause` call (the pauser): never signalled. */
  protectPids?: readonly number[];
  /** Re-checked before EVERY round and signal: false ⇒ stop at once (a lift must not cost the released turn anything — review F8). */
  stillPaused?: () => boolean;
  /** Only processes that started BEFORE this epoch-ms are targets (a HUMAN turn that began during the trap is allowed to run — D9). */
  startedBeforeMs?: number | (() => number | undefined);
  /** Processes whose own start falls inside one of these HUMAN-turn windows are spared (D9). */
  humanWindows?: () => Array<{ from: number; to?: number }>;
  termGraceMs?: number;
  maxRounds?: number;
  /** Called with the report so far after each SIGTERM batch (the trap persists it: a killed process must be in the Bilan even if the app dies next). */
  onProgress?: (report: ReliquatReport) => void;
}

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_ROUNDS = 3;
const POLL_MS = 50;
const YIELD_EVERY = 16;

interface Target {
  pid: number;
  startTicks: number;
  ppid: number;
  comm: string;
  cmd: string;
  cwd: string | null;
  startedAt: number;
  /** The earliest start along the ppid chain of listed members (itself included): what the human-turn cutoff compares. */
  originStartedAt: number;
  scope: ScopeRef;
  depth: number;
}

function leftOf(t: { pid: number; startTicks?: number; comm: string; cmd: string }, reason: string): ReliquatLeft {
  return { pid: t.pid, ...(t.startTicks !== undefined ? { startTicks: t.startTicks } : {}), comm: t.comm, cmd: t.cmd, reason };
}

/**
 * Kill every Reliquat in the member's scope(s). Returns null when the member has no tracked scope (nothing was looked at — the caller records nothing),
 * else the report. UNKNOWN is not NONE: an unreadable scope (or a failed scope lookup) sets `unknown`, which the caller treats as "trap incomplete, retry".
 */
export async function killReliquats(wsId: string, scopeDeps: ReliquatScopeDeps, kill: KillDeps, opts: ReliquatKillOptions): Promise<ReliquatReport | null> {
  let scopes: ScopeRef[];
  try {
    scopes = scopeDeps.scopes(wsId);
  } catch (e) {
    return { ...emptyReliquatReport(), unknown: `scope lookup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (scopes.length === 0) return null;
  const report = emptyReliquatReport(scopes.map((s) => s.unit));
  if (!kill.supported) {
    report.error = 'process identity (/proc start-time) unavailable on this platform — nothing killed (fail closed)';
    return report;
  }
  const protect: ReliquatProtect = { keeperPid: opts.keeperPid, cliPid: opts.cliPid, selfPid: kill.selfPid, ...(opts.protectPids ? { extraPids: opts.protectPids } : {}) };
  const maxRounds = opts.maxRounds ?? DEFAULT_ROUNDS;
  const grace = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killed = new Map<string, ReliquatKilled>(); // pid:startTicks
  const refused = new Map<string, ReliquatLeft>();
  const spared = new Map<number, ReliquatLeft>();
  const key = (t: { pid: number; startTicks: number }): string => `${t.pid}:${t.startTicks}`;
  const beforeMs = (): number | undefined => (typeof opts.startedBeforeMs === 'function' ? opts.startedBeforeMs() : opts.startedBeforeMs);
  const paused = (): boolean => {
    if (opts.stillPaused && !opts.stillPaused()) {
      report.aborted = 'lifted';
      return false;
    }
    return true;
  };
  // a HUMAN turn that began during the trap is allowed to run (D9): what it started is its own
  // compared on the ORIGIN start — the earliest along the ppid chain inside the scope — like the tool-tree kill (round-3 F1a): a worker a pre-pause daemon forks during a human turn belongs to the daemon and dies with it
  const tooNew = (t: Target): boolean => {
    const at = t.originStartedAt;
    const b = beforeMs();
    if (b !== undefined && at >= b) return true;
    return (opts.humanWindows?.() ?? []).some((w) => at >= w.from && (w.to === undefined || at <= w.to));
  };
  /** The command line for a record (read NOW; falls back to the comm the scope listing carries). */
  const cmdFor = (pid: number, comm: string): string => {
    const f = kill.read(pid);
    return f === 'gone' || f === 'unreadable' ? `[${comm}]` : cmdOf(f.argv, f.comm);
  };
  const alive = (t: { pid: number; startTicks: number }): boolean => {
    const f = kill.read(t.pid);
    return f !== 'gone' && f !== 'unreadable' && f.startTicks === t.startTicks && f.state !== 'Z';
  };
  const waitUntilGone = async (ts: Array<{ pid: number; startTicks: number }>, ms: number): Promise<void> => {
    const until = kill.now() + ms;
    while (kill.now() < until && ts.some(alive)) await kill.sleep(POLL_MS);
  };

  /** The scopes as they are NOW (a restart during the trap may have created a new generation; a scope emptied by the kills disappears). */
  const currentScopes = (): ScopeRef[] | 'unknown' => {
    try {
      const now = scopeDeps.scopes(wsId);
      for (const s of now) if (!report.scopes.includes(s.unit)) report.scopes.push(s.unit);
      return now;
    } catch {
      return 'unknown';
    }
  };

  /** One fresh census of every scope: the Reliquats that may be signalled, the ones left alone (listed), and whether any scope could not be read. */
  const planNow = (): { targets: Target[]; unknown?: string } => {
    const targets: Target[] = [];
    const sc = currentScopes();
    if (sc === 'unknown') return { targets, unknown: 'scope lookup failed during the kill' };
    let unknown: string | undefined;
    for (const scope of sc) {
      const listing = scopeDeps.list(scope);
      if (listing === 'gone') continue;
      if (listing === 'unreadable') {
        unknown = `scope ${scope.unit}: cgroup.procs unreadable — its Reliquats could not be listed`;
        continue;
      }
      // FI-1 names the keeper only once its pid file is published: with THIS member's own keeper listed as a `reliquat` the roles of the whole scope are unreliable (its CLI and MCP servers read `reliquat` too) —
      // nothing in it is signalled this round (UNKNOWN is not NONE: the trap retries once the pid file exists). Another workspace's keeper.js (a nested rig app) does not block the scope.
      const ownKeeper = listing.find((m) => m.role === 'reliquat' && ((): boolean => { const f = kill.read(m.pid); return f !== 'gone' && f !== 'unreadable' && isOwnKeeperProc(f, wsId); })());
      if (ownKeeper) {
        unknown = `scope ${scope.unit}: this member's own keeper (pid ${ownKeeper.pid}) is listed as a Reliquat — its pid file is not published yet, so the roles of the scope are unreliable`;
        continue;
      }
      const depth = depthsOf(listing);
      const byPid = new Map(listing.map((x) => [x.pid, x]));
      const originOf = (m: (typeof listing)[number]): number => {
        let at = kill.startMs(m.startTicks);
        const seen = new Set<number>([m.pid]);
        for (let q = byPid.get(m.ppid); q && !seen.has(q.pid) && seen.size < 64; q = byPid.get(q.ppid)) { seen.add(q.pid); at = Math.min(at, kill.startMs(q.startTicks)); }
        return at;
      };
      for (const m of listing) {
        if (m.role !== 'reliquat') continue;
        const v = judgeReliquat(m.pid, null, scope, listing, protect, kill.read);
        if (!v.ok) {
          if (v.kind === 'spared') spared.set(m.pid, leftOf({ pid: m.pid, comm: m.comm, cmd: cmdFor(m.pid, m.comm) }, v.reason));
          else if (v.kind === 'refused') refused.set(`${m.pid}:${m.startTicks}`, leftOf({ pid: m.pid, startTicks: m.startTicks, comm: m.comm, cmd: cmdFor(m.pid, m.comm) }, v.reason));
          continue;
        }
        const p = v.proc;
        const t: Target = { pid: p.pid, startTicks: p.startTicks, ppid: p.ppid, comm: p.comm, cmd: cmdOf(p.argv, p.comm), cwd: kill.readCwd(p.pid), startedAt: kill.startMs(p.startTicks), originStartedAt: originOf(m), scope, depth: depth.get(p.pid) ?? 0 };
        if (tooNew(t)) {
          spared.set(t.pid, leftOf(t, 'started during a HUMAN turn that began while the trap ran — the human prompt is allowed (D9)'));
          continue;
        }
        targets.push(t);
      }
    }
    return { targets, ...(unknown ? { unknown } : {}) };
  };

  const snapshot = (): ReliquatReport => ({
    ...report,
    killed: [...killed.values()].slice(-MAX_RELIQUATS_RECORDED),
    ...(killed.size > MAX_RELIQUATS_RECORDED ? { killedTotal: killed.size } : {}),
    refused: [...refused.values()],
    spared: [...spared.values()],
  });

  /** Re-verify one target against a listing read RIGHT NOW, then signal it. true = the signal was delivered. */
  const signalOne = (t: Target, sig: 'SIGTERM' | 'SIGKILL'): boolean => {
    const v = judgeReliquat(t.pid, t.startTicks, t.scope, scopeDeps.list(t.scope), protect, kill.read);
    if (!v.ok) {
      if (v.kind === 'refused') refused.set(key(t), leftOf(t, v.reason));
      else if (v.kind === 'spared') spared.set(t.pid, leftOf(t, v.reason));
      return false;
    }
    if (!kill.signal(t.pid, sig)) return false;
    const prev = killed.get(key(t));
    if (prev) prev.signal = sig;
    else {
      killed.set(key(t), {
        pid: t.pid, startTicks: t.startTicks, comm: t.comm, cmd: t.cmd, cwd: t.cwd, startedAt: t.startedAt, scope: t.scope.unit,
        evidence: v.evidence, signal: sig, outcome: 'exited',
      });
    }
    return true;
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (!paused()) break;
    const plan = planNow();
    if (plan.targets.length === 0) break;
    report.rounds = round;
    const termed: Target[] = [];
    let n = 0;
    for (const t of reliquatKillOrder(plan.targets)) {
      if (!paused()) break;
      if (signalOne(t, 'SIGTERM')) termed.push(t);
      if (++n % YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r)); // each signal re-reads the scope synchronously: let the Electron main thread breathe between small batches
    }
    if (termed.length > 0) opts.onProgress?.(snapshot());
    await waitUntilGone(termed, grace);
    for (const t of reliquatKillOrder(termed)) {
      if (!alive(t)) continue;
      if (++n % YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
      if (!paused()) break;
      // SIGTERM was ignored/slow: escalate — after a SECOND fresh scope listing + identity re-read of this pid.
      signalOne(t, 'SIGKILL');
    }
    await waitUntilGone(termed, 500);
    if (termed.length === 0) break; // nothing provable to signal: more rounds cannot change that
  }

  // Final census: whatever the scopes still list as a signal-able Reliquat is a survivor; a scope that cannot be read is UNKNOWN, never "clean".
  const last = report.aborted ? null : planNow();
  const stillThere = new Set((last?.targets ?? []).map(key));
  for (const [k, v] of killed) v.outcome = stillThere.has(k) || alive(v) ? 'survived' : 'exited';
  const out = snapshot();
  // a refusal / sparing recorded in an early round says nothing about a process that has died since
  out.refused = out.refused.filter((r) => r.startTicks === undefined || alive({ pid: r.pid, startTicks: r.startTicks }));
  out.spared = out.spared.filter((r) => { const f = kill.read(r.pid); return f !== 'gone' && !(f !== 'unreadable' && f.state === 'Z'); });
  out.survivors = (last?.targets ?? []).map((t) => leftOf(t, 'still-alive-after-kill'));
  for (const [k, v] of killed) if (v.outcome === 'survived' && !stillThere.has(k)) out.survivors.push(leftOf(v, 'still-alive-after-kill'));
  if (last?.unknown) out.unknown = last.unknown;
  out.rounds = report.rounds;
  if (report.aborted) out.aborted = report.aborted;
  if (report.error) out.error = report.error;
  return out;
}
