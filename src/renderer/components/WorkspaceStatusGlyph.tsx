import type React from 'react';
import type { Workspace, WorkspaceStatus } from '../../shared/types.ts';
import { THINKING_TOOL_LABEL } from '../../shared/types.ts';

/**
 * The status marker for a workspace, shown wherever the app lists agents:
 * the sidebar rows (both render paths), the Inbox, the jump palette and the
 * Resources table.
 *
 * Outlined RING glyphs, not the old filled `.ws-dot` circle. A ring plus an
 * inner shape carries two channels — form AND colour — so "finished" and
 * "needs your input" stay distinguishable to someone who cannot separate green
 * from amber. Five same-shaped dots in five hues could not do that. The quiet
 * states (stopped, hibernated) stay plain dots: there is no shape worth
 * drawing for them, and drawing one would assert a claim the state doesn't
 * make.
 *
 * `running` is a CSS ring rather than an SVG: a `border-top-color: transparent`
 * circle spun by a compositor-only transform costs no main-thread work, which
 * matters when dozens of rows animate at once. See `.ws-glyph-spin` in
 * styles.css, which also restores the top edge under `prefers-reduced-motion`
 * (a frozen ring with a transparent quarter reads as a broken glyph).
 *
 * This lives in its own module rather than in Sidebar.tsx so the other four
 * surfaces can use it without importing a 100KB component file — and so it
 * stays renderable in a test without dragging in xterm and the IPC bridge.
 *
 * NOT used for ARCHIVED workspaces: their `status` is a frozen leftover from
 * before archiving, with no live agent behind it, so a check-ring would assert
 * a successful finish the data cannot support. Those rows keep `.ws-dot`.
 */
export function WorkspaceStatusGlyph({
  status,
  hibernated,
  unread,
  title,
  size,
}: {
  status: WorkspaceStatus;
  hibernated: boolean;
  unread: boolean;
  title: string;
  /** Optional context class, e.g. `'sm'` for denser lists. */
  size?: 'sm';
}) {
  const cls = (kind: string) =>
    `ws-glyph ws-glyph-${kind}${size ? ` ws-glyph-${size}` : ''}` +
    `${unread ? ' unread' : ''}${hibernated ? ' hibernated' : ''}`;
  const svg = (children: React.ReactNode, kind: string) => (
    <span className={cls(kind)} title={title} role="img" aria-label={title}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {children}
      </svg>
    </span>
  );

  // A hibernated agent's process is STOPPED, so it must never animate as if it
  // were working — even though its last recorded status is usually 'running'.
  if (hibernated) {
    return <span className={cls('idle')} title={title} role="img" aria-label={title} />;
  }
  switch (status) {
    case 'running':
      // Lucide has no spinner; this is the CSS ring described above.
      return (
        <span className={cls('running')} title={title} role="img" aria-label={title}>
          <span className="ws-glyph-spin" aria-hidden="true" />
        </span>
      );
    case 'waiting':
      // Lucide `message-circle-question` — the agent is asking, not failing.
      return svg(
        <>
          <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </>,
        'waiting',
      );
    case 'error':
      // Lucide `circle-x`.
      return svg(
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m15 9-6 6M9 9l6 6" />
        </>,
        'error',
      );
    case 'idle':
      // Lucide `circle-check` — idle means the agent finished its turn.
      return svg(
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </>,
        'idle',
      );
    default:
      // `stopped` and any future status: a quiet dot, no shape claim.
      return <span className={cls('stopped')} title={title} role="img" aria-label={title} />;
  }
}

/** Tooltip text for a workspace's status glyph. Shared by every surface that
 * renders one, so the same state cannot be described two different ways. */
// Re-exported from a plain .ts module so it can be unit-tested (node:test can't
// import JSX). Every existing import site keeps working unchanged.
export { statusGlyphTitle } from '../status-glyph-title.ts';
