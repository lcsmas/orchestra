// Sidebar density — row text size, row height, gap between rows — set by the human in the "Aa" window
// (SidebarAppearanceSettings), persisted in localStorage like the sidebar width, applied as the --sb-* knobs of
// sidebar-orca.css. Picked from the round-3 prototype (branch prototype/sidebar-orca-3), 2026-10-31.
import { useSyncExternalStore } from 'react';

export type SidebarDensity = { font: number; rowH: number; gap: number };
/** "Normal" from the prototype: one step denser than the first Orca port (12 / 32 / 4), which read too big. */
export const DEFAULT_DENSITY: SidebarDensity = { font: 11.5, rowH: 28, gap: 2 };
export const DENSITY_LIMITS = {
  font: { min: 10, max: 14, step: 0.5 },
  rowH: { min: 20, max: 36, step: 1 },
  gap: { min: 0, max: 8, step: 1 },
} as const;
export const DENSITY_KEY = 'orchestra.sidebarDensity';

const snap = (v: unknown, k: keyof SidebarDensity): number => {
  const { min, max, step } = DENSITY_LIMITS[k];
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_DENSITY[k];
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
};
/** Clamp + snap every field; anything unreadable falls back to the default for that field. */
export function normalizeDensity(v: unknown): SidebarDensity {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { font: snap(o.font, 'font'), rowH: snap(o.rowH, 'rowH'), gap: snap(o.gap, 'gap') };
}
export function parseDensity(raw: string | null): SidebarDensity {
  if (!raw) return { ...DEFAULT_DENSITY };
  try { return normalizeDensity(JSON.parse(raw)); } catch { return { ...DEFAULT_DENSITY }; }
}
/** The inline style the aside carries; CSS reads these knobs (the row height can never undercut the text). */
export function densityVars(d: SidebarDensity): Record<string, string> {
  return {
    '--sb-font': `${d.font}px`,
    '--sb-head-font': `${d.font}px`,
    '--sb-row-h': `${Math.max(d.rowH, Math.ceil(d.font * 1.5) + 2)}px`,
    '--sb-row-gap': `${d.gap}px`,
  };
}

// ── store (renderer only) ───────────────────────────────────────────────────
let current: SidebarDensity | null = null;
const subs = new Set<() => void>();
function read(): SidebarDensity {
  if (!current) {
    try { current = parseDensity(localStorage.getItem(DENSITY_KEY)); } catch { current = { ...DEFAULT_DENSITY }; }
  }
  return current;
}
export function setSidebarDensity(d: SidebarDensity): void {
  current = normalizeDensity(d);
  try { localStorage.setItem(DENSITY_KEY, JSON.stringify(current)); } catch { /* best-effort, like the other UI prefs */ }
  subs.forEach((f) => f());
}
export function useSidebarDensity(): SidebarDensity {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, read);
}
