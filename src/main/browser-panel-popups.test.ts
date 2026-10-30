// Popup routing (#396, ledger #405): the REAL browser-panel.ts + browser-popups.ts over a stubbed `electron` (the loader hook the tabs test uses), driven
// through the window-open handler exactly as Electron 33 drives it: handler(details) -> response; for an `allow` with `createWindow`, Electron then calls the
// factory with `{ webContents: <the real guest>, ...show/size defaults, ...the page's parsed features, ...our override }` (replicated by electronMerge) and
// REQUIRES it to return that same guest. What each arm pins is named in its title; scripts/mutate-browser-popups.mjs reddens every one of them.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { electronMerge } from '../shared/electron-guest-window.testlib.ts';


const STUB = `
const views = (globalThis.__bpViews ??= []);
let pidSeq = 1000;
class WebContents {
  constructor(view) {
    this._view = view;
    this.destroyed = false; this.closed = 0; this.url = ''; this.title = '';
    this.dbgAttached = false; this.loaded = []; this.handlers = {}; this.onceHandlers = {}; this.pid = ++pidSeq; this.session = { id: 'session-of-' + this.pid };
    this.debugger = { attach() {}, detach() {}, isAttached: () => false, sendCommand: () => Promise.resolve({}) };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  }
  isDestroyed() { return this.destroyed; }
  getOSProcessId() { return this.pid; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  once(ev, fn) { (this.onceHandlers[ev] ||= []).push(fn); }
  emitEvent(ev, ...a) { for (const f of (this.handlers[ev] || [])) f(...a); }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  setBackgroundThrottling() {} beginFrameSubscription() {} endFrameSubscription() {}
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }
  reload() {} getURL() { return this.url; } getTitle() { return this.title; }
  capturePage() { return Promise.resolve({ toJPEG: () => Buffer.from('x') }); }
  close() { this.destroyed = true; this.closed++; if (this._view) this._view.webContents = undefined; for (const f of (this.onceHandlers.destroyed || [])) f(); }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(this); this._wc = this.webContents; this.bounds = null; views.push(this); }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
  setVisible(v) { this.visible = v; }
  getBounds() { return this.bounds ?? { x: 0, y: 0, width: 800, height: 600 }; }
}
// The guest Electron creates for a window.open (no window yet): the factory must give it one.
export function newGuest() { return new WebContents(null); }
// A popup child window, built by OUR createWindow factory: \`opts\` is exactly what the factory passed to the constructor.
export class BrowserWindow {
  constructor(opts) {
    this.opts = opts; this.destroyedFlag = false; this.visible = false; this.shown = []; this.closedHandlers = []; this.handlers = {}; this.title = '';
    this.webContents = opts.webContents ?? new WebContents(null);
    globalThis.__bpWins.push(this);
  }
  isDestroyed() { return this.destroyedFlag; }
  destroy() { this.destroyedFlag = true; this.webContents.destroyed = true; for (const f of this.webContents.onceHandlers.destroyed || []) f(); for (const f of this.closedHandlers) f(); }
  once(ev, fn) { if (ev === 'closed') this.closedHandlers.push(fn); }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emitEvent(ev, ...a) { for (const f of (this.handlers[ev] || [])) f(...a); }
  setTitle(t) { this.title = t; }
  loadURL(u) { globalThis.__bpWinLoads = [...(globalThis.__bpWinLoads || []), u]; return Promise.resolve(); }
  show() { this.visible = true; this.shown.push('show'); }
  showInactive() { this.visible = true; this.shown.push('showInactive'); }
  hide() { this.visible = false; this.shown.push('hide'); }
}
globalThis.__bpWins = [];
export const Menu = { buildFromTemplate: () => ({ popup() {} }) };
export const clipboard = { writeText() {} };
export const shell = { openExternal(u) { (globalThis.__bpExternal ??= []).push(u); } };
export const session = { fromPartition: (p) => ((globalThis.__bpSessions ??= {})[p] ??= { setUserAgent() {}, getUserAgent: () => 'UA', permCalls: 0, setPermissionRequestHandler(fn) { this.permHandler = fn; this.permCalls++; } }) };
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(STUB);
const platformUrl = 'data:text/javascript,' + encodeURIComponent(`export const platform = { broadcast() {} };`);
const loggerUrl =
  'data:text/javascript,' +
  encodeURIComponent(`const L = (globalThis.__bpLog ??= []); export const log = { info(m){ L.push(String(m)); }, warn(m){ L.push(String(m)); }, debug(){}, error(){} };`);

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === 'electron') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
        if (spec.endsWith('/platform') || spec === './platform') return { url: ${JSON.stringify(platformUrl)}, shortCircuit: true };
        if (spec.endsWith('/logger') || spec === './logger') return { url: ${JSON.stringify(loggerUrl)}, shortCircuit: true };
        return next(spec, ctx);
      }
    `),
  pathToFileURL('./'),
);

const bp = await import('./browser-panel.ts');
const popups = await import('./browser-popups.ts');
const memory = await import('./browser-tab-memory.ts');
const stub = (await import(stubUrl)) as { newGuest: () => any; BrowserWindow: new (opts: any) => any };

