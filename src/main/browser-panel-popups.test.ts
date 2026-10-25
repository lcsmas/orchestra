// Popup routing (#396, ledger #405): the REAL browser-panel.ts + browser-popups.ts over a stubbed `electron` (the loader hook the tabs test uses),
// driven through the window-open handler exactly as Electron calls it: handler(details) -> response, then `did-create-window` for an `allow`.
// What each arm pins is named in its title; scripts/mutate-browser-popups.mjs reddens every one of them.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const STUB = `
const views = (globalThis.__bpViews ??= []);
class WebContents {
  constructor(view) {
    this._view = view;
    this.destroyed = false; this.closed = 0; this.url = ''; this.title = '';
    this.dbgAttached = false; this.loaded = []; this.handlers = {}; this.onceHandlers = {};
    this.debugger = { attach() {}, detach() {}, isAttached: () => false, sendCommand: () => Promise.resolve({}) };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  }
  isDestroyed() { return this.destroyed; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  once(ev, fn) { (this.onceHandlers[ev] ||= []).push(fn); }
  emitEvent(ev, ...a) { for (const f of (this.handlers[ev] || [])) f(...a); }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }
  reload() {} getURL() { return this.url; } getTitle() { return this.title; }
  capturePage() { return Promise.resolve({ toJPEG: () => Buffer.from('x') }); }
  close() { this.destroyed = true; this.closed++; this._view.webContents = undefined; for (const f of (this.onceHandlers.destroyed || [])) f(); }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(this); this._wc = this.webContents; this.bounds = null; views.push(this); }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
}
// A popup child window as Electron hands it to 'did-create-window'.
export class FakeWindow {
  constructor() { this.destroyedFlag = false; this.visible = false; this.shown = []; this.closedHandlers = []; this.webContents = new WebContents({}); globalThis.__bpWins.push(this); }
  isDestroyed() { return this.destroyedFlag; }
  destroy() { this.destroyedFlag = true; this.webContents.destroyed = true; for (const f of this.webContents.onceHandlers.destroyed || []) f(); for (const f of this.closedHandlers) f(); }
  once(ev, fn) { if (ev === 'closed') this.closedHandlers.push(fn); }
  show() { this.visible = true; this.shown.push('show'); }
  showInactive() { this.visible = true; this.shown.push('showInactive'); }
  hide() { this.visible = false; this.shown.push('hide'); }
}
globalThis.__bpWins = [];
export const Menu = { buildFromTemplate: () => ({ popup() {} }) };
export const clipboard = { writeText() {} };
export const shell = { openExternal(u) { (globalThis.__bpExternal ??= []).push(u); } };
export const session = { fromPartition: () => ({ setUserAgent() {}, getUserAgent: () => 'UA' }) };
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
const stub = await import(stubUrl);
const { FakeWindow } = stub as { FakeWindow: new () => any };

const attached = new Set<unknown>();
const mainWindow = {
  contentView: { addChildView: (v: unknown) => attached.add(v), removeChildView: (v: unknown) => attached.delete(v) },
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
  assert.equal(attached.size, 0, 'a composited view leaked past destroyPanel');
  g.__bpExternal = [];
  g.__bpLog.length = 0; // the logger stub holds this very array
});

const RECT = { x: 1, y: 2, width: 640, height: 480 };
const wcOf = (tab: { view: unknown }) => (tab.view as { _wc: any })._wc;
const openShown = (ws: string) => { bp.showPanel(ws); bp.setBounds(ws, RECT); };
const base = 'https://app.example';
/** window.open as Electron reports it: a link click is foreground-tab + unnamed; a named/sized window.open is new-window. */
const link = (url = `${base}/link`) => ({ url, frameName: '', features: '', disposition: 'foreground-tab', referrer: { url: '', policy: 'default' } });
const named = (url = `${base}/auth`, frameName = 'oauth') => ({ url, frameName, features: 'width=500,height=600', disposition: 'new-window', referrer: { url: '', policy: 'default' } });
const clickOn = (wc: any) => wc.emitEvent('input-event', {}, { type: 'mouseDown' });
/** A child window came up: emit what Electron emits on the opener, and hand back the window. */
function created(wc: any): any {
  const w = new FakeWindow();
  wc.emitEvent('did-create-window', w, {});
  return w;
}
const tabsOf = (ws: string) => bp.listTabs(ws);

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

test('a NAMED popup is an `allow` that creates a native child window (opener kept): sandboxed, parented to the main window, hidden until adopted', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc);
  const r = wc.openHandler(named());
  assert.equal(r.action, 'allow');
  assert.equal(r.outlivesOpener, false);
  assert.equal(r.overrideBrowserWindowOptions.parent, mainWindow);
  assert.equal(r.overrideBrowserWindowOptions.show, false);
  assert.equal(r.overrideBrowserWindowOptions.resizable, false, 'fixed size: sway floats it instead of tiling it beside the app');
  assert.deepEqual(r.overrideBrowserWindowOptions.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal(tabsOf(ws).length, 1, 'no tab for an opener-dependent popup');
  const w = created(wc);
  assert.equal(w.visible, true, 'a clicked popup of the on-screen workspace is shown');
  assert.deepEqual(w.shown, ['show']);
  assert.equal(typeof w.webContents.openHandler, 'function', 'the child window routes ITS popups too');
});

