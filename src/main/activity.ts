import fs from 'node:fs/promises';
import path from 'node:path';
import { platform } from './platform';
import { log, scoped } from './logger';
import { store } from './store';
import {
  getBranchMergeState,
  getCurrentBranch,
  getRefShas,
  getReleaseVersionsContaining,
} from './git';
import type { AgentStopReason, Workspace, WorkspaceStatus } from '../shared/types';
// Value import (not `import type`): the .ts extension is required for value
// imports reachable from the test runner — see the hibernation-activity note.
import { THINKING_TOOL_LABEL, isScratchLike } from '../shared/types.ts';
// Dependency-free leaf (see hibernation-activity.ts): importing hibernation.ts
// here would close an import cycle, since it imports pty.ts which imports this
// file. The .ts extension is required for VALUE imports reachable from the
// strip-types test runner.
import { getActiveWorkspaceId, noteActivity } from './hibernation-activity.ts';

/** How stale {@link Workspace.lastTurnStartAt} may get before a turn-start
 *  event is allowed through `setStatus`'s no-op guard to refresh it (#88,
 *  review-88 R2).
 *
 *  The guard exists so a `running → running` re-assertion costs nothing, and
 *  `pretool` re-asserts on EVERY tool call — so an unconditional bypass would
 *  trade a free no-op for a store write and a full sidebar re-render, per tool.
 *  Within a live turn, events arrive seconds apart (measured for the thinking
 *  label: pretool→posttool 40–130ms, consecutive PAIRS 2.5–6.5s), so a window
 *  well above that keeps the hot path on the no-op.
 *
 *  Two minutes is comfortably above the observed inter-event gap and far below
 *  the 15-minute stall threshold, so a stamp repaired by this path is still
 *  vastly fresher than anything that could badge. UNBASELINED as a distribution
 *  — no measurement of the longest legitimate event-free gap inside one turn
 *  exists; the cost of being wrong in either direction is bounded (too small =
 *  an occasional extra write; too large = the repair waits one more event). */
const TURN_STAMP_REFRESH_MS = 2 * 60 * 1000;

// Status transitions are the most bug-prone surface in the app (a stuck or wrong
// dot has been the visible symptom of spool wipes, missed turn-end events, and
// dead PTYs). At `trace` every transition is logged with its cause, so a stuck
// dot is diagnosable from the log alone: you can see the last event that
// arrived and whether it moved the status or was a no-op.
const alog = scoped('activity');

// Hook-driven activity tracker.
//
// Claude Code's lifecycle hooks (installed per-workspace in
// .claude/settings.local.json by workspaces.ts) append one JSON line per event
// to a durable per-workspace spool file; events-spool.ts tails it and calls
// `applyAgentEvent` here. (A legacy Unix-socket path still feeds
// `dispatchHookEvent` for any pre-upgrade session whose hooks were not yet
// rewritten — same handling, minus the per-tool detail.)
//
// State is a clean function of those events:
//   submit   → running
//   pretool  → running, with the active tool name surfaced to the renderer
//   posttool → running, tool cleared
//   stop     → idle + autoUnread (chime + finished-toast) — the turn ended;
//              the bell records that the user has not opened it yet.
//   notify   → waiting (chime + needs-input-toast) — Claude fires this when the
//              agent is prompting the user for an answer (permission prompts
//              and the 60s idle reminder).
//
// Note `waiting` means ONLY "blocked on the user's answer". "Finished but not
// yet seen" is `idle` + `autoUnread`, a separate axis — see Workspace.autoUnread.

/** Set or clear the auto-unread bell — "an agent finished here and you have
 *  never seen it". See {@link Workspace.autoUnread}.
 *
 *  Stored ABSENT rather than `false` so store.json doesn't grow a dead key on
 *  every workspace ever opened, but broadcast with an explicit `undefined`:
 *  the renderer's `workspace:update` reducer is a MERGE, so omitting the key
 *  means "no opinion" and would leave a cleared bell on screen forever. */
export async function markAutoUnread(id: string, unread: boolean): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (!!ws.autoUnread === unread) return;
  const updated: Workspace = { ...ws, autoUnread: unread || undefined };
  void store.upsertWorkspace(updated).catch((e) => alog.swallow('persist autoUnread', e));
  platform.broadcast('workspace:update', updated);
}

/** Set or clear the loop marker — "this agent is running a recurring /loop".
 *  See {@link Workspace.loopingSince} for the set/clear rules. Same mechanics
 *  as {@link markAutoUnread}: stored ABSENT when off, broadcast with an
 *  explicit `undefined` (the renderer's `workspace:update` reducer is a MERGE,
 *  so a dropped key would leave a stale loop ring on screen forever). Setting
 *  while already looping is a no-op — `loopingSince` keeps the FIRST
 *  observation, so the tooltip can age "looping for 2h" rather than resetting
 *  on every re-schedule. */
export async function markLooping(id: string, looping: boolean): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (!!ws.loopingSince === looping) return;
  alog.info(`loop ${looping ? 'detected' : 'ended'} ws=${id}`);
  const updated: Workspace = { ...ws, loopingSince: looping ? Date.now() : undefined };
  void store.upsertWorkspace(updated).catch((e) => alog.swallow('persist loopingSince', e));
  platform.broadcast('workspace:update', updated);
}

/** Update a workspace's status. Returns the workspace plus whether this call
 *  was a real transition (`changed`) — callers that fire a one-shot side effect
 *  on entering a state (a chime, an OS notification) gate on `changed` so a
 *  redundant event (e.g. a `notify` right after a `stop`, both → `waiting`)
 *  doesn't re-fire it. Returns null only when the workspace is gone/archived. */
