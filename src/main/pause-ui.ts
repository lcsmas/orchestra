// Fleet PAUSE — the UI's data layer (#257, wave F ledger #281). NOTHING here writes a bus column itself: every write is the SHIPPED writer
// (`setRunPause`, `beginReprise`, `releaseMembers`), every read the SHIPPED reader (`pauseStatusView`, `repriseStatusView`, `listBilan`,
// `pausedCarrierForWorkspace`) — no second path (ADR 0003 §the bus is the source of truth). Electron-free: the host binds it in pause-ui-host.ts.
//
// WHO ACTS (spec question 1, ledger #281): the writers take a coordinator HANDLE (the hold rule). The UI acts AS THE WORKSPACE ROW THE CONTROL BELONGS TO:
// an orchestrator row is the coordinator of the run it anchors (accepted); a worker row is not (the writer REFUSES it — the typed `refused` outcome comes back
// untouched, and nothing is written). `uiActor` is the ONE place that decides it, so a different answer to the spec question is a one-function change.

import type { BusDb } from './bus.ts';
import { getRun, runHoldAuthority } from './bus-runs.ts';
import { beginReprise, pausedCarrierForWorkspace, setRunPause, type RunPauseOutcome } from './bus-pause.ts';
import { listBilan, type BilanRow } from './bus-pause-records.ts';
import { pauseStatusView } from './pause-douce.ts';
import { readCarrierColumns, readRoster, releaseMembers, repriseStatusView, resumingCarrierFor, type ReleaseResult } from './pause-reprise.ts';
import { nearestOrchestratorId, nodeOrchestrates, type WaveNode } from './wave-run-id.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { pausePhaseOf, pauseRosterSummary, type PauseMode, type PausePhase, type RepriseOutcome } from '../shared/pause-lifecycle.ts';
import {
  availabilityFor,
  explainPauseOutcome,
  explainReleaseResult,
  explainResumeOutcome,
  memberUiState,
  unavailableOverview,
  type ExplainCtx,
  type PauseUiBilanLine,
  type PauseUiControl,
  type PauseUiExplain,
  type PauseUiMember,
  type PauseUiOverview,
  type PauseUiReleaseRaw,
  type PauseUiReleaseResult,
  type PauseUiRun,
  type PauseUiWorkspaceState,
  type PauseUiWriteOutcome,
  type PauseUiWriteResult,
} from '../shared/pause-ui.ts';

/** What the UI layer needs from the host: the LIVE workspace tree (the gates' and the trap's own walk) and display names. */
export interface PauseUiDeps {
  getWorkspace: (id: string) => (WaveNode & { archived?: boolean }) | undefined;
  /** Non-archived workspaces. */
  listWorkspaces: () => Array<WaveNode & { archived?: boolean }>;
  /** A workspace's display name (branch / name); null = unknown. */
  labelOf: (wsId: string) => string | null;
  now?: () => number;
}

const KILLED_CAP = 12;
const NOTES_CAP = 8;

const short = (id: string): string => (/^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 8) : id);
const labeler = (deps: PauseUiDeps) => (id: string): string => deps.labelOf(id) ?? short(id);

/** One Bilan row → what a screen shows. Pure over the row; capped so the push payload stays small. */
export function toBilanLine(b: BilanRow): PauseUiBilanLine {
  const a = b.activity;
  const killed = Array.isArray(b.killed) ? (b.killed as Array<{ cmd?: unknown; cwd?: unknown; outcome?: unknown }>) : [];
  return {
    snapshotRef: b.snapshotRef,
    branch: a?.branch ?? null,
    head: a?.head ?? null,
    dirty: b.dirty,
    changed: a?.changed ?? null,
    snapshotIncomplete: a?.snapshotIncomplete ?? null,
    wasDoing: {
      turnRunning: a?.turnRunning === true,
      inFlight: (a?.inFlightTools ?? []).map((t) => (t.input ?? t.tool ?? '?')).slice(0, 4),
      bgTasks: (a?.bgTasks ?? []).map((t) => t.description).slice(0, 4),
      lastTask: a?.lastTask ?? null,
    },
    interrupt: a?.interrupt ?? null,
    exempt: a?.exempt === 'pauser' || a?.interrupt === 'exempt',
    killed: killed.slice(-KILLED_CAP).map((k) => ({ cmd: String(k.cmd ?? '').slice(0, 300), cwd: typeof k.cwd === 'string' ? k.cwd : null, outcome: String(k.outcome ?? '') })),
    killedCount: killed.length,
    notes: (a?.notes ?? []).slice(-NOTES_CAP),
    error: b.error,
  };
}

