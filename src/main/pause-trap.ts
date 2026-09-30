// Fleet PAUSE — the HOST TRAP (#252 D1b, ADR 0003, ledger #261 D5/D4). When a run becomes
// HARD-paused (`runs.paused_at` set by `orchestra run pause --hard`, which writes the bus
// directly), the host reacts for EVERY member of the run and its descendant runs:
//   1. SNAPSHOT the worktree to `refs/orchestra/pause/<run>/<ws>/<ts>` (no worktree/index/branch touch)
//   2. write the Bilan de pause row (what it was doing, ref, dirty, commands killed, error)
//   3. INTERRUPT the running turn (never stop the CLI session or the keeper)
//   4. KILL the tool process trees only (identity re-read at signal time — pause-kill.ts)
// then stamps `runs.pause_trap_at`. Detected while the app is up by a bus-dir watcher + a slow
// sweep; a pause that landed while the app was down is drained by the boot sweep. Rows 29/30:
// `onTurnStart` interrupts a turn that starts on a paused member's session (CLI /loop, cron).
//
// Dependency-injected (TrapDeps) so the whole flow runs over a real bus + real git + fakes for the
// session/process layer under `node --test`; production wiring is src/main/pause-trap-host.ts.

import fs from 'node:fs';
import path from 'node:path';
import type { BusDb } from './bus.ts';
import { busPath } from './bus.ts';
import { activePauseFor, getRunPause, runSubtreeIds, runsOwingPauseTrap, type RunPauseInfo } from './bus-pause.ts';
import {
  activePauseCarriers,
  appendBilanNote,
  bilanForMember,
  insertBilan,
  markTrapDone,
  updateBilan,
  type BilanActivity,
} from './bus-pause-records.ts';
import type { KillReport } from './pause-kill.ts';
import type { SnapshotInput, SnapshotResult } from './pause-snapshot.ts';
import type { RootRef } from '../shared/pause-procs.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { log } from './logger.ts';

export interface TrapMember {
  wsId: string;
  /** The member's OWN run (its nearest orchestrator). */
  runId: string;
  worktreePath: string | null;
  /** Sandbox/remote member: its worktree and processes live in a container — the host trap does not apply. */
  remote: boolean;
  status: string | null;
  lastTask: string | null;
  /** Live `parentId` chain, self first: a pause carried by ANY of these covers the member (`parent_run_id` is write-once,
   *  so `runId` alone misses a workspace re-parented after its run row was written). Optional: tests/older callers omit it. */
  chain?: readonly string[];
}

export interface MemberActivity {
  surface: 'sdk' | 'pty' | 'none';
  turnRunning: boolean;
  inFlightTools: NonNullable<BilanActivity['inFlightTools']>;
  bgTasks: NonNullable<BilanActivity['bgTasks']>;
}

export type InterruptOutcome = NonNullable<BilanActivity['interrupt']>;

export interface TrapDeps {
  getBus(): BusDb | null;
  now(): number;
  /** Non-archived workspaces covered by the pause = the SAME scope as D1a's gate: the carrier's anchor workspace is an
   *  ancestor-or-self on the LIVE store `parentId` chain ({@link liveChainIncludes}); `runIds` (the `parent_run_id` closure,
   *  write-once and so stale for a re-parented workspace) is only the fallback when the chain dangles. */
  members(runIds: readonly string[], carrierRunId: string): TrapMember[];
  /** The pause carrier governing `m` right now through the live tree (production: D1a's `pausedCarrierForWorkspace`, the
   *  gate's own decision). Omitted ⇒ the bus-level walk over `[m.runId, ...m.chain]`. */
  carrierFor?(m: TrapMember): RunPauseInfo | null;
  /** Read-only: what the member is doing — called BEFORE any interrupt/kill. */
  activityOf(m: TrapMember): Promise<MemberActivity>;
  /** Interrupt the running turn. Never stops the session/keeper. */
  interrupt(m: TrapMember): Promise<InterruptOutcome>;
  /** The verified CLI (+ keeper) whose tool trees may be killed, or an error/null ⇒ nothing is killed. */
  cliOf(m: TrapMember): Promise<{ cli: RootRef; keeperPid: number | null } | { error: string } | null>;
  /** Make the member's idle detached keeper OBSERVED (attach its session; starts no turn) so a CLI-started turn during the
   *  pause reaches `onTurnStart`. Never starts/kills anything. Omitted ⇒ no re-arming. */
  arm?(m: TrapMember): Promise<void>;
  /** Members trapped in parallel (snapshots of big worktrees must not serialize the interrupt of the last member). Default 3. */
  concurrency?: number;
  snapshot(input: SnapshotInput): Promise<SnapshotResult>;
  killTrees(cli: RootRef, keeperPid: number | null): Promise<KillReport>;
  /** Pause between the interrupt and the first kill scan (the CLI reaps its own tool child). */
  sleep(ms: number): Promise<void>;
  settleMs: number;
}

