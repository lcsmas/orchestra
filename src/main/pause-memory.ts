// Memory PAUSE (#290, epic #284, wave G ledger #295 FI-2 + FI-1.8) — the bus half. NO Electron import (like pause-auto.ts): the store, the memory guard and the tick reach it through
// `MemoryPauseDeps`; src/main/pause-memory-host.ts binds the real ones. Pure policy: src/shared/pause-memory.ts.
//
//  • `imposeMemoryPause` — the guard says the host is critical ⇒ a Pause DURE with the motive 'memory' (`runs.pause_auto`, no migration) on every TOPMOST run whose FROZEN `pause` switch is ON and
//    that carries a live local fleet. A pause already in force (MANUAL, usage-limit, or a memory one) is left exactly as it is; a memory pause that is RESUMING goes back to PAUSED in a new epoch.
//    A `pause`-OFF run is never written to. The existing trap (kill tool trees, Bilan, containers FI-1.8) then runs unchanged.
//  • `liftMemoryPause` — memory is back above the Admission threshold ⇒ per memory-paused run `beginReprise(db, run, 'host', {host:true, reason:'memory'})` (coordinators first, workers via their
//    OPS; the container restart runs first, FI-1.7). Only runs whose stored motive is 'memory' (epoch-matched) are ever lifted: a manual pause — or one a human took over — is never touched.
//  • `applyMemoryPause` — the entry the host calls on a guard edge (`pause_due` / `pause_liftable`) and on every tick (a LEVEL read of the snapshot: also right after an app restart).

import { openGate, send, type BusDb } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { revertResumeToPaused } from './pause-reprise.ts';
import {
  ancestorRunIds,
  ancestorStillPaused,
  escalationTarget,
  liveChain,
  readCarrier,
  recordHostOrigin,
  wakeOffAddressees,
  type AutoWorkspace,
  type PauseAutoDeps,
} from './pause-auto.ts';
import { parseSwitches, type BusSwitches } from '../shared/bus-switches.ts';
import { HUMAN_GATE_RECIPIENT } from '../shared/human-gates.ts';
import { formatGb, type MemoryGuardSnapshot, type MemoryPausedRunView } from '../shared/memory-guard.ts';
import { heldAddresseesKey, parseAutoHeld, parsePauseAuto, type AutoHeld } from '../shared/pause-auto.ts';
import {
  MEMORY_PAUSE_BY,
  decideMemoryLift,
  encodeMemoryPause,
  memoryPauseWant,
  parseMemoryPause,
  type MemoryPauseReason,
  type MemoryPauseWant,
} from '../shared/pause-memory.ts';

/** What the memory Pause reads from the store / the bus / the clock — a structural slice of `PauseAutoDeps`. */
export interface MemoryPauseDeps extends Pick<PauseAutoDeps, 'getBus' | 'beginReprise' | 'now' | 'log' | 'storeReady'> {
  /** The workspace store; `host.kind === 'sandbox'` marks a sandbox-hosted workspace (ignored by the guard). */
  getWorkspace: (id: string) => (AutoWorkspace & { host?: { kind: string } }) | undefined;
  /** Every workspace of the store (a fleet = the workspaces below a run's anchor). */
  listWorkspaces: () => ReadonlyArray<AutoWorkspace & { host?: { kind: string } }>;
}

/** The slice of `MemoryGuardSnapshot` the memory Pause keys on (FI-2). */
export interface MemoryGuardView {
  measured: boolean;
  availBytes: number | null;
  pause: 'none' | 'held';
  pauseCycle: number;
  episode: number;
  admissionBytes: number;
  criticalBytes: number;
}

/** The view the memory Pause keys on, from the guard's snapshot (FI-2): every field is load-bearing — `pauseCycle` keys the ledger, `measured` / `availBytes` gate every decision, `pause` is the level read's `impose`. */
export function viewOfSnapshot(s: MemoryGuardSnapshot): MemoryGuardView {
  return { measured: s.measured, availBytes: s.availBytes, pause: s.pause, pauseCycle: s.pauseCycle, episode: s.episode, admissionBytes: s.admissionBytes, criticalBytes: s.criticalBytes };
}

