// Popup bookkeeping for the browser panel (#396, spec #388 "Tabs and popups"): which user input may open a popup, and which native child windows a
// workspace holds. The routing DECISION is pure (src/shared/browser-tab-policy.ts `decidePopup`); the flow that applies it is `routePopup` in
// browser-panel.ts. Nothing here creates a window: Electron does (`setWindowOpenHandler` -> `allow`), this only registers and closes them.

import type { BrowserWindow, WebContents } from 'electron';
import type { BrowserTabOpener } from '../shared/types';
import { POPUP_RATE_WINDOW_MS, USER_GESTURE_WINDOW_MS } from '../shared/browser-tab-policy.ts';

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
  /** `w1`, `w2`… minted at registration, never reused: the memory attribution (#394) names a window by it. */
  id: string;
  /** The `window.open` target name ('' when unnamed): Electron's frame-name registry is process-global, so another workspace must not reuse a live one. */
  frameName: string;
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

let windowSeq = 0;

/** Record `p` for `wsId` (stamping its id); it leaves the registry when its window closes. */
export function registerPopupWindow(wsId: string, p: Omit<PopupWindow, 'id'>): PopupWindow {
  const entry: PopupWindow = { ...p, id: `w${++windowSeq}` };
  let set = windows.get(wsId);
  if (!set) windows.set(wsId, (set = new Set()));
  set.add(entry);
  entry.win.once('closed', () => windows.get(wsId)?.delete(entry));
  return entry;
}

/** Is a live popup window named `frameName` held by a workspace OTHER than `wsId`? (Electron would load a new popup's URL into it, across partitions.) */
export function frameNameHeldElsewhere(wsId: string, frameName: string): boolean {
  const name = frameName.trim();
  if (name === '') return false;
  for (const other of [...windows.keys()]) {
    if (other === wsId) continue;
    if (livePopupWindows(other).some((p) => p.frameName === name)) return true;
  }
  return false;
}

// ---- opening rate --------------------------------------------------------------------------------------------------------
// The budget is CONCURRENT (a popup that closes frees its slot), so a page that opens and closes popups would churn windows for ever: the policy also caps
// how many page-initiated popups a workspace may OPEN per minute. One timestamp per opened popup, per workspace, pruned on read.

const pageOpens = new Map<string, number[]>();

/** Record that `wsId` just opened a page-initiated popup. */
export function notePageInitiatedOpen(wsId: string, now: number = Date.now()): void {
  const list = pageOpens.get(wsId) ?? [];
  list.push(now);
  pageOpens.set(wsId, list);
}

/** How many page-initiated popups `wsId` opened within the last rate window. */
export function recentPageInitiatedOpens(wsId: string, now: number = Date.now()): number {
  const fresh = (pageOpens.get(wsId) ?? []).filter((t) => now - t < POPUP_RATE_WINDOW_MS);
  if (fresh.length === 0) pageOpens.delete(wsId);
  else pageOpens.set(wsId, fresh);
  return fresh.length;
}

/** Forget a workspace's opening history (delete / archive). */
export function forgetPopupRate(wsId: string): void {
  pageOpens.delete(wsId);
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
  forgetPopupRate(wsId);
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
