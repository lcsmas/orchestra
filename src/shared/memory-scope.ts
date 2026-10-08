// Plafond mémoire — the per-member kernel scope, PURE half (#320, wave H ledger #329, ADR 0005; contract = ledger FI-1).
// Impure halves: src/main/memory-scope.ts (resolve / read a member's scope), src/keeper/memory-watch.ts (the kill watch),
// src/main/memory-cap-switch.ts (the frozen switch + settings read at session start). Nothing here touches the OS.
//
// What a Plafond mémoire IS on this host (measured 2026-10-08, docs/codebase-map/session-keeper.md § Plafond mémoire):
//  - `MemoryMax` alone kills only with `MemorySwapMax=0` (zram swap would absorb the overflow otherwise);
//  - systemd's default `OOMPolicy=stop` ENDS THE WHOLE SCOPE after one oom_kill — `OOMPolicy=continue` is what makes "never group-kill" true;
//  - `MemoryHigh` below `MemoryMax` throttles a runaway to a crawl instead of ever reaching the kill (ledger D-Q2, option A): NEVER set. The soft
//    level is a WARNING level (the member is told when it crosses it — #322), not a kernel throttle;
//  - the keeper and the CLI sit at the default oom_score_adj (0) and an unprivileged process cannot go BELOW its floor (0), so they cannot be made less killable: the tool
//    processes are RAISED above them (+{@link OOM_ADJ_TOOLS}) instead. Advisory, not a boundary — a process may lower itself back to its floor (measured); it protects against honest tools.

import { GIB } from './memory-guard.ts';

// ─── Unit naming (FI-1 a) ──────────────────────────────────────────────────────────────────────────────────────────

/** Production unit prefix. Rigs set `ORCHESTRA_MEMORY_SCOPE_PREFIX=orchestra-rig-wh-` so their scopes are recognisable (ledger D2). */
export const MEMORY_SCOPE_UNIT_PREFIX = 'orchestra-ws-';
export const MEMORY_SCOPE_PREFIX_ENV = 'ORCHESTRA_MEMORY_SCOPE_PREFIX';
/** A prefix a unit name can carry: letters, digits, `_ . : -`, ending in `-`, short. Anything else ⇒ the production prefix (never a guess). */
export function sanitizeScopePrefix(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  return /^[A-Za-z0-9_.:-]{1,60}-$/.test(v) ? v : MEMORY_SCOPE_UNIT_PREFIX;
}

const WS_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const GEN_RE = /^[0-9a-z]{6,12}$/;

/** The launch generation: base36 ms. A restart while Reliquats keep the old scope alive must not collide with it. */
export function newScopeGen(nowMs: number): string {
  return Math.max(0, Math.floor(nowMs)).toString(36).padStart(6, '0');
}

/** `<prefix><wsId>-<gen>.scope`, or null when the ws id cannot be part of a unit name. */
export function memoryScopeUnitName(prefix: string, wsId: string, gen: string): string | null {
  if (!WS_ID_RE.test(wsId) || !GEN_RE.test(gen)) return null;
  return `${prefix}${wsId}-${gen}.scope`;
}

/** `{wsId, gen}` of a unit name made by {@link memoryScopeUnitName} with this prefix, else null. The gen is the LAST dash token (ws ids contain dashes). */
export function parseMemoryScopeUnit(prefix: string, unit: string): { wsId: string; gen: string } | null {
  if (!unit.startsWith(prefix) || !unit.endsWith('.scope')) return null;
  const core = unit.slice(prefix.length, -'.scope'.length);
  const i = core.lastIndexOf('-');
  if (i <= 0) return null;
  const wsId = core.slice(0, i);
  const gen = core.slice(i + 1);
  return WS_ID_RE.test(wsId) && GEN_RE.test(gen) ? { wsId, gen } : null;
}

/** The generation of `unit` iff it is a scope of exactly THIS workspace ("ab" must not match "ab-cd"'s scopes). */
export function scopeGenForWorkspace(prefix: string, wsId: string, unit: string): string | null {
  const p = parseMemoryScopeUnit(prefix, unit);
  return p && p.wsId === wsId ? p.gen : null;
}

