// Is a workspace still OWED its opening task? (#227) A spawned child's `lastTask` is delivered when an SDK session takes it
// (`startWorkspaceAgentHeadless` flips `hasInput`); a child whose start FAILED keeps it undelivered — Restart retries it
// (the classifier alone says 'unknown'). Pure so it is unit-tested; the effectful retry is `startWorkspaceAgentHeadless`.

/** The persisted-Workspace fields the decision reads. */
export interface OpeningTaskView {
  archived?: boolean;
  lastTask?: string;
  /** Set once a prompt reached the agent (SDK-delivered opening task, wake, or a typed terminal prompt). */
  hasInput?: boolean;
  /** `undefined` = no SDK session ever reported an id (a started session persists one from its first message). */
  sdkSessionId?: string;
  /** Set once the CLI produced its first NON-ERROR output for the queued task (agent-sdk `consume`, D7 — not at init). */
  openingTaskDelivered?: boolean;
  /** Persisted start failures (`ws.sdkStartErrors`): their count, time and message are read. */
  sdkStartErrors?: readonly { at?: number; message?: string }[];
}

/** True iff `lastTask` never reached a live CLI: no delivered marker, no `hasInput`, no SDK session ever ran. */
export function owesOpeningTask(ws: OpeningTaskView): boolean {
  return (
    !ws.archived && !!ws.lastTask?.trim() && ws.openingTaskDelivered !== true && ws.hasInput !== true && ws.sdkSessionId === undefined
  );
}

/** Same start error this many times in a row = a start that keeps failing for a reason a re-wake will not change (#227 F4). */
export const START_FAIL_STREAK = 3;
/** Only failures this recent count toward the streak: a transient cause (EMFILE/ENOMEM under load) must not leave a child un-wakeable
 *  forever once it is gone (#227 r4 F3). A permanent cause keeps failing, so its rows stay fresh. */
export const START_FAIL_WINDOW_MS = 10 * 60_000;

/** A start that KEEPS failing: a passive re-wake (the bus-wake sweep, 60 s + every WAL write) would only add another error row + store
 *  write per sweep and fail again — the human's Restart (or a direct message) is what retries it (#227 F7/F4). True when the child still
 *  owes its brief and has failed a start, OR the last START_FAIL_STREAK failures WITHIN START_FAIL_WINDOW_MS are the identical message (also
 *  for a child that ran once). NEVER true for a LIVE session: it is wakeable whatever its history says. */
export function startKeepsFailing(ws: OpeningTaskView, sessionLive = false, now = Date.now()): boolean {
  if (sessionLive) return false;
  const errs = ws.sdkStartErrors ?? [];
  if (owesOpeningTask(ws) && errs.length > 0) return true;
  const recent = errs.filter((e) => typeof e.at === 'number' && now - e.at <= START_FAIL_WINDOW_MS);
  if (recent.length < START_FAIL_STREAK) return false;
  const last = recent[recent.length - 1]?.message;
  return recent.slice(-START_FAIL_STREAK).every((e) => e.message === last);
}

/** Does Restart take the owed-opening-task route (retry the SDK start, delivering the brief once)? Nothing may be running under a PTY; a LIVE
 *  session only counts when ITS OWN first turn already failed (`sdkFailed`) — a live session whose start is merely slow or hung restarts
 *  normally (tear it down and redeliver), and a stale persisted error must not disarm that (#227 r4 F2). */
export function restartOwesOpeningTask(ws: OpeningTaskView, live: { ptyLive: boolean; sdkLive: boolean; sdkFailed?: boolean }): boolean {
  if (live.ptyLive || !owesOpeningTask(ws)) return false;
  return !live.sdkLive || live.sdkFailed === true;
}
