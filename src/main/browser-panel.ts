import { WebContentsView, Menu, clipboard, session, shell } from 'electron';
import type {
  BrowserBounds,
  BrowserPanelState,
  BrowserTabId,
  BrowserTabInfo,
  BrowserTabOpener,
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
import { platform } from './platform';
import { log } from './logger';

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
  /** Whether this tab's debugger has been attached for agent driving. */
  debuggerAttached: boolean;
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

/** Release a tab's native resources: debugger first, then the contents. */
function destroyTab(tab: Tab): void {
  const wc = liveContents(tab);
  if (!wc) return;
  try {
    if (tab.debuggerAttached) wc.debugger.detach();
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

/** Called once from index.ts after the main window exists. */
export function initBrowserPanels(accessor: () => Electron.BaseWindow | null): void {
  getWindow = accessor;
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

/** Recompute the panel's state and push it to the renderer. */
function publish(panel: Panel): BrowserPanelState {
  panel.state = computeState(panel);
  platform.broadcast('browser:event', panel.wsId, panel.state);
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

/** Build a tab (native view + handlers) for `panel` and append it to the
 *  registry. Does NOT change the active tab. */
function buildTab(panel: Panel, opts: { openedBy: BrowserTabOpener }): Tab {
  const win = getWindow?.();
  if (!win) throw new Error('browser-panel: main window not ready');

  const ses = session.fromPartition(partitionFor(panel.wsId));
  normalizeUserAgent(ses);
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
    debuggerAttached: false,
    nav: blankNav(),
  };
  if (panel.bounds) view.setBounds(panel.bounds);

  const wc = view.webContents;
  // Keep external target=_blank / window.open navigations in-tab when they're
  // web URLs; bounce anything else to the OS (mirrors login-browser.ts).
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void wc.loadURL(url);
    } else {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  wc.on('did-start-loading', () => emitState(panel, tab, { loading: true, error: undefined }));
  wc.on('did-stop-loading', () => emitState(panel, tab, { loading: false }));
  wc.on('did-navigate', () => emitState(panel, tab, {}));
  wc.on('did-navigate-in-page', () => emitState(panel, tab, {}));
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
  const tab = buildTab(panel, { openedBy: 'human' });
  panel.activeId = tab.id;
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
 *  the LAST tab evicts the panel — the next ensurePanel builds a fresh one
 *  (what that should mean for the user is the human-tabs ticket's call).
 *  Throws if the workspace has no such tab. */
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
export function destroyPanel(wsId: string): void {
  const panel = panels.get(wsId);
  if (!panel) return;
  hidePanel(wsId);
  panels.delete(wsId);
  for (const tab of panel.tabs) destroyTab(tab);
}

// ---------------------------------------------------------------------------
// Agent driving layer — Electron in-process CDP over `webContents.debugger`.
// ---------------------------------------------------------------------------
//
// These are the primitives the agent's browser tools (agent-browser-tools.ts)
// call. They operate on the SAME view the user sees, so the agent and the user
// share one surface.

/** Attach a tab's debugger (idempotent; the active tab unless `tabId` is given).
 *  Enables the CDP domains the tools need. Returns the panel (the default form
 *  creates it if the workspace has none; an explicit `tabId` must already exist)
 *  or throws if the tab has no live view. */
export function attachDebugger(wsId: string, tabId?: BrowserTabId): Panel {
  // An EXPLICIT tabId addresses a tab that must already exist: resolve it first
  // (throws "not found") and never build a panel for it — a stale id after
  // closeTab(last)/destroyPanel must fail, not resurrect a blank native view.
  const explicit = tabId === undefined ? undefined : resolveTab(wsId, tabId);
  const panel = getPanel(wsId) ?? (tabId === undefined ? ensurePanel(wsId) : undefined);
  const tab = explicit ?? (panel ? activeTabOf(panel) : undefined);
  const wc = liveContents(tab);
  // A dead view surfaces to the agent as a clear error rather than a TypeError
  // about `isDestroyed` — the agent can act on "panel is gone", not on a crash.
  if (!panel || !tab || !wc) throw new Error(`browser panel for workspace ${wsId} has no live view`);
  const dbg = wc.debugger;
  if (!tab.debuggerAttached) {
    if (!dbg.isAttached()) dbg.attach('1.3');
    tab.debuggerAttached = true;
  }
  return panel;
}

async function cdp(
  wsId: string,
  method: string,
  params?: Record<string, unknown>,
  tabId?: BrowserTabId,
): Promise<any> {
  attachDebugger(wsId, tabId);
  const wc = liveContents(resolveTab(wsId, tabId));
  if (!wc) throw new Error(`browser panel for workspace ${wsId} has no live view`);
  return wc.debugger.sendCommand(method, params ?? {});
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
// (`DESIGN_MODE_SCRIPT`), which also keeps the debugger session free: we add NO
// second `debugger.attach` (attaching twice to one target throws) and no
// long-lived CDP event subscription. The only CDP calls are the same
// `Runtime.evaluate` / `Page.captureScreenshot` the agent tools already use,
// through the same `cdp()` helper.
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

/** Arm design mode in the panel's page. Returns once the overlay is installed. */
export async function designModeArm(wsId: string, tabId?: BrowserTabId): Promise<void> {
  await evaluate(wsId, DESIGN_MODE_SCRIPT, tabId);
}

/** Disarm design mode (user toggled it off, or the panel is closing). Safe to
 *  call when it was never armed — the page-side teardown is guarded.
 *
 *  Swallows evaluation failures: the renderer disarms on unmount, on going
 *  inactive, and after a pick, so this routinely lands on a page that is
 *  mid-navigation or already gone ("Inspected target navigated or closed").
 *  There is nothing to clean up in that case — the document that held the
 *  overlay no longer exists — so surfacing it would log an ERROR on a perfectly
 *  normal path and train readers to ignore the channel. */
export async function designModeDisarm(wsId: string, tabId?: BrowserTabId): Promise<void> {
  try {
    await evaluate(
      wsId,
      `(() => { if (window.__orchestraDesignTeardown) { try { window.__orchestraDesignTeardown(); } catch (e) {} } window[${JSON.stringify(DESIGN_PICK_GLOBAL)}] = null; return true; })()`,
      tabId,
    );
  } catch (err) {
    log.debug(`design-mode disarm(${wsId}) — page gone or navigating`, err);
  }
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
  const pin = resolveTab(wsId, tabId)?.id ?? tabId; // resolve once: the pick and its screenshot come from the same tab
  const raw = await readRawPick(wsId, pin);
  if (!raw) return null;
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
