// Run rows carrying the FROZEN per-mechanism switch flags (#118, ledger #123).
//
// The wave-A core (src/main/bus.ts) created the `runs` table but nothing writes
// it (#114 left the run lifecycle to #115). This module adds the one thing #118
// owns: a run row records the switch snapshot taken AT WAVE START, and every
// later read of "is mechanism X on for this run" goes through THAT ROW, never
// through the live store.
//
// SCHEMA SLOT — `MIGRATIONS[2]` in src/main/bus.ts, per OPS-B's ruling on
// §Open-questions Q-B1 (ledger #123). Wave B has four tickets needing DDL and
// `migrate()` applies BY VERSION INDEX, so two tickets claiming the same number
// means the later one's SQL is skipped forever on a DB already stamped with it.
// The ruling: take the next free number and RENUMBER AT REBASE (#118 is 4th in
// merge order, so expect to land on 5). The migration is the ONLY mechanism that
// creates this table — see the note below on why the idempotent "belt" helper was
// removed rather than kept alongside it.

import type { BusDb } from './bus.ts';
import {
  type BusSwitches,
  freezeSwitches,
  mechanismEnabled,
  mechanismFromWire,
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
  /** The run's coordinator generation (#128). 0 until an OPS respawn bumps it;
   *  a write carrying an OLDER generation is fenced. Rendered in the pane. */
  coordinator_generation: number;
}

