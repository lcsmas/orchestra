// Bilan de pause — the `pause_records` half of the fleet Pause (#252 D1b, ADR 0003, schema =
// MIGRATIONS[9], frozen by D1a). One row per member per trap, written by the HOST TRAP
// (src/main/pause-trap.ts) and read by `orchestra run status`. `run_id` is the pause CARRIER
// (the run `run resume` lifts); the member's own run is `activity.memberRun`.
//
// `activity` is a JSON object (shape: BilanActivity), `killed_json` a KillReport, both
// stored as TEXT so the frozen schema never changes.

import type { BusDb } from './bus.ts';
import { runSubtreeIds, type RunPauseInfo } from './bus-pause.ts';
import { parseSwitches } from '../shared/bus-switches.ts';

/** What the member was doing when the Pause took effect + what the trap did (all optional but `surface`). */
export interface BilanActivity {
  surface: 'sdk' | 'pty' | 'none' | 'remote';
  memberRun?: string;
  status?: string;
  turnRunning?: boolean;
  interrupt?: 'interrupted' | 'idle' | 'no-session' | 'attached-then-interrupted' | 'failed' | 'exempt' | 'skipped';
  inFlightTools?: Array<{ tool: string | null; toolUseId: string | null; sinceMs: number | null }>;
  bgTasks?: Array<{ id: string; type?: string; description: string; status: string }>;
  lastTask?: string;
  branch?: string | null;
  head?: string | null;
  changed?: { modified: number; added: number; deleted: number };
  skippedLarge?: Array<{ path: string; bytes: number }>;
  /** Files the snapshot could not read (everything else is in the ref). */
  snapshotWarnings?: string[];
  submodules?: Array<{ path: string; ref: string | null; dirty: boolean; error?: string }>;
  /** `pauser`: the member that issued the pause keeps its turn (snapshot + row only). */
  exempt?: 'pauser';
  /** Free-text trail: turn starts observed while paused, partial failures. */
  notes?: string[];
  /** Processes the TURN OBSERVER (a CLI-started turn while paused) killed — kept apart from `killed_json`, which belongs to the pause-time trap
   *  (a non-NULL `killed_json` means "this member's trap is complete"). */
  observerKilled?: Array<{ pid: number; cmd: string; signal: string; outcome: string }>;
}

export interface BilanRow {
  id: number;
  runId: string;
  wsId: string;
  pausedAt: number;
  activity: BilanActivity | null;
  snapshotRef: string | null;
  dirty: boolean | null;
  killed: unknown | null;
  error: string | null;
  createdAt: number;
}

interface RawRow {
  id: number;
  run_id: string;
  ws_id: string;
  paused_at: number;
  activity: string | null;
  snapshot_ref: string | null;
  dirty: number | null;
  killed_json: string | null;
  error: string | null;
  created_at: number;
}

