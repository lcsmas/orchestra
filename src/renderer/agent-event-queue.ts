/**
 * RAF-batched sink for the `agent:event` channel (the structured agent view).
 *
 * Modeled on `term-write-queue.ts`. `agent:event` is the hottest main→renderer
 * channel in the structured view — streaming `text-delta`s can fire dozens of
 * times per assistant turn, and every event shares the one ordered IPC channel
 * with the status dot and everything else. Folding each delta into the store
 * with its own `setState` would trigger a React re-render per token and jank
 * the message list.
 *
 * So incoming events are ACCUMULATED per animation frame and flushed in one
 * batch: the flusher hands the whole frame's slice of events to a single
 * `foldEvents(session, events)` call (pure, immutable — src/shared/agent-events.ts),
 * producing ONE store commit per frame regardless of how many deltas landed.
 * Ordering is preserved (events flush in arrival order), and events for
 * different workspaces are kept in separate buckets so one session's flood
 * can't reorder another's stream.
 *
 * A latency fast path mirrors term-write-queue: the first event arriving into
 * an idle queue schedules a frame; a burst within that frame coalesces. There
 * is no byte budget here — an AgentEvent is small and `foldEvents` is O(events);
 * the win is purely collapsing N setStates into one per frame.
 */

import type { AgentEvent } from '../shared/types';

/** What the queue flushes each frame: the workspace it belongs to and the
 *  ordered events that arrived for it since the last flush. The consumer folds
 *  `events` into that workspace's session in a single store commit. */
export interface AgentEventBatch {
  workspaceId: string;
  events: AgentEvent[];
}

export interface AgentEventQueue {
  /** Enqueue one event for a workspace; schedules a frame flush if idle. */
  push(workspaceId: string, event: AgentEvent): void;
  /** Flush everything pending immediately (e.g. before teardown) and cancel
   *  any scheduled frame. */
  flushNow(): void;
  /** Drop everything pending and cancel any scheduled frame — used when the
   *  view unmounts so stale events can't commit against a gone session. */
  reset(): void;
}

/** Scheduling seam. Browser callers use the default (requestAnimationFrame);
 *  tests inject a fake so batching can be driven deterministically under node. */
export interface AgentEventQueueOpts {
  schedule?: (cb: () => void) => number;
  cancel?: (id: number) => void;
}

export function createAgentEventQueue(
  /** Called once per frame with each workspace's coalesced events, in the
   *  order the workspaces first appeared this frame. */
  flush: (batches: AgentEventBatch[]) => void,
  opts?: AgentEventQueueOpts,
): AgentEventQueue {
  const schedule = opts?.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancel = opts?.cancel ?? ((id: number) => cancelAnimationFrame(id));

  // Insertion-ordered map: workspace id → its events this frame. A Map keeps
  // first-seen workspace order stable so the flush is deterministic, and lets
  // events for the same workspace stay contiguous and in arrival order.
  let pending = new Map<string, AgentEvent[]>();
  let scheduled: number | null = null;

  const drain = () => {
    scheduled = null;
    if (pending.size === 0) return;
    const batches: AgentEventBatch[] = [];
    for (const [workspaceId, events] of pending) {
      batches.push({ workspaceId, events });
    }
    // Reset BEFORE flushing so a re-entrant push() during the flush (a store
    // subscriber that somehow enqueues) starts a fresh frame rather than
    // mutating the batch we're handing out.
    pending = new Map();
    flush(batches);
  };

  return {
    push(workspaceId: string, event: AgentEvent) {
      const bucket = pending.get(workspaceId);
      if (bucket) bucket.push(event);
      else pending.set(workspaceId, [event]);
      if (scheduled === null) scheduled = schedule(drain);
    },
    flushNow() {
      if (scheduled !== null) {
        cancel(scheduled);
        scheduled = null;
      }
      drain();
    },
    reset() {
      pending = new Map();
      if (scheduled !== null) {
        cancel(scheduled);
        scheduled = null;
      }
    },
  };
}
