import { WebContentsView, Menu, clipboard, session, shell } from 'electron';
// Namespace import on purpose: the stub-`electron` harnesses of #391/#393 (src/main/browser-panel-tabs.test.ts, scripts/verify-*-browser-panel*.mjs) do not export
// BrowserWindow, and a NAMED import of a missing export fails to link; only the popup factory constructs one.
import * as electronNs from 'electron';
import type {
  BrowserBounds,
  BrowserPanelState,
  BrowserTabId,
  BrowserTabInfo,
  BrowserTabOpener,
  BrowserTabRefusal,
  BrowserTabResult,
} from '../shared/types';
// NOTE the .ts extension on this VALUE import: it matches the convention the
// rest of main uses for shared modules (git.ts → ci-state.ts, workspaces.ts →
// status-text.ts), so this file stays resolvable if it is ever pulled into the
// type-stripping test runner, which does not resolve extensionless specifiers.
import {
  buildSelectorPath,
  clipForBox,
  shapePick,
  type DesignPick,
} from '../shared/design-mode.ts';
import { BROWSER_TAB_CAP, decidePopup, decideTabClose, decideTabOpen, isOsHandoffUrl } from '../shared/browser-tab-policy.ts';
import { buildChildWindowOptions, popupWindowTitle, POPUP_WEB_PREFERENCES } from '../shared/browser-popup-window.ts';
import { restorableUrl, snapshotTabs } from '../shared/browser-tab-state.ts';
import {
  closePopupWindows,
  closePopupsOpenedBy,
  consumeUserGesture,
  frameNameHeldByOther,
  livePopupWindows,
  notePageInitiatedOpen,
  recentPageInitiatedOpens,
  registerPopupWindow,
  setPopupWindowsVisible,
  trackUserGesture,
} from './browser-popups.ts';
import type { BrowserTabsPersistence } from './browser-tabs-store';
import { platform } from './platform';
import { log } from './logger';
import { setBrowserTabSource } from './browser-tab-memory.ts';

// Per-workspace embedded browser panel — an Electron `WebContentsView` overlaid
// on the React renderer inside the main window, that BOTH the user drives
// manually (URL bar, back/forward) AND the agent drives programmatically via
// this view's own `webContents.debugger` (Electron's in-process Chrome DevTools
// Protocol). This mirrors the Claude Code desktop app's "Browser pane", which —
// per a comment left in its bundle — is "Adapted from chrome-devtools-mcp
// patterns but using Electron's internal `webContents.debugger` API instead of
// an external CDP connection." So there is NO `--remote-debugging-port`, no
// spawned Chromium, no puppeteer, and no MCP subprocess: everything runs
// in-process against a view Orchestra owns.
//
// Isolation: the registry keys every panel by `wsId`, and each panel holds an
// ordered list of tabs (one native view each) with one ACTIVE tab. The agent's
// browser tools (agent-browser-tools.ts) close over their session's `wsId` and
// route through the registry, so a workspace's agent can only drive that
// workspace's panel — multiple workspaces each get an independent browser by
// construction. Every primitive acts on the active tab unless handed a `tabId`.
//
// This file is Electron-only: it owns native views, so only the main process
// touches it. The renderer reaches it through IPC (`browser:*`) and receives
// pushes on `browser:event`.


/** Per-tab navigation snapshot — what {@link BrowserPanelState} mirrors for the
 *  ACTIVE tab and {@link BrowserTabInfo} lists for every tab. */
type TabNav = Pick<
  BrowserPanelState,
  'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'error'
>;

/** One browser tab: a native view + its own debugger and navigation state.
 *
 *  `view` is always assigned at construction and never reassigned — but the
 *  `WebContentsView` it points at can OUTLIVE its own `webContents`: Electron
 *  sets `view.webContents` to `undefined` once the underlying WebContents is
 *  destroyed, even though its typing declares the property non-nullable
 *  (`readonly webContents: WebContents`). So `tab.view.webContents` must be
 *  treated as possibly-absent at every dereference — see {@link liveContents}. */
export interface Tab {
  /** `t1`, `t2`, … minted per workspace, never reused (see {@link nextTabId}). */
  id: BrowserTabId;
  view: WebContentsView;
  openedBy: BrowserTabOpener;
  /** Design mode's lease on the proxy's debugger attach while the picker is armed (#398); `null` when not armed. */
  designHold: (() => void) | null;
  /** Design mode was armed on this tab and its overlay may still be in the page; set synchronously by the arm (a disarm queued behind it must see it). */
  designArmed: boolean;
  /** Bumped by every arm at CALL time. A disarm (or a finished pick) only ends the arm it was issued against: one superseded by a later arm is a no-op, or it would wipe the new arm's mark and orphan its overlay + lease. */
  designGen: number;
  /** Tail of this tab's arm/disarm chain: a disarm that lands while an arm is still attaching must run AFTER it. */
  designOp: Promise<void>;
  nav: TabNav;
}

/** A workspace's browser panel: an ordered list of tabs with one active tab,
 *  plus the window-level attach state shared by all of them (one rect, one
 *  composited view at a time — the ACTIVE tab's). */
export interface Panel {
  wsId: string;
  tabs: Tab[];
  /** Id of the active tab — the one every un-suffixed primitive drives. */
  activeId: BrowserTabId;
  /** Id of the tab whose view is currently added to the window, or null. */
  attachedId: BrowserTabId | null;
  /** Whether setBounds has ever run for this panel. Until the renderer measures
   *  the `.browser-pane` placeholder the view has no meaningful rect, so adding
   *  it to the window would composit it at a garbage position over the app. */
  bounded: boolean;
  /** The last rect the renderer measured, re-applied to a tab view on attach. */
  bounds: BrowserBounds | null;
  /** A show was requested before any bounds existed (agent-driven open while the
   *  pane is closed); the attach happens on the first setBounds instead. */
  pendingShow: boolean;
  /** Last computed panel state, for a fresh renderer to re-request. */
  state: BrowserPanelState;
  /** The ACTIVE tab's native view (compat accessor — the browser verify
   *  harnesses read `panel.view`). Only valid while the panel has a tab. */
  readonly view: WebContentsView;
}

const panels = new Map<string, Panel>();

/** Next tab sequence number per workspace. Lives OUTSIDE {@link panels} on
 *  purpose: a panel evicted by dead-view reaping (or a last-tab close) and
 *  rebuilt must not restart at `t1`, or a stale id would address a new tab. */
const tabSeq = new Map<string, number>();

function nextTabId(wsId: string): BrowserTabId {
  const n = (tabSeq.get(wsId) ?? 0) + 1;
  tabSeq.set(wsId, n);
  return `t${n}`;
}

/** The workspace whose panel the RENDERER currently composites (its
 *  BrowserPanel component is mounted + active and called browserShow). This is
 *  the authority for "what is on screen": agent-driven opens must never attach
 *  a view for any other workspace, or a background agent's browsing would hide
 *  the panel the user is looking at and paint its own view — at stale bounds —
 *  over the current workspace's UI (the reported "browser makes Orchestra
 *  buggy"). Set by {@link showPanel} (renderer-driven), cleared by
 *  {@link hidePanel}. */
let focusedWsId: string | null = null;

/** The tab's live `webContents`, or `undefined` if the view has none any more.
 *
 *  Electron drops `WebContentsView.webContents` (to `undefined`) once the
 *  underlying WebContents is destroyed — by us via {@link destroyPanel}, or
 *  EXTERNALLY (renderer/GPU crash of the sandboxed panel page, Chromium
 *  reclaiming it, window teardown). Its typing says `readonly webContents:
 *  WebContents`, so TypeScript happily lets `tab.view.webContents.isDestroyed()`
 *  through — and that expression throws `Cannot read properties of undefined
 *  (reading 'isDestroyed')` in exactly that case: the guard meant to detect a
 *  dead view is itself what crashes on one.
 *
 *  Routing every dereference through here makes the absent case representable
 *  and checkable. Callers that get `undefined` should treat the tab as dead. */
function liveContents(tab: Tab | undefined): Electron.WebContents | undefined {
  const wc = tab?.view?.webContents as Electron.WebContents | undefined;
  return wc && !wc.isDestroyed() ? wc : undefined;
}

function activeTabOf(panel: Panel): Tab | undefined {
  return panel.tabs.find((t) => t.id === panel.activeId);
}

/** Remove `tab`'s view from the window if it is the one attached. */
function detachTab(panel: Panel, tab: Tab): void {
  if (panel.attachedId !== tab.id) return;
  try {
    getWindow?.()?.contentView.removeChildView(tab.view);
  } catch {
    /* already detached / window gone */
  }
  panel.attachedId = null;
}

/** Composite the ACTIVE tab (swapping out whichever tab was attached). Only the
 *  active tab of a panel ever composits. */
