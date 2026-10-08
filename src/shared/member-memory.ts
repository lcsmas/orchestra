// #328 (wave H, ledger #329; epic #319; contract FI-1 v1) — a member's memory read from ITS kernel scope, Reliquats counted. PURE half (the I/O half is
// src/main/member-memory.ts). A Reliquat (CONTEXT.md §Memory) = a process the member launched that left its tree; the process-tree walk cannot see it, the scope can.
// Dependency-free so `node --test` covers it without cgroups. Structural inputs only: this file never imports H1's memory-scope.ts types (FI-1.3 stays one-way).

/** One scope generation as read: the kernel meter + its members. `null` = could not be read (the scope vanished mid-read) — unmeasured, never 0. */
export interface ScopeReading {
  unit: string;
  gen: string;
  /** `memory.current` of the scope — the kernel's own meter (page cache included; it is what the Plafond compares to). */
  currentBytes: number | null;
  /** The scope's members with their role (`reliquat` = chain reaches no live keeper of this scope, FI-1.4); null = could not be listed. */
  procs: ReadonlyArray<{ pid: number; startTicks: number; rssBytes: number; role: string; comm?: string }> | null;
  /** The live keeper of this member iff it runs INSIDE this scope (H1's identity read, or found by its argv when the pid file is not there yet); null = the member's keeper is not in this scope. */
  keeperPid: number | null;
}

/** One tracked member: the SUM over its scope generations (a restart while Reliquats keep the old scope alive leaves two). */
export interface MemberMemoryView {
  wsId: string;
  /** Scope generations found (≥ 1). */
  scopes: number;
  /** Σ kernel meter over the readable generations; null = none readable. With `unreadable > 0` it is a LOWER BOUND. */
  bytes: number | null;
  unreadable: number;
  /** Live Reliquats over the listable generations; null = none listable. With `unlisted > 0` it is a lower bound. */
  reliquats: number | null;
  /** Σ RSS of those Reliquats (null with `reliquats`) — RSS, NOT the kernel bill: a Reliquat's shared pages are counted per process here and once in `bytes`, so this can exceed the member's bill. */
  reliquatBytes: number | null;
  unlisted: number;
  /** The heaviest live Reliquats (≤ {@link MAX_RELIQUAT_PROCS}, by RSS) for the page's expanded row — pid + comm only, no argv. [] = none / not listable. */
  reliquatProcs: Array<{ pid: number; comm: string; rssBytes: number }>;
  /** Some scope of this member holds its keeper. false = the member's keeper (if any runs) is OUTSIDE every scope it has — the scopes are an older generation's leftovers, so the keeper tree and the scope bill are DISJOINT. */
  keeperInScope: boolean;
}

/** How many Reliquats a member's view carries for display (the IPC payload stays small; the count is exact regardless). */
export const MAX_RELIQUAT_PROCS = 8;

/** One reading of every live member. JSON-safe (IPC snapshot, /busStatus, resources.jsonl). */
export interface MemberMemoryReport {
  at: number;
  /** Members with ≥ 1 scope, heaviest first (unmeasured last), ties by id. */
  tracked: MemberMemoryView[];
  /** Live members (a keeper runs) WITHOUT a scope: their memory stays the process-tree figure and their Reliquats are NOT tracked. */
  untracked: string[];
  /** Why this host cannot scope anything at all (`scopeSupport()` reason); null = supported. */
  unsupported: string | null;
  /** Member scopes that exist on this host but belong to NO workspace we asked about (a workspace gone from the store whose detached processes live on): counted, NOT read — FI-1 cannot enumerate scopes without an id. null = not countable. */
  strayScopes: number | null;
}

const sum = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Fold a member's scope generations into one view. Never 0 for what could not be read. */
export function memberViewFrom(wsId: string, readings: readonly ScopeReading[]): MemberMemoryView {
  const meters = readings.map((r) => r.currentBytes).filter(finite);
  const listed = readings.filter((r) => r.procs !== null);
  const reliquats = listed.flatMap((r) => (r.procs ?? []).filter((p) => p.role === 'reliquat'));
  return {
    wsId,
    scopes: readings.length,
    bytes: meters.length === 0 ? null : sum(meters),
    unreadable: readings.length - meters.length,
    reliquats: listed.length === 0 ? null : reliquats.length,
    reliquatBytes: listed.length === 0 ? null : sum(reliquats.map((p) => (finite(p.rssBytes) ? p.rssBytes : 0))),
    unlisted: readings.length - listed.length,
    reliquatProcs: reliquats
      .map((p) => ({ pid: p.pid, comm: p.comm ?? '?', rssBytes: finite(p.rssBytes) ? p.rssBytes : 0 }))
      .sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid)
      .slice(0, MAX_RELIQUAT_PROCS),
    keeperInScope: readings.some((r) => r.keeperPid !== null && r.keeperPid !== undefined),
  };
}

export function buildMemberMemoryReport(at: number, tracked: readonly MemberMemoryView[], untracked: readonly string[], unsupported: string | null, strayScopes: number | null = null): MemberMemoryReport {
  const order = (v: MemberMemoryView): number => v.bytes ?? -1;
  return {
    at,
    tracked: [...tracked].sort((a, b) => order(b) - order(a) || a.wsId.localeCompare(b.wsId)),
    untracked: [...untracked].sort(),
    unsupported,
    strayScopes,
  };
}

export const viewFor = (r: MemberMemoryReport | null | undefined, wsId: string | null): MemberMemoryView | undefined => (r && wsId ? r.tracked.find((m) => m.wsId === wsId) : undefined);