// ─── The decision: create the scope / set the limits — TWO separate clauses (ledger Q1 may change the first) ──────

/** What the host asks of a keeper's scope. `softBytes` is the WARNING level (#322 tells the member when it crosses it) — it is never a kernel limit (ledger D-Q2). */
export interface MemoryCapLimits {
  hardBytes: number;
  softBytes: number | null;
  /** Always 0: with swap on, `MemoryMax` is not a cap (the overflow parks in zram). */
  swapMaxBytes: 0;
}

/** What `ensureSession` asks of a keeper LAUNCH: its own scope (`unit`), with these limits (null = a scope with no limits — ledger Q1 variant). */
export interface MemoryCapLaunch {
  unit: string;
  limits: MemoryCapLimits | null;
}

export type MemoryCapReason = 'ok' | 'switch-off' | 'human' | 'remote' | 'platform' | 'unsupported' | 'bad-levels';

export interface MemoryCapDecision {
  /** Clause 1 — launch the keeper in its own scope. */
  createScope: boolean;
  /** Clause 2 — put limits on it. */
  limits: MemoryCapLimits | null;
  reason: MemoryCapReason;
}

export interface MemoryCapInput {
  /** The run's FROZEN `memory_cap` switch (false when the bus is down / no run row). */
  switchOn: boolean;
  /** The workspace has a coordinator (`parentId`) — a fleet member. A human-created top-level workspace is never capped. */
  hasCoordinator: boolean;
  /** Sandbox-hosted (its process lives in a container, not on this host). */
  remote: boolean;
  platform: string;
  /** `scopeSupport().ok` — systemd-run + a user manager with the `memory` controller delegated. */
  supported: boolean;
  softGb: number;
  hardGb: number;
}

export function decideMemoryCap(i: MemoryCapInput): MemoryCapDecision {
  const none = (reason: MemoryCapReason): MemoryCapDecision => ({ createScope: false, limits: null, reason });
  if (!i.hasCoordinator) return none('human');
  if (i.remote) return none('remote');
  if (i.platform !== 'linux') return none('platform');
  if (!i.supported) return none('unsupported');
  const hardBytes = Math.round(i.hardGb * GIB);
  const softBytes = Math.round(i.softGb * GIB);
  if (!(Number.isFinite(hardBytes) && hardBytes > 0)) return none('bad-levels');
  // Clause 1 (ledger Q1: «every member always runs in a scope» would drop `i.switchOn` here and nowhere else).
  const createScope = i.switchOn;
  // Clause 2: limits only on a scope that exists AND whose switch is on.
  const limits: MemoryCapLimits | null = createScope && i.switchOn ? { hardBytes, softBytes: softBytes > 0 && softBytes < hardBytes ? softBytes : null, swapMaxBytes: 0 } : null;
  return { createScope, limits, reason: createScope ? 'ok' : 'switch-off' };
}

/** `systemd-run` argv that starts `cmd args…` as the main process of a NEW user scope (never moves an existing process). */
export function buildScopeLaunchArgv(a: { unit: string; limits: MemoryCapLimits | null; description?: string; cmd: string; args: string[] }): { cmd: string; args: string[] } {
  const props: string[] = ['OOMPolicy=continue']; // systemd's default `stop` ends the WHOLE scope after one oom_kill
  if (a.limits) {
    props.push(`MemoryMax=${a.limits.hardBytes}`, `MemorySwapMax=${a.limits.swapMaxBytes}`);
  }
  return {
    cmd: 'systemd-run',
    args: ['--user', '--scope', '--collect', '--quiet', `--unit=${a.unit}`, ...(a.description ? [`--description=${a.description}`] : []), ...props.flatMap((p) => ['-p', p]), '--', a.cmd, ...a.args],
  };
}

// ─── Victim protection (the tool-process wrapper) ──────────────────────────────────────────────────────────────────

