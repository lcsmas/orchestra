import { WebContentsView, Menu, clipboard, session, shell } from 'electron';
// Namespace import on purpose: the stub-`electron` harnesses of #391/#393 (src/main/browser-panel-tabs.test.ts, scripts/verify-*-browser-panel*.mjs) do not export
// BrowserWindow, and a NAMED import of a missing export fails to link; only the popup factory constructs one.
import * as electronNs from 'electron';
import type {
  BrowserBounds,
  BrowserPanelState,
  BrowserProfileId,
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
import { AGENT_OPENER, BROWSER_TAB_CAP, decideExternalProtocol, decidePopup, decideTabClose, decideTabOpen, isOsHandoffUrl } from '../shared/browser-tab-policy.ts';
import { decideAgentFront } from '../shared/browser-agent-tabs.ts';
import { buildChildWindowOptions, popupWindowTitle, POPUP_WEB_PREFERENCES } from '../shared/browser-popup-window.ts';
import { restorableUrl, snapshotTabs } from '../shared/browser-tab-state.ts';
import {
  LeaseBook,
  HIDDEN_FRAME_DEADLINE_MS,
  SURFACE_PULSE_MAX_MS,
  NO_FRAME_MESSAGE,
  cropRect,
  decideTabAction,
  type ActionKind,
  type Surface,
} from '../shared/browser-hidden-drive.ts';
import { partitionFor } from '../shared/browser-profile.ts';
import { promoteSessionCookie, restoreCookie } from '../shared/browser-cookie-promote.ts';
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
import { DESIGN_MODE_SCRIPT, DESIGN_PICK_GLOBAL } from './design-mode-script.ts';

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
// ordered list of tabs (one native view each) with one ACTIVE tab. The host
// resolves the panel of an `orchestra browser` call from {workspace id, session key}
// (ADR 0008) and routes it through the registry, so a workspace's agent can only drive that
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
  /** #406: `visible` = composited on screen; `hidden` = attached to the window + `setVisible(false)` (throttled while idle, driven under a lease); `detached` = not a child of the window. */
  surface: Surface;
  /** The tab's CURRENT document was composited (a hidden view whose document loaded while hidden has no first frame and takes no input: it is detached at navigation start and surfaced on the next agent action). */
  composited: boolean;
  /** When the view was last put on screen / when its last load stopped (ms): a document hidden before its first frame is born hidden (see {@link hideView}). */
  shownAt: number;
  stoppedAt: number;
}

/** A workspace's browser panel: an ordered list of tabs with one active tab,
 *  plus the window-level attach state shared by all of them (one rect, one
 *  composited view at a time — the ACTIVE tab's). */
