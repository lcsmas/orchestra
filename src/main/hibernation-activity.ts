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
  inFlightTools.delete(wsId);
}

// --- in-flight tool-call tracking (liveness v2, issue #127) ------------------
//
// The staleness bound (src/shared/bus-liveness.ts) cannot see a session HUNG
// mid-tool-call: a `pretool` stamps `lastActivity` and moves the status to
// `running`, and if no `posttool`/`stop` ever follows, the clock freezes and
// `running` stays true forever — `decideEscalation`'s `running` guard then skips
// it unconditionally (the #90 wedge class). #127 adds a PROGRESS bound on each
// in-flight call: which tool is running and WHEN its call started, so the sweep
// can compare elapsed-in-call against a per-tool-class ceiling.
//
// PARALLEL tool calls are the common case (an assistant turn issues N `tool_use`
// blocks at once), so this tracks a LIST of concurrently in-flight calls per
// workspace, NOT one slot (review-127 F1: a single slot let a hung MCP call
// beside a fast Bash go untracked — the fast call's posttool cleared the whole
// slot, so the hung call vanished and never escalated, re-opening the exact #90
// gap #127 exists to close). Each call is keyed by its `toolUseId` when the
// event carries one (the SDK path always does; the spool hook now emits it too),
// so its posttool removes exactly that call and leaves a hung sibling in place.
// A call still in the list IS the zero-progress signal: its posttool never came.
//
// It lives in THIS dependency-free leaf for the same reason `lastActivity` does:
// the write site is `applyAgentEvent` in activity.ts, and importing bus-liveness
// (which imports bus.ts) from activity.ts would drag the bus onto the hot status
// path. This module imports nothing, so both sides depend on it freely. Fed from
// the SAME chokepoint that already stamps activity — no new probe (ticket bound).

/** The record for ONE in-flight tool call. */
export interface InFlightTool {
  /** The tool name as seen at `pretool` (e.g. `Bash`, `mcp__browser__click`).
   *  `null` when the name was unknown at call start (a legacy hook line). */
  tool: string | null;
  /** Epoch ms the call started (the `pretool` event). */
  startedAt: number;
  /** The tool_use id, when the event carried one — the SDK path always does; the
   *  spool hook mines it from the PreToolUse payload. `null` when unknown (an old
   *  hook), in which case posttool pairing falls back to FIFO. */
  toolUseId: string | null;
}

const inFlightTools = new Map<string, InFlightTool[]>();

/** Record that a tool call STARTED for `wsId` (an `applyAgentEvent` `pretool`).
 *  APPENDS to the in-flight list so parallel calls each get their own ceiling
 *  clock. When the same `toolUseId` somehow starts twice (a replay), the prior
 *  entry for that id is replaced rather than duplicated. */
export function noteToolStart(wsId: string, tool: string | null, toolUseId: string | null): void {
  const list = inFlightTools.get(wsId) ?? [];
  if (toolUseId !== null) {
    // Drop any existing entry for this id (a duplicate pretool for the same call)
    // so a replay cannot leave two entries that never both clear.
    const dedup = list.filter((c) => c.toolUseId !== toolUseId);
    dedup.push({ tool, startedAt: Date.now(), toolUseId });
    inFlightTools.set(wsId, dedup);
    return;
  }
  list.push({ tool, startedAt: Date.now(), toolUseId: null });
  inFlightTools.set(wsId, list);
}

/** Record that ONE in-flight tool call ENDED for `wsId` (an `applyAgentEvent`
 *  `posttool`). Removes the matching call:
 *   - by `toolUseId` when the posttool carries one (the SDK path, and the local
 *     spool hook now) — exact pairing, a hung sibling is untouched;
 *   - else the OLDEST id-less call OF THE SAME TOOL NAME (`tool`), else — when the
 *     name is unknown too — the oldest id-less call of any name.
 *
 *  The tool-name-scoped FIFO (review-127 F3) is what keeps the id-less REMOTE
 *  path (the sandbox wire carries a tool name but no id) from letting a fast
 *  call's posttool clear a hung call of a DIFFERENT tool — the exact F1 failure
 *  mode. Two id-less calls of the SAME tool still degrade to FIFO-within-name
 *  (at least one survives), which is the best the id-less wire allows.
 *
 *  Idempotent: a posttool with no matching in-flight call is a no-op. */
export function noteToolEnd(
  wsId: string,
  toolUseId: string | null,
  tool: string | null = null,
): void {
  const list = inFlightTools.get(wsId);
  if (!list || list.length === 0) return;
  let idx = -1;
  if (toolUseId !== null) {
    idx = list.findIndex((c) => c.toolUseId === toolUseId);
    // A posttool whose id matches nothing in flight is a no-op — it must NOT fall
    // back to removing an unrelated (possibly hung) call. Only an id-LESS posttool
    // uses FIFO, because it cannot say which call it belongs to.
    if (idx === -1) return;
  } else {
    // Id-less posttool (legacy hook, or the remote/sandbox wire). Prefer the
    // oldest id-less call OF THE SAME TOOL NAME so a fast call cannot clear a hung
    // call of a different tool (F3). Restrict to the id-less cohort so an
    // id-KEYED call whose own posttool is still coming is never stripped.
    if (tool !== null) {
      idx = list.findIndex((c) => c.toolUseId === null && c.tool === tool);
    }
    // No same-name id-less call (name unknown, or none of that tool): fall back to
    // the oldest id-less call of ANY name — the pre-F3 behaviour, still bounded to
    // the id-less cohort.
    if (idx === -1) idx = list.findIndex((c) => c.toolUseId === null);
    if (idx === -1) return;
  }
  list.splice(idx, 1);
  if (list.length === 0) inFlightTools.delete(wsId);
  else inFlightTools.set(wsId, list);
}

/** Clear ALL in-flight calls for `wsId` — a turn ended (`stop`/`stopfail`/
 *  `notify`) or the session was cleared, so no tool call can still be running.
 *  Without this, a turn that ends without a posttool for every call (an
 *  interrupt, an error) would leave phantom in-flight entries that later escalate
 *  as false hangs. */
export function clearInFlightTools(wsId: string): void {
  inFlightTools.delete(wsId);
}

/** Every in-flight tool call for `wsId` (empty array when none). Read by the
 *  liveness roster (index.ts) each sweep; the policy reasons over the whole set
 *  so a hung call is never masked by a fast sibling. */
export function getInFlightTools(wsId: string): InFlightTool[] {
  return inFlightTools.get(wsId) ?? [];
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