function attachActive(panel: Panel): void {
  const win = getWindow?.();
  const tab = activeTabOf(panel);
  if (!win || !tab || panel.attachedId === tab.id) return;
  const prev = panel.tabs.find((t) => t.id === panel.attachedId);
  if (prev) detachTab(panel, prev);
  panel.attachedId = null;
  if (panel.bounds) tab.view.setBounds(panel.bounds);
  win.contentView.addChildView(tab.view);
  panel.attachedId = tab.id;
}

/** The CDP proxy host's debugger seat (#398): this file holds NO debugger of its own. `send` runs one command on a tab through a proxy lease; `hold` keeps the attach for as long as design mode is armed. Registered by `initBrowserCliHost`. */
export interface CdpSeat {
  send(wsId: string, tabId: BrowserTabId, method: string, params: Record<string, unknown>): Promise<unknown>;
  hold(wsId: string, tabId: BrowserTabId): Promise<() => void>;
}
let cdpSeat: CdpSeat | null = null;
export function setCdpSeat(seat: CdpSeat | null): void {
  cdpSeat = seat;
}
/** Told, just before a tab's contents close, to drop the debugger seat the proxy holds on them. */
let tabTeardownHook: ((wc: Electron.WebContents) => void) | null = null;
export function setTabTeardownHook(h: ((wc: Electron.WebContents) => void) | null): void {
  tabTeardownHook = h;
}

/** Release a tab's native resources: the proxy's debugger seat first, then the contents. */
function destroyTab(tab: Tab): void {
  const wc = liveContents(tab);
  if (!wc) return;
  tab.designHold = null; // the seat below is force-detached: the hold is void
  try {
    tabTeardownHook?.(wc);
  } catch {
    /* already detached */
  }
  // WebContentsView has no close(); destroying its webContents releases it.
  (wc as unknown as { close?: () => void }).close?.();
}

/** Drop every tab whose native view is gone, so the next call recreates them
 *  cleanly instead of tripping over husks left in the map. A panel whose LAST
 *  tab died is evicted whole (the next ensurePanel builds a fresh one); a dead
 *  active tab hands the active slot to a surviving neighbour. */
function reapIfDead(wsId: string): Panel | undefined {
  const panel = panels.get(wsId);
  if (!panel) return undefined;
  const dead = panel.tabs.filter((t) => !liveContents(t));
  if (dead.length === 0) return panel;
  // The view lost its webContents (destroyed by us or externally). Detach the
  // husk from the window if it is still attached, then forget it.
  const wasActive = dead.some((t) => t.id === panel.activeId);
  const wasAttached = panel.attachedId !== null;
  const activeIdx = panel.tabs.findIndex((t) => t.id === panel.activeId);
  for (const t of dead) detachTab(panel, t);
  if (dead.length === panel.tabs.length) {
    // Keep `panel.tabs` intact: a holder of this evicted panel can still read
    // `panel.view` (the dead husk) instead of crashing on an empty list.
    panel.attachedId = null;
    panels.delete(wsId);
    return undefined;
  }
  panel.tabs = panel.tabs.filter((t) => !dead.includes(t));
  if (wasActive) {
    panel.activeId = panel.tabs[Math.min(activeIdx, panel.tabs.length - 1)].id;
    if (wasAttached) attachActive(panel);
  }
  publish(panel);
  return panel;
}

/** The live main-window accessor. Installed by index.ts at startup so this
 *  module (which must not import the window directly) can attach views to it. */
let getWindow: (() => Electron.BaseWindow | null) | null = null;

/** Where each workspace's tabs (URL + opener + active) are remembered across restarts (#393). Absent in the verify
 *  harnesses, which then simply run without restore/persist. */
let persistence: BrowserTabsPersistence | null = null;

/** URL a restored tab was asked to load, until the tab has a URL of its own: a snapshot taken while that load is
 *  still starting (or after it failed — server down at boot) must not blank the tab's remembered URL. */
const restoreUrls = new WeakMap<Tab, string>();

/** Called once from index.ts after the main window exists. `store` makes tabs survive an app restart. */
export function initBrowserPanels(
  accessor: () => Electron.BaseWindow | null,
  store?: BrowserTabsPersistence,
): void {
  getWindow = accessor;
  persistence = store ?? null;
  // #394: the Resources sampler / monitor read each tab's renderer pid through this — a pure read, it never reaps or publishes.
  setBrowserTabSource({
    tabs: () => [...panels.values()].flatMap((p) => [
      ...p.tabs.flatMap((t) => { const wc = liveContents(t); return wc ? [{ wsId: p.wsId, tabId: t.id, pid: wc.getOSProcessId() }] : []; }),
      // popup child windows hold cap slots and a renderer each: billed to their workspace like a tab (#396 review F7) — the chip counts them as tabs
      ...livePopupWindows(p.wsId).map((w) => { const wc = w.win.webContents as Electron.WebContents | undefined; return { wsId: p.wsId, tabId: w.id, pid: wc && !wc.isDestroyed() ? wc.getOSProcessId() : null }; }),
    ]),
    nonTabPids: () => { const ui = (getWindow?.() as Electron.BrowserWindow | null)?.webContents; return ui && !ui.isDestroyed() ? [ui.getOSProcessId()] : []; },
  });
}

/** Write any pending tab snapshot to disk now (app quit). */
export function flushBrowserTabs(): void {
  persistence?.flush();
}

function savePanelTabs(panel: Panel): void {
  // Only a REGISTERED panel is remembered: a panel mid-restore (not yet in `panels`), a closed-last-tab husk and a
  // destroyed panel must not overwrite what is on record.
  if (!persistence || panels.get(panel.wsId) !== panel || panel.tabs.length === 0) return;
  persistence.save(
    panel.wsId,
    snapshotTabs(
      panel.tabs.map((t) => ({
        id: t.id,
        url: restorableUrl(t.nav.url) || restoreUrls.get(t) || '',
        openedBy: t.openedBy,
      })),
      panel.activeId,
    ),
  );
}

/** The session partition holding a workspace's browser cookies/storage. Not
 *  `persist:` — a panel is scratch browsing tied to the workspace's lifetime;
 *  we don't want authenticated sessions surviving a workspace delete. Keyed by
 *  wsId so two workspaces browsing the same site stay isolated. All tabs of a
 *  workspace share it (one cookie jar per panel). */
function partitionFor(wsId: string): string {
  return `orchestra-browser-${wsId}`;
}

/** Strip Electron/Orchestra tokens from the UA so sites (and their bot
 *  heuristics) see a plain Chromium — same reasoning as login-browser.ts. */
function normalizeUserAgent(ses: Electron.Session): void {
  const ua = ses.getUserAgent().replace(/\s(?:Electron|Orchestra)\/\S+/gi, '');
  ses.setUserAgent(ua);
}

/** Panel sessions already guarded (one handler per session; every tab and popup window of a workspace shares its session). */
const guardedSessions = new WeakSet<Electron.Session>();

/** A link click or a redirect to `ssh:` / `zoommtg:` / `smb:` … inside a tab or a popup goes through Chromium's external-protocol path (Electron asks the session for the
 *  `openExternal` permission, `details.externalURL` = the target), NOT through `window.open` — and a CDP agent click is a user activation. Refused unless the URL passes the
 *  same allowlist as the popup path (`mailto:` / `tel:`). Every other permission keeps Electron's default (granted). (#396 review F-b) */
