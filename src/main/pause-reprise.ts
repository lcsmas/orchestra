// Structured Reprise — the bus half (#255, ledger #276 D3/D5, ADR 0003). Wave E, track E2.
//
// `orchestra run resume` on a paused carrier does NOT lift the pause: it starts a RESUMING phase (`runs.resume_started_at`). The host
// releases ONLY the coordinators of the carrier's subtree (depth order, each with a `reprise` bus row = the Bilan de pause of ITS wave);
// every worker stays blocked (the gate, `memberMayStart`) until its coordinator runs `orchestra run release <ws>|--all`, which sends it its
// Consigne de reprise. The run is ACTIVE again when the whole roster (`pause_members`) is released: every pause column goes back to NULL.
// Nothing here restarts anything: it only opens the gate for named members and tells them what the Pause recorded.
//
// LEAF module: it imports no `bus-pause*.ts` (bus-pause.ts imports THIS — `beginReprise`, the gate's release read, the lift's column
// clear — and `bus-pause-records.ts` imports bus-pause.ts), so the subtree walk is passed in by the callers.

import type { BusDb } from './bus.ts';
import { send } from './bus.ts';
import { getRun, runHoldAuthority } from './bus-runs.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { nearestOrchestratorId, nodeOrchestrates, type WaveNode } from './wave-run-id.ts';
import {
  memberMayStart,
  pausePhaseOf,
  pauseRosterSummary,
  type CarrierPauseColumns,
  type PauseConfirmVia,
  type PauseMemberRow,
  type PauseMode,
  type PausePhase,
  type RepriseOutcome,
} from '../shared/pause-lifecycle.ts';
import {
  consigneFromBilan,
  inFlightLines,
  killedCommands,
  renderConsigne,
  renderCoordinatorReprise,
  type BilanLike,
} from '../shared/pause-consigne.ts';
import type { ConsigneDeReprise } from '../shared/pause-lifecycle.ts';
import type { RepriseStatusView } from '../shared/pause-reprise-view.ts';

/** How long after the last release `bus-status` / `run status` keep naming members whose reprise accusé is still missing (tracking only — nothing is gated by it). */
export const REPRISE_TRACKING_TTL_MS = 24 * 3600_000;

/** Reserved `pause_records.ws_id` of the row carrying the pausing call's process chain — never a member (twin of bus-pause-records.ts). */
const PAUSE_ORIGIN_WS = '__pause_origin__';

/** The sender of every host-written row (twin of the wave-E `pause` rows, ledger #276 D3). */
export const HOST_SENDER = 'host';

// ─── the LIVE workspace tree ─────────────────────────────────────────────────

/**
 * The LIVE workspace tree — exactly what the gate and the trap walk (`parentId`, `kind`, `canOrchestrate`). `runs.parent_run_id` is write-once and a `runs` row
 * outlives a demotion, so the bus run tree misses a re-parented OPS and keeps an ex-orchestrator (review M3): coordinators, runs and release authority come from THIS
 * tree whenever it knows the workspace; the bus run tree is only the fallback for a workspace it does not know (or when no tree is registered). Registered by the host
 * (pause-trap-host.ts: the store) and by the store-less CLI (the app's store.json off disk).
 */
export interface LiveTree {
  get(id: string): WaveNode | undefined;
  ids(): string[];
}
let liveTreeSource: (() => LiveTree | null) | null = null;
export function setLiveTreeSource(src: (() => LiveTree | null) | null): void {
  liveTreeSource = src;
}
function liveTree(): LiveTree | null {
  try {
    const t = liveTreeSource?.() ?? null;
    return t && t.ids().length > 0 ? t : null;
  } catch {
    return null; // an unreadable tree is "no tree": the bus run tree answers
  }
}
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** `id` and its ancestors along the live `parentId` chain, self first (bounded; stops at a parent the tree does not have). `dangling` = it stopped at a parent the tree no
 *  longer has (a deleted ancestor): the chain says nothing about what lies above. */
function liveChainInfo(tree: LiveTree, id: string): { ids: string[]; dangling: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = tree.get(id);
  let dangling = false;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.id);
    if (!cur.parentId) break;
    const parent = tree.get(cur.parentId);
    if (!parent) dangling = true;
    cur = parent;
  }
  return { ids: out, dangling };
}
const liveChain = (tree: LiveTree, id: string): string[] => liveChainInfo(tree, id).ids;
/** Where `wsId` sits relative to the carrier on the live tree: 'under' (the chain reaches it), 'elsewhere' (a COMPLETE chain that does not — another wave), 'unknown' (not in the
 *  tree, or its chain dangles at a deleted ancestor — the bus run tree is the only evidence left, exactly like the gate's own fallback). */
function liveStatus(tree: LiveTree, carrier: string, wsId: string): 'under' | 'elsewhere' | 'unknown' {
  if (!tree.get(wsId)) return 'unknown';
  const { ids, dangling } = liveChainInfo(tree, wsId);
  if (ids.some((c) => sameId(c, carrier))) return 'under';
  return dangling ? 'unknown' : 'elsewhere';
}
interface LiveClass {
  /** The workspace orchestrates ⇒ it coordinates the run whose id is its own workspace id (run id == anchor workspace id). */
  coordinator: boolean;
  /** The run it belongs to (nearest orchestrator at or above it). */
  run: string;
  /** The run whose coordinator releases it: for a coordinator its PARENT run (the carrier for the top one); for a worker it is not used (its `run` is). */
  releaserRun: string;
}
/** What the live tree says about `wsId` — null when it does not know it or it is not at/under the carrier on the live chain. */
function classifyLive(tree: LiveTree, carrier: string, wsId: string): LiveClass | null {
  const node = tree.get(wsId);
  if (!node || liveStatus(tree, carrier, wsId) !== 'under') return null;
  return {
    coordinator: nodeOrchestrates(node),
    run: runWithin(tree, carrier, wsId),
    releaserRun: sameId(wsId, carrier) || !node.parentId ? carrier : runWithin(tree, carrier, node.parentId),
  };
}
/** The run a workspace READS its mail in (`$ORCHESTRA_RUN_ID` = `nearestOrchestratorId` over the WHOLE live chain — NOT bounded at the carrier, and a member of a plain anchor is
 *  its own standalone run): where a `reprise` row must be sent for `orchestra check` / the wake sweep to see it. Distinct from {@link runWithin}, which only GROUPS a wave for authority
 *  and `--all`. Unknown to the live tree: the run the trap recorded for it, else `fallback`. */
