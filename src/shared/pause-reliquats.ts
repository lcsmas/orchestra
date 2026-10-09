// Reliquats on a Pause dure (#325, wave H ledger #329, FI-1 v1 of the member scope #320). PURE: no fs, no signals — the decisions the
// I/O half (src/main/pause-reliquats.ts) applies, and the shapes the Bilan / Consigne / `run status` read.
//
// A Reliquat is a process of the member's kernel scope whose ppid chain reaches NO live keeper of that scope (FI-1 (c), role `reliquat`):
// a detached rig browser, a double-forked daemon, an `env -i` worker the session's tool tree no longer owns. The Pause dure kills them
// after the tool trees. Everything below is FAIL CLOSED: a process is signalled only when its identity (pid + /proc start-time) AND its
// scope membership AND its role were re-read at signal time AND nothing proves it is the live session (keeper, CLI, MCP server).

import { isSupervisorProc, type FreshRead, type ProcIdent } from './pause-procs.ts';
import type { ClassifiedMember, ScopeRole } from './memory-scope.ts';

/** FI-1 (c): ONE definition of the role and the classified member — H1's `src/shared/memory-scope.ts` (v1.3: never a second copy). */
export type { ScopeRole };

/** The structural subset of an FI-1 `memberScopes(wsId)` element this module reads. */
export interface ScopeRef {
  unit: string;
  cgroupDir: string;
}

/** The subset of an FI-1 `listScopeProcs(scope)` element (`ClassifiedMember`) this module reads. */
export type ScopeMember = Pick<ClassifiedMember, 'pid' | 'startTicks' | 'ppid' | 'comm' | 'role'>;

/** A FRESH listing of one scope: 'gone' = the scope no longer exists (every member died); 'unreadable' = UNKNOWN, never "empty". */
export type ScopeListing = ScopeMember[] | 'gone' | 'unreadable';

/** What no signal may reach, whatever the scope's classification says (defence in depth: a stale pid file must not turn the live session into a "Reliquat"). */
export interface ReliquatProtect {
  keeperPid: number | null;
  cliPid: number | null;
  selfPid: number;
  /** The `orchestra run pause` call's own process chain (the pauser). */
  extraPids?: readonly number[];
}

export interface ReliquatKilled {
  pid: number;
  /** /proc start-time ticks — with `pid` the process identity. */
  startTicks: number;
  comm: string;
  cmd: string;
  cwd: string | null;
  /** Epoch ms the process started (boot time + ticks / CLK_TCK) — the Bilan's "start time". */
  startedAt: number;
  /** The scope unit it was found in. */
  scope: string;
  /** What the signal-time re-read proved for THIS process. */
  evidence: string;
  signal: 'SIGTERM' | 'SIGKILL';
  /** planned = written BEFORE the first signal of the batch (write-ahead, review F3: an app death mid-batch must not lose the batch); exited = gone or zombie at the final census; survived = still the same live process. */
  outcome: 'planned' | 'exited' | 'survived';
}

export interface ReliquatLeft {
  /** Which step listed it (`browser` = the browser-Reliquat bridge): a RETRY of that step replaces its own earlier entries instead of stacking them. */
  source?: string;
  pid: number;
  startTicks?: number;
  comm: string;
  cmd: string;
  reason: string;
  /** `left-scope-parent` (review F1): the live PARENT of a killed Reliquat that is no longer in the member's scope — listed, never signalled (it is not ours to kill). */
  kind?: 'left-scope-parent';
}

/** What the Pause did to a member's Reliquats — `BilanActivity.reliquats`. Absent on the Bilan = the member has no tracked scope (nothing was looked at). */
export interface ReliquatReport {
  /** Scope units examined (the member's `memberScopes`). */
  scopes: string[];
  killed: ReliquatKilled[];
  /** More Reliquats were killed than `killed` keeps (200 newest). */
  killedTotal?: number;
  /** Identity / membership / ancestry NOT provable at signal time (never signalled). */
  refused: ReliquatLeft[];
  /** Deliberately left alone: a keeper/claude/app of another session, a process under the live session, a process of a HUMAN turn started during the trap. */
  spared: ReliquatLeft[];
  /** Still alive after the last round (same identity). */
  survivors: ReliquatLeft[];
  rounds: number;
  /** The pause was lifted while killing: the remaining signals were NOT sent. */
  aborted?: 'lifted';
  /** UNKNOWN is not NONE: the scope could not be read — the caller retries (never "0 Reliquats, complete"). */
  unknown?: string;
  error?: string;
}

export const MAX_RELIQUATS_RECORDED = 200;

export function emptyReliquatReport(scopes: string[] = []): ReliquatReport {
  return { scopes, killed: [], refused: [], spared: [], survivors: [], rounds: 0 };
}

