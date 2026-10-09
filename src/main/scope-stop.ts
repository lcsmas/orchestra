// #327 (wave H ledger #329, FI-1 of the member scope #320): an EXPLICIT stop of a member (stop, clear, archive, delete, account migration) stops everything in its scope — Reliquats included — so nothing it launched
// survives it. NOT the Veille (#326), NOT a restart or a resume by id (those keep the scope and its Reliquats: restarting the app leaves every scope intact). Electron-free; every I/O is injected.
//
// Order, fail-closed (UNKNOWN is not NONE): (1) kill the member's Reliquats BY IDENTITY, re-read at the moment of each signal and refused when unreadable (`killReliquats`, #325 — one implementation, not two);
// (2) only when the scopes were READ, nothing was refused and no live session of the member sits in a scope (a racing restart may have started a NEW generation: its keeper is not ours to stop), stop THAT scope's
// unit — named by FI-1 `memberScopes(wsId)` and re-checked to be this workspace's own — with `systemctl --user stop`, then verify it is gone. Never another member's scope, never a process outside `memberScopes(wsId)`.

import type { ReliquatReport, ScopeListing, ScopeRef } from '../shared/pause-reliquats.ts';

export interface ScopeStopDeps {
  /** FI-1 `memberScopes(wsId)`, every generation. [] = NOT TRACKED (switch OFF, no scope, unsupported host): nothing to do. A throw = UNKNOWN. */
  scopes(): ScopeRef[];
  /** The scope's processes with their FI-1 role, read NOW. 'gone' = the unit no longer exists; 'unreadable' = UNKNOWN. */
  list(scope: ScopeRef): ScopeListing;
  /** The identity-checked Reliquat kill of #325 over THIS member's scopes. null = no tracked scope. */
  killReliquats(): Promise<ReliquatReport | null>;
  /** `systemctl --user stop <unit>`; throws on failure. Called ONLY for a unit `ownsUnit` accepts. */
  stopUnit(unit: string): Promise<void>;
  /** Is `unit` a scope of exactly THIS workspace (prefix + workspace id + generation)? — the last guard before a unit is stopped. */
  ownsUnit(unit: string): boolean;
  /** Is this member's tracked keeper still alive? An explicit stop stops the SESSION first; a live keeper means the caller did not (yet) — the Reliquats of a RUNNING member are not ours to kill. */
  keeperAlive(): boolean;
  sleep(ms: number): Promise<void>;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
}

export interface ScopeStopReport {
  wsId: string;
  reason: string;
  /** Units found for the member. */
  scopes: string[];
  /** Units stopped by this call and verified gone (or found already gone). */
  stopped: string[];
  /** Units deliberately left alone, with why. */
  kept: Array<{ unit: string; reason: string }>;
  killed: number;
  /** Set when the kill could not be completed or a scope could not be read: nothing was stopped on an unknown. */
  unknown?: string;
}

const GONE_WAIT_MS = 2000;
const GONE_POLL_MS = 50;

/** Stop the member's whole scope(s). Never throws (a stop must not block a delete): failures are in the report. null = the member has no tracked scope. */
export async function stopMemberScope(wsId: string, reason: string, deps: ScopeStopDeps): Promise<ScopeStopReport | null> {
  let found: ScopeRef[];
  try {
    found = deps.scopes();
  } catch (e) {
    const unknown = `scope lookup failed: ${e instanceof Error ? e.message : String(e)}`;
    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${unknown} — nothing stopped`);
    return { wsId, reason, scopes: [], stopped: [], kept: [], killed: 0, unknown };
  }
  if (found.length === 0) return null;
  const report: ScopeStopReport = { wsId, reason, scopes: found.map((s) => s.unit), stopped: [], kept: [], killed: 0 };
  if (deps.keeperAlive()) {
    report.unknown = "the member's keeper is still alive — the session must be stopped first (the detached jobs of a RUNNING member are not Reliquats to kill)";
    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${report.unknown}`);
    return report;
  }

  // (1) the Reliquats, by identity
  let rel: ReliquatReport | null = null;
  try {
    rel = await deps.killReliquats();
  } catch (e) {
    report.unknown = `Reliquat kill failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (rel) {
    report.killed = rel.killed.length;
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
  for (const scope of fresh) if (!report.scopes.includes(scope.unit)) report.scopes.push(scope.unit);
  // A unit systemd already removed (the kill emptied it; `--collect`) is gone — counted stopped, never left in neither list.
  const stillThere = new Set(fresh.map((s) => s.unit));
  for (const unit of report.scopes) if (!stillThere.has(unit) && deps.ownsUnit(unit)) report.stopped.push(unit);
  for (const scope of fresh) {
    if (!deps.ownsUnit(scope.unit)) {
      report.kept.push({ unit: scope.unit, reason: 'not a scope of this workspace — never touched' });
      continue;
    }
    const listing = deps.list(scope);
    if (listing === 'gone') {
      report.stopped.push(scope.unit); // every process died with the kill: systemd already removed the unit
      continue;
    }
    if (listing === 'unreadable') {
      report.kept.push({ unit: scope.unit, reason: 'cgroup.procs unreadable — not stopped on an unknown' });
      continue;
    }
    if (refused > 0) {
      report.kept.push({ unit: scope.unit, reason: `${refused} Reliquat(s) refused (identity unreadable or changed) — a unit stop would kill them unchecked` });
      continue;
    }
    if (listing.some((m) => m.role === 'keeper' || m.role === 'cli' || m.role === 'session')) {
      report.kept.push({ unit: scope.unit, reason: 'a live session of this member runs in it (a restart started a new generation) — not ours to stop' });
      continue;
    }
    if (deps.keeperAlive()) {
      report.kept.push({ unit: scope.unit, reason: 'a keeper of this member came up meanwhile — not ours to stop' });
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
  deps.log.info(`scope-stop[${wsId}] (${reason}): killed ${report.killed}, stopped ${report.stopped.length}/${report.scopes.length} unit(s)${report.kept.length ? `, kept ${report.kept.map((k) => `${k.unit} (${k.reason})`).join('; ')}` : ''}`);
  return report;
}