test('a page-initiated child window of the on-screen workspace is shown WITHOUT stealing focus', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  wc.openHandler(named());
  assert.deepEqual(created(wc).shown, ['showInactive']);
});

test('a child window of a workspace that is NOT on screen stays hidden until its panel is shown, and hides again with it', () => {
  const ws = newWs();
  const other = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  wc.openHandler(named());
  const w = created(wc);
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
    const r = wc.openHandler(named(`${base}/a${i}`, `w${i}`));
    if (r.action === 'allow') wins.push(created(wc));
  }
  assert.equal(wins.length, 3);
  assert.equal(g.__bpLog.filter((l: string) => l.includes('popup refused (budget)')).length, 17);
  // A window that closes gives its slot back.
  wins[0].destroy();
  assert.equal(wc.openHandler(named(`${base}/b`, 'b')).action, 'allow');
  created(wc);
});

test('the cap is shared: 7 tabs + 1 window = 8 is full, and a clicked tab-route popup is refused (no 9th surface)', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  for (let i = 0; i < 6; i++) bp.createTab(ws, { openedBy: 'agent' });
  const wc = wcOf(t1);
  clickOn(wc);
  assert.equal(wc.openHandler(named()).action, 'allow', '7 tabs + 0 windows has one slot');
  created(wc);
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
  for (let i = 0; i < 2; i++) { clickOn(wc); assert.equal(wc.openHandler(named(`${base}/w${i}`, `n${i}`)).action, 'allow'); created(wc); }
  assert.equal(tabsOf(ws).length, 6);
  clickOn(wc);
  assert.equal(wc.openHandler(link(`${base}/y`)).action, 'deny');
  assert.equal(tabsOf(ws).length, 6, 'tab route refused at the cap');
  clickOn(wc);
  assert.equal(wc.openHandler(named(`${base}/z`, 'zz')).action, 'deny', 'window route refused at the cap');
  assert.equal(g.__bpWins.length, 2);
});

test('a popup from INSIDE a child window is routed by the same policy: _blank -> a tab of the panel', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc); wc.openHandler(named());
  const w = created(wc);
  clickOn(w.webContents);
  assert.equal(w.webContents.openHandler(link(`${base}/from-popup`)).action, 'deny');
  assert.equal(tabsOf(ws).length, 2);
});

test('NO leaked windows: destroyPanel destroys every child window, including ones opened from a child window', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc); wc.openHandler(named());
  const a = created(wc);
  clickOn(a.webContents); a.webContents.openHandler(named(`${base}/nested`, 'nested'));
  const b = created(a.webContents);
  bp.destroyPanel(ws);
  assert.equal(a.isDestroyed(), true);
  assert.equal(b.isDestroyed(), true);
});

test('NO leaked windows: destroyPanel closes the child windows even when the opener\'s `destroyed` event never fires (a hung / crashed renderer)', () => {
  const ws = newWs();
  openShown(ws);
  const wc = wcOf(bp.getActiveTab(ws)!);
  clickOn(wc); wc.openHandler(named());
  const w = created(wc);
  wc.onceHandlers.destroyed = []; // the opener will not announce its own destruction
  bp.destroyPanel(ws);
  assert.equal(w.isDestroyed(), true);
});

test('NO leaked windows: closing the opener tab closes the child windows it opened (and theirs)', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const wc2 = wcOf(t2);
  clickOn(wc2); wc2.openHandler(named());
  const a = created(wc2);
  clickOn(a.webContents); a.webContents.openHandler(named(`${base}/nested`, 'nested'));
  const b = created(a.webContents);
  const wc1 = wcOf(t1);
  clickOn(wc1); wc1.openHandler(named(`${base}/other`, 'other'));
  const c = created(wc1);
  bp.closeTab(ws, t2.id);
  assert.equal(a.isDestroyed(), true, 'the opener tab went away');
  assert.equal(b.isDestroyed(), true, 'and so did the window that window opened');
  assert.equal(c.isDestroyed(), false, 'another tab\'s window is untouched');
});

test('a window Electron created that routePopup did not ask for is destroyed, never adopted', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  const w = created(wc);
  assert.equal(w.isDestroyed(), true);
});

test('a popup whose panel is gone (destroyed under the page) is denied and builds nothing', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  bp.destroyPanel(ws);
  clickOn(wc);
  assert.equal(wc.openHandler(link()).action, 'deny');
  assert.equal(bp.listTabs(ws).length, 0, 'no panel was resurrected');
});

test('a clicked non-web link goes to the OS; the same from a script is refused; script/file URLs never leave the panel', () => {
  const ws = newWs();
  const wc = wcOf(bp.ensurePanel(ws).tabs[0]);
  clickOn(wc);
  assert.equal(wc.openHandler(link('mailto:a@b.c')).action, 'deny');
  assert.deepEqual(g.__bpExternal, ['mailto:a@b.c']);
  wc.openHandler(link('slack://x'));
  assert.deepEqual(g.__bpExternal, ['mailto:a@b.c'], 'no click: not handed to the OS');
  clickOn(wc); wc.openHandler(link('javascript:alert(1)'));
  clickOn(wc); wc.openHandler(link('file:///etc/passwd'));
  assert.deepEqual(g.__bpExternal, ['mailto:a@b.c'], 'unsafe schemes are refused even with a click');
  assert.equal(tabsOf(ws).length, 1);
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
