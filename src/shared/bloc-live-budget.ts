/**
 * The live-frame budget of Bloc HTML (#419, spec #414, ADR 0011): which blocs are mounted, what a bloc remembers when it is not, and when a
 * frame that never reported counts as failed. Pure — no DOM, no clock: the renderer injects the timers. Figures come from docs/evidence/419-*.
 */

/** A bloc mounts when it comes within this many px of the scroll viewport … */
export const BLOC_MOUNT_MARGIN_PX = 800;
/** … and unmounts only when it is farther than this (hysteresis: a frame at the boundary must not reload — its scripts restart — on every wheel tick). */
export const BLOC_KEEP_MARGIN_PX = 1600;
/** Hard ceiling on live frames, whatever their heights (the margins bound them by distance only: 50 tiny blocs fit in one screen). docs/evidence/419-*: busy blocs cost ~180 MB / 54% of a core at 20, 282 MB / 82% at 40; 24 ≈ one screen of small blocs. */
export const BLOC_LIVE_MAX = 24;
/** A frame that is already live is kept over a challenger that is this many px nearer (a frame at rank MAX must not reload on every wheel tick). */
export const BLOC_LIVE_STICKY_PX = 400;

/** Height of a bloc that was never measured (placeholder, first mount). */
export const BLOC_INITIAL_HEIGHT_PX = 80;
/** No `load` in this long ⇒ the frame never ran (a script hogging the frame process, or a dead process). Not a "slow machine" figure: see the watchdog. */
export const BLOC_NO_LOAD_MS = 30_000;
/** Loaded but no height report in this long ⇒ the frame's script did not run (CSP, syntax, crash). Counted FROM `load`, never from the mount (#419 / #415 M3). */
export const BLOC_NO_REPORT_AFTER_LOAD_MS = 5_000;

/** Per-bloc memory across an unmount: the last measured height — of the frame, or of its code fallback — so the placeholder holds the layout. Bounded: oldest-inserted out. */
const HEIGHT_CACHE_MAX = 2000;
const heights = new Map<string, number>();
/** length + a hash of up to ~2k chars sampled across the WHOLE source (equal-length blocs that differ only in the middle must not share an entry). */
export function blocHeightKey(source: string): string {
  const step = Math.max(1, Math.floor(source.length / 2048));
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i += step) h = Math.imul(h ^ source.charCodeAt(i), 0x01000193) >>> 0;
  return `${source.length}:${h.toString(36)}`;
}
/** The key of one SURFACE of a bloc: the inline frame and the enlarged one have different widths, hence different heights. BlocSlot's placeholder reads the `inline` one. */
export const blocSurfaceKey = (mode: 'inline' | 'enlarged', source: string): string => `${mode}:${blocHeightKey(source)}`;
/** The key of a bloc's rendered BOX in its default state (what BlocSlot's placeholder must equal): the clipped height for a tall bloc, the code block's for a failed one. */
export const blocBoxKey = (source: string): string => `box:${blocHeightKey(source)}`;
/** Blocs the user EXPANDED (« Afficher tout »): a remount restores it so the box does not change under the reader. Bounded like the heights. */
const expanded = new Set<string>();
export const wasBlocExpanded = (k: string): boolean => expanded.has(k);
export function rememberBlocExpanded(k: string, on: boolean): void {
  if (!on) { expanded.delete(k); return; }
  expanded.add(k);
  if (expanded.size > HEIGHT_CACHE_MAX) expanded.delete(expanded.values().next().value as string);
}
/** These take the KEY (`blocHeightKey(source)`, computed once per bloc): a bloc may flood hundreds of thousands of height reports, each one must stay O(1). */
export function rememberBlocHeight(k: string, h: number): void {
  if (heights.get(k) === h) return;
  heights.delete(k); // re-insert = most recent
  heights.set(k, h);
  if (heights.size > HEIGHT_CACHE_MAX) heights.delete(heights.keys().next().value as string);
}
export const recallBlocHeight = (k: string): number => heights.get(k) ?? BLOC_INITIAL_HEIGHT_PX;
/** The remembered height or undefined (never measured). */
export const peekBlocHeight = (k: string): number | undefined => heights.get(k);
export const blocHeightCacheSize = (): number => heights.size;

export interface BlocWatchdogDeps<T> {
  /** The frame is judged failed: show the source as code. */
  fail: () => void;
  setTimer: (f: () => void, ms: number) => T;
  clearTimer: (t: T) => void;
}
/**
 * Fails a frame on missing PROGRESS, not on elapsed time: the clock for a height report starts at the frame's `load`, so a loaded renderer
 * that is slow to START many mounted frames never turns a healthy bloc into code (#415 review M3). `start` → `loaded` → `reported`.
 */
export function createBlocWatchdog<T>(d: BlocWatchdogDeps<T>) {
  let timer: T | null = null;
  let settled = false;
  const arm = (ms: number) => {
    if (timer !== null) d.clearTimer(timer);
    timer = d.setTimer(() => { timer = null; if (!settled) { settled = true; d.fail(); } }, ms);
  };
  const stop = () => { if (timer !== null) { d.clearTimer(timer); timer = null; } };
  return {
    start: () => { if (!settled) arm(BLOC_NO_LOAD_MS); },
    loaded: () => { if (!settled) arm(BLOC_NO_REPORT_AFTER_LOAD_MS); },
    reported: () => { settled = true; stop(); },
    stop,
  };
}

export interface LiveCandidate {
  id: string;
  /** Distance from the slot's centre to the viewport's centre, px. */
  dist: number;
  /** Currently mounted. */
  live: boolean;
}
/** Which of the blocs near the viewport are live: the `max` nearest, an already-live one winning a near-tie (stickiness). Pure; ties broken by id. */
export function chooseLiveBlocs(candidates: readonly LiveCandidate[], max: number, stickyPx: number = BLOC_LIVE_STICKY_PX): Set<string> {
  const rank = (c: LiveCandidate) => c.dist - (c.live ? stickyPx : 0);
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(sorted.slice(0, Math.max(0, max)).map((c) => c.id));
}

/**
 * The windowed transcript list renders rows [start, end); a row holding a PINNED bloc (open enlarge overlay / source view, #417) must stay rendered or the overlay dies
 * with its opener. Widens the slice to cover every pinned row index within `maxExtra` rows of it (contiguous: rows between are rendered too). The cap bounds the cost of a
 * NON-modal pin (an open source view the reader scrolled 500 rows away from): beyond it the pin is ignored and the row unmounts like any other.
 */
export const BLOC_PIN_MAX_EXTRA_ROWS = 120;
export function widenWindowForPins(start: number, end: number, pinnedIdx: readonly number[], len: number, maxExtra: number = BLOC_PIN_MAX_EXTRA_ROWS): [number, number] {
  let s = start, e = end;
  for (const i of pinnedIdx) {
    if (i < 0 || i >= len || i < start - maxExtra || i >= end + maxExtra) continue;
    if (i < s) s = i;
    if (i + 1 > e) e = i + 1;
  }
  return [s, e];
}