/**
 * Does the process whose parent is `ppid` sit UNDER the live session — the member's proven keeper / CLI, or any keeper / claude CLI / Orchestra app (an MCP server,
 * a hook, a tool that is still a child)? Walks the ppid chain hop by hop through a FRESH `read`. 'unknown' = a hop could not be read (fail closed: callers refuse on anything but 'no').
 * Reparented past a dead hop / reaching init ⇒ 'no'. Bounded depth.
 */
export function sessionAncestorOf(ppid: number, read: (pid: number) => FreshRead, sessionPids: ReadonlySet<number>): 'yes' | 'no' | 'unknown' {
  let pid = ppid;
  for (let hops = 0; hops < 64; hops++) {
    if (pid <= 1) return 'no';
    if (sessionPids.has(pid)) return 'yes';
    const q = read(pid);
    if (q === 'unreadable') return 'unknown';
    if (q === 'gone') return 'no';
    if (isSupervisorProc(q)) return 'yes';
    pid = q.ppid;
  }
  return 'unknown';
}

/**
 * Is `p` THIS member's own keeper daemon — `node …/keeper.js <wsId> <sock> <pid> <log>` (keeper-client's argv)? A keeper of ANOTHER workspace (a nested rig app's) is not.
 * FI-1 labels the member's keeper `keeper` only once its pid file is published (the keeper writes it after it listens): until then it, its CLI and its MCP servers all read `reliquat`.
 */
export function isOwnKeeperProc(p: Pick<ProcIdent, 'argv'>, wsId: string): boolean {
  const argv = p.argv ?? [];
  const i = argv.findIndex((a) => (a.split('/').pop() ?? a) === 'keeper.js');
  return i >= 0 && argv[i + 1] === wsId;
}

export type ReliquatVerdict =
  | { ok: true; evidence: string; proc: ProcIdent }
  | { ok: false; kind: 'gone' | 'spared' | 'refused'; reason: string };

/**
 * THE decision, at plan time AND at signal time (`listing` and `read` must be FRESH on every call): may `pid` be signalled as a Reliquat of `scope`?
 * `expectStartTicks` = the identity planned earlier (null at plan time). Every refusal names its reason; nothing is signalled on anything not positively proven:
 * the scope must still list the pid with the SAME start-time and role `reliquat`, an independent /proc read must agree, it must not be (or sit under) a supervisor
 * or the live session, and it must not be a protected pid.
 */
export function judgeReliquat(
  pid: number,
  expectStartTicks: number | null,
  scope: ScopeRef,
  listing: ScopeListing,
  protect: ReliquatProtect,
  read: (pid: number) => FreshRead,
): ReliquatVerdict {
  // the live session = the app, the member's keeper and CLI: a process UNDER one of them is the session's. The pausing call's chain (`extraPids`) is protected from the signal but is NOT a session ancestor:
  // it runs up to the user manager (`systemd --user`, the subreaper orphans reparent to) — treating it as one would spare every detached Reliquat of the pauser's scope.
  const sessionPids = new Set<number>([protect.selfPid]);
  if (protect.keeperPid !== null) sessionPids.add(protect.keeperPid);
  if (protect.cliPid !== null) sessionPids.add(protect.cliPid);
  const protectedPids = new Set<number>([...sessionPids, ...(protect.extraPids ?? [])]);
  if (pid <= 1 || protectedPids.has(pid)) return { ok: false, kind: 'refused', reason: 'protected-pid (init / the app / the member\'s keeper or CLI / the pausing call)' };
  if (listing === 'gone') return { ok: false, kind: 'gone', reason: 'scope-gone' };
  if (listing === 'unreadable') return { ok: false, kind: 'refused', reason: 'scope-unreadable' };
  const entry = listing.find((e) => e.pid === pid);
  if (!entry) return { ok: false, kind: 'gone', reason: 'not-in-the-scope-any-more' }; // died, or left the scope: never ours to signal
  if (expectStartTicks !== null && entry.startTicks !== expectStartTicks) return { ok: false, kind: 'refused', reason: 'reused (start-time changed)' };
  if (entry.role !== 'reliquat') return { ok: false, kind: 'refused', reason: `role-is-${entry.role} (its chain reaches the live keeper)` };
  const p = read(pid);
  if (p === 'gone') return { ok: false, kind: 'gone', reason: 'gone' };
  if (p === 'unreadable') return { ok: false, kind: 'refused', reason: 'unreadable' };
  if (p.startTicks !== entry.startTicks) return { ok: false, kind: 'refused', reason: 'reused (start-time changed)' };
  if (p.state === 'Z') return { ok: false, kind: 'gone', reason: 'zombie' };
  if (isSupervisorProc(p)) return { ok: false, kind: 'spared', reason: 'supervisor (keeper / claude CLI / Orchestra app): never touched, even outside its session\'s tree' };
  const anc = sessionAncestorOf(p.ppid, read, sessionPids);
  if (anc === 'yes') return { ok: false, kind: 'spared', reason: 'under the live session or a supervisor (its ppid chain reaches the keeper / CLI / a claude CLI)' };
  if (anc === 'unknown') return { ok: false, kind: 'refused', reason: 'ancestry-unreadable' };
  return {
    ok: true,
    proc: p,
    evidence: `scope ${scope.unit}: role reliquat (its ppid chain reaches no live keeper of the scope); re-read now: in the scope's cgroup.procs, start-time ${p.startTicks} unchanged, not a supervisor, no live-session ancestor`,
  };
}