const children = new Set<unknown>(); // every view that is a CHILD of the window (visible or hidden — #406)
const attached = { // the views COMPOSITED on screen: children that are not setVisible(false)
  get size() { return [...children].filter((v) => (v as { visible?: boolean }).visible !== false).length; },
  has: (v: unknown) => children.has(v) && (v as { visible?: boolean }).visible !== false,
  add: (v: unknown) => children.add(v),
  delete: (v: unknown) => children.delete(v),
};
const PARENT_BOUNDS = { x: 0, y: 0, width: 1500, height: 950 };
const mainWindow = {
  contentView: { addChildView: (v: unknown) => attached.add(v), removeChildView: (v: unknown) => attached.delete(v) },
  getContentBounds: () => PARENT_BOUNDS,
  isDestroyed: () => false,
};
bp.initBrowserPanels(() => mainWindow as never);

let seq = 0;
const used: string[] = [];
const newWs = () => {
  const ws = `ws-popups-${++seq}`;
  used.push(ws);
  return ws;
};
const g = globalThis as any;
afterEach(() => {
  for (const ws of used.splice(0)) bp.destroyPanel(ws);
  for (const w of g.__bpWins.splice(0)) assert.equal(w.isDestroyed(), true, 'a popup child window outlived destroyPanel');
  assert.equal(children.size, 0, 'a view (visible or hidden) leaked past destroyPanel');
  g.__bpExternal = [];
  g.__bpWinLoads = [];
  g.__bpLog.length = 0; // the logger stub holds this very array
});

const RECT = { x: 1, y: 2, width: 640, height: 480 };
const wcOf = (tab: { view: unknown }) => (tab.view as { _wc: any })._wc;
const openShown = (ws: string) => { bp.showPanel(ws); bp.setBounds(ws, RECT); };
const base = 'https://app.example';
const REF = { url: '', policy: 'default' };
/** window.open as Electron reports it: a link click is foreground-tab + unnamed; a named/sized window.open is new-window. */
const link = (url = `${base}/link`) => ({ url, frameName: '', features: '', disposition: 'foreground-tab', referrer: REF });
const named = (url = `${base}/auth`, frameName = 'oauth', features = 'width=500,height=600') => ({ url, frameName, features, disposition: 'new-window', referrer: REF });
const clickOn = (wc: any) => wc.emitEvent('input-event', {}, { type: 'mouseDown' });
const tabsOf = (ws: string) => bp.listTabs(ws);
const HOSTILE = 'width=4000,height=3000,x=0,y=0,alwaysOnTop,frame=no,transparent,fullscreen,kiosk,modal,closable=no,focusable=no';

/** Run a window.open the way Electron 33 does: the handler, then — for an `allow` with a factory — the factory with Electron's merged options, whose return value MUST be the guest. */
function open(wc: any, details: ReturnType<typeof named>) {
  const r = wc.openHandler(details);
  if (r.action !== 'allow') return { r, win: undefined as any, guest: undefined as any };
  assert.equal(typeof r.createWindow, 'function', 'an allowed popup goes through OUR factory, never Electron\'s own BrowserWindow');
  const guest = stub.newGuest();
  const returned = r.createWindow(electronMerge(guest, details.features, r.overrideBrowserWindowOptions));
  assert.equal(returned, guest, 'Electron throws "Invalid webContents" unless the factory returns the guest it was handed');
  return { r, win: g.__bpWins.find((w: any) => w.webContents === returned), guest };
}
/** An allowed popup that must have produced a window. */
function openWin(wc: any, details = named()) {
  const o = open(wc, details);
  assert.ok(o.win, `no window for ${JSON.stringify(details)} (handler said ${o.r.action})`);
  return o.win;
}

test('a clicked `_blank` link opens a NEW TAB: the opener tab stays put, the new one loads the URL and becomes active', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  const wc = wcOf(t1);
  clickOn(wc);
  const r = wc.openHandler(link());
  assert.equal(r.action, 'deny', 'the new tab is built by us, never by Electron');
  const tabs = tabsOf(ws);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].url, '', 'the opener tab is not navigated (today\'s same-view handler loaded the popup HERE)');
  assert.equal(tabs[1].active, true);
  assert.deepEqual(wcOf(bp.getTab(ws, tabs[1].id)!).loaded, [`${base}/link`]);
  assert.equal(wc.loaded.length, 0);
});

test('a popup inherits the opener tab\'s owner (the agent may close what its own tab opened, never the human\'s)', () => {
  const ws = newWs();
  const human = bp.ensurePanel(ws).tabs[0];
  const agent = bp.createTab(ws, { openedBy: 'agent' });
  clickOn(wcOf(human)); wcOf(human).openHandler(link());
  clickOn(wcOf(agent)); wcOf(agent).openHandler(link(`${base}/two`));
  const by = tabsOf(ws).map((t) => t.openedBy);
  assert.deepEqual(by, [human.openedBy, 'agent', human.openedBy, 'agent']);
});

test('a ctrl/middle click (background-tab) opens a tab that is NOT activated', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  wc.openHandler({ ...link(), disposition: 'background-tab' });
  const tabs = tabsOf(ws);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].active, true);
  assert.equal(tabs[1].active, false);
});

