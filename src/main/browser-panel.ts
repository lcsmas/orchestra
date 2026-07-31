import { WebContentsView, Menu, clipboard, session, shell } from 'electron';
import type { BrowserBounds, BrowserPanelState } from '../shared/types';
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
// Isolation: the registry keys every view by `wsId`. The agent's browser tools
// (agent-browser-tools.ts) close over their session's `wsId` and route through
// `getPanel(wsId)`, so a workspace's agent can only drive that workspace's
// panel — multiple workspaces each get an independent browser by construction.
//
// This file is Electron-only: it owns native views, so only the main process
// touches it. The renderer reaches it through IPC (`browser:*`) and receives
// pushes on `browser:event`.

/** How the native view is attached to the window + kept in sync with the DOM
 *  placeholder the renderer draws.
 *
 *  `view` is always assigned at construction and never reassigned — but the
 *  `WebContentsView` it points at can OUTLIVE its own `webContents`: Electron
 *  sets `view.webContents` to `undefined` once the underlying WebContents is
 *  destroyed, even though its typing declares the property non-nullable
 *  (`readonly webContents: WebContents`). So `panel.view.webContents` must be
 *  treated as possibly-absent at every dereference — see {@link liveContents}. */
interface Panel {
  wsId: string;
  view: WebContentsView;
  /** True while the panel is visible (bounds set, added to the window). */
  visible: boolean;
  /** Whether setBounds has ever run for this view. Until the renderer measures
   *  the `.browser-pane` placeholder the view has no meaningful rect, so adding
   *  it to the window would composite it at a garbage position over the app. */
  bounded: boolean;
  /** A show was requested before any bounds existed (agent-driven open while the
   *  pane is closed); the attach happens on the first setBounds instead. */
  pendingShow: boolean;
  /** Whether this view's debugger has been attached for agent driving. */
  debuggerAttached: boolean;
  /** Last computed navigation state, for a fresh renderer to re-request. */
  state: BrowserPanelState;
}

const panels = new Map<string, Panel>();

/** The panel's live `webContents`, or `undefined` if the view has none any more.
 *
 *  Electron drops `WebContentsView.webContents` (to `undefined`) once the
 *  underlying WebContents is destroyed — by us via {@link destroyPanel}, or
 *  EXTERNALLY (renderer/GPU crash of the sandboxed panel page, Chromium
 *  reclaiming it, window teardown). Its typing says `readonly webContents:
 *  WebContents`, so TypeScript happily lets `panel.view.webContents.isDestroyed()`
 *  through — and that expression throws `Cannot read properties of undefined
 *  (reading 'isDestroyed')` in exactly that case: the guard meant to detect a
 *  dead view is itself what crashes on one.
 *
 *  Routing every dereference through here makes the absent case representable
 *  and checkable. Callers that get `undefined` should treat the panel as dead. */
function liveContents(panel: Panel | undefined): Electron.WebContents | undefined {
  const wc = panel?.view?.webContents as Electron.WebContents | undefined;
  return wc && !wc.isDestroyed() ? wc : undefined;
}

/** Drop a panel whose native view is gone, so the next call recreates it
 *  cleanly instead of tripping over a husk left in the map. */
function reapIfDead(wsId: string): Panel | undefined {
  const panel = panels.get(wsId);
  if (!panel) return undefined;
  if (liveContents(panel)) return panel;
  // The view lost its webContents (destroyed by us or externally). Detach the
  // husk from the window if it is still attached, then forget it.
  if (panel.visible) {
    const win = getWindow?.();
    try {
      win?.contentView.removeChildView(panel.view);
    } catch {
      /* already detached / window gone */
    }
    panel.visible = false;
  }
  panels.delete(wsId);
  return undefined;
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
 *  wsId so two workspaces browsing the same site stay isolated. */
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
  };
}

/** Recompute the panel's navigation state from the live webContents and push it
 *  to the renderer (URL bar / title / nav buttons). */