async function setStatus(
  id: string,
  status: WorkspaceStatus,
  /** Why the last turn ended, when this transition is a turn-END and the reason
   *  is one the human must see (issue #69). `null` explicitly CLEARS the
   *  marker (the agent is working again); `undefined` leaves it untouched.
   *
   *  Threaded through here rather than written by a second `upsertWorkspace`
   *  so it piggybacks the store write this function already makes — and so it
   *  crosses the SAME broadcast, keeping the dot and its explanation atomic in
   *  the renderer. */
  stopReason?: AgentStopReason | null,
  /** True when this transition IS a turn starting (issue #88) — the `submit`
   *  and `pretool` cases of `applyAgentEvent`, which are the one chokepoint
   *  both agent paths cross with that meaning. Stamps
   *  {@link Workspace.lastTurnStartAt}, the clock the queue-stall detector
   *  ages. Threaded here for the same reason `stopReason` is: it piggybacks
   *  the store write and the broadcast this function already makes, so the
   *  stall badge clears in the SAME frame the dot turns green rather than one
   *  broadcast later.
   *
   *  RETRACTED (review-88 R2). An earlier version of this comment claimed the
   *  flag "rides the no-op guard, and that is CORRECT … the first event of a
   *  turn is a real transition, so it is never swallowed." That was true of the
   *  two `applyAgentEvent` arms the source check pins and FALSE of two other
   *  writers — `restoreRunningFromKeeper` and `resumeRunning` both enter
   *  `running` without the flag, after which the whole turn's events are
   *  no-ops and the stamp never lands. The disproof is recorded here rather
   *  than deleted, because a comment asserting an invariant is exactly what
   *  suppresses the check that would catch its violation.
   *
   *  So the guard now treats a turn start as its own signal (see
   *  `turnStartChanged` below). Re-stamping on every `pretool` of one long turn
   *  is still avoided — but by the STATUS transition, not by the guard: only
   *  the first event moves `idle → running`, and subsequent ones now write the
   *  same `Date.now()`-fresh stamp, which is harmless (the clock only ever
   *  moves forward while a turn is genuinely in flight). */
  turnStart?: boolean,
): Promise<{ ws: Workspace; changed: boolean } | null> {
  const ws = store.getWorkspace(id);
  if (!ws) {
    // A status arriving for an unknown workspace means an orphaned agent is
    // still emitting events after its workspace was deleted — worth a line,
    // since it usually means a PTY/hook outlived its owner.
    alog.debug(`setStatus(${status}) for unknown workspace ${id} — dropped`);
    return null;
  }
  if (ws.archived) {
    alog.trace(`setStatus(${status}) for archived ${ws.name} — dropped`);
    return null;
  }
  // The stop-reason marker moves INDEPENDENTLY of the status (issue #69): a
  // turn that blows its budget ends `running → idle`, but a SECOND one on an
  // already-`idle` workspace (a queued turn that died instantly on the same
  // exhausted budget) is a real change to WHY it is idle while the status is
  // unchanged. Computing this before the no-op guard is what stops that
  // second, more important, signal being swallowed by it.
  const nextStopReason = stopReason === null ? undefined : (stopReason ?? ws.lastStopReason);
  const reasonChanged = nextStopReason !== ws.lastStopReason;
  // A TURN START is a third independent signal, for the same reason the stop
  // reason is (review-88 R2). The no-op guard below returns before `updated` is
  // built, so anything not accounted for here is unreachable for as long as the
  // status does not move — and `running → running` is the NORMAL shape of a
  // whole turn, not an edge case.
  //
  // MEASURED on 861fa16: two existing writers enter `running` WITHOUT the flag
  // — `restoreRunningFromKeeper` (:730, the detached-keeper startup reconcile)
  // and `resumeRunning` (:704, the user answering a parked tool call). After
  // either, every `submit`/`pretool` of that turn hit `ws.status === 'running'`
  // with the reason already clear, so the stamp never landed and a healthy
  // completed turn never moved the stall clock.
  //
  // Fixing it HERE rather than by passing the flag at those two call sites is
  // deliberate: neither is semantically a turn start (one restores a status,
  // one un-parks a tool call), and a rule that depends on every future writer
  // remembering a flag is the drift this guard already exists to prevent.
  //
  // SCOPED so it does not defeat the guard on the hot path. `pretool` fires
  // once per tool call and re-asserts `running` every time; letting all of
  // those through would turn a free no-op into a store write plus a broadcast
  // that re-renders every sidebar row, for a clock that is already fresh.
  //
  // The discriminator is STALENESS, not the status — in the R2 scenario the
  // status IS already `running`, which is exactly why the guard swallowed the
  // stamp. So: let it through only when the recorded start is missing or older
  // than the freshness window. Within a live turn the events are seconds apart
  // and the stamp stays fresh, so the common path still no-ops; after a
  // keeper-restore or a resume the recorded value is minutes-to-hours old and
  // the very next event repairs it.
  const turnStartChanged =
    turnStart === true &&
    (ws.lastTurnStartAt === undefined || Date.now() - ws.lastTurnStartAt > TURN_STAMP_REFRESH_MS);
  if (ws.status === status && !reasonChanged && !turnStartChanged) {
    alog.trace(`${ws.name}: status already ${status} (no-op)`);
    return { ws, changed: false };
  }
  alog.trace(
    `${ws.name}: ${ws.status} → ${status}` +
      (reasonChanged ? ` (stop reason ${ws.lastStopReason ?? 'none'} → ${nextStopReason ?? 'none'})` : ''),
  );
  const updated: Workspace = {
    ...ws,
    status,
    // Assigned EXPLICITLY (including to `undefined`) rather than deleted: the
    // renderer merges `workspace:update` over its current record, and a merge
    // cannot unset an absent key — deleting it here would leave a cleared
    // marker rendering forever. Same reason `loopingSince` is broadcast this
    // way (see types.ts).
    lastStopReason: nextStopReason,
    lastStopReasonAt: nextStopReason ? (reasonChanged ? Date.now() : ws.lastStopReasonAt) : undefined,
    // #88. Only ever moves FORWARD, never cleared: a cleared value would make
    // an active workspace's stall age fall back to `createdAt`, which for an
    // old workspace reads as a stall of days.
    lastTurnStartAt: turnStart ? Date.now() : ws.lastTurnStartAt,
  };
  // Broadcast to the renderer first, then persist. upsertWorkspace mutates the
  // in-memory store synchronously (before its first await), so state is already
  // consistent here — but its disk flush is serialized through one write chain
  // (tmp-write + atomic rename of the whole store.json). The 8s stats poll
  // enqueues a save per workspace onto that same chain, so awaiting the flush
  // would make the status dot wait behind a batch of unrelated full-file
  // writes — the visible latency. The dot is ephemeral UI; it must not block on
  // durability, so fire the persist and let it flush in the background.
  void store.upsertWorkspace(updated).catch((e) => alog.swallow("persist status", e));
  platform.broadcast('workspace:update', updated);
  return { ws: updated, changed: true };
}

/** Human-facing wording for a turn-end toast, keyed by WHY the turn ended.
 *  A turn that blew its budget or died on an error is still `waiting` — the
 *  human is still needed — but announcing it as "ready for review" misreports
 *  what happened, which is the whole point of carrying the reason. */
function finishedToast(reason: AgentStopReason | undefined, name: string): {
  title: string;
  body: string;
} {
  switch (reason) {
    case 'error':
      return { title: 'Agent stopped on an error', body: `${name} ended its turn with an error` };
    case 'max_turns':
      // #85: turn-scoped. The cap resets every user turn (MEASURED
      // 2026-08-25, probe 3 positive control) — the session is alive and one
      // more message continues it, so the toast must not read as terminal.
      return {
        title: 'Agent hit its step limit',
        body: `${name}'s turn hit the step limit — send a message to continue`,
      };
    case 'interrupted':
      return { title: 'Agent interrupted', body: `${name} was interrupted mid-turn` };
    // end_turn (and the spool path's absent reason) — the normal, good case.
    default:
      return { title: 'Agent finished', body: `${name} is ready for review` };
  }
}