test('page-initiated popups (no input) open in the background and draw on the budget of 3: a storm of 30 leaves 1 + 3 tabs', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  for (let i = 0; i < 30; i++) wc.openHandler(link(`${base}/p${i}`));
  const tabs = tabsOf(ws);
  assert.equal(tabs.length, 4, 'budget 3 + the opener');
  assert.equal(tabs.filter((t) => t.active).length, 1);
  assert.equal(tabs[0].active, true, 'a page-initiated popup never steals the active tab');
  assert.equal(g.__bpViews.filter((v: any) => !v.webContents?.destroyed).length >= 4, true);
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (budget)')).length, 27, 'every refusal is logged with its reason');
});

test('closing a page-initiated tab gives its budget back', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  for (let i = 0; i < 3; i++) wc.openHandler(link(`${base}/p${i}`));
  wc.openHandler(link(`${base}/refused`));
  assert.equal(tabsOf(ws).length, 4);
  bp.closeTab(ws, tabsOf(ws)[3].id);
  wc.openHandler(link(`${base}/again`));
  assert.equal(tabsOf(ws).length, 4, 'one slot was freed and taken again');
});

test('RATE: a page that opens and closes its popups cannot churn forever — at most 6 page-initiated opens per minute even with the budget free; clicks are unaffected; the minute rolls over', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  const realNow = Date.now;
  let t = 5_000_000;
  Date.now = () => t;
  try {
    for (let i = 0; i < 12; i++) {
      wc.openHandler(link(`${base}/churn${i}`));
      const tabs = tabsOf(ws);
      if (tabs.length > 1) bp.closeTab(ws, tabs[tabs.length - 1].id); // closed again at once: no concurrent pressure
    }
    assert.equal(g.__bpViews.length >= 7, true);
    assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (rate)')).length, 6, '12 attempts: 6 opened, 6 refused by the rate cap (the budget never bound)');
    assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (budget)')).length, 0);
    clickOn(wc);
    wc.openHandler(link(`${base}/clicked`));
    assert.equal(tabsOf(ws).length, 2, 'a user\'s click is not rate-limited');
    bp.closeTab(ws, tabsOf(ws)[1].id);
    t += 61_000;
    wc.openHandler(link(`${base}/next-minute`));
    assert.equal(tabsOf(ws).length, 2, 'a minute later the workspace may open again');
  } finally {
    Date.now = realNow;
  }
});

test('RATE (windows): named page-initiated popups that close themselves again are capped too — 6 per minute, then refused with the budget free', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  const realNow = Date.now;
  Date.now = () => 7_000_000;
  try {
    let opened = 0;
    for (let i = 0; i < 12; i++) {
      const o = open(wc, named(`${base}/c${i}`, `churn${i}`));
      if (o.win) { opened++; o.win.destroy(); } // the page closes its popup at once: no concurrent pressure on the budget
    }
    assert.equal(opened, 6);
    assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (rate)')).length, 6);
    assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (budget)')).length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('user-gesture popups do not draw on the budget, only on the cap: 8 clicks give 8 tabs, the 9th click is refused', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  for (let i = 0; i < 12; i++) { clickOn(wc); wc.openHandler(link(`${base}/c${i}`)); }
  assert.equal(tabsOf(ws).length, 8);
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (cap)')).length, 5);
});

test('one input opens ONE popup: the second window.open of the same click is page-initiated', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  wc.openHandler(link(`${base}/first`));
  wc.openHandler(link(`${base}/second`));
  const tabs = tabsOf(ws);
  assert.equal(tabs.length, 3);
  assert.equal(tabs[1].active, true, 'the clicked popup is shown');
  assert.equal(tabs[2].active, false, 'the second one is not');
  // Only the second one holds budget: fill the rest of it, then one more is refused.
  wc.openHandler(link(`${base}/third`)); wc.openHandler(link(`${base}/fourth`));
  assert.equal(tabsOf(ws).length, 5, 'second + third + fourth are page-initiated (budget 3), the opener and the clicked one are not');
  wc.openHandler(link(`${base}/fifth`));
  assert.equal(tabsOf(ws).length, 5);
});

// ---- the native child window: built from an ALLOWLIST by our createWindow factory ---------------------------------------------------------------

test('a NAMED popup is an `allow` answered by OUR createWindow factory (opener kept), with the guest\'s web preferences pinned; no tab for it', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const r = wc.openHandler(named());
  assert.equal(r.action, 'allow');
  assert.equal(r.outlivesOpener, false);
  assert.equal(typeof r.createWindow, 'function');
  assert.deepEqual(r.overrideBrowserWindowOptions, { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }, 'Electron derives the GUEST\'s preferences from this, merged over the page\'s features');
  assert.equal(tabsOf(ws).length, 1, 'no tab for an opener-dependent popup');
});

test('the factory builds the window from the allowlist: parent = the app window, hidden until adopted, FIXED size (sway floats it), the guest handed back, shown because its workspace is on screen', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const { win, guest } = open(wc, named());
  assert.ok(win);
  assert.equal(win.opts.webContents, guest);
  assert.equal(win.opts.parent, mainWindow);
  assert.equal(win.opts.show, false);
  assert.equal(win.opts.resizable, false, 'sway TILES a resizable child window beside the app, halving it');
  assert.equal(win.opts.autoHideMenuBar, true);
  assert.deepEqual(win.opts.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.deepEqual([win.opts.width, win.opts.height], [500, 600], 'a benign requested size is kept');
  assert.equal(win.visible, true, 'a clicked popup of the on-screen workspace is shown');
  assert.deepEqual(win.shown, ['show']);
  assert.equal(typeof win.webContents.openHandler, 'function', 'the child window routes ITS popups too');
});

