// Browser tab policy (#393, spec #388 "Tabs and popups") — PURE: no Electron, no fs. The rules the main-process tab layer
// (src/main/browser-panel.ts) applies BEFORE it creates or destroys a view, so a refusal never allocates anything:
//   - the cap: at most BROWSER_TAB_CAP tabs per workspace, human + agent combined;
//   - who opened each tab (BrowserTabOpener) and who may close what: the human closes any tab, an agent only its own (#397 consumes this);
//   - what closing a tab leaves active, and what closing the LAST tab means (it is replaced by a blank tab — the panel never has zero);
//   - popup routing (#396): `_blank`/unnamed -> tab, opener-dependent -> native child window, page-initiated -> budget, all under the same cap.

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

/** May `opener` open one more tab when the workspace already holds `openCount`? The cap is the only rule here; `opener` is carried for a per-opener rule. Popups (#396) are decided by `decidePopup`, which counts child windows with the tabs. */
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

// ---- renderer: when does a panel event re-open the pane? --------------------------------------------------------------

/** What the renderer remembers per workspace between `browser:event`s. */
export interface BrowserAutoOpenMemo {
  key: string;
  loading: boolean;
}

/** `browser:event` -> should the renderer mark this workspace's pane OPEN (an agent drove a closed pane)? Only when the ACTIVE tab did
 *  something an agent does: it navigated to a new (activeTabId, url) key, OR it STARTED loading (a same-url navigate / reload emits
 *  `did-start-loading` — the key does not change, the agent still needs its pane). A background tab's title / loading event re-publishes
 *  the active tab's unchanged url AND unchanged `loading`, so it neither changes the key nor raises the edge: it must not re-open a pane
 *  the user closed (#393 F2; up to 8 live tabs per workspace feed that stream). `prev` = the `next` returned for the previous event of
 *  this workspace (undefined before the first) — never clear it when the user closes the pane. */
export function decideBrowserAutoOpen(
  prev: BrowserAutoOpenMemo | undefined,
  state: { activeTabId: string; url: string; loading: boolean },
): { open: boolean; next: BrowserAutoOpenMemo } {
  const key = state.url ? `${state.activeTabId}\n${state.url}` : '';
  const next = { key, loading: state.loading };
  const navigated = key !== '' && key !== prev?.key;
  const startedLoading = key !== '' && state.loading && !prev?.loading;
  return { open: navigated || startedLoading, next };
}

// ---- popups (#396) -----------------------------------------------------------------------------------------------------

/** Page-initiated popups (opened WITHOUT a user gesture) a workspace may hold open at once, tabs and child windows together (spec #388 story 14). */
export const POPUP_BUDGET = 3;

/** Chromium's transient user-activation lifetime: an input this recent is the gesture that may open a popup (the main process consumes it on use). */
export const USER_GESTURE_WINDOW_MS = 5000;

/** What `webContents.setWindowOpenHandler` hands us about a page-opened window, plus the gesture the main process tracked. */
export interface PopupRequest {
  url: string;
  /** `window.open` target name; '' for `_blank` / unnamed (Electron strips `_blank`), a name for a named window. */
  frameName: string;
  /** Electron's disposition: `foreground-tab` (link / plain window.open), `background-tab` (ctrl/middle click), `new-window` (window.open with popup features), … */
  disposition: string;
  /** window.open features string (`noopener` shows here only for an explicit `window.open(…, 'noopener')`, never for `rel=noopener`). */
  features: string;
  /** Whether a fresh user input on the opener started it (Electron's handler does not say; main tracks `input-event`, one input = one popup). */
  userGesture: boolean;
}

/** What the workspace holds right now. The counts come from the live registries, never from a counter that could drift. */
export interface PopupContext {
  openTabs: number;
  /** Live popup child windows (they count against the cap with the tabs). */
  openWindows: number;
  /** Page-initiated popups (tabs + windows) still open. */
  pageInitiatedOpen: number;
  cap?: number;
  budget?: number;
}

export type PopupRefusal = 'cap' | 'budget' | 'unsafe-url' | 'no-gesture-external';