/** oom_score_adj of every Bash tool command: highest preference for the OOM killer; the keeper and the CLI stay at 0. */
export const OOM_ADJ_TOOLS = 1000;
export const OOM_TOOL_WRAPPER_FILE = 'oom-tool-wrapper.sh';
export const INNER_SHELL_PREFIX_ENV = 'ORCHESTRA_INNER_SHELL_PREFIX';

/** The CLI splits CLAUDE_CODE_SHELL_PREFIX into executable + args at whitespace, so a wrapper path with a space (a home dir with a space in it) would silently run a different command:
 *  such a path is NOT used — the keeper reports `unprotected` instead of wrapping tools wrongly. Must be absolute. */
export function wrapperPathUsable(p: string | undefined | null): p is string {
  return typeof p === 'string' && p.startsWith('/') && !/\s/.test(p);
}

/** `CLAUDE_CODE_SHELL_PREFIX` target (measured on CLI 2.1.291: it is invoked as `<prefix> <whole command string>` — ONE argument). */
export const OOM_TOOL_WRAPPER_SCRIPT = `#!/bin/sh
# Orchestra Plafond mémoire (#320) — installed by the app, set as CLAUDE_CODE_SHELL_PREFIX by a capped keeper.
# The keeper and the CLI sit at the default (0) and an unprivileged process cannot go below its floor, so protect them by RAISING this tool command (everything under it inherits it) so the
# kernel's OOM killer picks a tool process, never the keeper or the CLI (both stay at 0).
echo ${OOM_ADJ_TOOLS} > /proc/self/oom_score_adj 2>/dev/null
[ "$#" -eq 1 ] || exec "$@"
if [ -n "\${${INNER_SHELL_PREFIX_ENV}:-}" ]; then
  # the user's own prefix, chained exactly as the CLI would have called it
  exec \$${INNER_SHELL_PREFIX_ENV} "$1"
fi
case "\${SHELL:-}" in */bash|*/zsh) sh_=$SHELL ;; *) sh_=/bin/bash ;; esac
exec "$sh_" -c "$1"
`;

// ─── Reading a scope (FI-1 b) ──────────────────────────────────────────────────────────────────────────────────────

export interface MemoryEvents {
  high: number;
  max: number;
  oom: number;
  oomKill: number;
  oomGroupKill: number;
}

/** Parse `memory.events` ("key value" lines). Null when no counter is readable — an empty read is not "all zero". */
export function parseMemoryEvents(text: string): MemoryEvents | null {
  const m = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && /^\d+$/.test(v)) m.set(k, Number(v));
  }
  if (!m.has('oom_kill')) return null;
  return { high: m.get('high') ?? 0, max: m.get('max') ?? 0, oom: m.get('oom') ?? 0, oomKill: m.get('oom_kill') ?? 0, oomGroupKill: m.get('oom_group_kill') ?? 0 };
}

/** A cgroup limit file: `max` ⇒ null (no limit), a number ⇒ bytes, anything else ⇒ null. */
export function parseCgroupLimit(text: string): number | null {
  const v = text.trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** The cgroup-v2 path (`/user.slice/…/x.scope`) in a `/proc/<pid>/cgroup` text, or null (v1 / unreadable). */
export function parseProcCgroupV2(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('0::')) return line.slice(3).trim() || null;
  }
  return null;
}

/** True when a raw `/proc/<pid>/cmdline` is the keeper for `wsId` — `systemd-run --scope` exec'd INTO it: `<runtime> …/keeper.js <wsId> …`. A hung launcher (still `systemd-run`) is not. */
export function launcherExecedKeeper(cmdlineRaw: string, keeperScript: string, wsId: string): boolean {
  const argv = cmdlineRaw.split('\0').filter((a) => a.length > 0);
  if (argv.length === 0 || /(^|\/)systemd-run$/.test(argv[0])) return false; // the launcher's own argv CONTAINS the keeper command after `--`
  const i = argv.indexOf(keeperScript);
  return i >= 0 && argv[i + 1] === wsId;
}

