// Fleet PAUSE — the UI's data layer (#257, wave F ledger #281). NOTHING here writes a bus column itself: every write is the SHIPPED writer
// (`setRunPause`, `beginReprise`, `releaseMembers`), every read the SHIPPED reader (`pauseStatusView`, `repriseStatusView`, `listBilan`,
// `pausedCarrierForWorkspace`) — no second path (ADR 0003 §the bus is the source of truth). Electron-free: the host binds it in pause-ui-host.ts.
//
// WHO ACTS (spec Q1, ledger #281 D-pick): the HUMAN. The writers get `{ human: true }` (the ONLY in-process callers — enumerated by pause-gates-wiring.test.ts): the coordinator rule is skipped (the human is above
// every coordinator) and `paused_by` / `released_by` / the `reprise` sender / the Consigne / the Bilan say « humain » (`PAUSE_HUMAN_BY`), never the run's coordinator. What a row may do is a UI rule (spec Q5): a WORKER
// row is not a wave — the typed outcome `refused` (UI-emitted, nothing written) explains it and LINKS to its orchestrator; the writers' own `refused` is the CLI's.

import type { BusDb } from './bus.ts';
import { getRun, runHoldAuthority, setRunHold } from './bus-runs.ts';
import { beginReprise, getRunPause, pausedCarrierForWorkspace, setRunPause, type RunPauseOutcome } from './bus-pause.ts';
import { listBilan, recordPauseOrigin, replacePauseOrigin, type BilanRow } from './bus-pause-records.ts';
import { pauseStatusView } from './pause-douce.ts';
import { readCarrierColumns, readRoster, releaseMembers, repriseStatusView, resumingCarrierFor, type ReleaseResult } from './pause-reprise.ts';
import { nearestOrchestratorId, nodeOrchestrates, type WaveNode } from './wave-run-id.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { PAUSE_AUTO_BY } from '../shared/pause-auto.ts';
import { actorText, PAUSE_HUMAN_BY, pausePhaseOf, pauseRosterSummary, type PauseMode, type PausePhase, type RepriseOutcome } from '../shared/pause-lifecycle.ts';
import { killedCommands, stripControl } from '../shared/pause-consigne.ts';
import {
  availabilityFor,
  explainPauseOutcome,
  explainReleaseResult,
  explainResumeOutcome,
  explainWorkerRow,
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
// a workspace name / branch is user- or agent-chosen text too: the same control / bidi strip as every Bilan string (R1b-4)
const labeler = (deps: PauseUiDeps) => (id: string): string => cl(deps.labelOf(id) ?? short(id), 160);

type KillReportLike = { killed?: Array<{ cmd?: string; cwd?: string | null; pid?: number; outcome?: string }>; survivors?: Array<{ cmd?: string; pid?: number; reason?: string }>; refused?: Array<{ cmd?: string; pid?: number; reason?: string }>; skipped?: string };

/** Every recorded string (argv, cwd, paths, branch, errors, notes) is agent / filesystem-chosen text: control, invisible and bidi characters are stripped exactly as `orchestra run status` (`c()`) and the Consigne do,
 *  so a hostile command line cannot forge or reorder a line of the Bilan on the human's screen (review F8/F11, R1-6). */
const cl = (v: unknown, max = 300): string => {
  const t = stripControl(v);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const clOrNull = (v: unknown, max = 300): string | null => (v === null || v === undefined ? null : cl(v, max));

/** One Bilan row → what a screen shows. Pure over the row; capped so the push payload stays small. `killed_json` is the trap's KillReport (`{killed, survivors, refused, spared…}`), `{skipped}` for a remote member, or NULL
 *  while the trap has not finished for this member — read exactly as `orchestra run status` and the Consigne de reprise read it (`killedCommands` is the Consigne's own merge). */
export function toBilanLine(b: BilanRow): PauseUiBilanLine {
  const a = b.activity;
  const report: KillReportLike | null = b.killed && typeof b.killed === 'object' && !Array.isArray(b.killed) ? (b.killed as KillReportLike) : null;
  const merged = killedCommands({ snapshotRef: b.snapshotRef, dirty: b.dirty, killed: b.killed, error: b.error, activity: a });
  const rawKilled = [...(report?.killed ?? []), ...(a?.earlierKilled ?? []), ...(a?.observerKilled ?? [])];
  const outcomeByCmd = new Map(rawKilled.map((k) => [`${k.cwd ?? ''}\u0000${k.cmd}`, (k as { outcome?: string }).outcome ?? null]));
  const trap: PauseUiBilanLine['trap'] = b.killed === null || b.killed === undefined ? 'pending' : report?.skipped ? 'skipped' : 'done';
  const skippedLarge = (a?.skippedLarge ?? []).slice().sort((x, y) => Number(y.bytes) - Number(x.bytes));
  return {
    snapshotRef: clOrNull(b.snapshotRef, 200),
    branch: clOrNull(a?.branch, 200),
    head: clOrNull(a?.head, 80),
    dirty: b.dirty,
    changed: a?.changed ?? null,
    snapshotIncomplete: a?.snapshotIncomplete ?? null,
    wasDoing: {
      turnRunning: a?.turnRunning === true,
      inFlight: (a?.inFlightTools ?? []).map((t) => cl(t.input ?? t.tool ?? '?')).slice(0, 4),
      bgTasks: (a?.bgTasks ?? []).map((t) => cl(t.description)).slice(0, 4),
      lastTask: clOrNull(a?.lastTask, 200),
    },
    interrupt: clOrNull(a?.interrupt, 40),
    exempt: a?.exempt === 'pauser' || a?.interrupt === 'exempt',
    killed: merged.slice(-KILLED_CAP).map((k) => ({ cmd: cl(k.cmd), cwd: clOrNull(k.cwd, 300), outcome: clOrNull(outcomeByCmd.get(`${k.cwd ?? ''}\u0000${k.cmd}`) ?? null, 20) })),
    killedCount: merged.length,
    trap,
    skipped: report?.skipped ? cl(report.skipped, 200) : null,
    survivors: (report?.survivors ?? []).slice(0, 6).map((x) => ({ cmd: cl(x.cmd, 200), pid: Number(x.pid ?? 0), reason: cl(x.reason, 200) })),
    refused: (report?.refused ?? []).slice(0, 6).map((x) => ({ cmd: cl(x.cmd, 200), pid: Number(x.pid ?? 0), reason: cl(x.reason, 200) })),
    warnings: (a?.snapshotWarnings ?? []).slice(0, NOTES_CAP).map((w) => cl(w, 300)),
    // what the snapshot did NOT capture (the same facts `orchestra run status` prints): that worktree is the ONLY copy of it
    notCaptured: skippedLarge.slice(0, 6).map((f) => ({ path: cl(f.path, 300), bytes: Number(f.bytes) || 0, files: f.files === undefined ? null : Number(f.files), reason: f.reason === 'total-cap' ? 'total-cap' : f.reason === 'file-cap' ? 'file-cap' : null })),
    notCapturedCount: a?.skippedLargeCount ?? skippedLarge.length,
    snapshotNotes: (a?.snapshotNotes ?? []).slice(0, NOTES_CAP).map((n) => cl(n, 300)),
    submodules: (a?.submodules ?? []).slice(0, 6).map((m) => ({ path: cl(m.path, 300), ref: clOrNull(m.ref, 200), dirty: m.dirty === true, error: clOrNull(m.error, 300) })),
    notes: (a?.notes ?? []).slice(-NOTES_CAP).map((n) => cl(n, 300)),
    error: clOrNull(b.error, 400),
  };
}

/** Carriers that hold a pause column. The FROZEN `pause` switch filter is `pauseStatusView` → `activePauseFor`'s (a carrier whose switch is OFF reads null there: never a run, never a badge). */
function activeCarrierIds(db: BusDb): Array<{ id: string; auto: boolean; title: string | null }> {
  const rows = db.prepare('SELECT id, title, pause_auto FROM runs WHERE paused_at IS NOT NULL ORDER BY paused_at, id').all() as Array<{ id: string; title: string | null; pause_auto: string | null }>;
  return rows.map((r) => ({ id: r.id, auto: r.pause_auto !== null && r.pause_auto !== undefined, title: r.title ?? null }));
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
    pausedByLabel: pv.pausedBy ? (pv.pausedBy === PAUSE_HUMAN_BY ? actorText(pv.pausedBy, 'fr') : pv.pausedBy === PAUSE_AUTO_BY ? "l'hôte (limite d'usage)" : label(pv.pausedBy)) : null,
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
    // runs whose coordinator IS their own id (the app's anchor rule): one read, not one per workspace
    const anchoredRuns = new Set((db.prepare('SELECT id, coordinator FROM runs').all() as Array<{ id: string; coordinator: string }>).filter((r) => isCoordinatorHandle(r.coordinator, r.id)).map((r) => r.id));
    for (const ws of workspaces) {
      // a row gets a control when it ANCHORS a run: an orchestrator, or a plain workspace the host gave a mission run (#221: a parent that spawned children). A worker row's control is explained by
      // the UI's own `refused` at click time (Q5: it has an orchestrator above and no run of its own) with a link to that orchestrator.
      const ownsRun = anchoredRuns.has(ws.id);
      if (!nodeOrchestrates(ws) && !ownsRun) continue;
      const runId = ownsRun ? ws.id : nearestOrchestratorId(ws, deps.getWorkspace);
      const run = getRun(db, runId);
      const cols = db.prepare('SELECT paused_at, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at, resume_started_at FROM runs WHERE id = ?').get(runId) as
        | { paused_at: number | null; pause_mode: string | null; pause_deadline_at: number | null; pause_escalated_at: number | null; pause_trap_at: number | null; resume_started_at: number | null }
        | undefined;
      const switchOn = run ? run.flags.pause === true : null;
      // UNKNOWN is not NONE (the gates' own rule): a pause column on a run whose FROZEN switch is OFF is not enforced — the control reads ACTIVE, never "paused"
      const phase: PausePhase = cols && switchOn === true
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

/** A worker row (not a wave): its nearest run owner is ANOTHER row. The refusal is the UI's (Q5): nothing is written, the explanation links to the orchestrator. */
function isWorkerRow(t: { runId: string }, wsId: string): boolean {
  return t.runId !== wsId;
}

/** `ctxFor` that never throws: a failing bus read must not turn a refusal into a rejected invoke. */
function safeCtx(db: BusDb, deps: PauseUiDeps, runId: string, rowId: string, cover: ExplainCtx['cover'] = null): ExplainCtx {
  try {
    return ctxFor(db, deps, runId, rowId, cover);
  } catch {
    return { ...ctxStub(deps, rowId), runId };
  }
}

function ctxFor(db: BusDb, deps: PauseUiDeps, runId: string, actor: string, cover: ExplainCtx['cover']): ExplainCtx {
  const auth = runHoldAuthority(db, runId);
  return { label: labeler(deps), runLabel: labeler(deps)(runId), runId, actorLabel: labeler(deps)(actor), mayBe: auth ? [auth.coordinator, ...auth.ancestors] : [], cover };
}

/** The run a workspace row's control acts on: the run it ANCHORS (its own id, when the bus has a run whose coordinator is that row — an orchestrator, or a plain run-anchoring parent #221), else the nearest
 *  ancestor's that ANCHORS a run or orchestrates (a worker: the UI REFUSES it and the explanation links to that row), else the row itself (`no-run`). */
function targetOf(db: BusDb | null, deps: PauseUiDeps, wsId: string): { ws: WaveNode; runId: string } | null {
  const ws = deps.getWorkspace(wsId);
  if (!ws) return null;
  return { ws, runId: nearestRunOf(db, ws, deps) };
}

/** The first row at or above `ws` that orchestrates or anchors a bus run (R2-4: a child of a plain run-anchoring parent is explained against THAT parent, not as « no run »). `ws` itself when none. `ws` ITSELF counts even when archived; an archived ANCESTOR is skipped (no row to point at). */
function nearestRunOf(db: BusDb | null, ws: WaveNode, deps: PauseUiDeps): string {
  // an archived (or vanished) row has no line to point at: skipped, the next ancestor is named instead — an orchestrator included
  const usable = (id: string): boolean => {
    const w = deps.getWorkspace(id);
    return !!w && !w.archived;
  };
  const anchors = (id: string): boolean => {
    try {
      const r = db ? getRun(db, id) : null;
      return r !== null && isCoordinatorHandle(r.coordinator, id);
    } catch {
      return false;
    }
  };
  let cur: WaveNode = ws;
  const seen = new Set<string>([cur.id]);
  for (;;) {
    // the CLICKED row owns its run whatever its archive state (the Bus card of an archived carrier must still Reprendre / Libérer it); the archive skip is for the LINK's target — an ANCESTOR
    if ((cur.id === ws.id || usable(cur.id)) && (nodeOrchestrates(cur) || anchors(cur.id))) return cur.id;
    if (!cur.parentId) break;
    const parent = deps.getWorkspace(cur.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return ws.id;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `orchestra run pause [--hard]` from a workspace row (`mode` 'soft' = Pause douce, 'hard' = Pause dure; `hard` over a douce still waiting escalates it). */
export function uiPause(db: BusDb | null, deps: PauseUiDeps, req: { wsId: string; mode: PauseMode }): PauseUiWriteResult {
  const t = targetOf(db, deps, req.wsId);
  if (!db || !t) {
    const outcome = !db ? 'bus-unavailable' : 'unknown-workspace';
    return { outcome, runId: t?.runId ?? null, actor: null, explain: explainPauseOutcome(outcome, ctxStub(deps, req.wsId)), cover: null, overview: readPauseOverview(db, deps) };
  }
  const actor = PAUSE_HUMAN_BY;
  // an unknown mode is REFUSED, never defaulted to the destructive one (a renderer bug must not become a Pause dure)
  if (req.mode !== 'soft' && req.mode !== 'hard') return failed(db, deps, t.runId, actor, new Error(`unknown pause mode ${JSON.stringify(String(req.mode).slice(0, 20))} — nothing was written`));
  if (isWorkerRow(t, req.wsId)) return { outcome: 'refused', runId: t.runId, actor: null, explain: explainWorkerRow('pause', safeCtx(db, deps, t.runId, req.wsId)), cover: null, overview: readPauseOverview(db, deps) };
  const at = Date.now();
  let outcome: RunPauseOutcome;
  try {
    outcome = setRunPause(db, t.runId, true, actor, req.mode, { human: true });
    if (outcome === 'escalated') {
      // the human's Pause dure over an agent's douce: the writer made `paused_by` the human's; the recorded origin chain (who was exempt) goes too — nobody is spared (Q2)
      const made = getRunPause(db, t.runId);
      if (made) replacePauseOrigin(db, t.runId, made.pausedAt, []);
    }
    if (outcome === 'paused') {
      // A UI click has no CLI process chain: record an EMPTY origin (the shipped writer, as the CLI does after its own pause) so the host trap does not wait up to 3 s for one before it
      // interrupts a live member, and the Bilan says what is true — nobody is the pauser, nobody is spared.
      const made = getRunPause(db, t.runId);
      if (made && made.pausedAt >= at) recordPauseOrigin(db, t.runId, made.pausedAt, []);
    }
  } catch (e) {
    return failed(db, deps, t.runId, actor, e);
  }
  return { outcome, runId: t.runId, actor, explain: explainPauseOutcome(outcome, ctxFor(db, deps, t.runId, req.wsId, null)), cover: null, overview: readPauseOverview(db, deps) };
}

/** A writer THREW (SQLITE_BUSY past the 5 s busy_timeout, a full disk…): never a rejected invoke and never a silent panel — a typed `write-failed` the UI explains. */
function failed(db: BusDb, deps: PauseUiDeps, runId: string, actor: string, e: unknown): PauseUiWriteResult {
  // the bus that just threw may throw again on the reads below: the explanation must still come out
  let ctx: ExplainCtx;
  try {
    ctx = ctxFor(db, deps, runId, actor, null);
  } catch {
    ctx = ctxStub(deps, actor);
  }
  const explain = explainPauseOutcome('write-failed', { ...ctx, error: msgOf(e) });
  return { outcome: 'write-failed', runId, actor, explain, cover: null, overview: readPauseOverview(db, deps) };
}

/** `orchestra run resume` from a workspace row, exactly: starts the structured Reprise (`beginReprise` — coordinators first, workers released afterwards) THEN lifts the run's liveness hold (`setRunHold(false)`), as the verb does. */
export function uiResume(db: BusDb | null, deps: PauseUiDeps, req: { wsId: string }): PauseUiWriteResult {
  const t = targetOf(db, deps, req.wsId);
  if (!db || !t) {
    const outcome = !db ? 'bus-unavailable' : 'unknown-workspace';
    return { outcome, runId: t?.runId ?? null, actor: null, explain: explainResumeOutcome(outcome, ctxStub(deps, req.wsId)), cover: null, overview: readPauseOverview(db, deps) };
  }
  if (isWorkerRow(t, req.wsId)) return { outcome: 'refused', runId: t.runId, actor: null, explain: explainWorkerRow('resume', safeCtx(db, deps, t.runId, req.wsId)), cover: null, overview: readPauseOverview(db, deps) };
  const actor = PAUSE_HUMAN_BY;
  let outcome: RepriseOutcome;
  let holdLifted = false;
  try {
    outcome = beginReprise(db, t.runId, actor, { reason: 'manual', human: true });
    // `orchestra run resume` is ONE verb for both: after the Reprise it lifts the run's liveness HOLD too (verbRunHold) — same writer, as the human
    holdLifted = setRunHold(db, t.runId, false, actor, { human: true }) === 'resumed';
  } catch (e) {
    return failed(db, deps, t.runId, actor, e);
  }
  // `not-paused` on a run an ANCESTOR still pauses: say so (the CLI's "still PAUSED by run X — lift that one")
  let cover: PauseUiWriteResult['cover'] = null;
  if (outcome === 'not-paused') {
    const c = pausedCarrierForWorkspace(db, t.ws, deps.getWorkspace, { includeReleased: true });
    if (c && c.runId !== t.runId) cover = { runId: c.runId, label: labeler(deps)(c.runId) };
  }
  return { outcome, runId: t.runId, actor, explain: explainResumeOutcome(outcome, { ...ctxFor(db, deps, t.runId, req.wsId, cover), holdLifted }), cover, holdLifted, overview: readPauseOverview(db, deps) };
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
  const t = targetOf(db, deps, req.wsId);
  if (!db || !t) {
    const outcome = !db ? 'bus-unavailable' : 'unknown-workspace';
    const ex = explainPauseOutcome(outcome, ctxStub(deps, req.wsId));
    return { result: null, runId: t?.runId ?? null, carrierRunId: null, actor: null, explain: ex ? [ex] : [], overview: readPauseOverview(db, deps) };
  }
  if (isWorkerRow(t, req.wsId)) return { result: null, runId: t.runId, carrierRunId: null, actor: null, explain: [explainWorkerRow('release', safeCtx(db, deps, t.runId, req.wsId))], overview: readPauseOverview(db, deps) };
  const actor = PAUSE_HUMAN_BY;
  let carrier: string | null = null;
  let result: ReleaseResult;
  try {
    carrier = req.carrierRunId ?? resumingCarrierFor(db, t.runId, liveChainIds(deps, req.wsId));
    // not under a RESUMING pause: the writer itself says `not-resuming` / `not-paused` — ask it against the run so the typed answer is the writer's. `--all` = the members of the CLICKED row's run (`ownRuns`)
    result = releaseMembers(db, carrier ?? t.runId, actor, req.targets, Date.now(), { human: true, ownRuns: [t.runId] });
  } catch (e) {
    const f = failed(db, deps, t.runId, actor, e);
    return { result: null, runId: t.runId, carrierRunId: carrier, actor, explain: f.explain ? [f.explain] : [], overview: f.overview };
  }
  return { result, runId: t.runId, carrierRunId: carrier, actor, explain: explainReleaseResult(result, { ...ctxFor(db, deps, carrier ?? t.runId, req.wsId, null), actorId: req.wsId, carrierRunId: carrier ?? t.runId, all: req.targets === 'all' }), overview: readPauseOverview(db, deps) };
}

function ctxStub(deps: PauseUiDeps, wsId: string): ExplainCtx {
  const label = labeler(deps);
  return { label, runLabel: label(wsId), runId: wsId, actorLabel: label(wsId), mayBe: [], cover: null };
}

// ── the push fingerprint ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a bus write can change in the overview, as a string: a handful of aggregate queries (no row dump). A message / ack / wake touches none of these tables' overview columns, so the (heavier)
 * overview is not rebuilt for it; EVERY column the overview reads moves it (pause columns, `pause_auto`, the coordinator of each run, the roster's timestamps / roles / member runs, a Bilan row's
 * content length — a note appended, a kill recorded, an error set — and the frozen flags). Unit-tested per column in pause-ui.test.ts.
 */
export function pauseOverviewFingerprint(db: BusDb): string {
  const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
  const runs = one(`SELECT COUNT(*) AS n, COALESCE(SUM(paused_at),0) AS p, COALESCE(SUM(resume_started_at),0) AS s, COALESCE(SUM(pause_escalated_at),0) AS e, COALESCE(SUM(pause_trap_at),0) AS t,
                           COALESCE(SUM(pause_deadline_at),0) AS d, COALESCE(SUM(pause_auto IS NOT NULL),0) AS a, COALESCE(SUM(pause_mode = 'soft'),0) AS m,
                           COALESCE(group_concat(id || ':' || coordinator, ','),'') AS who, COALESCE(SUM(length(coalesce(title,''))),0) AS ti FROM (SELECT * FROM runs ORDER BY id)`);
  const roster = one(`SELECT COUNT(*) AS n, COALESCE(SUM(pause_confirmed_at),0) AS c, COALESCE(SUM(released_at),0) AS r, COALESCE(SUM(reprise_confirmed_at),0) AS a, COALESCE(SUM(role = 'coordinator'),0) AS k,
                             COALESCE(SUM(length(coalesce(member_run,''))),0) AS mr, COALESCE(SUM(pause_confirm_via = 'trap'),0) AS v FROM pause_members`);
  const bilan = one(`SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m, COALESCE(SUM(length(coalesce(activity,''))),0) AS a, COALESCE(SUM(length(coalesce(killed_json,''))),0) AS k, COALESCE(SUM(killed_json IS NOT NULL),0) AS kn,
                            COALESCE(SUM(length(coalesce(error,''))),0) AS e, COALESCE(SUM(coalesce(dirty,0)),0) AS d, COALESCE(SUM(length(coalesce(snapshot_ref,''))),0) AS r FROM pause_records`);
  const flags = one('SELECT COUNT(*) AS n, COALESCE(SUM(length(flags)),0) AS l FROM run_flags');
  return JSON.stringify([runs, roster, bilan, flags]);
}