/** In-memory bookkeeping: runId → the `pauseCycle` this host already evaluated it for. A new cycle (every `pause_due` edge) evaluates every candidate; a re-read inside the same cycle skips a
 *  run it already handled, so a human who lifted the memory Pause by hand while memory stays critical is not fought every tick. A restart forgets it (the next read re-imposes). */
export interface MemoryPauseLedger {
  imposed: Map<string, number>;
}
export const newMemoryPauseLedger = (): MemoryPauseLedger => ({ imposed: new Map() });

const mem = (bytes: number): string => `MemAvailable ${formatGb(bytes, 2)}`;

// ─── which runs are REALLY under a memory Pause (read-only: `orchestra bus-status`, D1 of ledger #329) ────────────────────────────────────────────────────

/** Every run that is paused RIGHT NOW with the stored memory motive (epoch-matched, so a later manual pause never reads as one). Unlike {@link memoryPausedRuns} (the runs the guard may LIFT) this
 *  includes a run whose Reprise is under way — it is still paused until every member is back — and does not look at the frozen `pause` switch (only a switch-ON run can have been paused). The guard's own `pause` field
 *  means "due now" and says nothing about this — the bus row is the truth (it also survives an app restart). Pure read; a failed read is an empty list. */
export function memoryPausedRunViews(db: BusDb | null, label?: (runId: string) => string | undefined): MemoryPausedRunView[] {
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT id, paused_at, pause_auto, resume_started_at FROM runs WHERE paused_at IS NOT NULL AND pause_auto IS NOT NULL ORDER BY paused_at, id').all() as Array<Record<string, unknown>>;
    const out: MemoryPausedRunView[] = [];
    for (const r of rows) {
      const pausedAt = Number(r.paused_at);
      if (parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt) === null) continue;
      const runId = String(r.id);
      const name = label?.(runId);
      out.push({ runId, ...(name ? { label: name } : {}), since: pausedAt, resuming: r.resume_started_at !== null && r.resume_started_at !== undefined });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── which runs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every run that carries a live LOCAL FLEET, with its frozen switches: its anchor workspace is live (exists, not archived, not sandbox-hosted) AND at least one live local workspace sits BELOW it. */
export function liveFleetRuns(db: BusDb, deps: Pick<MemoryPauseDeps, 'getWorkspace' | 'listWorkspaces'>): Array<{ id: string; flags: BusSwitches }> {
  const rows = db.prepare('SELECT r.id AS id, f.flags AS flags_json FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id ORDER BY r.created_at, r.id').all() as Array<{ id: string; flags_json: string | null }>;
  const local = (w: { archived?: boolean; host?: { kind: string } } | undefined): boolean => !!w && !w.archived && w.host?.kind !== 'sandbox';
  // every id that has at least one live local workspace below it (the live parent chain of each live local workspace, minus itself)
  const hasMembers = new Set<string>();
  for (const w of deps.listWorkspaces()) {
    if (!local(w)) continue;
    for (const id of liveChain(deps, w).ids.slice(1)) hasMembers.add(id);
  }
  return rows.filter((r) => local(deps.getWorkspace(String(r.id))) && hasMembers.has(String(r.id))).map((r) => ({ id: String(r.id), flags: parseSwitches(r.flags_json ?? null) }));
}

/** The TOPMOST of `ids`: those with no run of `ids` above them (the live workspace chain first, the bus run tree only when it is unknown or dangles). */
export function topmostRunIds(db: BusDb, deps: Pick<MemoryPauseDeps, 'getWorkspace'>, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestorRunIds(db, deps, id).some((a) => set.has(a)));
}

/** Runs whose FROZEN `pause` switch is ON that carry a FLEET ({@link liveFleetRuns}) and have NO such run above them — the topmost run of each tree: its Pause covers every run below (a child waits for
 *  every ancestor). A lone idle coordinator frees nothing and would be woken for nothing at the Reprise. A `pause`-OFF run is never a candidate, whatever sits above or below it. */
export function memoryPauseCandidates(db: BusDb, deps: Pick<MemoryPauseDeps, 'getWorkspace' | 'listWorkspaces'>): string[] {
  return topmostRunIds(db, deps, liveFleetRuns(db, deps).filter((r) => r.flags.pause === true).map((r) => r.id));
}

