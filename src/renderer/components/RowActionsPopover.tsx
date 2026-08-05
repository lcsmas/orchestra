import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The per-row action buttons (bookmark / archive / delete), floated OUTSIDE the
 * sidebar and anchored to whichever row the pointer is over.
 *
 * They used to be an absolutely-positioned strip INSIDE the row, which put them
 * on top of the row's own interactive content — the account badge (clickable:
 * it opens the account-migration menu), the PR/Linear badges (clickable: they
 * open the issue), and the collapse chevron. Reaching for a badge could hit an
 * action button instead, and one of those actions is Delete.
 *
 * Rendering it in a PORTAL rather than in the row is not a style choice: the
 * sidebar clips (`.ws-list` scrolls) and `.app` is a grid, so anything laid out
 * inside a row cannot paint past the sidebar's right edge. Fixed positioning
 * from a measured rect is the only way out.
 *
 * Hover intent: the pointer has to cross a gap to reach the buttons, so the
 * popover stays up briefly after the row is left (`CLOSE_DELAY_MS`) and cancels
 * that timer when the pointer lands on the popover itself. Without it the
 * buttons vanish mid-travel and become unclickable.
 */

const CLOSE_DELAY_MS = 220;
/** Gap between the sidebar's right edge and the popover. */
const OFFSET_X = 6;

export interface RowActionsTarget {
  /** Screen rect of the hovered row, from `getBoundingClientRect()`. */
  rect: { top: number; bottom: number; right: number };
  /** What to render — the caller owns the buttons, since which actions exist
   *  differs per row kind (git worktree archives, scratch deletes). */
  content: React.ReactNode;
  /** Identifies the row, so re-hovering the same row does not re-animate. */
  key: string;
}

export function useRowActionsPopover() {
  const [target, setTarget] = useState<RowActionsTarget | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const show = useCallback(
    (next: RowActionsTarget) => {
      cancelClose();
      setTarget(next);
    },
    [cancelClose],
  );

  const scheduleHide = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setTarget(null), CLOSE_DELAY_MS);
  }, [cancelClose]);

  /** Hide with no grace period — for when the anchor stops existing (a row
   *  deleted, the list re-ordered, the sidebar scrolled). */
  const hideNow = useCallback(() => {
    cancelClose();
    setTarget(null);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  return { target, show, scheduleHide, hideNow, cancelClose };
}

export function RowActionsPopover({
  target,
  onEnter,
  onLeave,
}: {
  target: RowActionsTarget | null;
  onEnter: () => void;
  onLeave: () => void;
}) {
  if (!target) return null;
  const { rect, content } = target;
  // Vertically centre on the row; the popover is one row tall, so this keeps
  // the buttons on the same optical line as the branch name they act on.
  const top = Math.round((rect.top + rect.bottom) / 2);
  return createPortal(
    <div
      className="ws-row-actions-pop"
      style={{ top, left: Math.round(rect.right + OFFSET_X) }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // The row underneath is a click target that selects the workspace; a
      // click on the buttons must never fall through to it.
      onClick={(e) => e.stopPropagation()}
    >
      {content}
    </div>,
    document.body,
  );
}