function guardExternalProtocols(ses: Electron.Session): void {
  if (guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  // optional call: the stub-`electron` harnesses of #391/#393 have sessions without this method
  ses.setPermissionRequestHandler?.((_wc, permission, callback, details) => {
    if (permission !== 'openExternal') return callback(true);
    const url = String((details as { externalURL?: string } | undefined)?.externalURL ?? '');
    const ok = isOsHandoffUrl(url);
    if (!ok) log.info(`browser-panel: external protocol refused (${url.split(':')[0].slice(0, 20) || 'unknown'}:)`); // scheme only: the rest can carry tokens
    callback(ok);
  });
}

function emptyState(wsId: string): BrowserPanelState {
  return {
    wsId,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    tabs: [],
    activeTabId: '',
  };
}

function blankNav(): TabNav {
  return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
}

/** Refresh a tab's url / title / history flags from its live contents (the
 *  `loading` flag and `error` are event-driven and kept as stored). */
function refreshNav(tab: Tab): TabNav {
  const wc = liveContents(tab);
  if (wc) {
    const nav = wc.navigationHistory;
    tab.nav.url = wc.getURL();
    tab.nav.title = wc.getTitle();
    tab.nav.canGoBack = nav.canGoBack();
    tab.nav.canGoForward = nav.canGoForward();
  }
  return tab.nav;
}

function tabInfo(panel: Panel, tab: Tab): BrowserTabInfo {
  const n = refreshNav(tab);
  return {
    id: tab.id,
    url: n.url,
    title: n.title,
    loading: n.loading,
    active: tab.id === panel.activeId,
    openedBy: tab.openedBy,
  };
}

/** The panel's state: url / title / loading / nav / error mirror the ACTIVE tab
 *  (so the renderer's URL bar is unchanged by tabs), plus the ordered tab list. */
function computeState(panel: Panel): BrowserPanelState {
  const active = activeTabOf(panel);
  const n = active ? refreshNav(active) : blankNav();
  return {
    wsId: panel.wsId,
    url: n.url,
    title: n.title,
    loading: n.loading,
    canGoBack: n.canGoBack,
    canGoForward: n.canGoForward,
    ...(n.error !== undefined ? { error: n.error } : {}),
    tabs: panel.tabs.map((t) => tabInfo(panel, t)),
    activeTabId: panel.activeId,
  };
}

/** Main-process observers of a panel's tab list (the CDP proxy, #395): called with the new ordered tabs after every publish, and once with `destroyed` when `destroyPanel` removes the workspace's panel. */
const panelListeners = new Set<(wsId: string, tabs: BrowserTabInfo[], destroyed: boolean) => void>();
export function onPanelChange(l: (wsId: string, tabs: BrowserTabInfo[], destroyed: boolean) => void): () => void {
  panelListeners.add(l);
  return () => panelListeners.delete(l);
}
function notifyPanelListeners(wsId: string, tabs: BrowserTabInfo[], destroyed = false): void {
  for (const l of [...panelListeners]) {
    try {
      l(wsId, tabs, destroyed);
    } catch {
      /* an observer must never break the panel */
    }
  }
}

/** Recompute the panel's state and push it to the renderer. */
function publish(panel: Panel): BrowserPanelState {
  panel.state = computeState(panel);
  savePanelTabs(panel);
  platform.broadcast('browser:event', panel.wsId, panel.state);
  notifyPanelListeners(panel.wsId, panel.state.tabs);
  return panel.state;
}

/** Fold a navigation event into `tab` and push the panel state (URL bar /
 *  title / nav buttons / tab list). */
function emitState(panel: Panel, tab: Tab, patch: Partial<TabNav>): void {
  // Reachable from webContents event handlers, which can still fire while the
  // contents are being torn down — so the view may already have lost them, or
  // the tab may already have been closed out of the registry. An evicted panel
  // keeps its `tabs` (stale holders read `panel.view`), so also require that
  // this panel is still THE registered one — else a late did-* event publishes
  // a ghost state for a deleted workspace or over a rebuilt panel.
  if (!liveContents(tab) || !panel.tabs.includes(tab) || panels.get(panel.wsId) !== panel) return;
  Object.assign(tab.nav, patch);
  publish(panel);
}

/** Right-click escape hatches, mirroring login-browser.ts. */
function attachContextMenu(view: WebContentsView, win: Electron.BaseWindow): void {
  view.webContents.on('context-menu', () => {
    // Fires from the native view; by the time it lands the contents may be gone.
    const wc = view.webContents as Electron.WebContents | undefined;
    if (!wc || wc.isDestroyed()) return;
    const url = wc.getURL();
    Menu.buildFromTemplate([
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Copy URL', click: () => clipboard.writeText(url) },
      { label: 'Open in system browser', click: () => void shell.openExternal(url) },
    ]).popup({ window: win as Electron.BrowserWindow });
  });
}

/** Tabs a page opened without a user gesture: each holds popup budget until it is closed (#396). */
const pageOpenedTabs = new WeakSet<Tab>();

/** Route a window a page opened (#396): the pure policy decides, this applies it. A tab is built here (so it gets none of Electron's own window); the one
 *  `allow` is a native child window that keeps its `window.opener`, so an OAuth sign-in can post back — built by OUR `createWindow` factory from an allowlist
 *  (`buildChildWindowOptions`), never from the page's `features` string, and carrying its own decision in the closure (no per-opener slot to mix up). */
function routePopup(
  panel: Panel,
  opener: Electron.WebContents,
  openedBy: BrowserTabOpener,
  d: Electron.HandlerDetails,
): Electron.WindowOpenHandlerResponse {
  const wsId = panel.wsId;
  if (panels.get(wsId) !== panel) return { action: 'deny' }; // the panel was evicted or destroyed under this page
  const windows = livePopupWindows(wsId);
  const now = Date.now();
  const route = decidePopup(
    { url: d.url, frameName: d.frameName, disposition: d.disposition, features: d.features, userGesture: consumeUserGesture(opener) },
    {
      openTabs: panel.tabs.length,
      openWindows: windows.length,
      pageInitiatedOpen: panel.tabs.filter((t) => pageOpenedTabs.has(t)).length + windows.filter((w) => w.pageInitiated).length,
      recentPageInitiated: recentPageInitiatedOpens(wsId, now),
      nameHeldByOtherOpener: frameNameHeldByOther(d.frameName, opener),
    },
  );
  switch (route.route) {
    case 'new-tab': {
      const tab = createTab(wsId, { url: d.url, openedBy, activate: route.activate });
      if (route.pageInitiated) {
        pageOpenedTabs.add(tab);
        notePageInitiatedOpen(wsId, now);
      }
      return { action: 'deny' };
    }
    case 'child-window': {
      return {
        action: 'allow',
        outlivesOpener: false,
        // the guest's own web preferences are derived from THIS (Electron merges it over the page's `features`): pinned to the secure set
        overrideBrowserWindowOptions: { webPreferences: { ...POPUP_WEB_PREFERENCES } },
        createWindow: (given) => createPopupWindow(panel, opener, openedBy, d, route.pageInitiated, given),
      };
    }
    case 'external':
      void shell.openExternal(d.url);
      return { action: 'deny' };
    case 'refuse': {
      let origin = d.url;
      try { origin = new URL(d.url).origin; } catch { /* keep the raw (scheme-only) text */ }
      log.info(`browser-panel: popup refused (${route.reason}) ws=${wsId} url=${origin}`); // origin only: an OAuth URL carries tokens in its query
      return { action: 'deny' };
    }
    default: {
      const unhandled: never = route;
      log.warn(`browser-panel: unhandled popup route ${JSON.stringify(unhandled)}`);
      return { action: 'deny' };
    }
  }
}

/** Electron's `createWindow` factory for an opener-dependent popup: Electron hands over the real guest `webContents` plus whatever the page's features string
 *  produced; we build the window from an allowlist and MUST return that same guest. A guest we cannot (or may not) give a window is closed — never left
 *  windowless. Registers the window (budget, cap, memory, teardown), routes ITS popups the same way, shows it when its workspace is the one on screen. */
function createPopupWindow(
  panel: Panel,
  opener: Electron.WebContents,
  openedBy: BrowserTabOpener,
  d: Electron.HandlerDetails,
  pageInitiated: boolean,
  given: Electron.BrowserWindowConstructorOptions,
): Electron.WebContents {
  const guest = (given as { webContents?: Electron.WebContents }).webContents; // in the runtime options, not in Electron's typing; absent on Electron's guest-less path
  if (guest !== undefined && (typeof guest !== 'object' || guest === null)) throw new Error('browser-panel: popup guest is not a webContents'); // unreachable: a features string that smuggles one is refused up front
  const wsId = panel.wsId;
  const gone = panels.get(wsId) !== panel;
  const full = !gone && panel.tabs.length + livePopupWindows(wsId).length >= BROWSER_TAB_CAP;
  const parent = getWindow?.() as Electron.BrowserWindow | null | undefined;
  if (gone || full || !parent || parent.isDestroyed()) {
    // the panel went away, or another popup took the last slot, between the handler and this call
    log.info(`browser-panel: popup refused (${gone ? 'gone' : full ? 'cap' : 'no-window'}) ws=${wsId} at creation`);
    if (!guest) throw new Error('browser-panel: popup refused at creation'); // guest-less path: nothing to hand back (Electron builds the window only after this returns)
    guest.close();
    return guest;
  }
  const bounds = parent.getContentBounds();
  const built = buildChildWindowOptions(given, { parent, parentSize: { width: bounds.width, height: bounds.height } }) as Electron.BrowserWindowConstructorOptions;
  // Guest-less path (Electron builds the contents itself): without a guest there is no inherited session, so pin the opener's — never the default one.
  if (!guest) built.webPreferences = { ...built.webPreferences, session: opener.session };
  const win = new electronNs.BrowserWindow(built);
  registerPopupWindow(wsId, { win, opener, openedBy, pageInitiated, frameName: d.frameName.trim() });
  if (pageInitiated) notePageInitiatedOpen(wsId); // counted when a window REALLY opens (not at approval: a reused or refused one opens nothing)
  const wc = win.webContents;
  if (!guest) void win.loadURL(d.url, { httpReferrer: d.referrer }); // guest-less path: the factory loads the page itself
  const retitle = (pageTitle: string): void => {
    if (!win.isDestroyed()) win.setTitle(popupWindowTitle(wc.getURL() || d.url, pageTitle));
  };
  retitle('');
  // The BrowserWindow's own event (a webContents one cannot veto the native title): preventDefault is what stops Electron setting the raw page title itself.
  win.on('page-title-updated', (e, title) => {
    e.preventDefault(); // the title is ours: the origin first, so a page cannot dress its window up as someone else
    retitle(title);
  });
  wc.on('did-navigate', () => retitle(wc.getTitle()));
  // The F1 clamp holds only at creation unless page-driven bounds are vetoed: Electron applies window.resizeTo / moveTo by default (#396 review F-a).
  wc.on('content-bounds-updated', (e) => e.preventDefault());
  watchPopups(panel, wc, openedBy);
  if (focusedWsId === wsId) {
    if (pageInitiated) win.showInactive();
    else win.show();
  }
  return wc;
}

/** Route every window `wc` (a tab, or a popup child window) opens, and close the child windows it opened when it goes away. */
function watchPopups(panel: Panel, wc: Electron.WebContents, openedBy: BrowserTabOpener): void {
  trackUserGesture(wc);
  wc.setWindowOpenHandler((details) => routePopup(panel, wc, openedBy, details));
  // Backstop: our `createWindow` factory never emits `did-create-window` (Electron skips it), so seeing it means Electron took its DEFAULT path for a popup — its
  // per-embedder factory slot was consumed by another popup's approval (cross-process frames). That window carries the PAGE's features (the F1 hole): destroy it.
  wc.on('did-create-window', (win) => {
    log.warn(`browser-panel: popup window created outside the allowlist factory — destroyed (ws=${panel.wsId})`);
    win.destroy();
  });
  wc.once('destroyed', () => closePopupsOpenedBy(panel.wsId, wc));
}

/** Build a tab (native view + handlers) for `panel` and append it to the
 *  registry. Does NOT change the active tab. */
function buildTab(panel: Panel, opts: { openedBy: BrowserTabOpener }): Tab {
  const win = getWindow?.();
  if (!win) throw new Error('browser-panel: main window not ready');

  const ses = session.fromPartition(partitionFor(panel.wsId));
  normalizeUserAgent(ses);
  guardExternalProtocols(ses);
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(panel.wsId),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // The panel browses arbitrary web content; keep it isolated from
      // Orchestra's preload/APIs entirely (no preload set).
    },
  });

  // An unpainted WebContentsView composites BLACK by default, which is what an
  // orphaned/zero-bounds view looks like on screen. Give it the app's canvas
  // colour so any such gap reads as a normal empty pane instead of a black hole.
  view.setBackgroundColor('#1a1f26');

  const tab: Tab = {
    id: nextTabId(panel.wsId),
    view,
    openedBy: opts.openedBy,
    designHold: null,
    designArmed: false,
    designGen: 0,
    designOp: Promise.resolve(),
    nav: blankNav(),
  };
  if (panel.bounds) view.setBounds(panel.bounds);

  const wc = view.webContents;
  wc.on('content-bounds-updated', (e) => e.preventDefault()); // a page's window.resizeTo / moveTo never moves or resizes the app window (#396 review F-a)
  watchPopups(panel, wc, opts.openedBy);
  wc.on('did-start-loading', () => emitState(panel, tab, { loading: true, error: undefined }));
  wc.on('did-stop-loading', () => emitState(panel, tab, { loading: false }));
  // A restored tab keeps its remembered URL until a navigation COMMITS to a restorable URL: during the load, and after a
  // failed one (server down at boot), `getURL()` can be the pending URL or a chrome-error:// page — neither may blank the record.
  const committed = (url: string): void => {
    if (restorableUrl(url)) restoreUrls.delete(tab);
  };
  wc.on('did-navigate', (_e, url) => {
    committed(url);
    emitState(panel, tab, {});
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    committed(url);
    emitState(panel, tab, {});
  });
  wc.on('page-title-updated', () => emitState(panel, tab, {}));
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED (a superseded navigation) — not a real failure.
    if (!isMainFrame || errorCode === -3) return;
    emitState(panel, tab, { loading: false, error: `${errorDescription} (${validatedURL})` });
  });

  attachContextMenu(view, win);
  panel.tabs.push(tab);
  return tab;
}

