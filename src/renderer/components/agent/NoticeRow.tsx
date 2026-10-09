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
  // Renders as a centered divider (see .av-notice-interrupted) — the text
  // carries the story, no shouty uppercase label.
  interrupted: '',
  // An intentional restart (#148) is routed to the dedicated expandable
  // RestartRow, never NoticeRow — but the map must stay exhaustive over the
  // kind union. If it ever DID reach here, no shouty label (it is neutral).
  restarted: '',
  // MCP connection outcomes (Option-D tracking): quiet hairline rows whose
  // dot color carries the state (green connected / red failed) — the text
  // ("context7 connected · 12 tools") is the whole story, no label.
  mcp: '',
  'mcp-error': '',
  // The Plafond mémoire (#322, D-Q7 B) is routed to the dedicated MemoryCapRow below; the label is its own.
  'memory-cap': 'Plafond mémoire',
};

/**
 * #322 (D-Q7 B): the Plafond mémoire's dedicated one-line row — « PLAFOND MÉMOIRE · Command [cmd] killed — 6 GB reached · 14:02 ». RED = a command was killed, AMBER = the warning level was crossed, the command in a
 * chip. Pure render over `message.noticeMemCap` (built once by shared/mem-notice.ts `memCapRowOf`, identical live and after a reopen); a row persisted before the dedicated one has a single text segment.
 * The full plain sentence rides as the tooltip. Hooks for the drive: `data-notice="memory-cap"`, `data-memcap-tone`, `data-memcap-chip`.
 */
function MemoryCapRow({ message }: { message: RenderMessage }) {
  const row = message.noticeMemCap ?? { tone: 'hard' as const, segments: [{ kind: 'text' as const, text: message.text ?? '' }] };
  const time = message.at ? new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className={`av-notice av-notice-memory-cap is-${row.tone}`} data-notice="memory-cap" data-memcap-tone={row.tone} role="note" title={message.text}>
      <span className="av-notice-dot" aria-hidden />
      <span className="av-notice-label">Plafond mémoire</span>
      <span className="av-notice-text">
        {row.segments.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 ? ' ' : ''}
            {s.kind === 'chip' ? (
              <code className="av-notice-chip" data-memcap-chip="">
                {s.text}
              </code>
            ) : (
              s.text
            )}
          </React.Fragment>
        ))}
      </span>
      {time ? <span className="av-notice-tag">{time}</span> : null}
    </div>
  );
}

function NoticeRowImpl({ message }: { message: RenderMessage }) {
  const kind: AgentNoticeKind = message.noticeKind ?? 'info';
  if (kind === 'memory-cap') return <MemoryCapRow message={message} />;
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
  (a, b) => a.message.id === b.message.id && a.message.text === b.message.text && a.message.noticeMemCap === b.message.noticeMemCap,
);