test('F1 — a HOSTILE features string cannot shape the window: nothing but the allowlist reaches the BrowserWindow constructor, the size stays inside 90% of the app window', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const win = openWin(wc, named(`${base}/auth`, 'oauth', HOSTILE));
  const ALLOWED = new Set(['webContents', 'parent', 'show', 'width', 'height', 'autoHideMenuBar', 'resizable', 'webPreferences']);
  for (const k of Object.keys(win.opts)) assert.ok(ALLOWED.has(k), `leaked window option ${k}`);
  for (const k of ['alwaysOnTop', 'frame', 'transparent', 'fullscreen', 'kiosk', 'modal', 'closable', 'focusable', 'x', 'y']) assert.equal(k in win.opts, false, `${k} reached the constructor`);
  assert.deepEqual([win.opts.width, win.opts.height], [1350, 855], '4000x3000 requested -> 90% of the 1500x950 app window');
  assert.equal(win.opts.show, false);
  assert.equal(win.opts.parent, mainWindow);
});

test('F1 — a `webContents` feature (Electron would hand the factory a STRING for the guest) is refused in the handler: no window, nothing to leak', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  assert.equal(wc.openHandler(named(`${base}/auth`, 'oauth', 'width=500,webContents=pwned')).action, 'deny');
  assert.equal(g.__bpWins.length, 0);
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (unsafe-features)')).length, 1);
});

test('F1 — the factory refuses a guest it must not give a window (panel gone, or the last slot taken meanwhile): the guest is CLOSED and handed back, never left windowless', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const r = wc.openHandler(named());
  assert.equal(r.action, 'allow');
  bp.destroyPanel(ws); // the workspace goes away between the handler and the factory
  const guest = stub.newGuest();
  assert.equal(r.createWindow(electronMerge(guest, 'width=500,height=600', r.overrideBrowserWindowOptions)), guest, 'Electron requires the guest back');
  assert.equal(guest.closed, 1, 'the guest was closed, not left windowless');
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (gone) ws=') && l.includes('at creation')).length, 1);
  assert.equal(g.__bpWins.length, 0, 'no window was built');
  // the other race: the cap fills up between the handler and the factory
  const ws2 = newWs();
  const t1 = bp.ensurePanel(ws2).tabs[0];
  for (let i = 0; i < 6; i++) bp.createTab(ws2, { openedBy: 'agent' });
  const wc2 = wcOf(t1);
  clickOn(wc2);
  const r2 = wc2.openHandler(named());
  assert.equal(r2.action, 'allow', '7 tabs: one slot at handler time');
  bp.createTab(ws2, { openedBy: 'agent' }); // 8 tabs now
  const guest2 = stub.newGuest();
  assert.equal(r2.createWindow(electronMerge(guest2, 'width=500,height=600', r2.overrideBrowserWindowOptions)), guest2);
  assert.equal(guest2.closed, 1);
  assert.equal(g.__bpWins.length, 0);
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (cap) ws=') && l.includes('at creation')).length, 1);
});

test('F6 — each factory call carries ITS OWN decision: two approvals (a clicked one, then a page-initiated one) created in the REVERSE order keep their own flags and owners', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.ensurePanel(ws).tabs[0];
  const agentTab = bp.createTab(ws, { openedBy: 'agent' });
  const wcH = wcOf(t1), wcA = wcOf(agentTab);
  clickOn(wcH);
  const rA = wcH.openHandler(named(`${base}/a`, 'wa')); // human tab, gesture
  const rB = wcA.openHandler(named(`${base}/b`, 'wb')); // agent tab, NO gesture
  assert.equal(rA.action, 'allow'); assert.equal(rB.action, 'allow');
  const gB = stub.newGuest(), gA = stub.newGuest();
  rB.createWindow(electronMerge(gB, 'width=500,height=600', rB.overrideBrowserWindowOptions)); // B's window comes up FIRST
  rA.createWindow(electronMerge(gA, 'width=500,height=600', rA.overrideBrowserWindowOptions));
  const live = popups.livePopupWindows(ws);
  const byGuest = (g_: any) => live.find((p) => p.win.webContents === g_)!;
  assert.deepEqual([byGuest(gA).pageInitiated, byGuest(gA).openedBy, byGuest(gA).frameName], [false, bp.getTab(ws, 't1')!.openedBy, 'wa']);
  assert.deepEqual([byGuest(gB).pageInitiated, byGuest(gB).openedBy, byGuest(gB).frameName], [true, 'agent', 'wb']);
  assert.deepEqual(g.__bpWins.find((w: any) => w.webContents === gB).shown, ['showInactive'], 'the page-initiated one does not steal focus');
  assert.deepEqual(g.__bpWins.find((w: any) => w.webContents === gA).shown, ['show']);
});

test('a page-initiated child window of the on-screen workspace is shown WITHOUT stealing focus', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  assert.deepEqual(openWin(wc).shown, ['showInactive']);
});