export interface Panel {
  wsId: string;
  /** The session partition ALL this panel's tabs use (#400): its profil navigateur's `persist:` one, else the
   *  workspace's own ephemeral one. Fixed at panel creation; {@link reprofilePanel} swaps it by rebuilding the tabs. */
  partition: string;
  /** The profil navigateur behind {@link partition}; absent = navigation éphémère. */
  profileId?: BrowserProfileId;
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
  /** {@link reprofilePanel} is rebuilding the tabs: the registry is half-built, so {@link publish} says nothing until the rebuild is whole. */
  rebuilding?: boolean;
  /** The last tab swap an AGENT caused on screen (#397): shown to the human as a notice, cleared by any swap the human or the page makes. */
  agentSwitch?: { from: BrowserTabId; to: BrowserTabId; at: number };
  /** The tab the latest `read_page` outline (its `data-orch-ref` ids) came from (#397): a later `click ref_N` targets THIS tab, not whichever is active then. */
  refTabId?: BrowserTabId;
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

/** A tab shown / loaded for less than this when it is hidden has not painted yet (hiding it would leave its document without a first frame). */
const FIRST_PAINT_MS = 400;

/** Take `tab`'s view OUT of the window (any state). Used when the tab dies, closes, is rebuilt, or navigates while hidden. */
function removeView(tab: Tab): void {
  if (tab.surface !== 'detached') {
    try {
      getWindow?.()?.contentView.removeChildView(tab.view);
    } catch {
      /* already detached / window gone */
    }
  }
  tab.surface = 'detached';
  tab.composited = false;
  const id = leaseId(tab);
  if (driveLeases.isHeld(id)) {
    try {
      liveContents(tab)?.setBackgroundThrottling(true); // the lease dies with the view's place in the window: nobody else would flip it back
    } catch {
      /* contents gone */
    }
  }
  driveLeases.forget(id);
  pinnedLeases.delete(id);
  leaseTabs.delete(id);
}

/** Stop compositing `tab` WITHOUT removing it (#406): attached + `setVisible(false)`, so an agent can still drive it (see {@link beginAgentAction}). */
function hideView(tab: Tab): void {
  if (tab.surface === 'detached') return;
  // A document that is still loading — or has not had FIRST_PAINT_MS since it was shown / finished loading — when its view is hidden is born hidden: no first frame, no input
  // (measured, #406). Take the view out instead: it settles detached and is surfaced under the cover by the next agent action, like a tab opened in a background workspace.
  if (liveContents(tab)?.isLoading?.() || Date.now() - Math.max(tab.shownAt, tab.stoppedAt) < FIRST_PAINT_MS) {
    removeView(tab);
    return;
  }
  try {
    tab.view.setVisible(false);
  } catch {
    /* view gone */
  }
  tab.surface = 'hidden';
}

/** Composite `tab`'s view on top of the window (adding it first if it is not a child). */
function showView(panel: Panel, tab: Tab): void {
  const win = getWindow?.();
  if (!win) return;
  if (panel.bounds) tab.view.setBounds(panel.bounds);
  win.contentView.addChildView(tab.view); // re-adding a child moves it to the top
  tab.view.setVisible(true);
  tab.surface = 'visible';
  tab.composited = true;
  tab.shownAt = Date.now();
}

/** Remove `tab`'s view from the window and clear the panel's "composited tab" mark if it was that one. */
function detachTab(panel: Panel, tab: Tab): void {
  if (panel.attachedId === tab.id) panel.attachedId = null;
  removeView(tab);
}

/** Composite the ACTIVE tab (hiding whichever tab was on screen — it stays attached, hidden). */
function attachActive(panel: Panel): void {
  const win = getWindow?.();
  const tab = activeTabOf(panel);
  if (!win || !tab || panel.attachedId === tab.id) return;
  const prev = panel.tabs.find((t) => t.id === panel.attachedId);
  if (prev) hideView(prev);
  panel.attachedId = null;
  showView(panel, tab);
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
  // `close()` is ASYNC (unload / pagehide handlers still run): remember it, a profile delete waits for it (settleClosedViews).
  trackClose(wc);
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

/** Which profil navigateur a workspace carries (#400): the host reads the workspace record + the profile list
 *  (`effectiveProfileId`). Absent in the verify harnesses → every panel is navigation éphémère. */
let profileOf: ((wsId: string) => BrowserProfileId | undefined) | null = null;

/** Install (index.ts) the resolver {@link ensurePanel} asks when it builds a panel. Human-facing wiring only: the
 *  agent tools and the CLI never reach this (pinned by browser-profiles-wiring.test.ts). */
export function setBrowserProfileResolver(fn: ((wsId: string) => BrowserProfileId | undefined) | null): void {
  profileOf = fn;
}

const FLUSH_COOKIES_MS = 1500;
/** A cookie is promoted this long after its LAST change: a site that rewrites it at every request costs one `set`, and what is promoted is the cookie as it is THEN
 *  (re-read), never the snapshot the event carried. A logout or rotation the main process SEES before the write is honoured (pre-write guard); one that lands inside the
 *  read → write window is put right within ~300 ms of the write (post-write reconciliation, seat-1) — unless its event is delivered more than 300 ms late. */
const PROMOTE_DEBOUNCE_MS = 250;
/** After a promotion's write, how long before the logout re-check runs a second time (the removal event can be delivered after the write's promise). */
const RECONCILE_SETTLE_MS = 300;
/** How long after our compensating `remove` resolves its own removal event is still expected. */
const OWN_ECHO_MS = 500;
const signInSessions = new WeakMap<Electron.Session, () => void>();

/** What keeps a profile signed in across a restart (PROFILE sessions only — never an ephemeral workspace's), once per session:
 *  1. a SESSION cookie (no expiry; Electron drops these at quit) is re-set with a sliding 30-day expiry (OPS ruling, #400) — debounced per cookie,
 *     and only if it is STILL that session cookie when re-read (removed / rewritten with an expiry in the meantime = left alone);
 *  2. Chromium writes its cookie store on its own ~30 s timer — a crash or SIGKILL right after signing in would lose the sign-in —
 *     so the store is flushed shortly after any change.
 *  {@link stopSignInPersistence} detaches it (a deleted profile must not get cookies re-created by a late event). */
function persistSignIns(ses: Electron.Session): void {
  if (signInSessions.has(ses)) return;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const settling = new Set<ReturnType<typeof setTimeout>>();
  /** Per cookie: the sequence number of its LAST event (a change OR a removal). A promotion whose read started before a later event SEEN BY THE MAIN PROCESS never
   *  writes: a rotated token is not overwritten by the value that was read, and the later change schedules its own. An event not yet delivered is the post-write
   *  reconciliation's job (below). */
  let seq = 0;
  const changedSeq = new Map<string, number>();
  /** Per cookie: the NEWEST event from the SITE (or the user) that is not ours — a genuine removal (a logout, an expiry, an eviction; not the `overwrite` that replaces a
   *  cookie with its promoted copy) or a change that is not an echo of one of our own writes. The post-write reconciliation acts on it. */
  const foreign = new Map<string, { seq: number; removed: boolean; cookie: Electron.Cookie }>();
  /** What we wrote per cookie (value + expiry, the last few): the insert event our own `set` emits must not read as the site's. */
  const ownWrites = new Map<string, Array<{ value: string; exp: number }>>();
  const noteOwnWrite = (key: string, d: { value: string; expirationDate: number }): void => {
    const l = ownWrites.get(key) ?? [];
    l.push({ value: d.value, exp: d.expirationDate });
    if (l.length > 4) l.shift();
    ownWrites.set(key, l);
  };
  const isOwnWrite = (key: string, c: Electron.Cookie): boolean =>
    c.expirationDate !== undefined && (ownWrites.get(key) ?? []).some((w) => w.value === c.value && Math.abs(w.exp - (c.expirationDate as number)) < 2);
  /** A compensating `remove` of OUR OWN promoted copy emits a removal event too: it is expected ONCE and must be neither read as a logout nor promoted. Consumed by
   *  that first echo, and dropped {@link OWN_ECHO_MS} after the remove resolves (an echo that never comes must not swallow a later, genuine logout). */
  const ownRemoval = new Set<string>();
  /** The promotion is read → write across the network service, and what the SITE does BETWEEN the two reaches us only AFTER the write was issued: the pre-write guard
   *  cannot see it. A logout would be undone by the 30-day copy (measured on the real app: login → logout at 243-250 ms, 12/200); a ROTATION would be overwritten by
   *  the value that was read (seat 1: the jar ended on the PREVIOUS value, ~1/100). So after the write, if a foreign event for this cookie arrived since the READ STARTED
   *  and the live cookie is still exactly OUR copy: a removal removes the copy; a change puts the site's newest value back (promoted if it is a session cookie).
   *  A user who logged in again meanwhile has a different live cookie and is left alone. Checked right after the write and once more after a short settle (the event
   *  can be delivered after the write's promise); an event delivered after the settle is NOT compensated. */
  const reconcile = (key: string, written: { url: string; name: string; value: string; expirationDate: number }, domain: string, path: string, started: number): void => {
    if (!alive || (foreign.get(key)?.seq ?? 0) <= started) return;
    void ses.cookies
      .get({ name: written.name, domain, path })
      .then((live) => {
        const last = foreign.get(key);
        if (!alive || !last || last.seq <= started) return undefined;
        const mine = live.find((c) => c.name === written.name && c.domain === domain && c.value === written.value && Math.abs((c.expirationDate ?? 0) - written.expirationDate) < 2);
        if (!mine) return undefined;
        if (last.removed) {
          ownRemoval.add(key);
          return ses.cookies.remove(written.url, written.name).finally(() => {
            const t = setTimeout(() => {
              settling.delete(t);
              ownRemoval.delete(key);
            }, OWN_ECHO_MS);
            settling.add(t);
          });
        }
        const d = restoreCookie(last.cookie, Date.now() / 1000);
        if (!d) return undefined;
        noteOwnWrite(key, d);
        return ses.cookies.set(d);
      })
      .catch((err) => log.warn('browser-panel: reconciling a promotion with a later change of the site failed', err));
  };
  const promote = (key: string, cookie: Electron.Cookie): void => {
    pending.delete(key);
    const started = seq;
    void ses.cookies
      .get({ name: cookie.name, domain: cookie.domain, path: cookie.path })
      .then(async (live) => {
        if (!alive || (changedSeq.get(key) ?? 0) > started) return;
        // `get({domain})` also matches SUBDOMAINS: promote the cookie the EVENT named, never a same-name sibling.
        const own = live.find((c) => c.name === cookie.name && c.domain === cookie.domain && (c.path ?? '/') === (cookie.path ?? '/'));
        const p = own ? promoteSessionCookie(own, Date.now() / 1000) : null;
        if (!p) return;
        noteOwnWrite(key, p);
        await ses.cookies.set(p);
        const domain = cookie.domain ?? '';
        const path = cookie.path ?? '/';
        reconcile(key, p, domain, path, started);
        const t = setTimeout(() => {
          settling.delete(t);
          reconcile(key, p, domain, path, started);
        }, RECONCILE_SETTLE_MS);
        settling.add(t);
      })
      .catch((err) => log.warn('browser-panel: promoting a session cookie failed', err));
  };
  const onChanged = (_e: unknown, cookie: Electron.Cookie, cause: string, removed: boolean): void => {
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    const genuineRemoval = removed && cause !== 'overwrite';
    if (genuineRemoval && ownRemoval.has(key)) {
      ownRemoval.delete(key); // the echo of our own compensating remove: not a logout, nothing to promote or flush on its account
      return;
    }
    changedSeq.set(key, ++seq);
    if (genuineRemoval) foreign.set(key, { seq, removed: true, cookie });
    else if (!removed && !isOwnWrite(key, cookie)) foreign.set(key, { seq, removed: false, cookie });
    if (!removed && promoteSessionCookie(cookie, 0)) {
      if (!pending.has(key)) pending.set(key, setTimeout(() => promote(key, cookie), PROMOTE_DEBOUNCE_MS));
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void ses.cookies.flushStore().catch(() => {});
    }, FLUSH_COOKIES_MS);
  };
  ses.cookies.on('changed', onChanged);
  signInSessions.set(ses, () => {
    alive = false;
    ses.cookies.removeListener('changed', onChanged);
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    for (const t of settling) clearTimeout(t);
    settling.clear();
  });
}

/** Stop promoting / flushing a profile partition's cookies (called before its storage is wiped: a late `changed` must not re-create a promoted
 *  cookie in a partition the human just deleted). A later panel on that partition would re-attach it. */
export function stopSignInPersistence(partition: string): void {
  try {
    const ses = session.fromPartition(partition);
    signInSessions.get(ses)?.();
    signInSessions.delete(ses);
  } catch (e) {
    log.debug('browser-panel: stopSignInPersistence', e);
  }
}

/** Write every open profile's cookies / storage to disk now (app quit). */
export function flushProfileStorage(): void {
  for (const panel of panels.values()) {
    if (panel.profileId === undefined) continue;
    try {
      const ses = session.fromPartition(panel.partition);
      ses.flushStorageData();
      void ses.cookies.flushStore().catch(() => {});
    } catch (e) {
      log.debug('browser-panel: flushProfileStorage', e);
    }
  }
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

/** The session partition holding a workspace's browser cookies/storage: a panel's is `Panel.partition` (#400) — its profil
 *  navigateur's `persist:` one, else the workspace's own in-memory one (`partitionFor`, shared/browser-profile.ts). */

/** Strip Electron/Orchestra tokens from the UA so sites (and their bot
 *  heuristics) see a plain Chromium — same reasoning as login-browser.ts. */
function normalizeUserAgent(ses: Electron.Session): void {
  const ua = ses.getUserAgent().replace(/\s(?:Electron|Orchestra)\/\S+/gi, '');
  ses.setUserAgent(ua);
}

/** Panel sessions already guarded (one handler per session; every tab and popup window of a workspace shares its session). */
const guardedSessions = new WeakSet<Electron.Session>();

/** A link click or a redirect to `ssh:` / `zoommtg:` / `smb:` … inside a tab or a popup goes through Chromium's external-protocol path (Electron asks the SESSION for the
 *  `openExternal` permission, `details.externalURL` = the target), NOT through `window.open` — and a CDP agent click is a user activation. Allowed only by `decideExternalProtocol`:
 *  `mailto:` / `tel:` AND a user gesture of the REQUESTING contents (`consumeUserGesture`: one input, one launch — a load-time `location.href = 'mailto:…'` or a programmatic `a.click()`
 *  has none). Every other permission keeps Electron's default (granted). (#396 review F-b; seat-3 F1) */
function guardExternalProtocols(ses: Electron.Session): void {
  if (guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  // optional call: the stub-`electron` harnesses of #391/#393 have sessions without this method
  ses.setPermissionRequestHandler?.((wc, permission, callback, details) => {
    if (permission !== 'openExternal') return callback(true);
    const url = String((details as { externalURL?: string } | undefined)?.externalURL ?? '');
    // the gesture is only consumed for an allow-listed scheme: a refused link must not eat the click's activation
    const userGesture = isOsHandoffUrl(url) && !!wc && consumeUserGesture(wc);
    const d = decideExternalProtocol({ url, userGesture });
    if (!d.allow) log.info(`browser-panel: external protocol refused (${url.split(':')[0].slice(0, 20) || 'unknown'}:${d.reason === 'no-gesture' ? ' no click' : ''})`); // scheme only: the rest can carry tokens
    callback(d.allow);
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
    ...(panel.profileId !== undefined ? { profileId: panel.profileId } : {}),
    ...(panel.agentSwitch ? { agentSwitch: panel.agentSwitch } : {}),
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
  // A rebuild in progress holds a half-built registry (the first rebuilt tab's did-start-loading would publish ONE tab of two): the renderer, the tab
  // persistence and the CDP proxy's diff must never see it — a tab missing from one publish and back in the next reads as closed and reopened (#400).
  if (panel.rebuilding) return panel.state;
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
function buildTab(panel: Panel, opts: { openedBy: BrowserTabOpener; id?: BrowserTabId }): Tab {
  const win = getWindow?.();
  if (!win) throw new Error('browser-panel: main window not ready');

  const ses = session.fromPartition(panel.partition);
  normalizeUserAgent(ses);
  if (panel.profileId !== undefined) persistSignIns(ses);
  guardExternalProtocols(ses);
  const view = new WebContentsView({
    webPreferences: {
      partition: panel.partition,
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
    id: opts.id ?? nextTabId(panel.wsId),
    view,
    openedBy: opts.openedBy,
    designHold: null,
    designArmed: false,
    designGen: 0,
    designOp: Promise.resolve(),
    nav: blankNav(),
    surface: 'detached',
    composited: false,
    shownAt: 0,
    stoppedAt: 0,
  };
  if (panel.bounds) view.setBounds(panel.bounds);

  const wc = view.webContents;
  wc.on('content-bounds-updated', (e) => e.preventDefault()); // a page's window.resizeTo / moveTo never moves or resizes the app window (#396 review F-a)
  watchPopups(panel, wc, opts.openedBy);
  wc.on('did-start-loading', () => emitState(panel, tab, { loading: true, error: undefined }));
  wc.on('did-stop-loading', () => {
    tab.stoppedAt = Date.now();
    emitState(panel, tab, { loading: false });
  });
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
  // #406: a document that loads into a view nobody is looking at gets no first frame and takes no input (measured, Electron 33): take a HIDDEN tab out
  // of the window when it starts a main-frame navigation, so the new document loads detached; the next agent action surfaces it under the cover.
  wc.on('did-start-navigation', (event: unknown, _url?: string, isInPlace?: boolean, isMainFrame?: boolean) => {
    const d = (event ?? {}) as { isMainFrame?: boolean; isSameDocument?: boolean };
    if ((d.isMainFrame ?? isMainFrame) && !(d.isSameDocument ?? isInPlace) && tab.surface === 'hidden') removeView(tab);
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

  const profileId = profileOf?.(wsId);
  const panel: Panel = {
    wsId,
    partition: partitionFor(wsId, profileId),
    profileId,
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

/** Move a workspace's panel onto another identity (#400): `profileId` = a profil navigateur, undefined = navigation
 *  éphémère. A view's partition is fixed at creation, so EVERY tab is rebuilt in the new partition — same ids, same
 *  openers, same active tab, each reloaded at its URL — and the old views (debuggers included) are destroyed. A panel
 *  that is not open is not built here: it picks the identity from the workspace record at its first ensurePanel
 *  (restored tabs included). HUMAN-FACING only (browser-profiles.ts); never reachable from the agent tools. */
export function reprofilePanel(wsId: string, profileId: BrowserProfileId | undefined): BrowserPanelState {
  const panel = reapIfDead(wsId);
  if (!panel) return getState(wsId);
  const partition = partitionFor(wsId, profileId);
  if (partition === panel.partition) return panel.state;
  const oldTabs = panel.tabs;
  const snaps = oldTabs.map((t) => ({
    id: t.id,
    openedBy: t.openedBy,
    url: restorableUrl(refreshNav(t).url) || restoreUrls.get(t) || '',
  }));
  const oldActive = panel.activeId;
  const wasAttached = panel.attachedId !== null;
  const prev = { partition: panel.partition, profileId: panel.profileId };
  for (const t of oldTabs) detachTab(panel, t); // every old view leaves the window (hidden ones included)
  panel.rebuilding = true;
  // `rebuilding` is released on EVERY way out (a rollback that itself throws must not leave the panel silent for good).
  try {
    panel.partition = partition;
    panel.profileId = profileId;
    panel.tabs = [];
    try {
      for (const sn of snaps) {
        const tab = buildTab(panel, { openedBy: sn.openedBy, id: sn.id });
        if (sn.url) {
          restoreUrls.set(tab, sn.url);
          void loadIn(tab, sn.url);
        }
      }
    } catch (e) {
      // A view could not be built: put the panel back EXACTLY as it was (old tabs alive, old identity, old view composited) and
      // let the caller see the error — never a half-built panel whose record and views disagree. Each step stands alone: a view that
      // will not close must not stop the registry from being restored.
      const half = panel.tabs;
      panel.tabs = oldTabs;
      panel.partition = prev.partition;
      panel.profileId = prev.profileId;
      for (const t of half) {
        try {
          destroyTab(t);
        } catch (err) {
          log.warn('browser-panel: reprofilePanel rollback could not close a half-built view', err);
        }
      }
      try {
        if (wasAttached) attachActive(panel);
      } catch (err) {
        log.warn('browser-panel: reprofilePanel rollback could not re-composite the panel', err);
      }
      throw e;
    }
    // Committed from here: nothing below may throw, or the record would be rolled back while the panel already runs on the new partition.
    panel.activeId = oldActive;
    // #397 pins these by TAB ID, and the ids survive the rebuild but the pages do not: the last outline's `ref_N` ids are gone with the old page, and the
    // « the agent switched tabs » notice names a swap that no longer exists.
    panel.refTabId = undefined;
    delete panel.agentSwitch;
    for (const t of oldTabs) {
      try {
        destroyTab(t);
      } catch (e) {
        log.warn('browser-panel: reprofilePanel could not close an old view', e);
      }
    }
    try {
      if (wasAttached) attachActive(panel);
    } catch (e) {
      log.warn('browser-panel: reprofilePanel could not re-composite the panel', e);
    }
  } finally {
    panel.rebuilding = false;
  }
  return publish(panel);
}

/** The profil navigateur `wsId`'s OPEN panel runs on, or undefined (ephemeral / no panel). A pure read — builds and reaps nothing; the CDP
 *  proxy asks it (with `decideAgentCdp`) before it lets an agent clear a profile's jar or touch another site's cookies. */
export function panelProfileId(wsId: string): BrowserProfileId | undefined {
  return panels.get(wsId)?.profileId;
}

/** The urls of one tab's frame tree (main frame + every subframe), read LIVE — what `Network.getCookies` without `urls` would cover. A pure read; `undefined`
 *  when the tab has no live view or the tree cannot be read (the agent CDP policy then refuses what it cannot judge). */
export function tabFrameUrls(wsId: string, tabId: BrowserTabId): string[] | undefined {
  const wc = liveContents(panels.get(wsId)?.tabs.find((t) => t.id === tabId));
  try {
    const main = wc?.mainFrame;
    return main ? main.framesInSubtree.map((f) => f.url) : undefined;
  } catch {
    return undefined;
  }
}

/** The workspaces whose OPEN panel runs on `profileId` right now (what the views do, not what a record says). */
export function workspacesOnProfile(profileId: BrowserProfileId): string[] {
  return [...panels.values()].filter((p) => p.profileId === profileId).map((p) => p.wsId);
}

/** Views being closed (a re-profile, a tab close, a panel teardown): `webContents.close()` is ASYNC (unload / pagehide handlers still run), so a
 *  storage wipe must wait for their `destroyed` or a page could write the partition back after it was cleared. */
const closing = new Set<Promise<void>>();
function trackClose(wc: Electron.WebContents): void {
  const p = new Promise<void>((resolve) => wc.once('destroyed', () => resolve()));
  closing.add(p);
  void p.then(() => closing.delete(p));
}

/** Resolve `true` once every view closed so far is really gone, `false` after `timeoutMs` (a hung page must not block forever — the caller decides). */
export async function settleClosedViews(timeoutMs: number): Promise<boolean> {
  if (closing.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); });
  const settled = Promise.all([...closing]).then(() => true);
  const ok = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  return ok;
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
  // An agent-opened tab that takes the screen is an agent swap: the human is told (#397).
  if (opts.activate) setActive(panel, tab, tab.openedBy === AGENT_OPENER);
  else publish(panel);
  if (opts.url) loadIn(tab, opts.url);
  return tab;
}

/** Make `tab` the active one. `byAgent`: an agent caused it — the swap is recorded for the human's notice; any other swap clears the notice. */
function setActive(panel: Panel, tab: Tab, byAgent = false): void {
  if (panel.activeId === tab.id) return;
  const from = panel.activeId;
  panel.activeId = tab.id;
  if (byAgent) {
    // Chained agent swaps (B then C) keep « Back » pointing at the tab the HUMAN was last on, not at the agent's own previous stop —
    // unless the agent has just returned TO that tab, where « Back » toggles to the tab it left.
    const prev = panel.agentSwitch;
    // …but only while that human tab still exists (the rig caught « Back » pointing at a tab closed in between: the button vanished).
    const origin = prev && prev.to === from && panel.tabs.some((t) => t.id === prev.from) ? prev.from : from;
    panel.agentSwitch = { from: origin === tab.id ? from : origin, to: tab.id, at: Date.now() };
  } else delete panel.agentSwitch;
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

// ---------------------------------------------------------------------------
// Agent-side tab operations (#397) — what the CDP proxy (browser-cdp-host.ts) calls. Policy first (cap, close ownership:
// the same pure rules as the human's strip), then the focus rule: only the FOCUSED workspace's agent swaps the tab the human
// looks at (and the human is told, `agentSwitch`); a background workspace's agent never attaches or shows a view.
// ---------------------------------------------------------------------------

/** Open a tab for the agent; shown (activated) only in the focused workspace. Refused (reason `cap`) over the cap, before any view exists. */
export function agentOpenTab(wsId: string, opts: { url?: string }): BrowserTabResult {
  return tryOpenTab(wsId, { ...(opts.url ? { url: opts.url } : {}), openedBy: AGENT_OPENER, activate: focusedWsId === wsId });
}

/** Close `tabId` for the agent: only a tab an agent opened (reason `not-owner` otherwise). */
export function agentCloseTab(wsId: string, tabId: BrowserTabId): BrowserTabResult {
  const wasActive = reapIfDead(wsId)?.activeId === tabId;
  const r = tryCloseTab(wsId, tabId, AGENT_OPENER);
  // Closing the tab on screen hands the screen to a neighbour: an agent-caused swap the human is told about (nothing to go « Back » to — `from` is gone).
  const after = r.ok && wasActive && focusedWsId === wsId ? reapIfDead(wsId) : undefined;
  if (after && after.activeId !== tabId) {
    after.agentSwitch = { from: tabId, to: after.activeId, at: Date.now() };
    publish(after);
  }
  return r;
}

/** The agent acts on `tabId`: bring it to the front when it is not active AND `wsId` is the focused workspace. Returns whether the screen changed. */
export function agentActivateTab(wsId: string, tabId: BrowserTabId): { brought: boolean } {
  const panel = reapIfDead(wsId);
  const tab = panel?.tabs.find((t) => t.id === tabId);
  const d = decideAgentFront({ wsFocused: focusedWsId === wsId, activeId: panel?.activeId ?? null, tabId, tabExists: !!tab });
  if (d.act !== 'activate' || !panel || !tab) return { brought: false };
  setActive(panel, tab, true);
  return { brought: true };
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
  // this (an `orchestra browser` call) while the renderer's pane is closed, so no
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
  if (attached) hideView(attached); // #406: hidden, not removed — an agent can still drive it
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
  for (const tab of panel.tabs) {
    removeView(tab);
    destroyTab(tab);
  }
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
// These are the primitives design mode calls (and, until #399 removed them, the
// agent's `mcp__browser__*` tools; the other primitives are now test-only). They operate on the SAME view the user sees, so the
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

// ---------------------------------------------------------------------------
// Driving a tab nobody is looking at (#406, policy A2 — ledger #409 §Decisions Q2). The pure rules live in shared/browser-hidden-drive.ts.
// A hidden tab is attached + `setVisible(false)` and THROTTLED while idle; an agent action takes a LEASE that switches `backgroundThrottling` off
// right before the action and back on after the last one (a short linger; a watchdog forces it if the action died). A hidden capture comes from the
// frame subscription (Page.captureScreenshot on a hidden view is flaky); click / type go through CDP unchanged. A tab whose document has no first
// frame (never attached, or navigated while hidden) is SURFACED under the visible tab (a pulse the human cannot see), or refused when nothing covers it.
// ---------------------------------------------------------------------------

/** Measured inside the built app (#406): a hidden composited tab can be DEAD (Chromium keeps the compositor frame of only the ~3 most recently hidden views: no frame from its
 *  subscription, no input lands) — one `capturePage()` wakes it. And a `capturePage()` taken while `backgroundThrottling` is OFF leaves the page PINNED unthrottled
 *  (Electron's flag disables WasHidden(): the capture's temporary show is never undone): the lease end flips throttling back ON and takes one more, discarded, capture — now
 *  its release hides the page for real (a capture without the flip, or after flipping back, leaves it throttled). Bounded: a wake that hangs must not hang the action. */
const WAKE_MS = 900;
/** A capture of a hidden view can be served from its still-alive OLD compositor frame, which predates a DOM change made since (measured #406: ~1.4 % stale first shots after a
 *  11-13 ms wake; ~5 % stale for a timer-driven change inside a lease). EVERY hidden capture therefore primes (shows the page) and then waits for the renderer's next frame, bounded. */
const FRESH_FRAME_MS = 200;
/** A surface pulse waits this long for the page's own first frame before nudging it with a one-pixel resize. */
const NUDGE_AFTER_MS = 300;
/** Leases whose page took a capture while unthrottled: they need the unpin capture when they end. */
const pinnedLeases = new Set<string>();
/** Resolves at the SECOND frame the view delivers from now (the first is the subscription's refresh of the old surface), or after `ms`. Always ends its subscription. */
function afterNextPaint(wc: Electron.WebContents, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    let done = false;
    const fin = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        wc.endFrameSubscription();
      } catch {
        /* contents gone */
      }
      resolve();
    };
    const timer = setTimeout(fin, ms);
    try {
      wc.beginFrameSubscription(false, () => {
        if (++n >= 2) fin();
      });
    } catch {
      fin(); // already subscribed elsewhere / contents gone: no barrier, the capture goes ahead
    }
  });
}
async function wakeView(wc: Electron.WebContents): Promise<void> {
  await Promise.race([wc.capturePage().then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, WAKE_MS))]);
}

export interface DriveLease {
  /** The action is over (idempotent): the linger before the flip-back starts. */
  end(): void;
  /** The action is still running: renews the lease so the watchdog does not call it orphaned. */
  touch(): void;
}
const NOOP_LEASE: DriveLease = { end: () => undefined, touch: () => undefined };
const driveLeases = new LeaseBook();
const leaseId = (tab: Tab): string => `${tabKeyOf(tab)}`;
const tabKeys = new WeakMap<Tab, string>();
const tabKeyOf = (tab: Tab): string => tabKeys.get(tab) ?? '';
const leaseTabs = new Map<string, Tab>();
let leaseTimer: ReturnType<typeof setTimeout> | null = null;

function sweepLeases(): void {
  leaseTimer = null;
  const { unflip, orphaned } = driveLeases.due(Date.now());
  for (const id of unflip) {
    const tab = leaseTabs.get(id);
    leaseTabs.delete(id);
    if (orphaned.includes(id)) log.warn(`browser-panel: lease on ${id} orphaned (its action died): forcing the flip-back`);
    const wc = liveContents(tab);
    if (wc) {
      try {
        wc.setBackgroundThrottling(true);
      } catch {
        /* contents gone */
      }
      // the unpin capture (see WAKE_MS); a lease taken while it runs makes it a capture UNDER the flip again — that lease owes the unpin
      if (pinnedLeases.delete(id) && tab?.surface === 'hidden') void wakeView(wc).then(() => { if (driveLeases.isHeld(id)) pinnedLeases.add(id); });
    } else pinnedLeases.delete(id);
  }
  scheduleSweep();
}
function scheduleSweep(): void {
  if (leaseTimer) clearTimeout(leaseTimer);
  leaseTimer = null;
  const at = driveLeases.nextWakeAt();
  if (at !== null) leaseTimer = setTimeout(sweepLeases, Math.max(25, at - Date.now()));
}

/** The visible tab of the focused workspace — what a pulse is hidden under — or null when nothing is on screen. */
function coverTab(): Tab | null {
  const fp = focusedWsId ? panels.get(focusedWsId) : undefined;
  const t = fp?.tabs.find((x) => x.id === fp.attachedId);
  return t && t.surface === 'visible' && liveContents(t) ? t : null;
}

/** Show `tab` once BELOW the cover (same rect, so the cover hides all of it) until its document has produced a frame, then hide it again. */
/** When a tab was last surfaced under the cover: its frame was just painted, so the same action's capture needs no prime (P6 stays under 2 s). */
const surfacedAt = new WeakMap<Tab, number>();
/** A pulse in flight per tab: an action that arrives meanwhile waits for it (the tab reads `visible` during the pulse, which would decide `direct` — no lease, no prime). */
const pulses = new WeakMap<Tab, Promise<void>>();
function surfaceTab(tab: Tab, cover: Tab): Promise<void> {
  const run = surfaceTabNow(tab, cover);
  const tracked = run.then(() => undefined, () => undefined);
  pulses.set(tab, tracked);
  void tracked.then(() => { if (pulses.get(tab) === tracked) pulses.delete(tab); });
  return run;
}
async function surfaceTabNow(tab: Tab, cover: Tab): Promise<void> {
  const win = getWindow?.();
  const wc = liveContents(tab);
  if (!win || !wc) throw new Error('the browser tab has no live view');
  tab.view.setBounds(cover.view.getBounds());
  win.contentView.addChildView(tab.view, 0);
  tab.view.setVisible(true);
  tab.surface = 'visible'; // composited for the length of the pulse only
  const t0 = Date.now();
  try {
    // painted = the view yields a non-empty capture (a frame subscription is not a reliable signal: measured, it stays silent on a re-shown static page that then captures fine)
    let painted = false;
    let nudged = false;
    while (!painted && Date.now() - t0 < SURFACE_PULSE_MAX_MS) {
      const img = await Promise.race([wc.capturePage().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 250))]);
      if (img && !img.isEmpty()) {
        painted = true;
        break;
      }
      if (!nudged && Date.now() - t0 >= NUDGE_AFTER_MS) {
        // a re-shown view whose page is static may never resubmit a frame (measured: a navigated, previously used tab): a one-pixel resize under the cover makes the renderer submit one
        nudged = true;
        const b = cover.view.getBounds();
        tab.view.setBounds({ ...b, width: Math.max(1, b.width - 1) });
        await new Promise((r) => setTimeout(r, 30));
        tab.view.setBounds(b);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    log.info(`browser-panel: drive ${tabKeyOf(tab) || tab.id} pulse: ${painted ? 'painted' : 'NOT painted'} after ${Date.now() - t0} ms${nudged ? ' (nudged)' : ''}`);
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0)))); // measured: attach + 800 ms under the cover; the frame callback alone is early
    // a document still loading (an action right after a click-through navigation) would be taken OUT again by hideView: wait for it, bounded
    while (Date.now() < t0 + SURFACE_PULSE_MAX_MS && liveContents(tab) && (wc.isLoading?.() || Date.now() - tab.stoppedAt < FIRST_PAINT_MS)) await new Promise((r) => setTimeout(r, 40));
  } finally {
    if (tab.surface === 'visible' && tab !== coverTab()) hideView(tab);
    tab.composited = true;
    surfacedAt.set(tab, Date.now());
  }
}

/** The first frame the view's compositor delivers after this call (a refresh of its current surface), as a NativeImage; rejects after `deadlineMs`. */
function frameOf(wc: Electron.WebContents, deadlineMs: number, onlyDirty = true): Promise<Electron.NativeImage> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        wc.endFrameSubscription();
      } catch {
        /* contents gone */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('no frame'))), deadlineMs);
    try {
      wc.beginFrameSubscription(onlyDirty, (image) => finish(() => resolve(image)));
    } catch (e) {
      finish(() => reject(e));
    }
  });
}

