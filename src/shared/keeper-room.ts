// #343 — the keeper leaf's MARGIN: how close keeper + CLI (leaf `k`) are to the room a FULL tool leaf leaves under the scope's backstop. PURE and dependency-free (the member view, the CLI line and the page share it).
// room = backstop − hard (the 1 GiB reserve by default). If k outgrows it, the next full tool leaf opens a scope-level OOM episode that can take the keeper or the CLI.

/** From this fraction of the room the margin reads « close » (amber); at 1 the keeper leaf ALONE fills the room a full tool leaf leaves, red. */
export const ROOM_WARN_FRACTION = 0.7;

export interface KeeperRoomInput {
  /** The scope's own `memory.max` (tool cap + room); null = no scope-level limit. */
  backstopBytes: number | null;
  /** The tool leaf's `memory.max` (the hard level actually held); null = none applied. */
  hardBytes: number | null;
  /** `k`'s working set (`memory.current` − `inactive_file`); null = `k/memory.stat` unreadable. */
  kWorkingSetBytes: number | null;
  /** `k`'s `memory.current`. */
  kCurrentBytes: number | null;
  /** The whole scope's `memory.current`. */
  scopeCurrentBytes: number | null;
  /** Kernel kills charged to `k` (`k/memory.events` oom_kill); null = unreadable. */
  kOomKills: number | null;
  /** OOM episodes the scope itself opened (`memory.events.local` oom): each is a backstop episode, killed or not. */
  scopeEpisodes: number | null;
}

export interface KeeperRoom {
  /** What `k` holds, working set when known (the page cache is reclaimed before any kill), else `memory.current` (an upper bound — `approx`). */
  kBytes: number;
  approx: boolean;
  /** backstop − hard: the room keeper + CLI have when the tool leaf is full. */
  roomBytes: number;
  /** kBytes / roomBytes (may exceed 1). */
  frac: number;
  /** Whole percent, FLOORED like the cap bar (« 70 % » always means at/over the amber line). */
  pct: number;
  /** backstop − scope.current: the headroom right now, null when the scope's own reading is missing. */
  freeBytes: number | null;
  tone: 'ok' | 'warn' | 'crit';
  /** The backstop's episodes on this scope: the larger of the kills charged to `k` and the OOM episodes the scope itself opened (one episode bumps both) — anything above 0 means the backstop has already acted. */
  netEvents: number;
}

/** The margin of the keeper leaf against the room, or null when it cannot be stated (no backstop, no tool cap, no k reading, or a tool cap at/above the backstop). Never a fabricated figure. */
export function keeperRoomOf(i: KeeperRoomInput): KeeperRoom | null {
  if (i.backstopBytes === null || i.hardBytes === null || i.backstopBytes <= i.hardBytes) return null;
  const k = i.kWorkingSetBytes ?? i.kCurrentBytes;
  if (k === null || !Number.isFinite(k) || k < 0) return null;
  const roomBytes = i.backstopBytes - i.hardBytes;
  const frac = k / roomBytes;
  return {
    kBytes: k,
    approx: i.kWorkingSetBytes === null,
    roomBytes,
    frac,
    pct: Math.floor(frac * 100 + 1e-9),
    freeBytes: i.scopeCurrentBytes === null ? null : i.backstopBytes - i.scopeCurrentBytes,
    tone: frac >= 1 ? 'crit' : frac >= ROOM_WARN_FRACTION ? 'warn' : 'ok',
    netEvents: Math.max(i.kOomKills ?? 0, i.scopeEpisodes ?? 0), // one scope-level episode that kills a `k` victim bumps BOTH counters: the larger is the number of episodes, never their sum (review minor)
  };
}

// ─── How the Resources page SAYS it (D-pick B, LEAD 2026-10-12: a chip only from 70 %, one tooltip line always, one dim line under the table) ───

const MIB = 1024 ** 2;
const GIB_ = 1024 ** 3;
/** « 0.9 GB », « 1 GB », « 90 MB » — one decimal from a GB, none for a whole GB, MB below. */
export function roomBytesText(n: number): string {
  if (n >= GIB_ / 2) {
    const g = Math.round((n / GIB_) * 10) / 10;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
  }
  return `${Math.round(n / MIB)} MB`;
}

export interface RoomChip {
  tone: 'warn' | 'crit';
  /** `k 0.9 GB / 1 GB room` */
  text: string;
  title: string;
}

/** The row's chip: null while the keeper leaf is comfortably inside the room (< 70 %) — a healthy page shows nothing; amber from 70 %, red from 100 % (k ALONE fills the room). */
export function roomChipOf(room: KeeperRoom | null | undefined): RoomChip | null {
  if (!room || room.tone === 'ok') return null;
  return { tone: room.tone, text: `k ${roomBytesText(room.kBytes)} / ${roomBytesText(room.roomBytes)} room`, title: roomTooltipLine(room) };
}

/** The tooltip line of the MEM cell, always present for a member whose margin is stateable. */
export function roomTooltipLine(room: KeeperRoom): string {
  const base = `keeper + CLI ${roomBytesText(room.kBytes)}${room.approx ? ' (upper bound: cache not separable)' : ''} of the ${roomBytesText(room.roomBytes)} room above the tool level (${room.pct} %)`;
  const tail = room.tone === 'crit' ? ' — above the room: a full tool leaf would open a scope-level OOM that can end the session' : room.tone === 'warn' ? ' — close to the room' : '';
  const acted = room.netEvents > 0 ? ` — the backstop has already acted on this scope (${room.netEvents} event${room.netEvents === 1 ? '' : 's'})` : '';
  return base + tail + acted;
}

/** The grey line's clause: « least room: feat-x 91 % of 1 GB » (the member with the highest k / room); null when no member has a margin. */
export function leastRoomClause(rows: ReadonlyArray<{ name: string; room?: KeeperRoom | null }>): string | null {
  const withRoom = rows.flatMap((r) => (r.room ? [{ name: r.name, room: r.room }] : []));
  if (withRoom.length === 0) return null;
  const worst = withRoom.reduce((a, b) => (b.room.frac > a.room.frac ? b : a));
  return `least room: ${worst.name} ${worst.room.pct} % of ${roomBytesText(worst.room.roomBytes)}`;
}
