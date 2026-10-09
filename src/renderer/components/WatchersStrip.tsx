import { useStore } from '../store';
import { watchersStripCopy } from '../../shared/watcher-status';

/**
 * #330 (D-Q8 = A): the sidebar-footer strip shown WHILE any directory watcher is degraded — the app keeps working on its fallbacks (sweeps, polls, pulls) but updates may lag, and since the 2026-10-08 incident
 * (a sidebar stuck on « en pause » after the Reprise) nothing used to say so. Same slot and look as the « Pause : état illisible » strip (`.pause-unreadable`); non-blocking (role=status), no button, no dismissal:
 * it renders nothing at all once the last watcher is back, so it disappears on its own. The words are pure (src/shared/watcher-status.ts `watchersStripCopy`); the state is the `watchers` store slice
 * (boot pull + `watchers:update` push).
 */
export function WatchersStrip() {
  const status = useStore((s) => s.watchers);
  const copy = watchersStripCopy(status, Date.now());
  if (!copy) return null;
  return (
    <div className="pause-unreadable watchers-strip" role="status" aria-live="polite" data-watchers-chip="" title={copy.lines.join('\n')}>
      <svg className="pause-icon" viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
        <path d="M8 2.2L14.6 13.6H1.4z" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 6.6v3.4M8 11.8v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>
        <b>{copy.title}</b> — {copy.body}
      </span>
    </div>
  );
}
