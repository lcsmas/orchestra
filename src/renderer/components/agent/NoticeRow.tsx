import React from 'react';
import type { AgentNoticeKind, RenderMessage } from '../../../shared/types';

/**
 * A quiet system-notice row in the transcript — the render surface for
 * {@link AgentNoticeEvent}s (rate limits, auth problems, compaction markers,
 * refusals, auto-denied tools, built-in slash-command output). These used to be
 * silently dropped at the normalize layer; the row keeps them legible without
 * shouting over the conversation.
 *
 * `command-output` renders preformatted (multi-line /usage tables etc.);
 * `rate-limit` appends the local reset time when the event carried one.
 */

const LABEL: Record<AgentNoticeKind, string> = {
  'rate-limit': 'Usage limit',
  auth: 'Authentication',
  'compact-boundary': 'Context',
  'compact-error': 'Compaction',
  refusal: 'Model refusal',
  'permission-denied': 'Permission',
  notification: 'Notice',
  warning: 'Warning',
  info: '',
  'command-output': '',
};

function NoticeRowImpl({ message }: { message: RenderMessage }) {
  const kind: AgentNoticeKind = message.noticeKind ?? 'info';
  const label = LABEL[kind] ?? '';
  const reset =
    kind === 'rate-limit' && message.noticeResetsAt
      ? new Date(message.noticeResetsAt * 1000)
      : null;
  return (
    <div className={`av-notice av-notice-${kind}`} data-notice={kind} role="note">
      <span className="av-notice-dot" aria-hidden />
      {label ? <span className="av-notice-label">{label}</span> : null}
      {kind === 'command-output' ? (
        <pre className="av-notice-pre">{message.text}</pre>
      ) : (
        <span className="av-notice-text">
          {message.text}
          {reset
            ? ` — resets ${reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : ''}
        </span>
      )}
    </div>
  );
}

/** Notices are immutable once folded (id captures identity), so memo on id. */
export const NoticeRow = React.memo(
  NoticeRowImpl,
  (a, b) => a.message.id === b.message.id && a.message.text === b.message.text,
);
