// Fleet PAUSE — the bus half (#252, ADR 0003, wave D ledger #261; schema = MIGRATIONS[9]).
//
// `orchestra run pause --hard` / `run resume` write `runs.paused_at|paused_by|pause_mode` DIRECTLY
// (store-less, like `run hold`), so a pause lands while the app is down. Descendant runs carry NO
// pause of their own: every reader walks `parent_run_id` to the carrier. A pause only counts while
// the CARRIER row's FROZEN `pause` switch is ON (the store's live switch is never read). The host
// trap (snapshot / Bilan / interrupt / kill — D1b) consumes `runsOwingPauseTrap` + `runSubtreeIds`
// and stamps `pause_trap_at`; it is NOT in this module.

import type { BusDb } from './bus.ts';
import { getRun, runHoldAuthority } from './bus-runs.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { parseSwitches } from '../shared/bus-switches.ts';
import {
  activePauseInChain,
  pauseGateDecision,
  type PauseChainLink,
  type PauseOrigin,
} from '../shared/bus-pause.ts';
import { nearestOrchestratorId, type WaveNode } from './wave-run-id.ts';

/** The typed outcome of `orchestra run pause|resume` (pause half). */
export type RunPauseOutcome =
  | 'paused'
  | 'already-paused'
  | 'lifted'
  | 'not-paused'
  | 'no-run'
  | 'refused' // caller is neither the run's coordinator nor an ancestor run's coordinator (hold rule)
  | 'switch-off'; // the run's FROZEN `pause` switch is OFF — pausing would be inert

export interface RunPauseInfo {
  runId: string;
  pausedAt: number;
  pausedBy: string | null;
  mode: string | null;
  /** `pause_trap_at` — when the host trap finished; null = still owed (D1b). */
  trapAt: number | null;
}

interface PauseRow {
  id: string;
  parent: string | null;
  pausedAt: number | null;
  pausedBy: string | null;
  mode: string | null;
  trapAt: number | null;
  switchOn: boolean;
}

function toPauseRow(r: Record<string, unknown>): PauseRow {
  return {
    id: String(r.id),
    parent: (r.parent_run_id as string | null) ?? null,
    pausedAt: r.paused_at === null || r.paused_at === undefined ? null : Number(r.paused_at),
    pausedBy: (r.paused_by as string | null) ?? null,
    mode: (r.pause_mode as string | null) ?? null,
    trapAt: r.pause_trap_at === null || r.pause_trap_at === undefined ? null : Number(r.pause_trap_at),
    // A row with no run_flags reads ALL-OFF (never the live store) — `parseSwitches(null)`.
    switchOn: parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true,
  };
}

const SELECT_PAUSE_ROWS = `
  SELECT r.id, r.parent_run_id, r.paused_at, r.paused_by, r.pause_mode, r.pause_trap_at,
         f.flags AS flags_json
    FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id`;

function readPauseRow(db: BusDb, runId: string): PauseRow | null {
  const r = db.prepare(`${SELECT_PAUSE_ROWS} WHERE r.id = ?`).get(runId) as
    | Record<string, unknown>
    | undefined;
  return r ? toPauseRow(r) : null;
}

/** The chain `[run, ...ancestors]` (nearest first), bounded by a seen-set so a malformed
 *  `parent_run_id` cycle ends. A missing ancestor row ends the walk (a dangling parent). */
function pauseChain(db: BusDb, runId: string): PauseRow[] {
  const out: PauseRow[] = [];
  const seen = new Set<string>();
  let cur: string | null = runId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const row = readPauseRow(db, cur);
    if (!row) break;
    out.push(row);
    cur = row.parent;
  }
  return out;
}

/**
 * THE READ EVERY GATE USES: the active pause governing `runId` — the run's own, or the nearest
 * ANCESTOR's — or null. UNKNOWN ⇒ NOT PAUSED (no row, a NULL column, a carrier whose frozen
 * `pause` switch is OFF): a missed pause is loud on the next check, a phantom one is not.
 */
export function activePauseFor(db: BusDb, runId: string): RunPauseInfo | null {
  const chain = pauseChain(db, runId);
  const links: PauseChainLink[] = chain.map((c) => ({
    runId: c.id,
    pausedAt: c.pausedAt,
    pauseSwitchOn: c.switchOn,
  }));
  const hit = activePauseInChain(links);
  if (!hit) return null;
  const carrier = chain.find((c) => c.id === hit.runId)!;
  return {
    runId: carrier.id,
    pausedAt: hit.pausedAt,
    pausedBy: carrier.pausedBy,
    mode: carrier.mode,
    trapAt: carrier.trapAt,
  };
}

/** The run's OWN pause column (carrier view, switch ignored), or null. For the verb + bus-status. */
export function getRunPause(db: BusDb, runId: string): RunPauseInfo | null {
  const row = readPauseRow(db, runId);
  if (!row || row.pausedAt === null) return null;
  return { runId, pausedAt: row.pausedAt, pausedBy: row.pausedBy, mode: row.mode, trapAt: row.trapAt };
}

