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
  appendObserverKills,
  bilanForMember,
  insertBilan,
  markTrapDone,
  readPauseOrigin,
  updateBilan,
  type BilanActivity,
} from './bus-pause-records.ts';
import type { KillReport } from './pause-kill.ts';
import type { SnapshotInput, SnapshotResult } from './pause-snapshot.ts';
import type { RootRef } from '../shared/pause-procs.ts';
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
  /** Is the turn in flight right now one a HUMAN typed (exact, TTL-free — production: the session's gate flag)? Such a start is ALLOWED however late the hook lands (D9, round-2 F3). */
  humanTurnInFlight?(m: TrapMember): boolean;
  /** Members trapped in parallel (snapshots of big worktrees must not serialize the interrupt of the last member). Default 3. */
  concurrency?: number;
  snapshot(input: SnapshotInput): Promise<SnapshotResult>;
  killTrees(
    cli: RootRef,
    keeperPid: number | null,
    opts?: { stillPaused?: () => boolean; startedBeforeMs?: number | (() => number | undefined); spareRoots?: readonly number[] },
  ): Promise<KillReport>;
  /** false while the workspace store has not been loaded from disk: an empty member list then means "unknown", never "none" (review F10). */
  storeReady?(): boolean;
  /** How long a recent pause waits for the CLI to record the pausing call's process chain (ms, default 3000). */
  originWaitMs?: number;
  /** Deadline for `arm` (ms, default 15000): a hung attach must not stall the member with no retry — it is an error, the trap stays open. */
  armTimeoutMs?: number;
  /** Pause between the interrupt and the first kill scan (the CLI reaps its own tool child). */
  sleep(ms: number): Promise<void>;
  settleMs: number;
}

