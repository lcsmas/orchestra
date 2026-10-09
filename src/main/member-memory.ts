// #328 (wave H, ledger #329; epic #319; contract FI-1 v1) — the PRODUCER of per-member memory read from the member's kernel scope. Pure half: src/shared/member-memory.ts.
// Consumers resolve a scope ONLY through FI-1's `memberScopes` / `readScopeMemory` / `listScopeProcs` (src/main/memory-scope.ts) — never a hard-coded slice path (FI-1.3); `[]` = not tracked,
// and the member keeps today's process-tree figure. Read-only: it never signals, moves or stops anything (the Pause/stop tracks own that, FI-1.4). Electron-free: ids and the clock are injected.

import { countMemberScopes, listKeeperTreeOutsideScope, listScopeProcs, memberScopes, readScopeMemory, scopeSupportCached, type MemberScope } from './memory-scope.ts';
import { scoped } from './logger.ts';
import { buildMemberMemoryReport, memberViewFrom, type MemberMemoryReport, type MemberMemoryView, type ScopeReading } from '../shared/member-memory.ts';

const mlog = scoped('member-memory');

/** A scope that vanishes mid-read is normal (its last process exited); the page polls every 2 s, so a failure is logged ONCE per distinct subject, not per sample. */
const warned = new Set<string>();
function warnOnce(what: string, e: unknown): void {
  if (warned.has(what)) return;
  if (warned.size > 256) warned.clear();
  warned.add(what);
  mlog.swallow(what, e);
}

export interface MemberMemoryDeps {
  now(): number;
  /** Every workspace id worth asking about (the store's, plus any with a live keeper). */
  workspaceIds(): string[];
  /** Workspace ids with a LIVE keeper — a member that runs; such a member without a scope is "not tracked". */
  liveMemberIds(): string[];
  /** FI-1 `memberScopes`: [] = not tracked. */
  scopes(wsId: string): MemberScope[];
  /** FI-1 `readScopeMemory`: null / throw = unmeasured. */
  readMemory(scope: MemberScope): { currentBytes: number; maxBytes?: number | null; workingSetBytes?: number | null; peakBytes?: number | null } | null;
  /** FI-1 `listScopeProcs`: null / throw = unlisted. */
  listProcs(scope: MemberScope): ScopeReading['procs'];
  /** FI-1 v1.9 `listKeeperTreeOutsideScope`: the processes of the keeper's tree (host-wide ppid chain) that left THIS scope — a browser main that moved itself into its own systemd scope (#328 review F1). Called with the scope that holds the keeper; null / throw = not measured (nothing is billed). Optional: a host without it bills the scope alone. */
  escaped?(scope: MemberScope): Array<{ pid: number; comm: string; rssBytes: number }> | null;
  /** FI-1 `scopeSupportCached` (`scopeSupport` is ~6 stat calls — too many for a 2 s poll). */
  support(): { ok: true } | { ok: false; reason: string };
  /** H1's `countMemberScopes().total`: every member scope on the host (any workspace) — null = not countable. The surplus over the scopes we READ is reported, never read. */
  countScopes(): number | null;
}

/** The FI-1 functions, wrapped so a throw anywhere reads as "unmeasured / not tracked" — the monitor line, the page and bus-status never fail on a scope. */
export function realMemberMemoryDeps(ids: { workspaceIds(): string[]; liveMemberIds(): string[] }): MemberMemoryDeps {
  return {
    now: () => Date.now(),
    workspaceIds: ids.workspaceIds,
    liveMemberIds: ids.liveMemberIds,
    scopes: (wsId) => memberScopes(wsId),
    readMemory: (s) => readScopeMemory(s),
    listProcs: (s) => listScopeProcs(s),
    support: () => scopeSupportCached(), // 30 s cache (H1): the page polls every 2 s
    countScopes: () => countMemberScopes()?.total ?? null,
    escaped: (s) => listKeeperTreeOutsideScope(s),
  };
}

/** FI-1 v1.9's walk costs one stat read per HOST pid per call (H1): the page polls every 2 s. Memoize it per (scope unit, keeper pid) for this long; the monitor's once-a-minute LINE is a record, not a poll, and bypasses it. */
export const ESCAPED_TTL_MS = 10_000;
const escapedMemo = new Map<string, { at: number; value: Array<{ pid: number; comm: string; rssBytes: number }> | null }>();

