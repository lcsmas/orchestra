import React, { useState } from 'react';
import type { RenderMessage, RestartTrigger } from '../../../shared/types';
import { RESTART_NOTICE_TEXT, restartTriggerLabel } from '../../../shared/restart-notice';

interface Props {
  /** A `restarted` notice message (role `system`, noticeKind `restarted`). */
  message: RenderMessage;
  /** Start expanded. Default false — collapsed is the point (Variant A). Exists
   *  so the render-smoke can assert the EXPANDED markup deterministically under
   *  SSR (same pattern as WakeRow/PeerMessageGroup). Production never passes it. */
  defaultOpen?: boolean;
}

/**
 * An INTENTIONAL restart rendered as a compact NEUTRAL row (issue #148, in the
 * #145 "Variant A — quiet rows" idiom). Instead of the raw red
 * `ERROR — Claude Code process exited with code -1` box (which an intentional
 * restart is NOT), the row shows a quiet reload chip:
 *
 *   ↻ Session redémarrée — conversation préservée   [›]
 *
 * collapsed by default, expanding to name the trigger (`orchestra restart`, the
 * toolbar button, or the #142 re-parent).
 *
 * MARKER-KEYED upstream — the row exists only because the restart PATH set an
 * explicit intent marker (`session.restartRequested` live; a persisted
 * `Workspace.sdkRestarts` record for backfill), NEVER because of the exit code
 * or timing: a genuine crash also exits -1 and keeps the red error box. IDENTICAL
 * in live and backfill: both paths build this row from the same
 * `makeRestartNotice` (src/shared/restart-notice.ts) and render this component
 * (the #57 live==backfill lesson).
 */
function RestartRowImpl({ message, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const trigger = (message.restartTrigger ?? 'cli') as RestartTrigger;
  const text = message.text || RESTART_NOTICE_TEXT;

  return (
    <div className={`av-restart ${open ? 'av-open' : 'av-closed'}`} data-restart="1">
      <button
        type="button"
        className="av-restart-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="av-restart-icon" aria-hidden>
          {/* A reload/↻ glyph — neutral, not an error. */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2v3h-3" />
          </svg>
        </span>
        <span className="av-restart-text">{text}</span>
        <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
          <svg
            width="9"
            height="9"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="av-restart-detail" data-restart-detail="1">
          {restartTriggerLabel(trigger)}
        </div>
      ) : null}
    </div>
  );
}

/** Notices are immutable once folded (id captures identity), so memo on id. */
export const RestartRow = React.memo(
  RestartRowImpl,
  (a, b) =>
    a.message.id === b.message.id &&
    a.message.restartTrigger === b.message.restartTrigger &&
    a.defaultOpen === b.defaultOpen,
);