/**
 * An agent is about to act on `tabId`: the decision (pure) + its effects. A tab on screen needs nothing; a hidden one takes a throttling lease; one with no
 * first frame is surfaced first; anything else is refused with a clear, FAST error. The caller MUST `end()` the lease (try/finally) — a watchdog backs that up.
 */
export async function beginAgentAction(wsId: string, tabId: BrowserTabId | undefined, kind: ActionKind): Promise<DriveLease> {
  const tab = resolveTab(wsId, tabId);
  const wc = liveContents(tab);
  if (!tab || !wc) throw new Error(`no browser panel open for workspace ${wsId}`);
  const inPulse = pulses.get(tab);
  if (inPulse) await inPulse; // another action's surface pulse on this tab: wait for it, then decide on the settled state
  const cover = coverTab();
  const d = decideTabAction({ tab: { surface: tab.surface, composited: tab.composited, hasCover: !!cover && cover !== tab }, kind });
  if (kind !== 'other' && d.act !== 'direct') log.info(`browser-panel: drive ${wsId.slice(0, 8)}/${tab.id} ${kind} → ${d.act} (surface ${tab.surface}, composited ${tab.composited}, cover ${!!cover}, loading ${!!wc.isLoading?.()})`);
  if (d.act === 'refuse') throw new Error(d.message);
  if (d.act === 'direct') return NOOP_LEASE;
  if (d.act === 'surface-then-lease') await surfaceTab(tab, cover as Tab);
  const id = `${wsId}/${tab.id}`;
  tabKeys.set(tab, id);
  leaseTabs.set(id, tab);
  const flipped = driveLeases.acquire(id, Date.now()).flip;
  if (flipped) wc.setBackgroundThrottling(false);
  scheduleSweep();
  if (kind === 'input') surfacedAt.delete(tab); // the page may change from here on: a later capture needs its own prime
  if (flipped && kind === 'input' && tab.surface === 'hidden') {
    pinnedLeases.add(id);
    const w0 = Date.now();
    await wakeView(wc); // a click / type needs a live view (evaluate does not; a capture primes its own, see captureTabFrame)
    log.info(`browser-panel: drive ${wsId.slice(0, 8)}/${tab.id} wake capture ${Date.now() - w0} ms`);
  }
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      driveLeases.release(id, Date.now());
      scheduleSweep();
    },
    touch: () => {
      if (!ended) {
        driveLeases.touch(id, Date.now());
        scheduleSweep();
      }
    },
  };
}

