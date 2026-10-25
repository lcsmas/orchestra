// Browser tab policy (#393, spec #388 "Tabs and popups") — PURE: no Electron, no fs. The rules the main-process tab layer
// (src/main/browser-panel.ts) applies BEFORE it creates or destroys a view, so a refusal never allocates anything:
//   - the cap: at most BROWSER_TAB_CAP tabs per workspace, human + agent combined;
//   - who opened each tab (BrowserTabOpener) and who may close what: the human closes any tab, an agent only its own (#397 consumes this);
//   - what closing a tab leaves active, and what closing the LAST tab means (it is replaced by a blank tab — the panel never has zero);
//   - the popup-routing decision SHAPE (#396 fills the routing; today every popup keeps the pre-tabs behaviour).

import type { BrowserTabOpener } from './types.ts';

/** Tabs a workspace may hold, human and agent combined (spec #388, user story 15: 20 workspaces x tabs must not push the machine to critical memory). */
export const BROWSER_TAB_CAP = 8;

/** The tab-opener roles as values (api-handlers acts for the HUMAN; #397 for the AGENT). Named so no `'human'` string literal is spread over the main process: the pause-origin guard (pause-gates-wiring.test.ts) counts those. */
export const HUMAN_OPENER: BrowserTabOpener = 'human';
export const AGENT_OPENER: BrowserTabOpener = 'agent';

/** The least a policy decision needs to know about one tab. */
export interface PolicyTab {
  id: string;
  openedBy: BrowserTabOpener;
}

// ---- open ------------------------------------------------------------------------------------------------------------

export type TabOpenDecision =
  | { ok: true }
  | { ok: false; reason: 'cap'; cap: number; open: number; message: string };

/** May `opener` open one more tab when the workspace already holds `openCount`? The cap is the only rule today; `opener` is carried so a per-opener budget (#396 page-initiated popups) extends this without a new signature. */
export function decideTabOpen(input: { openCount: number; opener: BrowserTabOpener; cap?: number }): TabOpenDecision {
  const cap = input.cap ?? BROWSER_TAB_CAP;
  if (input.openCount < cap) return { ok: true };
  return {
    ok: false,
    reason: 'cap',
    cap,
    open: input.openCount,
    message: `Tab limit reached: a workspace holds at most ${cap} browser tabs. Close one first.`,
  };
}

// ---- close -----------------------------------------------------------------------------------------------------------

export type TabCloseDecision =
  | {
      ok: true;
      /** The tab to activate afterwards: the current one when a background tab closed; the right neighbour (else the left) when the active one closed; null when the panel needs a fresh blank tab. */
      nextActiveId: string | null;
      /** True when the closed tab was the last one: the caller replaces it with a blank human tab instead of leaving the panel tab-less. */
      replaceWithBlank: boolean;
    }
  | { ok: false; reason: 'unknown-tab' | 'not-owner'; message: string };

/** May `actor` close `tabId`, and what is active afterwards? The human closes any tab; an agent only a tab it opened (spec user story 37). */
export function decideTabClose(input: {
  tabs: readonly PolicyTab[];
  activeId: string | null;
  tabId: string;
  actor: BrowserTabOpener;
}): TabCloseDecision {
  const idx = input.tabs.findIndex((t) => t.id === input.tabId);
  if (idx < 0) return { ok: false, reason: 'unknown-tab', message: `No such browser tab: ${input.tabId}.` };
  const tab = input.tabs[idx];
  if (input.actor === 'agent' && tab.openedBy !== 'agent') {
    return {
      ok: false,
      reason: 'not-owner',
      message: `Tab ${input.tabId} was opened by the user: an agent may close only the tabs it opened.`,
    };
  }
  if (input.tabs.length === 1) return { ok: true, nextActiveId: null, replaceWithBlank: true };
  if (input.activeId !== input.tabId) return { ok: true, nextActiveId: input.activeId, replaceWithBlank: false };
  const neighbour = input.tabs[idx + 1] ?? input.tabs[idx - 1];
  return { ok: true, nextActiveId: neighbour.id, replaceWithBlank: false };
}

// ---- popups (shape only — #396 implements the routing) -----------------------------------------------------------------

/** What `webContents.setWindowOpenHandler` hands us about a page-opened window, plus what #396 adds (user gesture, opener dependence). */
export interface PopupRequest {
  url: string;
  /** `window.open` target name; `_blank` / '' / `_self` / a named frame. */
  frameName: string;
  /** Electron's disposition: `foreground-tab`, `background-tab`, `new-window`, … */
  disposition: string;
  /** window.open features string. */
  features: string;
  /** Whether a user gesture started the popup (not provided by Electron's handler today — #396 plumbs it). */
  userGesture?: boolean;
}

/** Where a popup goes. A discriminated union on `route` so #396 adds arms (`new-tab`, `child-window`, `refuse`) without touching callers that already switch on it exhaustively. */
export type PopupRouteDecision =
  | { route: 'same-view' }
  | { route: 'external' };
// #396 adds: { route: 'new-tab'; activate: boolean } | { route: 'child-window' } | { route: 'refuse'; reason: string }

/** Route a popup. TODAY (pre-#396) this is the behaviour the panel always had: a web URL loads in the opener's own view, anything else goes to the OS. #396 replaces the body with the real routing (`_blank` -> tab, opener-dependent -> child window, page-initiated -> budget). */
export function decidePopup(req: PopupRequest): PopupRouteDecision {
  return /^https?:/i.test(req.url) ? { route: 'same-view' } : { route: 'external' };
}