/** Review m4: is the swap escape CLOSED? `memory.swap.max` must read `0`. A kernel without swap accounting has no such file: that is fine ONLY on a host with no swap at all
 *  (`SwapTotal: 0`); with swap present and no file the hog parks in zram and `MemoryMax` never kills — the scope is not a cap. */
export function swapLimitApplied(swapMaxText: string | null, swapTotalKb: number | null): boolean {
  if (swapMaxText !== null) return swapMaxText.trim() === '0';
  return swapTotalKb === 0;
}

export interface ScopeMemory {
  currentBytes: number;
  peakBytes: number | null;
  /** null = no limit (or unreadable). A capped scope reads a number. */
  maxBytes: number | null;
  highBytes: number | null;
  swapMaxBytes: number | null;
  swapCurrentBytes: number | null;
  events: MemoryEvents;
}

// ─── Telling the session from the Reliquats (FI-1 c) ───────────────────────────────────────────────────────────────

export interface ScopeMember {
  pid: number;
  /** /proc/<pid>/stat field 22 — with `pid` the identity (a pid alone is only a name). */
  startTicks: number;
  ppid: number;
  comm: string;
  cmdline: string;
  rssBytes: number;
}

export type ScopeRole = 'keeper' | 'cli' | 'session' | 'reliquat';

/** A process of the keeper's process TREE that is NOT in the keeper's scope (FI-1 v1.9): it escaped — typically a browser's main process in its own systemd scope. It is the member's memory
 *  all the same: the consumer that bills the member must add it. `cgroup` = its cgroup-v2 path. */
export type TreeOutsideScope = ScopeMember & { cgroup: string };
export type ClassifiedMember = ScopeMember & { role: ScopeRole };

/**
 * `keeper` = the keeper pid (when it is a member); `cli` = `cliPid`; `session` = any other member whose ppid chain reaches the
 * keeper (MCP servers, hooks, a running tool command); `reliquat` = every member whose chain does NOT reach a live keeper of this
 * scope (reparented to init, or no keeper at all). The chain is walked with `parentOf` (default: inside the member set only, a parent outside
 * the scope ends the walk; the app passes the host-wide resolver so a helper whose parent left the scope is still traced to the keeper).
 */
export function classifyScopeMembers(
  members: readonly ScopeMember[],
  keeperPid: number | null,
  cliPid: number | null = null,
  /** FI-1 v1.9: the parent of ANY pid on the host (null = unknown / init). Default = look inside the member set only. A browser's main process that moved itself into its OWN transient scope
   *  (measured: app-org.chromium.Chromium-<pid>.scope) leaves its helpers' chain broken at the scope boundary: the helpers are still the session's, and the chain must be walked beyond the scope. */
  parentOf?: (pid: number) => number | null,
): ClassifiedMember[] {
  const byPid = new Map(members.map((m) => [m.pid, m]));
  const keeperIn = keeperPid !== null && byPid.has(keeperPid);
  // A pid in the member set is walked from the SNAPSHOT's ppid (a member that exits between the snapshot and the walk must not read as «orphaned»); only a pid OUTSIDE the set asks the host resolver.
  const parent = (pid: number): number | null => {
    const m = byPid.get(pid);
    return m ? m.ppid : (parentOf?.(pid) ?? null);
  };
  const reaches = (m: ScopeMember): boolean => {
    let cur: number | null = m.pid;
    for (let hops = 0; cur !== null && cur > 0 && hops < 256; hops++) {
      if (cur === keeperPid) return true;
      cur = parent(cur);
    }
    return false;
  };
  return members.map((m) => {
    let role: ScopeRole;
    if (keeperIn && m.pid === keeperPid) role = 'keeper';
    else if (keeperIn && cliPid !== null && m.pid === cliPid && reaches(m)) role = 'cli';
    else if (keeperIn && reaches(m)) role = 'session';
    else role = 'reliquat';
    return { ...m, role };
  });
}

