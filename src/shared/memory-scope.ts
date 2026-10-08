// Plafond mémoire — the per-member kernel scope, PURE half (#320, wave H ledger #329, ADR 0005; contract = ledger FI-1).
// Impure halves: src/main/memory-scope.ts (resolve / read a member's scope), src/keeper/memory-watch.ts (the kill watch),
// src/main/memory-cap-switch.ts (the frozen switch + settings read at session start). Nothing here touches the OS.
//
// What a Plafond mémoire IS on this host (measured 2026-10-08, docs/codebase-map/session-keeper.md § Plafond mémoire):
//  - `MemoryMax` alone kills only with `MemorySwapMax=0` (zram swap would absorb the overflow otherwise);
//  - systemd's default `OOMPolicy=stop` ENDS THE WHOLE SCOPE after one oom_kill — `OOMPolicy=continue` is what makes "never group-kill" true;
//  - `MemoryHigh` below `MemoryMax` throttles a runaway to a crawl instead of ever reaching the kill (ledger Q2): the soft level is
//    stored and carried, but only APPLIED when {@link APPLY_SOFT_LEVEL} is true;
//  - an unprivileged process can only RAISE its oom_score_adj, so tool processes are raised (+{@link OOM_ADJ_TOOLS}) and the keeper/CLI keep 0.

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

/** What the host asks of a keeper's scope. `softBytes` is carried for the day Q2 is ruled; only {@link APPLY_SOFT_LEVEL} applies it. */
export interface MemoryCapLimits {
  hardBytes: number;
  softBytes: number | null;
  /** Always 0: with swap on, `MemoryMax` is not a cap (the overflow parks in zram). */
  swapMaxBytes: 0;
}

/** Ledger Q2 default while unanswered: NO `MemoryHigh` — a soft throttle below the hard level crawls a runaway forever instead of killing it. */
export const APPLY_SOFT_LEVEL = false;

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
    if (APPLY_SOFT_LEVEL && a.limits.softBytes !== null) props.push(`MemoryHigh=${a.limits.softBytes}`);
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

/** `CLAUDE_CODE_SHELL_PREFIX` target (measured on CLI 2.1.291: it is invoked as `<prefix> <whole command string>` — ONE argument). */
export const OOM_TOOL_WRAPPER_SCRIPT = `#!/bin/sh
# Orchestra Plafond mémoire (#320) — installed by the app, set as CLAUDE_CODE_SHELL_PREFIX by a capped keeper.
# An unprivileged process can only RAISE its oom_score_adj: raise this tool command (everything under it inherits it) so the
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
export type ClassifiedMember = ScopeMember & { role: ScopeRole };

/**
 * `keeper` = the keeper pid (when it is a member); `cli` = `cliPid`; `session` = any other member whose ppid chain reaches the
 * keeper (MCP servers, hooks, a running tool command); `reliquat` = every member whose chain does NOT reach a live keeper of this
 * scope (reparented to init, or no keeper at all). The chain is walked inside the member set only: a parent outside the scope
 * that is not the keeper ends the walk.
 */
export function classifyScopeMembers(members: readonly ScopeMember[], keeperPid: number | null, cliPid: number | null = null): ClassifiedMember[] {
  const byPid = new Map(members.map((m) => [m.pid, m]));
  const keeperIn = keeperPid !== null && byPid.has(keeperPid);
  const reaches = (m: ScopeMember): boolean => {
    let cur: ScopeMember | undefined = m;
    for (let hops = 0; cur && hops < 256; hops++) {
      if (cur.pid === keeperPid) return true;
      cur = byPid.get(cur.ppid);
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
  delta: { oomKill: number; oom: number };
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
  const level: MemKillRecord['level'] = a.delta.oom > 0 ? 'hard' : 'external';
  const out: MemKillRecord[] = [];
  for (let i = 0; i < a.delta.oomKill; i++) {
    const v = vanished[i];
    const others = vanished.filter((_, j) => j !== i && (a.delta.oomKill === 1 || j >= a.delta.oomKill)).slice(0, 5);
    out.push({
      seq: a.seqNext + i,
      at: a.nowMs,
      level,
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
  return `memory-cap[${wsLabel}] killed ${cmd} at the ${lvl} — scope ${rec.unit}${amb}`;
}

// ─── bus-status ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryCapStatusView {
  /** The run's frozen switch; null = the run has no row (nothing frozen). */
  switchOn: boolean | null;
  softBytes: number;
  hardBytes: number;
  /** Live scopes of this run's members (the app's count at the last look); null = unsupported / not counted. */
  scopes: number | null;
  supported: boolean;
  unsupportedReason?: string;
}

/** The `memory cap:` line of `orchestra bus-status`. */
export function formatMemoryCapLine(v: MemoryCapStatusView): string {
  const levels = `hard ${(v.hardBytes / GIB).toFixed(1)} GB (kernel kill, no swap)${APPLY_SOFT_LEVEL ? ` · soft ${(v.softBytes / GIB).toFixed(1)} GB` : ` · soft ${(v.softBytes / GIB).toFixed(1)} GB stored, not applied`}`;
  if (v.switchOn === null) return `memory cap: no run — nothing frozen (levels when a run freezes it ON: ${levels})`;
  if (!v.switchOn) return `memory cap: OFF for this run (frozen) — no member scope; levels if it were ON: ${levels}`;
  const scopes = v.scopes === null ? '' : ` · ${v.scopes} member scope(s) live`;
  const sup = v.supported ? '' : ` · NOT TRACKED on this host (${v.unsupportedReason ?? 'unsupported'})`;
  return `memory cap: ON for this run (frozen) — ${levels}; read at each member's next session start, running sessions keep what they started with${scopes}${sup}`;
}
