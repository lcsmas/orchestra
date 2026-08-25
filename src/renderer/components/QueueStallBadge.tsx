import { useEffect, useState } from 'react';
import type { Workspace } from '../../shared/types.ts';
import { workspaceQueueStall, QUEUE_STALL_THRESHOLD_MS } from '../../shared/queue-stall.ts';

/** How often the stall verdict is re-derived. The threshold is 15 minutes, so
 *  a 30s clock puts the badge on screen within 30s of the crossing — far below
 *  any latency that matters for a condition measured in quarter-hours, and
 *  cheap enough to leave running: the tick sets a NUMBER, and every consumer
 *  re-derives a pure function over fields it already has. */
const TICK_MS = 30_000;

/** A monotonically-advancing coarse clock, shared by every badge on screen.
 *
 *  Why a clock at all: a stall CROSSES its threshold by the mere passage of
 *  time. No store event fires at that moment — the parked count has not
 *  changed and neither has the last turn start — so a purely event-driven
 *  badge would sit invisible until something unrelated happened to re-render
 *  the row. That is a detector that fires only when you were already looking,
 *  which is the exact failure #88 exists to fix.
 *
 *  ONE interval for the whole sidebar rather than one per row: a fleet of
 *  dozens of rows would otherwise each hold a timer, and they would fire at
 *  staggered times, re-rendering rows piecemeal. */
let subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function useStallClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    subscribers.add(setNow);
    if (!timer) timer = setInterval(() => {
      const t = Date.now();
      for (const fn of subscribers) fn(t);
    }, TICK_MS);
    return () => {
      subscribers.delete(setNow);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

/** Round a duration to the coarsest honest unit. A stall reported as "17min"
 *  is no more useful than "17min" rounded, and a badge that reads "0min" while
 *  claiming a stall is a contradiction the human has to resolve — so the
 *  minimum shown is the threshold's own unit. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The queue-stall badge (issue #88) — "N deliveries are waiting here and this
 * workspace has not started a turn in X".
 *
 * Renders NOTHING in the overwhelmingly common case (nothing parked, or the
 * workspace is consuming normally), so it can be dropped onto every row
 * unconditionally. See `src/shared/queue-stall.ts` for the policy and for why
 * it stands down when #69 has already explained the cause.
 *
 * A NUMERIC PILL, modelled on `ws-hidden-count`, rather than a new
 * `WorkspaceStatusGlyph` shape: the glyph slot is the STATUS axis and #69
 * already owns it for stop reasons. A stall is orthogonal to status — the same
 * way `loopingSince` and `autoUnread` are — and orthogonal axes render as
 * badges beside the glyph, not as competing shapes inside it. It also has a
 * COUNT to show, which a glyph has nowhere to put.
 */
export function QueueStallBadge({ w }: { w: Workspace }): React.ReactElement | null {
  const now = useStallClock();
  const stall = workspaceQueueStall(w, now);
  if (!stall) return null;
  const parts: string[] = [];
  if (stall.queuedCount > 0) {
    parts.push(`${stall.queuedCount} queued prompt${stall.queuedCount === 1 ? '' : 's'}`);
  }
  if (stall.parkedInboxCount > 0) {
    parts.push(`${stall.parkedInboxCount} parked message${stall.parkedInboxCount === 1 ? '' : 's'}`);
  }
  const age = formatAge(stall.stalledForMs);
  // The tooltip names the SPLIT behind the number. The badge shows one figure
  // because a human triaging a frozen fleet does not care which pipe the work
  // arrived through — but "2 waiting" with no way to learn what the 2 are is a
  // number you cannot act on.
  const title =
    `Stalled: ${parts.join(' + ')} waiting, and no turn has started here in ${age}. ` +
    `Nothing recorded why — check whether this agent's session is still alive.`;
  return (
    <span
      className="ws-stall-badge"
      title={title}
      role="img"
      aria-label={title}
      data-stall-minutes={Math.floor(stall.stalledForMs / 60_000)}
      data-stall-parked={stall.parkedCount}
    >
      {/* Lucide `triangle-alert`, matching the outlined-stroke idiom of the
          status glyphs so the two read as one family at 10px. */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      {stall.parkedCount}
    </span>
  );
}

export { QUEUE_STALL_THRESHOLD_MS };