/** What `fireFinished` should record as the stop reason for a turn that just
 *  ended — and, critically, what it must NOT erase.
 *
 *  The `max_turns`/`error` allowlist is #69's: those two are worth showing, and
 *  every other reason passes `null` so a clean finish CLEARS a stale marker.
 *
 *  The `usage_limit` clause is #74's, and it exists because that rule is WRONG
 *  for a limit death. A limit-killed turn's own `turn-end` carries `stopReason`
 *  `'error'` — never `'usage_limit'`, which is written out-of-band by
 *  `markStoppedOnUsageLimit` from a latched `rate_limit_event`.
 *
 *  CORRECTED (review-74 R3). An earlier version of this paragraph said
 *  `'error'`/`'end_turn'`/`undefined` and labelled itself "MEASURED, not
 *  reasoned". That was wrong on both counts: no rig backed it, and the
 *  `'end_turn'` case is IMPOSSIBLE BY CONSTRUCTION — `toStopReason`
 *  (agent-events.ts) returns `'error'` whenever `msg.is_error` is truthy, so it
 *  can only return `'end_turn'` when `isError` is false. Enumerated over the
 *  five reachable `result` shapes: 429-limit and plain error both give
 *  (`'error'`, true); `error_during_execution` gives (`'interrupted'`, true);
 *  a clean success gives (`'end_turn'`, FALSE); max_turns gives (`'max_turns'`,
 *  true). The (`'end_turn'`, true) pair occurs zero times. The consequence for
 *  this function is unchanged — a limit death still arrives as `'error'` and
 *  would still erase the marker — but the claim is now the enumeration above
 *  rather than an unsupported label. So this function runs AFTER that marker
 *  is set and, under the old allowlist, overwrote it with `'error'` or cleared
 *  it outright. Either way `lastStopReason` stops being `'usage_limit'`, the
 *  resume driver's filter matches nothing, and **auto-resume silently never
 *  fires** — the whole feature dead, with every unit test still green, because
 *  the defect lives in a consumer downstream of the guard.
 *
 *  So: never clear a `usage_limit` marker here. Only the resume driver
 *  (`clearStopReason`) and a genuinely new turn (`submit`/`pretool`, which pass
 *  `null` on the RUNNING transition) may retire it — both of which mean the
 *  session actually moved on. */
function finishedStopReason(
  id: string,
  stopReason?: AgentStopReason,
): AgentStopReason | null | undefined {
  if (stopReason === 'max_turns' || stopReason === 'error' || stopReason === 'usage_limit') {
    return stopReason;
  }
  // No reason worth recording of its own. Preserve an existing usage-limit
  // pause rather than clearing it (see above); anything else still clears.
  return store.getWorkspace(id)?.lastStopReason === 'usage_limit' ? undefined : null;
}

function fireFinished(id: string, stopReason?: AgentStopReason): void {
  // Focus of the Electron window (the seam guards a destroyed window
  // internally — an isFocused throw here used to abort the whole spool drain
  // batch and strand the `stop`).
  const focused = platform.isFocused();
  // "Did the user actually SEE this turn end?" — the workspace must be the one
  // they have open AND the window must have focus. Either being false means the
  // output is unseen, so the row carries the auto-unread bell until they open
  // it (markSeen clears it). Mirrors Orca's `!isVisibleForegroundPaneKey(...)
  // || !isOrcaWindowForegroundFocused()` test. Computed BEFORE the await so it
  // reflects the moment the turn ended, not whenever the promise settles.
  const seen = focused && getActiveWorkspaceId() === id;
  // `idle`, not `waiting`: `waiting` now means ONLY "the agent is blocked on
  // your answer". A finished turn owes you nothing — whether you have looked at
  // it is carried by `autoUnread` below, which is a property of your attention
  // rather than of the agent's state.
  // Record WHY, on the same write (issue #69). `end_turn`/`interrupted` pass
  // `null` so a clean finish CLEARS any marker a previous turn left — without
  // that, one budget exhaustion would brand the row until the app restarted.
  void setStatus(
    id,
    'idle',
    finishedStopReason(id, stopReason),
  ).then((res) => {
    if (!res) return;
    const { ws, changed } = res;
    // EVERY user-facing side effect — the unread bell, the renderer chime
    // broadcast, the OS toast — gates on `changed`, i.e. a real
    // running→idle transition. A redundant terminal event on an
    // already-idle workspace (an overlapping drain, a synthetic turn-end, a
    // replayed spool line) used to gate only the OS toast: the broadcast
    // still chimed and markAutoUnread re-belled rows the user had already
    // reviewed. (`seen` is still computed BEFORE the await, at the moment
    // the turn ended.)
    if (!changed) return;
    void markAutoUnread(id, !seen);
    // Ship the main-process focus state with the event. document.hasFocus()
    // is unreliable in the renderer (returns stale true on Wayland when the
    // window is hidden on another workspace / CDP is attached), so the
    // renderer trusts this flag instead.
    platform.broadcast('agent:finished', id, focused);
    // Re-evaluate "is this branch in sync with base after a merge, or has
    // it diverged again?" each time the agent's turn ends. Agents drive the
    // merge themselves via the Merge button's prompt, and may keep working
    // on the branch afterward — so the pill cycles on/off with each merge
    // and re-divergence rather than being a one-shot terminal state.
    void detectAndUpdateMergeState(id);
    // OS toast additionally requires the window to be unfocused (`changed` is
    // already guaranteed by the gate above). The seam posts the native
    // Electron toast (click-to-focus).
    //
    // LOOPING rows skip the toast (and the renderer skips its chime — see
    // App.tsx's onAgentFinished): a /loop ends a turn every iteration, so a
    // 15-minute loop would otherwise toast+chime at the user 4×/hour for
    // routine ticks. The BELL still arms above — each iteration genuinely is
    // unseen output — and the loop badge on the glyph already says "alive and
    // recurring". A loop that parks on a QUESTION still notifies: that path is
    // fireNeedsInput, untouched.
    if (focused || ws.loopingSince) return;
    const { title, body } = finishedToast(stopReason, ws.name);
    platform.notify({ wsId: id, kind: 'finished', title, body });
  });
}

/** Flip a workspace to `waiting` because the agent is blocked on the user, and
 *  raise the "needs input" toast/chime if the window is unfocused. The terminal
 *  path reaches this via the Claude Code `Notification` hook → the events spool
 *  → `applyAgentEvent('notify')`. The structured (SDK) path has no spool signal
 *  for a parked question — its `canUseTool` bridge (agent-sdk.ts) emits a
 *  renderer-only `permission-request` event — so it calls this directly when it
 *  parks an interactive tool call. Exported for that caller. */