function envRunOf(tree: LiveTree | null, wsId: string, bilanRun: string | null, fallback: string): string {
  const n = tree?.get(wsId);
  if (tree && n) return nearestOrchestratorId(n, (id) => tree.get(id));
  return bilanRun ?? fallback;
}
/** The run `startId` belongs to INSIDE the carrier's wave: the nearest orchestrator at or above it, never above the carrier — and the CARRIER itself when none is found
 *  (a plain run-anchoring carrier, #221, is no orchestrator on the live tree: `nearestOrchestratorId` would call each member its own standalone run). */
function runWithin(tree: LiveTree, carrier: string, startId: string): string {
  for (const id of liveChain(tree, startId)) {
    const n = tree.get(id);
    if (n && nodeOrchestrates(n)) return n.id;
    if (sameId(id, carrier)) break;
  }
  return carrier;
}

// ─── carrier columns ─────────────────────────────────────────────────────────

interface RawCarrier {
  paused_at: number | null;
  paused_by: string | null;
  pause_mode: string | null;
  pause_deadline_at: number | null;
  pause_escalated_at: number | null;
  pause_trap_at: number | null;
  resume_started_at: number | null;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The pause columns of a carrier `runs` row, or null when the run has no row. */
export function readCarrierColumns(db: BusDb, runId: string): (CarrierPauseColumns & { pausedBy: string | null }) | null {
  const r = db
    .prepare(
      `SELECT paused_at, paused_by, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at, resume_started_at
         FROM runs WHERE id = ?`,
    )
    .get(runId) as RawCarrier | undefined;
  if (!r) return null;
  return {
    pausedAt: n(r.paused_at),
    pausedBy: r.paused_by ?? null,
    mode: r.pause_mode === 'soft' || r.pause_mode === 'hard' ? (r.pause_mode as PauseMode) : r.paused_at === null ? null : 'hard',
    deadlineAt: n(r.pause_deadline_at),
    escalatedAt: n(r.pause_escalated_at),
    trapAt: n(r.pause_trap_at),
    resumeStartedAt: n(r.resume_started_at),
  };
}

/** THE column list of "back to ACTIVE" (the whole machine, incl. the wave-E columns) — one copy for the raw lift and for the Reprise's close. */
const ACTIVE_SET =
  'paused_at = NULL, paused_by = NULL, pause_mode = NULL, pause_trap_at = NULL, pause_deadline_at = NULL, pause_escalated_at = NULL, resume_started_at = NULL, pause_auto = NULL';

/** Back to ACTIVE: every pause column NULL. `pause_records` / `pause_members` history is kept. */
export function clearPauseColumns(db: BusDb, runId: string): void {
  db.prepare(`UPDATE runs SET ${ACTIVE_SET} WHERE id = ?`).run(runId);
}

// ─── roster (`pause_members`) ────────────────────────────────────────────────

interface RawMember {
  run_id: string;
  paused_at: number;
  ws_id: string;
  role: string;
  member_run: string | null;
  pause_confirmed_at: number | null;
  pause_confirm_via: string | null;
  released_at: number | null;
  released_by: string | null;
  reprise_confirmed_at: number | null;
}

function toMember(r: RawMember): PauseMemberRow {
  return {
    runId: r.run_id,
    pausedAt: Number(r.paused_at),
    wsId: r.ws_id,
    role: r.role === 'coordinator' ? 'coordinator' : 'worker',
    memberRun: r.member_run ?? null,
    pauseConfirmedAt: n(r.pause_confirmed_at),
    pauseConfirmVia: (r.pause_confirm_via as PauseConfirmVia | null) ?? null,
    releasedAt: n(r.released_at),
    releasedBy: r.released_by ?? null,
    repriseConfirmedAt: n(r.reprise_confirmed_at),
  };
}

/** The roster of ONE pause epoch (carrier + `paused_at`), in insertion order. */
export function readRoster(db: BusDb, carrierRunId: string, pausedAt: number): PauseMemberRow[] {
  return (
    db
      .prepare('SELECT * FROM pause_members WHERE run_id = ? AND paused_at = ? ORDER BY rowid')
      .all(carrierRunId, pausedAt) as RawMember[]
  ).map(toMember);
}

/** Upsert a roster member by whoever writes first (the host, the CLI, the Pause douce). An existing row keeps its accusés and its role; a missing `member_run` is filled.
 *  `force` = the LIVE tree decided (review M3): the role is set to `m.role` in BOTH directions (the Pause douce enrolled it from the bus run tree, which keeps a demoted
 *  ex-orchestrator a "coordinator" and misses a run-less OPS) and a known `member_run` wins. Every branch is a NO-OP when nothing changes (`WHERE differs`): the host sweep
 *  re-seeds on every pass, and a write would re-trigger the bus-dir watcher → sweep → write (the same guard the Pause douce's enrolment carries). */
export function upsertRosterMember(
  db: BusDb,
  m: { runId: string; pausedAt: number; wsId: string; role: 'coordinator' | 'worker'; memberRun: string | null },
  force = false,
): void {
  db.prepare(
    `INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run) VALUES (?,?,?,?,?)
     ON CONFLICT(run_id, paused_at, ws_id) DO UPDATE SET ${
       force
         ? `member_run = COALESCE(excluded.member_run, pause_members.member_run), role = excluded.role
            WHERE pause_members.role IS NOT excluded.role OR pause_members.member_run IS NOT COALESCE(excluded.member_run, pause_members.member_run)`
         : `member_run = excluded.member_run
            WHERE pause_members.member_run IS NULL AND excluded.member_run IS NOT NULL`
     }`,
  ).run(m.runId, m.pausedAt, m.wsId, m.role, m.memberRun);
}

/**
 * THE GATE READ — the frozen `memberMayStart` (ledger #276 D3) applied to the carrier's CURRENT phase and `wsId`'s roster row: true ONLY for a member
 * RELEASED in the carrier's current RESUMING pause (`pausedAt` = the epoch the caller read; a different current epoch ⇒ false). Fail closed: no row,
 * not released, paused/pausing, active ⇒ false. Only reached when the carrier row says `resume_started_at` is set (two small reads, on a rare path).
 */
export function releasedWhileResuming(db: BusDb, carrierRunId: string, pausedAt: number, wsId: string): boolean {
  const cols = readCarrierColumns(db, carrierRunId);
  if (!cols || cols.pausedAt !== pausedAt) return false;
  const row = db.prepare('SELECT released_at FROM pause_members WHERE run_id = ? AND paused_at = ? AND ws_id = ?').get(carrierRunId, pausedAt, wsId) as
    | { released_at: number | null }
    | undefined;
  return pausePhaseOf(cols) === 'resuming' && memberMayStart('resuming', row ? { releasedAt: n(row.released_at) } : null);
}

// ─── Bilan reads (raw — see the LEAF note above) ─────────────────────────────

interface RawBilan {
  paused_at: number;
  ws_id: string;
  activity: string | null;
  snapshot_ref: string | null;
  dirty: number | null;
  killed_json: string | null;
  error: string | null;
}

interface BilanRec extends BilanLike {
  wsId: string;
  memberRun: string | null;
}

function parseJson<T>(s: string | null): T | null {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** The newest Bilan row per member of one pause epoch (the trap may write a retry's row — newest wins, like `bilanForMember`). */
function readBilanRecs(db: BusDb, carrierRunId: string, pausedAt: number): BilanRec[] {
  const rows = db
    .prepare('SELECT * FROM pause_records WHERE run_id = ? AND paused_at = ? ORDER BY id')
    .all(carrierRunId, pausedAt) as RawBilan[];
  const byWs = new Map<string, BilanRec>();
  for (const r of rows) {
    if (r.ws_id === PAUSE_ORIGIN_WS) continue;
    const activity = parseJson<NonNullable<BilanLike['activity']> & { memberRun?: string }>(r.activity);
    byWs.set(r.ws_id, {
      wsId: r.ws_id,
      memberRun: activity?.memberRun ?? null,
      activity,
      snapshotRef: r.snapshot_ref ?? null,
      dirty: r.dirty === null || r.dirty === undefined ? null : Number(r.dirty) !== 0,
      killed: parseJson<unknown>(r.killed_json),
      error: r.error ?? null,
    });
  }
  return [...byWs.values()];
}

// ─── the run tree (coordinators) ─────────────────────────────────────────────

interface RunNode {
  id: string;
  coordinator: string;
  parent: string | null;
}

/** `runs` rows for a set of run ids, preserving the caller's order (BFS = depth order for `runSubtreeIds`). */
function runNodes(db: BusDb, runIds: readonly string[]): RunNode[] {
  const q = db.prepare('SELECT id, coordinator, parent_run_id AS p FROM runs WHERE id = ?');
  const out: RunNode[] = [];
  for (const id of runIds) {
    const r = q.get(id) as { id: string; coordinator: string; p: string | null } | undefined;
    if (r) out.push({ id: r.id, coordinator: String(r.coordinator), parent: r.p ?? null });
  }
  return out;
}

/**
 * Seed the roster of one epoch. COORDINATORS (role 'coordinator', `member_run` = the run it coordinates — the Pause douce's convention; its parent run is derived on the fly): the carrier's own
 * coordinator, every LIVE orchestrator under the carrier (live tree — a re-parented or run-less OPS counts, a demoted ex-orchestrator does not), and — only for a workspace
 * the live tree does not know — the coordinators of the bus run tree. WORKERS (role 'worker', `member_run` = the run it belongs to): every Bilan member and any `extra` the
 * caller knows (the host sweep's live enumeration), their run read from the live tree when it knows them. Idempotent: rows already there keep their accusés.
 */
export function seedRoster(
  db: BusDb,
  carrierRunId: string,
  pausedAt: number,
  subtreeRunIds: readonly string[],
  extra: ReadonlyArray<{ wsId: string; runId: string }> = [],
): void {
  const tree = liveTree();
  const nodes = runNodes(db, subtreeRunIds);
  const busCoord = new Map<string, RunNode>(); // bus fallback: coordinator ws id → the run it coordinates (shallowest wins)
  for (const nd of nodes) if (!busCoord.has(nd.coordinator.toLowerCase())) busCoord.set(nd.coordinator.toLowerCase(), nd);
  // `member_run` of a COORDINATOR = the run it coordinates (the Pause douce's convention: the member's own nearest orchestrator, itself included); its parent run is derived on the fly
  const coord = (wsId: string, ownRun: string) => upsertRosterMember(db, { runId: carrierRunId, pausedAt, wsId, role: 'coordinator', memberRun: ownRun }, true);
  const worker = (wsId: string, memberRun: string | null, live: boolean) =>
    // an UNKNOWN run stays NULL (a Bilan row the observer created has no `memberRun`): never a wrong default — a later live read fills it, and until then
    // the carrier's own rule releases it and the wave filters read NULL as the carrier run
    upsertRosterMember(db, { runId: carrierRunId, pausedAt, wsId, role: 'worker', memberRun }, live);
  const done = new Set<string>();
  const carrierCoordinator = nodes.find((nd) => nd.id === carrierRunId)?.coordinator ?? carrierRunId; // the run's own coordinator, whatever the tree says
  coord(carrierCoordinator, carrierRunId);
  done.add(carrierCoordinator.toLowerCase());
  // 1. every LIVE orchestrator at/under the carrier is a coordinator — the live truth (no `runs` row needed, none believed)
  if (tree) {
    for (const id of tree.ids()) {
      if (done.has(id.toLowerCase())) continue;
      const c = classifyLive(tree, carrierRunId, id);
      if (c?.coordinator) {
        coord(id, c.run);
        done.add(id.toLowerCase());
      }
    }
  }
  // 2. the members: the live tree's run when it knows them, else the Bilan's / the caller's
  const universe = new Map<string, { id: string; run: string | null }>();
  for (const m of extra) universe.set(m.wsId.toLowerCase(), { id: m.wsId, run: m.runId }); // the LIVE enumeration first: its run is the truth the Bilan may lack
  for (const b of readBilanRecs(db, carrierRunId, pausedAt)) if (!universe.has(b.wsId.toLowerCase())) universe.set(b.wsId.toLowerCase(), { id: b.wsId, run: b.memberRun });
  for (const [key, m] of universe) {
    if (done.has(key)) continue;
    const c = tree ? classifyLive(tree, carrierRunId, m.id) : null;
    if (c) {
      worker(m.id, c.run, true); // the live tree knows it and says it is no coordinator: a `runs` row left by a demotion (or the Pause douce's bus-tree role) is overruled
      done.add(key);
      continue;
    }
    const nd = busCoord.get(key);
    // unknown to the live tree (not in it, or its chain dangles at a deleted ancestor): the bus run tree decides; a workspace on ANOTHER branch of the live tree is a plain worker
    if (nd && (!tree || liveStatus(tree, carrierRunId, m.id) === 'unknown')) coord(nd.coordinator, nd.id);
    else worker(m.id, m.run, false);
    done.add(key);
  }
  // 3. bus coordinators the live tree does not know at all (no tree registered, or a workspace gone from it) are still released — the fallback
  for (const nd of nodes) {
    const key = nd.coordinator.toLowerCase();
    if (done.has(key) || busCoord.get(key) !== nd) continue;
    if (tree && liveStatus(tree, carrierRunId, nd.coordinator) !== 'unknown') continue; // the live tree knows it and says it is NOT an orchestrator under the carrier: a `runs` row left by a demotion is not a coordinator
    coord(nd.coordinator, nd.id);
    done.add(key);
  }
}

// ─── consignes ───────────────────────────────────────────────────────────────

/** EARLIER epochs of this carrier that took `wsId` and from which it was NEVER released (a re-Pause during a Reprise opens a new epoch): what they killed must still reach
 *  the member, or it never learns those commands were killed. Newest first, at most {@link EARLIER_EPOCHS}. */
const EARLIER_EPOCHS = 5;
type EarlierEpochs = NonNullable<Parameters<typeof consigneFromBilan>[0]['earlier']>;
function earlierEpochs(db: BusDb, carrierRunId: string, wsId: string, pausedAt: number): EarlierEpochs {
  const rows = db
    .prepare('SELECT * FROM pause_records WHERE run_id = ? AND ws_id = ? AND paused_at < ? ORDER BY paused_at DESC, id DESC')
    .all(carrierRunId, wsId, pausedAt) as RawBilan[];
  const out: EarlierEpochs = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const epoch = Number(r.paused_at);
    if (seen.has(epoch)) continue; // the newest row of an epoch wins (a retry's)
    seen.add(epoch);
    const told = db.prepare('SELECT released_at FROM pause_members WHERE run_id = ? AND paused_at = ? AND ws_id = ?').get(carrierRunId, epoch, wsId) as { released_at: number | null } | undefined;
    // only an epoch that HAD a roster (a Reprise began) and never released this member: an older pause lifted WITHOUT a Reprise (every pre-wave-E pause, a plain lift)
    // has Bilan rows and no roster — it must not read as "you were never released from it"
    if (!told || told.released_at !== null) continue;
    const like: BilanLike = {
      activity: parseJson<NonNullable<BilanLike['activity']>>(r.activity),
      snapshotRef: r.snapshot_ref ?? null,
      dirty: r.dirty === null || r.dirty === undefined ? null : Number(r.dirty) !== 0,
      killed: parseJson<unknown>(r.killed_json),
      error: r.error ?? null,
    };
    out.push({ pausedAt: epoch, snapshotRef: like.snapshotRef, killed: killedCommands(like), inFlight: inFlightLines(like) });
    if (out.length >= EARLIER_EPOCHS) break;
  }
  return out;
}

function consigneFor(
  db: BusDb,
  carrierRunId: string,
  cols: { pausedAt: number; pausedBy: string | null; mode: PauseMode | null },
  row: PauseMemberRow | null,
  wsId: string,
  bilan: BilanRec | null,
): ConsigneDeReprise {
  return consigneFromBilan({
    runId: carrierRunId,
    pausedAt: cols.pausedAt,
    pausedBy: cols.pausedBy,
    mode: cols.mode,
    wsId,
    confirmedVia: row?.pauseConfirmVia ?? null,
    bilan,
    earlier: earlierEpochs(db, carrierRunId, wsId, cols.pausedAt),
  });
}

// ─── beginReprise ────────────────────────────────────────────────────────────

/**
 * THE Reprise entry (`RepriseEntry`, ledger #276 D3 — wired as `beginReprise` in src/main/bus-pause.ts). Bus only, store-less. `subtreeRunIds` =
 * `runSubtreeIds(db, carrier)` (BFS = depth order), passed in because this module is a leaf.
 *
 *  - no run row → 'no-run'; not paused → 'not-paused'; a CLI caller that is neither the carrier's coordinator nor an ancestor run's → 'refused'
 *    (HOST callers — E3's `{ host: true }` — are never refused); already resuming → 'already-resuming' (nothing is re-sent);
 *  - a carrier whose FROZEN `pause` switch is OFF (a stale column) is lifted plain, exactly as before wave E;
 *  - else: stamp `resume_started_at`, seed the roster, release the coordinators in depth order and send each ONE `reprise` row (the Bilan de pause of
 *    its wave). The run goes ACTIVE when the roster is fully released (the last `release`, or the host sweep for a roster that needs no worker).
 */
export function beginRepriseCore(
  db: BusDb,
  carrierRunId: string,
  actor: string | null,
  opts: { host?: boolean; reason?: 'manual' | 'usage_limit' } | undefined,
  subtreeRunIds: readonly string[],
  now = Date.now(),
): RepriseOutcome {
  const tx = db.transaction((): RepriseOutcome => {
    const auth = runHoldAuthority(db, carrierRunId);
    if (!auth) return 'no-run';
    if (opts?.host !== true) {
      const who = actor?.trim() ?? '';
      if (!who || ![auth.coordinator, ...auth.ancestors].some((c) => isCoordinatorHandle(c, who))) return 'refused';
    }
    const cols = readCarrierColumns(db, carrierRunId);
    if (!cols || cols.pausedAt === null) return 'not-paused';
    if (!getRun(db, carrierRunId)?.flags.pause) {
      clearPauseColumns(db, carrierRunId);
      return 'resuming';
    }
    const pausedAt = cols.pausedAt;
    const started = db
      .prepare('UPDATE runs SET resume_started_at = ? WHERE id = ? AND paused_at = ? AND resume_started_at IS NULL')
      .run(now, carrierRunId, pausedAt);
    if (started.changes !== 1) return 'already-resuming';
    seedRoster(db, carrierRunId, pausedAt, subtreeRunIds);
    releaseCoordinators(db, carrierRunId, cols, subtreeRunIds, now);
    // Closed here ONLY when the host trap FINISHED (`pause_trap_at`): then every member that existed at the trap has a Bilan row, so the roster is complete for the paused fleet
    // (a workspace that joins the tree LATER — e.g. a worker a released OPS spawns during the Reprise — is seeded BLOCKED by the host sweep and released with `release --all`). Otherwise
    // this store-less caller cannot see a live member the Bilan never recorded — the HOST sweep completes the roster from the live tree first, then
    // closes (sweepReprise); a member not listed yet is BLOCKED (fail closed), never leaked.
    if (cols.trapAt !== null) finishRepriseIfDone(db, carrierRunId);
    return 'resuming';
  });
  return tx.immediate();
}

/** The run a coordinator coordinates: live ⇒ its own workspace id (run id == anchor id); else the bus run whose coordinator it is. */
function coordinatedRun(tree: LiveTree | null, nodes: readonly RunNode[], wsId: string): string {
  const n = tree?.get(wsId);
  if (n && nodeOrchestrates(n)) return n.id;
  return nodes.find((x) => sameId(x.coordinator, wsId))?.id ?? wsId;
}

/** Release the coordinators in depth order (live chain length, else bus BFS); each gets ONE `reprise` row = its OWN Bilan + the Bilan de pause of its wave. */
function releaseCoordinators(
  db: BusDb,
  carrierRunId: string,
  cols: CarrierPauseColumns & { pausedBy: string | null },
  subtreeRunIds: readonly string[],
  now: number,
): void {
  const pausedAt = cols.pausedAt as number;
  const tree = liveTree();
  const nodes = runNodes(db, subtreeRunIds);
  const roster = readRoster(db, carrierRunId, pausedAt);
  const bilans = new Map(readBilanRecs(db, carrierRunId, pausedAt).map((b) => [b.wsId, b]));
  const coordRows = roster.filter((r) => r.role === 'coordinator');
  const depthOf = (r: PauseMemberRow): number => {
    if (tree && tree.get(r.wsId)) return liveChain(tree, r.wsId).length;
    const i = nodes.findIndex((x) => sameId(x.coordinator, r.wsId));
    return 1000 + (i < 0 ? 999 : i);
  };
  // the run whose coordinator is ABOVE `r` (the carrier for the top one): the live chain, else the bus parent run
  const parentRunOf = (r: PauseMemberRow): string => releaserRunOf(db, tree, r, carrierRunId, nodes);
  const ordered = [...coordRows].sort((x, y) => depthOf(x) - depthOf(y));
  for (const row of ordered) {
    if (row.releasedAt !== null) continue;
    const run = coordinatedRun(tree, nodes, row.wsId);
    // Its wave = the workers that belong to the run it coordinates + the coordinators it releases (its direct reports, whose releaser run is this run).
    const childCoords = coordRows.filter((c) => c !== row && sameId(parentRunOf(c), run));
    const waveRows = roster.filter(
      (r) => r.wsId.toLowerCase() !== row.wsId.toLowerCase() && ((r.role === 'worker' && sameId(r.memberRun ?? carrierRunId, run)) || childCoords.includes(r)),
    );
    const base = { pausedAt, pausedBy: cols.pausedBy, mode: cols.mode };
    const body = renderCoordinatorReprise({
      runId: run,
      carrierRunId,
      pausedAt,
      pausedBy: cols.pausedBy,
      mode: cols.mode,
      wave: waveRows.map((r) => consigneFor(db, carrierRunId, base, r, r.wsId, bilans.get(r.wsId) ?? null)),
      coordinators: childCoords.map((c) => c.wsId),
      self: consigneFor(db, carrierRunId, base, row, row.wsId, bilans.get(row.wsId) ?? null),
    });
    db.prepare(
      `UPDATE pause_members SET released_at = ?, released_by = 'host' WHERE run_id = ? AND paused_at = ? AND ws_id = ? AND released_at IS NULL`,
    ).run(now, carrierRunId, pausedAt, row.wsId);
    send(db, { runId: envRunOf(tree, row.wsId, bilans.get(row.wsId)?.memberRun ?? null, run), sender: HOST_SENDER, kind: 'reprise', recipient: row.wsId, body });
  }
}

/** ACTIVE again once EVERY roster member is released: all pause columns back to NULL. An EMPTY roster counts as released (nobody to wait for).
 *  Returns whether the run went active. ONE lock: the count and the clear cannot straddle a re-Pause (`revertResumeToPaused`), and the clear is guarded on
 *  the epoch + the `resuming` phase. */
export function finishRepriseIfDone(db: BusDb, carrierRunId: string): boolean {
  const tx = db.transaction((): boolean => {
    const cols = readCarrierColumns(db, carrierRunId);
    if (!cols || cols.pausedAt === null || cols.resumeStartedAt === null) return false;
    const left = db
      .prepare('SELECT COUNT(*) AS c FROM pause_members WHERE run_id = ? AND paused_at = ? AND released_at IS NULL')
      .get(carrierRunId, cols.pausedAt) as { c: number };
    if (Number(left.c) > 0) return false;
    const info = db.prepare(`UPDATE runs SET ${ACTIVE_SET} WHERE id = ? AND paused_at = ? AND resume_started_at IS NOT NULL`).run(carrierRunId, cols.pausedAt);
    return info.changes === 1;
  });
  return tx.immediate();
}

/**
 * A NEW `run pause` while RESUMING: back to PAUSED, but in a NEW EPOCH (`paused_at` = now, > the old one) owned by the re-pauser — NOT the same epoch.
 * Why (pre-review BLOCKING, ledger "what changed" to D3): the old epoch's Bilan rows read "fully trapped" (`killed_json` set), so a re-owed trap on the SAME epoch
 * would skip every member (`trapMember` returns 'complete') — no snapshot, no interrupt, no kill — while released members run on and re-accumulate work. A new
 * epoch has no Bilan rows, so the host trap really runs again (fresh snapshots, interrupt, kill), the roster starts empty (nothing stays released, no stale
 * accusé), and a stale `pause_auto` cannot let an auto Reprise override a human's Pause (D6). The old epoch's rows stay as history.
 */
export function revertResumeToPaused(
  db: BusDb,
  carrierRunId: string,
  actor: string,
  now = Date.now(),
  /** `mode` / `deadlineAt`: the Pause douce (#254) re-pausing with its own verb (a 'soft' epoch carries `paused_at + SOFT_PAUSE_DEADLINE_MS`); default = a hard pause.
   *  `auto`: the auto-pause track (#256) re-pausing on a usage-limit stop — it writes its epoch-bound `pause_auto` in the SAME statement (no window with a NULL one); default = a manual pause. */
  opts?: { mode?: PauseMode; deadlineAt?: (epoch: number) => number | null; auto?: (epoch: number) => string | null },
): boolean {
  const tx = db.transaction((): boolean => {
    const cols = readCarrierColumns(db, carrierRunId);
    if (!cols || cols.pausedAt === null || cols.resumeStartedAt === null) return false;
    const epoch = Math.max(now, cols.pausedAt + 1); // never the old key, even if the clock stepped back (pause_members is keyed on the epoch)
    const info = db
      .prepare(
        `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = NULL, pause_deadline_at = ?, pause_escalated_at = NULL,
                         resume_started_at = NULL, pause_auto = ?
          WHERE id = ? AND paused_at = ? AND resume_started_at IS NOT NULL`,
      )
      .run(epoch, actor, opts?.mode ?? 'hard', opts?.deadlineAt?.(epoch) ?? null, opts?.auto?.(epoch) ?? null, carrierRunId, cols.pausedAt);
    return info.changes === 1;
  });
  return tx.immediate();
}

/** The RESUMING carrier that governs `runId`: the first of `liveChain` (live workspace-tree ids, self first — the store-less verbs' walk) and then the
 *  bus's `parent_run_id` chain whose run row is itself RESUMING. Null = not under a Reprise. */
export function resumingCarrierFor(db: BusDb, runId: string, liveChain: readonly string[] = []): string | null {
  const parent = db.prepare('SELECT parent_run_id AS p FROM runs WHERE id = ?');
  const busChain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = runId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    busChain.push(cur);
    cur = ((parent.get(cur) as { p: string | null } | undefined)?.p ?? null) as string | null;
  }
  for (const id of [...liveChain, ...busChain]) {
    const c = readCarrierColumns(db, id);
    if (c && c.pausedAt !== null && c.resumeStartedAt !== null) return id;
  }
  return null;
}

// ─── release (`orchestra run release`) ───────────────────────────────────────

export interface ReleaseResult {
  /** Why nothing was done at the carrier level (not resuming…), else null. */
  error: 'no-run' | 'not-paused' | 'not-resuming' | null;
  phase: PausePhase | null;
  released: string[];
  already: string[];
  /** Targets the actor may not release (named, with who may). */
  refused: Array<{ wsId: string; mayBe: string[] }>;
  /** `--all` only: members the actor MAY release (an ancestor coordinator) but that belong to a run BELOW its own — `--all` leaves them to their own OPS; an explicit id releases them. */
  below: string[];
  /** Targets that match no roster member. */
  unknown: string[];
  /** The run went ACTIVE as a result of this call. */
  finished: boolean;
}

/** Who may release a member: the orchestrators ABOVE it on the LIVE tree (its own run's coordinator and every ancestor run's — the same walk the gate and the trap use) PLUS the
 *  carrier's own authority (whoever may pause/resume the run may release anyone in it: a plain run-anchoring carrier is no orchestrator, a member may have been re-parented out of the
 *  live subtree, the carrier's workspace may be gone from the store — review: no topology may leave a member nobody can release). For a workspace the live tree does not know, the bus
 *  run tree too (the coordinator of its run or of an ancestor run). */
function releasers(db: BusDb, tree: LiveTree | null, row: PauseMemberRow, carrierRunId: string): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.some((o) => sameId(o, id))) out.push(id);
  };
  const chain = tree && tree.get(row.wsId) ? liveChainInfo(tree, row.wsId) : null;
  if (chain && tree) {
    for (const id of chain.ids.slice(1)) {
      const n = tree.get(id);
      if (n && nodeOrchestrates(n)) add(id);
    }
  }
  if (!chain || chain.dangling) {
    // the live tree cannot say what lies above (unknown workspace, or a chain cut at a deleted ancestor): the bus run tree is the only evidence left, like the gate's own fallback
    const auth = runHoldAuthority(db, row.memberRun ?? carrierRunId);
    if (auth) [auth.coordinator, ...auth.ancestors].forEach(add);
  }
  const carrierAuth = runHoldAuthority(db, carrierRunId);
  if (carrierAuth) [carrierAuth.coordinator, ...carrierAuth.ancestors].forEach(add);
  return out;
}