/** A hidden tab's screenshot from its frame subscription (35–50 ms measured; fresh, never the pre-hide frame): PNG/JPEG base64, `clip` honoured. */
type CaptureOpts = { format?: 'png' | 'jpeg'; quality?: number; clip?: { x: number; y: number; width: number; height: number } };
/** One capture at a time per tab: Electron keeps ONE frame subscriber per contents, so two overlapping captures would end each other's prime / fallback. */
const captureQueue = new WeakMap<Tab, Promise<void>>();
export function captureTabFrame(wsId: string, tabId: BrowserTabId | undefined, opts: CaptureOpts = {}): Promise<string> {
  const tab = resolveTab(wsId, tabId);
  if (!tab) return captureTabFrameNow(wsId, tabId, opts);
  const run = (captureQueue.get(tab) ?? Promise.resolve()).then(() => captureTabFrameNow(wsId, tabId, opts));
  const tail = run.then(() => undefined, () => undefined);
  captureQueue.set(tab, tail);
  void tail.then(() => { if (captureQueue.get(tab) === tail) captureQueue.delete(tab); });
  return run;
}
async function captureTabFrameNow(wsId: string, tabId: BrowserTabId | undefined, opts: CaptureOpts): Promise<string> {
  const lease = await beginAgentAction(wsId, tabId, 'capture');
  try {
    const tab = resolveTab(wsId, tabId);
    const wc = liveContents(tab);
    if (!tab || !wc) throw new Error(`no browser panel open for workspace ${wsId}`);
    let img: Electron.NativeImage | null = null;
    pinnedLeases.add(`${wsId}/${tab.id}`); // a capture under the flip pins the page: the lease end unpins it
    const justSurfaced = Date.now() - (surfacedAt.get(tab) ?? 0) <= 1500;
    surfacedAt.delete(tab); // single use: only the capture of the action that surfaced the tab skips the prime
    if (tab.surface === 'hidden' && !justSurfaced) {
      const p0 = Date.now();
      await wakeView(wc); // prime: shows the page so the renderer produces its frame (and wakes a dead view) …
      await afterNextPaint(wc, FRESH_FRAME_MS); // … settle: the capture below must not read the old surface
      log.info(`browser-panel: drive ${wsId.slice(0, 8)}/${tab.id} prime+settle ${Date.now() - p0} ms`);
    }
    try {
      // `capturePage()` of a hidden view under the lease is fresh and wakes a dead one (measured in the built app); the frame subscription is the fallback.
      const c0 = Date.now();
      const c = await Promise.race([wc.capturePage(), new Promise<null>((r) => setTimeout(() => r(null), HIDDEN_FRAME_DEADLINE_MS))]);
      if (c && !c.isEmpty()) img = c;
      log.info(`browser-panel: drive ${wsId.slice(0, 8)}/${tab.id} frame capture ${Date.now() - c0} ms (${img ? 'got a frame' : 'none'})`);
    } catch {
      /* fall through to the frame subscription */
    }
    try {
      img = img ?? (await frameOf(wc, 600));
    } catch {
      log.info(`browser-panel: drive ${wsId.slice(0, 8)}/${tab.id} capture got NO frame in ${HIDDEN_FRAME_DEADLINE_MS} ms (surface ${tab.surface}, composited ${tab.composited})`);
      throw new Error(NO_FRAME_MESSAGE);
    }
    const size = img.getSize();
    const rect = cropRect(opts.clip, size.width, size.height, size.width / Math.max(1, tab.view.getBounds().width));
    const out = rect ? img.crop(rect) : img;
    return (opts.format === 'jpeg' ? out.toJPEG(Math.max(0, Math.min(100, opts.quality ?? 80))) : out.toPNG()).toString('base64');
  } finally {
    lease.end();
  }
}

