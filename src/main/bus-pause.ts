// Fleet PAUSE — the bus half (#252, ADR 0003, wave D ledger #261; schema = MIGRATIONS[9]).
//
// `orchestra run pause --hard` / `run resume` write `runs.paused_at|paused_by|pause_mode` DIRECTLY
// (store-less, like `run hold`), so a pause lands while the app is down. Descendant runs carry NO
// pause of their own: every reader walks `parent_run_id` to the carrier. A pause only counts while
// the CARRIER row's FROZEN `pause` switch is ON (the store's live switch is never read). The host
// trap (snapshot / Bilan / interrupt / kill — D1b) consumes `runsOwingPauseTrap` + `runSubtreeIds`
// and stamps `pause_trap_at`; it is NOT in this module.

import { runCoordinator, type BusDb } from './bus.ts';
import { getRun, runHoldAuthority } from './bus-runs.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { parseSwitches } from '../shared/bus-switches.ts';
import {
  activePauseInChain,
  pauseGateDecision,
  type PauseChainLink,
  type PauseOrigin,
} from '../shared/bus-pause.ts';
import { PAUSE_HUMAN_BY, trapOwed, type PauseMode, type RepriseEntry } from '../shared/pause-lifecycle.ts';
import { softDeadlineAt } from '../shared/pause-douce.ts';
import type { WaveNode } from './wave-run-id.ts';
import { beginRepriseCore, clearPauseColumns, readCarrierColumns, releasedWhileResuming, revertResumeToPaused } from './pause-reprise.ts';

/** The typed outcome of `orchestra run pause|resume` (pause half). */
export type RunPauseOutcome =
  | 'paused'
  | 'already-paused'
  | 'escalated' // `--hard` over a Pause douce still waiting: the douce is cut short, the host trap is owed now (#254)
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
  /** #254 Pause douce: `paused_at + 3 min` (null = hard). */
  deadlineAt?: number | null;
  /** #254: when the douce stopped waiting (all confirmed, or the deadline); null = still waiting / hard. */
  escalatedAt?: number | null;
  /** `resume_started_at` (#255): set = the Reprise began (RESUMING) — the host trap must stop touching members. Absent/null = not resuming. */
  resumeStartedAt?: number | null;
}

interface PauseRow {
  id: string;
  parent: string | null;
  pausedAt: number | null;
  pausedBy: string | null;
  mode: string | null;
  trapAt: number | null;
  deadlineAt: number | null;
  escalatedAt: number | null;
  resumeStartedAt: number | null;
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
    deadlineAt: r.pause_deadline_at === null || r.pause_deadline_at === undefined ? null : Number(r.pause_deadline_at),
    escalatedAt: r.pause_escalated_at === null || r.pause_escalated_at === undefined ? null : Number(r.pause_escalated_at),
    resumeStartedAt: r.resume_started_at === null || r.resume_started_at === undefined ? null : Number(r.resume_started_at),
    // A row with no run_flags reads ALL-OFF (never the live store) — `parseSwitches(null)`.
    switchOn: parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true,
  };
}

