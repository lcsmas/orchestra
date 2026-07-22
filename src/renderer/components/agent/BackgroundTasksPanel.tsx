// Background tasks panel for the structured agent view — a right-side
// slide-over that lists the Task-tool subagents (and shells/monitors/workflows)
// the current session has spawned, mirroring the Claude Desktop app. Each card
// live-updates from the SDK's task lifecycle events (folded into
// `AgentSession.tasks`): description, elapsed time, token count, tool-use count,
// last tool, and a "View transcript" link for finished tasks.
//
// Pure presentational: it reads `session.tasks` (the fold's projection) and
// calls back for open/close and transcript-open. The elapsed timer is the only
// local state — a 1s tick that re-renders running cards so their age advances
// (frozen once a task ends).

import { useEffect, useState } from 'react';
import type { AgentSession, BackgroundTask } from '../../../shared/types';

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
}: {
  task: BackgroundTask;
  now: number;
  onOpenTranscript: (path: string) => void;
}) {
  const usage = task.usage;
  const elapsed = formatElapsed(taskElapsedMs(task, now));
  return (
    <div className="av-bgtask-card" data-status={task.status}>
      <div className="av-bgtask-card-head">
        <span className="av-bgtask-title" title={taskTitle(task)}>
          {taskTitle(task)}
        </span>
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
            onClick={() => onOpenTranscript(task.outputFile as string)}
          >
            View transcript
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
  onClose,
}: {
  session: AgentSession | undefined;
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

  const openTranscript = (path: string) => {
    void window.orchestra.agentSdkOpenTaskTranscript(path);
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
                  <TaskCard key={t.id} task={t} now={now} onOpenTranscript={openTranscript} />
                ))}
              </section>
            )}
            {finished.length > 0 && (
              <section className="av-bgtask-group">
                <div className="av-bgtask-group-head">
                  Finished <span className="av-bgtask-group-count">{finished.length}</span>
                </div>
                {finished.map((t) => (
                  <TaskCard key={t.id} task={t} now={now} onOpenTranscript={openTranscript} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
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