test('a child window of a workspace that is NOT on screen stays hidden until its panel is shown, and hides again with it', () => {
  const ws = newWs();
  const other = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  const w = openWin(wc);
  assert.equal(w.visible, false, 'workspace never shown: the popup must not appear over another workspace');
  openShown(ws);
  assert.equal(w.visible, true);
  openShown(other); // the renderer switches workspace: showPanel(other) hides ws first
  assert.equal(w.visible, false, 'switching workspace hides the child window with its panel');
  bp.hidePanel(other);
  openShown(ws);
  assert.equal(w.visible, true);
  bp.hidePanel(ws);
  assert.equal(w.visible, false);
});

test('child windows count against the cap with the tabs, and page-initiated ones against the budget: a storm of named popups opens 3, then none', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  const wins: any[] = [];
  for (let i = 0; i < 20; i++) {
    const o = open(wc, named(`${base}/a${i}`, `w${i}`));
    if (o.win) wins.push(o.win);
  }
  assert.equal(wins.length, 3);
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (budget)')).length, 17);
  // A window that closes gives its slot back.
  wins[0].destroy();
  assert.ok(open(wc, named(`${base}/b`, 'b')).win);
});

test('the cap is shared: 7 tabs + 1 window = 8 is full, and a clicked tab-route popup is refused (no 9th surface)', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  for (let i = 0; i < 6; i++) bp.createTab(ws, { openedBy: 'agent' });
  const wc = wcOf(t1);
  clickOn(wc);
  openWin(wc);
  assert.equal(tabsOf(ws).length, 7);
  clickOn(wc);
  assert.equal(wc.openHandler(link(`${base}/last-tab`)).action, 'deny');
  assert.equal(tabsOf(ws).length, 7, 'refused: the window took the 8th slot');
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (cap)')).length, 1);
});

test('the cap is shared, other way: 6 tabs + 2 windows = 8 refuses both routes, gesture or not', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  for (let i = 0; i < 5; i++) bp.createTab(ws, { openedBy: 'agent' });
  const wc = wcOf(t1);
  for (let i = 0; i < 2; i++) { clickOn(wc); openWin(wc, named(`${base}/w${i}`, `n${i}`)); }
  assert.equal(tabsOf(ws).length, 6);
  clickOn(wc);
  assert.equal(wc.openHandler(link(`${base}/y`)).action, 'deny');
  assert.equal(tabsOf(ws).length, 6, 'tab route refused at the cap');
  clickOn(wc);
  assert.equal(wc.openHandler(named(`${base}/z`, 'zz')).action, 'deny', 'window route refused at the cap');
  assert.equal(g.__bpWins.length, 2);
});

test('the human\'s own `+` (tryOpenTab) shares the cap with popup windows: 5 tabs + 3 windows = 8 refuses it', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  for (let i = 0; i < 4; i++) bp.createTab(ws, { openedBy: 'agent' });
  const wc = wcOf(t1);
  for (let i = 0; i < 3; i++) { clickOn(wc); openWin(wc, named(`${base}/w${i}`, `n${i}`)); }
  assert.equal(tabsOf(ws).length, 5);
  const r = bp.tryOpenTab(ws, { openedBy: bp.getTab(ws, 't1')!.openedBy });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'cap');
  assert.equal(tabsOf(ws).length, 5, 'refused: no sixth tab');
  // control: with one window gone there is room again
  g.__bpWins[0].destroy();
  assert.equal(bp.tryOpenTab(ws, { openedBy: bp.getTab(ws, 't1')!.openedBy }).ok, true);
});

test('a popup from INSIDE a child window is routed by the same policy: _blank -> a tab of the panel', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const w = openWin(wc);
  clickOn(w.webContents);
  assert.equal(w.webContents.openHandler(link(`${base}/from-popup`)).action, 'deny');
  assert.equal(tabsOf(ws).length, 2);
});

// ---- F5: Electron's frame-name registry is process-global -------------------------------------------------------------------------------------------

test('F5 — a named popup is refused while ANOTHER OPENER holds a live window of that name (Electron\'s frame-name registry is process-global): another workspace, or another TAB of the same workspace; the holder itself, other names and a freed name are fine', () => {
  const a = newWs(), b = newWs();
  const tA = bp.ensurePanel(a).tabs[0];
  const tA2 = bp.createTab(a, { openedBy: 'agent' }); // a second tab of the SAME workspace
  const wcA = wcOf(tA), wcA2 = wcOf(tA2), wcB = wcOf(bp.ensurePanel(b).tabs[0]);
  clickOn(wcA);
  const winA = openWin(wcA, named(`${base}/a`, 'oauth'));
  clickOn(wcB);
  assert.equal(wcB.openHandler(named(`${base}/b`, 'oauth')).action, 'deny', 'workspace B must not reuse A\'s live window');
  clickOn(wcA2);
  assert.equal(wcA2.openHandler(named(`${base}/evil`, 'oauth')).action, 'deny', 'a hostile tab of the SAME workspace must not load into (and retarget) the bank tab\'s popup');
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (name-in-use)')).length, 2);
  clickOn(wcB);
  assert.ok(open(wcB, named(`${base}/b`, 'other')).win, 'another name is fine');
  clickOn(wcA);
  assert.equal(wcA.openHandler(named(`${base}/a2`, 'oauth')).action, 'allow', 'the holder itself may reuse its own named window (the browser resolves it)');
  winA.destroy();
  clickOn(wcA2);
  assert.ok(open(wcA2, named(`${base}/b2`, 'oauth')).win, 'a closed popup frees its name');
});