// ─── Naming the killed command (FI-1 b) ────────────────────────────────────────────────────────────────────────────

export interface VictimSnap {
  pid: number;
  startTicks: number;
  comm: string;
  cmdline: string;
  rssPages: number;
  adj: number;
}

export const snapKey = (pid: number, startTicks: number): string => `${pid}:${startTicks}`;

/** One kill by the Plafond mémoire. `command` is a best match (the kernel does not name its victim): null when nothing vanished. */
export interface MemKillRecord {
  /** Absent on a record written before #322 (= `kill`). */
  kind?: 'kill';
  /** How the victim was named (#322 m2): `kernel` = the kernel's own OOM line (journal), pid + comm exact; `inferred` = ranked from the member snapshots (a larger command that exited in the same window can be mistaken for it); absent = an older keeper (= inferred). */
  source?: 'kernel' | 'inferred';
  /** Monotonic per keeper (1, 2, …) — a reattaching app delivers only what it has not seen. */
  seq: number;
  at: number;
  /** `hard` = the scope hit its own MemoryMax (the `oom` counter moved); `external` = an OOM kill from outside the scope's own limit (global OOM). */
  level: 'hard' | 'external';
  command: string | null;
  pid: number | null;
  rssBytes: number | null;
  /** Other processes that vanished in the same window (ambiguity is shown, never hidden). */
  candidates: string[];
  unit: string;
  hardBytes: number | null;
}

/** The scope's memory crossed the WARNING level upward (#322, ledger D-Q2) — never a kernel limit, nothing is slowed. One record per crossing; `seq` shares the kills' counter, so one per-unit cursor covers both. */
export interface MemSoftRecord {
  kind: 'soft';
  seq: number;
  at: number;
  unit: string;
  /** The reading that crossed: the scope's working set (`memory.current` − `inactive_file`, ledger R5). */
  bytes: number;
  softBytes: number;
  hardBytes: number | null;
}
/** What the keeper hands the host to tell the member and its coordinator about. */
export type MemNoticeRecord = MemKillRecord | MemSoftRecord;
export const isSoftRecord = (r: MemNoticeRecord): r is MemSoftRecord => r.kind === 'soft';

/** `memory.stat` → name → bytes/count (only the lines of the form `name <integer>`). */
export function parseMemoryStat(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+)\s+(\d+)\s*$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** The scope's WORKING SET (ledger R5): `memory.current` minus the inactive page cache. The raw figure counts every file page the member's commands touched (a `pnpm install`, a `git` pack) —
 *  the kernel reclaims that cache before it kills anything, so warning on it would cry wolf; what can actually cost a kill is what stays. Without `inactive_file` it is the raw figure. */
export function workingSetBytes(currentBytes: number, stat: Record<string, number>): number {
  return Math.max(0, currentBytes - (stat.inactive_file ?? 0));
}

/** Re-arm the warning once the scope falls below this fraction of the level (a scope hovering AT the level must not report every sample). */
export const SOFT_REARM_FRACTION = 0.9;

// ─── The kernel's own record of a memcg OOM kill (#322 m2) ─────────────────────────────────────────────────────────

/** One `oom-kill:` line of the kernel log: which cgroup hit its limit and exactly which task died. */
export interface KernelOomKill {
  atMs: number;
  pid: number;
  comm: string;
  /** The cgroup that hit its limit / the victim's cgroup (paths as the kernel prints them). */
  oomMemcg: string;
  taskMemcg: string;
}

/** Parse the MESSAGE of a kernel log line; null unless it is a memcg `oom-kill:` line. */
export function parseKernelOomMessage(message: string, atMs: number): KernelOomKill | null {
  if (!message.startsWith('oom-kill:') || !message.includes('CONSTRAINT_MEMCG')) return null;
  const m = /oom_memcg=([^,]*),task_memcg=([^,]*),task=(.*),pid=(\d+),uid=\d+/.exec(message);
  if (!m) return null;
  const pid = Number(m[4]);
  return Number.isInteger(pid) && pid > 0 ? { atMs, pid, comm: m[3], oomMemcg: m[1], taskMemcg: m[2] } : null;
}