/** Create (or return) the panel for `wsId`. The panel and its ONE initial tab
 *  (`openedBy: 'human'`) are created lazily on first open and reused thereafter.
 *  Throws if the window isn't ready. */
export function ensurePanel(wsId: string): Panel {
  // reapIfDead returns the panel only if it still has a live tab; otherwise it
  // evicts the husk so we fall through and build a fresh one.
  const existing = reapIfDead(wsId);
  if (existing) return existing;
  if (!getWindow?.()) throw new Error('browser-panel: main window not ready');

  const panel: Panel = {
    wsId,
    tabs: [],
    activeId: '',
    attachedId: null,
    bounded: false,
    bounds: null,
    pendingShow: false,
    state: emptyState(wsId),
    get view() {
      return activeTabOf(this)!.view;
    },
  };
  const saved = persistence?.load(wsId) ?? null;
  if (saved) {
    // Restore (#393): the tabs this workspace had when the app last ran, in order, with the same one active.
    const built = saved.tabs.map((t) => {
      const tab = buildTab(panel, { openedBy: t.openedBy });
      if (t.url) {
        restoreUrls.set(tab, t.url);
        void loadIn(tab, t.url);
      }
      return tab;
    });
    panel.activeId = built[Math.min(saved.activeIndex, built.length - 1)].id;
  } else {
    panel.activeId = buildTab(panel, { openedBy: 'human' }).id;
  }
  panel.state = computeState(panel);
  panels.set(wsId, panel);
  return panel;
}

/** Look up an existing panel (does NOT create). Used by the agent tools, which
 *  should only drive a panel the user/agent has already opened. */
export function getPanel(wsId: string): Panel | undefined {
  return reapIfDead(wsId);
}

// ---------------------------------------------------------------------------
// Tabs registry (v1) — workspace → ordered tabs with one active tab.
// ---------------------------------------------------------------------------
//
// Every un-suffixed primitive below (navigate, goBack, evaluate, capture, …)
// acts on the ACTIVE tab; the debugger/CDP ones also take an optional trailing
// `tabId`. No cap and no policy here — callers (the human tab UI, the agent
// tools) put their own rules in front.

/** The panel's tabs in display order (empty when it has no live panel). */
export function listTabs(wsId: string): BrowserTabInfo[] {
  const panel = reapIfDead(wsId);
  return panel ? panel.tabs.map((t) => tabInfo(panel, t)) : [];
}

export function getTab(wsId: string, tabId: BrowserTabId): Tab | undefined {
  return reapIfDead(wsId)?.tabs.find((t) => t.id === tabId);
}

export function getActiveTab(wsId: string): Tab | undefined {
  const panel = reapIfDead(wsId);
  return panel ? activeTabOf(panel) : undefined;
}

/** Add a tab to `wsId`'s panel (creating the panel — and its initial human tab —
 *  first if there is none). `url` is loaded in the new tab; `activate` (default
 *  false) makes it the active tab, swapping it onto the screen if the panel is
 *  composited. Never changes which workspace is focused. */
export function createTab(
  wsId: string,
  opts: { url?: string; openedBy: BrowserTabOpener; activate?: boolean },
): Tab {
  const panel = ensurePanel(wsId);
  const tab = buildTab(panel, opts);
  if (opts.activate) setActive(panel, tab);
  else publish(panel);
  if (opts.url) loadIn(tab, opts.url);
  return tab;
}

function setActive(panel: Panel, tab: Tab): void {
  if (panel.activeId === tab.id) return;
  panel.activeId = tab.id;
  if (panel.attachedId !== null) attachActive(panel);
  publish(panel);
}

/** Make `tabId` the active tab (the one composited / driven). Throws if the
 *  workspace has no such tab. */
export function activateTab(wsId: string, tabId: BrowserTabId): BrowserPanelState {
  const panel = reapIfDead(wsId);
  const tab = panel?.tabs.find((t) => t.id === tabId);
  if (!panel || !tab) throw new Error(`browser tab ${tabId} not found in workspace ${wsId}`);
  setActive(panel, tab);
  return panel.state;
}

/** Close `tabId`: detach its view, drop its debugger, destroy its contents. If
 *  it was active, its right neighbour (else the left) becomes active. Closing
 *  the LAST tab evicts the panel AND forgets its saved tabs (#393 F1: else the next
 *  ensurePanel would restore the tab just closed) — the next ensurePanel builds a
 *  fresh blank one. The human/agent paths go through {@link tryCloseTab}, which never
 *  evicts (it replaces the last tab first). Throws if the workspace has no such tab. */
