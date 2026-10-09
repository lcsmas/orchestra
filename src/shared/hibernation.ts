// Session hibernation — pure eligibility logic.
//
// Orchestra keeps every agent's process alive for the whole app run: the
// renderer's 12-pane LRU (mounted-panes.ts) unmounts React components but
// NEVER touches the backing process, and stopPty/sdkStop fire only on an
// explicit stop/delete/archive/quit. With ~19 live agents that is hundreds of
// MB of resident memory held by sessions nobody has touched in hours.
//
// Hibernation stops the PROCESS of a long-idle agent while keeping its
// conversation: the terminal path resumes with `claude --continue` on the next
// keystroke, the structured path resumes by `ws.sdkSessionId`. So this is a
// memory optimization with no user-visible loss of state — which is exactly
// why the eligibility rules must be conservative. A wrongly-hibernated agent
// is not a crash, it is a silently-killed turn, and that is far more expensive
// than the RAM it saved.
//
// This module is PURE (no Electron, no fs, no process registry) so the whole
// matrix is unit-testable; the sweeper in src/main/hibernation.ts supplies the
// live signals.

import type { Workspace } from './types.ts';
import { isFleetMember } from './admission.ts';
import { formatGb, type MemoryGuardSnapshot } from './memory-guard.ts';

/** Default idle threshold before an agent is eligible: 5 minutes. A resource
 *  lever (issue #198 D14): many live session trees hold ~700 MB each and the
 *  laptop overheats when Orchestra runs long, so idle sessions are reclaimed
 *  sooner. Resume is ~1s and lossless (conversation + queued mail survive — see
 *  the module header), so a user stepping away briefly comes back to a
 *  hibernated-but-intact session that wakes on their next keystroke. Was 30 min. */
export const DEFAULT_HIBERNATE_AFTER_MS = 5 * 60 * 1000;

/** Sentinel returned by {@link resolveHibernateAfterMs} when the feature is
 *  switched off (`ORCHESTRA_HIBERNATE_AFTER_MS=-1`). Callers must check for it
 *  explicitly — it is NOT a threshold, and comparing an idle duration against
 *  it would make every workspace instantly eligible. */
export const HIBERNATION_DISABLED = -1;

/** The live signals the sweeper samples per workspace. Passed in rather than
 *  read here so this module stays pure and the matrix stays testable. */
export interface HibernationSignals {
  /** Epoch ms — the clock, injected so tests don't race a real one. */
  now: number;
  /** Epoch ms of the workspace's last agent activity (any lifecycle event:
   *  submit/pretool/posttool/stop/notify/session). Undefined means "nothing
   *  observed this app run", which is NOT the same as "idle forever" — see the
   *  guard below. */
  lastActivityAt: number | undefined;
  /** True iff this workspace is the one the user currently has open. The active
   *  pane's process must never be killed under the user's cursor. */
  isActive: boolean;
  /** True iff an agent PTY (`<wsId>`) is live for this workspace. */
  hasLivePty: boolean;
  /** True iff a structured (SDK) session is live for this workspace. */
  hasLiveSdk: boolean;
  /** True iff a RUN-SCRIPT pty (`<wsId>:run`) is live — a dev server, a watcher,
   *  a test loop. The agent may legitimately be idle for hours while its run
   *  script does the work, and killing the agent process here would also read to
   *  the user as "my running app died". Hibernation skips these entirely. */
  hasLiveRunPty: boolean;
  /** True iff the structured session still owns a RUNNING background task (a
   *  `run_in_background` Bash / background Agent). Required, not optional: a caller
   *  that forgets it must fail tsc, not silently hibernate over a live task. */
  hasLiveBackgroundTask: boolean;
  /** Resolved idle threshold in ms, or {@link HIBERNATION_DISABLED}. */
  thresholdMs: number;
  /** Idle time on the MONOTONIC clock (ms since this member's last activity, CLOCK_MONOTONIC — immune to NTP steps / a resume's wall-clock jump). Used ONLY by the Reliquat wait (#326-fu m2): that wait guards an
   *  IRREVERSIBLE stop, so a wall-clock jump forward must not shorten it — the member must have been idle on BOTH clocks. Required, not optional: a caller that forgets it must fail tsc, not silently kill on the wall clock.
   *  NaN reads as "unknown": the Reliquat wait is then never over (fail closed). */
  monotonicIdleMs: number;
  /** True while the memory guard HOLDS Admission (`isAdmissionHolding(getMemoryGuardSnapshot())`, FI-2 — nothing else decides it). A fleet
   *  member that passes every other guard then counts as past its idle threshold (fast Veille, #288). Required: a caller that forgets it
   *  must fail tsc, not silently ignore the hold. */
  admissionHeld: boolean;
  /** Reliquats of this member alive NOW (#326: FI-1 role `reliquat` of its kernel scope; with no tracked scope, #331's orphaned headless browsers). 0 = none, or not looked at / not knowable (the sweeper
   *  then keeps today's Veille). Required: a caller that forgets it must fail tsc, not silently skip the wait. */
  liveReliquats: number;
  /** The Reliquat delay in ms (Garde mémoire setting, read hot) — how long an idle member with live Reliquats waits before its Veille. Required for the same reason. */
  reliquatDelayMs: number;
}

