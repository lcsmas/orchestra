import React from 'react';
import { createPortal } from 'react-dom';
import type { AgentRewindPreview } from '../../../shared/types';
import { describeRewindPreview } from './rewind-util';

/** Popover width — also used to clamp it inside the viewport. */
const POP_WIDTH = 268;

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
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  // Anchor the PORTALLED panel to the trigger, clamped to the viewport.
  //
  // Why portalled: the message list is VIRTUALIZED, and each row sits inside a
  // `transform: translateY(...)` container. A transform creates a stacking
  // context, which traps any `z-index` inside that row — so an in-place popover
  // is painted OVER by every later row (reproduced: 5/5 sample points inside
  // the panel hit `av-row`/assistant messages, which is the "transparent
  // popover" bug). No z-index can escape a stacking context; only leaving the
  // subtree can. Same reason AvMenu portals.
  React.useLayoutEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      // Right-align to the trigger (it lives in the right-hand gutter), then
      // clamp so the panel can never render off-screen.
      const left = Math.min(Math.max(8, r.right - POP_WIDTH), window.innerWidth - POP_WIDTH - 8);
      // Flip above the trigger when there isn't room below.
      const panelH = panelRef.current?.offsetHeight ?? 210;
      const below = r.bottom + 6;
      const top = below + panelH > window.innerHeight - 8 ? Math.max(8, r.top - panelH - 6) : below;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    // Capture phase: the transcript scroller is a nested scrolling element, and
    // a bubbling listener would never see its scroll events.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, preview]);

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
      // TWO subtrees to test, because the panel is portalled to document.body
      // and is therefore NOT inside rootRef — checking only the trigger would
      // close the dialog on its own buttons.
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
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

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              className="av-rewind-pop"
              role="dialog"
              aria-label="Rewind to this message"
              style={{ left: pos.left, top: pos.top, width: POP_WIDTH }}
            >
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
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