export function closeTab(wsId: string, tabId: BrowserTabId): BrowserPanelState {
  const panel = reapIfDead(wsId);
  const tab = panel?.tabs.find((t) => t.id === tabId);
  if (!panel || !tab) throw new Error(`browser tab ${tabId} not found in workspace ${wsId}`);
  const idx = panel.tabs.indexOf(tab);
  const wasActive = tab.id === panel.activeId;
  const wasAttached = panel.attachedId !== null;
  detachTab(panel, tab);
  if (panel.tabs.length === 1) {
    // Last tab: evict the panel whole. `panel.tabs` is left intact (like the
    // all-dead reap) so a holder's `panel.view` reads the husk, not a TypeError.
    destroyTab(tab);
    panels.delete(wsId);
    panel.attachedId = null;
    panel.pendingShow = false;
    persistence?.save(wsId, null);
    const empty = emptyState(wsId);
    platform.broadcast('browser:event', wsId, empty);
    return empty;
  }
  panel.tabs.splice(idx, 1);
  destroyTab(tab);
  if (wasActive) {
    panel.activeId = panel.tabs[Math.min(idx, panel.tabs.length - 1)].id;
    if (wasAttached) attachActive(panel);
  }
  return publish(panel);
}

// ---------------------------------------------------------------------------
// Policy-checked tab operations (#393). The bare createTab/closeTab/activateTab above have no cap and no
// ownership rule; every caller that acts for the human or the agent goes through these, which ask the pure
// policy (src/shared/browser-tab-policy.ts) FIRST — a refusal allocates nothing and destroys nothing.
// ---------------------------------------------------------------------------

function refused(wsId: string, reason: BrowserTabRefusal, message: string): BrowserTabResult {
  return { ok: false, reason, message, state: getState(wsId) };
}

/** Open a tab for `opts.openedBy`, refused (reason `cap`) when the workspace already holds the maximum — the
 *  decision is made before any view exists, so a refusal leaks nothing. */
export function tryOpenTab(
  wsId: string,
  opts: { url?: string; openedBy: BrowserTabOpener; activate?: boolean },
): BrowserTabResult {
  const panel = ensurePanel(wsId);
  const d = decideTabOpen({ openCount: panel.tabs.length + livePopupWindows(wsId).length, opener: opts.openedBy }); // popup windows share the cap (#396)
  if (!d.ok) return refused(wsId, d.reason, d.message);
  const tab = createTab(wsId, opts);
  return { ok: true, state: panel.state, tabId: tab.id };
}

/** Close `tabId` on behalf of `actor`: the human any tab, an agent only the tabs it opened. Closing the LAST tab
 *  leaves one fresh blank (human) tab, so the panel — and the agent primitives that drive "the active tab" — never
 *  find it tab-less. */
export function tryCloseTab(wsId: string, tabId: BrowserTabId, actor: BrowserTabOpener): BrowserTabResult {
  const panel = reapIfDead(wsId);
  if (!panel) return refused(wsId, 'unknown-tab', `No such browser tab: ${tabId}.`);
  const d = decideTabClose({ tabs: panel.tabs, activeId: panel.activeId, tabId, actor });
  if (!d.ok) return refused(wsId, d.reason, d.message);
  // Replacement FIRST: closeTab on the only tab would evict the panel.
  if (d.replaceWithBlank) createTab(wsId, { openedBy: 'human', activate: true });
  const state = closeTab(wsId, tabId);
  return { ok: true, state };
}

/** Make `tabId` the active tab; refused (`unknown-tab`) when the workspace has no such tab. */
export function tryActivateTab(wsId: string, tabId: BrowserTabId): BrowserTabResult {
  const panel = reapIfDead(wsId);
  if (!panel?.tabs.some((t) => t.id === tabId)) return refused(wsId, 'unknown-tab', `No such browser tab: ${tabId}.`);
  return { ok: true, state: activateTab(wsId, tabId) };
}

/** Resolve the tab a primitive should drive: `tabId` when given (throws if the
 *  workspace has no such tab), else the active tab. `undefined` only when the
 *  workspace has no live panel. */
function resolveTab(wsId: string, tabId?: BrowserTabId): Tab | undefined {
  if (tabId === undefined) return getActiveTab(wsId);
  const tab = getTab(wsId, tabId);
  if (!tab) throw new Error(`browser tab ${tabId} not found in workspace ${wsId}`);
  return tab;
}

/** Add the ACTIVE tab's view to the window (if not already) and mark the panel
 *  visible. Bounds are applied separately via {@link setBounds} once the
 *  renderer measures them. */
export function showPanel(wsId: string): BrowserPanelState {
  const panel = ensurePanel(wsId);
  // Renderer-authoritative: whoever shows a panel is putting it on screen.
  // (The agent path goes through revealForAgent, which only reaches here when
  // this workspace is already the focused one.)
  focusedWsId = wsId;
  setPopupWindowsVisible(wsId, true);
  const win = getWindow?.();
  // Never composite a view that has never been positioned: an agent can call
  // this (via its MCP browser tools) while the renderer's pane is closed, so no
  // placeholder has been measured and the view would land at a garbage rect
  // over the app. Defer the attach to the first setBounds.
  if (!panel.bounded) {
    panel.pendingShow = true;
    return panel.state;
  }
  if (win && panel.attachedId === null) {
    // Hide every OTHER workspace's panel first: only the active workspace's
    // browser should be composited (they'd otherwise stack).
    for (const [id, other] of panels) {
      if (id !== wsId && other.attachedId !== null) hidePanel(id);
    }
    attachActive(panel);
  }
  return panel.state;
}

/** Remove the view from the window (stops compositing) without destroying it —
 *  its pages + history + cookies survive so re-showing is instant. */
export function hidePanel(wsId: string): void {
  if (focusedWsId === wsId) focusedWsId = null;
  setPopupWindowsVisible(wsId, false);
  const panel = panels.get(wsId);
  if (!panel) return;
  // Cancel a deferred attach too, or a later setBounds would show a panel the
  // caller has since hidden.
  panel.pendingShow = false;
  const attached = panel.tabs.find((t) => t.id === panel.attachedId);
  if (attached) detachTab(panel, attached);
  panel.attachedId = null;
}

/** Agent-driven "open the panel" — never steals the screen. If this
 *  workspace's panel is the one the renderer currently composites, (re)attach
 *  it; otherwise just ensure the panel EXISTS and leave revealing to the
 *  renderer, which marks the navigating workspace's pane open (browser:event
 *  auto-open) and attaches it when the user is — or switches — there.
 *  Attaching from here for a non-focused workspace would hide the active
 *  workspace's panel and composite this one over the user's current UI. */
export function revealForAgent(wsId: string): BrowserPanelState {
  const panel = ensurePanel(wsId);
  if (focusedWsId === wsId) return showPanel(wsId);
  return panel.state;
}

/** Position/size the native view over the renderer's `.browser-pane` rect.
 *  Bounds are device-independent pixels relative to the window content. Applied
 *  to every tab of the panel, so a tab swapped in later is already the right
 *  size. */
export function setBounds(wsId: string, bounds: BrowserBounds): void {
  // The renderer pushes bounds continuously (ResizeObserver + window resize), so
  // this is the call most likely to land on a panel whose view died underneath
  // it — the burst of `browser:setBounds failed` TypeErrors this guard fixes.
  const panel = reapIfDead(wsId);
  if (!panel) return;
  const rect = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  panel.bounds = rect;
  for (const tab of panel.tabs) tab.view.setBounds(rect);
  panel.bounded = true;
  // A panel opened by an agent (showPanel with no renderer mounted) defers its
  // attach until now, when it finally has a real rect to sit in.
  if (panel.pendingShow) {
    panel.pendingShow = false;
    showPanel(wsId);
  }
}

function loadIn(tab: Tab, to: string): Promise<void> {
  const url = normalizeUrl(to);
  const wc = liveContents(tab);
  if (!wc) return Promise.resolve();
  return wc.loadURL(url).catch((err) => {
    // loadURL rejects on ERR_ABORTED for a superseded nav; state is emitted by
    // did-fail-load for real failures. Swallow so callers don't see spurious
    // rejections.
    log.debug(`browser-panel navigate ${url}`, err);
  });
}

/** Navigate the active tab (or `tabId`). `to` is a URL (http/https/file); a bare
 *  host gets https:// prepended, and a non-URL string is treated as a query is
 *  NOT done here (the renderer/agent decides). The default (active-tab) form
 *  opens the panel view if needed; an explicit `tabId` must already exist. */
export async function navigate(
  wsId: string,
  to: string,
  tabId?: BrowserTabId,
): Promise<BrowserPanelState> {
  // An explicit tabId must already exist (throws "not found"); only the
  // default (active-tab) form opens the panel.
  const tab = tabId === undefined ? (ensurePanel(wsId), getActiveTab(wsId)) : resolveTab(wsId, tabId);
  if (!tab) return getState(wsId);
  await loadIn(tab, to);
  return getState(wsId);
}