/** Kill order: deepest first (children before parents inside the scope listing), then NEWEST first. */
export function reliquatKillOrder<T extends { depth: number; startTicks: number }>(targets: readonly T[]): T[] {
  return [...targets].sort((a, b) => b.depth - a.depth || b.startTicks - a.startTicks);
}

/** Distance of each member from the top of the chain INSIDE the listing (a Reliquat reparented to init has depth 0). */
export function depthsOf(members: readonly ScopeMember[]): Map<number, number> {
  const by = new Map(members.map((m) => [m.pid, m]));
  const out = new Map<number, number>();
  for (const m of members) {
    let d = 0;
    const seen = new Set<number>([m.pid]);
    for (let cur = by.get(m.ppid); cur && !seen.has(cur.pid) && d < 64; cur = by.get(cur.ppid)) {
      seen.add(cur.pid);
      d++;
    }
    out.set(m.pid, d);
  }
  return out;
}

/** A retry merges BY IDENTITY: what an earlier attempt killed stays listed (D11: every killed process is in the Bilan), the latest attempt's facts replace the rest. */
export function mergeReliquats(prior: ReliquatReport | undefined | null, cur: ReliquatReport): ReliquatReport {
  const killed = new Map<string, ReliquatKilled>();
  // an earlier attempt's entry that THIS attempt did not signal again is judged by the latest census: still alive ⇒ survived, else exited (never a stale 'survived' after it died)
  const stillAlive = new Set(cur.survivors.map((x) => `${x.pid}:${x.startTicks}`));
  for (const k of prior?.killed ?? []) killed.set(`${k.pid}:${k.startTicks}`, { ...k, outcome: cur.unknown ? k.outcome : stillAlive.has(`${k.pid}:${k.startTicks}`) ? 'survived' : 'exited' });
  for (const k of cur.killed) killed.set(`${k.pid}:${k.startTicks}`, k);
  const all = [...killed.values()];
  // entries an earlier truncation already dropped stay counted
  const hidden = Math.max(0, (prior?.killedTotal ?? 0) - (prior?.killed.length ?? 0)) + Math.max(0, (cur.killedTotal ?? 0) - cur.killed.length);
  const total = all.length + hidden;
  const kept = all.slice(-MAX_RELIQUATS_RECORDED);
  return {
    scopes: [...new Set([...(prior?.scopes ?? []), ...cur.scopes])],
    killed: kept,
    ...(total > kept.length ? { killedTotal: total } : {}),
    refused: cur.refused,
    spared: cur.spared,
    survivors: cur.survivors,
    rounds: Math.max(prior?.rounds ?? 0, cur.rounds),
    ...(cur.aborted ? { aborted: cur.aborted } : {}),
    ...(cur.unknown ? { unknown: cur.unknown } : {}),
    ...(cur.error ? { error: cur.error } : {}),
  };
}

/**
 * Two reports of the SAME attempt (the scope's, then the browsers') in one: killed unioned BY IDENTITY, survivors / refused / spared / scopes concatenated (de-duplicated by identity),
 * unknown / error joined, the larger round count. Unlike {@link mergeReliquats} (a RETRY: the latest census replaces the lists) nothing of either side is dropped.
 */
