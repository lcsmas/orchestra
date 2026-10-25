// Popup bookkeeping for the browser panel (#396, spec #388 "Tabs and popups"): which user input may open a popup, and which native child windows a
// workspace holds. The routing DECISION is pure (src/shared/browser-tab-policy.ts `decidePopup`); the flow that applies it is `routePopup` in
// browser-panel.ts. Nothing here creates a window: Electron does (`setWindowOpenHandler` -> `allow`), this only registers and closes them.

import type { BrowserWindow, WebContents } from 'electron';
import type { BrowserTabOpener } from '../shared/types';
import { USER_GESTURE_WINDOW_MS } from '../shared/browser-tab-policy.ts';

// ---- user gesture ------------------------------------------------------------------------------------------------------
// Electron's window-open handler does not say whether a user gesture started the popup. `input-event` fires for real input (also CDP-dispatched
// input, which is how the agent clicks), so the last activating input on the opener is the gesture, and — as in Chromium — opening a popup consumes it.

/** Input events that start a user activation (`mouseDown` also covers a click's down half; moves, wheel and key-ups do not). */
const ACTIVATING_INPUT = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'touchEnd']);

const lastActivation = new WeakMap<WebContents, number>();
const tracked = new WeakSet<WebContents>();

/** Start recording the activating inputs of `wc` (idempotent). */
export function trackUserGesture(wc: WebContents, now: () => number = Date.now): void {
  if (tracked.has(wc)) return;
  tracked.add(wc);
  wc.on('input-event', (_e, input) => {
    if (ACTIVATING_INPUT.has(input.type)) lastActivation.set(wc, now());
  });
  // A new document starts with no activation (as in Chromium): a click on page A must not let the page it navigated to open a popup.
  wc.on('did-navigate', () => lastActivation.delete(wc));
}

/** Was there an activating input on `wc` within the gesture window? Consumes it: one input opens at most one popup. */
export function consumeUserGesture(wc: WebContents, now: number = Date.now()): boolean {
  const at = lastActivation.get(wc);
  if (at === undefined) return false;
  lastActivation.delete(wc);
  return now - at <= USER_GESTURE_WINDOW_MS;
}

// ---- native child windows ----------------------------------------------------------------------------------------------

/** One popup child window (an `window.opener` popup, e.g. an OAuth sign-in). */
export interface PopupWindow {
  win: BrowserWindow;
  /** The contents that called `window.open` (a tab, or another child window). */
  opener: WebContents;
  /** Who owns it for the tab-ownership rule: inherited from the tab that started the chain. */
  openedBy: BrowserTabOpener;
  /** Opened without a user gesture: counts against the budget while it lives. */
  pageInitiated: boolean;
}

const windows = new Map<string, Set<PopupWindow>>();

const alive = (p: PopupWindow): boolean => !p.win.isDestroyed();

/** The workspace's live popup windows (destroyed ones are pruned here, so a count can never drift past a window that closed). */
export function livePopupWindows(wsId: string): PopupWindow[] {
  const set = windows.get(wsId);
  if (!set) return [];
  for (const p of set) if (!alive(p)) set.delete(p);
  if (set.size === 0) windows.delete(wsId);
  return [...set];
}

/** Record `p` for `wsId`; it leaves the registry when its window closes. */
export function registerPopupWindow(wsId: string, p: PopupWindow): void {
  let set = windows.get(wsId);
  if (!set) windows.set(wsId, (set = new Set()));
  set.add(p);
  p.win.once('closed', () => windows.get(wsId)?.delete(p));
}

/** Destroy a window, tolerating one that is already gone. */
function destroyWindow(p: PopupWindow): void {
  try {
    if (alive(p)) p.win.destroy();
  } catch {
    /* already gone */
  }
}

/** Destroy every popup window of `wsId` (workspace delete / archive: none may outlive it). */
export function closePopupWindows(wsId: string): void {
  for (const p of livePopupWindows(wsId)) destroyWindow(p);
  windows.delete(wsId);
}

/** Destroy the popup windows `opener` opened — and, through them, the ones those opened — when `opener` goes away. */
export function closePopupsOpenedBy(wsId: string, opener: WebContents): void {
  for (const p of livePopupWindows(wsId)) {
    if (p.opener !== opener) continue;
    const child = p.win.isDestroyed() ? undefined : p.win.webContents;
    destroyWindow(p);
    if (child) closePopupsOpenedBy(wsId, child);
  }
}

/** Show or hide the workspace's popup windows with its panel: a child window must not float over another workspace's UI. */
export function setPopupWindowsVisible(wsId: string, visible: boolean): void {
  for (const p of livePopupWindows(wsId)) {
    if (visible) p.win.showInactive();
    else p.win.hide();
  }
}