function emitState(panel: Panel, patch: Partial<BrowserPanelState>): void {
  // Reachable from webContents event handlers, which can still fire while the
  // contents are being torn down — so the view may already have lost them.
  const wc = liveContents(panel);
  if (!wc) return;
  const nav = wc.navigationHistory;
  panel.state = {
    ...panel.state,
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: nav.canGoBack(),
    canGoForward: nav.canGoForward(),
    ...patch,
  };
  platform.broadcast('browser:event', panel.wsId, panel.state);
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

/** Create (or return) the panel for `wsId`. The native view is created lazily
 *  on first open and reused thereafter. Throws if the window isn't ready. */
export function ensurePanel(wsId: string): Panel {
  // reapIfDead returns the panel only if its view still has live contents;
  // otherwise it evicts the husk so we fall through and build a fresh one.
  const existing = reapIfDead(wsId);
  if (existing) return existing;

  const win = getWindow?.();
  if (!win) throw new Error('browser-panel: main window not ready');

  const ses = session.fromPartition(partitionFor(wsId));
  normalizeUserAgent(ses);
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(wsId),
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

  const panel: Panel = {
    wsId,
    view,
    visible: false,
    bounded: false,
    pendingShow: false,
    debuggerAttached: false,
    state: emptyState(wsId),
  };

  const wc = view.webContents;
  // Keep external target=_blank / window.open navigations in-panel when they're
  // web URLs; bounce anything else to the OS (mirrors login-browser.ts).
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      void wc.loadURL(url);
    } else {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  wc.on('did-start-loading', () => emitState(panel, { loading: true, error: undefined }));
  wc.on('did-stop-loading', () => emitState(panel, { loading: false }));
  wc.on('did-navigate', () => emitState(panel, {}));
  wc.on('did-navigate-in-page', () => emitState(panel, {}));
  wc.on('page-title-updated', () => emitState(panel, {}));
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED (a superseded navigation) — not a real failure.
    if (!isMainFrame || errorCode === -3) return;
    emitState(panel, { loading: false, error: `${errorDescription} (${validatedURL})` });
  });

  attachContextMenu(view, win);
  panels.set(wsId, panel);
  return panel;
}

/** Look up an existing panel (does NOT create). Used by the agent tools, which
 *  should only drive a panel the user/agent has already opened. */
export function getPanel(wsId: string): Panel | undefined {
  return reapIfDead(wsId);
}

/** Add the view to the window (if not already) and mark it visible. Bounds are
 *  applied separately via {@link setBounds} once the renderer measures them. */
export function showPanel(wsId: string): BrowserPanelState {
  const panel = ensurePanel(wsId);
  const win = getWindow?.();
  // Never composite a view that has never been positioned: an agent can call
  // this (via its MCP browser tools) while the renderer's pane is closed, so no
  // placeholder has been measured and the view would land at a garbage rect
  // over the app. Defer the attach to the first setBounds.
  if (!panel.bounded) {
    panel.pendingShow = true;
    return panel.state;
  }
  if (win && !panel.visible) {
    // Hide every OTHER workspace's panel first: only the active workspace's
    // browser should be composited (they'd otherwise stack).
    for (const [id, other] of panels) {
      if (id !== wsId && other.visible) hidePanel(id);
    }
    win.contentView.addChildView(panel.view);
    panel.visible = true;
  }
  return panel.state;
}

/** Remove the view from the window (stops compositing) without destroying it —
 *  its page + history + cookies survive so re-showing is instant. */
export function hidePanel(wsId: string): void {
  const panel = panels.get(wsId);
  const win = getWindow?.();
  if (!panel) return;
  // Cancel a deferred attach too, or a later setBounds would show a panel the
  // caller has since hidden.
  panel.pendingShow = false;
  if (win && panel.visible) {
    win.contentView.removeChildView(panel.view);
    panel.visible = false;
  }
}

/** Position/size the native view over the renderer's `.browser-pane` rect.
 *  Bounds are device-independent pixels relative to the window content. */
export function setBounds(wsId: string, bounds: BrowserBounds): void {
  // The renderer pushes bounds continuously (ResizeObserver + window resize), so
  // this is the call most likely to land on a panel whose view died underneath
  // it — the burst of `browser:setBounds failed` TypeErrors this guard fixes.
  const panel = reapIfDead(wsId);
  if (!panel) return;
  panel.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
  panel.bounded = true;
  // A panel opened by an agent (showPanel with no renderer mounted) defers its
  // attach until now, when it finally has a real rect to sit in.
  if (panel.pendingShow) {
    panel.pendingShow = false;
    showPanel(wsId);
  }
}