/** How long a member must have been idle before its Veille: the normal threshold — or, while it still has LIVE Reliquats (#326), the longer of that threshold and the Reliquat delay.
 *  A non-finite / non-positive delay adds no wait (the setting is normalised upstream; this is the belt for a caller that passes garbage). */
export function effectiveVeilleWaitMs(thresholdMs: number, liveReliquats: number, reliquatDelayMs: number): number {
  if (liveReliquats > 0 && Number.isFinite(reliquatDelayMs) && reliquatDelayMs > thresholdMs) return reliquatDelayMs;
  return thresholdMs;
}

/**
 * Read the idle threshold from the environment.
 *
 * `ORCHESTRA_HIBERNATE_AFTER_MS` semantics (all three cases are load-bearing —
 * an env var with a default is not a kill switch, so "disabled" needs its own
 * explicit value rather than being expressed as absence):
 *   - unset / empty / not a number / `0`  → {@link DEFAULT_HIBERNATE_AFTER_MS}
 *   - `-1`                                → {@link HIBERNATION_DISABLED}
 *   - any positive integer                → that many ms (used by the e2e rig
 *                                           to make the sweep observable)
 *
 * `0` deliberately maps to the DEFAULT rather than "hibernate immediately": a
 * mistyped or empty-string-coerced env var must never turn into an aggressive
 * kill-everything mode.
 */
export function resolveHibernateAfterMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HIBERNATE_AFTER_MS;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_HIBERNATE_AFTER_MS;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return DEFAULT_HIBERNATE_AFTER_MS;
  if (n === HIBERNATION_DISABLED) return HIBERNATION_DISABLED;
  if (n <= 0) return DEFAULT_HIBERNATE_AFTER_MS;
  return n;
}

/** Default cadence of the idle sweep: 5 minutes. Coarse on purpose — the win is
 *  reclaiming memory from agents idle for tens of minutes, so this granularity
 *  costs at most one extra interval of RAM and keeps the sweep off the hot
 *  path. */
export const DEFAULT_HIBERNATE_SWEEP_MS = 5 * 60 * 1000;

/**
 * Read the sweep cadence from the environment (`ORCHESTRA_HIBERNATE_SWEEP_MS`).
 *
 * Separate knob from the idle threshold because they are independently
 * interesting to a test rig: a verifier wants a SHORT threshold (so a workspace
 * becomes eligible quickly) AND a SHORT cadence (so it doesn't wait out a
 * 5-minute timer to observe the sweep). A hardcoded cadence makes the sweep
 * observable only by real-time waiting.
 *
 * Unset / empty / non-numeric / non-positive → {@link DEFAULT_HIBERNATE_SWEEP_MS}.
 * Unlike the threshold there is NO disable sentinel here: disabling is the
 * threshold's job (`ORCHESTRA_HIBERNATE_AFTER_MS=-1`), and giving one feature
 * two kill switches invites the two disagreeing. Floored at 1s so a typo can't
 * spin the event loop.
 */