/** Record that this workspace's session STOPPED because it hit its turn limit
 *  (issue #69), so the sidebar can say WHY.
 *
 *  ## Why this exists rather than riding the normal turn-end path
 *
 *  The reason is already known upstream: `toStopReason`
 *  (`src/shared/agent-events.ts`) NORMALIZES a result carrying
 *  `subtype: 'error_max_turns'` (or `stop_reason: 'max_turns'`) into a
 *  `turn-end` event with `stopReason: 'max_turns'`, and `emitFrom`
 *  (`src/main/agent-sdk.ts`) keys on exactly that normalized value before
 *  calling this. Nothing here re-derives it from CLI text.
 *
 *  What this call adds is REACH. The same reason would otherwise travel only
 *  via `driveStatusFromEvent`, which is gated on `session.driveStatus` — TRUE
 *  only when a terminal PTY coexists. In the plain structured-view
 *  configuration the SDK's own shell hooks own the events spool instead, and
 *  they carry no reason field at all: MEASURED, 8 consecutive exhaustions in
 *  that configuration wrote no reason ANYWHERE, leaving only a `[WARN]` in the
 *  app log — verbatim the bug #69 reports. So `emitFrom` calls this OUTSIDE
 *  that gate, the same exemption `markLooping` takes and for the same reason:
 *  the gate exists to stop double-DRIVING the status dot, while this is a
 *  store field with its own no-change guard (`setStatus` returns
 *  `changed: false` when neither the status nor the reason moved), so the two
 *  paths overlap safely.
 *
 *  Status stays `idle` — a stopped session is idle; the REASON is the
 *  orthogonal axis, never a sixth `WorkspaceStatus`.
 *
 *  ## History worth keeping (do not delete this paragraph)
 *
 *  The first version of this fix passed its E2E only because the drive SEEDED
 *  `lastStopReason` directly — it proved the renderer renders a field, and was
 *  structurally blind to the producer being broken. The disclosed gap in that
 *  attempt's own NOT VERIFIED list ("nothing proves activity.ts actually writes
 *  lastStopReason on a real max_turns event") was EXACTLY where the defect
 *  lived. A NOT-VERIFIED entry naming the defect class under test is a STOP,
 *  not a footnote. Never accept a seeded `lastStopReason` as proof of this
 *  seam; drive the producer. */
export async function markStoppedOnMaxTurns(id: string): Promise<void> {
  await setStatus(id, 'idle', 'max_turns');
}

/** Sibling of {@link markStoppedOnMaxTurns} for a turn killed by the account's
 *  USAGE LIMIT (#74) — the reason that resolves by itself at the reset, and so
 *  the only one the app auto-resumes from.
 *
 *  Takes the same OUTSIDE-the-gate exemption and for the identical reason: in
 *  the plain structured-view configuration `driveStatusFromEvent` is gated on
 *  `session.driveStatus` (a coexisting PTY), so a limit death there would
 *  otherwise write the reason nowhere. That is precisely the field failure #74
 *  exists to fix — a coordinator died on the limit and NOTHING recorded why,
 *  so nothing could ever decide to restart it.
 *
 *  `resetsAtMs` is epoch MILLISECONDS and must already have been converted
 *  from the notice's epoch-SECONDS by `resetsAtMsFromNotice` — see the unit
 *  trap documented at length in src/shared/usage-resume.ts. Null is a real,
 *  expected value ("limited, reset time unknown"): the 429-turn-result
 *  detection path reports no reset time, and the resume driver then waits for
 *  fresh usage evidence rather than guessing.
 *
 *  Status stays `idle` for the same reason as max_turns: a stopped session is
 *  idle, and the reason is the orthogonal axis. */
export async function markStoppedOnUsageLimit(
  id: string,
  resetsAtMs: number | null,
): Promise<void> {
  const res = await setStatus(id, 'idle', 'usage_limit');
  // Persist the reset time alongside the reason. Written AFTER setStatus so we
  // build on the record it just wrote (setStatus owns `lastStopReason` /
  // `lastStopReasonAt`); re-reading from the store rather than reusing a stale
  // capture keeps this correct if setStatus changed anything else.
  const current = store.getWorkspace(id);
  if (!current) return;
  const next: Workspace = {
    ...current,
    // ALWAYS refresh the timestamp (review-74 R4). A SECOND limit death on a
    // workspace already `idle` + `usage_limit` hits `setStatus`'s no-op guard
    // (status unchanged AND reason unchanged), so it returns without writing,
    // and the spread above would preserve the FIRST death's timestamp.
    //
    // That matters here because #74 is the first consumer to make a RESUME
    // DECISION from this field: the driver passes it to `canAutoFlushQueue` as
    // `blockedAt`, whose whole rule is "the usage reading must have been
    // fetched AFTER the block". Measured discrimination — a snapshot fetched
    // 10:02 with deaths at 10:00 and 10:05: the correct `blockedAt` (10:05)
    // says wait; the stale one (10:00) says the reading is fresh enough and
    // resumes PREMATURELY, straight back into the wall.
    lastStopReasonAt: Date.now(),
    ...(resetsAtMs === null
      ? // Clear a stale reset from an earlier limit rather than leaving it to
        // be read as this one's — an old timestamp is already in the past, so
        // it would make the resume driver fire IMMEDIATELY, straight back into
        // the wall it is supposed to be waiting out.
        { usageLimitResetsAt: undefined }
      : { usageLimitResetsAt: resetsAtMs }),
  };
  await store.upsertWorkspace(next);
  // Only broadcast when setStatus did not already (it broadcasts on a real
  // transition); an unconditional second broadcast is harmless but noisy, and
  // the renderer re-renders every workspace row on each one.
  if (!res?.changed) platform.broadcast('workspace:update', next);
}

/** Clear the usage-limit pause marker after the auto-resume driver has acted on
 *  it (#74) — the counterpart to {@link markStoppedOnUsageLimit}.
 *
 *  Load-bearing for two reasons, not merely cosmetic:
 *   1. **Idempotence.** The driver's verdict is derived from
 *      `lastStopReason === 'usage_limit'`, so a marker left in place makes
 *      EVERY subsequent tick decide to resume again — a nudge every 20s at the
 *      flusher's cadence. Clearing it is what makes the resume happen once.
 *   2. **Honesty.** The sidebar would otherwise keep saying "⏸ limit reached"
 *      about a session that is running again.
 *
 *  Only ever clears a `usage_limit` marker: a workspace that stopped for a
 *  DIFFERENT reason since (max_turns, error) has a marker the human still needs,
 *  and silently dropping it would resurrect the #69 bug this machinery exists
 *  to fix. `setStatus(_, null)` explicitly clears (see its `stopReason` doc);
 *  the status itself is left alone — the wake path owns that. */