/** Capture the panel as a JPEG (base64) — the agent's "screenshot" primitive.
 *  Uses the native `capturePage()` (simpler + faster than `Page.captureScreenshot`),
 *  matching the Claude Code desktop app's screenshot tool. */
export async function capture(
  wsId: string,
  quality = 75,
  tabId?: BrowserTabId,
): Promise<string> {
  const q = Math.max(0, Math.min(100, quality));
  const tab = resolveTab(wsId, tabId);
  if (tab && tab.surface !== 'visible') return captureTabFrame(wsId, tab.id, { format: 'jpeg', quality: q });
  const wc = liveContents(tab);
  if (!wc) throw new Error(`no browser panel open for workspace ${wsId}`);
  const image = await withTimeout(wc.capturePage(), 10_000, 'capturePage');
  return image.toJPEG(q).toString('base64');
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
  // Pin the tab the refs were stamped on (#397): `data-orch-ref` ids are per PAGE, so a later `click ref_N` must go to this tab
  // even when the human has switched to another one since.
  const tab = resolveTab(wsId, tabId);
  const out = String(await evaluate(wsId, script, tab?.id ?? tabId));
  const panel = getPanel(wsId); // evaluate may have just created the panel (first read_page): pin whatever it read
  const read = tab ?? (panel ? activeTabOf(panel) : undefined);
  if (panel && read) panel.refTabId = read.id;
  return out;
}

