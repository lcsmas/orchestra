// Fleet PAUSE — the HOST TRAP (#252 D1b, ADR 0003, ledger #261 D5/D4). When a run becomes
// HARD-paused (`runs.paused_at` set by `orchestra run pause --hard`, which writes the bus
// directly), the host reacts for EVERY member of the run and its descendant runs:
//   1. SNAPSHOT the worktree to `refs/orchestra/pause/<run>/<ws>/<ts>` (no worktree/index/branch touch)
//   2. write the Bilan de pause row (what it was doing, ref, dirty, commands killed, error)
//   3. INTERRUPT the running turn (never stop the CLI session or the keeper)
//   4. KILL the tool process trees only (identity re-read at signal time — pause-kill.ts)
//   5. STOP the member's ATTRIBUTED Docker containers (label `orchestra.ws`; never remove; #292 — pause-containers.ts)
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
import { sweepReprise } from './pause-reprise.ts';
import {
  activePauseCarriers,
  appendBilanNote,
  appendObserverKills,
  bilanForMember,
  insertBilan,
  markTrapDone,
  readPauseOrigin,
  updateBilan,
  updateBilanContainers,
  updateBilanReliquats,
  type BilanActivity,
} from './bus-pause-records.ts';
import { restartContainers, restartOwedContainers, stopAttributedContainers, type PauseDockerApi } from './pause-containers.ts';
import { hasContainerFacts, mergeContainers, mergeRestarted } from '../shared/pause-containers.ts';
import { carrierPhase, confirmByTrap, enrollRoster, sweepSoftPauses, __resetPauseDouceForTests, type PauseOrderDeps } from './pause-douce.ts';
import type { KillReport, StopTaskResult } from './pause-kill.ts';
import type { ReliquatKillOptions } from './pause-reliquats.ts';
import { mergeReliquats, type ReliquatReport } from '../shared/pause-reliquats.ts';
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
  /** #254: the read could not tell (a tracked keeper is alive but did not answer the probe): `turnRunning` is then a guess. A Pause douce reads it as RUNNING (UNKNOWN is not NONE). */
  unknown?: boolean;
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
    opts?: { stillPaused?: () => boolean; startedBeforeMs?: number | (() => number | undefined); humanWindows?: () => Array<{ from: number; to?: number }>; spareRoots?: readonly number[]; stopTask?: (taskId: string) => Promise<StopTaskResult> },
  ): Promise<KillReport>;
  /** #282: end one of the member's background tasks through the CLI's own `stop_task` (the CLI then enqueues no task-notification turn, which a SIGTERM makes it do — a model request on a paused member).
   *  Called by the kill for each tool root that is a task, BEFORE any signal. Omitted ⇒ signals only (the old behaviour). */
  stopTask?(m: TrapMember, taskId: string): Promise<StopTaskResult>;
  /** false while the workspace store has not been loaded from disk: an empty member list then means "unknown", never "none" (review F10). */
  storeReady?(): boolean;
  /** How long a recent pause waits for the CLI to record the pausing call's process chain (ms, default 3000). */
  originWaitMs?: number;
  /** Deadline for `arm` (ms, default 15000): a hung attach must not stall the member with no retry — it is an error, the trap stays open. */
  armTimeoutMs?: number;
  /** #254 Pause douce: where a member's pause order is dropped for its tool-result hook (omitted ⇒ the bus row alone). */
  pauseOrders?: PauseOrderDeps;
  /** #254: how often a Pause douce still waiting re-checks its members' turns (ms, default {@link DOUCE_POLL_MS}); a turn ending is not a bus write. */
  douceCheckMs?: number;
  /** #325 (wave H ledger #329, FI-1 v1 of the member scope #320): kill the member's RELIQUATS — processes of its kernel scope whose ppid chain reaches no live keeper (a detached rig browser, a double-forked `env -i` daemon),
   *  which the tool-tree kill above cannot reach — AFTER the tool trees. Production: `killReliquats` of pause-reliquats.ts over `memberScopes` / `listScopeProcs`. Resolves null when the member has NO tracked scope (nothing was looked
   *  at: the Bilan stays byte-identical to before). Omitted ⇒ no step. */
  killReliquats?(m: TrapMember, opts: ReliquatKillOptions): Promise<ReliquatReport | null>;
  /** #292: the app's own Docker client (REAL socket, never a relay — `docker-api.ts`). A Pause dure stops each member's attributed containers through it, the Reprise restarts them.
   *  Omitted/null ⇒ Docker is not touched at all (and a Reprise records its owed restarts as `failed: Docker is not available to the host`). */
  containers?: PauseDockerApi | null;
  /** #292: the Docker client for ONE member — pinned to the daemon ITS relay stamps on (the keeper publishes it, `docker-api.ts` `dockerApiForMember`): the app's own resolution can have moved
   *  since the keeper started (a `docker context use`, a relaunch with another env), and Pause must query the daemon the containers were stamped on. Omitted/null ⇒ `containers`. */
  containersFor?: (wsId: string) => PauseDockerApi | null;
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
/** Interrupt outcomes after which no turn of this member is running (#282: only then is `stop_task` offered to the kill). */
const TURN_OVER: ReadonlySet<string> = new Set(['interrupted', 'attached-then-interrupted', 'idle']);

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
  // #255: once the Reprise began (`resume_started_at`) the trap touches NOTHING more — members are being released, not trapped.
  return cur !== null && cur.pausedAt === carrier.pausedAt && (cur.resumeStartedAt ?? null) === null;
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
    if (prior.snapshotIncomplete) activity.snapshotIncomplete = prior.snapshotIncomplete;
    if (prior.skippedLargeCount !== undefined) activity.skippedLargeCount = prior.skippedLargeCount;
    if (prior.snapshotNotes) activity.snapshotNotes = prior.snapshotNotes;
    if (prior.snapshotWarnings) activity.snapshotWarnings = prior.snapshotWarnings;
    if (prior.submodules) activity.submodules = prior.submodules;
    if (prior.interruptDeferrals) activity.interruptDeferrals = prior.interruptDeferrals;
    // a pauser an earlier attempt proved stays on the row through the provisional write (an app death before the final write must not lose it); re-derived / cleared below
    if (prior.exempt) activity.exempt = prior.exempt;
    if (prior.pauserCli) activity.pauserCli = prior.pauserCli;
    if (prior.earlierKilled) activity.earlierKilled = prior.earlierKilled;
    if (prior.containers) activity.containers = prior.containers; // #292: a retry merges BY ID — never stops a container twice
    if (prior.reliquats) activity.reliquats = prior.reliquats; // #325: what an earlier attempt killed stays listed; a retry merges BY IDENTITY
  }

  // 1. Snapshot (skipped if an earlier, interrupted trap already took one).
  let incompleteEarly = false;
  let snapshotRef = existing?.snapshotRef ?? null;
  let dirty: boolean | null = existing?.dirty ?? null;
  // a snapshot that TIMED OUT is never re-taken (each retry would wait the full timeout again before the interrupt, forever on a persistently incomplete member, and leave unreachable objects in the member's .git)
  if (!snapshotRef && prior?.snapshotIncomplete === 'timeout') errors.push('snapshot incomplete: timeout (an earlier attempt; not retried — a retry would wait the full timeout again)');
  else if (!snapshotRef) {
    if (!m.worktreePath) errors.push('snapshot: workspace has no worktree');
    else {
      try {
        const r = await deps.snapshot({ worktreePath: m.worktreePath, runId: carrier.runId, wsId: m.wsId, at: deps.now() });
        snapshotRef = r.ref;
        dirty = r.dirty;
        activity.branch = r.branch;
        activity.head = r.head;
        activity.changed = r.changed;
        if (r.skippedLarge.length > 0) { activity.skippedLarge = r.skippedLarge; activity.skippedLargeCount = r.skippedLargeCount; }
        if (r.notes.length > 0) activity.snapshotNotes = r.notes;
        if (r.warnings.length > 0) activity.snapshotWarnings = r.warnings;
        if (r.submodules.length > 0) activity.submodules = r.submodules;
      } catch (e) {
        // a TIMEOUT is its own, loud outcome: no ref, `snapshotIncomplete`, and the pause goes on (interrupt + kill follow below) — never a silent success
        if (e instanceof Error && e.name === 'SnapshotTimeoutError') activity.snapshotIncomplete = 'timeout';
        errors.push(e instanceof Error && e.name === 'SnapshotTimeoutError' ? errMsg(e) : `snapshot: ${errMsg(e)}`);
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
  let pauseCallPids: number[] = []; // #325: the pausing call's whole process chain — never signalled, not even as a Reliquat
  if (target !== null && !('error' in target)) {
    const chain = await waitForOrigin(deps, db, carrier);
    const hit = chain?.find((p) => p.pid === target.cli.pid && p.startTicks === target.cli.startTicks);
    if (chain && hit) {
      spareRoot = chain.find((p) => p.ppid === hit.pid)?.pid;
      pauseCallPids = chain.map((p) => p.pid);
    }
  }
  const pauser = spareRoot !== undefined;
  // A pauser an EARLIER attempt already PROVED stays exempt while its CLI is unreadable (round-3 F2): a probe flake must not make a proven coordinator interruptible, bounded deferral or not.
  const carriedPauser = !pauser && target !== null && 'error' in target && prior?.exempt === 'pauser' && prior.pauserCli !== undefined;
  if (carriedPauser) {
    activity.exempt = 'pauser';
    activity.pauserCli = prior!.pauserCli;
    activity.notes = [...(activity.notes ?? []), 'pauser (proved by an earlier attempt): CLI unreadable on this attempt — its turn is still NOT interrupted'];
  }
  if (pauser) {
    activity.exempt = 'pauser';
    activity.pauserCli = (target as { cli: RootRef }).cli;
    activity.notes = [...(activity.notes ?? []), `pauser: this member's CLI (pid ${(target as { cli: RootRef }).cli.pid}) is a process ancestor of the \`orchestra run pause\` call — its turn is NOT interrupted and the tool tree holding the call (root pid ${spareRoot}) is spared; its other tool trees are killed`];
  }

  // A lift while arming / probing the CLI / waiting for the origin (up to seconds): never interrupt a turn the lift just released (pre-review M7).
  if (!stillPaused(db, carrier)) return 'lifted';
  if (!pauser && !carriedPauser) {
    delete activity.exempt; // not a pauser on this attempt (proof gone / CLI replaced): never a stale label
    delete activity.pauserCli;
  }
  let killed: unknown = null;
  // 4. Interrupt — the model must stop issuing tool calls before the trees are killed. Skipped for the pauser, and for a HUMAN turn that began
  // during the trap (D9: a human prompt is allowed — never interrupted by the trap).
  // Bounded by "a human turn is in flight NOW" (round-3 F1c): a human turn that already ended shields nothing on a retry (no dep ⇒ unknown ⇒ shielded).
  const humanInFlightNow = (): boolean => (deps.humanTurnInFlight ? deps.humanTurnInFlight(m) : true);
  // re-read at EVERY signal: a human turn may start (or end) while the kill rounds run (D9). A tool root started inside a human turn's window is spared even after the turn ENDED
  // (round-3 F3i: a prompt that starts a background task and ends in seconds must not lose the task to a later round / retry); one started after the end is not.
  // an OPEN window with no human turn in flight any more (session stopped / died / interrupted before the release fired) is clamped to NOW: a dead turn shields nothing later
  const humanWindowsNow = (): Array<{ from: number; to?: number }> => humanWindowsSince(m.wsId, carrier.pausedAt).map((w) => (w.to === undefined && !humanInFlightNow() ? { ...w, to: deps.now() } : w));
  const humanAtInterrupt = lastHumanTurnStart(m.wsId);
  const humanDuringTrap = humanAtInterrupt !== undefined && humanAtInterrupt >= carrier.pausedAt && humanInFlightNow();
  const deferrals = prior?.interruptDeferrals ?? 0;
  if (pauser || carriedPauser) activity.interrupt = 'exempt';
  else if (target !== null && 'error' in target && deferrals < MAX_INTERRUPT_DEFERRALS) {
    // The pauser can only be recognised through a PROVEN CLI: a flaking probe must never interrupt it, so the interrupt waits for the retry (round-2 F2).
    // An interrupt a PREVIOUS attempt already made stays on the Bilan (pre-review r2 #3): only a never-interrupted member reads "skipped".
    if (prior?.interrupt === 'interrupted' || prior?.interrupt === 'attached-then-interrupted') activity.interrupt = prior.interrupt;
    else {
      activity.interrupt = 'skipped';
      activity.interruptDeferrals = deferrals + 1;
      activity.notes = [...(activity.notes ?? []), `CLI identity not proven on this attempt (${deferrals + 1}/${MAX_INTERRUPT_DEFERRALS}) — the interrupt is deferred to the retry (the pauser cannot be ruled out)`];
    }
  } else if (humanDuringTrap) {
    activity.interrupt = 'skipped';
    activity.notes = [...(activity.notes ?? []), 'a HUMAN prompt started a turn during the trap: that turn is allowed and was not interrupted; only processes older than it are killed'];
  } else {
    // The deferral is BOUNDED (round-3 F2): a CLI that never proves itself must not leave a turn running under a hard pause for ever.
    if (target !== null && 'error' in target) activity.notes = [...(activity.notes ?? []), `CLI still unproven after ${MAX_INTERRUPT_DEFERRALS} attempts — interrupting anyway (the pauser can no longer be ruled out)`];
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
  let attemptKills: KillReport['killed'] = [];
  if (target === null) killed = { skipped: 'no live CLI for this member' };
  else if ('error' in target) killed = null; // unproven ⇒ not complete (see above)
  else {
    try {
      // #282: through the CLI only once the member's turn is PROVABLY over (the interrupt took effect / nothing ran) and for a STRUCTURED member (keeper → CLI; a PTY agent has no SDK session to ask):
      // a foreground tool's shell carries a task id too, and stopping it under a live turn (the exempt pauser's other tool, a failed/skipped interrupt) would only continue that turn.
      // Read from THIS attempt's proven keeper, never the surface a retry carried over from an attempt that could not probe.
      const offerStop = !!deps.stopTask && target.keeperPid !== null && TURN_OVER.has(String(activity.interrupt));
      const rep = await deps.killTrees(target.cli, target.keeperPid, {
        stillPaused: () => stillPaused(db, carrier),
        humanWindows: humanWindowsNow,
        ...(spareRoot !== undefined ? { spareRoots: [spareRoot] } : {}),
        ...(offerStop ? { stopTask: (taskId: string) => deps.stopTask!(m, taskId) } : {}),
      });
      killed = rep;
      attemptKills = rep.killed;
      if (rep.aborted === 'lifted') {
        // the pause was lifted mid-kill: what WAS killed is still recorded (D11: every killed process is listed), never dropped
        updateBilan(db, rowId, { activity, killed: rep, error: errors.length ? errors.join('; ') : null });
        return 'lifted';
      }
      if (rep.killed.some((k) => k.signal !== 'stop_task' && k.via === 'root-under-cli')) trapKilledAt.set(m.wsId, deps.now()); // only a tool ROOT ended by SIGNAL can be followed by a task-notification turn (a CLI stop_task suppresses it; an orphan is no task)
      const failedStops = (rep.stopTask ?? []).filter((x) => !x.ok);
      if (failedStops.length > 0) activity.notes = [...(activity.notes ?? []), `stop_task failed for ${failedStops.map((x) => `${x.taskId} (${x.cmd.slice(0, 60)}${x.note ? `: ${x.note.slice(0, 80)}` : ''})`).join(', ')} — not confirmed: the task was ended by signal (or by the CLI's own kill landing late), so the CLI may have started a task-notification turn by itself (the turn observer interrupts it)`];
      // a tool ROOT killed by signal although `stop_task` was offered had no task link (tasks/<id>.output on its stdout — a CLI whose path differs, a Monitor-style task): if it was a background task the CLI may start a task-notification turn
      const unlinked = offerStop ? rep.killed.filter((k) => k.via === 'root-under-cli' && !(rep.stopTask ?? []).some((x) => x.pid === k.pid)) : [];
      if (unlinked.length > 0) activity.notes = [...(activity.notes ?? []), `tool root(s) ended by signal with no task link (${unlinked.slice(0, 3).map((k) => k.cmd.slice(0, 50)).join(' | ')}): if one was a background task the CLI may have started a task-notification turn by itself (the turn observer interrupts it)`];
      if (rep.cliGone) {
        // the CLI exited / was replaced (a Restart): not "0 killed, complete" — retried against the current CLI; what WAS killed stays listed (round-3 F5)
        incomplete = true;
        activity.notes = [...(activity.notes ?? []), 'the CLI changed identity during the trap (a Restart?) — its orphaned tools are not reachable by identity; the trap is retried against the current CLI'];
      }
      if (rep.error) errors.push(`kill: ${rep.error}`);
      if (rep.survivors.length > 0) errors.push(`kill: ${rep.survivors.length} tool process(es) still alive after the trap`);
    } catch (e) {
      killed = null;
      errors.push(`kill: ${errMsg(e)} — the trap stays open and is retried`);
      incomplete = true;
    }
  }
  // 5a. #325 — kill the member's RELIQUATS (ledger #329 FI-1 v1): the processes of its kernel scope whose ppid chain reaches no live keeper — a detached rig browser, a double-forked `env -i` daemon — that the tree walk above
  // (ppid / session / CLAUDE_PID) cannot reach. Under a PROVEN session only (a member with no live CLI has no keeper either: every process of its scope is a Reliquat); an unproven CLI/keeper waits for the retry. The keeper, the CLI,
  // the MCP servers and anything outside the member's scope are never signalled (`judgeReliquat`, re-read at signal time). An unreadable scope is UNKNOWN: the trap stays open and is retried. No tracked scope ⇒ null ⇒ nothing recorded.
  if (deps.killReliquats && (target === null || !('error' in target))) {
    const proven = target;
    try {
      const rep = await deps.killReliquats(m, {
        keeperPid: proven ? proven.keeperPid : null,
        cliPid: proven ? proven.cli.pid : null,
        ...(pauseCallPids.length ? { protectPids: pauseCallPids } : {}),
        stillPaused: () => stillPaused(db, carrier),
        humanWindows: humanWindowsNow,
        // write-ahead: a Reliquat that was just signalled is in the Bilan even if the app dies next (D11: every killed process is listed)
        onProgress: (r) => {
          activity.reliquats = mergeReliquats(prior?.reliquats, r);
          updateBilanReliquats(db, carrier.runId, m.wsId, carrier.pausedAt, () => activity.reliquats as ReliquatReport);
        },
      });
      if (rep) {
        activity.reliquats = mergeReliquats(prior?.reliquats, rep);
        if (rep.aborted === 'lifted') {
          updateBilan(db, rowId, { activity, killed: killed ?? null, error: errors.length ? errors.join('; ') : null }); // what WAS killed is still recorded, never dropped
          return 'lifted';
        }
        if (rep.unknown) {
          errors.push(`reliquats: ${rep.unknown} — nothing is known about the leftover processes of this scope; the trap stays open and is retried`);
          incomplete = true;
        }
        if (rep.error) errors.push(`reliquats: ${rep.error}`);
        if (rep.survivors.length > 0) errors.push(`reliquats: ${rep.survivors.length} leftover process(es) still alive after the trap`);
      }
    } catch (e) {
      errors.push(`reliquats: ${errMsg(e)} — the trap stays open and is retried`);
      incomplete = true;
    }
  }
  // 5b. #292 — stop the member's ATTRIBUTED containers (label `orchestra.ws=<ws>`, whatever the relay switch) AFTER the tool-tree kill and BEFORE the trap is stamped
  // complete. `docker stop` only (never remove/kill/pause); a `--rm` container is skipped (a stop would delete it). Docker unavailable / an API error is RECORDED
  // (`activity.containers.error`) and never blocks the trap or keeps it incomplete. Each stop is persisted at once, and `stillPaused` is re-read before every container.
  const dockerApi = deps.containersFor?.(m.wsId) ?? deps.containers ?? null;
  let dockerStepRan = false; // the step completed this attempt (listed without throwing): a stale error / empty facts an earlier attempt left on the row are superseded
  if (dockerApi) {
    let liftedDuringStop = false;
    try {
      const res = await stopAttributedContainers(dockerApi, m.wsId, {
        stillPaused: () => stillPaused(db, carrier),
        now: deps.now,
        ...(activity.containers ? { prior: activity.containers } : {}),
        onProgress: (c) => {
          activity.containers = c;
          updateBilanContainers(db, carrier.runId, m.wsId, carrier.pausedAt, (cur) => mergeContainers(cur, c) ?? c); // overlay = this call's view
        },
      });
      dockerStepRan = true;
      activity.containers = hasContainerFacts(res.containers) ? res.containers : undefined; // a member with nothing attributed keeps its Bilan row byte-identical to before
      if (!activity.containers) delete activity.containers;
      // the Reprise began while (or right after) containers were stopped: its own read of the Bilan may have run before the last stop — restart what THIS call stopped (idempotent with the Reprise's restart)
      liftedDuringStop = res.lifted || (res.stoppedNow.length > 0 && !stillPaused(db, carrier));
      if (liftedDuringStop && res.stoppedNow.length > 0) {
        const mine = res.containers.stopped.filter((e) => res.stoppedNow.includes(e.id));
        const restarted = await restartContainers(dockerApi, mine, deps.now);
        activity.containers = { ...res.containers, restarted: mergeRestarted(res.containers.restarted, restarted) };
        activity.notes = [...(activity.notes ?? []), `the Reprise began while containers were being stopped: ${mine.length} stopped by this attempt were restarted at once`];
      }
    } catch (e) {
      activity.containers = { stopped: activity.containers?.stopped ?? [], ...(activity.containers?.restarted ? { restarted: activity.containers.restarted } : {}), error: `stop: ${errMsg(e)}` };
    }
    if (liftedDuringStop) {
      // merge what a concurrent writer (the Reprise's container step) recorded meanwhile — never overwrite its `restarted` results
      const rowNow = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
      const merged = mergeContainers(rowNow?.activity?.containers, activity.containers);
      updateBilan(db, rowId, { activity: { ...activity, ...(merged ? { containers: merged } : {}) }, killed: incomplete ? null : killed, error: errors.length ? errors.join('; ') : null });
      return 'lifted';
    }
  }
  const fresh = bilanForMember(db, carrier.runId, m.wsId, carrier.pausedAt);
  // notes appended by onTurnStart while we were busy must survive this final write
  const merged: BilanActivity = {
    ...activity,
    // union, order kept: notes the turn observer appended meanwhile (fresh) AND the ones this attempt added (activity) — preferring `fresh` alone dropped the trap's own (round-3 F2 arm)
    notes: [...new Set([...(fresh?.activity?.notes ?? []), ...(activity.notes ?? [])])].slice(-50), // bounded like appendBilanNote
    ...(fresh?.activity?.observerKilled ? { observerKilled: fresh.activity.observerKilled } : {}),
    // the container progress writes (`onProgress`) and anything a concurrent Reprise recorded survive this whole-activity write
    // overlay = THIS attempt's view; a step that ran clean supersedes an earlier attempt's error even when this attempt found nothing to stop
    ...(() => {
      const c = activity.containers || fresh?.activity?.containers ? mergeContainers(fresh?.activity?.containers, activity.containers ?? (dockerStepRan ? { stopped: [] } : undefined)) : undefined;
      return hasContainerFacts(c) ? { containers: c } : {};
    })(),
  };
  // An attempt that kills but stays INCOMPLETE (the CLI vanished, a failed interrupt…) leaves `killed_json` NULL — what it killed is kept, never dropped (D11 / round-3 F5).
  if (incomplete && attemptKills.length > 0) merged.earlierKilled = [...(activity.earlierKilled ?? []), ...attemptKills.map((k) => ({ pid: k.pid, cmd: k.cmd, signal: k.signal, outcome: k.outcome, via: k.via, cwd: k.cwd, evidence: k.evidence }))].slice(-100); // bounded like observerKilled
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
  try {
    enrollRoster(db, carrier, members); // #254: every member of a hard pause / an escalated douce has a roster row (idempotent)
  } catch (e) {
    log.warn('pause-trap: could not enrol the pause roster', e);
  }
  // once per pause: a retried trap must not log (and fill the log) every attempt (round-3 F6)
  if (!warned.has(`${carrier.runId}@${carrier.pausedAt}:start`)) {
    warned.add(`${carrier.runId}@${carrier.pausedAt}:start`);
    log.info(`pause-trap: run ${carrier.runId} hard-paused at ${carrier.pausedAt} — trapping ${members.length} member(s)`);
  }
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
        else {
          n++;
          try {
            confirmByTrap(db, carrier, m, deps.now()); // #254: taken by the host = paused (a member that already confirmed keeps its own accusé)
          } catch (e) {
            log.warn(`pause-trap: could not record ${m.wsId} as trapped in the roster`, e);
          }
        }
      } catch (e) {
        failed = true;
        warnOnce(`${carrier.runId}@${carrier.pausedAt}:member:${m.wsId}:${errMsg(e)}`, `pause-trap: member ${m.wsId} failed`, e);
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
    warnOnce(`${carrier.runId}@${carrier.pausedAt}:incomplete`, `pause-trap: run ${carrier.runId}: ${incompleteN} member(s) could not be proven interrupted/killed — NOT stamping the trap done (retried with backoff up to ${PAUSE_RETRY_MAX_MS / 1000} s; later attempts are not logged)`);
    return { ...base, members: n, done: false, incomplete: incompleteN };
  }
  if (!stillPaused(db, carrier)) return { ...base, members: n, done: false, aborted: 'lifted' };
  markTrapDone(db, carrier.runId, carrier.pausedAt, deps.now());
  log.info(`pause-trap: run ${carrier.runId} trapped (${n} member(s))`);
  return { ...base, members: n, done: true };
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string, err?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  if (err !== undefined) log.warn(msg, err);
  else log.warn(msg);
}

// ── rows 29/30: a turn start observed while paused ──────────────────────────

/** One mark per HUMAN turn the moment `promptStream` YIELDS it (its start, not its enqueue — review F2): a prompt parked behind a running turn, or a
 *  second prompt typed during the first, is marked when IT starts, so neither is taken for a CLI-started turn. Single-use each; TTL bridges the hook latency. */
const humanTurnMarks = new Map<string, number[]>();
/** When a human turn last started (NOT consumed): the trap must not interrupt/kill a human turn that began during its own run. */
const humanTurnStarts = new Map<string, number>();
/** Per ws: the windows [start, end] of the HUMAN turns since the app started (last 20) — a tool ROOT started inside one is the human turn's and stays shielded after the turn ENDED (round-3 F3i). */
const humanWindows = new Map<string, Array<{ from: number; to?: number }>>();
const HUMAN_MARK_TTL_MS = 30_000;

/** Called by `promptStream` right before it yields a turn that contains a HUMAN-typed prompt. */
export function markPauseHumanTurn(wsId: string, now = Date.now()): void {
  const live = (humanTurnMarks.get(wsId) ?? []).filter((at) => now - at <= HUMAN_MARK_TTL_MS);
  live.push(now);
  humanTurnMarks.set(wsId, live);
  humanTurnStarts.set(wsId, now);
  humanWindows.set(wsId, [...(humanWindows.get(wsId) ?? []), { from: now }].slice(-20));
}

/** The human turn that was in flight ended: close its window (the last open one). Called by agent-sdk at the gate release. */
export function markPauseHumanTurnEnd(wsId: string, now = Date.now()): void {
  const ws = humanWindows.get(wsId);
  for (let i = (ws?.length ?? 0) - 1; i >= 0; i--) {
    const w = (ws as Array<{ from: number; to?: number }>)[i];
    if (w.to === undefined) {
      w.to = now;
      return;
    }
  }
}

/** The human-turn windows that STARTED at or after `since` (the pause): a turn begun before the pause was in flight at the pause and is trapped like any other. */
export function humanWindowsSince(wsId: string, since: number): Array<{ from: number; to?: number }> {
  return (humanWindows.get(wsId) ?? []).filter((w) => w.from >= since).map((w) => ({ ...w }));
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
  humanWindows.clear();
  warned.clear();
  nextAttempt.clear();
  retryCount.clear();
  trapKilledAt.clear();
  inflight.clear();
  turnTrap.clear();
  trapArming.clear();
  arming = false;
  if (douceTimer) clearTimeout(douceTimer);
  douceTimer = null;
  douceStopped = false;
  __resetPauseDouceForTests();
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
    // anchored on the pause (pre-review r2 #1): a human turn yielded BEFORE the pause, whose hook lands late, is still trapped (it was in flight at the pause)
    const humanNow = deps.humanTurnInFlight?.(m) === true && (lastHumanTurnStart(m.wsId) ?? 0) >= carrier.pausedAt;
    // follow-up R1-2: a mark made BEFORE the escalation is void after it (the M4 rule applied to the moment a douce turns hard): a human prompt typed in the waiting window
    // leaves single-use marks (one at the send, one at the yield) that would otherwise admit the first CLI-started turn after the escalation.
    const since = Math.max(carrier.pausedAt, carrier.escalatedAt ?? 0);
    const marked = consumeHumanMark(m.wsId, deps.now(), since);
    if (humanNow || marked) return 'allowed';
    // #254: a Pause douce still WAITING lets the running command finish — an unexplained turn start here is most often a keeper REATTACH mid-turn (app restart + opening the workspace), not a cron turn; the escalation's trap takes whatever still runs.
    // AFTER the human mark above: a human prompt typed in the window must spend ITS mark at its own start, or it would admit the first CLI-started turn after the escalation (follow-up R1-2).
    if (carrierPhase(db, carrier.runId) === 'pausing') return 'skipped';
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
          const rep = await deps.killTrees(target.cli, target.keeperPid, { stillPaused: () => resolveCarrier(deps, db, m) !== null, ...(deps.stopTask && target.keeperPid !== null && TURN_OVER.has(String(outcome)) ? { stopTask: (taskId: string) => deps.stopTask!(m, taskId) } : {}) });
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
            `turn started while paused (not a human prompt — e.g. the CLI's /loop or cron) at ${new Date(now).toISOString()}: interrupt=${outcome}, ${killedN} tool process(es) killed` +
              (now - (trapKilledAt.get(m.wsId) ?? Number.NEGATIVE_INFINITY) <= TASK_NOTIFICATION_WINDOW_MS
                ? ' — most likely the task-notification of a background task THIS trap just killed (the CLI sent 1 short model request before the interrupt: the pause is not quiescent for that one turn)'
                : ''),
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
    // #254: a Pause douce still waiting does NOT attach idle/mid-turn keepers — an attach mid-turn reads as a CLI-started turn and the observer would
    // interrupt the very command the douce lets finish. The escalated trap arms its members itself (and this pass re-arms them from then on).
    if (carrierPhase(db, c.runId) === 'pausing') continue;
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
/** The retry delay doubles per failed attempt (5, 10, 20, 40, 60 s): a persistently failing member (snapshot error + unresponsive keeper) must not cost a full snapshot every 5 s (round-3 F6). */
export const PAUSE_RETRY_MAX_MS = 60_000;
export function pauseRetryDelay(failedAttempts: number): number {
  return Math.min(PAUSE_RETRY_MS * 2 ** Math.max(0, failedAttempts), PAUSE_RETRY_MAX_MS);
}
const retryCount = new Map<string, number>();
/** Bounded deferrals of the pause-time interrupt while the CLI cannot be proven (the pauser cannot be ruled out) — then the interrupt runs anyway (round-3 F2). */
export const MAX_INTERRUPT_DEFERRALS = 3;
/** ws id → when the pause-time trap last killed something there (the CLI's task-notification turn for a killed background task follows within seconds — round-3 verifier MINOR). */
const trapKilledAt = new Map<string, number>();
const TASK_NOTIFICATION_WINDOW_MS = 15_000;
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
  // #254: a Pause douce first — notify/confirm/escalate (escalation makes the trap owed, read just below). The deadline timer lands the escalation AT 3 min.
  try {
    const { dueAt } = await sweepSoftPauses(deps);
    armDouceTimer(deps, dueAt);
  } catch (e) {
    log.warn('pause-trap: pause-douce sweep failed', e);
  }
  // #292: a Reprise's FIRST act — restart exactly the containers the Pause stopped, BEFORE the sweep below releases the coordinators (beginRepriseCore / sweepReprise hold them while any are owed).
  try {
    await restartOwedContainers({ getBus: deps.getBus, api: deps.containers ?? null, ...(deps.containersFor ? { apiFor: deps.containersFor } : {}), now: deps.now, warn: (m, e) => log.warn(m, e) });
  } catch (e) {
    log.warn('pause-trap: container restart step failed', e);
  }
  // #255: complete the roster of every RESUMING carrier from the live tree and close a finished Reprise. Idempotent; a switch-OFF run is never resuming.
  try {
    sweepReprise({ getBus: deps.getBus, members: (ids, carrier) => deps.members(ids, carrier), subtree: runSubtreeIds, storeReady: deps.storeReady, warn: (m, e) => log.warn(m, e) });
  } catch (e) {
    log.warn('pause-trap: reprise sweep failed', e);
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
          if (sum.done || sum.aborted === 'lifted') {
            nextAttempt.delete(key);
            retryCount.delete(key);
          } else {
            const n = retryCount.get(key) ?? 0;
            nextAttempt.set(key, deps.now() + pauseRetryDelay(n));
            retryCount.set(key, n + 1);
          }
          return sum;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return Promise.all(out);
}

let douceTimer: ReturnType<typeof setTimeout> | null = null;
/** Set by `stopPauseTrap`, cleared by `startPauseTrap`: a sweep still in flight must not re-arm the poll after the stop. */
let douceStopped = false;
/** A Pause douce still waiting re-checks its members every this long: a member's turn ENDING (quota, crash, done without confirming) is not a bus write, so no watcher would tell the host. */
export const DOUCE_POLL_MS = 3_000;
/** One-shot sweep at min(the earliest pending Pause-douce deadline, now + poll) (+ 50 ms): the escalation lands AT the deadline, a finished turn is seen within seconds. Re-armed by every sweep; null = nothing pending. */
function armDouceTimer(deps: TrapDeps, dueAt: number | null): void {
  if (douceTimer) clearTimeout(douceTimer);
  douceTimer = null;
  if (dueAt === null || douceStopped) return;
  const at = Math.min(dueAt, deps.now() + (deps.douceCheckMs ?? DOUCE_POLL_MS));
  douceTimer = setTimeout(() => {
    douceTimer = null;
    void sweepPauseTrap(deps);
  }, Math.max(0, at - deps.now()) + 50);
  douceTimer.unref?.();
}

/** Start detection (idempotent): boot drain now, a slow safety sweep, and a bus-directory watch. */
export function startPauseTrap(deps: TrapDeps): void {
  if (timer) return;
  douceStopped = false;
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
  if (douceTimer) clearTimeout(douceTimer);
  douceTimer = null;
  douceStopped = true;
  if (debounce) clearTimeout(debounce);
  debounce = null;
  watcher?.close();
  watcher = null;
  activeDeps = null;
}