export interface TrapSummary {
  carrier: string;
  pausedAt: number;
  members: number;
  /** false = aborted (lifted mid-trap) or a member threw — `pause_trap_at` NOT stamped. */
  done: boolean;
  aborted?: 'lifted' | 'no-bus';
}

const ACTIVITY_LASTTASK_CHARS = 200;

/** Is `carrierRunId` (a run id = its anchor workspace id) `startId` itself or one of its ancestors on the LIVE `parentId` chain?
 *  `dangling` = the walk reached a parent the store no longer has — the same case D1a's gate falls back to `parent_run_id` for.
 *  Bounded by a seen-set (a malformed cycle ends). */
export function liveChainIncludes(
  startId: string,
  carrierRunId: string,
  lookup: (id: string) => { parentId?: string } | undefined,
): { includes: boolean; dangling: boolean } {
  const seen = new Set<string>();
  let cur: string | undefined = startId;
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === carrierRunId) return { includes: true, dangling: false };
    seen.add(cur);
    const node = lookup(cur);
    if (!node) return { includes: false, dangling: cur !== startId };
    cur = node.parentId;
  }
  return { includes: false, dangling: false };
}

function stillPaused(db: BusDb, carrier: RunPauseInfo): boolean {
  const cur = getRunPause(db, carrier.runId);
  return cur !== null && cur.pausedAt === carrier.pausedAt;
}

