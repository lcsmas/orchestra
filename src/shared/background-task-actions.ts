// Pure decision logic for the Background-tasks panel's actions (#19) — kept out
// of the component so it is testable without a renderer, per the repo's
// "pure logic lives in src/shared/" convention.
//
// The whole point of this module is that a KILL IS A REQUEST, NOT A STATE
// CHANGE. `Query.stopTask()` resolves as soon as the CLI accepts the request;
// the task is only actually dead once the CLI says so — via a
// `task_notification { status: 'stopped' }` or by dropping the id from the
// `background_tasks_changed` level set. Both arrive through the ordinary event
// fold, so `BackgroundTask.status` remains the single source of truth for
// whether a task is running.
//
// If the panel instead flipped the card to "Stopped" on click, "the button
// worked" and "the task died" would produce identical UI — the exact
// indistinguishability this issue's acceptance gate exists to rule out. So the
// click records only a REQUESTED marker, which is rendered as a distinct
// pending affordance and is superseded the moment real state lands.

import type { AgentSession, BackgroundTask } from './types';

/** What the Stop control on a task card should do/show right now. */
export type StopButtonState =
  /** Task is running and no stop has been requested — an armed Stop button. */
  | 'stoppable'
  /** A stop was requested and the CLI has not reported a terminal state yet.
   *  Disabled + "Stopping…": the request is in flight, not the outcome. */
  | 'stopping'
  /** Task already reached a terminal state — no control at all. */
  | 'settled';

/** Decide the Stop control's state for one task.
 *
 *  `requested` is the set of task ids the user has clicked Stop on this session
 *  (renderer-local; it does not survive a reload, which is correct — a stale
 *  "Stopping…" must never outlive the evidence for it).
 *
 *  Terminal state ALWAYS wins over a pending request: once the CLI reports the
 *  task settled, the card shows the real outcome even if the request set still
 *  holds the id. That ordering is what makes the request marker unable to mask
 *  a task that never actually died — it can only ever be shown while the task
 *  is genuinely still running. */
export function stopButtonState(
  task: Pick<BackgroundTask, 'id' | 'status'>,
  requested: ReadonlySet<string>,
): StopButtonState {
  if (task.status !== 'running') return 'settled';
  return requested.has(task.id) ? 'stopping' : 'stoppable';
}

/** Prune a stop-request set down to the ids that are still running.
 *
 *  Called whenever the folded task set changes, so a request marker is dropped
 *  the instant its task settles (or disappears entirely). Without this, a card
 *  that stopped and a card whose stop request was simply forgotten would both
 *  read "Stopping…" forever.
 *
 *  Returns the SAME set instance when nothing needed pruning, so a React
 *  `setState` can skip a needless re-render. */
export function pruneStopRequests(
  requested: ReadonlySet<string>,
  tasks: Record<string, Pick<BackgroundTask, 'status'>>,
): ReadonlySet<string> {
  if (requested.size === 0) return requested;
  let changed = false;
  const next = new Set<string>();
  for (const id of requested) {
    if (tasks[id]?.status === 'running') next.add(id);
    else changed = true;
  }
  return changed ? next : requested;
}

/** Whether the "Run in background" (Ctrl+B parity) action is offered.
 *
 *  `Query.backgroundTasks()` moves in-flight FOREGROUND work into the
 *  background, so it is only meaningful while a turn is actually running. With
 *  no turn in flight there is nothing to background and the SDK would simply
 *  answer `false`; offering a control that can only no-op is worse than
 *  offering none, so the panel hides it.
 *
 *  Note this deliberately does NOT require `session.tasks` to be non-empty:
 *  the work being backgrounded is FOREGROUND work, which by definition has not
 *  produced a background-task card yet. Gating on the task set would hide the
 *  control in exactly the case it exists for. */
export function canBackgroundForegroundWork(
  session: Pick<AgentSession, 'running'> | undefined,
): boolean {
  return !!session?.running;
}