/** Turn user/agent input into a loadable URL: pass through explicit schemes,
 *  prepend https:// to a bare `host[/path]`, leave anything else (the caller
 *  should have resolved a search query already). */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('file:') || s.startsWith('about:')) {
    return s;
  }
  // Looks like a domain (has a dot, no spaces) → assume https.
  if (/^[^\s/]+\.[^\s/]+/.test(s)) return `https://${s}`;
  // Fall back to a Google search so a bare term still navigates somewhere
  // sensible from the URL bar.
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export function goBack(wsId: string, tabId?: BrowserTabId): void {
  const wc = liveContents(resolveTab(wsId, tabId));
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

export function goForward(wsId: string, tabId?: BrowserTabId): void {
  const wc = liveContents(resolveTab(wsId, tabId));
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

export function reload(wsId: string, tabId?: BrowserTabId): void {
  liveContents(resolveTab(wsId, tabId))?.reload();
}

/** Current state snapshot (a freshly-mounted renderer requests this). */
export function getState(wsId: string): BrowserPanelState {
  return reapIfDead(wsId)?.state ?? emptyState(wsId);
}

/** Destroy a workspace's panel entirely (workspace deleted / archived): every
 *  tab's debugger and contents, not just the active one. */
function destroyPanelViews(wsId: string): void {
  const panel = panels.get(wsId);
  if (!panel) return;
  hidePanel(wsId);
  panels.delete(wsId);
  for (const tab of panel.tabs) destroyTab(tab);
  notifyPanelListeners(wsId, [], true);
}

/** The tab's live `webContents` for the CDP proxy (#395), or `undefined` when it has none. */
export function tabContents(wsId: string, tabId: BrowserTabId): Electron.WebContents | undefined {
  return liveContents(getTab(wsId, tabId));
}

/** Is `wsId` the workspace whose panel the renderer composites right now? (the agent bring-to-front rule) */
export function isFocusedWorkspace(wsId: string): boolean {
  return focusedWsId === wsId;
}

/** Destroy a workspace's panel (delete / archive) AND forget its remembered tabs (#393) — even when this process never
 *  opened the panel (deleted straight after a restart). Forgetting comes after the teardown so no late event re-saves. */
export function destroyPanel(wsId: string): void {
  destroyPanelViews(wsId);
  closePopupWindows(wsId);
  persistence?.save(wsId, null);
}

// ---------------------------------------------------------------------------
// Agent driving layer — CDP commands, sent through the CDP proxy's debugger seat.
// ---------------------------------------------------------------------------
//
// These are the primitives the agent's browser tools (agent-browser-tools.ts)
// and design mode call. They operate on the SAME view the user sees, so the
// agent and the user share one surface. None of them attaches a debugger: the
// proxy (`browser-cdp-host.ts`) is the only attacher (#398, ADR 0009) and every
// command below rides a lease on its attach (`cdpSeat`).

/** The tab a CDP primitive drives. The default form (no `tabId`) creates the
 *  panel if the workspace has none; an EXPLICIT `tabId` must already exist —
 *  resolved first, so a stale id after closeTab(last)/destroyPanel fails with
 *  "not found" instead of resurrecting a blank native view. Throws if the tab
 *  has no live view: a dead view surfaces to the agent as a clear error rather
 *  than a TypeError about `isDestroyed`. */
function liveTabFor(wsId: string, tabId?: BrowserTabId): Tab {
  const explicit = tabId === undefined ? undefined : resolveTab(wsId, tabId);
  const panel = getPanel(wsId) ?? (tabId === undefined ? ensurePanel(wsId) : undefined);
  const tab = explicit ?? (panel ? activeTabOf(panel) : undefined);
  if (!panel || !tab || !liveContents(tab)) throw new Error(`browser panel for workspace ${wsId} has no live view`);
  return tab;
}

/** Run one CDP command on a tab through the proxy's lease. */
async function cdp(
  wsId: string,
  method: string,
  params?: Record<string, unknown>,
  tabId?: BrowserTabId,
): Promise<any> {
  const tab = liveTabFor(wsId, tabId);
  if (!cdpSeat) throw new Error('the browser CDP proxy is not running (initBrowserCliHost has not run)');
  return cdpSeat.send(wsId, tab.id, method, params ?? {});
}

/** Reject after `ms` if `p` hasn't settled. Screenshots and input dispatch on a
 *  view that stops compositing mid-call HANG FOREVER (measured on Electron 33:
 *  `capturePage` and `Page.captureScreenshot` on a detached view never settle),
 *  and a hung promise here means an agent tool call that never returns. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Throw a clear, actionable error when the tab isn't composited. A hidden
 *  (background-workspace / closed-pane) `WebContentsView` produces NO frames:
 *  measured on Electron 33, `capturePage` returns an empty 0x0 image if the
 *  view was never attached and hangs forever if it was detached after showing;
 *  CDP `Page.captureScreenshot` hangs in both cases, and CDP mouse input hangs
 *  or silently queues. Failing fast with guidance beats a blank image, a
 *  phantom click, or an agent stuck on a tool call that never returns. */
function requireComposited(wsId: string, what: string, tabId?: BrowserTabId): Tab {
  const panel = getPanel(wsId);
  const tab = resolveTab(wsId, tabId);
  if (!panel || !tab || !liveContents(tab)) {
    throw new Error(`no browser panel open for workspace ${wsId}`);
  }
  if (panel.attachedId === null) {
    throw new Error(
      `${what} needs the Browser pane on screen, but this workspace's panel is not currently ` +
        `composited (the workspace is in the background or its pane is closed). ` +
        `read_page, evaluate, navigate and form_input still work; for ${what}, ask the user ` +
        `to open this workspace's Browser pane.`,
    );
  }
  // Only the ACTIVE tab composits; a background tab produces no frames either.
  if (panel.attachedId !== tab.id) {
    throw new Error(
      `${what} needs tab ${tab.id} on screen, but it is not the active tab (only the active ` +
        `tab of the Browser pane is composited). read_page, evaluate, navigate and form_input ` +
        `still work on it; for ${what}, activate the tab first.`,
    );
  }
  return tab;
}

/** Capture the panel as a JPEG (base64) — the agent's "screenshot" primitive.
 *  Uses the native `capturePage()` (simpler + faster than `Page.captureScreenshot`),
 *  matching the Claude Code desktop app's screenshot tool. */
export async function capture(
  wsId: string,
  quality = 75,
  tabId?: BrowserTabId,
): Promise<string> {
  const tab = requireComposited(wsId, 'screenshot', tabId);
  const wc = liveContents(tab);
  if (!wc) throw new Error(`no browser panel open for workspace ${wsId}`);
  const image = await withTimeout(wc.capturePage(), 10_000, 'capturePage');
  return image.toJPEG(Math.max(0, Math.min(100, quality))).toString('base64');
}

/** Evaluate JS in the page and return the value (JSON-serialized by CDP). */
export async function evaluate(
  wsId: string,
  expression: string,
  tabId?: BrowserTabId,
): Promise<any> {
  const res = await cdp(
    wsId,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    tabId,
  );
  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'evaluate failed');
  }
  return res?.result?.value;
}

/** The accessibility tree as a compact text outline, each interactive node
 *  tagged `[ref_N]` so the agent can act on it by ref (matching CC's
 *  `read_page`). Built in-page via a DOM walk (robust across Electron versions
 *  vs the CDP Accessibility domain, which varies). */
export async function readPage(wsId: string, tabId?: BrowserTabId): Promise<string> {
  // Walk the DOM in-page, assigning stable data-orch-ref ids to interactive
  // elements, and emit a YAML-ish outline. Kept dependency-free and defensive.
  const script = `(() => {
    const out = [];
    let ref = 0;
    const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY']);
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const label = (el) => (
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('alt'))) ||
      (el.value && String(el.value)) ||
      (el.innerText || el.textContent || '').trim().slice(0, 120)
    );
    const walk = (el, depth) => {
      if (!el || depth > 40) return;
      for (const child of el.children) {
        if (!isVisible(child)) { walk(child, depth); continue; }
        const role = child.getAttribute && child.getAttribute('role');
        const interactive = INTERACTIVE.has(child.tagName) || role === 'button' || role === 'link' || (child.getAttribute && child.getAttribute('tabindex') === '0');
        if (interactive) {
          const r = ++ref;
          child.setAttribute('data-orch-ref', String(r));
          const tag = child.tagName.toLowerCase();
          const t = (child.getAttribute && child.getAttribute('type')) ? '['+child.getAttribute('type')+']' : '';
          out.push('  '.repeat(Math.min(depth, 8)) + '[ref_' + r + '] ' + tag + t + ' ' + JSON.stringify(label(child)));
        }
        walk(child, depth + 1);
      }
    };
    walk(document.body, 0);
    return document.title + '\\n' + document.location.href + '\\n' + out.join('\\n');
  })()`;
  return String(await evaluate(wsId, script, tabId));
}