// ─── impose ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MemoryImposeOutcome =
  | 'paused' // a new Pause dure (motive memory) was written
  | 'repaused' // the run's memory (or usage-limit, host-owned) Reprise was RESUMING: back to PAUSED in a NEW epoch with the memory motive
  | 'already' // already under a memory Pause: untouched
  | 'usage-pause' // a usage-limit auto pause is in effect: untouched, re-looked-at every read (its state moves without a human: its Reprise may begin)
  | 'other-pause'; // a MANUAL pause (or a manual Reprise in progress) governs it: untouched — the human's

export interface MemoryImposeEntry {
  runId: string;
  outcome: MemoryImposeOutcome;
}

export interface MemoryImposeContext {
  availBytes: number;
  pauseCycle: number;
  episode: number;
  criticalBytes: number;
}

function imposeOne(deps: MemoryPauseDeps, db: BusDb, runId: string, ctx: MemoryImposeContext, attempt = 0): MemoryImposeOutcome {
  const now = deps.now();
  const reason: MemoryPauseReason = { reason: 'memory', pauseCycle: ctx.pauseCycle, episode: ctx.episode, availBytes: ctx.availBytes, thresholdBytes: ctx.criticalBytes };
  const cur = readCarrier(db, runId);
  if (cur && cur.pausedAt !== null) {
    const mine = parseMemoryPause(cur.pauseAuto, cur.pausedAt) !== null;
    const usage = parsePauseAuto(cur.pauseAuto, cur.pausedAt) !== null; // the host's OWN usage-limit auto pause
    if (cur.resumeStartedAt === null) return mine ? 'already' : usage ? 'usage-pause' : 'other-pause';
    if (!mine && !usage) return 'other-pause'; // a MANUAL Reprise is in progress: the human's, not ours to re-pause
    // A host-owned Reprise (memory's, or the usage-limit evaluator's once its quota is back) is under way and memory is critical: back to PAUSED in a NEW epoch (the old epoch's Bilan rows read
    // "fully trapped"), the epoch-bound memory motive written in the SAME statement. Re-checked inside one immediate transaction: a human takeover landing in between wins.
    const reverted = db
      .transaction((): boolean => {
        const c = readCarrier(db, runId);
        if (!c || c.pausedAt !== cur.pausedAt || c.resumeStartedAt === null) return false;
        if (parseMemoryPause(c.pauseAuto, c.pausedAt) === null && parsePauseAuto(c.pauseAuto, c.pausedAt) === null) return false;
        return revertResumeToPaused(db, runId, MEMORY_PAUSE_BY, now, { auto: (epoch) => encodeMemoryPause(reason, epoch) });
      })
      .immediate();
    if (reverted) {
      const epoch = readCarrier(db, runId)?.pausedAt;
      if (epoch !== null && epoch !== undefined) recordHostOrigin(db, deps, runId, epoch);
      deps.log.info(`memory-pause: ${mem(ctx.availBytes)} < critical ${formatGb(ctx.criticalBytes, 2)} — run ${runId} was RESUMING${mine ? '' : ' (usage-limit Reprise)'}: PAUSED again (new epoch, cycle ${ctx.pauseCycle})`);
      return 'repaused';
    }
    return attempt === 0 ? imposeOne(deps, db, runId, ctx, 1) : 'other-pause'; // the Reprise finished / another pause landed meanwhile: classify again, once
  }
  const res = db
    .prepare(
      `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_deadline_at = NULL, pause_escalated_at = NULL,
              pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?
        WHERE id = ? AND paused_at IS NULL`,
    )
    .run(now, MEMORY_PAUSE_BY, encodeMemoryPause(reason, now), runId);
  if (res.changes === 1) {
    recordHostOrigin(db, deps, runId, now);
    deps.log.info(`memory-pause: ${mem(ctx.availBytes)} < critical ${formatGb(ctx.criticalBytes, 2)} — run ${runId} is now PAUSED (dure, auto, motive memory, cycle ${ctx.pauseCycle}, episode ${ctx.episode})`);
    return 'paused';
  }
  // a pause landed between the read and the write: classify it now (once), never overwrite it
  return attempt === 0 ? imposeOne(deps, db, runId, ctx, 1) : 'other-pause';
}