export function memoizeEscaped(base: NonNullable<MemberMemoryDeps['escaped']>, opts: { fresh?: boolean; now?: () => number } = {}): NonNullable<MemberMemoryDeps['escaped']> {
  const now = opts.now ?? Date.now;
  return (s) => {
    const t = now();
    const key = `${s.unit}:${s.keeperPid}`;
    const hit = escapedMemo.get(key);
    if (!opts.fresh && hit && t - hit.at >= 0 && t - hit.at < ESCAPED_TTL_MS) return hit.value;
    const value = base(s);
    escapedMemo.set(key, { at: t, value });
    if (escapedMemo.size > 256) for (const [k, v] of escapedMemo) if (t - v.at > 5 * ESCAPED_TTL_MS) escapedMemo.delete(k);
    return value;
  };
}

let warnedSupport: string | null = null;

/** One reading of every candidate member. Never throws. Sync sysfs reads only (cgroup files + /proc via FI-1): ~1 ms with no scope, plus ~12 µs per process living in a scope (measured). */
export function sampleMemberMemory(d: MemberMemoryDeps): MemberMemoryReport {
  let support: ReturnType<MemberMemoryDeps['support']>;
  try {
    support = d.support();
  } catch (e) {
    support = { ok: false, reason: `scope support could not be probed: ${(e as Error)?.message ?? e}` };
  }
  const tracked = [];
  const trackedIds = new Set<string>();
  for (const wsId of new Set(d.workspaceIds())) {
    let scopes: MemberScope[];
    try {
      scopes = d.scopes(wsId);
    } catch (e) {
      warnOnce(`memberScopes(${wsId})`, e);
      continue; // an unreadable directory scan = not tracked: today's behaviour
    }
    if (scopes.length === 0) continue;
    const readings: ScopeReading[] = scopes.map((s) => {
      let currentBytes: number | null = null;
      let mem: ReturnType<MemberMemoryDeps['readMemory']> = null;
      try {
        mem = d.readMemory(s);
        currentBytes = mem?.currentBytes ?? null;
      } catch (e) {
        warnOnce(`readScopeMemory(${s.unit})`, e);
      }
      let procs: ScopeReading['procs'] = null;
      try {
        // FI-1 `listScopeProcs` answers [] for a scope that vanished (and for one whose cgroup.procs it could not read): with the meter ALSO unreadable that is « gone », not « zero Reliquats » — unlisted
        procs = currentBytes === null ? null : d.listProcs(s);
      } catch (e) {
        warnOnce(`listScopeProcs(${s.unit})`, e);
      }
      // `s.keeperPid` is FI-1's own identity read (pid file, or — while the keeper has not written it yet — the scope's keeper.js process by argv); null = this member's keeper is NOT in this scope
      return { unit: s.unit, gen: s.gen, currentBytes, procs, keeperPid: s.keeperPid, maxBytes: mem?.maxBytes ?? null, workingSetBytes: mem?.workingSetBytes ?? null, peakBytes: mem?.peakBytes ?? null };
    });
    // What the keeper's tree holds OUTSIDE its scope (a browser main in its own systemd scope): in nobody's bill. Only a keeper that is IN one of the scopes has a tree to walk; one read of /proc per sample, lazily.
    const keeperAt = readings.findIndex((r) => r.keeperPid !== null);
    let outside: Array<{ pid: number; comm: string; rssBytes: number }> = [];
    if (keeperAt >= 0 && d.escaped) {
      try {
        outside = d.escaped(scopes[keeperAt]) ?? [];
      } catch (e) {
        warnOnce(`listKeeperTreeOutsideScope(${wsId})`, e);
      }
    }
    trackedIds.add(wsId);
    tracked.push(memberViewFrom(wsId, readings, outside));
  }
  let live: string[] = [];
  try {
    live = d.liveMemberIds();
  } catch (e) {
    warnOnce('liveMemberIds', e);
  }
  // untracked = a live member (its keeper runs) whose CURRENT session is in no scope: it has none at all, OR only an older generation's leftovers (its live keeper is outside them)
  const keeperless = new Set(tracked.filter((v: MemberMemoryView) => !v.keeperInScope).map((v) => v.wsId));
  const untracked = [...new Set(live)].filter((id) => !trackedIds.has(id) || keeperless.has(id));
  const unsupported = support.ok ? null : support.reason;
  if (unsupported !== warnedSupport) {
    warnedSupport = unsupported;
    if (unsupported) mlog.info(`member scopes unavailable on this host — Reliquats not tracked (${unsupported})`);
  }
  let stray: number | null = null;
  try {
    const all = d.countScopes();
    if (all !== null) stray = Math.max(0, all - tracked.reduce((n, m) => n + m.scopes, 0));
  } catch (e) {
    warnOnce('countMemberScopes', e);
  }
  return buildMemberMemoryReport(d.now(), tracked, untracked, unsupported, stray);
}

/** Test seam: forget the logged support state. */
export const __resetMemberMemoryForTests = (): void => {
  warnedSupport = null;
  warned.clear();
  escapedMemo.clear();
};