/** The kernel kills that belong to THIS scope (its own cgroup hit its limit — basename = the unit), not older than `sinceMs`, oldest first. */
export function kernelKillsForUnit(lines: readonly KernelOomKill[], unit: string, sinceMs: number): KernelOomKill[] {
  const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
  return lines
    .filter((l) => l.atMs >= sinceMs && (base(l.oomMemcg) === unit || base(l.taskMemcg) === unit))
    .sort((a, b) => a.atMs - b.atMs || a.pid - b.pid);
}

/**
 * Replace the inferred victim of each record with the kernel's: `kills` are the unit's kernel lines for this window, oldest first, paired with the
 * records in order. A record with no line left keeps its inference (`source: 'inferred'`). `vanished` = the members seen before this look
 * (the command line / rss of a pid we had snapshotted). Returns new records; the inputs are not mutated.
 */
export function applyKernelKills(records: readonly MemKillRecord[], kills: readonly KernelOomKill[], vanished: readonly Pick<VictimSnap, 'pid' | 'comm' | 'cmdline' | 'rssPages'>[], pageSize = 4096): MemKillRecord[] {
  return records.map((r, i) => {
    const k = kills[i];
    if (!k) return { ...r, source: 'inferred' };
    const seen = vanished.find((v) => v.pid === k.pid);
    return {
      ...r,
      source: 'kernel',
      command: seen ? describeCommand(seen.cmdline, seen.comm) : k.comm,
      pid: k.pid,
      rssBytes: seen ? seen.rssPages * pageSize : null,
      candidates: [], // everything else that vanished in the window exited on its own: the kernel said who died
    };
  });
}

// ─── The words (the member's notice row, the coordinator's bus message, the app log) ───────────────────────────────

const fmtGb = (bytes: number): string => {
  const g = bytes / GIB;
  return `${Number.isInteger(g) ? g : +g.toFixed(2)} GB`; // 6 GB, 3.1 GB, 0.25 GB (a rig cap) — never a rounded-off cap
};

/** The row the member sees. One text for the live row and the reopened one (the builder is the single source). */
export function memNoticeText(rec: MemNoticeRecord): string {
  if (isSoftRecord(rec)) {
    return `Memory at ${fmtGb(rec.bytes)} — Plafond mémoire warning level (${fmtGb(rec.softBytes)}) crossed${rec.hardBytes !== null ? `; hard cap ${fmtGb(rec.hardBytes)}` : ''}`;
  }
  const reason = rec.level === 'hard'
    ? `Plafond mémoire${rec.hardBytes !== null ? ` ${fmtGb(rec.hardBytes)}` : ''} reached`
    : 'killed by the system under memory pressure (not by the Plafond mémoire)';
  if (rec.command === null) return `A command was killed: ${reason} (it lived too briefly to be named)`;
  const cmd = rec.command.length > 120 ? `${rec.command.slice(0, 119)}…` : rec.command;
  const prefix = rec.source === 'kernel' ? `Command ${cmd}` : `A command (probably ${cmd})`;
  return rec.level === 'hard' ? `${prefix} killed: ${reason}` : `${prefix} ${reason}`;
}

/** The ONE message the coordinator gets: workspace, command, level. */
export function memBusBody(wsLabel: string, rec: MemNoticeRecord): string {
  if (isSoftRecord(rec)) {
    return `Plafond mémoire — workspace ${wsLabel}: memory ${fmtGb(rec.bytes)} crossed the warning level (${fmtGb(rec.softBytes)})${rec.hardBytes !== null ? `, hard cap ${fmtGb(rec.hardBytes)}` : ''}. Nothing was killed or slowed. Scope ${rec.unit}.`;
  }
  const cmd = rec.command === null ? 'an unnamed command (it lived too briefly)' : `${rec.source === 'kernel' ? 'command' : 'probably the command'} \`${rec.command}\`${rec.pid !== null ? ` (pid ${rec.pid}${rec.rssBytes ? `, ~${Math.round(rec.rssBytes / (1024 * 1024))} MB` : ''})` : ''}`;
  const lvl = rec.level === 'hard' ? `hard level${rec.hardBytes !== null ? ` (${fmtGb(rec.hardBytes)})` : ''}` : 'an OOM kill from outside the scope limit';
  return `Plafond mémoire — workspace ${wsLabel}: ${cmd} KILLED at the ${lvl}. The member's session survived. Scope ${rec.unit}.`;
}