/** Pause every candidate run the guard's critical state calls for; a run already evaluated in this `pauseCycle` is skipped (every `pause_due` edge opens a NEW cycle, so an edge always evaluates). */
export function imposeMemoryPause(deps: MemoryPauseDeps, ctx: MemoryImposeContext, ledger: MemoryPauseLedger): MemoryImposeEntry[] {
  const db = deps.getBus();
  if (!db) return [];
  if (deps.storeReady && !deps.storeReady()) return []; // UNKNOWN is not NONE: with the store unloaded every fleet would read as "not there"
  const out: MemoryImposeEntry[] = [];
  for (const runId of memoryPauseCandidates(db, deps)) {
    if (ledger.imposed.get(runId) === ctx.pauseCycle) continue;
    // one run failing must never starve the others
    try {
      const outcome = imposeOne(deps, db, runId, ctx);
      // ONLY the guard's OWN Pause is ledgered ("a human lifted it — don't fight"): a usage-limit or MANUAL pause in effect is looked at again at every read — when it ENDS inside this cycle the run is memory-paused at the next read
      if (outcome === 'paused' || outcome === 'repaused' || outcome === 'already') ledger.imposed.set(runId, ctx.pauseCycle);
      out.push({ runId, outcome });
    } catch (e) {
      deps.log.warn(`memory-pause: imposing the Pause on run ${runId} threw — retried at the next read`, e);
    }
  }
  return out;
}

// ─── lift ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryLiftEntry {
  runId: string;
  action: 'reprise' | 'wait';
  why?: string;
  outcome?: string;
}

interface MemoryPausedRun {
  runId: string;
  pausedAt: number;
  trapAt: number | null;
  reason: MemoryPauseReason;
  depth: number;
}