/** The tab a `ref_N` belongs to: the explicit one, else the tab the latest {@link readPage} came from (even if another tab is active now), else the active tab. */
function refTab(wsId: string, tabId?: BrowserTabId): BrowserTabId | undefined {
  if (tabId !== undefined) return tabId;
  const panel = getPanel(wsId);
  if (panel?.refTabId !== undefined) {
    if (!panel.tabs.some((t) => t.id === panel.refTabId)) {
      throw new Error('the tab this ref came from was closed (call read_page again)');
    }
    return panel.refTabId;
  }
  return resolveTab(wsId)?.id;
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
  const pin = (resolveTab(wsId, tabId) ?? liveTabFor(wsId, tabId)).id;
  const lease = await beginAgentAction(wsId, pin, 'input');
  try {
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
  } finally {
    lease.end();
  }
}

/** Click a `ref_N` element (resolves its center, then clickAt). */
export async function clickRef(wsId: string, ref: number, tabId?: BrowserTabId): Promise<void> {
  const pin = refTab(wsId, tabId); // resolve once: the point and the click hit the same tab, the one the ref came from
  const p = await refToPoint(wsId, ref, pin); // a stale ref fails HERE, before anything is swapped on the human's screen
  if (pin !== undefined) agentActivateTab(wsId, pin); // a click needs its tab on screen: bring it (focused workspace only) — the human is told
  await clickAt(wsId, p.x, p.y, pin);
}