/** Carriers whose pause is ACTIVE for the UI: `paused_at` set AND the frozen `pause` switch ON (the same filter every gate applies). */
function activeCarrierIds(db: BusDb): Array<{ id: string; auto: boolean; title: string | null }> {
  const rows = db
    .prepare(
      `SELECT r.id, r.title, r.pause_auto, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        WHERE r.paused_at IS NOT NULL ORDER BY r.paused_at, r.id`,
    )
    .all() as Array<{ id: string; title: string | null; pause_auto: string | null; flags_json: string | null }>;
  const out: Array<{ id: string; auto: boolean; title: string | null }> = [];
  for (const r of rows) {
    let pauseOn = false;
    try {
      pauseOn = (JSON.parse(r.flags_json ?? '{}') as { pause?: boolean }).pause === true;
    } catch {
      pauseOn = false; // a malformed flags blob reads all-OFF, like parseSwitches
    }
    if (pauseOn) out.push({ id: r.id, auto: r.pause_auto !== null && r.pause_auto !== undefined, title: r.title ?? null });
  }
  return out;
}

function memberOf(
  deps: PauseUiDeps,
  phase: PausePhase,
  row: ReturnType<typeof readRoster>[number],
  bilans: Map<string, BilanRow>,
): PauseUiMember {
  const b = bilans.get(row.wsId) ?? null;
  return {
    wsId: row.wsId,
    label: labeler(deps)(row.wsId),
    role: row.role,
    memberRun: row.memberRun,
    ui: memberUiState(phase, row),
    confirmVia: row.pauseConfirmVia,
    confirmedAt: row.pauseConfirmedAt,
    releasedAt: row.releasedAt,
    releasedBy: row.releasedBy,
    repriseConfirmedAt: row.repriseConfirmedAt,
    bilan: b ? toBilanLine(b) : null,
  };
}

function runView(db: BusDb, deps: PauseUiDeps, carrierId: string, auto: boolean, title: string | null): PauseUiRun | null {
  const pv = pauseStatusView(db, carrierId);
  if (!pv || pv.carrierRunId !== carrierId) return null;
  const label = labeler(deps);
  const bilans = new Map(listBilan(db, carrierId, pv.pausedAt).map((b) => [b.wsId, b]));
  const roster = readRoster(db, carrierId, pv.pausedAt);
  const rp = repriseStatusView(db, carrierId);
  const own = rp && rp.carrier === carrierId ? rp : null;
  return {
    carrierRunId: carrierId,
    carrierLabel: label(carrierId),
    title,
    phase: pv.phase,
    mode: pv.mode === 'soft' ? 'soft' : pv.mode === 'hard' ? 'hard' : null,
    pausedAt: pv.pausedAt,
    pausedBy: pv.pausedBy,
    pausedByLabel: pv.pausedBy ? label(pv.pausedBy) : null,
    deadlineAt: pv.deadlineAt,
    escalatedAt: pv.escalatedAt,
    trapAt: pv.trapAt,
    resumeStartedAt: readCarrierColumns(db, carrierId)?.resumeStartedAt ?? null,
    auto,
    progress: { kind: pv.phase === 'resuming' ? 'repris' : 'en-pause', done: pv.summary.done, total: pv.summary.total, missing: pv.summary.missing },
    blocked: own ? own.blocked : [],
    members: roster.map((r) => memberOf(deps, pv.phase, r, bilans)),
  };
}