/** Runs PAUSED by the memory guard and not yet resuming (frozen switch ON, epoch-matched memory motive). Ancestor runs first. A manual pause, a usage-limit pause and a stale column never appear here. */
export function memoryPausedRuns(db: BusDb): MemoryPausedRun[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.paused_at, r.pause_trap_at, r.pause_auto, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL AND r.resume_started_at IS NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const parents = new Map((db.prepare('SELECT id, parent_run_id AS p FROM runs').all() as Array<{ id: string; p: string | null }>).map((r) => [r.id, r.p]));
  const depthOf = (id: string): number => {
    let d = 0;
    const seen = new Set<string>([id]);
    for (let p = parents.get(id) ?? null; p && !seen.has(p); p = parents.get(p) ?? null) {
      seen.add(p);
      d++;
    }
    return d;
  };
  const out: MemoryPausedRun[] = [];
  for (const r of rows) {
    if (parseSwitches((r.flags_json as string | null | undefined) ?? null).pause !== true) continue;
    const pausedAt = Number(r.paused_at);
    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt);
    if (!reason) continue;
    out.push({ runId: String(r.id), pausedAt, trapAt: r.pause_trap_at === null || r.pause_trap_at === undefined ? null : Number(r.pause_trap_at), reason, depth: depthOf(String(r.id)) });
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** Tell someone that the Reprise of `run` is HELD, and record the hold in `pause_auto.held` — ONE transaction (the row/gate AND the record land together or neither does). Null on failure. */
function escalateMemoryHold(db: BusDb, deps: MemoryPauseDeps, run: MemoryPausedRun, rawPauseAuto: string | null, off: Array<{ wsId: string; runId: string }>, availBytes: number): AutoHeld | null {
  try {
    if (!parseMemoryPause(rawPauseAuto, run.pausedAt)) return null; // no longer THIS memory pause
    const list = off.map((a) => `${a.wsId} (run ${a.runId})`).join(', ');
    const target = escalationTarget(db, deps, run.runId);
    const body =
      `Memory-Pause Reprise HELD for run ${run.runId}: memory is back (${mem(availBytes)}), but the Reprise would address ${list}, whose run has its frozen \`wake\` switch OFF — nobody would receive its \`reprise\` row ` +
      `and every worker below would stay blocked. The run stays PAUSED. Detach/remove that run, or lift the pause yourself once it is safe (\`orchestra run resume --run ${run.runId}\`).`;
    const held: AutoHeld = { at: deps.now(), addressees: heldAddresseesKey(off), to: target.kind === 'gate' ? HUMAN_GATE_RECIPIENT : target.coordinator }; // `encodeMemoryPause` stamps the memory motive on a hold
    db.transaction(() => {
      if (target.kind === 'coordinator') send(db, { runId: target.runId, sender: 'host', recipient: target.coordinator, kind: 'escalation', body });
      else openGate(db, run.runId, target.asker, body, HUMAN_GATE_RECIPIENT);
      const upd = db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ? AND pause_auto = ?').run(encodeMemoryPause(run.reason, run.pausedAt, held), run.runId, run.pausedAt, rawPauseAuto);
      if (upd.changes !== 1) throw new Error('the memory pause changed meanwhile'); // rolls the row back too
    }).immediate();
    return held;
  } catch (e) {
    deps.log.warn(`memory-pause: HELD escalation for run ${run.runId} failed — retried at the next read`, e);
    return null;
  }
}

function liftOne(deps: MemoryPauseDeps, db: BusDb, run: MemoryPausedRun, availBytes: number): MemoryLiftEntry {
  const now = deps.now();
  const decision = decideMemoryLift({ pausedAt: run.pausedAt, trapAt: run.trapAt, ancestorPaused: ancestorStillPaused(db, deps, run.runId), now });
  if (decision.action === 'wait') return { runId: run.runId, action: 'wait', why: decision.why };
  // the row may have changed since the SELECT (a human lift, a human takeover, a manual re-pause): never Reprise what is no longer THIS memory pause
  const cur = readCarrier(db, run.runId);
  if (!cur || cur.pausedAt !== run.pausedAt || cur.resumeStartedAt !== null || parseMemoryPause(cur.pauseAuto, cur.pausedAt) === null) return { runId: run.runId, action: 'wait', why: 'changed-meanwhile' };
  // The addressee set is re-read NOW: a Reprise nobody receives would leave every worker blocked for ever — held (told ONCE per addressee set), re-evaluated at every read
  const off = wakeOffAddressees(db, deps, run.runId, run.pausedAt);
  if (off.length > 0) {
    const key = heldAddresseesKey(off);
    const curHeld = parseAutoHeld(cur.pauseAuto, cur.pausedAt);
    if (!curHeld || curHeld.addressees.join('|') !== key.join('|')) {
      const held = escalateMemoryHold(db, deps, run, cur.pauseAuto, off, availBytes);
      if (held) deps.log.warn(`memory-pause: ${mem(availBytes)} — run ${run.runId} could be lifted but its Reprise could not wake ${off.map((a) => `${a.wsId} (run ${a.runId})`).join(', ')} (frozen wake switch OFF) — Reprise HELD, ${held.to === HUMAN_GATE_RECIPIENT ? 'asked the human (decision gate)' : `escalated to ${held.to}`}`);
    }
    return { runId: run.runId, action: 'wait', why: 'no-wake-addressee' };
  }
  if (parseAutoHeld(cur.pauseAuto, cur.pausedAt)) db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ? AND pause_auto = ?').run(encodeMemoryPause(run.reason, run.pausedAt, null), run.runId, run.pausedAt, cur.pauseAuto); // the offending run is gone: the hold ends with it
  let outcome: string;
  try {
    // the re-read and the Reprise are ONE immediate transaction (beginReprise nests as a savepoint): a human / coordinator takeover landing between them wins
    outcome = db
      .transaction((): string => {
        const again = readCarrier(db, run.runId);
        if (!again || again.pausedAt !== run.pausedAt || again.resumeStartedAt !== null || parseMemoryPause(again.pauseAuto, again.pausedAt) === null) return 'changed-meanwhile';
        return deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'memory' });
      })
      .immediate();
  } catch (e) {
    deps.log.warn(`memory-pause: Reprise of run ${run.runId} threw — retried at the next read`, e);
    return { runId: run.runId, action: 'wait', why: 'reprise-threw' };
  }
  if (outcome === 'changed-meanwhile') return { runId: run.runId, action: 'wait', why: 'changed-meanwhile' };
  if (outcome === 'resuming' || outcome === 'already-resuming') {
    deps.log.info(`memory-pause: ${mem(availBytes)} — memory is back, run ${run.runId} Reprise started (${outcome}; cycle ${run.reason.pauseCycle})`);
  } else if (outcome === 'refused') {
    deps.log.warn(`memory-pause: Reprise of run ${run.runId} REFUSED for a host caller — contract breach (#276 D3)`);
  }
  return { runId: run.runId, action: 'reprise', outcome };
}

