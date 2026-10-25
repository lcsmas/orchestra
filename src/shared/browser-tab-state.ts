// Persisted browser tabs (#393) — PURE: the shape of what survives an app restart (per workspace: each tab's URL + opener, and which one was active)
// and the defensive parse of the file it lives in. The main-process half (src/main/browser-tabs-store.ts) only reads/writes the JSON.

import { BROWSER_TAB_CAP } from './browser-tab-policy.ts';
import type { BrowserTabOpener } from './types.ts';

export interface PersistedBrowserTab {
  /** '' for a tab that never navigated — it still counts as a tab and comes back blank. */
  url: string;
  openedBy: BrowserTabOpener;
}

export interface PersistedBrowserTabs {
  tabs: PersistedBrowserTab[];
  /** Index into `tabs` of the active tab (always in range). */
  activeIndex: number;
}

/** The whole file: workspace id -> its tabs. */
export interface PersistedBrowserTabsFile {
  version: 1;
  workspaces: Record<string, PersistedBrowserTabs>;
}

/** A URL that is safe to navigate to after a restart: web, file or about:blank. Anything else (javascript:, chrome:, data:, a corrupt string) restores as a blank tab. */
export function restorableUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  if (u === 'about:blank') return '';
  return /^(https?|file):/i.test(u) ? u : '';
}

/** Snapshot a live panel's tabs for persistence (`tabs` in display order, `activeId` the active tab's id). */
export function snapshotTabs(
  tabs: readonly { id: string; url: string; openedBy: BrowserTabOpener }[],
  activeId: string,
): PersistedBrowserTabs {
  const kept = tabs.slice(0, BROWSER_TAB_CAP);
  const found = kept.findIndex((t) => t.id === activeId);
  return {
    tabs: kept.map((t) => ({ url: restorableUrl(t.url), openedBy: t.openedBy })),
    activeIndex: found >= 0 ? found : 0,
  };
}

/** Parse one workspace's persisted entry; null when it holds nothing restorable. Clamps to the cap and the active index to range. */
export function parsePersistedTabs(raw: unknown): PersistedBrowserTabs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { tabs?: unknown; activeIndex?: unknown };
  if (!Array.isArray(r.tabs)) return null;
  const tabs: PersistedBrowserTab[] = [];
  for (const t of r.tabs) {
    if (tabs.length >= BROWSER_TAB_CAP) break;
    if (!t || typeof t !== 'object') continue;
    const e = t as { url?: unknown; openedBy?: unknown };
    tabs.push({ url: restorableUrl(e.url), openedBy: e.openedBy === 'agent' ? 'agent' : 'human' });
  }
  if (tabs.length === 0) return null;
  const ai = typeof r.activeIndex === 'number' && Number.isInteger(r.activeIndex) ? r.activeIndex : 0;
  return { tabs, activeIndex: ai >= 0 && ai < tabs.length ? ai : 0 };
}

/** Parse the whole file. Never throws: a corrupt or foreign file is an empty map (a fresh start), not a crash at boot. */
export function parseBrowserTabsFile(text: string): Record<string, PersistedBrowserTabs> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  if (!json || typeof json !== 'object') return {};
  const ws = (json as { workspaces?: unknown }).workspaces;
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return {};
  const out: Record<string, PersistedBrowserTabs> = {};
  for (const [id, entry] of Object.entries(ws as Record<string, unknown>)) {
    const p = parsePersistedTabs(entry);
    if (p) out[id] = p;
  }
  return out;
}

export function serializeBrowserTabsFile(workspaces: Record<string, PersistedBrowserTabs>): string {
  const file: PersistedBrowserTabsFile = { version: 1, workspaces };
  return JSON.stringify(file);
}
