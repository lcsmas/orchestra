// Background tasks panel for the structured agent view — a right-side
// slide-over that lists the Task-tool subagents (and shells/monitors/workflows)
// the current session has spawned, mirroring the Claude Desktop app. Each card
// live-updates from the SDK's task lifecycle events (folded into
// `AgentSession.tasks`): description, elapsed time, token count, tool-use count,
// last tool, and a "View transcript" link for finished tasks.
//
// It reads `session.tasks` (the fold's projection) and calls back for
// open/close and transcript-open. Two actions reach the SDK (#19):
//
//  • Stop — `Query.stopTask()` via `agentSdkStopTask`. The click records only a
//    REQUEST; the card is flipped by the CLI's own `task_notification`
//    (status 'stopped') or by the id leaving the `background_tasks_changed`
//    level set, both through the ordinary fold. So a settled card is evidence
//    the task actually died, never merely that the button was pressed. The
//    request/state decision lives in shared/background-task-actions.ts.
//
//  • Run in background — `Query.backgroundTasks()` via `agentSdkBackgroundTasks`,
//    the SDK's Ctrl+B parity: it moves in-flight FOREGROUND work into the
//    background. It is NOT a state query (no state-returning background-task
//    method exists on the SDK Query interface at 0.3.241); live state comes
//    only from the organic level signal.
//
// Local state is the 1s elapsed tick and the pending stop-request set (pruned
// against the folded task set, so a "Stopping…" marker cannot outlive its
// evidence).

import { useEffect, useState } from 'react';
import type { AgentSession, BackgroundTask } from '../../../shared/types';
import {
  canBackgroundForegroundWork,
  pruneStopRequests,
  stopButtonState,
  type StopButtonState,
} from '../../../shared/background-task-actions';

/** k/M token formatter (mirrors TurnFooter.formatTokens / AccountBadge). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Compact elapsed formatter: 8s · 1m 12s · 1h 3m. */
function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Elapsed for a task: live (now − startedAt) while running, else the frozen
 *  span — the SDK-reported durationMs when present, else endedAt − startedAt. */
function taskElapsedMs(task: BackgroundTask, now: number): number {
  if (task.status === 'running') return now - task.startedAt;
  if (task.usage?.durationMs != null) return task.usage.durationMs;
  if (task.endedAt != null) return task.endedAt - task.startedAt;
  return 0;
}

const STATUS_LABEL: Record<BackgroundTask['status'], string> = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** Title for a task: its description, or a type-derived fallback. */
function taskTitle(task: BackgroundTask): string {
  if (task.description) return task.description;
  if (task.subagentType) return task.subagentType;
  if (task.taskType) return task.taskType;
  return 'Task';
}

/** Sub-label under the title: the SDK agent/task type — "Agent", "Shell", … */
function taskKindLabel(task: BackgroundTask): string {
  const t = task.taskType ?? (task.subagentType ? 'subagent' : undefined);
  switch (t) {
    case 'subagent':
      return 'Agent';
    case 'shell':
      return 'Shell';
    case 'monitor':
      return 'Monitor';
    case 'workflow':
      return 'Workflow';
    default:
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Task';
  }
}

