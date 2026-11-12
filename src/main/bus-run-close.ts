// #437 — a run closes with its coordinator (ADR 0012): archiving or deleting the agent that coordinates a run sets
// `runs.closed_at`; unarchiving reopens the SAME run (a run's id IS its coordinator's workspace id, so there is no
// "new run" to mint — see ledger #443 DECISION for #437). Platform-free (BusDb only) so the real functions are driven
// over a real SQLite bus by the tests; workspaces.ts feeds them workspace ids. Nothing here ever throws into a caller's
// archive/delete path — those wrappers catch (D1: the bus never blocks a workspace operation).

import type { BusDb } from './bus.ts';

/** Close every OPEN run whose coordinator is one of `coordinatorIds`. Returns the run ids it closed (idempotent: an already
 *  closed run keeps its FIRST closing time and is not reported again). */
export function closeRunsCoordinatedBy(db: BusDb, coordinatorIds: readonly string[], now: number = Date.now()): string[] {
  const out: string[] = [];
  const sel = db.prepare('SELECT id FROM runs WHERE coordinator = ? AND closed_at IS NULL');
  const upd = db.prepare('UPDATE runs SET closed_at = ? WHERE id = ? AND closed_at IS NULL');
  db.transaction(() => {
    for (const c of coordinatorIds) {
      for (const r of sel.all(c) as Array<{ id: string }>) {
        if (upd.run(now, r.id).changes === 1) out.push(r.id);
      }
    }
  }).immediate();
  return out;
}

/** Reopen every CLOSED run whose coordinator is one of `coordinatorIds` (unarchive). History, unread mail and the frozen
 *  switches are untouched — only `closed_at` clears. Returns the run ids it reopened. */
export function reopenRunsCoordinatedBy(db: BusDb, coordinatorIds: readonly string[]): string[] {
  const out: string[] = [];
  const sel = db.prepare('SELECT id FROM runs WHERE coordinator = ? AND closed_at IS NOT NULL');
  const upd = db.prepare('UPDATE runs SET closed_at = NULL WHERE id = ? AND closed_at IS NOT NULL');
  db.transaction(() => {
    for (const c of coordinatorIds) {
      for (const r of sel.all(c) as Array<{ id: string }>) {
        if (upd.run(r.id).changes === 1) out.push(r.id);
      }
    }
  }).immediate();
  return out;
}

/** Every closed run id — what a sweep that enumerates runs filters out. */
export function closedRunIds(db: BusDb): Set<string> {
  return new Set((db.prepare('SELECT id FROM runs WHERE closed_at IS NOT NULL').all() as Array<{ id: string }>).map((r) => r.id));
}

/** The first of `runIds` that is CLOSED (`{ id, closedAt }`), or null when none is (an unknown id is not closed: the
 *  unknown-run refusal owns that). Order = the caller's order, so the refusal names the run the sender is acting in first. */
export function firstClosedRun(db: BusDb, runIds: ReadonlyArray<string | null | undefined>): { id: string; closedAt: number } | null {
  const q = db.prepare('SELECT closed_at AS c FROM runs WHERE id = ?');
  for (const id of runIds) {
    if (!id) continue;
    const r = q.get(id) as { c: number | null } | undefined;
    if (r && r.c !== null && r.c !== undefined) return { id, closedAt: Number(r.c) };
  }
  return null;
}

/** What the store says about a run's coordinator: `live` (exists, not archived), `archived`, or `gone` (no such workspace). */
export type CoordinatorState = 'live' | 'archived' | 'gone';

/** App start (and the only repair for a close/reopen a crash or a bus outage dropped): a run is closed iff its coordinator is
 *  archived or gone — close the open ones whose coordinator is not live, reopen the closed ones whose coordinator is live.
 *  Never creates a row and never touches the frozen switches, so the #433 sweep + `ensureTopLevelRun` (INSERT-OR-IGNORE on the
 *  run id) cannot re-create a closed run: it stays exactly one row, closed or open. */
export function reconcileRunClosure(
  db: BusDb,
  stateOf: (coordinatorId: string) => CoordinatorState,
  now: number = Date.now(),
): { closed: string[]; reopened: string[] } {
  const closed: string[] = [];
  const reopened: string[] = [];
  const rows = db.prepare('SELECT id, coordinator, closed_at FROM runs').all() as Array<{ id: string; coordinator: string; closed_at: number | null }>;
  db.transaction(() => {
    for (const r of rows) {
      const live = stateOf(r.coordinator) === 'live';
      if (!live && r.closed_at === null) {
        if (db.prepare('UPDATE runs SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(now, r.id).changes === 1) closed.push(r.id);
      } else if (live && r.closed_at !== null) {
        if (db.prepare('UPDATE runs SET closed_at = NULL WHERE id = ? AND closed_at IS NOT NULL').run(r.id).changes === 1) reopened.push(r.id);
      }
    }
  }).immediate();
  return { closed, reopened };
}
