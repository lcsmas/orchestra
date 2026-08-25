import React from 'react';
import { createPortal } from 'react-dom';
import { useAgentTheme } from './agent-theme';

/** Panel width — mirrored in `.av-fork-pop` so the anchor math matches paint. */
const PANEL_WIDTH = 288;
/** Gap between the trigger's bottom edge and the panel. */
const PANEL_GAP = 6;
/** Keep the panel this far off any viewport edge when clamping. */
const VIEWPORT_MARGIN = 8;

interface Props {
  /** The message being resumed from — {@link RenderMessage.rewindId}. */
  rewindId: string;
  /** Forks the conversation into a new workspace. */
  onFork: (rewindId: string) => Promise<void>;
}

/**
 * The per-message **"Resume from here"** affordance (#18) — the NON-DESTRUCTIVE
 * sibling of {@link RewindControl}.
 *
 * Where rewind UNDOES a turn in place, this branches: the conversation up to
 * the previous exchange is copied into a **new Orchestra workspace** with its
 * own git worktree, and THIS workspace is left completely untouched and still
 * running. Parallel workspaces are Orchestra's native model for exactly this.
 *
 * Deliberately NOT disabled while a turn is in flight — nothing about the
 * source session is stopped or mutated, so there is no teardown to race (this
 * is the substantive behavioural difference from `RewindControl`, whose
 * `disabled` prop guards a destructive truncation).
 *
 * The panel is PORTALLED to `<body>` with fixed positioning for the same two
 * reasons documented at length on {@link RewindControl}: an in-flow panel is
 * clipped by `.av-message-list`'s `overflow:auto` and then painted over by
 * `.av-composer`, while a bare `<body>` portal loses the `--av-*` palette. The
 * portal root therefore carries `av-view` plus the live `data-agent-theme`.
 */
export function ForkControl({ rewindId, onFork }: Props) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const rootRef = React.useRef<HTMLSpanElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const theme = useAgentTheme();

  // Anchor to the trigger, clamped to the viewport, flipping above when there
  // is no room below. Re-runs on scroll in the CAPTURE phase because the
  // transcript scroller is a descendant of window, not window itself.
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
  }, [open]);

  // Dismiss on outside click / Esc, like the other av-* popovers.
  React.useEffect(() => {
    if (!open) return;
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
      await onFork(rewindId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="av-fork" ref={rootRef}>
      <button
        type="button"
        className="av-fork-btn"
        title="Resume from here in a new workspace"
        aria-label="Resume from here in a new workspace"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Branch glyph — a line splitting off, "fork from here". */}
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
          <path
            d="M5 2.8v10.4M5 7.5h4a2 2 0 0 0 2-2V3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="5" cy="2.6" r="1.4" fill="currentColor" />
          <circle cx="11" cy="3.2" r="1.4" fill="currentColor" />
        </svg>
        <span className="av-fork-label">Resume here</span>
      </button>

      {open
        ? createPortal(
            <div className="av-view av-fork-portal" data-agent-theme={theme}>
              <div
                ref={panelRef}
                className="av-fork-pop"
                role="dialog"
                aria-label="Resume from here in a new workspace"
                style={{
                  left: pos?.left ?? 0,
                  top: pos?.top ?? 0,
                  visibility: pos ? 'visible' : 'hidden',
                }}
              >
                <div className="av-fork-pop-title">Resume from here?</div>
                <div className="av-fork-pop-body">
                  Branches the conversation up to this point into a{' '}
                  <strong>new workspace</strong> with its own worktree. This workspace is
                  left untouched and keeps running.
                </div>
                {/* Q1b: the checkpoint-loss and file-skew caveats are DECLARED in
                    the affordance copy, never left silent. The new worktree's own
                    git history is the safety net that makes this acceptable. */}
                <div className="av-fork-pop-note">
                  The branch is cut from this workspace&apos;s current tip, so its files
                  are at today&apos;s state — not the state at this message. The fork also
                  starts without file-undo history.
                </div>
                <div className="av-fork-pop-actions">
                  <button
                    type="button"
                    className="av-fork-cancel"
                    onClick={() => setOpen(false)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="av-fork-confirm"
                    onClick={() => void confirm()}
                    disabled={busy}
                  >
                    {busy ? 'Forking…' : 'Resume here'}
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
