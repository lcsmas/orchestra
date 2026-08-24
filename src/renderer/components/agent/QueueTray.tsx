import { useEffect, useRef, useState } from 'react';
import type { AgentQueuedPrompt } from '../../../shared/types';

/** The queue tray — prompts parked behind the in-flight turn, sitting between
 *  the transcript and the composer.
 *
 *  Why a dedicated strip rather than ghost bubbles in the transcript: the
 *  transcript SCROLLS, so a queued prompt can sit off-screen exactly when the
 *  user wants to cancel it (measured on the UI prototype — the third of three
 *  queued messages was already out of view). Docked above the composer, the
 *  queue is always visible and always the same distance from the send button.
 *
 *  Delivery order is the list order, top-first. The header states the resulting
 *  turn count in words because "3 queued" alone doesn't say whether that's three
 *  turns or one — which is the whole point of merging. */
export interface QueueTrayProps {
  queued: AgentQueuedPrompt[];
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onCoalesce: (id: string, on: boolean) => void;
  onMergeAll: () => void;
}

/** How many turns this queue will produce — a run of merged entries collapses
 *  into one. Mirrors `promptStream`'s coalesce loop; kept in sync by the tests
 *  in agent-components.test.ts. */
export function turnCount(queued: AgentQueuedPrompt[]): number {
  if (queued.length === 0) return 0;
  // Every entry starts a turn unless the entry BEFORE it merged into it.
  return queued.reduce((n, q, i) => (i > 0 && queued[i - 1].coalesceWithNext ? n : n + 1), 0);
}

export function QueueTray({
  queued,
  onRemove,
  onEdit,
  onMove,
  onCoalesce,
  onMergeAll,
}: QueueTrayProps) {
  if (queued.length === 0) return null;
  const turns = turnCount(queued);
  const allMerged = turns === 1 && queued.length > 1;
  return (
    <div className="av-queue" role="region" aria-label="Queued messages">
      <div className="av-queue-head">
        <span className="av-queue-count">
          {queued.length} queued
        </span>
        <span className="av-queue-sub">
          → will run as {turns} turn{turns > 1 ? 's' : ''} after this one
        </span>
        <span className="av-queue-spacer" />
        {queued.length > 1 && !allMerged && (
          <button className="av-queue-btn" onClick={onMergeAll}>
            Merge all into one turn
          </button>
        )}
      </div>
      <div className="av-queue-list">
        {queued.map((q, i) => (
          <QueueRow
            key={q.id}
            entry={q}
            index={i}
            total={queued.length}
            onRemove={onRemove}
            onEdit={onEdit}
            onMove={onMove}
            onCoalesce={onCoalesce}
          />
        ))}
      </div>
    </div>
  );
}

function QueueRow({
  entry,
  index,
  total,
  onRemove,
  onEdit,
  onMove,
  onCoalesce,
}: {
  entry: AgentQueuedPrompt;
  index: number;
  total: number;
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onCoalesce: (id: string, on: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  // An edit landing from ANOTHER window (or a coalesce rewriting the text) must
  // not be clobbered by this row's stale draft — resync whenever the
  // authoritative text changes while we're not actively editing it.
  useEffect(() => {
    if (!editing) setDraft(entry.text);
  }, [entry.text, editing]);

  const commit = () => {
    const t = draft.trim();
    // An empty edit is a cancel-by-clearing; treat it as a no-op instead of
    // sending an empty turn the agent can do nothing with.
    if (t && t !== entry.text) onEdit(entry.id, t);
    else setDraft(entry.text);
    setEditing(false);
  };

  const isLast = index === total - 1;

  return (
    <div
      className={`av-queue-row${entry.coalesceWithNext ? ' av-queue-row-merged' : ''}`}
      data-queue-index={index}
    >
      <span className="av-queue-num" aria-hidden>
        {index + 1}
      </span>
      {editing ? (
        <textarea
          ref={ref}
          className="av-queue-edit"
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter commits, Shift+Enter keeps a newline — same contract as the
            // composer, so the muscle memory carries over.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(entry.text);
              setEditing(false);
            }
            // Don't let Escape/Enter reach the composer's global handlers (Esc
            // there INTERRUPTS the turn — a brutal outcome for cancelling an edit).
            e.stopPropagation();
          }}
          aria-label={`Edit queued message ${index + 1}`}
        />
      ) : (
        <div
          className="av-queue-text"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to edit"
        >
          {entry.text}
        </div>
      )}
      <div className="av-queue-actions">
        <button
          className="av-queue-btn av-queue-icon"
          disabled={isLast}
          aria-pressed={entry.coalesceWithNext}
          onClick={() => onCoalesce(entry.id, !entry.coalesceWithNext)}
          title={
            isLast
              ? 'Nothing after this to merge with'
              : entry.coalesceWithNext
                ? 'Merged with the next message — click to split'
                : 'Merge with the next message into one turn'
          }
          aria-label={entry.coalesceWithNext ? 'Split from next message' : 'Merge with next message'}
        >
          ⧉
        </button>
        <button
          className="av-queue-btn av-queue-icon"
          disabled={index === 0}
          onClick={() => onMove(entry.id, -1)}
          title="Move earlier"
          aria-label={`Move message ${index + 1} earlier`}
        >
          ↑
        </button>
        <button
          className="av-queue-btn av-queue-icon"
          disabled={isLast}
          onClick={() => onMove(entry.id, 1)}
          title="Move later"
          aria-label={`Move message ${index + 1} later`}
        >
          ↓
        </button>
        <button
          className="av-queue-btn"
          onClick={() => setEditing(true)}
          aria-label={`Edit message ${index + 1}`}
        >
          Edit
        </button>
        <button
          className="av-queue-btn av-queue-icon av-queue-remove"
          onClick={() => onRemove(entry.id)}
          title="Cancel this message"
          aria-label={`Cancel message ${index + 1}`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