export interface TrapSummary {
  carrier: string;
  pausedAt: number;
  members: number;
  /** false = aborted (lifted mid-trap), a member threw or is INCOMPLETE — `pause_trap_at` NOT stamped (retried on the next sweep). */
  done: boolean;
  aborted?: 'lifted' | 'no-bus' | 'no-members' | 'store-not-ready';
  /** Members whose interrupt/kill could not be proven (unresponsive keeper, unprovable CLI, failed interrupt): retried, never stamped DONE. */
  incomplete?: number;
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

/** Outcome of trapping one member: `incomplete` = an interrupt/kill could not be PROVEN (retry; never stamp the trap DONE). */
export type MemberTrapOutcome = 'complete' | 'incomplete' | 'lifted';

/** Trap ONE member. Every step records its own failure in the Bilan and the trap moves on. */
export async function trapMember(deps: TrapDeps, db: BusDb, carrier: RunPauseInfo, m: TrapMember): Promise<MemberTrapOutcome> {
  const errors: string[] = [];
  const existing = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
  if (existing && existing.killed !== null) return 'complete'; // already fully trapped (boot completion after a mid-trap quit)

  if (m.remote) {
    const activity: BilanActivity = { surface: 'none', memberRun: m.runId, notes: ['sandbox/remote member — host snapshot and kill do not apply (its worktree and processes live in the container)'] };
    if (existing) updateBilan(db, existing.id, { activity, killed: { skipped: 'remote' }, error: null });
    else insertBilan(db, { runId: carrier.runId, wsId: m.wsId, pausedAt: carrier.pausedAt, activity, snapshotRef: null, dirty: null, killed: { skipped: 'remote' }, error: null }, deps.now());
    return 'complete';
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
    ...(existing?.activity?.notes ? { notes: existing.activity.notes } : {}),
  };

  // A RETRY (the row exists, trap still owed) keeps the FIRST attempt's observations: a fresh read after the interrupt says "idle", and the
  // snapshot facts (head/changed/skipped/warnings) are not re-taken — overwriting them would erase what the Bilan must disclose (pre-review M3).
  const prior = existing?.activity;
  if (prior && prior.turnRunning !== undefined) {
    activity.surface = prior.surface;
    activity.turnRunning = prior.turnRunning;
    activity.inFlightTools = prior.inFlightTools ?? [];
    activity.bgTasks = prior.bgTasks ?? [];
  }
  if (prior) {
    if (prior.branch !== undefined) activity.branch = prior.branch;
    if (prior.head !== undefined) activity.head = prior.head;
    if (prior.changed) activity.changed = prior.changed;
    if (prior.skippedLarge) activity.skippedLarge = prior.skippedLarge;
    if (prior.snapshotWarnings) activity.snapshotWarnings = prior.snapshotWarnings;
    if (prior.submodules) activity.submodules = prior.submodules;
  }

  // 1. Snapshot (skipped if an earlier, interrupted trap already took one).
  let incompleteEarly = false;
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
  // Re-read NOW: the snapshot can take seconds, and the turn observer may have appended notes/kills (or inserted the member's row) meanwhile —
  // merge them instead of overwriting, and never insert a second row for the same member.
  const cur = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
  if (cur?.activity?.notes) activity.notes = cur.activity.notes;
  if (cur?.activity?.observerKilled) activity.observerKilled = cur.activity.observerKilled;
  const rowId = cur
    ? (updateBilan(db, cur.id, { activity, snapshotRef, dirty, error: errors.length ? errors.join('; ') : (cur.error ?? null) }), cur.id) // a retry keeps the last attempt's error until its own final write
    : insertBilan(db, { runId: carrier.runId, wsId: m.wsId, pausedAt: carrier.pausedAt, activity, snapshotRef, dirty, killed: null, error: errors.length ? errors.join('; ') : null }, deps.now());

  // A lift during the snapshot: stop before touching any process.
  if (!stillPaused(db, carrier)) return 'lifted';
  // Watch the session for CLI-started turns from now on (idle keepers included — the pauser too).
  // While THIS trap arms the member, the attach's own turn-start notification is ignored by the observer (`trapArming`): the trap interrupts/kills the member itself, pauser-aware.
  trapArming.add(m.wsId);
  try {
    await withDeadline(deps.arm?.(m), deps.armTimeoutMs ?? ARM_TIMEOUT_MS, 'arm');
  } catch (e) {
    // a REJECTION is recorded and the trap goes on (as before); a HANG is unknown state: the trap stays open and is retried (pre-review M8)
    errors.push(`arm: ${errMsg(e)}${e instanceof DeadlineError ? ' — the trap stays open and is retried' : ''}`);
    if (e instanceof DeadlineError) incompleteEarly = true;
  } finally {
    trapArming.delete(m.wsId);
  }

  // 3. The verified CLI (+ keeper): needed to decide the pauser AND to kill.
  let target: Awaited<ReturnType<TrapDeps['cliOf']>> = null;
  let incomplete = incompleteEarly;
  try {
    target = await deps.cliOf(m);
  } catch (e) {
    target = { error: errMsg(e) };
  }
  if (target !== null && 'error' in target) {
    // UNKNOWN is not NONE (review F4): an unresponsive/unprovable CLI is an error that is RETRIED, never "nothing to kill".
    errors.push(`kill: ${target.error} — nothing killed yet (fail closed); the trap stays open and is retried`);
    incomplete = true;
  }

  // The PAUSER (review F5): the member whose CLI is a process ancestor of the `orchestra run pause` call — keyed on recorded process ancestry
  // (pid + start-time re-verified against the live CLI), NEVER on the `--as` handle a human also uses. Only the tool tree holding the call is spared.
  let spareRoot: number | undefined;
  if (target !== null && !('error' in target)) {
    const chain = await waitForOrigin(deps, db, carrier);
    const hit = chain?.find((p) => p.pid === target.cli.pid && p.startTicks === target.cli.startTicks);
    if (chain && hit) spareRoot = chain.find((p) => p.ppid === hit.pid)?.pid;
  }
  const pauser = spareRoot !== undefined;
  if (pauser) {
    activity.exempt = 'pauser';
    activity.notes = [...(activity.notes ?? []), `pauser: this member's CLI (pid ${(target as { cli: RootRef }).cli.pid}) is a process ancestor of the \`orchestra run pause\` call — its turn is NOT interrupted and the tool tree holding the call (root pid ${spareRoot}) is spared; its other tool trees are killed`];
  }

  // A lift while arming / probing the CLI / waiting for the origin (up to seconds): never interrupt a turn the lift just released (pre-review M7).
  if (!stillPaused(db, carrier)) return 'lifted';
  let killed: unknown = null;
  // 4. Interrupt — the model must stop issuing tool calls before the trees are killed. Skipped for the pauser, and for a HUMAN turn that began
  // during the trap (D9: a human prompt is allowed — never interrupted by the trap).
  const humanAtInterrupt = lastHumanTurnStart(m.wsId);
  const humanDuringTrap = humanAtInterrupt !== undefined && humanAtInterrupt >= carrier.pausedAt;
  if (pauser) activity.interrupt = 'exempt';
  else if (target !== null && 'error' in target) {
    // The pauser can only be recognised through a PROVEN CLI: a flaking probe must never interrupt it, so the interrupt waits for the retry (round-2 F2).
    activity.interrupt = 'skipped';
    activity.notes = [...(activity.notes ?? []), 'CLI identity not proven on this attempt — the interrupt is deferred to the retry (the pauser cannot be ruled out)'];
  } else if (humanDuringTrap) {
    activity.interrupt = 'skipped';
    activity.notes = [...(activity.notes ?? []), 'a HUMAN prompt started a turn during the trap: that turn is allowed and was not interrupted; only processes older than it are killed'];
  } else {
    try {
      activity.interrupt = await deps.interrupt(m);
      if (activity.interrupt === 'failed' || activity.interrupt === 'unresponsive') {
        errors.push(`interrupt: ${activity.interrupt} — the turn may still be running; the trap stays open and is retried`);
        incomplete = true;
      }
    } catch (e) {
      activity.interrupt = 'failed';
      errors.push(`interrupt: ${errMsg(e)} — the trap stays open and is retried`);
      incomplete = true;
    }
  }
  // a retry whose fresh interrupt reads "idle" (the turn already stopped) keeps what the first attempt actually did
  if ((prior?.interrupt === 'interrupted' || prior?.interrupt === 'attached-then-interrupted') && (activity.interrupt === 'idle' || activity.interrupt === 'no-session')) activity.interrupt = prior.interrupt;
  if (!pauser && deps.settleMs > 0) await deps.sleep(deps.settleMs);
  if (!stillPaused(db, carrier)) {
    updateBilan(db, rowId, { activity, error: errors.length ? errors.join('; ') : null }); // keep what the interrupt did
    return 'lifted';
  }

  // 5. Kill the tool trees (D4) under a VERIFIED CLI only.
  if (target === null) killed = { skipped: 'no live CLI for this member' };
  else if ('error' in target) killed = null; // unproven ⇒ not complete (see above)
  else {
    try {
      const rep = await deps.killTrees(target.cli, target.keeperPid, {
        stillPaused: () => stillPaused(db, carrier),
        // re-read at EVERY signal: a human turn may start while the kill rounds run (D9)
        startedBeforeMs: () => {
          const h = lastHumanTurnStart(m.wsId);
          return h !== undefined && h >= carrier.pausedAt ? h : undefined;
        },
        ...(spareRoot !== undefined ? { spareRoots: [spareRoot] } : {}),
      });
      killed = rep;
      if (rep.aborted === 'lifted') {
        // the pause was lifted mid-kill: what WAS killed is still recorded (D11: every killed process is listed), never dropped
        updateBilan(db, rowId, { activity, killed: rep, error: errors.length ? errors.join('; ') : null });
        return 'lifted';
      }
      if (rep.error) errors.push(`kill: ${rep.error}`);
      if (rep.survivors.length > 0) errors.push(`kill: ${rep.survivors.length} tool process(es) still alive after the trap`);
    } catch (e) {
      killed = null;
      errors.push(`kill: ${errMsg(e)} — the trap stays open and is retried`);
      incomplete = true;
    }
  }
  const fresh = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
  // notes appended by onTurnStart while we were busy must survive this final write
  const merged: BilanActivity = {
    ...activity,
    notes: fresh?.activity?.notes ?? activity.notes,
    ...(fresh?.activity?.observerKilled ? { observerKilled: fresh.activity.observerKilled } : {}),
  };
  if (!merged.notes?.length) delete merged.notes;
  // `killed` stays NULL while incomplete: NULL means "this member's trap is still owed" (the next sweep redoes interrupt + kill, not the snapshot).
  updateBilan(db, rowId, { activity: merged, killed: incomplete ? null : killed, error: errors.length ? errors.join('; ') : null });
  return incomplete ? 'incomplete' : 'complete';
}

/** The recorded process chain of the `orchestra run pause` call. A RECENT pause waits briefly for the CLI to write it (it lands within ms of the pause);
 *  an old one (boot drain) or none ⇒ null ⇒ nobody is spared. */
async function waitForOrigin(deps: TrapDeps, db: BusDb, carrier: RunPauseInfo): Promise<ReturnType<typeof readPauseOrigin>> {
  const limit = deps.originWaitMs ?? 3000;
  const start = deps.now();
  for (;;) {
    const chain = readPauseOrigin(db, carrier.runId, carrier.pausedAt);
    if (chain) return chain;
    if (carrier.pausedAt + limit < start || deps.now() - start >= limit) return null;
    await deps.sleep(100);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run the trap for one pause carrier. Safe to call again for a half-done trap (members done are skipped). */
export async function runPauseTrap(deps: TrapDeps, carrier: RunPauseInfo): Promise<TrapSummary> {
  const db = deps.getBus();
  const base = { carrier: carrier.runId, pausedAt: carrier.pausedAt };
  if (!db) return { ...base, members: 0, done: false, aborted: 'no-bus' };
  // UNKNOWN is not NONE (review F10): an unloaded store reads as "no members"; never stamp the trap DONE over it.
  if (deps.storeReady && !deps.storeReady()) {
    warnOnce(`${carrier.runId}@${carrier.pausedAt}:store`, `pause-trap: run ${carrier.runId} is paused but the workspace store is not loaded yet — trap deferred`);
    return { ...base, members: 0, done: false, aborted: 'store-not-ready' };
  }
  const members = deps.members(runSubtreeIds(db, carrier.runId), carrier.runId);
  if (members.length === 0) {
    warnOnce(`${carrier.runId}@${carrier.pausedAt}:none`, `pause-trap: run ${carrier.runId} is paused but no member workspace was found — NOT stamping the trap done (retried)`);
    return { ...base, members: 0, done: false, aborted: 'no-members' };
  }
  log.info(`pause-trap: run ${carrier.runId} hard-paused at ${carrier.pausedAt} — trapping ${members.length} member(s)`);
  let n = 0;
  let failed = false;
  let aborted = false;
  let incompleteN = 0;
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
        const out = await trapMember(deps, db, carrier, m);
        if (out === 'lifted') aborted = true;
        else if (out === 'incomplete') incompleteN++;
        else n++;
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
  if (incompleteN > 0) {
    log.warn(`pause-trap: run ${carrier.runId}: ${incompleteN} member(s) could not be proven interrupted/killed — NOT stamping the trap done (retried)`);
    return { ...base, members: n, done: false, incomplete: incompleteN };
  }
  if (!stillPaused(db, carrier)) return { ...base, members: n, done: false, aborted: 'lifted' };
  markTrapDone(db, carrier.runId, carrier.pausedAt, deps.now());
  log.info(`pause-trap: run ${carrier.runId} trapped (${n} member(s))`);
  return { ...base, members: n, done: true };
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(msg);
}

// ── rows 29/30: a turn start observed while paused ──────────────────────────

/** One mark per HUMAN turn the moment `promptStream` YIELDS it (its start, not its enqueue — review F2): a prompt parked behind a running turn, or a
 *  second prompt typed during the first, is marked when IT starts, so neither is taken for a CLI-started turn. Single-use each; TTL bridges the hook latency. */
const humanTurnMarks = new Map<string, number[]>();
/** When a human turn last started (NOT consumed): the trap must not interrupt/kill a human turn that began during its own run. */
const humanTurnStarts = new Map<string, number>();
const HUMAN_MARK_TTL_MS = 30_000;

/** Called by `promptStream` right before it yields a turn that contains a HUMAN-typed prompt. */
export function markPauseHumanTurn(wsId: string, now = Date.now()): void {
  const live = (humanTurnMarks.get(wsId) ?? []).filter((at) => now - at <= HUMAN_MARK_TTL_MS);
  live.push(now);
  humanTurnMarks.set(wsId, live);
  humanTurnStarts.set(wsId, now);
}

export function lastHumanTurnStart(wsId: string): number | undefined {
  return humanTurnStarts.get(wsId);
}

function consumeHumanMark(wsId: string, now: number, notBefore = 0): boolean {
  const marks = humanTurnMarks.get(wsId) ?? [];
  while (marks.length > 0) {
    const at = marks.shift() as number;
    // a mark from BEFORE the pause is a pre-pause human turn: it must never admit a CLI-started turn after the pause (pre-review M4)
    if (now - at <= HUMAN_MARK_TTL_MS && at >= notBefore) {
      humanTurnMarks.set(wsId, marks);
      return true;
    }
  }
  humanTurnMarks.set(wsId, marks);
  return false;
}

export function __resetPauseTrapForTests(): void {
  humanTurnMarks.clear();
  humanTurnStarts.clear();
  warned.clear();
  nextAttempt.clear();
  inflight.clear();
  turnTrap.clear();
  trapArming.clear();
  arming = false;
}

/** Members whose `arm` is running inside a member trap (their attach-fired turn start is the trap's own business). */
const trapArming = new Set<string>();
const ARM_TIMEOUT_MS = 15_000;

class DeadlineError extends Error {}

/** Await `p` (undefined ⇒ resolves at once) with a deadline; never leaves its timer behind. */
async function withDeadline(p: Promise<void> | undefined, ms: number, what: string): Promise<void> {
  if (!p) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new DeadlineError(`${what} timed out after ${ms} ms`)), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Per-member CLI-started-turn handler state: one handler at a time, a burst re-runs it once after it finishes. */
const turnTrap = new Map<string, { running: boolean; again: boolean; lastNoteAt: number }>();

/** The pause carrier governing `m` right now (the gate's own live-tree decision in production, the bus-level walk otherwise). */
function resolveCarrier(deps: TrapDeps, db: BusDb, m: TrapMember): RunPauseInfo | null {
  if (deps.carrierFor) return deps.carrierFor(m);
  for (const id of [m.runId, ...(m.chain ?? [])]) {
    const c = activePauseFor(db, id);
    if (c) return c;
  }
  return null;
}

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
    const carrier = resolveCarrier(deps, db, m);
    if (!carrier) return 'not-paused';
    if (trapArming.has(m.wsId)) return 'skipped'; // the member trap's own arm() attach fired this start: trapMember handles the turn (pauser-aware)
    // a human turn IN FLIGHT (exact) OR a fresh mark (the hook of a very short turn can land after its result); BOTH are consumed — a leftover mark must not admit a later CLI turn
    const humanNow = deps.humanTurnInFlight?.(m) === true;
    const marked = consumeHumanMark(m.wsId, deps.now(), carrier.pausedAt);
    if (humanNow || marked) return 'allowed';
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
        if (round > 0 && !resolveCarrier(deps, db, m)) break; // lifted meanwhile (review F8): never touch a turn the lift just released
        st.again = false;
        const now = deps.now();
        const outcome = await deps.interrupt(m).catch((e) => `failed: ${errMsg(e)}`);
        if (deps.settleMs > 0) await deps.sleep(deps.settleMs);
        let killedN = 0;
        const target = await deps.cliOf(m).catch(() => null);
        if (target && !('error' in target)) {
          const rep = await deps.killTrees(target.cli, target.keeperPid, { stillPaused: () => resolveCarrier(deps, db, m) !== null });
          killedN = rep.killed.length;
          appendObserverKills(db, carrier.runId, m.wsId, carrier.pausedAt, rep.killed);
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
/** Earliest next attempt per carrier after an INCOMPLETE/deferred trap (an unresponsive keeper must not be hammered on every bus write). */
const nextAttempt = new Map<string, number>();
export const PAUSE_RETRY_MS = 5_000;
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
    if ((nextAttempt.get(key) ?? 0) > deps.now()) continue;
    inflight.add(key);
    out.push(
      runPauseTrap(deps, c)
        .catch((e): TrapSummary => {
          log.warn(`pause-trap: trap of ${c.runId} threw`, e);
          return { carrier: c.runId, pausedAt: c.pausedAt, members: 0, done: false };
        })
        .then((sum) => {
          if (sum.done || sum.aborted === 'lifted') nextAttempt.delete(key);
          else nextAttempt.set(key, deps.now() + PAUSE_RETRY_MS);
          return sum;
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