/** Where a popup goes. */
export type PopupRouteDecision =
  /** `_blank` / unnamed: a new tab (no opener). `activate` only for a user's foreground click. */
  | { route: 'new-tab'; activate: boolean; pageInitiated: boolean }
  /** `window.opener`-dependent (named, or a sized popup): a native child window that KEEPS its opener, so an OAuth sign-in can post back. */
  | { route: 'child-window'; pageInitiated: boolean }
  /** A non-web scheme the user clicked: the OS handles it. */
  | { route: 'external' }
  | { route: 'refuse'; reason: PopupRefusal; message: string };

type UrlKind = 'web' | 'blank' | 'external' | 'unsafe';

/** Schemes a page-controlled popup must never hand to the OS or load: script, inline documents, local files, internal pages. */
const UNSAFE_SCHEMES = /^(javascript|data|file|vbscript|blob|chrome|chrome-untrusted|devtools|view-source|filesystem|about):/i;

function classifyUrl(url: string): UrlKind {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return 'web';
  if (u === '' || /^about:blank$/i.test(u)) return 'blank';
  if (UNSAFE_SCHEMES.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return 'unsafe';
  return 'external';
}

/** Does this `window.open` features string opt out of the opener (`noopener`, not `noopener=0|no|false`)? */
function featuresDenyOpener(features: string): boolean {
  return features.split(/[\s,]+/).some((tok) => {
    const [k, v = ''] = tok.toLowerCase().split('=');
    return k === 'noopener' && !['0', 'no', 'false'].includes(v);
  });
}

/** Does the page need `window.opener` in the popup? A NAMED window (the page addresses it, and OAuth libraries post back to it) or a sized/positioned
 *  popup (`new-window` WITH features) is; a plain `_blank` link / unnamed `window.open` is a tab; an explicit `noopener` is a tab either way. */
export function popupNeedsOpener(req: Pick<PopupRequest, 'frameName' | 'disposition' | 'features'>): boolean {
  if (featuresDenyOpener(req.features)) return false;
  const name = req.frameName.trim().toLowerCase();
  if (name !== '' && !['_blank', '_self', '_parent', '_top'].includes(name)) return true;
  return req.disposition === 'new-window' && req.features.trim() !== ''; // no features = a shift-clicked link, not a sized popup
}

/** Route a popup (spec #388 "Tabs and popups"): web `_blank` / unnamed -> new tab; opener-dependent -> native child window; a page-initiated popup (no
 *  gesture) draws on a budget; tabs + child windows share the per-workspace cap. A refusal allocates nothing. */
export function decidePopup(req: PopupRequest, ctx: PopupContext): PopupRouteDecision {
  const cap = ctx.cap ?? BROWSER_TAB_CAP;
  const budget = ctx.budget ?? POPUP_BUDGET;
  const kind = classifyUrl(req.url);
  if (kind === 'unsafe') {
    return { route: 'refuse', reason: 'unsafe-url', message: 'A page tried to open a window on a script, file or internal URL: refused.' };
  }
  if (kind === 'external') {
    // An OS hand-off cannot be counted against a budget, so only a user's own click may start one.
    return req.userGesture
      ? { route: 'external' }
      : { route: 'refuse', reason: 'no-gesture-external', message: 'A page tried to open an external application without a click: refused.' };
  }
  if (ctx.openTabs + ctx.openWindows >= cap) {
    return { route: 'refuse', reason: 'cap', message: `Popup refused: a workspace holds at most ${cap} browser tabs and popup windows. Close one first.` };
  }
  if (!req.userGesture && ctx.pageInitiatedOpen >= budget) {
    return { route: 'refuse', reason: 'budget', message: `Popup refused: a page may hold at most ${budget} popups it opened without a click.` };
  }
  const pageInitiated = !req.userGesture;
  if (popupNeedsOpener(req)) return { route: 'child-window', pageInitiated };
  return { route: 'new-tab', activate: req.userGesture && req.disposition !== 'background-tab', pageInitiated };
}