export async function clearStopReason(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.lastStopReason !== 'usage_limit') return;
  await setStatus(id, ws.status, null);
  // Drop the reset time with the reason it belonged to, so a later limit that
  // reports no reset cannot inherit this stale (already-past) one and resume
  // instantly. Assigned explicitly rather than deleted — the renderer merges
  // `workspace:update` and a merge cannot unset an absent key.
  const current = store.getWorkspace(id);
  if (!current || current.usageLimitResetsAt === undefined) return;
  const next: Workspace = { ...current, usageLimitResetsAt: undefined };
  await store.upsertWorkspace(next);
  platform.broadcast('workspace:update', next);
}

export function fireNeedsInput(id: string): void {
  const focused = platform.isFocused();
  void setStatus(id, 'waiting').then((res) => {
    if (!res) return;
    const { ws, changed } = res;
    // Chime broadcast AND OS toast gate on a real transition — a redundant
    // `notify` (overlapping drain, replayed spool line, notify-after-notify)
    // used to gate only the toast while the broadcast still chimed.
    if (!changed) return;
    platform.broadcast('agent:needs-input', id, focused);
    if (focused) return;
    platform.notify({
      wsId: id,
      kind: 'needsInput',
      title: 'Agent needs input',
      body: `${ws.name} is waiting for your answer`,
    });
  });
}

// Cache the (branchSha, baseSha, remoteSha) triple from each workspace's last
// full merge probe. The 8s stats poll calls this for every workspace, and
// getBranchMergeState spawns 2-9 git processes per call — the expensive reflog
// branch is precisely the idle steady state (branch tip == base, nothing
// ahead) that idle/fresh workspaces sit in. Merge state AND `unpushedAhead` are
// a pure function of these three SHAs, so when none has moved since the last
// probe the result cannot have changed: one cheap `rev-parse` (one process)
// short-circuits the whole computation. Any ref movement busts the cache and
// forces a recompute. The remote-tracking SHA (`origin/<branch>`) MUST be in
// the key: a `git push` moves only that ref — the branch tip and base tip stay
// put — so keying on just (branchSha, baseSha) would never notice the push and
// would pin a stale ↑N badge until the branch or base tip later moved.
const lastMergeProbe = new Map<
  string,
  { branchSha: string; baseSha: string; remoteSha: string | null }
>();

export async function detectAndUpdateMergeState(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  // `isScratchLike` covers the orchestrator kind too — it is just as repo-less
  // as a scratch session. The old `kind === 'scratch'` test let orchestrators
  // through and was saved only by their empty `repoPath` making the git call
  // fail; that is an accident, not a guard. (Pre-existing; see the matching
  // fixes in detectAndUpdateBranchName/ReleaseState and api-handlers findPR.)
  if (!ws || ws.archived || isScratchLike(ws)) return;
  const heads = await getRefShas(ws.repoPath, ws.branch, ws.baseBranch);
  if (heads) {
    const prev = lastMergeProbe.get(id);
    if (
      prev &&
      prev.branchSha === heads.branchSha &&
      prev.baseSha === heads.baseSha &&
      prev.remoteSha === heads.remoteSha
    )
      return;
  }
  const { merged, diverged, unpushedAhead, stalePointer } = await getBranchMergeState(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  // Record the probed SHAs so the next poll can skip recomputation while the
  // refs hold still. Set even when the derived state is unchanged below.
  if (heads) lastMergeProbe.set(id, heads);
  // mergedAt is "timestamp of most recent merge" — set/refresh on every
  // merge cycle. `divergedFromBase` is what tells the renderer whether the
  // branch is currently in sync with that merge (pill visible) or has new
  // commits since (pill hidden, button enabled). Cleared only on
  // `stalePointer`, which signals the branch tip is just an old commit on
  // base's history with no real merge — clears false positives written by
  // the pre-fix detection.
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const nextMergedAt = merged ? Date.now() : stalePointer ? undefined : fresh.mergedAt;
  const nextDiverged = diverged;
  const nextUnpushed = unpushedAhead;
  const changed =
    nextMergedAt !== fresh.mergedAt ||
    Boolean(fresh.divergedFromBase) !== nextDiverged ||
    (fresh.unpushedAhead ?? 0) !== nextUnpushed;
  if (!changed) return;
  const updated: Workspace = {
    ...fresh,
    mergedAt: nextMergedAt,
    divergedFromBase: nextDiverged,
    unpushedAhead: nextUnpushed,
  };
  // Broadcast before persisting — see setStatus: the renderer must not wait on
  // the serialized store-write chain to reflect the merge pill / ↑N badge.
  void store.upsertWorkspace(updated).catch((e) => alog.swallow("persist status", e));
  platform.broadcast('workspace:update', updated);
}

/** Reconcile the stored branch name with what's actually checked out in the
 *  worktree. A branch renamed outside orchestra — `git branch -m` in a
 *  terminal, an editor's VCS UI, a teammate's script — leaves `ws.branch`
 *  stale, and that name is threaded into every downstream git call (merge
 *  state, PR lookup, the rename instruction's env), so a stale value quietly
 *  poisons all of them. We piggyback this on the hot 8s stats poll: one cheap
 *  `rev-parse` per workspace. When the live HEAD differs from the stored
 *  branch we adopt it, refresh the display name, and set `branchManuallySet` —
 *  an out-of-band rename is a deliberate choice, so the auto-rename
 *  instruction should stop firing. Detached HEAD (getCurrentBranch → '') is
 *  ignored: there's no branch to adopt and the worktree is mid-rebase/bisect. */
// Throttle the per-workspace out-of-band-rename probe. The stats poll calls
// this every 8s per workspace, but a `git branch -m` from a terminal is a rare,
// deliberate event — there's no value in spawning a `git rev-parse` per
// workspace 7-8 times a minute to catch it. Cap each workspace's probe to once
// per BRANCH_PROBE_MS; the rename is still adopted within a minute. With N
// workspaces this turns ~N·7.5 git spawns/min into ~N.
const BRANCH_PROBE_MS = 60_000;
const lastBranchProbe = new Map<string, number>();

/** Drop a workspace's cached probe state. Called when a workspace is deleted or
 *  archived: the renderer stops polling it, so its entries would otherwise
 *  linger as dead ids accumulating over a long session. */
export function forgetWorkspaceProbes(id: string): void {
  lastBranchProbe.delete(id);
  lastMergeProbe.delete(id);
  lastContext.delete(id);
}

export async function detectAndUpdateBranchName(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  // See detectAndUpdateMergeState: orchestrators are repo-less too. This one is
  // the sharpest of the three — it would reconcile the row's label against a
  // `git rev-parse` in a directory that is not a checkout, and on a hit would
  // relabel the row and pin `branchManuallySet`, permanently retiring the
  // rename nudge.
  if (!ws || ws.archived || isScratchLike(ws)) return;
  const now = Date.now();
  const last = lastBranchProbe.get(id) ?? 0;
  if (now - last < BRANCH_PROBE_MS) return;
  lastBranchProbe.set(id, now);
  const live = await getCurrentBranch(ws.worktreePath);
  if (!live || live === ws.branch) return;
  // Re-read after the await — a concurrent orchestra-driven rename may have
  // already adopted the same name, in which case there's nothing left to do.
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived || fresh.branch === live) return;
  const repoName = path.basename(fresh.repoPath);
  const updated: Workspace = {
    ...fresh,
    branch: live,
    name: `${repoName} · ${live}`,
    branchManuallySet: true,
  };
  // Broadcast before persisting — see setStatus: don't gate the renamed-branch
  // UI on the serialized store-write chain.
  void store.upsertWorkspace(updated).catch((e) => alog.swallow("persist status", e));
  platform.broadcast('workspace:update', updated);
}