function parse<T>(s: string | null): T | null {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function toRow(r: RawRow): BilanRow {
  return {
    id: Number(r.id),
    runId: r.run_id,
    wsId: r.ws_id,
    pausedAt: Number(r.paused_at),
    activity: parse<BilanActivity>(r.activity),
    snapshotRef: r.snapshot_ref ?? null,
    dirty: r.dirty === null || r.dirty === undefined ? null : Number(r.dirty) !== 0,
    killed: parse<unknown>(r.killed_json),
    error: r.error ?? null,
    createdAt: Number(r.created_at),
  };
}

export interface BilanInput {
  runId: string;
  wsId: string;
  pausedAt: number;
  activity: BilanActivity | null;
  snapshotRef: string | null;
  dirty: boolean | null;
  killed: unknown | null;
  error: string | null;
}

export function insertBilan(db: BusDb, r: BilanInput, now = Date.now()): number {
  const info = db
    .prepare(
      `INSERT INTO pause_records (run_id, ws_id, paused_at, activity, snapshot_ref, dirty, killed_json, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      r.runId,
      r.wsId,
      r.pausedAt,
      r.activity === null ? null : JSON.stringify(r.activity),
      r.snapshotRef,
      r.dirty === null ? null : r.dirty ? 1 : 0,
      r.killed === null ? null : JSON.stringify(r.killed),
      r.error,
      now,
    );
  return Number(info.lastInsertRowid);
}

export function updateBilan(db: BusDb, id: number, patch: Partial<Omit<BilanInput, 'runId' | 'wsId' | 'pausedAt'>>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('activity' in patch) {
    sets.push('activity = ?');
    vals.push(patch.activity === null ? null : JSON.stringify(patch.activity));
  }
  if ('snapshotRef' in patch) {
    sets.push('snapshot_ref = ?');
    vals.push(patch.snapshotRef);
  }
  if ('dirty' in patch) {
    sets.push('dirty = ?');
    vals.push(patch.dirty === null ? null : patch.dirty ? 1 : 0);
  }
  if ('killed' in patch) {
    sets.push('killed_json = ?');
    vals.push(patch.killed === null ? null : JSON.stringify(patch.killed));
  }
  if ('error' in patch) {
    sets.push('error = ?');
    vals.push(patch.error);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE pause_records SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

/** The member's Bilan row for THIS pause (carrier + `paused_at`), newest first, or null. */
export function bilanForMember(db: BusDb, carrierRunId: string, wsId: string, pausedAt: number): BilanRow | null {
  const r = db
    .prepare('SELECT * FROM pause_records WHERE run_id = ? AND ws_id = ? AND paused_at = ? ORDER BY id DESC LIMIT 1')
    .get(carrierRunId, wsId, pausedAt) as RawRow | undefined;
  return r ? toRow(r) : null;
}

/** Every Bilan row of one pause (carrier + `paused_at`), oldest first. */
export function listBilan(db: BusDb, carrierRunId: string, pausedAt?: number): BilanRow[] {
  const rows =
    pausedAt === undefined
      ? (db.prepare('SELECT * FROM pause_records WHERE run_id = ? ORDER BY id').all(carrierRunId) as RawRow[])
      : (db
          .prepare('SELECT * FROM pause_records WHERE run_id = ? AND paused_at = ? ORDER BY id')
          .all(carrierRunId, pausedAt) as RawRow[]);
  return rows.map(toRow);
}

/** The rows a coordinator of `runId` should read: its own subtree's members under the carrier's pause. */
export function listBilanForRun(db: BusDb, carrierRunId: string, runId: string, pausedAt: number): BilanRow[] {
  const inScope = new Set(runSubtreeIds(db, runId));
  return listBilan(db, carrierRunId, pausedAt).filter((r) => {
    const mr = r.activity?.memberRun;
    return mr === undefined ? runId === carrierRunId : inScope.has(mr);
  });
}

/**
 * Stamp `runs.pause_trap_at`: the trap finished for THIS pause. Guarded on `paused_at` so a trap
 * that outlived a resume+re-pause cannot stamp the NEW pause as done.
 */
export function markTrapDone(db: BusDb, carrierRunId: string, pausedAt: number, at = Date.now()): boolean {
  const info = db
    .prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ? AND paused_at = ? AND pause_trap_at IS NULL')
    .run(at, carrierRunId, pausedAt);
  return info.changes === 1;
}

/** Append a note to a member's Bilan (creating a minimal row if the trap has none yet). */
export function appendBilanNote(db: BusDb, carrierRunId: string, wsId: string, pausedAt: number, note: string): void {
  const tx = db.transaction(() => {
    const row = bilanForMember(db, carrierRunId, wsId, pausedAt);
    if (!row) {
      insertBilan(db, {
        runId: carrierRunId,
        wsId,
        pausedAt,
        activity: { surface: 'none', notes: [note] },
        snapshotRef: null,
        dirty: null,
        killed: null,
        error: null,
      });
      return;
    }
    const a: BilanActivity = row.activity ?? { surface: 'none' };
    updateBilan(db, row.id, { activity: { ...a, notes: [...(a.notes ?? []), note].slice(-50) } });
  });
  tx.immediate();
}

/** Every carrier whose pause is ACTIVE (paused_at set AND its frozen `pause` switch ON), whether or not its trap finished.
 *  The re-arm pass reads it: a member's idle keeper must be watched for CLI-started turns for the whole pause. */
export function activePauseCarriers(db: BusDb): RunPauseInfo[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.paused_at, r.paused_by, r.pause_mode, r.pause_trap_at, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        WHERE r.paused_at IS NOT NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows
    .filter((r) => parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true)
    .map((r) => ({
      runId: String(r.id),
      pausedAt: Number(r.paused_at),
      pausedBy: (r.paused_by as string | null) ?? null,
      mode: (r.pause_mode as string | null) ?? null,
      trapAt: r.pause_trap_at === null || r.pause_trap_at === undefined ? null : Number(r.pause_trap_at),
    }));
}

/** The NEWEST pause that has Bilan rows in scope of `runId` (its own run or any run of its subtree) — readable after the
 *  lift: `pause_records` history outlives `run resume`. Null when none. */
export function latestPauseBilanFor(db: BusDb, runId: string): { carrierRunId: string; pausedAt: number; rows: BilanRow[] } | null {
  const inScope = new Set(runSubtreeIds(db, runId));
  const recent = db.prepare('SELECT * FROM pause_records ORDER BY id DESC LIMIT 500').all() as RawRow[];
  for (const raw of recent) {
    const r = toRow(raw);
    const mr = r.activity?.memberRun;
    if (r.runId === runId || (mr !== undefined && inScope.has(mr))) {
      const rows = listBilanForRun(db, r.runId, runId, r.pausedAt);
      if (rows.length > 0) return { carrierRunId: r.runId, pausedAt: r.pausedAt, rows };
    }
  }
  return null;
}

/** Record what the turn observer killed on a paused member, on its activity (never on `killed_json`: that marks the trap complete). */
export function appendObserverKills(
  db: BusDb,
  carrierRunId: string,
  wsId: string,
  pausedAt: number,
  killed: ReadonlyArray<{ pid: number; cmd: string; signal: string; outcome: string }>,
): void {
  if (killed.length === 0) return;
  const tx = db.transaction(() => {
    const row = bilanForMember(db, carrierRunId, wsId, pausedAt);
    const add = killed.map((k) => ({ pid: k.pid, cmd: k.cmd, signal: k.signal, outcome: k.outcome }));
    if (!row) {
      insertBilan(db, { runId: carrierRunId, wsId, pausedAt, activity: { surface: 'none', observerKilled: add }, snapshotRef: null, dirty: null, killed: null, error: null });
      return;
    }
    const a: BilanActivity = row.activity ?? { surface: 'none' };
    updateBilan(db, row.id, { activity: { ...a, observerKilled: [...(a.observerKilled ?? []), ...add].slice(-100) } });
  });
  tx.immediate();
}