/** Navigate the panel. `to` is a URL (http/https/file); a bare host gets
 *  https:// prepended, and a non-URL string is treated as a query is NOT done
 *  here (the renderer/agent decides). Opens the panel view if needed. */
export async function navigate(wsId: string, to: string): Promise<BrowserPanelState> {
  const panel = ensurePanel(wsId);
  const url = normalizeUrl(to);
  const wc = liveContents(panel);
  if (!wc) return panel.state;
  try {
    await wc.loadURL(url);
  } catch (err) {
    // loadURL rejects on ERR_ABORTED for a superseded nav; state is emitted by
    // did-fail-load for real failures. Swallow so callers don't see spurious
    // rejections.
    log.debug(`browser-panel navigate(${wsId}) ${url}`, err);
  }
  return panel.state;
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

export function goBack(wsId: string): void {
  const wc = liveContents(getPanel(wsId));
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

export function goForward(wsId: string): void {
  const wc = liveContents(getPanel(wsId));
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

export function reload(wsId: string): void {
  liveContents(getPanel(wsId))?.reload();
}

/** Current state snapshot (a freshly-mounted renderer requests this). */
export function getState(wsId: string): BrowserPanelState {
  return panels.get(wsId)?.state ?? emptyState(wsId);
}

/** Destroy a workspace's panel entirely (workspace deleted). */
export function destroyPanel(wsId: string): void {
  const panel = panels.get(wsId);
  if (!panel) return;
  hidePanel(wsId);
  panels.delete(wsId);
  const wc = liveContents(panel);
  if (wc) {
    try {
      if (panel.debuggerAttached) wc.debugger.detach();
    } catch {
      /* already detached */
    }
    // WebContentsView has no close(); destroying its webContents releases it.
    (wc as unknown as { close?: () => void }).close?.();
  }
}

// ---------------------------------------------------------------------------
// Agent driving layer — Electron in-process CDP over `webContents.debugger`.
// ---------------------------------------------------------------------------
//
// These are the primitives the agent's browser tools (agent-browser-tools.ts)
// call. They operate on the SAME view the user sees, so the agent and the user
// share one surface.

/** Attach the view's debugger (idempotent). Enables the CDP domains the tools
 *  need. Returns the panel or throws if the workspace has no open panel. */
export function attachDebugger(wsId: string): Panel {
  const panel = getPanel(wsId) ?? ensurePanel(wsId);
  const wc = liveContents(panel);
  // A dead view surfaces to the agent as a clear error rather than a TypeError
  // about `isDestroyed` — the agent can act on "panel is gone", not on a crash.
  if (!wc) throw new Error(`browser panel for workspace ${wsId} has no live view`);
  const dbg = wc.debugger;
  if (!panel.debuggerAttached) {
    if (!dbg.isAttached()) dbg.attach('1.3');
    panel.debuggerAttached = true;
  }
  return panel;
}

async function cdp(wsId: string, method: string, params?: Record<string, unknown>): Promise<any> {
  const panel = attachDebugger(wsId);
  const wc = liveContents(panel);
  if (!wc) throw new Error(`browser panel for workspace ${wsId} has no live view`);
  return wc.debugger.sendCommand(method, params ?? {});
}

/** Capture the panel as a JPEG (base64) — the agent's "screenshot" primitive.
 *  Uses the native `capturePage()` (simpler + faster than `Page.captureScreenshot`),
 *  matching the Claude Code desktop app's screenshot tool. */
export async function capture(wsId: string, quality = 75): Promise<string> {
  const wc = liveContents(getPanel(wsId));
  if (!wc) throw new Error(`no browser panel open for workspace ${wsId}`);
  const image = await wc.capturePage();
  return image.toJPEG(Math.max(0, Math.min(100, quality))).toString('base64');
}

/** Evaluate JS in the page and return the value (JSON-serialized by CDP). */
export async function evaluate(wsId: string, expression: string): Promise<any> {
  const res = await cdp(wsId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'evaluate failed');
  }
  return res?.result?.value;
}

/** The accessibility tree as a compact text outline, each interactive node
 *  tagged `[ref_N]` so the agent can act on it by ref (matching CC's
 *  `read_page`). Built in-page via a DOM walk (robust across Electron versions
 *  vs the CDP Accessibility domain, which varies). */
export async function readPage(wsId: string): Promise<string> {
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
  return String(await evaluate(wsId, script));
}

/** Resolve a `ref_N` (from {@link readPage}) to viewport center coordinates. */
async function refToPoint(wsId: string, ref: number): Promise<{ x: number; y: number }> {
  const rect = await evaluate(
    wsId,
    `(() => { const el = document.querySelector('[data-orch-ref="${ref}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`,
  );
  if (!rect) throw new Error(`ref_${ref} not found (call read_page again)`);
  return rect;
}

/** Click at viewport coordinates via CDP Input (a real, trusted input event —
 *  unlike a synthetic DOM `.click()` which fails isTrusted checks). */
export async function clickAt(wsId: string, x: number, y: number): Promise<void> {
  await cdp(wsId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp(wsId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Click a `ref_N` element (resolves its center, then clickAt). */
export async function clickRef(wsId: string, ref: number): Promise<void> {
  const p = await refToPoint(wsId, ref);
  await clickAt(wsId, p.x, p.y);
}

/** Type text into the currently-focused element via CDP (trusted input). */
export async function typeText(wsId: string, text: string): Promise<void> {
  await cdp(wsId, 'Input.insertText', { text });
}

/** Set the value of a form element identified by `ref` (matches CC's
 *  `form_input`) — focuses it, selects all, and types, so it works for inputs
 *  and textareas alike, firing input/change events. */
export async function formInput(wsId: string, ref: number, value: string): Promise<void> {
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
  );
}

/** Scroll the page (or a wheel gesture) via CDP. */
export async function scrollBy(wsId: string, deltaY: number): Promise<void> {
  await cdp(wsId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 100,
    y: 100,
    deltaX: 0,
    deltaY,
  });
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
    // Snapshot the full computed style as a plain map; main subsets it
    // (shared/design-mode.ts STYLE_PROPS) so the property list lives in ONE
    // place that the unit tests assert against.
    for (let i = 0; i < cs.length; i++) { const p = cs[i]; computed[p] = cs.getPropertyValue(p); }
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
export async function designModeArm(wsId: string): Promise<void> {
  await evaluate(wsId, DESIGN_MODE_SCRIPT);
}

/** Disarm design mode (user toggled it off, or the panel is closing). Safe to
 *  call when it was never armed — the page-side teardown is guarded. */
export async function designModeDisarm(wsId: string): Promise<void> {
  await evaluate(
    wsId,
    `(() => { if (window.__orchestraDesignTeardown) { try { window.__orchestraDesignTeardown(); } catch (e) {} } window[${JSON.stringify(DESIGN_PICK_GLOBAL)}] = null; return true; })()`,
  );
}

/** Read a completed pick out of the page (and clear it), or `null` if the user
 *  has not clicked yet. `{cancelled:true}` comes back when they pressed Escape.
 *
 *  Polled by the renderer while design mode is armed rather than pushed as a
 *  CDP event, because the picker holds no debugger event subscription — see the
 *  block comment at the top of this section. */
async function readRawPick(wsId: string): Promise<any | null> {
  return evaluate(
    wsId,
    `(() => { const p = window[${JSON.stringify(DESIGN_PICK_GLOBAL)}]; window[${JSON.stringify(DESIGN_PICK_GLOBAL)}] = null; return p || null; })()`,
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
): Promise<DesignPick | { cancelled: true } | null> {
  const raw = await readRawPick(wsId);
  if (!raw) return null;
  if (raw.cancelled) return { cancelled: true };

  const viewport = raw.viewport ?? { width: 1280, height: 800 };
  let screenshot: string | undefined;
  try {
    const clip = clipForBox(raw.box, viewport);
    const shot = await cdp(wsId, 'Page.captureScreenshot', {
      format: 'png',
      clip,
      captureBeyondViewport: false,
    });
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
