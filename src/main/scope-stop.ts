// #327 (wave H ledger #329, FI-1 of the member scope #320): an EXPLICIT stop of a member (stop, clear, archive, delete, account migration) stops everything in its scope — Reliquats included — so nothing it launched
// survives it. NOT the Veille (#326), NOT a restart or a resume by id (those keep the scope and its Reliquats: restarting the app leaves every scope intact). Electron-free; every I/O is injected.
//
// Per scope, fail-closed (UNKNOWN is not NONE). A scope that holds a LIVE member (keeper / CLI / session in its listing, or the tracked keeper's own unit) is never touched — a restart or a wake may have started a NEW
// generation, and the detached jobs of a RUNNING member are not Reliquats. The others ("dead" scopes) get: (1) their Reliquats killed BY IDENTITY, re-read at the moment of each signal and refused when unreadable
// (`killReliquats`, #325 — one implementation, not two); (2) only when the scopes were READ and nothing was refused, THAT unit stopped — named by FI-1 `memberScopes(wsId)`, re-checked to be this workspace's own —
// with `systemctl --user stop`, then verified gone. Never another member's scope, never a process outside `memberScopes(wsId)`.

import type { ReliquatReport, ScopeListing, ScopeMember, ScopeRef } from '../shared/pause-reliquats.ts';

export interface ScopeStopDeps {
  /** FI-1 `memberScopes(wsId)`, every generation. [] = NOT TRACKED (switch OFF, no scope, unsupported host): nothing to do. A throw = UNKNOWN. */
  scopes(): ScopeRef[];
  /** The scope's processes with their FI-1 role, read NOW. 'gone' = the unit no longer exists; 'unreadable' = UNKNOWN. */
  list(scope: ScopeRef): ScopeListing;
  /** The identity-checked Reliquat kill of #325, over THESE scopes only (the member's other scopes hold a live session). */
  killReliquats(only: ScopeRef[]): Promise<ReliquatReport | null>;
  /** `systemctl --user stop <unit>`; throws on failure. Called ONLY for a unit `ownsUnit` accepts. */
  stopUnit(unit: string): Promise<void>;
  /** Is `unit` a scope of exactly THIS workspace (prefix + workspace id + generation)? — the last guard before a unit is stopped. */
  ownsUnit(unit: string): boolean;
  /** The unit the member's TRACKED live keeper runs in: null = no live keeper, 'unknown' = alive but cannot be placed (fail closed: nothing is touched). */
  liveKeeperUnit(): string | null | 'unknown';
  sleep(ms: number): Promise<void>;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
}

export interface ScopeStopReport {
  wsId: string;
  reason: string;
  /** Units found for the member. */
  scopes: string[];
  /** Units stopped by this call and verified gone (or found already gone / removed by systemd once the kill emptied them). */
  stopped: string[];
  /** Units deliberately left alone, with why. */
  kept: Array<{ unit: string; reason: string }>;
  /** Reliquats the kill verified EXITED (a `survived` one is not counted here). */
  killed: number;
  /** Reliquats still alive after the last kill round (the unit stop is what takes them). */
  survivors: number;
  /** Set when the kill could not be completed or a scope could not be read: nothing was stopped on an unknown. */
  unknown?: string;
}

const GONE_WAIT_MS = 2000;
const GONE_POLL_MS = 50;
const LIVE_ROLES = new Set<ScopeMember['role']>(['keeper', 'cli', 'session']);
const hasLive = (l: ScopeMember[]): boolean => l.some((m) => LIVE_ROLES.has(m.role));

type Verdict =
  | { kind: 'foreign' | 'gone' | 'unreadable' | 'live' }
  | { kind: 'dead' };