/** Reprise every memory-paused run that may be lifted now. Only the memory motive is ever lifted: a MANUAL Pause (pause_auto NULL — including one a human took over from the guard) and a usage-limit pause stay as they are. */
export function liftMemoryPause(deps: MemoryPauseDeps, availBytes: number): MemoryLiftEntry[] {
  const db = deps.getBus();
  if (!db) return [];
  if (deps.storeReady && !deps.storeReady()) return []; // UNKNOWN is not NONE: with the store unloaded the live tree is unknown, the ancestor walk would lie
  const out: MemoryLiftEntry[] = [];
  for (const run of memoryPausedRuns(db)) {
    try {
      out.push(liftOne(deps, db, run, availBytes));
    } catch (e) {
      deps.log.warn(`memory-pause: lifting run ${run.runId} threw — retried at the next read`, e);
      out.push({ runId: run.runId, action: 'wait', why: 'lift-threw' });
    }
  }
  return out;
}

// ─── the entry the host calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryPauseApplied {
  want: MemoryPauseWant;
  imposed: MemoryImposeEntry[];
  lifted: MemoryLiftEntry[];
}

/** `due` / `liftable` = a guard EDGE (FI-2.4: key on `pause_due` / `pause_liftable`); `level` = a read of the snapshot (the tick, the boot reconcile — FI-2.5): right even after an app restart.
 *  An unmeasured snapshot does nothing (unknown ≠ plenty ≠ critical). */
export function applyMemoryPause(deps: MemoryPauseDeps, view: MemoryGuardView, ledger: MemoryPauseLedger, trigger: 'due' | 'liftable' | 'level'): MemoryPauseApplied {
  const none: MemoryPauseApplied = { want: 'none', imposed: [], lifted: [] };
  if (!view.measured || view.availBytes === null) return none;
  const avail = view.availBytes;
  const want: MemoryPauseWant = trigger === 'due' ? 'impose' : trigger === 'liftable' ? 'lift' : memoryPauseWant({ measured: view.measured, availBytes: avail, pause: view.pause, admissionBytes: view.admissionBytes });
  if (want === 'impose') {
    const imposed = imposeMemoryPause(deps, { availBytes: avail, pauseCycle: view.pauseCycle, episode: view.episode, criticalBytes: view.criticalBytes }, ledger);
    return { want, imposed, lifted: [] };
  }
  if (want === 'lift') return { want, imposed: [], lifted: liftMemoryPause(deps, avail) };
  return { ...none, want };
}

/** What the host does with one guard EDGE (FI-2.4: key on `pause_due` / `pause_liftable` only — an Admission edge is nothing of the memory Pause's; the snapshot is the state AFTER the sample). A throw is logged,
 *  never propagated into the guard's drain: the level read at the next tick retries. */
export function handleMemoryGuardEdge(deps: MemoryPauseDeps, ledger: MemoryPauseLedger, e: { transition: { kind: string }; snapshot: MemoryGuardSnapshot }): MemoryPauseApplied | null {
  if (e.transition.kind !== 'pause_due' && e.transition.kind !== 'pause_liftable') return null;
  try {
    return applyMemoryPause(deps, viewOfSnapshot(e.snapshot), ledger, e.transition.kind === 'pause_due' ? 'due' : 'liftable');
  } catch (err) {
    deps.log.warn(`memory-pause: handling ${e.transition.kind} failed — retried at the next tick`, err);
    return null;
  }
}