/** Trap ONE member. Every step records its own failure in the Bilan and the trap moves on. */
export async function trapMember(deps: TrapDeps, db: BusDb, carrier: RunPauseInfo, m: TrapMember): Promise<void> {
  const errors: string[] = [];
  const existing = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
  if (existing && existing.killed !== null) return; // already fully trapped (boot completion after a mid-trap quit)
  const exempt = carrier.pausedBy !== null && isCoordinatorHandle(carrier.pausedBy, m.wsId);

  if (m.remote) {
    const activity: BilanActivity = { surface: 'none', memberRun: m.runId, notes: ['sandbox/remote member — host snapshot and kill do not apply (its worktree and processes live in the container)'] };
    if (existing) updateBilan(db, existing.id, { activity, killed: { skipped: 'remote' }, error: null });
    else insertBilan(db, { runId: carrier.runId, wsId: m.wsId, pausedAt: carrier.pausedAt, activity, snapshotRef: null, dirty: null, killed: { skipped: 'remote' }, error: null }, deps.now());
    return;
  }

  // 0. What it was doing — BEFORE anything is interrupted or killed.
  let act: MemberActivity = { surface: 'none', turnRunning: false, inFlightTools: [], bgTasks: [] };
  try {
    act = await deps.activityOf(m);
  } catch (e) {
    errors.push(`activity: ${errMsg(e)}`);
  }
  const activity: BilanActivity = {
    surface: act.surface,
    memberRun: m.runId,
    ...(m.status ? { status: m.status } : {}),
    turnRunning: act.turnRunning,
    inFlightTools: act.inFlightTools,
    bgTasks: act.bgTasks,
    ...(m.lastTask ? { lastTask: m.lastTask.slice(0, ACTIVITY_LASTTASK_CHARS) } : {}),
    ...(exempt ? { exempt: 'pauser' as const } : {}),
    ...(existing?.activity?.notes ? { notes: existing.activity.notes } : {}),
  };

  // 1. Snapshot (skipped if an earlier, interrupted trap already took one).
  let snapshotRef = existing?.snapshotRef ?? null;
  let dirty: boolean | null = existing?.dirty ?? null;
  if (!snapshotRef) {
    if (!m.worktreePath) errors.push('snapshot: workspace has no worktree');
    else {
      try {
        const r = await deps.snapshot({ worktreePath: m.worktreePath, runId: carrier.runId, wsId: m.wsId, at: deps.now() });
        snapshotRef = r.ref;
        dirty = r.dirty;
        activity.branch = r.branch;
        activity.head = r.head;
        activity.changed = r.changed;
        if (r.skippedLarge.length > 0) activity.skippedLarge = r.skippedLarge;
        if (r.warnings.length > 0) activity.snapshotWarnings = r.warnings;
        if (r.submodules.length > 0) activity.submodules = r.submodules;
      } catch (e) {
        errors.push(`snapshot: ${errMsg(e)}`);
      }
    }
  }

  // 2. The provisional Bilan row: the snapshot ref is durable before anything is killed.
  const rowId = existing
    ? (updateBilan(db, existing.id, { activity, snapshotRef, dirty, error: errors.length ? errors.join('; ') : null }), existing.id)
    : insertBilan(db, { runId: carrier.runId, wsId: m.wsId, pausedAt: carrier.pausedAt, activity, snapshotRef, dirty, killed: null, error: errors.length ? errors.join('; ') : null }, deps.now());

  // A lift during the snapshot: stop before touching any process.
  if (!stillPaused(db, carrier)) return;
  // Watch the session for CLI-started turns from now on (idle keepers included — exempt members too).
  await deps.arm?.(m).catch((e) => errors.push(`arm: ${errMsg(e)}`));

  let killed: unknown = { skipped: 'exempt (pauser)' };
  if (!exempt) {
    // 3. Interrupt — the model must stop issuing tool calls before the trees are killed.
    try {
      activity.interrupt = await deps.interrupt(m);
    } catch (e) {
      activity.interrupt = 'failed';
      errors.push(`interrupt: ${errMsg(e)}`);
    }
    if (deps.settleMs > 0) await deps.sleep(deps.settleMs);
    if (!stillPaused(db, carrier)) return;
    // 4. Kill the tool trees (D4) under a VERIFIED CLI only.
    try {
      const target = await deps.cliOf(m);
      if (target === null) killed = { skipped: 'no live CLI for this member' };
      else if ('error' in target) {
        killed = { skipped: `cli identity unprovable: ${target.error}` };
        errors.push(`kill: ${target.error} — nothing killed (fail closed)`);
      } else {
        const rep = await deps.killTrees(target.cli, target.keeperPid);
        killed = rep;
        if (rep.error) errors.push(`kill: ${rep.error}`);
        if (rep.survivors.length > 0) errors.push(`kill: ${rep.survivors.length} tool process(es) still alive after the trap`);
      }
    } catch (e) {
      killed = { skipped: `kill threw: ${errMsg(e)}` };
      errors.push(`kill: ${errMsg(e)}`);
    }
  } else {
    activity.interrupt = 'exempt';
  }
  const fresh = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
  // notes appended by onTurnStart while we were busy must survive this final write
  const merged: BilanActivity = { ...activity, notes: fresh?.activity?.notes ?? activity.notes };
  if (!merged.notes?.length) delete merged.notes;
  updateBilan(db, rowId, { activity: merged, killed, error: errors.length ? errors.join('; ') : null });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run the trap for one pause carrier. Safe to call again for a half-done trap (members done are skipped). */
export async function runPauseTrap(deps: TrapDeps, carrier: RunPauseInfo): Promise<TrapSummary> {
  const db = deps.getBus();
  const base = { carrier: carrier.runId, pausedAt: carrier.pausedAt };
  if (!db) return { ...base, members: 0, done: false, aborted: 'no-bus' };
  const members = deps.members(runSubtreeIds(db, carrier.runId), carrier.runId);
  log.info(`pause-trap: run ${carrier.runId} hard-paused at ${carrier.pausedAt} — trapping ${members.length} member(s)`);
  let n = 0;
  let failed = false;
  let aborted = false;
  const queue = [...members];
  const worker = async (): Promise<void> => {
    for (;;) {
      const m = queue.shift();
      if (!m || failed || aborted) return;
      if (!stillPaused(db, carrier)) {
        aborted = true;
        return;
      }
      try {
        await trapMember(deps, db, carrier, m);
        n++;
      } catch (e) {
        failed = true;
        log.warn(`pause-trap: member ${m.wsId} failed`, e);
        try {
          appendBilanNote(db, carrier.runId, m.wsId, carrier.pausedAt, `trap failed: ${errMsg(e)}`);
        } catch {
          /* the bus itself is unwritable: the next sweep retries */
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 3, members.length)) }, () => worker()));
  if (aborted) return { ...base, members: n, done: false, aborted: 'lifted' };
  if (failed) return { ...base, members: n, done: false };
  if (!stillPaused(db, carrier)) return { ...base, members: n, done: false, aborted: 'lifted' };
  markTrapDone(db, carrier.runId, carrier.pausedAt, deps.now());
  log.info(`pause-trap: run ${carrier.runId} trapped (${n} member(s))`);
  return { ...base, members: n, done: true };
}