/** The run `row` is released FROM (the coordinator above it): a worker's own run; a coordinator's parent run (live chain, else the bus parent run, else the carrier). */
function releaserRunOf(db: BusDb, tree: LiveTree | null, row: PauseMemberRow, carrierRunId: string, nodes?: readonly RunNode[]): string {
  if (row.role !== 'coordinator') return row.memberRun ?? carrierRunId;
  const live = tree ? classifyLive(tree, carrierRunId, row.wsId) : null;
  if (live) return live.releaserRun;
  const nd =
    nodes?.find((x) => sameId(x.coordinator, row.wsId)) ??
    (() => {
      const r = db.prepare('SELECT id, parent_run_id AS p FROM runs WHERE lower(coordinator) = lower(?) ORDER BY rowid LIMIT 1').get(row.wsId) as { id: string; p: string | null } | undefined;
      return r ? { id: r.id, parent: r.p } : undefined;
    })();
  return nd && nd.id !== carrierRunId && nd.parent ? nd.parent : carrierRunId;
}

/** The runs `actor` coordinates (what `--all` is limited to): its own live run when it orchestrates, and the bus runs it coordinates — the CARRIER's run included, so the coordinator of a
 *  plain run-anchoring carrier (no orchestrator on the live tree, #221) still owns the members `runWithin` assigns to the carrier. */