/** Detect the published GitHub Releases this branch's work shipped in and
 *  stamp `releasedAt` + `releasedVersions` (and `releasedVersion`, the
 *  earliest, for back-compat). An unmerged branch naturally yields no pills —
 *  its authored commits are in no release. The version list still tracks later
 *  ships and policy changes because `getReleaseVersionsContaining` recomputes
 *  whenever the branch tip or the release list moves — and serves a memoized
 *  result (one `rev-parse`) on every poll in between. `getPublishedReleases`
 *  is cached per-repo (30s) and shared across that repo's workspaces, so this
 *  stays at roughly one `gh` call per repo per TTL even on the PR poll
 *  cadence. Writes/broadcasts only when the version list actually changes.
 *  Deliberately NOT wired into `detectAndUpdateMergeState`, which runs on the
 *  hot 8s stats poll and must stay network-free. */
export async function detectAndUpdateReleaseState(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  // See detectAndUpdateMergeState: orchestrators are repo-less too. This path
  // reaches `gh`, so letting one through spends the shared (and exhaustible)
  // GitHub budget on a branch that is not in the repo.
  if (!ws || ws.archived || isScratchLike(ws)) return;
  // One pill for the release that FIRST shipped this branch's own work, plus
  // one per release this branch itself cut (it authored the version-bump tag
  // commit). getReleaseVersionsContaining derives the branch's authored commit
  // set (from its reflog, falling back to the base..branch range), so a fresh
  // branch cut from an old release commit it never authored gets nothing, a
  // merged/stale-pointer branch still gets exactly what it shipped, and a
  // stray follow-up commit riding along in another branch's release earns no
  // extra pill. An empty authored set already yields no versions.
  // getPublishedReleases is cached per-repo (30s), so this costs at most one
  // gh call per repo per TTL.
  const { versions, releasedAt } = await getReleaseVersionsContaining(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const prev = fresh.releasedVersions ?? (fresh.releasedVersion ? [fresh.releasedVersion] : []);
  // No change → avoid a redundant write/broadcast. (Covers both staying empty
  // and staying identical.)
  if (prev.length === versions.length && prev.every((v, i) => v === versions[i])) return;
  if (versions.length === 0) {
    // The branch shipped nothing (or a prior over-eager computation left stale
    // pills): clear the release fields so the badges disappear.
    const cleared: Workspace = {
      ...fresh,
      releasedAt: undefined,
      releasedVersion: undefined,
      releasedVersions: undefined,
    };
    void store.upsertWorkspace(cleared).catch((e) => alog.swallow("persist cleared context", e));
    platform.broadcast('workspace:update', cleared);
    return;
  }
  const updated: Workspace = {
    ...fresh,
    // Recompute releasedAt from the fresh result rather than preserving a stale
    // one — the version list itself just changed, so the "shipped when" anchor
    // should track it.
    releasedAt: releasedAt ?? fresh.releasedAt ?? Date.now(),
    releasedVersion: versions[0], // earliest = the "shipped when" signal
    releasedVersions: versions,
  };
  // Broadcast before persisting — see setStatus: don't gate the released-version
  // pill on the serialized store-write chain.
  void store.upsertWorkspace(updated).catch((e) => alog.swallow("persist status", e));
  platform.broadcast('workspace:update', updated);
}

/** Reconciliation floor for the status dot: the agent's process is gone, so it
 *  cannot possibly still be `running`. Called from the PTY exit handler. This
 *  is the durability backstop that makes a lost terminal event self-heal — even
 *  if a `stop`/`notify` line were never delivered, the dot can never outlive the
 *  process.
 *
 *  Resolves to `idle` + the auto-unread bell, exactly like a normal turn-end:
 *  the process died with output the user never saw, which is precisely what
 *  `autoUnread` records. It must NOT resolve to `waiting` — that now means "the
 *  agent is blocked on your answer", and a dead process cannot be answered, so
 *  it would park a permanently-unanswerable row in the Needs-You inbox.
 *  A no-op when the workspace already left `running` via a real stop/notify. */
export function reconcileExited(id: string): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  // The agent process is gone, and a /loop's wakeups live inside it — clear
  // the loop marker regardless of status (a looping agent is usually `idle`,
  // sleeping until its next wakeup, so this must not hide behind the
  // `running` guard below).
  if (ws.loopingSince) void markLooping(id, false);
  if (ws.status !== 'running') return;
  const seen = platform.isFocused() && getActiveWorkspaceId() === id;
  void markAutoUnread(id, !seen);
  void setStatus(id, 'idle');
}

/** Restore `running` after a parked interactive tool call is answered (the
 *  structured/SDK path's inverse of {@link fireNeedsInput}). The agent stopped
 *  to ask; once the user replies it resumes work, so the dot must go back to
 *  green. Guarded to only act on the `waiting` we set when parking — never
 *  resurrect a session that legitimately reached `idle`/`stopped`, and a
 *  redundant call when already `running` is a no-op (`setStatus` short-circuits
 *  on an unchanged status). No toast/chime on this direction. */
export function resumeRunning(id: string): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'waiting') return;
  void setStatus(id, 'running');
}