/** Resolve a `ref_N` (from {@link readPage}) to viewport center coordinates. */
async function refToPoint(
  wsId: string,
  ref: number,
  tabId?: BrowserTabId,
): Promise<{ x: number; y: number }> {
  const rect = await evaluate(
    wsId,
    `(() => { const el = document.querySelector('[data-orch-ref="${ref}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`,
    tabId,
  );
  if (!rect) throw new Error(`ref_${ref} not found (call read_page again)`);
  return rect;
}

/** Click at viewport coordinates via CDP Input (a real, trusted input event —
 *  unlike a synthetic DOM `.click()` which fails isTrusted checks). */
export async function clickAt(
  wsId: string,
  x: number,
  y: number,
  tabId?: BrowserTabId,
): Promise<void> {
  // Pin the tab ONCE: press and release must hit the same tab even if the active tab changes mid-click.
  const pin = requireComposited(wsId, 'click', tabId).id;
  await withTimeout(
    cdp(wsId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, pin),
    10_000,
    'click (mousePressed)',
  );
  await withTimeout(
    cdp(wsId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, pin),
    10_000,
    'click (mouseReleased)',
  );
}

/** Click a `ref_N` element (resolves its center, then clickAt). */
export async function clickRef(wsId: string, ref: number, tabId?: BrowserTabId): Promise<void> {
  const pin = resolveTab(wsId, tabId)?.id ?? tabId; // resolve once: the point and the click hit the same tab
  const p = await refToPoint(wsId, ref, pin);
  await clickAt(wsId, p.x, p.y, pin);
}

/** Type text into the currently-focused element via CDP (trusted input). */
export async function typeText(wsId: string, text: string, tabId?: BrowserTabId): Promise<void> {
  requireComposited(wsId, 'type', tabId);
  await withTimeout(cdp(wsId, 'Input.insertText', { text }, tabId), 10_000, 'type (insertText)');
}

/** Set the value of a form element identified by `ref` (matches CC's
 *  `form_input`) — focuses it, selects all, and types, so it works for inputs
 *  and textareas alike, firing input/change events. */
