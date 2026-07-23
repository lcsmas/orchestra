import { WebContentsView, Menu, clipboard, session, shell } from 'electron';
import type { BrowserBounds, BrowserPanelState } from '../shared/types';
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
// This file is Electron-only. The daemon/headless bundle never imports it; the
// renderer reaches it through IPC (`browser:*`) and receives pushes on
// `browser:event`.

/** How the native view is attached to the window + kept in sync with the DOM
 *  placeholder the renderer draws. `null` view means the panel exists in state
 *  but its native view was torn down (workspace deleted / window closed). */
interface Panel {
  wsId: string;
  view: WebContentsView;
  /** True while the panel is visible (bounds set, added to the window). */
  visible: boolean;
  /** Whether this view's debugger has been attached for agent driving. */
  debuggerAttached: boolean;
  /** Last computed navigation state, for a fresh renderer to re-request. */
  state: BrowserPanelState;
}

const panels = new Map<string, Panel>();

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
 *  to the renderer (URL bar / title / nav buttons) + any ui-rpc client. */
function emitState(panel: Panel, patch: Partial<BrowserPanelState>): void {
  const wc = panel.view.webContents;
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
    const wc = view.webContents;
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
  const existing = panels.get(wsId);
  if (existing && !existing.view.webContents.isDestroyed()) return existing;

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

  const panel: Panel = {
    wsId,
    view,
    visible: false,
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
  const p = panels.get(wsId);
  if (p && p.view.webContents.isDestroyed()) {
    panels.delete(wsId);
    return undefined;
  }
  return p;
}

/** Add the view to the window (if not already) and mark it visible. Bounds are
 *  applied separately via {@link setBounds} once the renderer measures them. */
export function showPanel(wsId: string): BrowserPanelState {
  const panel = ensurePanel(wsId);
  const win = getWindow?.();
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
  if (panel && win && panel.visible) {
    win.contentView.removeChildView(panel.view);
    panel.visible = false;
  }
}

/** Position/size the native view over the renderer's `.browser-pane` rect.
 *  Bounds are device-independent pixels relative to the window content. */
export function setBounds(wsId: string, bounds: BrowserBounds): void {
  const panel = panels.get(wsId);
  if (!panel || panel.view.webContents.isDestroyed()) return;
  panel.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
}

/** Navigate the panel. `to` is a URL (http/https/file); a bare host gets
 *  https:// prepended, and a non-URL string is treated as a query is NOT done
 *  here (the renderer/agent decides). Opens the panel view if needed. */
export async function navigate(wsId: string, to: string): Promise<BrowserPanelState> {
  const panel = ensurePanel(wsId);
  const url = normalizeUrl(to);
  try {
    await panel.view.webContents.loadURL(url);
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
  const panel = getPanel(wsId);
  if (panel?.view.webContents.navigationHistory.canGoBack()) {
    panel.view.webContents.navigationHistory.goBack();
  }
}

export function goForward(wsId: string): void {
  const panel = getPanel(wsId);
  if (panel?.view.webContents.navigationHistory.canGoForward()) {
    panel.view.webContents.navigationHistory.goForward();
  }
}

export function reload(wsId: string): void {
  getPanel(wsId)?.view.webContents.reload();
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
  if (!panel.view.webContents.isDestroyed()) {
    try {
      if (panel.debuggerAttached) panel.view.webContents.debugger.detach();
    } catch {
      /* already detached */
    }
    // WebContentsView has no close(); destroying its webContents releases it.
    (panel.view.webContents as unknown as { close?: () => void }).close?.();
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
  const dbg = panel.view.webContents.debugger;
  if (!panel.debuggerAttached) {
    if (!dbg.isAttached()) dbg.attach('1.3');
    panel.debuggerAttached = true;
  }
  return panel;
}

async function cdp(wsId: string, method: string, params?: Record<string, unknown>): Promise<any> {
  const panel = attachDebugger(wsId);
  return panel.view.webContents.debugger.sendCommand(method, params ?? {});
}

/** Capture the panel as a JPEG (base64) — the agent's "screenshot" primitive.
 *  Uses the native `capturePage()` (simpler + faster than `Page.captureScreenshot`),
 *  matching the Claude Code desktop app's screenshot tool. */
export async function capture(wsId: string, quality = 75): Promise<string> {
  const panel = getPanel(wsId);
  if (!panel) throw new Error(`no browser panel open for workspace ${wsId}`);
  const image = await panel.view.webContents.capturePage();
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
