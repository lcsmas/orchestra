// Pure time-formatting logic for the structured view's bubble time indication:
// the hover timestamp on each bubble and the per-turn divider (time + day label
// + idle gap) rendered above every user turn. Dependency-free so `node --test`
// covers it without Electron.

/** "14:32" — 24h wall-clock, the compact per-bubble/divider form. */
export function formatClock(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Full precision for tooltips — "Mon 17 Aug 2026, 14:32:07". */
export function formatFullStamp(atMs: number): string {
  const d = new Date(atMs);
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${day}, ${formatClock(atMs)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Midnight-boundary day index (local time) — equal iff same calendar day. */
function dayOrdinal(atMs: number): number {
  const d = new Date(atMs);
  return d.getFullYear() * 10_000 + d.getMonth() * 100 + d.getDate();
}

/** "Today" / "Yesterday" / "Mon 12 Aug" (+" 2025" when not this year),
 *  relative to `nowMs`. */
export function formatDayLabel(atMs: number, nowMs: number): string {
  const ord = dayOrdinal(atMs);
  if (ord === dayOrdinal(nowMs)) return 'Today';
  if (ord === dayOrdinal(nowMs - 86_400_000)) return 'Yesterday';
  const d = new Date(atMs);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Compact idle-gap form: "+3m", "+2h 5m", "+3d". Sub-minute → "". */
export function formatGap(gapMs: number): string {
  const m = Math.floor(gapMs / 60_000);
  if (m < 1) return '';
  if (m < 60) return `+${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem > 0 ? `+${h}h ${rem}m` : `+${h}h`;
  }
  return `+${Math.floor(h / 24)}d`;
}

/** Gaps below this stay silent on the divider — a normal conversational pause,
 *  not an idle period worth calling out. */
export const DIVIDER_GAP_MIN_MS = 10 * 60_000;

export interface TurnDivider {
  /** "14:32" — always present. */
  time: string;
  /** Day label, only when this turn starts a new calendar day in the
   *  transcript (or is the first stamped turn). */
  day?: string;
  /** "+2h 5m" idle gap since the previous message, only when ≥ 10 min. */
  gap?: string;
  /** Tooltip precision. */
  title: string;
}

/** Divider content for a user turn at `atMs`, given the previous stamped
 *  message's time (`prevAtMs`, undefined for the transcript's first) and the
 *  current wall clock (for Today/Yesterday). */
export function computeTurnDivider(
  atMs: number,
  prevAtMs: number | undefined,
  nowMs: number,
): TurnDivider {
  const newDay = prevAtMs === undefined || dayOrdinal(prevAtMs) !== dayOrdinal(atMs);
  const gapMs = prevAtMs === undefined ? 0 : atMs - prevAtMs;
  const gap = gapMs >= DIVIDER_GAP_MIN_MS ? formatGap(gapMs) : '';
  return {
    time: formatClock(atMs),
    ...(newDay ? { day: formatDayLabel(atMs, nowMs) } : {}),
    ...(gap ? { gap } : {}),
    title: formatFullStamp(atMs),
  };
}