function ownRuns(db: BusDb, tree: LiveTree | null, actor: string): string[] {
  const out: string[] = [];
  const n = tree?.get(actor);
  if (n && nodeOrchestrates(n)) out.push(n.id);
  for (const r of db.prepare('SELECT id FROM runs WHERE lower(coordinator) = lower(?)').all(actor) as Array<{ id: string }>) out.push(r.id);
  return out;
}

/**
 * `orchestra run release <ws>… | --all`: open the gate for members and send each its Consigne de reprise (built from ITS Bilan row). The caller must coordinate
 * the member's run or an ancestor run (live tree). An EXPLICIT id releases any member the caller may; `--all` releases only the members of the caller's OWN run — a worker of
 * a run below it (another OPS's wave) is left to its own OPS and reported as `below` (review M1: the LEAD's `--all` must not dispatch every OPS's workers). `targets` are roster
 * ws ids (exact) or unique prefixes.
 */
export function releaseMembers(
  db: BusDb,
  carrierRunId: string,
  actor: string,
  targets: readonly string[] | 'all',
  now = Date.now(),
): ReleaseResult {
  const tx = db.transaction((): ReleaseResult => {
    const res: ReleaseResult = { error: null, phase: null, released: [], already: [], refused: [], below: [], unknown: [], finished: false };
    const cols = readCarrierColumns(db, carrierRunId);
    if (!cols) return { ...res, error: 'no-run' };
    res.phase = pausePhaseOf(cols);
    if (cols.pausedAt === null) return { ...res, error: 'not-paused' };
    if (cols.resumeStartedAt === null) return { ...res, error: 'not-resuming' };
    const pausedAt = cols.pausedAt;
    const roster = readRoster(db, carrierRunId, pausedAt);
    let rows: PauseMemberRow[];
    if (targets === 'all') {
      rows = roster;
    } else {
      rows = [];
      for (const t of targets) {
        const key = t.trim().toLowerCase();
        const exact = roster.filter((r) => r.wsId.toLowerCase() === key);
        const hit = exact.length ? exact : key.length >= 6 ? roster.filter((r) => r.wsId.toLowerCase().startsWith(key)) : [];
        if (hit.length === 1) rows.push(hit[0]);
        else res.unknown.push(t);
      }
    }
    const bilans = new Map(readBilanRecs(db, carrierRunId, pausedAt).map((b) => [b.wsId, b]));
    const tree = liveTree();
    const mine = targets === 'all' ? ownRuns(db, tree, actor) : [];
    for (const row of rows) {
      if (row.releasedAt !== null) {
        if (targets !== 'all') res.already.push(row.wsId);
        continue;
      }
      const may = releasers(db, tree, row, carrierRunId);
      if (!may.some((c) => isCoordinatorHandle(c, actor))) {
        res.refused.push({ wsId: row.wsId, mayBe: may });
        continue;
      }
      if (targets === 'all' && !mine.some((r) => sameId(r, releaserRunOf(db, tree, row, carrierRunId)))) {
        res.below.push(row.wsId); // allowed by ancestry, but another OPS's wave: --all leaves it to that OPS (or an explicit id)
        continue;
      }
      const upd = db
        .prepare('UPDATE pause_members SET released_at = ?, released_by = ? WHERE run_id = ? AND paused_at = ? AND ws_id = ? AND released_at IS NULL')
        .run(now, actor, carrierRunId, pausedAt, row.wsId);
      if (upd.changes !== 1) continue;
      const body = renderConsigne(consigneFor(db, carrierRunId, { pausedAt, pausedBy: cols.pausedBy, mode: cols.mode }, row, row.wsId, bilans.get(row.wsId) ?? null), { releasedBy: actor });
      send(db, { runId: envRunOf(tree, row.wsId, bilans.get(row.wsId)?.memberRun ?? null, row.memberRun ?? carrierRunId), sender: actor, kind: 'reprise', recipient: row.wsId, body });
      res.released.push(row.wsId);
    }
    // Closed here ONLY when the host trap finished (the roster is then complete — same rule as beginRepriseCore); else the host sweep seeds the live
    // members the Bilan never saw (BLOCKED) and closes it: a member not listed yet must not be un-gated by someone else's last release.
    res.finished = cols.trapAt !== null ? finishRepriseIfDone(db, carrierRunId) : false;
    return res;
  });
  return tx.immediate();
}