// ── rows 29/30: a turn start observed while paused ──────────────────────────

/** Workspaces the HUMAN just sent a prompt to: the next observed turn start is allowed (un-pauses nothing). */
const humanTurnMarks = new Map<string, number>();
const HUMAN_MARK_TTL_MS = 10_000;

/** Registered as pause-gate's human-turn observer: `sdkSend(origin 'human')` calls it once per HUMAN send, before the turn starts. */
export function markPauseHumanTurn(wsId: string, now = Date.now()): void {
  humanTurnMarks.set(wsId, now);
}

function consumeHumanMark(wsId: string, now: number): boolean {
  const at = humanTurnMarks.get(wsId);
  if (at === undefined) return false;
  humanTurnMarks.delete(wsId);
  return now - at <= HUMAN_MARK_TTL_MS;
}

export function __resetPauseTrapForTests(): void {
  humanTurnMarks.clear();
  inflight.clear();
  turnTrap.clear();
  arming = false;
}

/** Per-member CLI-started-turn handler state: one handler at a time, a burst re-runs it once after it finishes. */
const turnTrap = new Map<string, { running: boolean; again: boolean; lastNoteAt: number }>();

/**
 * A turn START was observed on `m`'s session. If the member is paused (by the gate's own live-tree decision) and the start was
 * not a HUMAN send: interrupt it, kill the tool trees it already spawned and note it in the Bilan. The pauser is NOT exempt here
 * (it is only spared the pause-time interrupt/kill of the turn that issued the pause): a CLI-started turn is "a new turn".
 * Returns what it did. Never throws.
 */
export async function onTurnStart(deps: TrapDeps, m: TrapMember): Promise<'allowed' | 'interrupted' | 'not-paused' | 'skipped'> {
  try {
    const db = deps.getBus();
    if (!db) return 'not-paused';
    let carrier: RunPauseInfo | null = null;
    if (deps.carrierFor) carrier = deps.carrierFor(m);
    else {
      for (const id of [m.runId, ...(m.chain ?? [])]) {
        carrier = activePauseFor(db, id);
        if (carrier) break;
      }
    }
    if (!carrier) return 'not-paused';
    if (consumeHumanMark(m.wsId, deps.now())) return 'allowed';
    if (m.remote) return 'skipped';
    const st = turnTrap.get(m.wsId) ?? { running: false, again: false, lastNoteAt: Number.NEGATIVE_INFINITY };
    turnTrap.set(m.wsId, st);
    if (st.running) {
      st.again = true; // a turn started while we were handling the previous one: run once more when done
      return 'skipped';
    }
    st.running = true;
    try {
      for (let round = 0; round < 3; round++) {
        st.again = false;
        const now = deps.now();
        const outcome = await deps.interrupt(m).catch((e) => `failed: ${errMsg(e)}`);
        if (deps.settleMs > 0) await deps.sleep(deps.settleMs);
        let killedN = 0;
        const target = await deps.cliOf(m).catch(() => null);
        if (target && !('error' in target)) {
          const rep = await deps.killTrees(target.cli, target.keeperPid);
          killedN = rep.killed.length;
        }
        if (now - st.lastNoteAt >= 1000) {
          st.lastNoteAt = now;
          appendBilanNote(
            db,
            carrier.runId,
            m.wsId,
            carrier.pausedAt,
            `turn started while paused (not a human prompt — e.g. the CLI's /loop or cron) at ${new Date(now).toISOString()}: interrupt=${outcome}, ${killedN} tool process(es) killed`,
          );
        }
        log.info(`pause-trap: turn started on paused member ${m.wsId} — interrupted (${outcome}), killed ${killedN}`);
        if (!st.again) break;
      }
    } finally {
      st.running = false;
    }
    return 'interrupted';
  } catch (e) {
    log.warn(`pause-trap: onTurnStart failed for ${m.wsId}`, e);
    return 'skipped';
  }
}