// THE `ensureRunFlagsSchema()` HELPER IS DELIBERATELY GONE. Do not reintroduce it.
//
// It used to run `CREATE TABLE IF NOT EXISTS run_flags` at the top of every read
// and write, as an "idempotent belt" beside the real migration. OPS-B ruled it
// out (ledger #123, Q-B1) for two reasons, and the second one bit me before I
// removed it:
//
//   1. Schema creation in two places with two mechanisms means `schemaVersion(db)`
//      stops describing the DB's actual shape — the version no longer predicts
//      which tables exist.
//   2. `CREATE TABLE IF NOT EXISTS` is a SILENT NO-OP against a table that
//      already exists with a DIFFERENT shape, so a later migration altering this
//      table would leave the old columns and report success. Wrong-shape-passes-
//      green: failing in the direction that looks fine.
//
// MEASURED, not theoretical: with the belt in place I deleted `run_flags` from
// `MIGRATIONS[2]` — the exact slot-collision failure C11 exists to catch — and
// the whole suite stayed GREEN at 26/26, because the first read re-created the
// table. The belt was silently repairing the defect the gate was looking for.
// With it removed, that same mutant turns C11 red.
//
// The table now comes from ONE place: the migration in `src/main/bus.ts`.

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
 *
 * THE FREEZE IS ONE ATOMIC DECISION, keyed on the EXISTENCE OF THE `runs` ROW
 * (F1, reviewer 7c372e9a on ledger #123). Two independent `INSERT OR IGNORE`s —
 * one on `runs`, one on `run_flags` — is NOT atomic: a run whose `runs` row
 * exists but whose `run_flags` row does not (a run created by a writer that
 * predates run_flags — #115's CLI lifecycle, an older build, a partially-applied
 * v2, a failed second insert) would take the `runs` ignore but WRITE `run_flags`
 * at the later call, freezing the running run at then-current LIVE switches —
 * exactly the mid-wave mutation T118.2 forbids, and it flips `busSwitch` ON under
 * a run that was live before the switch was touched. So: if the `runs` row
 * already existed when we got here, the run is ALREADY STARTED and we write NO
 * flags. An existing run with no run_flags row therefore reads all-OFF forever
 * (via `runFlags`), never freezable-late — the coexistence-safe direction.
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
  const frozen = freezeSwitches(liveSwitches, busAvailable);
  const now = Date.now();
  const tx = db.transaction(() => {
    const info = db.prepare(
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
    // ONE atomic decision: the run is NEW iff THIS insert created the row. Only a
    // brand-new run freezes its flags. If the `runs` row already existed, the run
    // was started earlier and we must not write `run_flags` now — writing it would
    // freeze a running run at the CURRENT live switches, which is F1. `changes`
    // reads the affected-row count of THIS statement inside the same transaction,
    // so it is not racy against a concurrent writer.
    const isNewRun = info.changes === 1;
    if (isNewRun) {
      db.prepare('INSERT OR IGNORE INTO run_flags (run_id, flags, frozen_at) VALUES (?,?,?)').run(
        input.id,
        serializeSwitches(frozen),
        now,
      );
    }
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

/**
 * RE-FREEZE a MISSION run's flags at a wave boundary (#134 D1a/D1b, ledger #135).
 *
 * The LEAD is the ONE permanent node; if its mission row froze once and never
 * again, the LEAD's own plain children (ship agents) spawned after a later flip
 * would read stale flags. So each time the LEAD starts a new wave (spawns-as- or
 * promotes an OPS), its mission row is re-frozen to the CURRENT live switches.
 *
 * DELIBERATELY NARROW — the invariant that keeps #123 F1 intact:
 *   - MISSION ROWS ONLY (`kind = 'mission'`). An OPS/member row is NEVER
 *     re-frozen (that is the mid-wave mutation the freeze forbids); the UPDATE's
 *     WHERE clause is the guard, so a caller cannot re-freeze a vague row even by
 *     mistake. G4b asserts an OPS row is byte-identical across a member spawn.
 *   - WAVE-BOUNDARY ONLY (the caller fires this only when a mission spawns/
 *     promotes a child orchestrator, never on member spawn). A mission has no
 *     mid-wave members of its OWN to split, so re-freezing it is not a late
 *     freeze of anything that governs a running member (members obey the OPS
 *     row, which is untouched here).
 *
 * A no-op when the run does not exist, is not a mission, or has no run_flags row
 * (nothing to update). `startRun` stays INSERT-OR-IGNORE freeze-once; this is the
 * SEPARATE explicit path D1b requires — never fold re-freeze into `startRun`.
 */
export function refreezeRun(db: BusDb, runId: string, liveSwitches: BusSwitches): boolean {
  const frozen = freezeSwitches(liveSwitches);
  const info = db
    .prepare(
      `UPDATE run_flags SET flags = ?, frozen_at = ?
        WHERE run_id = ?
          AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_flags.run_id AND r.kind = 'mission')`,
    )
    .run(serializeSwitches(frozen), Date.now(), runId);
  return info.changes === 1;
}

/** The typed outcome of an ADMIN refreeze (`orchestra run refreeze`, #156). Every
 *  branch is a distinct refusal reason so the CLI can print WHY, and every arm of
 *  the acceptance matrix keys on a specific value rather than a bare boolean. */
export type RefreezeMissionOutcome =
  | 'no-run' // the run id resolves to no `runs` row
  | 'not-mission' // the run exists but is a vague (OPS) row — refused (arm 3)
  | 'live-child' // a child is live mid-turn — refused, row untouched (arm 2)
  | 'refrozen' // the mission row's flags were UPDATEd to the live switches (arm 1)
  | 'no-flags'; // a mission row with no run_flags row — nothing to update (never late-inserted)

/**
 * ADMIN RE-FREEZE (#156): the explicit, safe path a FLAT mission needs.
 *
 * THE GAP #156 CLOSES: `bus-run-anchor.ts` D1b re-freezes a mission row ONLY when a
 * nested OPS launches under it (a wave boundary). An orchestrator that runs FLAT —
 * plain children only, never a promoted sub-OPS — hits that boundary NEVER, so its
 * mission keeps the flags frozen at its first anchor forever and can never pick up
 * a later switch flip. This is the operator-driven re-freeze that boundary can't
 * provide, gated by the SAME invariants D1b relies on:
 *
 *   - MISSION ROWS ONLY. The gate is `refreezeRun`'s own WHERE (`kind = 'mission'`),
 *     re-asserted here by reading the row first so a vague row is REFUSED with a
 *     reason rather than silently no-op'd. An OPS/member row is never re-frozen.
 *   - NO LIVE CHILD MID-TURN. The freeze invariant exists to keep an in-flight
 *     wave's regime stable, so a refreeze is REFUSED while any child is live
 *     (`hasLiveChild`, injected by the caller who owns the store's liveness probes
 *     for BOTH surfaces — PTY `isRunning` AND structured/SDK `sdkSessionLive`).
 *     The bus alone cannot see a plain child's turn state — that is why this is
 *     injected, not read here.
 *   - #134 F1: NO LATE INSERT. This calls only `refreezeRun`, which is a pure
 *     UPDATE — it never creates a `runs` or `run_flags` row. A mission whose
 *     run_flags row is absent returns `no-flags` (nothing to update), never a
 *     late freeze.
 *
 * Deliberately NOT folded into `startRun`/`refreezeRun`: this adds the mission/
 * live-child GATE around the existing UPDATE (D1b's caller-side invariant, moved
 * to a place the CLI can reach), and returns a typed reason so the two failure
 * modes (not-a-mission, live-child) are distinguishable at the CLI.
 */
export function refreezeMissionRun(
  db: BusDb,
  runId: string,
  liveSwitches: BusSwitches,
  opts: { hasLiveChild: boolean },
): RefreezeMissionOutcome {
  const row = getRun(db, runId);
  if (!row) return 'no-run';
  // Re-assert the mission gate at the CLI so a vague row is a REASONED refusal.
  // refreezeRun's WHERE clause is the true guard (it cannot touch a vague row even
  // if this check were wrong), but reading the kind here lets the CLI say WHY.
  if (row.kind !== 'mission') return 'not-mission';
  // The freeze invariant: never re-freeze a wave whose child is mid-turn.
  if (opts.hasLiveChild) return 'live-child';
  // Pure UPDATE — never a late insert (#134 F1). `false` here means the mission
  // row exists but its run_flags row does not (nothing to update), which is the
  // coexistence-safe direction: an unfrozen run reads all-OFF, not late-frozen.
  const changed = refreezeRun(db, runId, liveSwitches);
  return changed ? 'refrozen' : 'no-flags';
}

/** Read one run row with its frozen flags, or null. */
export function getRun(db: BusDb, runId: string): BusRunRow | null {
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

/**
 * THE FUNCTION #117 CALLS — frozen on ledger #123 with OPS-B.
 *
 *   busSwitch(runId, 'delivery' | 'wake' | 'ask_gate' | 'liveness') -> boolean
 *
 * Reads the flags RECORDED ON THE RUN ROW. Never the live store — that is the
 * whole contract, and the substitution C10 mutates.
 *
 * Returns FALSE for an unknown run or an unknown mechanism name. False is the
 * coexistence-safe direction: a mechanism that does not fire leaves the old
 * channel authoritative, whereas a defaulted-true would fire a half-adopted
 * mechanism on exactly the runs whose provenance is already broken. A caller
 * that needs to distinguish "off" from "no such run" reads {@link getRun}.
 */
export function busSwitch(db: BusDb, runId: string, mechanism: string): boolean {
  const key = mechanismFromWire(mechanism);
  if (!key) return false;
  return mechanismEnabled(runFlags(db, runId), key);
}

/**
 * The set of runs whose flags a reader in `readerRunId` may be governed by, for
 * the D1a/D1a-bis BIDIRECTIONAL innermost-run wake routing (#134, ledger #135):
 * `readerRunId` itself, every DESCENDANT (nested below via `parent_run_id`), AND
 * every ANCESTOR (up the `parent_run_id` chain).
 *
 * WHY BOTH DIRECTIONS (D1a-bis): a message is governed by the INNERMOST (deeper)
 * run of its two parties, and the store-less CLI writes mail with the SENDER's
 * run:
 *   - an OPS→LEAD digest sits in the OPS run — a DESCENDANT of the LEAD's mission;
 *   - a LEAD→OPS ruling sits in the LEAD's mission run — an ANCESTOR of the OPS.
 * So a reader must look for mail addressed to it in its own run OR any run related
 * to it up or down the chain. Which run's SWITCH governs is decided separately in
 * the sweep, by DEPTH ({@link runDepthMap}): the deeper of (mail run, reader run).
 *
 * Returns `{ ids, depth }` — `ids` always includes `readerRunId` (even with no
 * row yet), `depth` maps every run id in `ids` to its distance from a top-level
 * mission (root = 0). One query reads the whole edge set; the tree is walked in
 * memory (the `runs` table is one row per orchestrator). Bounded against a
 * malformed `parent_run_id` cycle by `seen` sets.
 */
export function getRelatedRunIds(
  db: BusDb,
  readerRunId: string,
): { ids: string[]; depth: Map<string, number> } {
  const edges = db
    .prepare('SELECT id, parent_run_id FROM runs')
    .all() as { id: string; parent_run_id: string | null }[];
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    parentOf.set(e.id, e.parent_run_id);
    if (e.parent_run_id) {
      const list = childrenOf.get(e.parent_run_id) ?? [];
      list.push(e.id);
      childrenOf.set(e.parent_run_id, list);
    }
  }
  const ids = new Set<string>([readerRunId]);
  // Ancestors: walk parent_run_id up.
  {
    const seen = new Set<string>([readerRunId]);
    let cur: string | null | undefined = parentOf.get(readerRunId);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      ids.add(cur);
      cur = parentOf.get(cur);
    }
  }
  // Descendants: walk children down.
  {
    const seen = new Set<string>([readerRunId]);
    const queue = [readerRunId];
    while (queue.length) {
      const c = queue.shift()!;
      for (const child of childrenOf.get(c) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        ids.add(child);
        queue.push(child);
      }
    }
  }
  // Depth of every related run = hops to a top-level mission (parent null / absent).
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const seen = new Set<string>();
    let d = 0;
    let cur: string | null | undefined = id;
    while (cur && parentOf.get(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf.get(cur);
      d++;
    }
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);
  return { ids: [...ids], depth };
}

/** Every run, newest first — the pane's mission/wave tree source. */
export function listRuns(db: BusDb, limit = 200): BusRunRow[] {
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
    // `runs.coordinator_generation` (#128, MIGRATIONS[5]). A row read from a DB
    // that predates the column reads undefined here — floored to 0, the same
    // coexistence-safe default the migration's `DEFAULT 0` backfills.
    coordinator_generation: Number(row.coordinator_generation ?? 0),
  };
}
