import React from 'react';
import { createPortal } from 'react-dom';
import type { AgentRewindPreview } from '../../../shared/types';
import { describeRewindPreview } from './rewind-util';
import { useAgentTheme } from './agent-theme';

/** Panel width — mirrored in `.av-rewind-pop` so the anchor math matches paint. */
const PANEL_WIDTH = 268;
/** Gap between the trigger's bottom edge and the panel. */
const PANEL_GAP = 6;
/** Keep the panel this far off any viewport edge when clamping. */
const VIEWPORT_MARGIN = 8;

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
 *
 * The panel is PORTALLED to `<body>` with fixed positioning, like {@link AvMenu}.
 * It has to be: the panel's own row lives inside `.av-message-list`, which is
 * the `overflow:auto` scroller, so an in-flow panel is CLIPPED at the scroller's
 * edge and then painted over by `.av-composer` (a later sibling of the
 * scroller) — no z-index inside the list can escape either, since clipping and
 * sibling paint order both outrank it. An earlier attempt portalled it to
 * `<body>` and regressed differently: outside `.av-view` the whole `--av-*`
 * palette is undeclared, so the background resolved to `rgba(0,0,0,0)` — a
 * transparent dialog. Hence the portal root carries `av-view` (which is where
 * the tokens are declared) plus the live `data-agent-theme`, so the panel keeps
 * the palette AND follows the light/dark toggle while escaping the clip.
 */
export function RewindControl({ rewindId, onPreview, onConfirm, disabled }: Props) {
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<AgentRewindPreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const rootRef = React.useRef<HTMLSpanElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const theme = useAgentTheme();

  // Anchor to the trigger, opening downward-left, clamped to the viewport. The
  // panel is `position:fixed`, so this re-runs on scroll (capture phase — the
  // transcript scroller is a descendant, not the window) and on resize, or the
  // panel would detach from its row mid-scroll.
  React.useLayoutEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, r.right - PANEL_WIDTH),
        window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN,
      );
      // Flip above the trigger when there isn't room below, so the panel is
      // never pushed off-screen for a message near the foot of the transcript.
      const below = r.bottom + PANEL_GAP;
      const panelH = panelRef.current?.offsetHeight ?? 0;
      const overflows = panelH > 0 && below + panelH > window.innerHeight - VIEWPORT_MARGIN;
      const top = overflows ? Math.max(VIEWPORT_MARGIN, r.top - PANEL_GAP - panelH) : below;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
    // `preview` re-runs placement once the dry run lands and the panel's height
    // settles — otherwise the flip decision is made against a 0-height panel.
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
    // Two subtrees to check, because the panel is portalled out of the trigger.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
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

      {open
        ? createPortal(
            // `av-view` carries the --av-* palette (declared on that class), and
            // the theme attribute keeps light mode working outside the pane.
            <div className="av-view av-rewind-portal" data-agent-theme={theme}>
              <div
                ref={panelRef}
                className="av-rewind-pop"
                role="dialog"
                aria-label="Rewind to this message"
                style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              >
                <div className="av-rewind-pop-title">Rewind to this message?</div>
                <div className="av-rewind-pop-body">
                  This message and everything after it will be removed from the conversation,
                  and its text returns to the composer so you can edit and resend it.
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
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