/** Re-arm every member of every ACTIVE pause: attach idle detached keepers so their CLI-started turns are observed.
 *  Covers "app restarted after the trap finished": nothing is owed, yet a `/loop` tick must still be caught. */
export async function armPausedMembers(deps: TrapDeps): Promise<number> {
  const db = deps.getBus();
  if (!db || !deps.arm) return 0;
  let carriers: RunPauseInfo[];
  try {
    carriers = activePauseCarriers(db);
  } catch (e) {
    log.warn('pause-trap: could not read active pauses', e);
    return 0;
  }
  let n = 0;
  for (const c of carriers) {
    for (const m of deps.members(runSubtreeIds(db, c.runId), c.runId)) {
      if (m.remote) continue;
      try {
        await deps.arm(m);
        n++;
      } catch (e) {
        log.warn(`pause-trap: could not arm ${m.wsId}`, e);
      }
    }
  }
  return n;
}

// ── detection: bus-dir watcher + slow sweep + boot drain ─────────────────────

const inflight = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let watcher: fs.FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let activeDeps: TrapDeps | null = null;

export const PAUSE_SWEEP_MS = 15_000;
export const PAUSE_WATCH_DEBOUNCE_MS = 250;

let arming = false;

/** One pass: start a trap for every carrier that owes one and is not already being trapped. */
export async function sweepPauseTrap(deps: TrapDeps): Promise<TrapSummary[]> {
  const db = deps.getBus();
  if (!db) return [];
  if (!arming && deps.arm) {
    arming = true;
    void armPausedMembers(deps).finally(() => {
      arming = false;
    });
  }
  let owing: RunPauseInfo[];
  try {
    owing = runsOwingPauseTrap(db);
  } catch (e) {
    log.warn('pause-trap: could not read owed traps', e);
    return [];
  }
  const out: Promise<TrapSummary>[] = [];
  for (const c of owing) {
    const key = `${c.runId}@${c.pausedAt}`;
    if (inflight.has(key)) continue;
    inflight.add(key);
    out.push(
      runPauseTrap(deps, c)
        .catch((e): TrapSummary => {
          log.warn(`pause-trap: trap of ${c.runId} threw`, e);
          return { carrier: c.runId, pausedAt: c.pausedAt, members: 0, done: false };
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return Promise.all(out);
}

/** Start detection (idempotent): boot drain now, a slow safety sweep, and a bus-directory watch. */
export function startPauseTrap(deps: TrapDeps): void {
  if (timer) return;
  activeDeps = deps;
  void sweepPauseTrap(deps);
  timer = setInterval(() => void sweepPauseTrap(deps), PAUSE_SWEEP_MS);
  timer.unref?.();
  const bus = busPath();
  const dir = path.dirname(bus);
  const walName = `${path.basename(bus)}-wal`;
  try {
    // The directory, not the -wal inode: SQLite recycles -wal (see bus-wake.ts armBusWalWatcher).
    watcher = fs.watch(dir, (_e, filename) => {
      if (filename !== null && filename !== walName && filename !== path.basename(bus)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (activeDeps) void sweepPauseTrap(activeDeps);
      }, PAUSE_WATCH_DEBOUNCE_MS);
      debounce.unref?.();
    });
    watcher.on('error', (e) => log.warn(`pause-trap: bus directory watch errored — sweep-only (${PAUSE_SWEEP_MS} ms)`, e));
  } catch (e) {
    log.warn('pause-trap: could not watch the bus directory — sweep-only', e);
  }
  log.info(`pause-trap: started (watch ${dir}, sweep ${PAUSE_SWEEP_MS} ms)`);
}

export function stopPauseTrap(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (debounce) clearTimeout(debounce);
  debounce = null;
  watcher?.close();
  watcher = null;
  activeDeps = null;
}