// ---- F2: the origin in the title -----------------------------------------------------------------------------------------------------------------

test('F2 — the child window\'s title carries the page\'s ORIGIN first, follows navigation, and the page\'s own title is sanitised (page-title-updated is prevented)', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const win = openWin(wc, named('https://accounts.example.com/o/auth?token=SECRET', 'oauth'));
  assert.equal(win.title, 'https://accounts.example.com', 'before the page titles itself: just the origin, never the query');
  let prevented = false;
  win.emitEvent('page-title-updated', { preventDefault: () => { prevented = true; } }, 'Sign in\u202e\u0007'); // the BrowserWindow's event: only its preventDefault stops the native title
  assert.equal(prevented, true, 'Electron\'s own title update is cancelled: the title is ours');
  assert.equal(win.title, 'https://accounts.example.com — Sign in');
  win.webContents.url = 'https://evil.example/phish';
  win.webContents.title = 'Google';
  win.webContents.emitEvent('did-navigate', {}, 'https://evil.example/phish');
  assert.equal(win.title, 'https://evil.example — Google', 'the origin follows the navigation');
});

// ---- F7: memory attribution (#394) ----------------------------------------------------------------------------------------------------------------

test('F7 — popup child windows are billed to their workspace like tabs (they hold cap slots and a renderer each); a closed window drops out', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.ensurePanel(ws).tabs[0];
  const wc = wcOf(t1);
  clickOn(wc);
  const win = openWin(wc);
  const MB = 1024 * 1024;
  const table = (pids: number[]) => pids.map((pid) => ({ pid, ppid: 1, memBytes: 100 * MB, cpuPct: 0, rssPages: 0, comm: 'electron' })) as never;
  const view = memory.currentBrowserTabMemory(undefined, undefined, table)!;
  const row = view.byWorkspace.find((r) => r.wsId === ws)!;
  assert.equal(row.tabs, 2, 'one tab + one popup window');
  assert.equal(row.bytes, 200 * MB, 'both renderers are billed');
  assert.ok(view.attributedPids.includes(win.webContents.pid), 'the window\'s renderer is attributed (not counted again in the App tile)');
  win.destroy();
  const after = memory.currentBrowserTabMemory(undefined, undefined, table)!.byWorkspace.find((r) => r.wsId === ws)!;
  assert.equal(after.tabs, 1);
  assert.equal(after.bytes, 100 * MB);
});

// ---- teardown -----------------------------------------------------------------------------------------------------------------------------------

test('NO leaked windows: destroyPanel destroys every child window, including ones opened from a child window', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const a = openWin(wc);
  clickOn(a.webContents);
  const b = openWin(a.webContents, named(`${base}/nested`, 'nested'));
  bp.destroyPanel(ws);
  assert.equal(a.isDestroyed(), true);
  assert.equal(b.isDestroyed(), true);
});

test('NO leaked windows: destroyPanel closes the child windows even when the opener\'s `destroyed` event never fires (a hung / crashed renderer)', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const w = openWin(wc);
  wc.onceHandlers.destroyed = []; // the opener will not announce its own destruction
  bp.destroyPanel(ws);
  assert.equal(w.isDestroyed(), true);
});

test('NO leaked windows: closing the opener tab closes the child windows it opened (and theirs)', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const wc2 = wcOf(t2);
  clickOn(wc2);
  const a = openWin(wc2);
  clickOn(a.webContents);
  const b = openWin(a.webContents, named(`${base}/nested`, 'nested'));
  const wc1 = wcOf(t1);
  clickOn(wc1);
  const c = openWin(wc1, named(`${base}/other`, 'other'));
  bp.closeTab(ws, t2.id);
  assert.equal(a.isDestroyed(), true, 'the opener tab went away');
  assert.equal(b.isDestroyed(), true, 'and so did the window that window opened');
  assert.equal(c.isDestroyed(), false, 'another tab\'s window is untouched');
});

test('a popup whose panel is gone (destroyed under the page) is denied and builds nothing', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  bp.destroyPanel(ws);
  clickOn(wc);
  assert.equal(wc.openHandler(link()).action, 'deny');
  assert.equal(bp.listTabs(ws).length, 0, 'no panel was resurrected');
});

test('OS hand-off is mailto:/tel: on a click only; every other scheme — even with a click — is refused and never reaches the OS', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  assert.equal(wc.openHandler(link('mailto:a@b.c')).action, 'deny');
  assert.deepEqual(g.__bpExternal, ['mailto:a@b.c']);
  wc.openHandler(link('tel:+33123456789')); // no click any more: refused
  assert.deepEqual(g.__bpExternal, ['mailto:a@b.c'], 'no click: not handed to the OS');
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'vbscript:x', 'ssh://root@h', 'zoommtg://zoom.us/join', 'smb://h/s', 'slack://x', 'devtools://devtools/x', 'chrome-untrusted://x']) {
    clickOn(wc);
    wc.openHandler(link(u));
  }
  assert.deepEqual(g.__bpExternal, ['mailto:a@b.c'], 'nothing else ever reaches shell.openExternal');
  assert.equal(tabsOf(ws).length, 1, 'and nothing loaded');
});