const SELECT_PAUSE_ROWS = `
  SELECT r.id, r.parent_run_id, r.paused_at, r.paused_by, r.pause_mode, r.pause_trap_at,
         r.pause_deadline_at, r.pause_escalated_at, r.resume_started_at,
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
  return resolvePause(db, runId, null);
}

/** {@link activePauseFor} seen from the run's own COORDINATOR as the member (#255): a carrier that is RESUMING and has already released it no longer
 *  pauses it — the store-less twin of the gate's `memberMayStart` (what `run resume` / `run status` ask when the app's store file is not readable). */
export function activePauseForCoordinator(db: BusDb, runId: string): RunPauseInfo | null {
  return resolvePause(db, runId, runCoordinator(db, runId));
}

function resolvePause(db: BusDb, runId: string, asMember: string | null): RunPauseInfo | null {
  const chain = pauseChain(db, runId);
  const links: PauseChainLink[] = chain.map((c) => ({
    runId: c.id,
    // a link that RELEASED `asMember` during its Reprise carries no pause for it (the walk goes on: an ancestor may still pause it)
    pausedAt: asMember !== null && c.pausedAt !== null && c.resumeStartedAt !== null && releasedWhileResuming(db, c.id, c.pausedAt, asMember) ? null : c.pausedAt,
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
    deadlineAt: carrier.deadlineAt,
    escalatedAt: carrier.escalatedAt,
    resumeStartedAt: carrier.resumeStartedAt,
  };
}

/** The run's OWN pause column (carrier view, switch ignored), or null. For the verb + bus-status. */
export function getRunPause(db: BusDb, runId: string): RunPauseInfo | null {
  const row = readPauseRow(db, runId);
  if (!row || row.pausedAt === null) return null;
  return infoOf(row, row.pausedAt);
}

function infoOf(row: PauseRow, pausedAt: number): RunPauseInfo {
  return {
    runId: row.id,
    pausedAt,
    pausedBy: row.pausedBy,
    mode: row.mode,
    trapAt: row.trapAt,
    deadlineAt: row.deadlineAt,
    escalatedAt: row.escalatedAt,
    resumeStartedAt: row.resumeStartedAt,
  };
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

/** Carriers whose host trap is still OWED (`trapOwed`, the frozen state machine): `paused_at` set, frozen switch ON, `pause_trap_at` NULL,
 *  and — for a Pause douce (#254) — only once it ESCALATED (all confirmed, or the 3-min deadline). D1b polls this (app up) and drains it at
 *  boot (app was down when the pause landed). */
export function runsOwingPauseTrap(db: BusDb): RunPauseInfo[] {
  const rows = (db.prepare(SELECT_PAUSE_ROWS).all() as Record<string, unknown>[]).map(toPauseRow);
  return rows
    .filter(
      (r) =>
        r.pausedAt !== null &&
        r.switchOn &&
        trapOwed({
          pausedAt: r.pausedAt,
          mode: r.mode === 'soft' ? 'soft' : r.mode === 'hard' ? 'hard' : null,
          deadlineAt: r.deadlineAt,
          escalatedAt: r.escalatedAt,
          trapAt: r.trapAt,
          resumeStartedAt: r.resumeStartedAt,
        }),
    )
    .map((r) => ({ ...infoOf(r, r.pausedAt as number), trapAt: null }));
}

/**
 * PAUSE / LIFT a run (`orchestra run pause [--hard]` / `run resume`). `mode` 'hard' (default) = Pause dure (#252); 'soft' = Pause douce (#254:
 * `pause_deadline_at = paused_at + 3 min`, the trap is owed only once escalated). `--hard` over a douce still waiting cuts it short
 * (`escalated`). Authority = the HOLD rule
 * (`runHoldAuthority`: the run's coordinator or an ANCESTOR run's coordinator; a worker, a
 * descendant's coordinator, or no identity is `refused`) — except the HUMAN at the app (`opts.human`, pause-ui.ts only), above every coordinator. A pause needs the run's FROZEN
 * `pause` switch ON (`switch-off` otherwise: nothing written, never inert-but-accepted). A
 * repeat pause keeps the ORIGINAL time/holder (the HUMAN's escalation of a douce, and the human's takeover of a HOST auto-pause, are recorded as the human's). A pure UPDATE — it never creates a row and never
 * touches `run_flags`. A LIFT works whatever the switch says and clears `pause_trap_at` too, so
 * the next pause owes a fresh trap; `pause_records` history is kept.
 */
export function setRunPause(
  db: BusDb,
  runId: string,
  pause: boolean,
  actor: string | null | undefined,
  mode: PauseMode = 'hard',
  /** `human`: the HUMAN at the app (src/main/pause-ui.ts only — no CLI verb sets it): above every coordinator, so the coordinator rule is skipped and the pause is recorded as the human's (`PAUSE_HUMAN_BY`). */
  opts?: { human?: boolean },
): RunPauseOutcome {
  const auth = runHoldAuthority(db, runId);
  if (!auth) return 'no-run';
  const human = opts?.human === true;
  const who = human ? PAUSE_HUMAN_BY : (actor?.trim() ?? '');
  if (!human && (!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who)))) {
    return 'refused';
  }
  const row = readPauseRow(db, runId);
  const isPaused = row !== null && row.pausedAt !== null;
  if (pause) {
    if (!getRun(db, runId)?.flags.pause) return 'switch-off';
    if (isPaused) {
      // #255: a Pause WHILE RESUMING = back to PAUSED in a NEW epoch owned by this caller (the trap runs again on fresh Bilan rows; nothing stays released) — in the mode the caller asked for.
      if (revertResumeToPaused(db, runId, who, Date.now(), { mode, deadlineAt: (epoch) => (mode === 'soft' ? softDeadlineAt(epoch) : null) })) return 'paused';
      // `--hard` over a douce that is still waiting = escalate NOW (the trap becomes owed); anything else keeps the original pause.
      if (mode === 'hard' && row!.mode === 'soft' && row!.escalatedAt === null && row!.trapAt === null && row!.resumeStartedAt === null) {
        // ONE statement: the HUMAN's Pause dure over an agent's douce is the human's Pause now (Q1/Q2) — `paused_by` moves with the escalation, never a half-written state (the caller then replaces the recorded origin: nobody spared)
        const done = db.prepare(
          `UPDATE runs SET pause_mode = 'hard', pause_escalated_at = ?${human ? ', paused_by = ?' : ''}
            WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL`,
        ).run(...(human ? [Date.now(), PAUSE_HUMAN_BY, runId, row!.pausedAt] : [Date.now(), runId, row!.pausedAt])).changes;
        if (done > 0) return 'escalated';
      }
      adoptPause(db, runId, human);
      return 'already-paused';
    }
    const now = Date.now();
    const wrote = db.prepare(
      `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_deadline_at = ?, pause_escalated_at = NULL,
              resume_started_at = NULL, pause_auto = NULL, pause_trap_at = NULL
        WHERE id = ? AND paused_at IS NULL`,
    ).run(now, who, mode, mode === 'soft' ? softDeadlineAt(now) : null, runId);
    if (wrote.changes === 0) {
      // a pause (the host's auto pause on a usage limit?) landed between the read and this write: the caller's pause IS that pause now — adopt it (#256, D6)
      adoptPause(db, runId, human);
      return 'already-paused';
    }
    return 'paused';
  }
  if (!isPaused) return 'not-paused';
  clearPauseColumns(db, runId); // every pause column (incl. wave E's) — a stale `resume_started_at` would read the NEXT pause as RESUMING
  return 'lifted';
}

/** A pause already in force is taken over by whoever re-asserts it (#256, D6): `pause_auto` NULL = manual, never auto-resumed. The HUMAN's takeover of a HOST auto-pause is recorded as the human's (`paused_by`, Q1) — a re-press of a
 *  coordinator's own pause rewrites nothing (the `pause_auto IS NOT NULL` guard). */
function adoptPause(db: BusDb, runId: string, human: boolean): void {
  if (human) db.prepare('UPDATE runs SET paused_by = ? WHERE id = ? AND paused_at IS NOT NULL AND pause_auto IS NOT NULL').run(PAUSE_HUMAN_BY, runId);
  db.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ? AND paused_at IS NOT NULL').run(runId);
}

/**
 * THE structured Reprise entry (#255, ledger #276 D3 — signature = `RepriseEntry`): `orchestra run resume` calls it with the caller's handle,
 * the auto Reprise (#256) with `{ host: true, reason: 'usage_limit' }` (a host caller is never refused). It does NOT lift the pause: it starts
 * the RESUMING phase, releases the coordinators of the subtree and sends each its `reprise` row — see src/main/pause-reprise.ts.
 */
export const beginReprise: RepriseEntry = (db, carrierRunId, actor, opts) => {
  const bus = db as BusDb;
  return beginRepriseCore(bus, carrierRunId, actor, opts, runSubtreeIds(bus, carrierRunId));
};

/** Seams so the gate decision runs over a real bus + a fake workspace map without the Electron
 *  store (src/main/pause-gate.ts binds the real ones; the unit suite binds fakes). */
export interface PauseGateDeps {
  getWorkspace: (id: string) => WaveNode | undefined;
  getBus: () => BusDb | null;
  warn?: (msg: string, err?: unknown) => void;
  /** Called when the bus is unavailable at a gate read: a pause the CLI wrote is then NOT enforced (fail-open by design). */
  onBusUnavailable?: () => void;
}

/** The pause carrier governing `ws` through the LIVE workspace tree: `ws` itself and every ancestor along the store's `parentId`
 *  chain are each checked as a possible carrier (a run id == its orchestrator's workspace id, or a run-anchoring plain parent's).
 *  `runs.parent_run_id` is write-once (never re-pointed by attach/detach/demote), so it is used ONLY as the fallback when the chain
 *  reaches a workspace that is no longer in the store. Exported for the liveness roster (the SILENCE seam uses the SAME walk). */
export function pausedCarrierForWorkspace(
  db: BusDb,
  ws: WaveNode,
  getWorkspace: (id: string) => WaveNode | undefined,
  /** `includeReleased`: also report a carrier that is RESUMING and has already released `ws` (the release/confirm verbs and `run status` need the carrier itself). */
  opts?: { includeReleased?: boolean },
): RunPauseInfo | null {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: WaveNode | undefined = ws;
  let dangling = false;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    ids.push(cur.id);
    if (!cur.parentId) break;
    const parent = getWorkspace(cur.parentId);
    if (!parent) {
      dangling = true;
      break;
    }
    cur = parent;
  }
  for (const id of ids) {
    const row = readPauseRow(db, id);
    if (row && row.pausedAt !== null && row.switchOn) {
      // #255 `memberMayStart`: a member RELEASED by its coordinator during the RESUMING phase may start; the walk goes on (an ANCESTOR carrier may still pause it).
      if (!opts?.includeReleased && row.resumeStartedAt !== null && releasedWhileResuming(db, id, row.pausedAt, ws.id)) continue;
      return infoOf(row, row.pausedAt);
    }
  }
  if (dangling) {
    // A workspace on the chain is gone from the store: the bus's own run tree is the only evidence left.
    for (const id of ids) {
      // the release exemption is evaluated for THIS workspace along the whole run chain (an ancestor carrier may still pause it), exactly like the live walk
      const hit = resolvePause(db, id, opts?.includeReleased ? null : ws.id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * THE GATE DECISION: the refusal for `ws` (`run en pause — orchestra run resume --run <id>`) or
 * null when a start may proceed. The pause is resolved NOW from the live workspace tree
 * ({@link pausedCarrierForWorkspace}) — never `$ORCHESTRA_RUN_ID`. A HUMAN origin is never refused
 * and never even reads the bus. Unknown (no ws, no row, an unreadable read — logged) ⇒ NOT paused;
 * so is an UNAVAILABLE bus (`onBusUnavailable`): fail-open on purpose — failing closed would freeze
 * every agent behind a broken bus.
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
    if (!db) {
      deps.onBusUnavailable?.();
      return null;
    }
    return pauseGateDecision(pausedCarrierForWorkspace(db, ws, deps.getWorkspace));
  } catch (e) {
    deps.warn?.('pause gate: unreadable — treating as NOT paused', e);
    return null;
  }
}