export async function formInput(
  wsId: string,
  ref: number,
  value: string,
  tabId?: BrowserTabId,
): Promise<void> {
  await evaluate(
    wsId,
    `(() => {
      const el = document.querySelector('[data-orch-ref="${ref}"]');
      if (!el) return;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
    tabId,
  );
}

/** Scroll the page (or a wheel gesture) via CDP. */
export async function scrollBy(wsId: string, deltaY: number, tabId?: BrowserTabId): Promise<void> {
  requireComposited(wsId, 'scroll', tabId);
  await withTimeout(
    cdp(
      wsId,
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY },
      tabId,
    ),
    10_000,
    'scroll (mouseWheel)',
  );
}

// ---------------------------------------------------------------------------
// Design mode — the user-facing element picker (Orca parity).
// ---------------------------------------------------------------------------
//
// The user arms design mode from the browser toolbar, hovers to see the element
// under the cursor highlighted, and clicks to pick it. Orchestra then captures
// that element (outerHTML, a computed-style subset, a cropped screenshot, its
// selector + page URL) and hands the bundle to the renderer, which drops it
// into the agent composer as one attachment.
//
// WHY AN IN-PAGE OVERLAY AND NOT `Overlay.setInspectMode`:
//
// CDP's Overlay domain is the "native" way to do this and was tried first. It
// does not work here, for a reason specific to how this panel is driven:
// `Overlay.setInspectMode` makes the *browser* swallow the next click and
// report it as `Overlay.inspectNodeRequested` — but the highlight it paints is
// drawn by the DevTools frontend overlay layer, which an Electron
// `WebContentsView` with no DevTools frontend attached does not composite. The
// pick event fires; nothing is drawn. Since the whole point of design mode is
// that the user SEES what they are about to pick, a pick-without-highlight is
// not the feature.
//
// So the highlight + hit-testing live in the page as an injected overlay
// (`DESIGN_MODE_SCRIPT`), which needs no CDP event subscription. Design mode
// attaches NO debugger (attaching twice to one target throws): the CDP proxy is
// the only attacher (#398), and while the picker is armed design mode keeps a
// lease on that attach (`Tab.designHold`) so the 150 ms poll does not attach and
// detach on every tick. The only CDP calls are the same `Runtime.evaluate` /
// `Page.captureScreenshot` the agent tools use, through the same `cdp()` helper.
//
// The overlay is deliberately built to be un-pickable by itself: it sets
// `pointer-events: none` on its own chrome and, at pick time, the walker starts
// from `document.elementFromPoint`, which never returns a pointer-events:none
// node. So design mode cannot capture its own highlight box.

/** The id the injected overlay uses for its own DOM, so re-arming replaces
 *  rather than stacking overlays, and disarm can find and remove it. */
const DESIGN_OVERLAY_ID = '__orchestra_design_overlay__';

/** Where the in-page script stashes a completed pick for main to poll.
 *  A global (rather than a CDP event) because the picker deliberately holds NO
 *  debugger event subscription — see the block comment above. */
const DESIGN_PICK_GLOBAL = '__orchestraDesignPick';

/** Arm the in-page picker: inject the highlight overlay and start listening for
 *  a click. Idempotent — re-running replaces any existing overlay.
 *
 *  The script is a single self-contained IIFE (no build step reaches the page)
 *  that: draws a fixed-position outline + label box following `mousemove`,
 *  and on `click` (captured, prevented) walks the picked element's ancestor
 *  chain into a selector-node list, snapshots its computed style + outerHTML +
 *  box, stashes the result on `window[DESIGN_PICK_GLOBAL]`, and tears itself
 *  down. Escape disarms without picking. */
const DESIGN_MODE_SCRIPT = `(() => {
  const OVERLAY_ID = ${JSON.stringify(DESIGN_OVERLAY_ID)};
  const PICK_GLOBAL = ${JSON.stringify(DESIGN_PICK_GLOBAL)};
  // Re-arming: tear down any previous run first so listeners never stack.
  if (window.__orchestraDesignTeardown) { try { window.__orchestraDesignTeardown(); } catch (e) {} }
  window[PICK_GLOBAL] = null;

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  // pointer-events:none on the whole overlay is what makes the picker unable to
  // pick ITSELF — elementFromPoint skips pointer-events:none nodes.
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px solid #6aa9ff;background:rgba(106,169,255,0.18);border-radius:2px;transition:all 40ms linear;pointer-events:none;';
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#6aa9ff;color:#0b1020;padding:2px 6px;border-radius:3px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35);';
  host.appendChild(box); host.appendChild(label);
  (document.body || document.documentElement).appendChild(host);

  let current = null;

  const describe = (el) => {
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    const classes = cls.split(/\\s+/).filter(Boolean);
    let nth = 1;
    let sib = el.previousElementSibling;
    while (sib) { if (sib.tagName === el.tagName) nth++; sib = sib.previousElementSibling; }
    return { tag: el.tagName, id: el.id || undefined, classes, nthOfType: nth };
  };

  const paint = (el) => {
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const cls = el.classList && el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '';
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls) +
      '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    // Prefer the label ABOVE the box; flip below when the element is near the
    // top edge, so the label never sits off-screen.
    const above = r.top > 22;
    label.style.left = Math.max(0, r.left) + 'px';
    label.style.top = (above ? r.top - 20 : r.bottom + 4) + 'px';
  };

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === current) return;
    current = el; paint(el);
  };

  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY) || current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const computed = {};
    // Snapshot the computed style as a plain map; main subsets it
    // (shared/design-mode.ts STYLE_PROPS) so the property list lives in ONE
    // place that the unit tests assert against.
    //
    // TWO passes, because ITERATING a CSSStyleDeclaration yields only LONGHAND
    // properties: margin, padding, border and border-radius are SHORTHANDS and
    // never appear in that enumeration, so a pure index walk silently drops
    // exactly the four box/border values design mode exists to report.
    // (Measured on a real page: 383 enumerated properties, 0 of them
    // shorthands, while getPropertyValue('margin') returns 6px fine.) So walk
    // the enumeration for everything, then explicitly ask for the shorthands.
    // NOTE: no backticks anywhere in this script — it IS a template literal.
    for (let i = 0; i < cs.length; i++) { const p = cs[i]; computed[p] = cs.getPropertyValue(p); }
    for (const p of ['margin', 'padding', 'border', 'border-radius', 'font']) {
      const v = cs.getPropertyValue(p);
      if (v) computed[p] = v;
    }
    const chain = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      chain.unshift(describe(node));
      node = node.parentElement;
    }
    window[PICK_GLOBAL] = {
      url: location.href,
      title: document.title,
      chain: chain,
      outerHTML: el.outerHTML || '',
      computed: computed,
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    teardown();
  };

  const onKey = (e) => { if (e.key === 'Escape') { window[PICK_GLOBAL] = { cancelled: true }; teardown(); } };

  const teardown = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    const h = document.getElementById(OVERLAY_ID);
    if (h && h.parentNode) h.parentNode.removeChild(h);
    window.__orchestraDesignTeardown = null;
  };
  window.__orchestraDesignTeardown = teardown;

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  return true;
})()`;

/** Give back design mode's lease on the proxy's attach (idempotent). */
function releaseDesignHold(tab: Tab | undefined): void {
  const release = tab?.designHold;
  if (!tab || !release) return;
  tab.designHold = null;
  release();
}

/** The picker is gone from `tab` (picked, cancelled, torn down, never installed): drop the armed mark and the lease — but ONLY if `gen`, the
 *  generation captured when THIS piece of work started, is still current. Every path that clears arm state passes it (the argument is
 *  required on purpose): a later arm bumped the counter and owns the tab, and clearing under it would orphan its overlay + lease. */
function endDesign(tab: Tab, gen: number): void {
  if (tab.designGen !== gen) return;
  tab.designArmed = false;
  releaseDesignHold(tab);
}

/** Every tab of `wsId` design mode is armed on. The renderer addresses design mode by workspace only, so after a tab switch (an agent tab
 *  opened with activate, the user clicking another tab) the armed tab is not necessarily the active one. */
function armedTabs(wsId: string): Tab[] {
  return (panels.get(wsId)?.tabs ?? []).filter((t) => t.designArmed);
}

/** Run `fn` after every earlier arm/disarm of `tab` has settled (their errors are theirs). */
function inDesignOrder<T>(tab: Tab, fn: () => Promise<T>): Promise<T> {
  const run = tab.designOp.then(fn);
  tab.designOp = run.then(() => undefined, () => undefined);
  return run;
}

/** Arm design mode in the panel's page. Returns once the overlay is installed.
 *  Holds the proxy's debugger attach until the pick, the cancel or the disarm. */
export async function designModeArm(wsId: string, tabId?: BrowserTabId): Promise<void> {
  const tab = liveTabFor(wsId, tabId);
  const gen = ++tab.designGen;
  tab.designArmed = true; // now, not after the lease: a disarm queued right behind this arm must find it armed
  return inDesignOrder(tab, async () => {
    try {
      if (!cdpSeat) throw new Error('the browser CDP proxy is not running (initBrowserCliHost has not run)');
      if (!tab.designHold) tab.designHold = await cdpSeat.hold(wsId, tab.id);
      await evaluate(wsId, DESIGN_MODE_SCRIPT, tab.id);
    } catch (err) {
      endDesign(tab, gen); // no-op when a later arm (a URL-change re-arm queued behind this one) already owns the tab
      throw err;
    }
  });
}

/** Tear the overlay down on one tab and give its lease back (a no-op when design mode is not armed there). */
function disarmTab(wsId: string, tab: Tab): Promise<void> {
  const gen = tab.designGen; // at call time: the arm this disarm is issued against
  return inDesignOrder(tab, async () => {
    if (!tab.designArmed || tab.designGen !== gen) return; // not armed, or a later arm (off→on inside one round trip) supersedes this disarm
    try {
      await evaluate(
        wsId,
        `(() => { if (window.__orchestraDesignTeardown) { try { window.__orchestraDesignTeardown(); } catch (e) {} } window[${JSON.stringify(DESIGN_PICK_GLOBAL)}] = null; return true; })()`,
        tab.id,
      );
    } catch (err) {
      log.debug(`design-mode disarm(${wsId}) — page gone or navigating`, err);
    } finally {
      endDesign(tab, gen); // an arm called while this disarm's teardown was in flight bumped the counter: it owns the tab
    }
  });
}

/** Disarm design mode (user toggled it off, or the panel is closing). Safe to
 *  call when it was never armed — then there is nothing to tear down and no
 *  debugger is attached just to find that out (a pick or Escape already tore the
 *  overlay down and gave its lease back). Without a `tabId` it disarms EVERY tab
 *  of the workspace it is armed on, not just the active one.
 *
 *  Swallows evaluation failures: the renderer disarms on unmount, on going
 *  inactive, and after a pick, so this routinely lands on a page that is
 *  mid-navigation or already gone ("Inspected target navigated or closed").
 *  There is nothing to clean up in that case — the document that held the
 *  overlay no longer exists — so surfacing it would log an ERROR on a perfectly
 *  normal path and train readers to ignore the channel. */
export async function designModeDisarm(wsId: string, tabId?: BrowserTabId): Promise<void> {
  let targets: Tab[];
  try {
    targets = tabId === undefined ? armedTabs(wsId) : [resolveTab(wsId, tabId)].filter((t): t is Tab => !!t);
  } catch {
    return; // the tab is gone: its lease died with it
  }
  await Promise.all(targets.map((t) => disarmTab(wsId, t)));
}

/** Read a completed pick out of the page (and clear it), or `null` if the user
 *  has not clicked yet. `{cancelled:true}` comes back when they pressed Escape.
 *
 *  Polled by the renderer while design mode is armed rather than pushed as a
 *  CDP event, because the picker holds no debugger event subscription — see the
 *  block comment at the top of this section. */
async function readRawPick(wsId: string, tabId?: BrowserTabId): Promise<any | null> {
  return evaluate(
    wsId,
    `(() => { const p = window[${JSON.stringify(DESIGN_PICK_GLOBAL)}]; window[${JSON.stringify(DESIGN_PICK_GLOBAL)}] = null; return p || null; })()`,
    tabId,
  );
}

/** Poll for a pick and, if one landed, capture its cropped screenshot and shape
 *  the whole thing into a {@link DesignPick}.
 *
 *  Returns:
 *  - `null` — nothing picked yet (keep polling),
 *  - `{cancelled: true}` — the user pressed Escape (stop polling, disarm),
 *  - a `DesignPick` — done.
 *
 *  The screenshot is best-effort: if `Page.captureScreenshot` fails (a page
 *  mid-navigation, a clip the renderer rejects) the pick still returns with its
 *  text half intact, because a selector + HTML + styles is already useful and
 *  losing it to a failed crop would be the worse outcome. */
export async function designModePoll(
  wsId: string,
  tabId?: BrowserTabId,
): Promise<DesignPick | { cancelled: true } | null> {
  const pinned = resolveTab(wsId, tabId);
  if (!pinned) return null; // no panel: nothing is armed, and a poll never builds one (a late poll after archive/delete)
  const pin = pinned.id; // resolve once: the pick and its screenshot come from the same tab
  const gen = pinned.designGen; // BEFORE the first await: a re-arm landing inside the read round trip must not be folded into this pick's generation
  const raw = await readRawPick(wsId, pin);
  if (!raw) return null;
  // A pick or a cancel ends the arm (the page-side picker tore itself down): give the attach back,
  // but only after the screenshot, so the pick is one attach rather than detach-then-attach.
  // It is one-shot for the whole workspace: a picker still armed on another tab (the user switched tabs
  // mid-pick) is torn down too, so no overlay or lease is left behind on a tab nobody is polling.
  try {
    return await finishPick(wsId, pin, raw);
  } finally {
    endDesign(pinned, gen); // a re-arm landing during the read or the screenshot owns the tab now
    for (const other of armedTabs(wsId)) if (other !== pinned) void disarmTab(wsId, other);
  }
}

/** The second half of {@link designModePoll}: a raw page-side pick → cropped screenshot + shaped {@link DesignPick}. */
async function finishPick(wsId: string, pin: BrowserTabId | undefined, raw: any): Promise<DesignPick | { cancelled: true }> {
  if (raw.cancelled) return { cancelled: true };

  const viewport = raw.viewport ?? { width: 1280, height: 800 };
  let screenshot: string | undefined;
  try {
    const clip = clipForBox(raw.box, viewport);
    // Bounded: Page.captureScreenshot HANGS (never settles) if the view stops
    // compositing mid-call — e.g. the pane closing right after a pick.
    const shot = await withTimeout(
      cdp(
        wsId,
        'Page.captureScreenshot',
        { format: 'png', clip, captureBeyondViewport: false },
        pin,
      ),
      10_000,
      'design-mode screenshot',
    );
    if (shot?.data) screenshot = String(shot.data);
  } catch (err) {
    // Best-effort: the text half of the pick is still worth delivering.
    log.debug(`design-mode: element screenshot failed for ${wsId}`, err);
  }

  return shapePick(
    wsId,
    {
      url: String(raw.url ?? ''),
      title: String(raw.title ?? ''),
      selector: buildSelectorPath(raw.chain ?? []),
      outerHTML: String(raw.outerHTML ?? ''),
      computed: raw.computed ?? {},
      box: raw.box,
    },
    screenshot,
  );
}