/** A closed Reprise whose accusés are still being collected ("N/M repris — manquent : …", `repriseStatusView` phase `active`): the pause columns are already NULL. */
function trackedRepriseRun(db: BusDb, deps: PauseUiDeps, carrierId: string, title: string | null): PauseUiRun | null {
  const rp = repriseStatusView(db, carrierId);
  if (!rp || rp.carrier !== carrierId || rp.phase !== 'active') return null;
  const label = labeler(deps);
  const roster = readRoster(db, carrierId, rp.pausedAt);
  const bilans = new Map(listBilan(db, carrierId, rp.pausedAt).map((b) => [b.wsId, b]));
  const sum = pauseRosterSummary('resuming', roster);
  return {
    carrierRunId: carrierId,
    carrierLabel: label(carrierId),
    title,
    phase: 'active',
    mode: null,
    pausedAt: rp.pausedAt,
    pausedBy: null,
    pausedByLabel: null,
    deadlineAt: null,
    escalatedAt: null,
    trapAt: null,
    resumeStartedAt: null,
    auto: false,
    progress: { kind: 'repris', done: sum.done, total: sum.total, missing: sum.missing },
    blocked: [],
    members: roster.map((r) => memberOf(deps, 'resuming', r, bilans)),
  };
}

/** The workspace's chain (self first) along the live `parentId` links — what `resumingCarrierFor` walks. */
function liveChainIds(deps: PauseUiDeps, wsId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = deps.getWorkspace(wsId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.id);
    cur = cur.parentId ? deps.getWorkspace(cur.parentId) : undefined;
  }
  return out;
}

/**
 * THE READ: every pause carrier with its roster / progress / Bilan, the controls of every ORCHESTRATOR row, and a state per workspace under a pause (sidebar badges).
 * Never throws; a missing bus or a failing read is `available: false` + the reason (an empty overview must never read as "nothing is paused").
 */
