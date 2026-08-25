import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { computeAttention } from '../../shared/attention';
import { WorkspaceStatusGlyph, statusGlyphTitle } from './WorkspaceStatusGlyph';
import { isActionableStopReason } from '../../shared/usage-resume';
import type { Workspace } from '../../shared/types';

function rowRepoLabel(w: Workspace): string {
  if (w.kind === 'orchestrator') return 'orchestrator';
  if (!w.repoPath) return 'scratch';
  const parts = w.repoPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? w.repoPath;
}

/** Header inbox — Orca's "Needs You" triage as a dropdown.
 *
 * The badge counts workspaces that need the user (status waiting/error,
 * finished-but-unopened (`autoUnread`), +
 * bookmarks); the popover lists them grouped, with the running agents below
 * for ambient awareness. Clicking a row jumps to the workspace — which is also
 * what clears its signals (main's markSeen clears `waiting`; the store's
 * setActive clears the bookmark), so the inbox needs no read-state of its own. */
export function InboxBell() {
  const workspaces = useStore((s) => s.workspaces);
  const tools = useStore((s) => s.tools);
  const setActive = useStore((s) => s.setActive);
  const [open, setOpen] = useState(false);
  /** Viewport coords for the portalled panel, captured from the bell's rect at
   * open time. PORTALLED to document.body like NewWorkspaceBranchPopover —
   * anchored inside the sidebar it gets clipped by the sidebar's overflow /
   * backdrop-filter containing block. Shipped both failure modes of in-place
   * anchoring already: right-anchored → off the WINDOW's left edge (v0.5.187),
   * left-anchored → clipped at the SIDEBAR's right edge (v0.5.188). Clamped
   * on-screen whatever the sidebar width or bell position. */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const { needsYou, bookmarked, working, count } = computeAttention(workspaces);

  const POPOVER_WIDTH = 320;
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const btn = rootRef.current?.querySelector('.header-icon-btn');
    const r = btn?.getBoundingClientRect();
    setPos(
      r
        ? {
            left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8)),
            top: r.bottom + 6,
          }
        : { left: 8, top: 48 },
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is portalled, so check BOTH the bell wrapper and the panel —
      // testing only rootRef would close the popover on any click inside it.
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const jump = (id: string) => {
    setActive(id);
    setOpen(false);
  };

  const row = (w: Workspace, reason: string, reasonClass: string) => (
    <button key={w.id} className="inbox-row" onClick={() => jump(w.id)} role="menuitem">
      {/* Same ring glyph the sidebar uses, so one shape means one state
          everywhere. The row also prints a text reason, so here the glyph is
          reinforcement rather than the sole signal — but a reader scanning the
          column still gets shape as well as colour. */}
      <WorkspaceStatusGlyph
        status={w.status}
        hibernated={w.hibernatedAt !== undefined}
        unread={!!w.markedUnread}
        autoUnread={!!w.autoUnread}
        looping={!!w.loopingSince}
        stopReason={isActionableStopReason(w.lastStopReason) ? w.lastStopReason : undefined}
        title={statusGlyphTitle(w)}
      />
      <span className="inbox-branch">{w.branch}</span>
      <span className="inbox-repo">{rowRepoLabel(w)}</span>
      <span className={`inbox-reason ${reasonClass}`}>{reason}</span>
    </button>
  );

  return (
    <div className="inbox-bell" ref={rootRef}>
      <button
        className="header-icon-btn"
        onClick={toggle}
        title={
          count > 0
            ? `${count} workspace${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`
            : 'Inbox — nothing needs you right now'
        }
        aria-label="Inbox — workspaces needing attention"
      >
        <InboxIcon />
        {count > 0 && <span className="inbox-badge">{count > 9 ? '9+' : count}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="inbox-popover"
            role="menu"
            aria-label="Workspaces needing attention"
            style={{ left: pos.left, top: pos.top }}
          >
          {needsYou.length === 0 && bookmarked.length === 0 && (
            <div className="inbox-empty">Nothing needs you — agents are working or idle.</div>
          )}
          {needsYou.length > 0 && (
            <>
              <div className="inbox-section">Needs you</div>
              {/* Three distinct reasons a row is here, in the same priority
                  computeAttention sorts by. A finished-but-unopened agent is
                  NOT "waiting for you" — nothing is blocked on you — so it
                  must not borrow the blocked copy. */}
              {needsYou.map((w) =>
                row(
                  w,
                  w.status === 'error'
                    ? 'error'
                    : w.status === 'waiting'
                      ? 'waiting for you'
                      : 'finished — not opened yet',
                  w.status === 'error' ? 'error' : 'waiting',
                ),
              )}
            </>
          )}
          {bookmarked.length > 0 && (
            <>
              <div className="inbox-section">Bookmarked</div>
              {bookmarked.map((w) => row(w, 'marked unread', 'bookmark'))}
            </>
          )}
          {working.length > 0 && (
            <>
              <div className="inbox-section">Working</div>
              {working.slice(0, 6).map((w) => row(w, tools[w.id] ?? 'working…', 'working'))}
              {working.length > 6 && (
                <div className="inbox-more">+{working.length - 6} more working</div>
              )}
            </>
          )}
          </div>,
          document.body,
        )}
    </div>
  );
}

function InboxIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7z" />
    </svg>
  );
}
