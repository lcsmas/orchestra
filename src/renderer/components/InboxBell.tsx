import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { computeAttention } from '../../shared/attention';
import type { Workspace } from '../../shared/types';

function rowRepoLabel(w: Workspace): string {
  if (w.kind === 'orchestrator') return 'orchestrator';
  if (!w.repoPath) return 'scratch';
  const parts = w.repoPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? w.repoPath;
}

/** Header inbox — Orca's "Needs You" triage as a dropdown.
 *
 * The badge counts workspaces that need the user (status waiting/error +
 * bookmarks); the popover lists them grouped, with the running agents below
 * for ambient awareness. Clicking a row jumps to the workspace — which is also
 * what clears its signals (main's markSeen clears `waiting`; the store's
 * setActive clears the bookmark), so the inbox needs no read-state of its own. */
export function InboxBell() {
  const workspaces = useStore((s) => s.workspaces);
  const tools = useStore((s) => s.tools);
  const setActive = useStore((s) => s.setActive);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const { needsYou, bookmarked, working, count } = computeAttention(workspaces);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
      <span
        className={`ws-dot ${w.status}${w.markedUnread ? ' unread' : ''}`}
        aria-hidden="true"
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
        onClick={() => setOpen((v) => !v)}
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
      {open && (
        <div className="inbox-popover" role="menu" aria-label="Workspaces needing attention">
          {needsYou.length === 0 && bookmarked.length === 0 && (
            <div className="inbox-empty">Nothing needs you — agents are working or idle.</div>
          )}
          {needsYou.length > 0 && (
            <>
              <div className="inbox-section">Needs you</div>
              {needsYou.map((w) =>
                row(
                  w,
                  w.status === 'error' ? 'error' : 'waiting for you',
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
        </div>
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