// ─── reprise accusé (`orchestra run confirm reprise`) ────────────────────────

export interface ConfirmRepriseResult {
  /** Carriers whose roster now records this member's accusé. */
  confirmed: Array<{ runId: string; pausedAt: number }>;
  /** Carriers where the member is rostered but NOT released yet (its coordinator has not dispatched it). */
  notReleased: Array<{ runId: string; pausedAt: number }>;
  /** Already confirmed earlier (idempotent). */
  already: Array<{ runId: string; pausedAt: number }>;
}

/**
 * The member's reprise accusé: for EVERY carrier whose newest roster epoch includes this workspace and RELEASED it, stamp
 * `reprise_confirmed_at`. Keyed by the workspace id, not a live-tree walk: it must also work AFTER the run went active (the last worker
 * confirms once its coordinator released it). Tracking only — never gates anything.
 */
export function confirmReprise(db: BusDb, wsId: string, now = Date.now()): ConfirmRepriseResult {
  const tx = db.transaction((): ConfirmRepriseResult => {
    const out: ConfirmRepriseResult = { confirmed: [], notReleased: [], already: [] };
    const latest = db
      .prepare('SELECT run_id, MAX(paused_at) AS paused_at FROM pause_members WHERE lower(ws_id) = lower(?) GROUP BY run_id')
      .all(wsId.trim()) as Array<{ run_id: string; paused_at: number }>;
    for (const l of latest) {
      const row = db
        .prepare('SELECT * FROM pause_members WHERE run_id = ? AND paused_at = ? AND lower(ws_id) = lower(?)')
        .get(l.run_id, l.paused_at, wsId.trim()) as RawMember | undefined;
      if (!row) continue;
      const ref = { runId: l.run_id, pausedAt: Number(l.paused_at) };
      if (row.released_at === null) out.notReleased.push(ref);
      else if (row.reprise_confirmed_at !== null) out.already.push(ref);
      else {
        db.prepare('UPDATE pause_members SET reprise_confirmed_at = ? WHERE run_id = ? AND paused_at = ? AND ws_id = ?').run(now, l.run_id, l.paused_at, row.ws_id);
        out.confirmed.push(ref);
      }
    }
    return out;
  });
  return tx.immediate();
}

