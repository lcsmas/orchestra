// Last-activity tracking for the hibernation sweeper — a DEPENDENCY-FREE leaf.
//
// Why its own module rather than living in hibernation.ts: the stamping call
// site is `applyAgentEvent` in activity.ts, and hibernation.ts imports pty.ts,
// which imports activity.ts. Having activity.ts import hibernation.ts would
// close that loop (activity → hibernation → pty → activity) and drag node-pty
// into anything that touches the status path, including tests. This module
// imports NOTHING, so both sides can depend on it freely.
//
// In-memory only, and that is the SAFE direction: the map is empty after a
// restart, so `sweepHibernation` falls back to the app-start floor and nothing
// can be hibernated until it has been idle for a full threshold *of this run*.
// An agent that was mid-thought when the app closed is never killed seconds
// after launch on the strength of a stale on-disk timestamp.

const lastActivity = new Map<string, number>();

/** Epoch ms this app run started — the floor for workspaces that have not
 *  emitted a lifecycle event yet. Without it, a session that has been quietly
 *  live since launch (started, never emitted another event) would have no
 *  timestamp at all and could never become eligible. */
let appStartedAt = Date.now();

/** Stamp a workspace as active NOW. Called from `applyAgentEvent`
 *  (activity.ts) for EVERY agent lifecycle event — the one funnel both the
 *  spool-tailed terminal path and the structured path's `driveStatusFromEvent`
 *  pass through — and from the restore paths, so a woken agent is not
 *  immediately re-eligible on the next sweep. */
export function noteActivity(wsId: string): void {
  lastActivity.set(wsId, Date.now());
}

/** Last observed activity, or `undefined` when nothing has been seen. */
export function getLastActivity(wsId: string): number | undefined {
  return lastActivity.get(wsId);
}

/** Drop a workspace's tracking (workspace deleted). */
export function forgetHibernationActivity(wsId: string): void {
  lastActivity.delete(wsId);
}

/** Reset the app-start floor. Called once when the sweeper starts. */
export function noteAppStart(): void {
  appStartedAt = Date.now();
}

// --- the workspace the user is looking at -----------------------------------
//
// Main has no notion of renderer selection; the renderer reports it over
// `workspaces:setActive`. It lives in THIS leaf rather than hibernation.ts
// because two unrelated consumers need it and one of them (activity.ts's
// turn-end auto-unread) cannot import hibernation.ts without closing the
// activity → hibernation → pty → activity cycle described above.
//
// Absent (no window, nothing selected) means "no workspace is being watched",
// which is the correct default in both consumers: nothing is protected from
// the hibernation sweep, and a finishing agent is treated as UNSEEN.

let activeWorkspaceId: string | null = null;

/** Record the renderer's currently-selected workspace. */
export function noteActiveWorkspace(id: string | null): void {
  activeWorkspaceId = id;
}

/** The renderer's currently-selected workspace, or null. */
export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

export function getAppStartedAt(): number {
  return appStartedAt;
}