/** Startup reconcile for keeper-hosted turns: a live detached keeper reports a
 *  turn genuinely in flight, but `store.load()` floored the persisted `running`
 *  to `idle` (its "no process can survive a restart" assumption predates the
 *  keeper). Lift exactly that case back to `running` so the sidebar shows the
 *  agent working WITHOUT attaching to it (the caller probes read-only — lazy
 *  reattach stays lazy). Guarded to only lift `idle`: never resurrect
 *  `error`/`stopped`, and a redundant call is a `setStatus` no-op. The bell is
 *  cleared too — "finished, unseen" cannot be true of a turn still in flight
 *  (the load migration may have minted it from a stale `waiting`), and
 *  `fireFinished` re-arms it when this turn really ends. The turn-end that
 *  resolves this restored `running` arrives through the surviving spool (the
 *  startup wipe keeps live keepers' spool + cursor, and the detached CLI's
 *  hooks keep appending). */
export function restoreRunningFromKeeper(id: string): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'idle') return;
  alog.info(`restoring running status from live keeper mid-turn ws=${id}`);
  if (ws.autoUnread) void markAutoUnread(id, false);
  // No tool name is knowable without attaching — label the gap as thinking,
  // exactly as `submit` does, so the tooltip reads "Agent is thinking…" until
  // the next spool pretool names the real tool.
  emitTool(id, THINKING_TOOL_LABEL);
  void setStatus(id, 'running');
}

/** Push the agent's currently-running tool (or null to clear) to the renderer.
 *  This is ephemeral UI state — it rides its own IPC channel rather than
 *  `Workspace.status`/the store so per-tool churn never writes store.json. */
function emitTool(id: string, tool: string | null): void {
  platform.broadcast('agent:tool', id, tool);
}

// Cap how much of a transcript we read. The context figure lives on the LAST
// assistant turn, which is at the file's tail, so we read the trailing slice
// rather than the whole JSONL — a long session's transcript is multi-MB and
// re-reading it on every posttool would be wasteful. 512 KiB comfortably holds
// the final few turns even when one carries a large tool result.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** The size of a Claude Code session's context window, in tokens, derived from
 *  its transcript. This is the figure the TUI's `/context` view shows as
 *  "used": on the most recent MAIN-CHAIN assistant message (sub-agent /
 *  sidechain turns don't count toward the parent's context), the sum of the
 *  three input components — fresh input, cache writes, and cache reads. Output
 *  tokens are excluded: they're what the model produced, not what's fed back in.
 *  Returns 0 when the newest relevant entry is a compaction boundary: the
 *  pre-compact assistant usage behind it is stale (compaction just shrank the
 *  live context), and the true post-compact size is unknown until the next
 *  assistant turn — 0 tells the caller "reset the badge" rather than
 *  resurfacing the pre-compact figure.
 *  Returns null when the transcript is missing/unreadable or has no usable
 *  assistant turn yet (e.g. the very first event of a brand-new session). */
async function computeContextTokens(transcriptPath: string): Promise<number | null> {
  let text: string;
  try {
    const handle = await fs.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null; // transcript not created yet, removed, or unreadable
  }
  // Walk lines newest-first; the first main-chain assistant turn we hit carries
  // the live context size. Reading from the tail means we stop almost
  // immediately. A leading partial line (we sliced mid-file) just fails to
  // parse and is skipped.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry: {
      type?: unknown;
      subtype?: unknown;
      isSidechain?: unknown;
      message?: { usage?: Record<string, unknown> };
    };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // A compaction boundary newer than any assistant turn means the context
    // was just rewritten: everything behind it is pre-compact and stale.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return 0;
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const tokens =
      num(usage.input_tokens) +
      num(usage.cache_creation_input_tokens) +
      num(usage.cache_read_input_tokens);
    return tokens > 0 ? tokens : null;
  }
  return null;
}

// The last context size pushed per workspace, so a recompute that lands on the
// same number (common on a posttool that didn't move the model) doesn't spam a
// redundant IPC message. Cleared lazily — a stale entry only costs one skipped
// no-op send.
const lastContext = new Map<string, number>();

/** Recompute a workspace's context size from its transcript and push it to the
 *  renderer if it changed. Like {@link emitTool}, the live figure is ephemeral UI
 *  state on its own IPC channel — so per-turn growth (every posttool) never
 *  writes store.json. The exception is `persist: true`, passed only at turn-end
 *  (`stop`/`notify`), which also stamps `Workspace.contextTokens` so the badge
 *  can be seeded at startup before any live event fires. That write is free: the
 *  turn-end status→`waiting` transition already saves the store, so we fold the
 *  token number into that same record rather than adding a write. No-ops when the
 *  hook carried no transcript path (legacy sessions). */
async function emitContext(
  id: string,
  transcriptPath: string | undefined,
  persist = false,
): Promise<void> {
  if (!transcriptPath) return;
  let tokens: number | null;
  try {
    tokens = await computeContextTokens(transcriptPath);
  } catch (e) {
    log.error(`activity: computeContextTokens failed for ${id}`, e);
    return;
  }
  if (tokens == null) return;
  // Persist the turn-end figure onto the workspace record so the sidebar badge
  // survives a restart. Only when it actually changed from what's stored, to keep
  // this a no-op when the cached value already matches (and so a `notify` right
  // after a `stop`, both turn-ends, doesn't double-write). `upsertWorkspace`
  // already runs on the status transition; this just carries one more field.
  // 0 is the "context reset by compaction" signal — drop the persisted figure
  // rather than storing a literal zero, so the startup seed shows no badge.
  if (persist) {
    const ws = store.getWorkspace(id);
    const persisted = tokens > 0 ? tokens : undefined;
    if (ws && !ws.archived && ws.contextTokens !== persisted) {
      void store.upsertWorkspace({ ...ws, contextTokens: persisted }).catch((e) => alog.swallow("persist contextTokens", e));
    }
  }
  if (lastContext.get(id) === tokens) return;
  lastContext.set(id, tokens);
  platform.broadcast('agent:context', id, tokens);
}

/** Force-clear a workspace's context badge without consulting the transcript.
 *  Used at SessionStart when the hook's `source` says the context was just
 *  discarded (`clear`) or rewritten (`compact`): the true new size is unknown
 *  until the next assistant turn, and for `clear` the fresh transcript may not
 *  even exist yet — so a recompute can't be trusted to notice the reset. Sends
 *  the 0 sentinel (renderer drops the badge) and drops the persisted figure. */
function resetContext(id: string): void {
  const ws = store.getWorkspace(id);
  if (ws && !ws.archived && ws.contextTokens != null) {
    void store.upsertWorkspace({ ...ws, contextTokens: undefined }).catch((e) => alog.swallow("clear contextTokens", e));
  }
  if (lastContext.get(id) === 0) return;
  lastContext.set(id, 0);
  platform.broadcast('agent:context', id, 0);
}

/** Apply one lifecycle event to a workspace's status. Fed by the durable spool
 *  tailer (with the per-tool `tool` for pretool/posttool) and, for legacy
 *  sessions, by the Unix-socket route via `dispatchHookEvent`. `setStatus`
 *  only writes the store on a real transition, so the idempotent `running`
 *  re-assertions on every pretool are free. */
