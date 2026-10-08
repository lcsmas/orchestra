// The renderer-safe half of the browser Reliquats (#331): what the Resources page reads — the per-workspace counter and the grey « 🌐 N arrêtés » chip (D-Q4 A'). NO imports of any kind (the renderer
// bundles this file; the Node path module imported by src/shared/browser-reliquats.ts is why the chip lives apart — the headless-sway capture gate caught it). The decisions live in browser-reliquats.ts, which re-exports this.

export interface BrowserCounter {
  stopped: number;
  lastAt: number;
  lastPrefix: string;
}

/** What the Resources page reads (data layer; the chip itself is D4-gated): browsers stopped per workspace since the app started. */
export interface BrowserReliquatView {
  total: number;
  byWorkspace: Record<string, BrowserCounter>;
}

/** D-Q4 A' (the Resources chip): the grey « 🌐 N arrêtés » of ONE workspace row. null at 0 — nothing is drawn, and a row is never created for a counter (the caller only asks for rows that exist). */
export interface BrowserChip {
  count: number;
  title: string;
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function browserChipOf(view: BrowserReliquatView | null | undefined, wsId: string, fmtTime: (ms: number) => string = hhmm): BrowserChip | null {
  const c = view?.byWorkspace?.[wsId];
  if (!c || !(c.stopped > 0)) return null;
  const n = c.stopped;
  return { count: n, title: `${n} navigateur${n === 1 ? '' : 's'} headless orphelin${n === 1 ? '' : 's'} arrêté${n === 1 ? '' : 's'} depuis le démarrage — dernier à ${fmtTime(c.lastAt)}, profil ${c.lastPrefix} (laissé en place)` };
}
