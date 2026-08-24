// Unit tests for the Background-tasks panel's pure action logic (#19).
//
// The load-bearing property under test is that a KILL REQUEST NEVER MASQUERADES
// AS A KILL: `stopButtonState` may only ever return 'stopping' for a task the
// folded state still reports as `running`, and a request marker is pruned the
// instant real terminal state lands. If that ever inverted, a card reading
// "Stopped" would prove only that the button was clicked — which is exactly the
// evidence this feature must not fabricate.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stopButtonState,
  pruneStopRequests,
  canBackgroundForegroundWork,
} from './background-task-actions.ts';
import type { BackgroundTask } from './types.ts';

function task(id: string, status: BackgroundTask['status']): Pick<BackgroundTask, 'id' | 'status'> {
  return { id, status };
}

// ─── stopButtonState ────────────────────────────────────────────────────────

test('stopButtonState: a running task with no request is stoppable', () => {
  assert.equal(stopButtonState(task('t1', 'running'), new Set()), 'stoppable');
});

test('stopButtonState: a running task with a pending request is stopping', () => {
  assert.equal(stopButtonState(task('t1', 'running'), new Set(['t1'])), 'stopping');
});

test('stopButtonState: only the requested task shows stopping', () => {
  const requested = new Set(['t1']);
  assert.equal(stopButtonState(task('t1', 'running'), requested), 'stopping');
  assert.equal(stopButtonState(task('t2', 'running'), requested), 'stoppable');
});

for (const status of ['completed', 'failed', 'stopped'] as const) {
  test(`stopButtonState: a ${status} task is settled (no control)`, () => {
    assert.equal(stopButtonState(task('t1', status), new Set()), 'settled');
  });

  // THE key assertion: real terminal state OUTRANKS a lingering request, so a
  // pending marker can never be shown over a task the CLI has settled.
  test(`stopButtonState: ${status} outranks a still-pending stop request`, () => {
    assert.equal(stopButtonState(task('t1', status), new Set(['t1'])), 'settled');
  });
}

// ─── pruneStopRequests ──────────────────────────────────────────────────────

test('pruneStopRequests: an empty set is returned as-is (same instance)', () => {
  const empty = new Set<string>();
  assert.equal(pruneStopRequests(empty, {}), empty);
});

test('pruneStopRequests: keeps ids whose task is still running (same instance)', () => {
  const requested = new Set(['t1']);
  const out = pruneStopRequests(requested, { t1: { status: 'running' } });
  assert.equal(out, requested, 'no change should reuse the instance so React can skip a render');
});

test('pruneStopRequests: drops an id once its task settles', () => {
  const out = pruneStopRequests(new Set(['t1', 't2']), {
    t1: { status: 'stopped' },
    t2: { status: 'running' },
  });
  assert.deepEqual([...out], ['t2']);
});

test('pruneStopRequests: drops an id whose task vanished from the set entirely', () => {
  // `background_tasks_changed` has replace-semantics, so a task can leave the
  // live set without ever producing a terminal notification for this id.
  const out = pruneStopRequests(new Set(['gone']), {});
  assert.deepEqual([...out], []);
});

test('pruneStopRequests: drops completed and failed, not just stopped', () => {
  const out = pruneStopRequests(new Set(['a', 'b', 'c']), {
    a: { status: 'completed' },
    b: { status: 'failed' },
    c: { status: 'running' },
  });
  assert.deepEqual([...out], ['c']);
});

// ─── canBackgroundForegroundWork ────────────────────────────────────────────

test('canBackgroundForegroundWork: offered only while a turn is in flight', () => {
  assert.equal(canBackgroundForegroundWork({ running: true }), true);
  assert.equal(canBackgroundForegroundWork({ running: false }), false);
});

test('canBackgroundForegroundWork: no session means nothing to background', () => {
  assert.equal(canBackgroundForegroundWork(undefined), false);
});

// ─── integration with the event fold ────────────────────────────────────────
//
// A kill is only real once the CLI reports it. These exercise the two routes it
// can arrive by, and assert that in BOTH the pending marker clears and the card
// reports a terminal state — i.e. the UI's "Stopped" is always downstream of the
// CLI, never of the click.

import { foldEvent, emptySession } from './agent-events.ts';
import type { AgentEvent } from './types.ts';

function taskEv(over: Partial<Extract<AgentEvent, { type: 'task' }>>): AgentEvent {
  return { type: 'task', kind: 'started', seq: 0, at: 1000, ...over } as AgentEvent;
}

test('kill path: task_notification(stopped) settles the card and clears the request', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEv({ kind: 'started', taskId: 't1', description: 'sleep 90' }));

  // User clicks Stop: request recorded, card still running → "Stopping…".
  let requested: ReadonlySet<string> = new Set(['t1']);
  assert.equal(stopButtonState(s.tasks.t1, requested), 'stopping');

  // The CLI answers stopTask with its own terminal notification.
  s = foldEvent(s, taskEv({ seq: 1, at: 5000, kind: 'notification', taskId: 't1', status: 'stopped' }));
  requested = pruneStopRequests(requested, s.tasks);

  assert.equal(s.tasks.t1.status, 'stopped');
  assert.equal(s.tasks.t1.endedAt, 5000);
  assert.equal(requested.size, 0, 'the pending marker clears once real state lands');
  assert.equal(stopButtonState(s.tasks.t1, requested), 'settled');
});

test('kill path: the level signal alone settles the card and clears the request', () => {
  // `background_tasks_changed` has replace-semantics, so a killed task can drop
  // out of the live set with no terminal notification for its id at all.
  let s = emptySession('ws');
  s = foldEvent(s, taskEv({ kind: 'started', taskId: 't1', description: 'sleep 90' }));
  s = foldEvent(s, taskEv({ seq: 1, kind: 'started', taskId: 't2', description: 'other' }));

  let requested: ReadonlySet<string> = new Set(['t1']);
  assert.equal(stopButtonState(s.tasks.t1, requested), 'stopping');

  s = foldEvent(s, taskEv({ seq: 2, at: 7000, kind: 'changed', liveIds: ['t2'] }));
  requested = pruneStopRequests(requested, s.tasks);

  assert.equal(s.tasks.t1.status, 'stopped');
  assert.equal(requested.size, 0);
  assert.equal(stopButtonState(s.tasks.t1, requested), 'settled');
  // The untouched sibling keeps its armed Stop control.
  assert.equal(stopButtonState(s.tasks.t2, requested), 'stoppable');
});

test('kill path: a request on a task that keeps running stays pending (no false settle)', () => {
  // The negative control for the two tests above: without a CLI-side terminal
  // signal the marker must NOT clear, or "Stopping…" would silently resolve
  // itself and the UI would imply an outcome nobody reported.
  let s = emptySession('ws');
  s = foldEvent(s, taskEv({ kind: 'started', taskId: 't1', description: 'stubborn' }));
  let requested: ReadonlySet<string> = new Set(['t1']);

  // Progress keeps arriving — the task ignored/has not yet honored the stop.
  s = foldEvent(s, taskEv({ seq: 1, at: 3000, kind: 'progress', taskId: 't1', lastToolName: 'Bash' }));
  requested = pruneStopRequests(requested, s.tasks);

  assert.equal(s.tasks.t1.status, 'running');
  assert.equal(requested.size, 1);
  assert.equal(stopButtonState(s.tasks.t1, requested), 'stopping');
});