test('a refusal is logged with its reason and the ORIGIN only (an OAuth URL carries tokens in its query)', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  wc.openHandler(link('javascript:alert(1)'));
  clickOn(wc);
  wc.openHandler(link('file:///etc/passwd'));
  for (let i = 0; i < 4; i++) wc.openHandler(link(`${base}/cb?token=SECRET${i}#frag`));
  const refused = g.__bpLog.filter((l: string) => l.includes('popup refused'));
  assert.equal(refused.length, 3);
  assert.equal(refused.some((l: string) => l.includes('SECRET')), false);
  assert.equal(refused.some((l: string) => l.includes(`url=${base}`)), true);
});

// ---- pre-review round: Electron's per-embedder factory slot, the guest-less path, tabs() robustness, when the rate is counted ------------------------

test('BACKSTOP — a window Electron creates through its DEFAULT path (`did-create-window`: our factory never emits it, so its per-embedder slot was consumed by another popup) is destroyed, on tabs and on popup windows alike', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const popupWin = openWin(wc);
  for (const emitter of [wc, popupWin.webContents]) {
    const stray = new stub.BrowserWindow({ webContents: stub.newGuest(), width: 4000, height: 3000, alwaysOnTop: true }); // what the page's features would have built
    emitter.emitEvent('did-create-window', stray, {});
    assert.equal(stray.isDestroyed(), true, 'the page-shaped window is destroyed on sight');
  }
  assert.equal(g.__bpLog.filter((l: string) => l.includes('created outside the allowlist factory')).length, 2);
  assert.equal(popupWin.isDestroyed(), false, 'the legitimate popup is untouched');
});

test('guest-less path (Electron builds the contents itself): the window is pinned to the OPENER\'s session — never the default one — and loads the URL itself', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const r = wc.openHandler(named(`${base}/guestless`, 'oauth'));
  assert.equal(r.action, 'allow');
  const ret = r.createWindow({ show: true, width: 800, height: 600 }); // no `webContents` key
  const win = g.__bpWins.find((w: any) => w.webContents === ret);
  assert.ok(win, 'a window was built and its own contents returned');
  assert.equal(win.opts.webPreferences.session, wc.session, 'same session as the opener (cookies, UA normalisation)');
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.deepEqual(g.__bpWinLoads, [`${base}/guestless`], 'the factory loads the page itself on this path');
});

test('#394 source robustness — a popup window whose contents are already destroyed does not break the sample for every workspace: it reads as unmeasured', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.ensurePanel(ws).tabs[0];
  const wc = wcOf(t1);
  clickOn(wc);
  const win = openWin(wc);
  win.webContents.destroyed = true; // contents gone, BrowserWindow object still alive (a crash / teardown window)
  const MB = 1024 * 1024;
  const table = (pids: number[]) => pids.map((pid) => ({ pid, ppid: 1, memBytes: 100 * MB, cpuPct: 0, rssPages: 0, comm: 'electron' })) as never;
  const view = memory.currentBrowserTabMemory(undefined, undefined, table);
  assert.ok(view, 'the sample still works (a throw inside the source would blank every workspace)');
  const row = view!.byWorkspace.find((r) => r.wsId === ws)!;
  assert.equal(row.tabs, 2);
  assert.equal(row.unmeasured, 1, 'the dead window is unmeasured, not 0 bytes');
  assert.equal(row.bytes, 100 * MB);
  win.webContents.destroyed = false;
});

test('RATE is counted when a window REALLY opens, not at approval: approvals whose factory never runs (a reused named window, a refusal) consume none', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  const realNow = Date.now;
  Date.now = () => 9_000_000;
  try {
    for (let i = 0; i < 10; i++) assert.equal(wc.openHandler(named(`${base}/approved${i}`, `ghost${i}`)).action, 'allow', 'approved, never created (Electron reused a window / the guest was dropped)');
    let opened = 0;
    for (let i = 0; i < 12; i++) {
      const o = open(wc, named(`${base}/real${i}`, `real${i}`));
      if (o.win) { opened++; o.win.destroy(); }
    }
    assert.equal(opened, 6, 'the 10 ghost approvals did not eat the rate: all 6 real openings were allowed, then the cap bit');
  } finally {
    Date.now = realNow;
  }
});

// ---- final round (review round 2): page-driven bounds, external protocols, two clauses no arm saw ------------------------------------------------------

test('F-a — a page\'s window.resizeTo / moveTo is VETOED on popup windows and on tabs (`content-bounds-updated`), so the creation-time clamp holds for the whole life of the window', () => {
  const ws = newWs();
  openShown(ws);
  const tabWc = wcOf(bp.getActiveTab(ws)!);
  clickOn(tabWc);
  const win = openWin(tabWc);
  for (const [what, emitter] of [['popup window', win.webContents], ['tab', tabWc]] as const) {
    let prevented = false;
    emitter.emitEvent('content-bounds-updated', { preventDefault: () => { prevented = true; } }, { x: 0, y: 0, width: 4000, height: 4000 });
    assert.equal(prevented, true, `${what}: the page-driven bounds change is cancelled (Electron applies it by default)`);
  }
});