/**
 * Every run the pause currently covers: each carrier (frozen `pause` switch ON) AND every
 * descendant run below it. The SILENCE seam — liveness unions this into its held set. A run with
 * no row is simply absent (unknown ⇒ not paused).
 */
export function effectivePausedRunIds(db: BusDb): Set<string> {
  const rows = (db.prepare(SELECT_PAUSE_ROWS).all() as Record<string, unknown>[]).map(toPauseRow);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const r of rows) {
    const seen = new Set<string>();
    let cur: PauseRow | undefined = r;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.pausedAt !== null && cur.switchOn) {
        out.add(r.id);
        break;
      }
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  return out;
}

/** `rootRunId` plus every run below it (`parent_run_id` closure). For the host trap (D1b): the
 *  members of ALL these runs are the pause's members. Bounded against cycles. */
export function runSubtreeIds(db: BusDb, rootRunId: string): string[] {
  const rows = db.prepare('SELECT id, parent_run_id AS p FROM runs').all() as {
    id: string;
    p: string | null;
  }[];
  const kids = new Map<string, string[]>();
  for (const r of rows) {
    if (r.p) kids.set(r.p, [...(kids.get(r.p) ?? []), r.id]);
  }
  const out = [rootRunId];
  const seen = new Set<string>(out);
  for (let i = 0; i < out.length; i++) {
    for (const k of kids.get(out[i]) ?? []) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/** Carriers whose host trap is still OWED: `paused_at` set, frozen switch ON, `pause_trap_at`
 *  NULL. D1b polls this (app up) and drains it at boot (app was down when the pause landed). */
export function runsOwingPauseTrap(db: BusDb): RunPauseInfo[] {
  const rows = (db.prepare(SELECT_PAUSE_ROWS).all() as Record<string, unknown>[]).map(toPauseRow);
  return rows
    .filter((r) => r.pausedAt !== null && r.switchOn && r.trapAt === null)
    .map((r) => ({
      runId: r.id,
      pausedAt: r.pausedAt as number,
      pausedBy: r.pausedBy,
      mode: r.mode,
      trapAt: null,
    }));
}

/**
 * PAUSE / LIFT a run (`orchestra run pause --hard` / `run resume`). Authority = the HOLD rule
 * (`runHoldAuthority`: the run's coordinator or an ANCESTOR run's coordinator; a worker, a
 * descendant's coordinator, or no identity is `refused`). A pause needs the run's FROZEN
 * `pause` switch ON (`switch-off` otherwise: nothing written, never inert-but-accepted). A
 * repeat pause keeps the ORIGINAL time/holder. A pure UPDATE — it never creates a row and never
 * touches `run_flags`. A LIFT works whatever the switch says and clears `pause_trap_at` too, so
 * the next pause owes a fresh trap; `pause_records` history is kept.
 */
export function setRunPause(
  db: BusDb,
  runId: string,
  pause: boolean,
  actor: string | null | undefined,
): RunPauseOutcome {
  const auth = runHoldAuthority(db, runId);
  if (!auth) return 'no-run';
  const who = actor?.trim() ?? '';
  if (!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who))) {
    return 'refused';
  }
  const row = readPauseRow(db, runId);
  const isPaused = row !== null && row.pausedAt !== null;
  if (pause) {
    if (!getRun(db, runId)?.flags.pause) return 'switch-off';
    if (isPaused) return 'already-paused';
    db.prepare(
      `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_trap_at = NULL
        WHERE id = ? AND paused_at IS NULL`,
    ).run(Date.now(), who, runId);
    return 'paused';
  }
  if (!isPaused) return 'not-paused';
  db.prepare(
    'UPDATE runs SET paused_at = NULL, paused_by = NULL, pause_mode = NULL, pause_trap_at = NULL WHERE id = ?',
  ).run(runId);
  return 'lifted';
}

/** Seams so the gate decision runs over a real bus + a fake workspace map without the Electron
 *  store (src/main/pause-gate.ts binds the real ones; the unit suite binds fakes). */
export interface PauseGateDeps {
  getWorkspace: (id: string) => WaveNode | undefined;
  getBus: () => BusDb | null;
  warn?: (msg: string, err?: unknown) => void;
}

/**
 * THE GATE DECISION: the refusal for `ws` (`run en pause — orchestra run resume --run <id>`) or
 * null when a start may proceed. The run is resolved NOW from the live workspace tree
 * (`nearestOrchestratorId`, the `resolveWaveRunId` walk) — never `$ORCHESTRA_RUN_ID`. A HUMAN
 * origin is never refused and never even reads the bus. Unknown (no ws, no bus, no run row, an
 * unreadable read — logged) ⇒ NOT paused.
 */
export function pauseRefusalWith(
  deps: PauseGateDeps,
  ws: WaveNode | null | undefined,
  origin: PauseOrigin,
): string | null {
  if (origin === 'human') return null;
  if (!ws) return null;
  try {
    const db = deps.getBus();
    if (!db) return null;
    return pauseGateDecision(activePauseFor(db, nearestOrchestratorId(ws, deps.getWorkspace)));
  } catch (e) {
    deps.warn?.('pause gate: unreadable — treating as NOT paused', e);
    return null;
  }
}