export function resolveHibernateSweepMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HIBERNATE_SWEEP_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HIBERNATE_SWEEP_MS;
  return Math.max(1000, n);
}

/**
 * Should this workspace's agent process be stopped to reclaim its memory?
 *
 * ALL conditions must hold. Each one is a safety rule, not a heuristic:
 *
 *  - **A process is actually live.** Nothing to reclaim otherwise, and
 *    recording `hibernatedAt` on an already-stopped workspace would put a "zZ"
 *    chip on a row that never had a process.
 *  - **Status is `idle`.** Never `running` (a turn is in flight — killing it
 *    loses the work), never `waiting` (the agent is blocked on the user; the
 *    orange dot and the inbox entry are a standing request for attention and
 *    must survive), never `error` (the failure is the signal), never `stopped`
 *    (already down).
 *  - **Not auto-unread.** A finished turn the user has never opened is `idle`
 *    but still owes them a look, so it is protected for the same reason
 *    `waiting` is. See {@link Workspace.autoUnread}. Except a fleet member
 *    (`parentId` set): its coordinator reads it over the bus, so its bell is
 *    permanent and would pin its process forever.
 *  - **Not the active workspace.** The pane the user is looking at keeps its
 *    process, even if they've been reading in silence past the threshold.
 *  - **Not sandbox-hosted** (`ws.host` absent). A remote session's process
 *    lives in a container over a shared WebSocket; stopping it here is a
 *    different lifecycle with different restore semantics (and no local RAM to
 *    reclaim, which is the entire point).
 *  - **Not archived.** Archived rows are already out of the fleet.
 *  - **No live run-script PTY.** See {@link HibernationSignals.hasLiveRunPty}.
 *  - **No running background task.** See {@link HibernationSignals.hasLiveBackgroundTask}.
 *  - **Idle longer than the threshold**, measured from the last observed
 *    lifecycle event — OR, while Admission is held ({@link HibernationSignals.admissionHeld}), any idle FLEET member (a coordinator
 *    reads it over the bus, {@link isFleetMember}): fast Veille (#288) skips ONLY this clock, every guard above still applies, a
 *    workspace without a coordinator is never affected, and the disabled sentinel stays a kill switch. A FLEET member with LIVE Reliquats (#326) must have been idle for the
 *    longer Reliquat delay instead ({@link effectiveVeilleWaitMs}), on the wall AND the monotonic clock; fast Veille is not delayed, a member without a coordinator never waits. When no activity has EVER been observed for this
 *    workspace this app run, the sweeper supplies the app-start time (see
 *    src/main/hibernation.ts) — so an unknown `lastActivityAt` here means the
 *    tracker has no opinion and we decline rather than guess, since treating
 *    "unknown" as "idle since the epoch" would hibernate the whole fleet on the
 *    first sweep after launch.
 */