export function combineReliquats(a: ReliquatReport | undefined | null, b: ReliquatReport, opts: { replaceSource?: string } = {}): ReliquatReport {
  if (opts.replaceSource) {
    // a retry of ONE step: that step's earlier spared / survivors / refused are history (the latest census replaces them); everything else of `a` stays
    const drop = <T extends { source?: string }>(xs: readonly T[]): T[] => xs.filter((x) => x.source !== opts.replaceSource);
    if (a) a = { ...a, spared: drop(a.spared), survivors: drop(a.survivors), refused: drop(a.refused) };
  }
  if (!a) return b;
  const byId = <T extends { pid: number; startTicks?: number }>(xs: readonly T[]): T[] => { const m = new Map<string, T>(); for (const x of xs) m.set(`${x.pid}:${x.startTicks ?? ''}`, x); return [...m.values()]; };
  const killed = byId([...a.killed, ...b.killed]);
  const hidden = Math.max(0, (a.killedTotal ?? 0) - a.killed.length) + Math.max(0, (b.killedTotal ?? 0) - b.killed.length);
  const kept = killed.slice(-MAX_RELIQUATS_RECORDED);
  const unknown = [a.unknown, b.unknown].filter(Boolean).join('; ');
  const error = [a.error, b.error].filter(Boolean).join('; ');
  return {
    scopes: [...new Set([...a.scopes, ...b.scopes])],
    killed: kept,
    ...(killed.length + hidden > kept.length ? { killedTotal: killed.length + hidden } : {}),
    refused: byId([...a.refused, ...b.refused]),
    spared: byId([...a.spared, ...b.spared]),
    survivors: byId([...a.survivors, ...b.survivors]),
    rounds: Math.max(a.rounds, b.rounds),
    ...(a.aborted || b.aborted ? { aborted: (a.aborted ?? b.aborted) as 'lifted' } : {}),
    ...(unknown ? { unknown } : {}),
    ...(error ? { error } : {}),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

function trimTo(s: string, n: number, strip: (s: unknown) => string): string {
  const clean = strip(s);
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

const LISTED = 20;

/** One list line per killed Reliquat (cmd, pid, start, cwd) + the « +N more » tail — the ONE rendering shared by the Pause's Consigne and the Veille notice (#326). `total` = how many were killed in all (≥ `done.length`). */
export function reliquatKilledItemLines(done: readonly ReliquatKilled[], total: number, strip: (s: unknown) => string, moreHint = 'orchestra run status'): string[] {
  const out: string[] = [];
  for (const k of done.slice(0, LISTED)) out.push(`  - ${trimTo(k.cmd, 300, strip)}   (pid ${k.pid}, started ${iso(k.startedAt)}${k.cwd ? `, cwd ${trimTo(k.cwd, 200, strip)}` : ''})`);
  if (done.length > LISTED) out.push(`  - … +${total - LISTED} more (${moreHint})`);
  return out;
}

/** The Consigne de reprise's Reliquat lines (LISTED, never re-run). Nothing is said for a member with no scope or no Reliquat to report. `strip` = the Consigne's control-character strip. */
export function reliquatConsigneLines(r: ReliquatReport | undefined | null, strip: (s: unknown) => string): string[] {
  if (!r) return [];
  const out: string[] = [];
  // `planned` = written before the first signal of a batch (review F3) and never completed by a census: the Pause was ABOUT to kill it — not claimed as killed
  const done = r.killed.filter((k) => k.outcome !== 'planned');
  const planned = r.killed.length - done.length;
  if (done.length > 0) {
    const n = (r.killedTotal ?? r.killed.length) - planned;
    out.push(`Leftover processes (Reliquats) the Pause killed for you (${n}) — processes you started that had left your session's process tree (detached daemons, orphaned headless browsers); LISTED, NOT re-run. Re-run one only if you still need it, after checking the tree:`);
    out.push(...reliquatKilledItemLines(done, n, strip));
  }
  if (planned > 0) out.push(`Leftover processes the Pause was about to kill when it was interrupted (${planned}) — their outcome was not recorded; check them before re-running anything: ${r.killed.filter((k) => k.outcome === 'planned').slice(0, 3).map((k) => `${trimTo(k.cmd, 60, strip)} (pid ${k.pid})`).join('; ')}${planned > 3 ? '; …' : ''}`);
  for (const s of r.survivors.filter((x) => x.kind !== 'left-scope-parent').slice(0, LISTED)) out.push(`STILL ALIVE after the Pause (Reliquat): ${trimTo(s.cmd, 200, strip)} (pid ${s.pid}: ${trimTo(s.reason, 80, strip)})`);
  for (const s of r.survivors.filter((x) => x.kind === 'left-scope-parent').slice(0, LISTED)) out.push(`STILL ALIVE and OUTSIDE your scope (NOT killed — not in your scope): ${trimTo(s.cmd, 200, strip)} (pid ${s.pid}) — ${trimTo(s.reason, 200, strip)}`);
  for (const s of r.refused.slice(0, LISTED)) out.push(`Leftover process NOT killed (identity not provable, pid ${s.pid}): ${trimTo(s.reason, 120, strip)} — ${trimTo(s.cmd, 120, strip)}`);
  if (r.spared.length > 0) out.push(`Leftover processes left running on purpose (${r.spared.length}): ${r.spared.slice(0, 3).map((s) => `${trimTo(s.cmd, 60, strip)} (pid ${s.pid})`).join('; ')}${r.spared.length > 3 ? '; …' : ''}`);
  if (r.unknown) out.push(`Leftover processes: NOT checked for you — ${trimTo(r.unknown, 160, strip)}`);
  return out;
}
