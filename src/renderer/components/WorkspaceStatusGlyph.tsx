import type React from 'react';
import type { Workspace, WorkspaceStatus } from '../../shared/types.ts';
import { THINKING_TOOL_LABEL } from '../../shared/types.ts';

/**
 * The status marker for a workspace, shown wherever the app lists agents:
 * the sidebar rows (both render paths), the Inbox, the jump palette and the
 * Resources table.
 *
 * SHAPE, not just colour, carries the states that ask something of the user:
 * the `waiting` question mark and the `autoUnread` bell are distinguishable
 * without seeing hue at all, which five same-shaped dots in five colours could
 * not manage. The quiet states — `idle`, `stopped`, `hibernated` — are plain
 * DOTS: there is no shape worth drawing for "nothing is happening", and
 * drawing one asserts a claim the state doesn't make (a check mark on `idle`
 * would claim a successful finish, but `idle` is also where a workspace that
 * has never run sits). This matches Orca one-for-one, which renders its
 * done/active states as a bare `bg-emerald-500` circle.
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
 * before archiving, with no live agent behind it, so a live-looking glyph would
 * assert something the data cannot support. Those rows keep `.ws-dot`.
 */
export function WorkspaceStatusGlyph({
  status,
  hibernated,
  unread,
  autoUnread,
  looping,
  title,
  size,
}: {
  status: WorkspaceStatus;
  hibernated: boolean;
  unread: boolean;
  /** The agent finished a turn here and the user has never opened it
   *  ({@link Workspace.autoUnread}). Renders a BELL instead of the status
   *  shape: "finished, unseen" is a different thing to communicate than
   *  "finished" — see the switch below. */
  autoUnread?: boolean;
  /** The agent is running a recurring /loop ({@link Workspace.loopingSince}).
   *  An axis ORTHOGONAL to status — a looping agent alternates running
   *  (iteration in flight) and idle/bell (sleeping until the next wakeup) —
   *  so it renders as a small cycle-arrows BADGE on the glyph's corner,
   *  overlaid on every state's shape rather than replacing any of them. */
  looping?: boolean;
  title: string;
  /** Optional context class, e.g. `'sm'` for denser lists. */
  size?: 'sm';
}) {
  const cls = (kind: string) =>
    `ws-glyph ws-glyph-${kind}${size ? ` ws-glyph-${size}` : ''}` +
    `${unread ? ' unread' : ''}${hibernated ? ' hibernated' : ''}`;
  // The /loop corner badge — Lucide `rotate-cw` arrows, slow-spun in CSS.
  // Inherits `currentColor`, so it follows each state's own hue (green on
  // idle, yellow on running, amber on the bell/?, accent when bookmarked)
  // without per-state rules here. Suppressed while HIBERNATED below: the
  // process is stopped, so a wakeup can never fire and the badge would
  // advertise a loop that cannot run.
  const loopBadge = looping ? (
    <span className="ws-glyph-loop" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.4}
        strokeLinecap="round" aria-hidden="true" focusable="false">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v5h-5" />
      </svg>
    </span>
  ) : null;
  const svg = (children: React.ReactNode, kind: string) => (
    <span className={cls(kind)} title={title} role="img" aria-label={title}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {children}
      </svg>
      {loopBadge}
    </span>
  );

  // A hibernated agent's process is STOPPED, so it must never animate as if it
  // were working — even though its last recorded status is usually 'running'.
  // No loop badge either — see loopBadge above.
  if (hibernated) {
    return <span className={cls('idle')} title={title} role="img" aria-label={title} />;
  }
  // "Finished, and you have never looked at it" — a FILLED BELL, the third of
  // the three attention states. Deliberately checked only for the quiet
  // statuses: `waiting` (blocked on your answer) and `error` are stronger
  // claims that must keep their own glyph, and `running` means a NEW turn is
  // already underway so a stale bell would misreport it. That leaves exactly
  // `idle`/`stopped`, which is where a finished-unseen turn lands.
  if (autoUnread && (status === 'idle' || status === 'stopped')) {
    // A FILLED bell — the exact path from Orca's `FilledBellIcon`
    // (WorktreeCardHelpers.tsx), which it renders in amber for this same
    // state. Filled rather than outlined so it reads as a solid attention mark
    // against the outlined `?`/`x` glyphs, and stays legible at 10px.
    // Rendered outside the shared `svg()` helper because that helper sets
    // stroke-based defaults; this path is fill-only.
    return (
      <span className={cls('autounread')} title={title} role="img" aria-label={title}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M5.25 9A6.75 6.75 0 0 1 12 2.25 6.75 6.75 0 0 1 18.75 9v3.75c0 .526.214 1.03.594 1.407l.53.532a.75.75 0 0 1-.53 1.28H4.656a.75.75 0 0 1-.53-1.28l.53-.532A1.989 1.989 0 0 0 5.25 12.75V9Zm6.75 12a3 3 0 0 0 2.996-2.825.75.75 0 0 0-.748-.8h-4.5a.75.75 0 0 0-.748.8A3 3 0 0 0 12 21Z"
          />
        </svg>
        {loopBadge}
      </span>
    );
  }
  switch (status) {
    case 'running':
      // Lucide has no spinner; this is the CSS ring described above.
      return (
        <span className={cls('running')} title={title} role="img" aria-label={title}>
          <span className="ws-glyph-spin" aria-hidden="true" />
          {loopBadge}
        </span>
      );
    case 'waiting':
      // Lucide `message-circle-question-mark` — the agent is asking, not
      // failing. Paths copied verbatim from lucide-react 0.577.0, the version
      // Orca pins, so this is the identical glyph rather than a same-named
      // icon from a different revision (Orchestra previously carried an older
      // one whose speech bubble was a visibly different shape).
      return svg(
        <>
          <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
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
      // A plain GREEN DOT — matching Orca, whose `done`/`active` states render
      // `size-2 rounded-full bg-emerald-500`. Deliberately not a check mark:
      // `idle` only means "no turn in flight", which is also the state of a
      // workspace that has never run, so a check would assert a successful
      // completion the status cannot support. The two states that DO need
      // acting on (waiting, autoUnread) keep distinct shapes, so the
      // form-plus-colour redundancy is preserved exactly where it matters.
      return (
        <span className={cls('idle')} title={title} role="img" aria-label={title}>
          {loopBadge}
        </span>
      );
    default:
      // `stopped` and any future status: a quiet dot, no shape claim.
      return (
        <span className={cls('stopped')} title={title} role="img" aria-label={title}>
          {loopBadge}
        </span>
      );
  }
}

/** Tooltip text for a workspace's status glyph. Shared by every surface that
 * renders one, so the same state cannot be described two different ways. */
// Re-exported from a plain .ts module so it can be unit-tested (node:test can't
// import JSX). Every existing import site keeps working unchanged.
export { statusGlyphTitle } from '../status-glyph-title.ts';