/** Stop the member's whole scope(s). Never throws (a stop must not block a delete): failures are in the report. null = the member has no tracked scope. */
export async function stopMemberScope(wsId: string, reason: string, deps: ScopeStopDeps): Promise<ScopeStopReport | null> {
  let found: ScopeRef[];
  try {
    found = deps.scopes();
  } catch (e) {
    const unknown = `scope lookup failed: ${e instanceof Error ? e.message : String(e)}`;
    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${unknown} — nothing stopped`);
    return { wsId, reason, scopes: [], stopped: [], kept: [], killed: 0, survivors: 0, unknown };
  }
  if (found.length === 0) return null;
  const report: ScopeStopReport = { wsId, reason, scopes: found.map((s) => s.unit), stopped: [], kept: [], killed: 0, survivors: 0 };

  let liveUnit: string | null | 'unknown';
  try {
    liveUnit = deps.liveKeeperUnit();
  } catch {
    liveUnit = 'unknown';
  }
  if (liveUnit === 'unknown') {
    report.unknown = "the member's live keeper cannot be placed in a scope — nothing is touched";
    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${report.unknown}`);
    return report;
  }

  /** What may be done to `scope` NOW (a fresh listing every time). */
  const judge = (scope: ScopeRef): Verdict => {
    if (!deps.ownsUnit(scope.unit)) return { kind: 'foreign' };
    const listing = deps.list(scope);
    if (listing === 'gone') return { kind: 'gone' };
    if (listing === 'unreadable') return { kind: 'unreadable' };
    if (hasLive(listing) || scope.unit === liveUnit) return { kind: 'live' };
    return { kind: 'dead' };
  };
  const keptWhy = (kind: Verdict['kind'], again = false): string =>
    kind === 'foreign'
      ? 'not a scope of this workspace — never touched'
      : kind === 'unreadable'
        ? 'cgroup.procs unreadable — not stopped on an unknown'
        : again
          ? 'a live session of this member came up meanwhile — not ours to stop'
          : 'a live session of this member runs in it (a restart or a wake started a newer generation) — not ours to touch';

  // (0) which scopes are the stop's to act on
  const dead: ScopeRef[] = [];
  for (const scope of found) {
    const v = judge(scope);
    if (v.kind === 'gone') report.stopped.push(scope.unit); // every process died: systemd already removed the unit
    else if (v.kind === 'dead') dead.push(scope);
    else report.kept.push({ unit: scope.unit, reason: keptWhy(v.kind) });
  }
  if (dead.length === 0) {
    deps.log.info(`scope-stop[${wsId}] (${reason}): nothing to stop — stopped ${report.stopped.length}/${report.scopes.length}${report.kept.length ? `, kept ${report.kept.map((k) => `${k.unit} (${k.reason})`).join('; ')}` : ''}`);
    return report;
  }

  // (1) the Reliquats of the dead scopes, by identity
  let rel: ReliquatReport | null = null;
  try {
    rel = await deps.killReliquats(dead);
  } catch (e) {
    report.unknown = `Reliquat kill failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (rel) {
    report.killed = rel.killed.filter((k) => k.outcome === 'exited').length;
    report.survivors = rel.survivors.length;
    if (rel.survivors.length > 0) deps.log.warn(`scope-stop[${wsId}] (${reason}): ${rel.survivors.length} Reliquat(s) still alive after the kill rounds: ${rel.survivors.slice(0, 5).map((s) => `${s.pid}:${s.comm}`).join(' ')} — the unit stop is next`);
    if (rel.unknown) report.unknown = rel.unknown;
    else if (rel.error) report.unknown = rel.error;
  } else if (!report.unknown) {
    report.unknown = 'Reliquat kill returned no report'; // no report is UNKNOWN, not "nothing to kill"
  }
  const refused = rel?.refused.length ?? 0;
  if (report.unknown) {
    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${report.unknown} — no unit stopped (UNKNOWN is not NONE)`);
    return report;
  }

  // (2) the units, from a FRESH lookup (a generation may have come or gone while the Reliquats were killed)
  let fresh: ScopeRef[];
  try {
    fresh = deps.scopes();
  } catch (e) {
    report.unknown = `scope lookup failed after the kill: ${e instanceof Error ? e.message : String(e)}`;
    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${report.unknown}`);
    return report;
  }
  const freshUnits = new Set(fresh.map((s) => s.unit));
  for (const scope of fresh) {
    if (report.scopes.includes(scope.unit)) continue;
    report.scopes.push(scope.unit);
    report.kept.push({ unit: scope.unit, reason: 'appeared after the lookup — its Reliquats were not examined, not stopped' });
  }
  for (const scope of dead) {
    if (!freshUnits.has(scope.unit)) {
      report.stopped.push(scope.unit); // the kill emptied it and systemd removed it (`--collect`): gone, never left in neither list
      continue;
    }
    const v = judge(scope);
    if (v.kind === 'gone') {
      report.stopped.push(scope.unit);
      continue;
    }
    if (v.kind !== 'dead') {
      report.kept.push({ unit: scope.unit, reason: keptWhy(v.kind, true) });
      continue;
    }
    if (refused > 0) {
      report.kept.push({ unit: scope.unit, reason: `${refused} Reliquat(s) refused (identity unreadable or changed) — a unit stop would kill them unchecked` });
      continue;
    }
    try {
      await deps.stopUnit(scope.unit);
    } catch (e) {
      report.kept.push({ unit: scope.unit, reason: `systemctl stop failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    let gone = false;
    for (let waited = 0; waited <= GONE_WAIT_MS; waited += GONE_POLL_MS) {
      if (deps.list(scope) === 'gone') {
        gone = true;
        break;
      }
      await deps.sleep(GONE_POLL_MS);
    }
    if (gone) report.stopped.push(scope.unit);
    else report.kept.push({ unit: scope.unit, reason: 'still listed after systemctl stop' });
  }
  deps.log.info(`scope-stop[${wsId}] (${reason}): killed ${report.killed}${report.survivors ? ` (+${report.survivors} survivor(s))` : ''}, stopped ${report.stopped.length}/${report.scopes.length} unit(s)${report.kept.length ? `, kept ${report.kept.map((k) => `${k.unit} (${k.reason})`).join('; ')}` : ''}`);
  return report;
}