/** Total live Reliquats over the report (lower bound when `anyUnlisted`). */
export function reliquatTotals(r: MemberMemoryReport): { count: number; bytes: number; members: number; anyUnlisted: boolean } {
  let count = 0;
  let bytes = 0;
  let members = 0;
  let anyUnlisted = false;
  for (const m of r.tracked) {
    if (m.unlisted > 0) anyUnlisted = true;
    if (m.reliquats && m.reliquats > 0) {
      count += m.reliquats;
      bytes += m.reliquatBytes ?? 0;
      members++;
    }
  }
  return { count, bytes, members, anyUnlisted };
}

/**
 * What the Resources row shows as the member's process memory (before containers). A scope-tracked member = the scope's meter (it holds the keeper's whole tree AND every Reliquat) PLUS the PTY sessions
 * (the Electron-hosted terminals are outside the scope); the `<wsId>:sdk` keeper tree is INSIDE it, so it is NOT added a second time. Untracked / meter unreadable → the plain tree sum (master's figure).
 * A partial read (one generation unreadable) is a lower bound: never below the keeper tree it replaces. When NO scope holds the keeper (`keeperInScope` false: the live keeper runs unscoped next to an older generation's leftovers)
 * the two are disjoint and ADD — never the stale scope in place of the live tree.
 */
export function rowProcessBytes(sessions: ReadonlyArray<{ kind: string; memBytes: number }>, view: MemberMemoryView | undefined): number {
  const all = sum(sessions.map((s) => s.memBytes));
  if (!view || view.bytes === null) return all;
  if (!view.keeperInScope) return all + view.bytes;
  const sdk = sum(sessions.filter((s) => s.kind === 'sdk').map((s) => s.memBytes));
  const outside = all - sdk;
  return outside + (view.unreadable > 0 ? Math.max(view.bytes, sdk) : view.bytes);
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

export const reliquatWord = (n: number): string => `${n} Reliquat${n === 1 ? '' : 's'}`;

const untrackedWhy = (r: MemberMemoryReport): string =>
  // never NAME a cause we did not observe: OFF-for-its-run is one of several (a human workspace, a session started before the switch, an unsupported host)
  r.unsupported ?? 'no live member has a scope (e.g. memory_cap OFF for its run, a session started before it was ON, a human workspace)';
const strayPhrase = (n: number): string => `${n} scope${n === 1 ? '' : 's'} of workspaces not in the store ${n === 1 ? 'was' : 'were'} not read`;

/**
 * The dim line under the Resources page's Agents table (D-Q3 option A): « Reliquats not tracked … » and the stray scopes. null = nothing to say (no live member, or every live member is tracked
 * and no stray scope) — a healthy page shows no line. Not a problem state: the page renders it dim, not yellow.
 */
export function reliquatsNote(r: MemberMemoryReport | null | undefined): string | null {
  if (!r) return null;
  const stray = r.strayScopes ?? 0;
  const bits: string[] = [];
  if (r.tracked.length === 0) {
    if (r.untracked.length > 0 || stray > 0) bits.push(`Reliquats not tracked — ${untrackedWhy(r)}`);
  } else if (r.untracked.length > 0) bits.push(`Reliquats not tracked for ${r.untracked.length} member${r.untracked.length === 1 ? '' : 's'} (no scope)`);
  if (stray > 0) bits.push(strayPhrase(stray));
  return bits.length === 0 ? null : bits.join(' · ');
}

/** The tooltip of a row's « ⚠ N Reliquats » chip: the count, their RSS, and what a Reliquat IS. */
export function reliquatChipTitle(c: { count: number; bytes: number; partial: boolean }): string {
  return `${reliquatWord(c.count)}${c.partial ? ' (at least — a scope could not be listed)' : ''} · ${fmtBytes(c.bytes)} RSS — processes this workspace launched that outlived its session or left its process tree`;
}

/** The `reliquats:` line of `orchestra bus-status` (host-wide, like `containers:`). Always one line when the app returned a report. */
export function formatReliquatsLine(r: MemberMemoryReport, labelOf: (wsId: string) => string): string {
  const stray = r.strayScopes ?? 0;
  const strayText = strayPhrase(stray);
  if (r.tracked.length === 0) return `reliquats: Reliquats not tracked — ${untrackedWhy(r)}${stray > 0 ? ` · ${strayText}` : ''}`;
  const parts: string[] = [];
  const withR = r.tracked.filter((m) => m.reliquats !== null && m.reliquats > 0);
  const t = reliquatTotals(r);
  if (withR.length === 0) parts.push(t.anyUnlisted ? '0 live (lower bound)' : '0 live');
  else parts.push(`${t.count} live${t.anyUnlisted ? ' (lower bound)' : ''} — ${withR.map((m) => `${labelOf(m.wsId)} ×${m.reliquats} · ${fmtBytes(m.reliquatBytes ?? 0)} RSS`).join(', ')}`);
  parts.push(`${r.tracked.length} member${r.tracked.length === 1 ? '' : 's'} tracked`);
  if (r.untracked.length > 0) parts.push(`Reliquats not tracked for ${r.untracked.length} member${r.untracked.length === 1 ? '' : 's'} (no scope)`);
  const blind = r.tracked.filter((m) => m.unlisted > 0 || m.bytes === null).length;
  if (blind > 0) parts.push(`${blind} member${blind === 1 ? '' : 's'} could not be fully read — figures incomplete`);
  if (stray > 0) parts.push(strayText);
  return `reliquats: ${parts.join(' · ')}`;
}