/** Type text into the currently-focused element via CDP (trusted input). */
export async function typeText(wsId: string, text: string, tabId?: BrowserTabId): Promise<void> {
  const lease = await beginAgentAction(wsId, tabId, 'input');
  try {
    await withTimeout(cdp(wsId, 'Input.insertText', { text }, tabId), 10_000, 'type (insertText)');
  } finally {
    lease.end();
  }
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
  const pin = refTab(wsId, tabId);
  const found = await evaluate(
    wsId,
    `(() => {
      const el = document.querySelector('[data-orch-ref="${ref}"]');
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    pin,
  );
  if (found === false) throw new Error(`ref_${ref} not found (call read_page again)`); // before any swap on the human's screen
  if (pin !== undefined) agentActivateTab(wsId, pin);
}

/** Scroll the page (or a wheel gesture) via CDP. */
export async function scrollBy(wsId: string, deltaY: number, tabId?: BrowserTabId): Promise<void> {
  const lease = await beginAgentAction(wsId, tabId, 'input');
  try {
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
  } finally {
    lease.end();
  }
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
// The overlay is deliberately built to be un-pickable by itself (pointer-events:
// none; the walker also skips its host) and page-CSS-proof (closed shadow root,
// inline !important, top layer). The injected script + its constants live in
// ./design-mode-script.ts.

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
      component: raw.component,
    },
    screenshot,
  );
}
