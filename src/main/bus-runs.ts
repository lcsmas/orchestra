// Run rows carrying the FROZEN per-mechanism switch flags (#118, ledger #123).
//
// The wave-A core (src/main/bus.ts) created the `runs` table but nothing writes
// it (#114 left the run lifecycle to #115). This module adds the one thing #118
// owns: a run row records the switch snapshot taken AT WAVE START, and every
// later read of "is mechanism X on for this run" goes through THAT ROW, never
// through the live store.
//
// SCHEMA SLOT — deliberately NOT `MIGRATIONS[2]`. §Open-questions Q-B1 on ledger
// #123: #115, #116 and #118 could each append a `MIGRATIONS[2]`, and because
// `migrate()` applies by VERSION INDEX, a DB already stamped v2 by whichever
// build ran first would SKIP the others' SQL forever — a data bug that looks
// like nothing. So this module applies its own additive DDL idempotently
// (`ensureRunFlagsSchema`) and consumes no version number. Fold it into
// whatever migration the LEAD assigns the slot to; until then it collides with
// nobody.

import type { BusDb } from './bus.ts';
import {
  type BusSwitches,
  freezeSwitches,
  parseSwitches,
  serializeSwitches,
} from '../shared/bus-switches.ts';

/** A run as the pane renders it: the mission/wave tree plus its frozen flags. */
export interface BusRunRow {
  id: string;
  kind: string;
  coordinator: string;
  parent_run_id: string | null;
  title: string | null;
  created_at: number;
  closed_at: number | null;
  /** The switch snapshot frozen when this run started. Never re-read live. */
  flags: BusSwitches;
}

/**
 * Additive, idempotent DDL. Safe to call on every open and from N processes at
 * once (`IF NOT EXISTS` + busy_timeout).
 *
 * `run_flags` is a SIDECAR table rather than an `ALTER TABLE runs ADD COLUMN`,
 * for one reason that matters: `ADD COLUMN` is not expressible as
 * `IF NOT EXISTS` in SQLite, so a second call throws `duplicate column name`
 * and any caller that swallows that error is also swallowing every real DDL
 * failure. A sidecar keyed on run_id is idempotent by construction.
 */
export function ensureRunFlagsSchema(db: BusDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_flags (
      run_id     TEXT PRIMARY KEY,
      -- JSON object, one boolean per mechanism. See shared/bus-switches.ts for
      -- why it is not a bitmask (a bitmask silently reassigns meaning when the
      -- mechanism list grows).
      flags      TEXT NOT NULL,
      frozen_at  INTEGER NOT NULL
    );
  `);
}

/**
 * START A RUN: snapshot the live switches ONCE and write them to the row.
 *
 * THE FREEZE, at the write boundary. After this returns, nothing re-reads the
 * live switches for this run — not the pane, not a mechanism guard, not the
 * startup notice. A flip lands in the store and is picked up by the NEXT
 * `startRun`, which is what T118.2 asserts in both directions.
 *
 * INSERT OR IGNORE, not REPLACE: calling `startRun` twice for one run id must
 * be a no-op, never a re-freeze. A re-freeze is precisely the mid-wave mutation
 * the feature forbids, and it would arrive through the most innocent-looking
 * path there is — an idempotent-looking "ensure the run exists" call on a
 * resume. The row wins; the second caller's live switches are discarded.
 */
export function startRun(
  db: BusDb,
  input: {
    id: string;
    kind: string;
    coordinator: string;
    parentRunId?: string | null;
    title?: string | null;
  },
  liveSwitches: BusSwitches,
  busAvailable = true,
): BusRunRow {
  if (!input.id?.trim()) throw new Error('bus.startRun: run id is required');
  if (!input.coordinator?.trim()) throw new Error('bus.startRun: coordinator is required');
  ensureRunFlagsSchema(db);
  const frozen = freezeSwitches(liveSwitches, busAvailable);
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO runs (id, kind, coordinator, parent_run_id, title, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      input.id,
      input.kind,
      input.coordinator,
      input.parentRunId ?? null,
      input.title ?? null,
      now,
    );
    db.prepare('INSERT OR IGNORE INTO run_flags (run_id, flags, frozen_at) VALUES (?,?,?)').run(
      input.id,
      serializeSwitches(frozen),
      now,
    );
  });
  tx.immediate();
  // Read the row BACK rather than returning what we intended to write: if the
  // INSERT OR IGNORE was ignored (run already started), the caller must receive
  // the ALREADY-FROZEN flags, not the ones it just offered. Returning the
  // in-memory snapshot here would make a second startRun LOOK like a re-freeze
  // to its caller while the row said otherwise — the two would drift silently.
  const row = getRun(db, input.id);
  if (!row) throw new Error(`bus.startRun: run ${input.id} vanished immediately after insert`);
  return row;
}

/** Read one run row with its frozen flags, or null. */
export function getRun(db: BusDb, runId: string): BusRunRow | null {
  ensureRunFlagsSchema(db);
  const row = db
    .prepare(
      `SELECT r.*, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        WHERE r.id = ?`,
    )
    .get(runId) as (Record<string, unknown> & { flags_json?: string | null }) | undefined;
  if (!row) return null;
  return toRunRow(row);
}

/**
 * THE READ EVERY MECHANISM GUARD MUST USE: the run's frozen flags.
 *
 * An UNKNOWN run reads as all-OFF, not as the live switches. A mechanism firing
 * because its run row was missing is indistinguishable in the field from the
 * switch genuinely being on, and it would fire on exactly the runs whose
 * provenance is already unrecoverable.
 */
export function runFlags(db: BusDb, runId: string): BusSwitches {
  return getRun(db, runId)?.flags ?? parseSwitches(null);
}

/** Every run, newest first — the pane's mission/wave tree source. */
export function listRuns(db: BusDb, limit = 200): BusRunRow[] {
  ensureRunFlagsSchema(db);
  const rows = db
    .prepare(
      `SELECT r.*, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`,
    )
    .all(limit) as (Record<string, unknown> & { flags_json?: string | null })[];
  return rows.map(toRunRow);
}

function toRunRow(row: Record<string, unknown> & { flags_json?: string | null }): BusRunRow {
  return {
    id: String(row.id),
    kind: String(row.kind),
    coordinator: String(row.coordinator),
    parent_run_id: (row.parent_run_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    created_at: Number(row.created_at),
    closed_at: (row.closed_at as number | null) ?? null,
    flags: parseSwitches(row.flags_json ?? null),
  };
}