export function shouldHibernate(ws: Workspace, signals: HibernationSignals): boolean {
  const {
    now,
    lastActivityAt,
    isActive,
    hasLivePty,
    hasLiveSdk,
    hasLiveRunPty,
    hasLiveBackgroundTask,
    thresholdMs,
    monotonicIdleMs,
    admissionHeld,
    liveReliquats,
    reliquatDelayMs,
  } = signals;

  if (thresholdMs === HIBERNATION_DISABLED) return false;
  if (thresholdMs <= 0) return false;

  // Nothing running → nothing to reclaim.
  if (!hasLivePty && !hasLiveSdk) return false;

  if (ws.status !== 'idle') return false;
  // An unseen finished turn is a standing request for attention, exactly as
  // `waiting` is. Before the three-state split those rows WERE `waiting` and
  // this status check protected them; now they resolve to `idle` + the
  // auto-unread bell, so without this line the sweeper would hibernate the very
  // workspaces whose output the user has not read yet — and the "zZ" chip would
  // replace the bell on a row that still owes them a look.
  // Fleet members (parentId) are exempt: read over the bus, their bell never clears and
  // pinned ~8 GB on 2026-10-07. The inbox entry survives (computeAttention ignores hibernatedAt).
  if (ws.autoUnread && !ws.parentId) return false;
  // A prompt still waiting to be delivered (e.g. a spawn's brief) means a turn is
  // about to start — hibernating now strands it (2026-09-30: fresh spawns slept 1 s in).
  if (ws.sdkPendingPrompts?.length) return false;
  // A /loop's wakeups live INSIDE the session process — hibernating a looping
  // agent doesn't pause the loop, it silently kills it (and the sidebar would
  // keep advertising a loop that can never fire again). A loop's idle phase
  // between wakeups can legitimately exceed the idle threshold (ScheduleWakeup
  // delays go up to 60 min), so without this line the sweeper reaps exactly the
  // agents that are deliberately sleeping-to-work.
  if (ws.loopingSince) return false;
  if (isActive) return false;
  if (ws.host) return false;
  if (ws.archived) return false;
  if (hasLiveRunPty) return false;
  // A quiet long task emits no lifecycle events, so idleness can't see it — the live
  // task set must block on its own (#198 D14 F1).
  if (hasLiveBackgroundTask) return false;

  if (lastActivityAt === undefined) return false;
  // Fast Veille (#288): under a held Admission the idle clock is waived for a fleet member — its memory is reclaimed before anything waits.
  if (admissionHeld && isFleetMember(ws)) return true;
  // #326: a FLEET member with LIVE Reliquats waits the Reliquat delay (≥ the threshold); fast Veille above is NOT delayed (under pressure the Reliquats are what must be freed). A member without a coordinator is
  // never delayed (OPS ruling R11, #326-fu m4): its Veille is today's, Reliquats or not. The wait guards an irreversible stop, so it is measured on BOTH clocks (m2): the smaller idle time decides.
  if (!isFleetMember(ws) || !(liveReliquats > 0)) return now - lastActivityAt >= thresholdMs;
  return Math.min(now - lastActivityAt, monotonicIdleMs) >= effectiveVeilleWaitMs(thresholdMs, liveReliquats, reliquatDelayMs);
}

/** Human-readable idle duration for the log line and the row tooltip
 *  ("hibernated 2h 5m ago"). Deliberately coarse — this is housekeeping copy,
 *  not a timer. */
export function formatIdleDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Start of the idle clock for the sweep: the last activity seen, else the app-start
 *  floor — but never before the workspace EXISTED. Without the createdAt bound a child
 *  spawned 2 h after launch read "idle 2h" and was hibernated before its first turn.
 *  A non-finite `lastSeen`/`createdAt` is ignored: NaN through `Math.max` would read
 *  every member as instantly stale (#236 F3). */
export function idleClockStart(
  lastSeen: number | undefined,
  appStartedAt: number,
  createdAt: number | undefined,
): number {
  const seen = lastSeen !== undefined && Number.isFinite(lastSeen) ? lastSeen : appStartedAt;
  const born = createdAt !== undefined && Number.isFinite(createdAt) ? createdAt : 0;
  return Math.max(seen, born);
}

/** The tail of a Veille log line (#288): empty while Admission is open (the line stays byte-identical to what it always was); under the hold it
 *  names the MemAvailable behind the Veille and — when only the hold made the member eligible — that it went early. */
export function fastVeilleLogSuffix(
  admissionHeld: boolean,
  snap: Pick<MemoryGuardSnapshot, 'availBytes' | 'measured'>,
  early: boolean,
  thresholdMs: number,
): string {
  if (!admissionHeld) return '';
  const mem =
    snap.availBytes === null ? 'MemAvailable unknown' : `MemAvailable ${formatGb(snap.availBytes, 2)}${snap.measured ? '' : ' (last good reading)'}`;
  return ` — Admission HELD, ${mem}${early ? `, fast Veille (idle below the ${formatIdleDuration(thresholdMs)} threshold)` : ''}`;
}
