import React, { useState } from 'react';
import type { RenderMessage } from '../../../shared/types';
import type { TaskNotice } from '../../../shared/task-notices';
import { describeTaskNoticeRun } from '../../../shared/task-notices';
import { MarkdownView } from './MarkdownView';

/** One parsed avis de tâche plus the message it came from. */
export interface TaskNoticeItem {
  message: RenderMessage;
  notice: TaskNotice;
}

interface Props {
  items: TaskNoticeItem[];
  /** Start expanded — for the SSR render smoke only (see PeerMessageGroup). */
  defaultOpen?: boolean;
}

const ICON: Record<TaskNotice['tone'], string> = { ok: '✓', fail: '✗', stopped: '■', event: '◆' };

function Caret({ open }: { open: boolean }) {
  return (
    <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5.5 3 10.5 8 5.5 13" />
      </svg>
    </span>
  );
}

function openOutput(path: string) {
  void window.orchestra.agentSdkOpenTaskTranscript(path).catch(() => undefined);
}

/** The expanded body: what the human actually wants from the notice (agent
 *  result, full event / failure reason), then the model-facing note folded. */
function NoticeBody({ n }: { n: TaskNotice }) {
  const full = n.reason ?? (n.event && n.event !== n.detail ? n.event : undefined);
  return (
    <div className="av-tnotice-body">
      {n.result ? (
        <div className="av-tnotice-result av-md">
          <MarkdownView text={n.result} done />
        </div>
      ) : null}
      {full ? <pre className="av-tnotice-pre">{full}</pre> : null}
      <div className="av-tnotice-facts">
        {n.taskIds.length > 0 ? <span>task {n.taskIds.join(', ')}</span> : null}
        {n.worktree ? <span title={n.worktree}>worktree</span> : null}
        {n.outputFile ? (
          <button type="button" className="av-tnotice-open" onClick={() => openOutput(n.outputFile as string)}>
            Open output
          </button>
        ) : null}
      </div>
      {n.note ? (
        <details className="av-tnotice-note">
          <summary>Note to the agent</summary>
          <p>{n.note}</p>
        </details>
      ) : null}
    </div>
  );
}

function hasBody(n: TaskNotice): boolean {
  return !!(n.result || n.reason || n.event || n.note || n.outputFile || n.taskIds.length);
}

/** One avis de tâche as a quiet line; expands to its body. */
export function TaskNoticeRow({ item, defaultOpen = false }: { item: TaskNoticeItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const n = item.notice;
  const expandable = hasBody(n);
  return (
    <div className={`av-tnotice ${open ? 'av-open' : 'av-closed'}`} data-task-notice={n.tone} data-kind={n.kind}>
      <button
        type="button"
        className="av-tnotice-header"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        {expandable ? <Caret open={open} /> : <span className="av-caret" aria-hidden />}
        <span className="av-tnotice-icon" aria-hidden>
          {ICON[n.tone]}
        </span>
        <span className="av-tnotice-label">{n.label}</span>
        {n.detail ? <span className="av-tnotice-detail">— {n.detail}</span> : null}
        {n.meta.length > 0 ? <span className="av-tnotice-meta">{n.meta.join(' · ')}</span> : null}
      </button>
      {open && expandable ? <NoticeBody n={n} /> : null}
    </div>
  );
}

/**
 * A run of consecutive avis de tâche (#273). One notice renders as its own
 * quiet row; two or more collapse behind "N task notices · K failed" — the
 * failure count stays on the collapsed line so a failure is never folded away.
 * Same idiom as PeerMessageGroup (#56); expansion is per-mount view state.
 */
function TaskNoticeGroupImpl({ items, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 1) return <TaskNoticeRow item={items[0]} defaultOpen={defaultOpen} />;
  const { label, failed } = describeTaskNoticeRun(items.map((i) => i.notice));
  return (
    <div className={`av-tnotice-run ${open ? 'av-open' : 'av-closed'}`} data-task-notice-run={items.length}>
      <button type="button" className="av-tnotice-header" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Caret open={open} />
        <span className="av-tnotice-label">{label}</span>
        {failed > 0 ? <span className="av-tnotice-failed">· {failed} failed</span> : null}
      </button>
      {open ? (
        <div className="av-tnotice-run-body">
          {items.map((it) => (
            <TaskNoticeRow key={it.message.id} item={it} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function areEqual(a: Props, b: Props): boolean {
  if (a.items.length !== b.items.length || a.defaultOpen !== b.defaultOpen) return false;
  for (let i = 0; i < a.items.length; i++) {
    if (a.items[i].message.id !== b.items[i].message.id || a.items[i].message.text !== b.items[i].message.text) return false;
  }
  return true;
}

export const TaskNoticeGroup = React.memo(TaskNoticeGroupImpl, areEqual);