// ─── bus-status ──────────────────────────────────────────────────────────────

/** What `orchestra bus-status` prints for `runId` (its own run or an ancestor's carrier): "N/M repris — manquent : …". Null = no Reprise to report. */
export function repriseStatusView(db: BusDb, runId: string): RepriseStatusView | null {
  const chain: string[] = [];
  const seen = new Set<string>();
  const parent = db.prepare('SELECT parent_run_id AS p FROM runs WHERE id = ?');
  let cur: string | null = runId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = ((parent.get(cur) as { p: string | null } | undefined)?.p ?? null) as string | null;
  }
  for (const id of chain) {
    const cols = readCarrierColumns(db, id);
    if (!cols) continue;
    let pausedAt: number;
    let phase: 'resuming' | 'active';
    if (cols.pausedAt !== null) {
      if (pausePhaseOf(cols) !== 'resuming') continue;
      pausedAt = cols.pausedAt;
      phase = 'resuming';
    } else {
      const last = db.prepare('SELECT MAX(paused_at) AS m FROM pause_members WHERE run_id = ?').get(id) as { m: number | null };
      if (last.m === null || last.m === undefined) continue;
      pausedAt = Number(last.m);
      phase = 'active';
    }
    const rows = readRoster(db, id, pausedAt);
    if (rows.length === 0) continue;
    if (phase === 'active' && !rows.some((r) => r.releasedAt !== null)) continue; // an old pause that never reached a Reprise
    // a forgotten accusé (an archived / deleted / sandbox member that will never send one) stops nagging a day after the last release
    if (phase === 'active' && Math.max(...rows.map((r) => r.releasedAt ?? 0)) < Date.now() - REPRISE_TRACKING_TTL_MS) continue;
    const sum = pauseRosterSummary('resuming', rows);
    if (phase === 'active' && sum.missing.length === 0) continue; // fully accused: nothing to chase
    return {
      carrier: id,
      pausedAt,
      phase,
      total: sum.total,
      released: rows.filter((r) => r.releasedAt !== null).length,
      done: sum.done,
      missing: sum.missing,
      blocked: phase === 'resuming' ? rows.filter((r) => r.releasedAt === null).map((r) => r.wsId) : [],
    };
  }
  return null;
}