test('F-b — link clicks and redirects to external protocols inside a tab or popup (Electron asks the SESSION for the `openExternal` permission) are refused unless mailto:/tel: AND the requesting contents had a user gesture (one input, one launch); every other permission keeps its default; one handler per session', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  bp.createTab(ws, { openedBy: 'agent' }); // a second tab of the SAME session
  const ses = g.__bpSessions[`orchestra-browser-${ws}`];
  assert.equal(typeof ses.permHandler, 'function', 'the panel session is guarded');
  assert.equal(ses.permCalls, 1, 'installed once per session, however many tabs share it');
  const wc = wcOf(t1);
  const ask = (permission: string, details?: object, requester: any = wc) => { let out: boolean | undefined; ses.permHandler(requester, permission, (ok: boolean) => { out = ok; }, details); return out; };
  // mailto:/tel: with NO gesture (a load-time location.href / a programmatic a.click(): no input event) — before anything has clicked
  assert.equal(ask('openExternal', { externalURL: 'mailto:a@b.c' }), false, 'a load-time location.href / a programmatic a.click(): no input event, no gesture');
  assert.equal(ask('openExternal', { externalURL: 'tel:+999' }), false);
  // other schemes: refused with AND without a click (and a refusal must not eat the click's activation)
  for (const url of ['ssh://root@h', 'zoommtg://zoom.us/join?confno=1', 'smb://h/s', 'vscode://file/x', 'slack://x', 'javascript:alert(1)', 'file:///etc/passwd', '']) {
    assert.equal(ask('openExternal', { externalURL: url }), false, `${url || '(empty)'} without a click`);
    clickOn(wc);
    assert.equal(ask('openExternal', { externalURL: url }), false, `${url || '(empty)'} WITH a click`);
  }
  assert.equal(ask('openExternal'), false, 'no details at all: refused');
  // a refused link leaves the click's activation unconsumed (an ordinary browser honours a navigation within the activation window): spend it before the next assertions
  assert.equal(ask('openExternal', { externalURL: 'mailto:spend@b.c' }), true, 'the unconsumed activation of the last click above');
  // mailto:/tel: — only with a gesture of the REQUESTING contents
  clickOn(wc);
  assert.equal(ask('openExternal', { externalURL: 'mailto:a@b.c' }), true, 'a clicked mailto: launches');
  assert.equal(ask('openExternal', { externalURL: 'mailto:a@b.c' }), false, 'one input, one launch: the gesture was consumed');
  clickOn(wc);
  assert.equal(ask('openExternal', { externalURL: ' TEL:+33123456789' }), true, 'a clicked tel: launches');
  clickOn(wcOf(bp.getTab(ws, 't2')!));
  assert.equal(ask('openExternal', { externalURL: 'mailto:a@b.c' }), false, 'a click on ANOTHER tab is no gesture for this one');
  assert.equal(ask('openExternal', { externalURL: 'mailto:a@b.c' }, null), false, 'no requesting contents: refused');
  for (const permission of ['geolocation', 'notifications', 'media', 'clipboard-read']) assert.equal(ask(permission, {}), true, `${permission}: unchanged (granted by default)`);
  const refusals = g.__bpLog.filter((l: string) => l.includes('external protocol refused'));
  assert.ok(refusals.some((l: string) => l.includes('(ssh:)')), 'a refused scheme is logged with the SCHEME only');
  assert.ok(refusals.some((l: string) => l.includes('(mailto: no click)')), 'a no-click refusal says so');
  assert.equal(g.__bpLog.some((l: string) => l.includes('root@h') || l.includes('confno') || l.includes('a@b.c') || l.includes('+999')), false, 'never the rest of the URL');
});

test('F-d (1) — a popup\'s frame name is registered TRIMMED: a holder named " sso " still blocks another opener asking for "sso" (and for " sso ")', () => {
  const ws = newWs();
  const a = wcOf(bp.ensurePanel(ws).tabs[0]);
  const b = wcOf(bp.createTab(ws, { openedBy: 'agent' }));
  clickOn(a);
  openWin(a, named(`${base}/a`, ' sso '));
  clickOn(b);
  assert.equal(b.openHandler(named(`${base}/evil`, 'sso')).action, 'deny', 'untrimmed registration would let Electron load the evil URL into the holder\'s window');
  clickOn(b);
  assert.equal(b.openHandler(named(`${base}/evil2`, ' sso ')).action, 'deny');
});

test('F-d (2) — ownership is inherited THROUGH a popup window: a popup opened from an AGENT tab\'s child window opens agent-owned tabs (the agent can close them); from a HUMAN tab\'s, human-owned', () => {
  const ws = newWs();
  openShown(ws);
  const human = bp.ensurePanel(ws).tabs[0];
  const agent = bp.createTab(ws, { openedBy: 'agent' });
  for (const [tab, want] of [[agent, 'agent'], [human, human.openedBy]] as const) {
    const before = tabsOf(ws).length;
    clickOn(wcOf(tab));
    const child = openWin(wcOf(tab), named(`${base}/c-${want}`, `child-${want}`));
    clickOn(child.webContents);
    assert.equal(child.webContents.openHandler(link(`${base}/from-child-${want}`)).action, 'deny');
    const opened = tabsOf(ws).slice(before);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].openedBy, want, `a tab opened from the child window of a ${want} tab`);
    child.destroy();
  }
});