/** The app-log line for one warning-level crossing. */
export function formatMemSoftLine(wsLabel: string, rec: MemSoftRecord): string {
  return `memory-cap[${wsLabel}] warning level crossed: ${(rec.bytes / GIB).toFixed(2)} GB >= ${(rec.softBytes / GIB).toFixed(2)} GB — scope ${rec.unit} — at ${new Date(rec.at).toISOString()}`;
}

/** The kernel's own ranking (mm/oom_kill.c oom_badness): RSS pages + adj/1000 × the cgroup's page budget. */
export function estimateOomBadness(s: Pick<VictimSnap, 'rssPages' | 'adj'>, totalPages: number): number {
  if (s.adj <= -1000) return Number.NEGATIVE_INFINITY;
  return s.rssPages + (s.adj / 1000) * totalPages;
}

export function describeCommand(cmdline: string, comm: string, max = 200): string {
  const c = (cmdline || comm || '').replace(/\s+/g, ' ').trim();
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

export interface InferKillsInput {
  /** The last snapshot of the scope's members (key = {@link snapKey}). */
  before: ReadonlyMap<string, VictimSnap>;
  /** Keys alive NOW. */
  aliveKeys: ReadonlySet<string>;
  /** Counter movement since the previous look. */
  /** `oomKill` = kills this look saw; `hardCredit` = how many of them the scope's OWN limit accounts for (the carried `oom` credit, see memory-watch.ts) — the first `hardCredit` records are `hard`, the rest `external`. */
  delta: { oomKill: number; hardCredit: number };
  maxBytes: number | null;
  unit: string;
  seqNext: number;
  nowMs: number;
  pageSize?: number;
}

/**
 * One record per process the kernel killed (`delta.oomKill`). The victims are the snapshot members that vanished, ranked by the
 * kernel's own badness estimate; ties and extra vanished processes are listed as `candidates`. No vanished process ⇒ `command: null`
 * (the kill is real — the counter says so — but it lived < one snapshot interval and cannot be named).
 */
export function inferKillRecords(a: InferKillsInput): MemKillRecord[] {
  if (a.delta.oomKill <= 0) return [];
  const page = a.pageSize ?? 4096;
  const totalPages = a.maxBytes !== null ? Math.max(1, Math.floor(a.maxBytes / page)) : 1;
  const vanished = [...a.before.entries()]
    .filter(([k]) => !a.aliveKeys.has(k))
    .map(([, s]) => s)
    .sort((x, y) => estimateOomBadness(y, totalPages) - estimateOomBadness(x, totalPages) || y.rssPages - x.rssPages);
  const out: MemKillRecord[] = [];
  for (let i = 0; i < a.delta.oomKill; i++) {
    const v = vanished[i];
    const others = vanished.filter((_, j) => j !== i && (a.delta.oomKill === 1 || j >= a.delta.oomKill)).slice(0, 5);
    out.push({
      kind: 'kill',
      source: 'inferred',
      seq: a.seqNext + i,
      at: a.nowMs,
      level: i < a.delta.hardCredit ? 'hard' : 'external',
      command: v ? describeCommand(v.cmdline, v.comm) : null,
      pid: v ? v.pid : null,
      rssBytes: v ? v.rssPages * page : null,
      candidates: others.map((o) => describeCommand(o.cmdline, o.comm, 80)),
      unit: a.unit,
      hardBytes: a.maxBytes,
    });
  }
  return out;
}

/** The app-log line for one kill (workspace, killed command, level). */
export function formatMemKillLine(wsLabel: string, rec: MemKillRecord): string {
  const cmd = rec.command === null ? 'an unnamed process (it lived less than one snapshot)' : `"${rec.command}" (pid ${rec.pid}, ~${Math.round((rec.rssBytes ?? 0) / (1024 * 1024))} MB)`;
  const lvl = rec.level === 'hard' ? `hard level${rec.hardBytes !== null ? ` (${(rec.hardBytes / GIB).toFixed(2)} GB)` : ''}` : 'an OOM kill from outside the scope limit';
  const amb = rec.candidates.length ? ` — also gone in the same window: ${rec.candidates.join(' | ')}` : '';
  return `memory-cap[${wsLabel}] killed ${cmd} at the ${lvl} — scope ${rec.unit} — at ${new Date(rec.at).toISOString()}${amb}${rec.source === 'kernel' ? ' — victim named by the kernel log' : ''}`;
}

/** What the app says about a freshly launched scoped keeper, from the state the keeper reports (`helloAck.cap.state`). `warn` states are ones where the promise «a runaway tool dies, the session survives» does NOT hold. */
export function describeCapState(state: 'active' | 'unprotected' | 'not-applied' | 'no-scope' | undefined, unit: string, hardBytes: number): { level: 'info' | 'warn'; text: string } {
  const hard = `${(hardBytes / GIB).toFixed(2)} GB`;
  switch (state) {
    case 'active':
      return { level: 'info', text: `ACTIVE — scope ${unit}, hard ${hard}, tool commands run at oom_score_adj ${OOM_ADJ_TOOLS}` };
    case 'unprotected':
      return { level: 'warn', text: `scope ${unit} has its hard limit (${hard}) but the tool wrapper is unusable — the kernel would kill the CLI (the biggest process) before a runaway tool command` };
    case 'not-applied':
      return { level: 'warn', text: `scope ${unit} exists but its memory limit (${hard}) or its swap limit (0) is NOT applied (memory controller not delegated? no swap accounting?) — this member runs UNCAPPED` };
    case 'no-scope':
      return { level: 'warn', text: `the keeper is not in scope ${unit} — this member runs UNCAPPED` };
    default:
      return { level: 'warn', text: `the keeper did not report a cap state for scope ${unit} (an older keeper?) — this member's cap is UNVERIFIED` };
  }
}

// ─── bus-status ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryCapStatusView {
  /** The run's frozen switch; null = the run has no row (nothing frozen). */
  switchOn: boolean | null;
  softBytes: number;
  hardBytes: number;
  /** Member scopes live on this HOST right now (any run — scopes are not tagged with a run); null = unsupported / not counted. */
  scopes: number | null;
  /** Of those, how many have NO memory limit applied (`memory.max` = max): a scope that is not a cap. */
  unlimited?: number;
  supported: boolean;
  unsupportedReason?: string;
}

/** The `memory cap:` line of `orchestra bus-status`. */
export function formatMemoryCapLine(v: MemoryCapStatusView): string {
  const levels = `hard ${(v.hardBytes / GIB).toFixed(1)} GB (kernel kill, no swap) · soft ${(v.softBytes / GIB).toFixed(1)} GB (warning level, no kernel throttle)`;
  if (v.switchOn === null) return `memory cap: no run — nothing frozen (levels when a run freezes it ON: ${levels})`;
  if (!v.switchOn) return `memory cap: OFF for this run (frozen) — no member scope; levels if it were ON: ${levels}`;
  const scopes = v.scopes === null ? '' : ` · ${v.scopes} member scope(s) live${v.unlimited ? `, ${v.unlimited} WITHOUT a limit applied` : ''}`;
  const sup = v.supported ? '' : ` · NOT TRACKED on this host (${v.unsupportedReason ?? 'unsupported'})`;
  return `memory cap: ON for this run (frozen) — ${levels}; read at each member's next session start, running sessions keep what they started with${scopes}${sup}`;
}