function TaskCard({
  task,
  now,
  onOpenTranscript,
  transcriptMissing = false,
  stopState,
  onStop,
}: {
  task: BackgroundTask;
  now: number;
  onOpenTranscript: (path: string) => void;
  /** True when a prior open attempt reported the transcript file missing. */
  transcriptMissing?: boolean;
  /** Whether this card offers a Stop control, shows a pending request, or
   *  neither — decided by `stopButtonState` against the FOLDED status. */
  stopState: StopButtonState;
  onStop: (taskId: string) => void;
}) {
  const usage = task.usage;
  const elapsed = formatElapsed(taskElapsedMs(task, now));
  return (
    <div className="av-bgtask-card" data-status={task.status}>
      <div className="av-bgtask-card-head">
        <span className="av-bgtask-title" title={taskTitle(task)}>
          {taskTitle(task)}
        </span>
        {/* Kill control. Present only while the task is genuinely running:
            'settled' renders nothing, so a finished card carries no action
            that could imply the outcome is still in the user's hands. While a
            request is in flight the button is DISABLED and reads "Stopping…" —
            deliberately not "Stopped", which is a claim only the CLI gets to
            make. */}
        {stopState !== 'settled' && (
          <button
            type="button"
            className="av-bgtask-stop"
            data-state={stopState}
            disabled={stopState === 'stopping'}
            onClick={() => onStop(task.id)}
            aria-label={
              stopState === 'stopping'
                ? `Stopping ${taskTitle(task)}`
                : `Stop ${taskTitle(task)}`
            }
            title={
              stopState === 'stopping'
                ? 'Stop requested — waiting for the task to end'
                : 'Stop this background task'
            }
          >
            {stopState === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <span
          className="av-bgtask-status-dot"
          data-status={task.status}
          aria-hidden="true"
        />
      </div>
      <div className="av-bgtask-meta">
        <span className="av-bgtask-kind">{taskKindLabel(task)}</span>
        <span className="av-bgtask-elapsed" title={STATUS_LABEL[task.status]}>
          {elapsed}
        </span>
      </div>
      {/* The summary line — present only when agentProgressSummaries surfaced one. */}
      {task.summary && task.status === 'running' && (
        <div className="av-bgtask-summary" title={task.summary}>
          {task.summary}
        </div>
      )}
      <div className="av-bgtask-stats">
        {usage && (usage.totalTokens > 0 || usage.toolUses > 0) && (
          <>
            <span className="av-bgtask-stat">{formatTokens(usage.totalTokens)} tokens</span>
            <span className="av-bgtask-stat">
              {usage.toolUses} {usage.toolUses === 1 ? 'tool use' : 'tool uses'}
            </span>
          </>
        )}
        {task.lastToolName && task.status === 'running' && (
          <span className="av-bgtask-stat av-bgtask-lasttool">{task.lastToolName}</span>
        )}
        {task.outputFile && (
          <button
            type="button"
            className="av-bgtask-transcript"
            disabled={transcriptMissing}
            title={transcriptMissing ? 'The transcript file is missing or was removed' : undefined}
            onClick={() => onOpenTranscript(task.outputFile as string)}
          >
            {transcriptMissing ? 'Transcript unavailable' : 'View transcript'}
          </button>
        )}
      </div>
    </div>
  );
}

/** The panel body — Running and Finished groups. Exported for the header count
 *  and for direct testing/reuse. */
export function BackgroundTasksPanel({
  session,
  workspaceId,
  onClose,
}: {
  session: AgentSession | undefined;
  /** Needed for the two SDK-reaching actions (stop / background) — the panel is
   *  otherwise a pure projection of `session`. */
  workspaceId: string;
  onClose: () => void;
}) {
  // A 1s tick advances the live elapsed on running cards. Only runs while there
  // is at least one running task, so a settled panel costs nothing.
  const tasks = session ? Object.values(session.tasks) : [];
  const running = tasks.filter((t) => t.status === 'running');
  const finished = tasks.filter((t) => t.status !== 'running');
  const hasRunning = running.length > 0;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Task ids the user has clicked Stop on whose task has NOT yet been reported
  // settled by the CLI. Renderer-local and deliberately non-persistent: a
  // "Stopping…" marker must never outlive the evidence for it, so a reload
  // clears it and the card falls back to whatever the fold actually says.
  const [stopRequested, setStopRequested] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Prune the request set against the folded tasks on every change, so a marker
  // disappears the moment its task reaches a terminal state OR leaves the live
  // set entirely (`background_tasks_changed` has replace-semantics, so a task
  // can vanish without a terminal notification for that id). `pruneStopRequests`
  // returns the same instance when nothing changed, so this cannot loop.
  const sessionTasks = session?.tasks;
  useEffect(() => {
    setStopRequested((prev) => pruneStopRequests(prev, sessionTasks ?? {}));
  }, [sessionTasks]);

  // Kill a running task. Marks the request first so the button disables
  // immediately (a second click would be a duplicate stopTask), then calls the
  // SDK. On a rejected request the marker is rolled back so the control re-arms
  // rather than sticking on "Stopping…" for a task that was never asked to die;
  // main has already surfaced the reason as a warning notice.
  const stopTask = (taskId: string) => {
    setStopRequested((prev) => new Set(prev).add(taskId));
    void window.orchestra
      .agentSdkStopTask(workspaceId, taskId)
      .then((accepted) => {
        if (!accepted) {
          setStopRequested((prev) => {
            const next = new Set(prev);
            next.delete(taskId);
            return next;
          });
        }
      })
      .catch(() => {
        setStopRequested((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      });
  };

  // Ctrl+B parity: move the in-flight FOREGROUND work into the background. No
  // toolUseId — this backgrounds everything currently blocking the turn, which
  // is what the terminal's Ctrl+B does. Offered only while a turn runs (there is
  // nothing to background otherwise), and the resulting task appears as a card
  // via the organic event stream, so no local state is invented here.
  const canBackground = canBackgroundForegroundWork(session);
  const backgroundForegroundWork = () => {
    void window.orchestra.agentSdkBackgroundTasks(workspaceId).catch(() => {});
  };

  // Track transcript paths whose open FAILED (file missing/moved) so the click
  // gives feedback instead of doing nothing — the handler returns false then.
  const [missingTranscripts, setMissingTranscripts] = useState<Set<string>>(() => new Set());
  const openTranscript = (path: string) => {
    void window.orchestra
      .agentSdkOpenTaskTranscript(path)
      .then((ok) => {
        if (!ok) setMissingTranscripts((prev) => new Set(prev).add(path));
      })
      .catch(() => setMissingTranscripts((prev) => new Set(prev).add(path)));
  };

  return (
    <div className="av-bgtask-panel" role="complementary" aria-label="Background tasks">
      <div className="av-bgtask-panel-head">
        <span className="av-bgtask-panel-title">Background tasks</span>
        <button
          type="button"
          className="av-bgtask-panel-close"
          onClick={onClose}
          aria-label="Close background tasks"
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="av-bgtask-panel-body">
        {tasks.length === 0 ? (
          <div className="av-bgtask-empty">
            No background tasks yet. Tasks the agent spawns (via the Task tool)
            appear here.
          </div>
        ) : (
          <>
            {running.length > 0 && (
              <section className="av-bgtask-group">
                <div className="av-bgtask-group-head">
                  Running <span className="av-bgtask-group-count">{running.length}</span>
                </div>
                {running.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    now={now}
                    onOpenTranscript={openTranscript}
                    transcriptMissing={!!t.outputFile && missingTranscripts.has(t.outputFile)}
                    stopState={stopButtonState(t, stopRequested)}
                    onStop={stopTask}
                  />
                ))}
              </section>
            )}
            {finished.length > 0 && (
              <section className="av-bgtask-group">
                <div className="av-bgtask-group-head">
                  Finished <span className="av-bgtask-group-count">{finished.length}</span>
                </div>
                {finished.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    now={now}
                    onOpenTranscript={openTranscript}
                    transcriptMissing={!!t.outputFile && missingTranscripts.has(t.outputFile)}
                    stopState={stopButtonState(t, stopRequested)}
                    onStop={stopTask}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
      {/* Ctrl+B parity. Lives in a footer rather than on a card because it acts
          on FOREGROUND work — work that by definition has no background card
          yet, which is exactly why the control is not gated on the task list. */}
      {canBackground && (
        <div className="av-bgtask-panel-foot">
          <button
            type="button"
            className="av-bgtask-background-now"
            onClick={backgroundForegroundWork}
            title="Move the work blocking the current turn into the background (Ctrl+B parity)"
          >
            Run current work in background
          </button>
        </div>
      )}
    </div>
  );
}

/** The number of tasks currently running — for the toolbar toggle badge. */
export function runningTaskCount(session: AgentSession | undefined): number {
  if (!session) return 0;
  let n = 0;
  for (const t of Object.values(session.tasks)) if (t.status === 'running') n++;
  return n;
}

/** Total tasks the session has (running + finished) — drives whether the
 *  toolbar toggle is worth showing at all. */
export function totalTaskCount(session: AgentSession | undefined): number {
  return session ? Object.keys(session.tasks).length : 0;
}