// ─── host sweep (the app, store known) ───────────────────────────────────────

export interface RepriseSweepDeps {
  getBus: () => BusDb | null;
  /** The trap's own live-tree enumeration (`TrapDeps.members`). */
  members: (runIds: string[], carrierRunId: string) => Array<{ wsId: string; runId: string }>;
  /** `runSubtreeIds` (bus-pause.ts) — injected: this module is a leaf. */
  subtree: (db: BusDb, rootRunId: string) => string[];
  /** The store is loaded from disk (an unloaded store reads as "no members" — never complete a roster over it). */
  storeReady?: () => boolean;
  warn?: (msg: string, err?: unknown) => void;
}

/**
 * One host pass over every RESUMING carrier: complete its roster from the LIVE workspace tree (a member the Bilan never saw — the trap had not
 * reached it, or it joined the tree — would otherwise stay blocked with no roster row for its coordinator to release), then close the Reprise
 * when the roster is fully released. Idempotent; a no-op for a switch-OFF run (only ever resuming when the switch was ON). Returns the carriers
 * that went ACTIVE.
 */
export function sweepReprise(deps: RepriseSweepDeps): string[] {
  const db = deps.getBus();
  if (!db) return [];
  const done: string[] = [];
  let carriers: Array<{ id: string; paused_at: number }>;
  try {
    carriers = db.prepare('SELECT id, paused_at FROM runs WHERE paused_at IS NOT NULL AND resume_started_at IS NOT NULL').all() as Array<{ id: string; paused_at: number }>;
  } catch (e) {
    deps.warn?.('reprise sweep: could not read resuming carriers', e);
    return [];
  }
  for (const c of carriers) {
    try {
      const subtree = deps.subtree(db, c.id);
      if (!deps.storeReady || deps.storeReady()) {
        const members = deps.members(subtree, c.id);
        db.transaction(() => {
          // re-read INSIDE the lock: the last `release` may have closed this epoch since the SELECT — never seed a finished one
          const cur = readCarrierColumns(db, c.id);
          if (cur && cur.pausedAt === Number(c.paused_at) && cur.resumeStartedAt !== null) seedRoster(db, c.id, Number(c.paused_at), subtree, members);
        }).immediate();
      }
      if (finishRepriseIfDone(db, c.id)) done.push(c.id);
    } catch (e) {
      deps.warn?.(`reprise sweep: carrier ${c.id} failed`, e);
    }
  }
  return done;
}
