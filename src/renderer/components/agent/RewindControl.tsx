import React from 'react';
import type { AgentRewindPreview } from '../../../shared/types';
import { describeRewindPreview } from './rewind-util';

interface Props {
  /** The message being rewound — {@link RenderMessage.rewindId}. */
  rewindId: string;
  /** Runs the SDK dry-run so the confirmation can state what would change.
   *  Called once when the popover opens. */
  onPreview: (rewindId: string) => Promise<AgentRewindPreview>;
  /** Commits the rewind. The caller handles composer prefill + IPC. */
  onConfirm: (rewindId: string) => Promise<void>;
  /** Disabled while a turn is in flight — rewinding mid-turn would race the
   *  session teardown against the stream still writing rows. */
  disabled?: boolean;
}

/**
 * The per-message **rewind** affordance — Orchestra's take on Claude Code's
 * double-Esc restore, as an explicit action on the message you want to undo.
 *
 * Shown on hover over a user bubble that carries a `rewindId` (see
 * {@link RenderMessage.rewindId}; turns with no id — externally-originated, or
 * pre-feature history — simply have no target and render nothing). Clicking
 * opens a small confirmation that first runs a DRY RUN, so the user sees
 * exactly which files would be restored before committing to a destructive,
 * irreversible action.
 */
export function RewindControl({ rewindId, onPreview, onConfirm, disabled }: Props) {
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<AgentRewindPreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const rootRef = React.useRef<HTMLSpanElement | null>(null);

  // Fetch the dry run when the popover opens. Guarded against a late resolve
  // landing after the user dismissed it (setState on a closed popover would
  // flash stale counts the next time it opens).
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview(null);
    onPreview(rewindId)
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch((e: unknown) => {
        if (alive) {
          setPreview({
            canRewind: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [open, rewindId, onPreview]);

  // Dismiss on outside click / Esc, like the other av-* popovers.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't let Esc also reach the composer's interrupt handler.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(rewindId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="av-rewind" ref={rootRef}>
      <button
        type="button"
        className="av-rewind-btn"
        title={disabled ? 'Stop the current turn to rewind' : 'Rewind to this message'}
        aria-label="Rewind to this message"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Counter-clockwise arrow — "go back to here". */}
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
          <path
            d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.6V5.4h2.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="av-rewind-label">Rewind</span>
      </button>

      {open ? (
        <div className="av-rewind-pop" role="dialog" aria-label="Rewind to this message">
          <div className="av-rewind-pop-title">Rewind to this message?</div>
          <div className="av-rewind-pop-body">
            This message and everything after it will be removed from the conversation, and
            its text returns to the composer so you can edit and resend it.
          </div>
          <div className="av-rewind-pop-files">{describeRewindPreview(preview)}</div>
          <div className="av-rewind-pop-actions">
            <button
              type="button"
              className="av-rewind-cancel"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="av-rewind-confirm"
              onClick={() => void confirm()}
              disabled={busy}
            >
              {busy ? 'Rewinding…' : 'Rewind'}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