export function applyAgentEvent(
  id: string,
  event: string,
  tool: string | undefined,
  transcript?: string,
  /** Why the turn ended, when the caller knows (the SDK path — see
   *  `sdkEventToStopReason`). The terminal/spool path passes nothing: Claude
   *  Code's Stop hook carries no reason field, so those events keep their
   *  previous behavior exactly. Only consulted for terminal events. */
  stopReason?: AgentStopReason,
  /** Loop level-signal from the Stop payload's `session_crons` (the CLI
   *  scheduler's own registry of pending ScheduleWakeup/CronCreate//loop
   *  tasks), reduced by the spool hook: 'none' = definitively nothing will
   *  wake this session, 'some' = a wakeup is armed, undefined = no opinion
   *  (older hook script/CLI, or a non-spool caller). Only consulted for
   *  turn-end events. */
  crons?: 'none' | 'some',
): void {
  alog.trace(`event ${event}${tool ? ` tool=${tool}` : ''} ws=${id}`);
  // Every lifecycle event — from either agent path — is "this workspace did
  // something", which is exactly what the hibernation sweeper measures idleness
  // against. Stamped for ALL events including unhandled ones: an event we don't
  // map to a status still proves the agent is alive, and treating it as silence
  // would make an unrecognized Claude Code hook look like an idle agent.
  noteActivity(id);
  switch (event) {
    case 'submit':
      // Same gap as `posttool`, at the other end: the prompt has been submitted
      // and the model is generating before any tool runs. That window is also
      // event-free, so label it rather than clearing.
      emitTool(id, THINKING_TOOL_LABEL);
      // `null` clears any stop-reason marker (#69): the agent is taking a turn,
      // so whatever ended the LAST one is no longer the workspace's state. Done
      // on the running transition rather than on the next turn-end so the badge
      // disappears the moment work resumes, not one turn later.
      // `true` = this is a TURN START (#88): stamps `lastTurnStartAt`, which
      // is what makes a queue-stall badge CLEAR the moment work resumes.
      void setStatus(id, 'running', null, true);
      break;
    case 'pretool':
      emitTool(id, tool ?? null);
      void setStatus(id, 'running', null, true);
      // A ScheduleWakeup call is the /loop skill re-arming its next iteration —
      // the observable that marks this workspace as LOOPING. Detected here
      // because this is the one chokepoint both agent paths cross with the
      // tool name in hand (spool hook line and SDK tool-use event alike). The
      // hook line carries no tool INPUT, so `stop: true` (loop termination) is
      // only visible on the SDK path — see agent-sdk.ts's emitFrom; a terminal
      // session's loop end is caught by session-clear/process-exit instead.
      if (tool === 'ScheduleWakeup') void markLooping(id, true);
      break;
    case 'posttool':
      // Stay running between tools. The label does NOT go blank here: what
      // follows a finished tool is the model generating its next step, and that
      // gap measured 2.5–6.5s on a live session with no lifecycle event in it —
      // the row read as frozen. Label it instead of clearing it, so the tooltip
      // says "Agent is thinking…" (statusGlyphTitle special-cases the sentinel)
      // rather than dropping to a bare "Agent is working…" for seconds at a
      // time. Status is untouched
      // (`running` either way) — see THINKING_TOOL_LABEL for why this is a label
      // and not a sixth status. Refresh the context-size badge here too so it
      // climbs live through a long turn, not only at turn-end.
      emitTool(id, THINKING_TOOL_LABEL);
      void emitContext(id, transcript);
      break;
    case 'stop':
    // Claude's `StopFailure` hook (turn ended on an API error) maps here too:
    // an error-terminated turn is still a turn-end, so the dot must leave
    // `running`. Without this the dot stuck on `running` after every rate-limit
    // / overload turn-end.
    case 'stopfail':
      emitTool(id, null);
      // Turn-end: persist the figure (piggybacks the status write fireFinished
      // is about to make) so the badge can be restored at next startup.
      void emitContext(id, transcript, true);
      // Loop badge, level-triggered: `session_crons` is the scheduler's own
      // answer to "will anything wake this session later?", delivered on every
      // turn-end. This is what makes the badge SELF-HEALING — a /loop that
      // dies by simply not re-arming (the dynamic-/loop norm) is cleared on
      // that very turn, where the transcript reconcile (loop-scan.ts) needs a
      // staleness window and the tool-call rules can't see "no call happened".
      // Applied BEFORE fireFinished so its looping-row toast/chime suppression
      // reads the fresh flag (markLooping mutates the in-memory store
      // synchronously). undefined = no opinion — never clear on absence.
      if (crons === 'none') void markLooping(id, false);
      else if (crons === 'some') void markLooping(id, true);
      // `stopfail` is itself a reason signal: the terminal path routes Claude
      // Code's StopFailure hook here and passes no explicit reason, so fall back
      // to 'error' for it. That keeps the two paths agreeing without the spool
      // hook needing a new field it cannot produce.
      fireFinished(id, stopReason ?? (event === 'stopfail' ? 'error' : undefined));
      break;
    case 'notify':
      emitTool(id, null);
      void emitContext(id, transcript, true);
      fireNeedsInput(id);
      break;
    case 'session':
      // SessionStart. The `tool` slot carries the hook payload's `source`
      // (startup | resume | clear | compact). clear/compact just invalidated
      // the persisted context figure — without this the badge kept showing the
      // pre-compact size (e.g. 288k) while the TUI statusline showed ~0% until
      // the next turn ended. startup/resume instead refresh the badge from the
      // (existing) transcript, which still carries a valid last-turn figure.
      if (tool === 'clear' || tool === 'compact') {
        resetContext(id);
        // A cleared session dropped its conversation — any /loop that lived in
        // it is gone with it (a compact keeps the conversation, so the loop
        // survives that).
        if (tool === 'clear') void markLooping(id, false);
      } else {
        void emitContext(id, transcript, true);
      }
      break;
    default:
      // An event name we don't handle falls through to NOTHING — the status
      // simply never moves, which surfaces as a stuck dot with no other clue.
      // A Claude Code upgrade renaming/adding a hook event is exactly how this
      // happens, so name the unknown event rather than ignoring it silently.
      alog.warn(`unhandled agent event "${event}" (ws=${id}) — status unchanged`);
  }
}

/** Legacy Unix-socket entry point (hooks-server `/event` route). Pre-upgrade
 *  workspaces still POST bare `{id, event}` here until their hooks are
 *  rewritten on the next pty:start; they carry no per-tool detail. */
export function dispatchHookEvent(id: string, event: string): void {
  applyAgentEvent(id, event, undefined);
}
