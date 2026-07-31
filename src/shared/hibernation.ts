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

/** Default idle threshold before an agent is eligible: 30 minutes. Long enough
 *  that a user stepping away from a session mid-thought comes back to a live
 *  process, short enough that an overnight fleet collapses to near-zero. */
export const DEFAULT_HIBERNATE_AFTER_MS = 30 * 60 * 1000;

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
  /** Resolved idle threshold in ms, or {@link HIBERNATION_DISABLED}. */
  thresholdMs: number;
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

/**
 * Should this workspace's agent process be stopped to reclaim its memory?
 *
 * ALL conditions must hold. Each one is a safety rule, not a heuristic:
 *
 *  - **A process is actually live.** Nothing to reclaim otherwise, and
 *    recording `hibernatedAt` on an already-stopped workspace would put a "zZ"
 *    chip on a row that never had a process.
 *  - **Status is `idle`.** Never `running` (a turn is in flight — killing it
 *    loses the work), never `waiting` (the agent stopped FOR THE USER; the
 *    orange dot and the inbox entry are a standing request for attention and
 *    must survive), never `error` (the failure is the signal), never `stopped`
 *    (already down).
 *  - **Not the active workspace.** The pane the user is looking at keeps its
 *    process, even if they've been reading in silence past the threshold.
 *  - **Not sandbox-hosted** (`ws.host` absent). A remote session's process
 *    lives in a container over a shared WebSocket; stopping it here is a
 *    different lifecycle with different restore semantics (and no local RAM to
 *    reclaim, which is the entire point).
 *  - **Not archived.** Archived rows are already out of the fleet.
 *  - **No live run-script PTY.** See {@link HibernationSignals.hasLiveRunPty}.
 *  - **Idle longer than the threshold**, measured from the last observed
 *    lifecycle event. When no activity has EVER been observed for this
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
    thresholdMs,
  } = signals;

  if (thresholdMs === HIBERNATION_DISABLED) return false;
  if (thresholdMs <= 0) return false;

  // Nothing running → nothing to reclaim.
  if (!hasLivePty && !hasLiveSdk) return false;

  if (ws.status !== 'idle') return false;
  if (isActive) return false;
  if (ws.host) return false;
  if (ws.archived) return false;
  if (hasLiveRunPty) return false;

  if (lastActivityAt === undefined) return false;
  return now - lastActivityAt >= thresholdMs;
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