export function readPauseOverview(db: BusDb | null, deps: PauseUiDeps): PauseUiOverview {
  const at = (deps.now ?? Date.now)();
  if (!db) return unavailableOverview('The fleet bus is not open (see the log for the open failure).', at);
  try {
    const label = labeler(deps);
    const carriers = activeCarrierIds(db);
    const runs: PauseUiRun[] = [];
    const seen = new Set<string>();
    for (const c of carriers) {
      const v = runView(db, deps, c.id, c.auto, c.title);
      if (v) {
        runs.push(v);
        seen.add(c.id);
      }
    }
    // closed Reprises still waiting for accusés (tracking only)
    for (const r of db.prepare('SELECT DISTINCT run_id AS id FROM pause_members').all() as Array<{ id: string }>) {
      if (seen.has(r.id)) continue;
      const t = trackedRepriseRun(db, deps, r.id, (db.prepare('SELECT title FROM runs WHERE id = ?').get(r.id) as { title: string | null } | undefined)?.title ?? null);
      if (t) runs.push(t);
    }

    const workspaces = deps.listWorkspaces();
    const byWorkspace: Record<string, PauseUiWorkspaceState> = {};
    if (runs.some((r) => r.phase !== 'active')) {
      const rosterRows = new Map<string, ReturnType<typeof readRoster>>();
      for (const ws of workspaces) {
        // the GATE'S OWN answer first (live-tree walk: the nearest carrier that does NOT release `ws`), so a member released by an inner carrier but still blocked by an outer one reads
        // BLOCKED; only when nothing blocks it, the nearest carrier that released it (the "libéré / repris" badge)
        const carrier = pausedCarrierForWorkspace(db, ws, deps.getWorkspace) ?? pausedCarrierForWorkspace(db, ws, deps.getWorkspace, { includeReleased: true });
        if (!carrier) continue;
        const key = `${carrier.runId}@${carrier.pausedAt}`;
        let roster = rosterRows.get(key);
        if (!roster) rosterRows.set(key, (roster = readRoster(db, carrier.runId, carrier.pausedAt)));
        const row = roster.find((r) => r.wsId === ws.id);
        const view = runs.find((r) => r.carrierRunId === carrier.runId);
        const phase: PausePhase = view?.phase ?? 'paused';
        // UNKNOWN is not NONE: under a pause but not (yet) in the roster — the host enrols within a sweep — reads as "being paused" (fail closed while resuming)
        byWorkspace[ws.id] = {
          wsId: ws.id,
          carrierRunId: carrier.runId,
          phase,
          ui: row ? memberUiState(phase, row) : phase === 'resuming' ? 'blocked' : 'pausing',
          role: row?.role ?? null,
          via: row?.pauseConfirmVia ?? null,
        };
      }
    }

    const controls: Record<string, PauseUiControl> = {};
    for (const ws of workspaces) {
      if (!nodeOrchestrates(ws)) continue; // a worker row's control is explained by the writer's own `refused` at click time
      const runId = nearestOrchestratorId(ws, deps.getWorkspace);
      const run = getRun(db, runId);
      const cols = db.prepare('SELECT paused_at, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at, resume_started_at FROM runs WHERE id = ?').get(runId) as
        | { paused_at: number | null; pause_mode: string | null; pause_deadline_at: number | null; pause_escalated_at: number | null; pause_trap_at: number | null; resume_started_at: number | null }
        | undefined;
      const phase: PausePhase = cols
        ? pausePhaseOf({
            pausedAt: cols.paused_at === null ? null : Number(cols.paused_at),
            mode: cols.pause_mode === 'soft' ? 'soft' : cols.pause_mode === 'hard' ? 'hard' : null,
            deadlineAt: cols.pause_deadline_at === null ? null : Number(cols.pause_deadline_at),
            escalatedAt: cols.pause_escalated_at === null ? null : Number(cols.pause_escalated_at),
            trapAt: cols.pause_trap_at === null ? null : Number(cols.pause_trap_at),
            resumeStartedAt: cols.resume_started_at === null ? null : Number(cols.resume_started_at),
          })
        : 'active';
      const carrier = phase === 'active' ? pausedCarrierForWorkspace(db, ws, deps.getWorkspace, { includeReleased: true }) : null;
      const coveredBy = carrier && carrier.runId !== runId ? { runId: carrier.runId, label: label(carrier.runId) } : null;
      const anchored = run !== null && isCoordinatorHandle(run.coordinator, ws.id);
      const switchOn = run ? run.flags.pause === true : null;
      controls[ws.id] = {
        wsId: ws.id,
        runId,
        anchored,
        switchOn,
        phase,
        coveredBy,
        can: availabilityFor({ anchored, runKnown: run !== null, switchOn, phase, covered: coveredBy !== null }),
      };
    }
    return { available: true, error: null, at, runs, controls, byWorkspace };
  } catch (e) {
    return unavailableOverview(`pause overview failed: ${e instanceof Error ? e.message : String(e)}`, at);
  }
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

// compile-time pins: the wire unions must cover every outcome the shipped writers can return, and `ReleaseResult` must stay assignable to the wire shape
const _outcomesCovered: Exclude<RunPauseOutcome | RepriseOutcome, PauseUiWriteOutcome> extends never ? true : never = true;
const _releaseShape = (r: ReleaseResult): PauseUiReleaseRaw => r;
void _outcomesCovered;
void _releaseShape;

/** THE actor decision (spec question 1): the workspace row the control belongs to. See the file header. */
export function uiActor(wsId: string): string {
  return wsId;
}

function ctxFor(db: BusDb, deps: PauseUiDeps, runId: string, actor: string, cover: ExplainCtx['cover']): ExplainCtx {
  const auth = runHoldAuthority(db, runId);
  return { label: labeler(deps), runLabel: labeler(deps)(runId), actorLabel: labeler(deps)(actor), mayBe: auth ? [auth.coordinator, ...auth.ancestors] : [], cover };
}

function targetOf(deps: PauseUiDeps, wsId: string): { ws: WaveNode; runId: string } | null {
  const ws = deps.getWorkspace(wsId);
  if (!ws) return null;
  return { ws, runId: nearestOrchestratorId(ws, deps.getWorkspace) };
}

/** `orchestra run pause [--hard]` from a workspace row (`mode` 'soft' = Pause douce, 'hard' = Pause dure; `hard` over a douce still waiting escalates it). */
export function uiPause(db: BusDb | null, deps: PauseUiDeps, req: { wsId: string; mode: PauseMode }): PauseUiWriteResult {
  const t = targetOf(deps, req.wsId);
  if (!db || !t) {
    const outcome = !db ? 'bus-unavailable' : 'unknown-workspace';
    return { outcome, runId: t?.runId ?? null, actor: null, explain: explainPauseOutcome(outcome, ctxStub(deps, req.wsId)), cover: null, overview: readPauseOverview(db, deps) };
  }
  const actor = uiActor(req.wsId);
  const outcome = setRunPause(db, t.runId, true, actor, req.mode);
  return { outcome, runId: t.runId, actor, explain: explainPauseOutcome(outcome, ctxFor(db, deps, t.runId, actor, null)), cover: null, overview: readPauseOverview(db, deps) };
}

/** `orchestra run resume` from a workspace row: starts the structured Reprise (`beginReprise` — coordinators first, workers released afterwards). Does NOT touch the liveness hold (spec question 4). */
export function uiResume(db: BusDb | null, deps: PauseUiDeps, req: { wsId: string }): PauseUiWriteResult {
  const t = targetOf(deps, req.wsId);
  if (!db || !t) {
    const outcome = !db ? 'bus-unavailable' : 'unknown-workspace';
    return { outcome, runId: t?.runId ?? null, actor: null, explain: explainResumeOutcome(outcome, ctxStub(deps, req.wsId)), cover: null, overview: readPauseOverview(db, deps) };
  }
  const actor = uiActor(req.wsId);
  const outcome = beginReprise(db, t.runId, actor, { reason: 'manual' });
  // `not-paused` on a run an ANCESTOR still pauses: say so (the CLI's "still PAUSED by run X — lift that one")
  let cover: PauseUiWriteResult['cover'] = null;
  if (outcome === 'not-paused') {
    const c = pausedCarrierForWorkspace(db, t.ws, deps.getWorkspace, { includeReleased: true });
    if (c && c.runId !== t.runId) cover = { runId: c.runId, label: labeler(deps)(c.runId) };
  }
  return { outcome, runId: t.runId, actor, explain: explainResumeOutcome(outcome, ctxFor(db, deps, t.runId, actor, cover)), cover, overview: readPauseOverview(db, deps) };
}

/**
 * `orchestra run release <ws>… | --all` from a workspace row: `targets` = roster ws ids (exact, or a unique prefix of ≥ 6 chars) or 'all' (the members of the
 * ACTING row's own run only — a worker of a run below it comes back in `below`). The carrier is the RESUMING pause that governs the acting row (`resumingCarrierFor`,
 * the CLI's own resolution) unless `carrierRunId` names one.
 */
export function uiRelease(
  db: BusDb | null,
  deps: PauseUiDeps,
  req: { wsId: string; targets: readonly string[] | 'all'; carrierRunId?: string | null },
): PauseUiReleaseResult {
  const t = targetOf(deps, req.wsId);
  if (!db || !t) {
    const outcome = !db ? 'bus-unavailable' : 'unknown-workspace';
    const ex = explainPauseOutcome(outcome, ctxStub(deps, req.wsId));
    return { result: null, runId: t?.runId ?? null, carrierRunId: null, actor: null, explain: ex ? [ex] : [], overview: readPauseOverview(db, deps) };
  }
  const actor = uiActor(req.wsId);
  const carrier = req.carrierRunId ?? resumingCarrierFor(db, t.runId, liveChainIds(deps, req.wsId));
  if (!carrier) {
    // not under a RESUMING pause: the writer itself would say `not-resuming` / `not-paused` — ask it against the run so the typed answer is the writer's
    const result = releaseMembers(db, t.runId, actor, req.targets);
    return { result, runId: t.runId, carrierRunId: null, actor, explain: explainReleaseResult(result, { ...ctxFor(db, deps, t.runId, actor, null), all: req.targets === 'all' }), overview: readPauseOverview(db, deps) };
  }
  const result = releaseMembers(db, carrier, actor, req.targets);
  return { result, runId: t.runId, carrierRunId: carrier, actor, explain: explainReleaseResult(result, { ...ctxFor(db, deps, carrier, actor, null), all: req.targets === 'all' }), overview: readPauseOverview(db, deps) };
}

function ctxStub(deps: PauseUiDeps, wsId: string): ExplainCtx {
  const label = labeler(deps);
  return { label, runLabel: label(wsId), actorLabel: label(wsId), mayBe: [], cover: null };
}
