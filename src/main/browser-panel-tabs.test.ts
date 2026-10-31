// Tabs registry v1 (#391, ledger #405): the REAL browser-panel.ts holding N>1
// tabs per workspace, over a stubbed `electron` (loader hook — the same seam the
// scripts/verify-*-browser-panel*.mjs harnesses use). Every arm asserts on what
// the registry does to the window (which views are attached) and to the native
// resources (which contents are closed / debuggers detached), because a leaked
// view paints black over the app and nothing else would notice.
//
// Mutants that must redden this file: scripts/mutate-browser-panel-tabs.mjs.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const STUB = `
const views = (globalThis.__bpViews ??= []);
class WebContents {
  constructor(view) {
    this._view = view;
    this.destroyed = false; this.closed = 0; this.url = ''; this.title = '';
    this.cmds = []; this.dbgAttached = false; this.detachCalls = 0; this.loaded = [];
    this.handlers = {};
    this.dbgHandlers = {};
    this.debugger = {
      // Like Electron: a second attach throws, and detach emits 'detach'.
      attach: () => { if (this.dbgAttached) throw new Error('Another debugger is already attached to this WebContents.'); this.dbgAttached = true; this.attachCalls = (this.attachCalls || 0) + 1; },
      detach: () => { this.dbgAttached = false; this.detachCalls++; for (const f of [...(this.dbgHandlers.detach || [])]) f({}, 'client disconnected'); },
      on: (ev, fn) => { (this.dbgHandlers[ev] ||= []).push(fn); },
      off: (ev, fn) => { this.dbgHandlers[ev] = (this.dbgHandlers[ev] || []).filter((f) => f !== fn); },
      isAttached: () => this.dbgAttached,
      sendCommand: (m, p) => { this.cmds.push({ m, p }); if (this.onCmd) this.onCmd(m, p); return this.reply ? this.reply(m, p) : Promise.resolve({ result: { value: this.evalValue ?? 'ev' } }); },
    };
    this.getUserAgent = () => 'UA';
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  }
  isDestroyed() { return this.destroyed; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emitEvent(ev, ...a) { for (const f of (this.handlers[ev] || [])) f(...a); }
  once() {} setWindowOpenHandler() {}
  setBackgroundThrottling(v) { (this.throttle ??= []).push(v); }
  isLoading() { return !!this.loadingNow; }
  beginFrameSubscription(_dirty, cb) { this.subs = (this.subs ?? 0) + 1; const f = { getSize: () => ({ width: 800, height: 600 }), crop() { return this; }, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpeg') }; setTimeout(() => cb(f), 1); setTimeout(() => cb(f), 3); }
  endFrameSubscription() { this.subs = (this.subs ?? 1) - 1; }
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }
  reload() { this.reloaded = true; }
  capturePage() { return Promise.resolve({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), crop() { return this; }, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('x') }); }
  getURL() { return this.url; } getTitle() { return this.title; }
  // Real Electron closes ASYNCHRONOUSLY: with __bpAsyncClose the contents stay live until finishClose().
  close() { this.closed++; if (globalThis.__bpAsyncClose) { this.pendingClose = true; return; } this.destroyed = true; this._view.webContents = undefined; }
  finishClose() { this.destroyed = true; this._view.webContents = undefined; }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(this); this._wc = this.webContents; this.bounds = null; views.push(this); }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
  setVisible(v) { this.visible = v; }
  getBounds() { return this.bounds ?? { x: 0, y: 0, width: 800, height: 600 }; }
  killExternally() { this._wc.destroyed = true; this.webContents = undefined; }
}
export const Menu = { buildFromTemplate: () => ({ popup() {} }) };
export const clipboard = { writeText() {} };
export const shell = { openExternal() {} };
export const session = { fromPartition: () => ({ setUserAgent() {}, getUserAgent: () => 'UA' }) };
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(STUB);
const platformUrl =
  'data:text/javascript,' +
  encodeURIComponent(
    `export const platform = { broadcast(ch, wsId, state) { (globalThis.__bpEvents ??= []).push({ ch, wsId, state }); } };`,
  );
const loggerUrl =
  'data:text/javascript,' +
  encodeURIComponent(`export const log = { info(){}, warn(){}, debug(){}, error(){} };`);

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
const seat = await import('./browser-cdp-seat.ts');

// The registry attaches no debugger (#398): its CDP commands ride the proxy host's seat. The real host
// imports Electron; this stands in with the REAL `browser-cdp-seat.ts` over the stubbed debugger.
const lease = async (ws: string, tabId: string) => {
  const wc = bp.tabContents(ws, tabId) as any;
  if (!wc) throw new Error('no live view');
  seat.seatAcquire(wc);
  return { wc, release: () => seat.seatRelease(wc, 0) }; // grace 0: the registry's contract is about WHO holds the attach, the grace has its own tests
};
const testSeat: Parameters<typeof bp.setCdpSeat>[0] = {
  async send(ws, tabId, method, params) {
    const l = await lease(ws, tabId);
    try { return await l.wc.debugger.sendCommand(method, params); } finally { l.release(); }
  },
  async hold(ws, tabId) { return (await lease(ws, tabId)).release; },
};
bp.setCdpSeat(testSeat);
bp.setTabTeardownHook((wc) => seat.seatForceDetach(wc as any));

const children = new Set<unknown>(); // every view that is a CHILD of the window (visible or hidden — #406)
const attached = { // the views COMPOSITED on screen: children that are not setVisible(false)
  get size() { return [...children].filter((v) => (v as { visible?: boolean }).visible !== false).length; },
  has: (v: unknown) => children.has(v) && (v as { visible?: boolean }).visible !== false,
  add: (v: unknown) => children.add(v),
  delete: (v: unknown) => children.delete(v),
};
const uiProbe = { paints: true }; // the main renderer's requestAnimationFrame answers (a window on a DISPLAYED desktop) — false = it stalls (an undisplayed sway workspace)
bp.initBrowserPanels(() => ({
  contentView: {
    addChildView: (v: unknown) => attached.add(v),
    removeChildView: (v: unknown) => attached.delete(v),
  },
  webContents: { isDestroyed: () => false, executeJavaScript: () => (uiProbe.paints ? Promise.resolve(true) : new Promise(() => undefined)) },
}) as never);

let seq = 0;
const used: string[] = [];
const newWs = () => {
  const ws = `ws-tabs-${++seq}`;
  used.push(ws);
  return ws;
};

// Every arm ends by tearing its workspaces down; a view still attached after
// that is a leak (it would paint black over the app), so assert it here.
afterEach(() => {
  for (const ws of used.splice(0)) bp.destroyPanel(ws);
  assert.equal(children.size, 0, 'a view (visible or hidden) leaked past destroyPanel');
});
const RECT = { x: 1, y: 2, width: 640, height: 480 };
const wcOf = (tab: { view: unknown }) => (tab.view as { _wc: any })._wc;
const viewOf = (tab: { view: unknown }) => tab.view;
const events = () => (globalThis as any).__bpEvents as { ch: string; wsId: string; state: any }[];

/** Open a workspace's panel on screen (renderer-style: show, then bounds). */
function openShown(ws: string) {
  bp.showPanel(ws);
  bp.setBounds(ws, RECT);
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Records the order of throttling flips and captures on a stub view (the pin: a capture taken while throttling is OFF leaves the page unthrottled, #406 P3). */
function trace(wc: any): string[] {
  const events: string[] = [];
  wc.setBackgroundThrottling = (v: boolean) => events.push(`throttle:${v}`);
  const real = wc.capturePage.bind(wc);
  wc.capturePage = () => { events.push('capture'); return real(); };
  return events;
}

test('ensurePanel creates exactly ONE human tab, active (no user-visible change)', () => {
  const ws = newWs();
  openShown(ws);
  const tabs = bp.listTabs(ws);
  assert.deepEqual(tabs.map((t) => [t.id, t.openedBy, t.active]), [['t1', 'human', true]]);
  assert.equal(bp.getState(ws).activeTabId, 't1');
  assert.equal(attached.size, 1, 'one composited view');
});

test('createTab holds N>1 tabs in order; only the first is active unless asked', () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const t3 = bp.createTab(ws, { openedBy: 'human', url: 'http://localhost:1/x' });
  assert.deepEqual(bp.listTabs(ws).map((t) => [t.id, t.openedBy, t.active]), [
    ['t1', 'human', true],
    ['t2', 'agent', false],
    ['t3', 'human', false],
  ]);
  assert.equal(bp.getTab(ws, 't2'), t2);
  assert.equal(bp.getActiveTab(ws)?.id, 't1');
  assert.deepEqual(wcOf(t3).loaded, ['http://localhost:1/x'], 'url opens in the NEW tab');
  assert.deepEqual(wcOf(bp.getActiveTab(ws)!).loaded, [], 'and not in the active one');
  assert.equal(attached.size, 1, 'extra tabs never composit');
  assert.deepEqual(
    bp.getState(ws).tabs.map((t) => t.id),
    ['t1', 't2', 't3'],
    'the pushed state lists every tab',
  );
});

test('createTab({activate}) swaps the composited view; exactly one view attached', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent', activate: true });
  assert.equal(bp.getActiveTab(ws)?.id, 't2');
  assert.equal(attached.size, 1);
  assert.ok(attached.has(viewOf(t2)) && !attached.has(viewOf(t1)));
});

test('activateTab swaps which tab composits and the state mirrors the ACTIVE tab', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent', url: 'http://localhost:2/b' });
  wcOf(t1).url = 'http://localhost:2/a';
  const st = bp.activateTab(ws, 't2');
  assert.equal(st.activeTabId, 't2');
  assert.equal(st.url, 'http://localhost:2/b', 'top-level url mirrors the active tab');
  assert.deepEqual(st.tabs.map((t) => [t.id, t.active, t.url]), [
    ['t1', false, 'http://localhost:2/a'],
    ['t2', true, 'http://localhost:2/b'],
  ]);
  assert.equal(attached.size, 1);
  assert.ok(attached.has(viewOf(t2)) && !attached.has(viewOf(t1)), 'the old tab was detached');
  assert.deepEqual((viewOf(t2) as any).bounds, RECT, 'swapped-in tab has the panel rect');
  assert.throws(() => bp.activateTab(ws, 't99'), /not found/);
});

test('setBounds sizes EVERY tab view, so a tab activated later is already the right size', () => {
  const ws = newWs();
  const t1 = bp.ensurePanel(ws).tabs[0];
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  bp.setBounds(ws, RECT);
  assert.deepEqual((viewOf(t1) as any).bounds, RECT);
  assert.deepEqual((viewOf(t2) as any).bounds, RECT);
});

test('a state event from a BACKGROUND tab lands in tabs[] but not in the top-level mirror', () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  wcOf(t2).url = 'http://localhost:3/bg';
  wcOf(t2).title = 'bg title';
  wcOf(t2).emitEvent('did-navigate');
  const st = bp.getState(ws);
  assert.equal(st.url, '', 'active tab (t1) url unchanged');
  assert.deepEqual(st.tabs.find((t) => t.id === 't2'), {
    id: 't2', url: 'http://localhost:3/bg', title: 'bg title', loading: false, active: false, openedBy: 'agent',
  });
  assert.ok(events().some((e) => e.wsId === ws && e.state.tabs.length === 2), 'and it was broadcast');
});

test('closeTab: closing the ACTIVE tab promotes a neighbour and swaps the composited view', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent', activate: true });
  const t3 = bp.createTab(ws, { openedBy: 'agent' });
  const st = bp.closeTab(ws, 't2');
  assert.equal(st.activeTabId, 't3', 'right neighbour becomes active');
  assert.deepEqual(bp.listTabs(ws).map((t) => t.id), ['t1', 't3']);
  assert.equal(wcOf(t2).closed, 1, 'closed tab contents destroyed');
  assert.equal(attached.size, 1);
  assert.ok(attached.has(viewOf(t3)) && !attached.has(viewOf(t2)) && !attached.has(viewOf(t1)));
  assert.throws(() => bp.closeTab(ws, 't2'), /not found/);
});

test('closeTab on a background tab leaves the active tab and the window alone, drops its debugger', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.designModeArm(ws, 't2'); // design mode keeps t2's debugger attached while armed
  assert.equal(wcOf(t2).dbgAttached, true);
  bp.closeTab(ws, 't2');
  assert.equal(wcOf(t2).detachCalls, 1, 'debugger detached before the contents closed');
  assert.equal(wcOf(t2).closed, 1);
  assert.equal(bp.getActiveTab(ws)?.id, 't1');
  assert.ok(attached.has(viewOf(t1)));
  assert.equal(wcOf(t1).closed, 0, 'the active tab was not touched');
});

test('closing the LAST tab evicts the panel and destroys it (rebuilt by the next ensurePanel)', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const st = bp.closeTab(ws, 't1');
  assert.deepEqual([st.tabs, st.activeTabId], [[], '']);
  assert.equal(bp.getPanel(ws), undefined);
  assert.deepEqual(bp.listTabs(ws), []);
  assert.equal(wcOf(t1).closed, 1);
  assert.equal(attached.size, 0);
});

test('tab ids are never reused: not after a close, not after the panel is evicted and rebuilt', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' }); // t2
  bp.closeTab(ws, 't2');
  const t3 = bp.createTab(ws, { openedBy: 'agent' });
  assert.equal(t3.id, 't3', 'a closed id is not handed out again');
  for (const t of bp.listTabs(ws)) (bp.getTab(ws, t.id)!.view as any).killExternally();
  assert.equal(bp.getPanel(ws), undefined, 'every tab died: panel evicted');
  const fresh = bp.ensurePanel(ws).tabs[0];
  assert.equal(fresh.id, 't4', 'a rebuilt panel continues the numbering');
});

test('destroyPanel tears down EVERY tab: contents closed, debuggers detached, nothing attached', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const t3 = bp.createTab(ws, { openedBy: 'human' });
  await bp.designModeArm(ws, 't1');
  await bp.designModeArm(ws, 't2');
  await bp.designModeArm(ws, 't3');
  for (const t of [t1, t2, t3]) assert.equal(wcOf(t).dbgAttached, true, `${t.id} armed: debugger held`);
  bp.destroyPanel(ws);
  for (const t of [t1, t2, t3]) {
    assert.equal(wcOf(t).closed, 1, `${t.id} contents closed`);
    assert.equal(wcOf(t).detachCalls, 1, `${t.id} debugger detached`);
  }
  assert.equal(attached.size, 0);
  assert.equal(bp.getPanel(ws), undefined);
});

test('dead-view reaping is per tab: a dead background tab is dropped, the rest survive', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const t3 = bp.createTab(ws, { openedBy: 'agent' });
  (viewOf(t2) as any).killExternally();
  bp.setBounds(ws, RECT); // any registry call reaps
  assert.deepEqual(bp.listTabs(ws).map((t) => t.id), ['t1', 't3']);
  assert.equal(bp.getActiveTab(ws)?.id, 't1');
  assert.ok(attached.has(viewOf(t1)) && attached.size === 1);
  assert.ok(bp.getTab(ws, 't3') === t3);
});

test('dead-view reaping: a dead ACTIVE tab is detached and a neighbour takes over the window', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  (viewOf(t1) as any).killExternally();
  bp.setBounds(ws, RECT);
  assert.equal(bp.getActiveTab(ws)?.id, 't2');
  assert.ok(!attached.has(viewOf(t1)), 'the husk is detached');
  assert.ok(attached.has(viewOf(t2)) && attached.size === 1, 'the surviving tab composits');
});

test('dead-view reaping: when EVERY tab died the panel is evicted and detached', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  (viewOf(t1) as any).killExternally();
  (viewOf(t2) as any).killExternally();
  bp.setBounds(ws, RECT);
  assert.equal(bp.getPanel(ws), undefined);
  assert.equal(attached.size, 0);
});

test('only the ACTIVE tab of the FOCUSED workspace composits (two workspaces x two tabs)', () => {
  const a = newWs();
  const b = newWs();
  openShown(a);
  bp.createTab(a, { openedBy: 'agent', activate: true });
  openShown(b);
  const b2 = bp.createTab(b, { openedBy: 'agent', activate: true });
  assert.equal(attached.size, 1, 'showing B hid A (all of A\'s tabs)');
  assert.ok(attached.has(viewOf(b2)));
  // An agent reveal for the background workspace attaches nothing.
  bp.revealForAgent(a);
  assert.equal(attached.size, 1);
  assert.ok(attached.has(viewOf(b2)));
});

test('hide / re-show keeps the active tab; a tab activated while hidden shows on re-show', () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  bp.hidePanel(ws);
  assert.equal(attached.size, 0);
  bp.activateTab(ws, 't2'); // hidden: must not composit
  assert.equal(attached.size, 0, 'activating a tab of a hidden panel attaches nothing');
  bp.showPanel(ws);
  assert.ok(attached.has(viewOf(t2)) && attached.size === 1);
});

test('primitives hit the ACTIVE tab by default and the named tab with a trailing tabId', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.evaluate(ws, 'A');
  await bp.evaluate(ws, 'B', 't2');
  const evals = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Runtime.evaluate').map((c: any) => c.p.expression);
  assert.deepEqual(evals(t1), ['A']);
  assert.deepEqual(evals(t2), ['B']);
  bp.activateTab(ws, 't2');
  await bp.evaluate(ws, 'C');
  assert.deepEqual(evals(t2), ['B', 'C'], 'default follows the active tab');
  await assert.rejects(() => bp.evaluate(ws, 'D', 't99'), /not found/);
  assert.equal(wcOf(t1).dbgAttached, false, 'a one-shot command leaves no debugger behind (lease released)');
});

test('capture / input on a BACKGROUND tab are DRIVEN IN PLACE under a throttling lease (#406): nothing is refused or brought to the front', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' }); // never shown: detached, no first frame yet — surfaced under the visible tab 1, then hidden
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0, 'a background tab answers a screenshot');
  await bp.clickAt(ws, 1, 1, 't2');
  await bp.typeText(ws, 'x', 't2');
  await bp.scrollBy(ws, 5, 't2');
  assert.equal(bp.getActiveTab(ws)!.id, 't1', 'the human\'s tab never changed');
  assert.equal(attached.size, 1, 'and only the human\'s tab is composited (t2 is hidden)');
  assert.equal(viewOf(bp.getTab(ws, 't2')!).visible, false);
  const throttle = wcOf(bp.getTab(ws, 't2')!).throttle as boolean[];
  assert.equal(throttle[0], false, 'throttling went OFF for the action');
  await new Promise((r) => setTimeout(r, 1300)); // LINGER_MS 600 + the sweep
  assert.equal(throttle[throttle.length - 1], true, 'and back ON after the last action (P3/P7)');
  assert.ok((await bp.capture(ws, 75, 't1')).length > 0, 'the active tab still captures');
});

test('navigate / reload honour tabId and default to the active tab', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.navigate(ws, 'http://localhost:9/one');
  await bp.navigate(ws, 'http://localhost:9/two', 't2');
  assert.deepEqual(wcOf(t1).loaded, ['http://localhost:9/one']);
  assert.deepEqual(wcOf(t2).loaded, ['http://localhost:9/two']);
  bp.reload(ws, 't2');
  assert.equal(wcOf(t2).reloaded, true);
  assert.equal(wcOf(t1).reloaded, undefined);
});

test('clickAt pins ONE tab: press and release land on the same tab even if the active tab changes mid-click', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  let switched = false;
  wcOf(t1).onCmd = (m: string) => {
    if (m === 'Input.dispatchMouseEvent' && !switched) { switched = true; bp.activateTab(ws, 't2'); }
  };
  await bp.clickAt(ws, 3, 4);
  const mouse = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Input.dispatchMouseEvent').map((c: any) => c.p.type);
  assert.equal(switched, true, 'setup: the active tab changed between press and release');
  assert.deepEqual(mouse(t1), ['mousePressed', 'mouseReleased'], 'both halves of the click hit the tab the click started on');
  assert.deepEqual(mouse(t2), [], 'nothing leaked to the tab that became active');
});

test('getState reaps: a dead tab is not listed to a freshly mounted renderer', () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  (viewOf(t2) as any).killExternally();
  assert.deepEqual(bp.getState(ws).tabs.map((t) => t.id), ['t1']);
});

test('a held Panel keeps a readable view after its LAST tab is closed (no TypeError on the husk)', () => {
  const ws = newWs();
  openShown(ws);
  const panel = bp.getPanel(ws)!;
  const t1 = bp.getActiveTab(ws)!;
  bp.closeTab(ws, 't1');
  assert.doesNotThrow(() => panel.view);
  assert.equal(panel.view, viewOf(t1));
});

// ── follow-up (#391-fu): ghost state, explicit-tabId resurrection, reaping on every read, pinned multi-step ──

test('a late did-* event from a closed LAST tab / destroyed panel publishes no ghost state', () => {
  (globalThis as any).__bpAsyncClose = true; // the old contents outlive closeTab for a moment, like real Electron
  try {
    const ws = newWs();
    openShown(ws);
    const old = bp.getActiveTab(ws)!;
    bp.closeTab(ws, 't1'); // last tab: panel evicted, old contents still live
    const rebuilt = bp.ensurePanel(ws); // a fresh panel for the same workspace
    const n = events().length;
    wcOf(old).emitEvent('did-stop-loading');
    assert.equal(events().length, n, 'no broadcast from the evicted panel (it would show t1 over the live one)');
    assert.equal(rebuilt.tabs.length, 1, 'setup: the rebuilt panel is the live one');
    const ws2 = newWs();
    openShown(ws2);
    const t = bp.getActiveTab(ws2)!;
    bp.destroyPanel(ws2);
    const m = events().length;
    wcOf(t).emitEvent('did-navigate');
    assert.equal(events().length, m, 'no ghost state for a deleted workspace');
  } finally {
    (globalThis as any).__bpAsyncClose = false;
  }
});

test('an explicit tabId that no longer exists fails WITHOUT building a panel (closeTab-last, destroyPanel)', async () => {
  const views = () => (globalThis as any).__bpViews.length as number;
  const ws = newWs();
  openShown(ws);
  bp.closeTab(ws, 't1');
  const before = views();
  await assert.rejects(() => bp.evaluate(ws, '1', 't1'), /not found/);
  await assert.rejects(() => bp.navigate(ws, 'http://localhost:9/x', 't1'), /not found/);
  await assert.rejects(() => bp.designModeArm(ws, 't1'), /not found/);
  assert.equal(bp.getPanel(ws), undefined, 'no panel resurrected');
  assert.equal(views(), before, 'no native view built');
  const ws2 = newWs();
  openShown(ws2);
  bp.destroyPanel(ws2);
  const before2 = views();
  await assert.rejects(() => bp.evaluate(ws2, '1', 't1'), /not found/);
  assert.equal(bp.getPanel(ws2), undefined);
  assert.equal(views(), before2);
  // control: the DEFAULT (no tabId) form still opens the panel on demand, as before
  const ws3 = newWs();
  const b3 = views();
  await bp.evaluate(ws3, '1');
  assert.ok(bp.getPanel(ws3) && views() === b3 + 1, 'default evaluate builds the panel');
  const ws4 = newWs();
  await bp.navigate(ws4, 'http://localhost:9/y');
  assert.ok(bp.getPanel(ws4), 'default navigate builds the panel');
});

test('listTabs / getTab / getActiveTab reap a dead tab themselves (no stale list for the CDP target list)', () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  (viewOf(t2) as any).killExternally();
  assert.deepEqual(bp.listTabs(ws).map((t) => t.id), ['t1']);
  const ws2 = newWs();
  openShown(ws2);
  const u2 = bp.createTab(ws2, { openedBy: 'agent' });
  (viewOf(u2) as any).killExternally();
  assert.equal(bp.getTab(ws2, 't2'), undefined, 'a dead tab is not returned by getTab');
  const ws3 = newWs();
  openShown(ws3);
  const v1 = bp.getActiveTab(ws3)!;
  bp.createTab(ws3, { openedBy: 'agent' });
  (viewOf(v1) as any).killExternally();
  assert.equal(bp.getActiveTab(ws3)?.id, 't2', 'a dead active tab is not returned by getActiveTab');
});

test('reaping a dead ACTIVE tab promotes its right neighbour, else the left one (not always the first)', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  const t3 = bp.createTab(ws, { openedBy: 'agent' });
  bp.activateTab(ws, 't2');
  (viewOf(bp.getTab(ws, 't2')!) as any).killExternally();
  assert.equal(bp.getActiveTab(ws)?.id, 't3', 'middle tab died: the one that slid into its slot (t3), not t1');
  assert.ok(attached.has(viewOf(t3)) && attached.size === 1);
  bp.activateTab(ws, 't3');
  (viewOf(t3) as any).killExternally();
  assert.equal(bp.getActiveTab(ws)?.id, 't1', 'last tab died: the left neighbour');
});

test('reaping the dead LAST of 3 tabs promotes its left neighbour (t2), not the first tab (t1)', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  const t3 = bp.createTab(ws, { openedBy: 'agent', activate: true });
  (viewOf(t3) as any).killExternally();
  assert.equal(bp.getActiveTab(ws)?.id, 't2');
});

test('clickRef pins ONE tab: a tab switch between resolving the ref and clicking never lands on the new tab — the pinned tab is brought back (#397) and gets the whole click', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  wcOf(t1).evalValue = { x: 5, y: 6 };
  wcOf(t1).onCmd = (m: string) => { if (m === 'Runtime.evaluate') bp.activateTab(ws, 't2'); };
  await bp.clickRef(ws, 1); // #397: a click needs its tab on screen, so the pinned tab (focused workspace) is brought back before the click
  const mouse = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse(t2), [], 'nothing was clicked on the tab that became active');
  assert.deepEqual(mouse(t1).map((c: any) => c.p.type), ['mousePressed', 'mouseReleased'], 'the pinned tab received the WHOLE click (press and release), not half of it');
  assert.equal(bp.getActiveTab(ws)?.id, 't1', 'and it is the tab on screen again');
});

test('clickRef in a BACKGROUND workspace is driven in place (#406): the click lands, nothing is brought to the front, no view stays composited for it', async () => {
  const fg = newWs();
  const ws = newWs();
  openShown(fg);
  const t1 = bp.ensurePanel(ws).tabs[0]!; // a panel nobody looks at
  wcOf(t1).evalValue = { x: 5, y: 6 };
  await bp.clickRef(ws, 1);
  assert.ok(wcOf(t1).cmds.some((c: any) => c.m === 'Input.dispatchMouseEvent'), 'the click was dispatched');
  assert.equal(attached.has(viewOf(t1)), false, 'and no view is composited for it (hidden under the focused tab)');
  assert.equal(bp.isFocusedWorkspace(fg), true, 'the focused workspace is untouched');
});

test('a tab hidden while its page is STILL LOADING is taken out of the window — even when it was shown long ago — and a settled one stays attached-hidden (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent', activate: true }); // t2 on screen …
  (t2 as any).shownAt = 0; (t2 as any).stoppedAt = 0; // … long ago, so only `isLoading()` can decide below
  wcOf(t2).loadingNow = true; // … its document loading again …
  bp.activateTab(ws, 't1'); // … and the human switches back before it paints
  assert.equal(children.has(viewOf(t2)), false, 'a loading document is NOT left attached-hidden');
  wcOf(t2).loadingNow = false;
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0, 'the next agent action surfaces it under the visible tab and answers');
  assert.equal(children.has(viewOf(t2)) && viewOf(t2).visible === false, true, 'and leaves it attached + hidden');
  // a tab that settled long ago is simply hidden, not removed (only the loading clause could have removed the first one)
  const t3 = bp.createTab(ws, { openedBy: 'agent', activate: true });
  (t3 as any).shownAt = 0; (t3 as any).stoppedAt = 0;
  bp.activateTab(ws, 't1');
  assert.equal(children.has(viewOf(t3)) && viewOf(t3).visible === false, true, 'a settled tab stays attached + hidden');
  // and one shown a moment ago (no first paint yet) is removed even though it is not loading
  const t4 = bp.createTab(ws, { openedBy: 'agent', activate: true });
  bp.activateTab(ws, 't1');
  assert.equal(children.has(viewOf(t4)), false, 'a tab hidden within FIRST_PAINT_MS of being shown is removed');
});

test('a hidden tab that starts a main-frame navigation is detached so the new document loads detached (born hidden = dead), and is surfaced on the next action (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2'); // surfaced once: attached + hidden
  await nap(900);
  assert.equal(children.has(viewOf(t2)), true);
  const handlers = (wcOf(t2).handlers ?? {}) as Record<string, Array<(...a: unknown[]) => void>>;
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: true });
  assert.equal(children.has(viewOf(t2)), true, 'a same-document navigation (pushState / hash) never detaches');
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: false, isSameDocument: false });
  assert.equal(children.has(viewOf(t2)), true, 'a sub-frame navigation never detaches');
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: false });
  assert.equal(children.has(viewOf(t2)), false, 'a main-frame navigation took the hidden view out of the window');
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0, 'surfaced again on the next action');
});

test('a lease on a hidden tab flips throttling OFF around the action, and its end flips it back ON and THEN takes one discarded capture that unpins the page (#406 P3)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2'); // surfaced once: attached + hidden + composited
  await nap(900); // that first lease's linger is over
  const events = trace(wcOf(t2));
  const lease = await bp.beginAgentAction(ws, 't2', 'input');
  assert.deepEqual(events, ['throttle:false', 'capture'], 'throttling off, then the wake capture of a possibly evicted hidden frame');
  lease.end();
  await nap(900);
  assert.deepEqual(events, ['throttle:false', 'capture', 'throttle:true', 'capture'], 'flip back FIRST, then the unpin capture — the other order would pin the page unthrottled again');
});

test('EVERY hidden screenshot primes (shows the page) and then waits for the renderer\'s next paint — the SECOND subscription frame, the first being the refresh of the old surface — and always ends its subscription (#406 P1)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2'); // surfaces the tab
  await nap(1700); // past the 1500 ms "just surfaced" window (a surfaced tab needs no prime)
  const wc = wcOf(t2);
  const frame = { getSize: () => ({ width: 800, height: 600 }), crop() { return this; }, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpeg') };
  let cb: ((f: unknown) => void) | null = null;
  wc.beginFrameSubscription = (_d: boolean, f: (x: unknown) => void) => { wc.subs = (wc.subs ?? 0) + 1; cb = f; };
  let done = false;
  const shot = bp.capture(ws, 75, 't2').then((r) => { done = true; return r; });
  await nap(80);
  assert.equal(done, false, 'still waiting: no frame has arrived');
  cb!(frame);
  await nap(40);
  assert.equal(done, false, 'the FIRST frame is the refresh of the old surface: not enough');
  cb!(frame);
  assert.ok((await shot).length > 0);
  assert.equal(wc.subs, 0, 'its subscription is ended');
  // and a SECOND screenshot inside the linger primes and waits again (a change made since the first one is as stale-prone)
  let again = false;
  const shot2 = bp.capture(ws, 75, 't2').then((r) => { again = true; return r; });
  await nap(80);
  assert.equal(again, false, 'the second screenshot waits for its own paint');
  cb!(frame); cb!(frame);
  assert.ok((await shot2).length > 0);
  await nap(900);
});

test('the next-paint wait is bounded: a page that paints nothing new releases the screenshot after FRESH_FRAME_MS and the subscription is ended (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2'); // surfaces the tab
  await nap(1700); // past the 1500 ms "just surfaced" window (a surfaced tab needs no prime)
  const wc = wcOf(t2);
  wc.beginFrameSubscription = () => { wc.subs = (wc.subs ?? 0) + 1; };
  const t0 = Date.now();
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0);
  const waited = Date.now() - t0;
  assert.ok(waited >= 150 && waited < 700, `bounded wait, got ${waited} ms`);
  assert.equal(wc.subs, 0);
  await nap(900);
});

test('a tab surfaced by THIS action needs no prime: its frame was just painted under the cover, so the screenshot does not wait for another paint (P6 stays under 2 s)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const wc = wcOf(t2);
  const frame = { getSize: () => ({ width: 800, height: 600 }), crop() { return this; }, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpeg') };
  wc.beginCalls = 0;
  wc.beginFrameSubscription = (_d: boolean, f: (x: unknown) => void) => { wc.beginCalls += 1; setTimeout(() => f(frame), 1); setTimeout(() => f(frame), 3); };
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0);
  assert.equal(wc.beginCalls, 0, 'no frame subscription at all: the pulse polls capturePage, and there is no prime + next-paint wait on top');
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0); // a SECOND screenshot right away: the mark was single-use
  assert.equal(wc.beginCalls, 1, 'the second screenshot primes and waits for its own paint, though it is inside the 1.5 s window');
  await nap(900);
});

test('a lease for evaluate (no frame needed) flips throttling and takes NO capture, so nothing to unpin (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(900);
  const events = trace(wcOf(t2));
  (await bp.beginAgentAction(ws, 't2', 'other')).end();
  await nap(900);
  assert.deepEqual(events, ['throttle:false', 'throttle:true']);
});

test('a navigation under a LEASE ends the lease: removing the view flips throttling back ON (P7 — a forgotten lease would leave the page unthrottled for good)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const events = trace(wcOf(t2));
  const lease = await bp.beginAgentAction(ws, 't2', 'other'); // e.g. the agent's Page.navigate / a click on a link
  assert.deepEqual(events, ['throttle:false']);
  const handlers = (wcOf(t2).handlers ?? {}) as Record<string, Array<(...a: unknown[]) => void>>;
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: false });
  assert.deepEqual(events, ['throttle:false', 'throttle:true'], 'the lease died with the view: throttling is back ON at once');
  lease.end();
  await nap(900);
  assert.deepEqual(events, ['throttle:false', 'throttle:true'], 'and the later sweep finds nothing to flip again');
});

test('a screenshot right after a navigation (the document is still loading) waits for the load before hiding the surfaced tab again, and answers (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const handlers = (wcOf(t2).handlers ?? {}) as Record<string, Array<(...a: unknown[]) => void>>;
  wcOf(t2).loadingNow = true;
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: false }); // detached, loading
  setTimeout(() => { wcOf(t2).loadingNow = false; (t2 as any).stoppedAt = Date.now(); }, 700); // the load ends mid-pulse
  const shot = await bp.capture(ws, 75, 't2');
  assert.ok(shot.length > 0, 'answered');
  assert.equal(children.has(viewOf(t2)) && viewOf(t2).visible === false, true, 'and the tab is attached + hidden again, not removed while loading');
  await nap(900);
});

test('an action that arrives during another action\'s surface pulse waits for it (the tab reads visible meanwhile) instead of deciding `direct` (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const handlers = (wcOf(t2).handlers ?? {}) as Record<string, Array<(...a: unknown[]) => void>>;
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: false }); // never composited → the next action pulses
  const first = bp.capture(ws, 75, 't2');
  await nap(120);
  const t0 = Date.now();
  const lease = await bp.beginAgentAction(ws, 't2', 'input');
  const waited = Date.now() - t0;
  assert.ok(waited >= 250, `the second action waited for the pulse to finish (${waited} ms)`);
  assert.equal(viewOf(t2).visible, false, 'the pulse is over when it proceeds');
  lease.end();
  await first;
  await nap(900);
});

test('two screenshots of one hidden tab never overlap (Electron has ONE frame subscriber per contents) (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const wc = wcOf(t2);
  let live = 0, peak = 0;
  const frame = { getSize: () => ({ width: 800, height: 600 }), crop() { return this; }, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpeg') };
  wc.beginFrameSubscription = (_d: boolean, f: (x: unknown) => void) => { live++; peak = Math.max(peak, live); setTimeout(() => f(frame), 5); setTimeout(() => f(frame), 15); };
  wc.endFrameSubscription = () => { live--; };
  await Promise.all([bp.capture(ws, 75, 't2'), bp.capture(ws, 75, 't2')]);
  assert.equal(peak, 1, `never two live frame subscriptions on one contents (peak ${peak})`);
  await nap(900);
});

test('the unpin capture is owed again by a lease taken WHILE it runs (a capture under the flip pins the page) (#406 P3)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const wc = wcOf(t2);
  const events: string[] = [];
  wc.setBackgroundThrottling = (v: boolean) => events.push(`throttle:${v}`);
  const real = wc.capturePage.bind(wc);
  let slowNext = false;
  wc.capturePage = () => { events.push('capture'); if (!slowNext) return real(); slowNext = false; return new Promise((r) => setTimeout(() => r(real()), 400)); };
  const l1 = await bp.beginAgentAction(ws, 't2', 'input'); // flip + wake capture
  l1.end();
  slowNext = true; // the unpin capture the sweep takes in ~600 ms will be slow
  await nap(800); // sweep fired: throttle:true + the slow unpin capture is running
  const l2 = await bp.beginAgentAction(ws, 't2', 'other'); // a new lease while that capture runs: flips OFF under it
  l2.end();
  await nap(1800);
  assert.deepEqual(events, ['throttle:false', 'capture', 'throttle:true', 'capture', 'throttle:false', 'throttle:true', 'capture'], 'the second lease owes its own unpin capture after its flip-back');
});

test('F1 (a) an action on a window that paints NOTHING is refused fast — before any capture, pulse or flip — and evaluate still works (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const events = trace(wcOf(t2));
  uiProbe.paints = false;
  try {
    const t0 = Date.now();
    await assert.rejects(() => bp.beginAgentAction(ws, 't2', 'input'), /desktop workspace that is not displayed/);
    assert.ok(Date.now() - t0 < 600, `refused fast (${Date.now() - t0} ms)`);
    await assert.rejects(() => bp.capture(ws, 75, 't2'), /not displayed/);
    assert.deepEqual(events, [], 'nothing was flipped and no capture was started (a capture on a window that paints nothing hangs and pins the page)');
    (await bp.beginAgentAction(ws, 't2', 'other')).end(); // evaluate / navigate need no frame: allowed
    await nap(900);
    assert.deepEqual(events, ['throttle:false', 'throttle:true']);
  } finally {
    uiProbe.paints = true;
    await nap(800); // the verdict is cached for PAINT_VERDICT_TTL_MS: do not leak a "stalled" verdict into the next test
  }
});

test('F1 (b) a wake capture that never finishes proves the window paints nothing: the next action is refused at once, without asking or capturing (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const wc = wcOf(t2);
  let captures = 0;
  wc.capturePage = () => { captures++; return new Promise(() => undefined); }; // the window stopped painting after the probe said yes
  const lease = await bp.beginAgentAction(ws, 't2', 'input'); // the wake is bounded (WAKE_MS), the action goes on
  lease.end();
  assert.equal(captures, 1);
  const t0 = Date.now();
  await assert.rejects(() => bp.beginAgentAction(ws, 't2', 'input'), /not displayed/);
  assert.ok(Date.now() - t0 < 100, 'refused from the stall verdict, without another probe');
  assert.equal(captures, 1, 'and without another capture');
  await nap(900);
});

for (const settled of [true, false]) {
  test(`F2 the cover leaves the screen MID-PULSE (the Browser pane is closed; the cover was shown ${settled ? 'long ago → hideView' : 'a moment ago → removeView'}): the pulsing view is hidden in the same tick, the action fails with the true cause, nothing stays composited (#406 P4)`, async () => {
    const ws = newWs();
    openShown(ws);
    if (settled) { (bp.getActiveTab(ws) as any).shownAt = 0; (bp.getActiveTab(ws) as any).stoppedAt = 0; }
    const t2 = bp.createTab(ws, { openedBy: 'agent' }); // never composited → the screenshot pulses it under the visible tab
    const shot = bp.capture(ws, 75, 't2').then(() => 'resolved', (e: Error) => e.message);
    await nap(150);
    assert.equal(viewOf(t2).visible, true, 'mid-pulse the view is composited (under the cover)');
    bp.hidePanel(ws); // the human closes the pane
    assert.equal(viewOf(t2).visible, false, 'hidden in the SAME tick the cover is hidden — it never shows in the vacated pane');
    const msg = await shot;
    assert.match(msg, /Browser pane was closed .* first frame/);
    assert.equal(children.has(viewOf(t2)), false, 'and it was taken out of the window');
  });
}

test('F2 the cover TAB is closed mid-pulse (removeView path): the pulsing view is hidden in the same tick (#406 P4)', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' }); // t2: becomes the closed cover's neighbour
  const t3 = bp.createTab(ws, { openedBy: 'agent' }); // t3: never composited → pulses under t1
  const shot = bp.capture(ws, 75, 't3').then(() => 'resolved', (e: Error) => e.message);
  await nap(150);
  assert.equal(viewOf(t3).visible, true, 'mid-pulse the view is composited (under the cover)');
  bp.closeTab(ws, 't1'); // the human closes the tab that was hiding it
  assert.equal(viewOf(t3).visible, false, 'hidden in the SAME tick the cover tab is removed');
  assert.match(await shot, /Browser pane was closed .* first frame/);
  assert.equal(children.has(viewOf(t3)), false);
});

test('F5 (a) a human who activates the pulsing tab mid-pulse keeps it: it is not hidden, removed or refused (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  const shot = bp.capture(ws, 75, 't2');
  await nap(150);
  bp.activateTab(ws, 't2'); // the old cover (t1) leaves, t2 is the pane's visible tab now
  assert.ok((await shot).length > 0, 'the action proceeds on the now-visible tab');
  assert.equal(bp.getActiveTab(ws)?.id, 't2');
  assert.equal(viewOf(t2).visible, true, 'still on screen');
  assert.equal(children.has(viewOf(t2)), true);
});

test('F3 a screenshot of a tab whose load takes longer than the old 1.5 s bound waits for it and answers (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  await bp.capture(ws, 75, 't2');
  await nap(1700);
  const handlers = (wcOf(t2).handlers ?? {}) as Record<string, Array<(...a: unknown[]) => void>>;
  wcOf(t2).loadingNow = true;
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: false });
  setTimeout(() => { wcOf(t2).loadingNow = false; (t2 as any).stoppedAt = Date.now(); }, 2500);
  const shot = await bp.capture(ws, 75, 't2');
  assert.ok(shot.length > 0, 'answered once the load settled');
  assert.equal(children.has(viewOf(t2)) && viewOf(t2).visible === false, true, 'attached + hidden afterwards');
  await nap(900);
});

test('F3 a page that NEVER finishes loading is refused with the TRUE cause, and its still-loading view is not left in the window (#406)', async () => {
  const ws = newWs();
  openShown(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  wcOf(t2).loadingNow = true; // never settles
  const t0 = Date.now();
  await assert.rejects(() => bp.capture(ws, 75, 't2'), /still loading/);
  assert.ok(Date.now() - t0 < 7500, `bounded (${Date.now() - t0} ms)`);
  assert.equal(children.has(viewOf(t2)), false, 'a loading view is never left attached (hidden or not)');
});

test('F5 (b) a main-frame navigation of the VISIBLE tab never takes its view out of the window (#406)', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const handlers = (wcOf(t1).handlers ?? {}) as Record<string, Array<(...a: unknown[]) => void>>;
  for (const h of handlers['did-start-navigation'] ?? []) h({ isMainFrame: true, isSameDocument: false });
  assert.equal(children.has(viewOf(t1)) && viewOf(t1).visible === true, true, 'the human\'s tab stays on screen through a navigation');
});

test('with NOTHING on screen to hide a first-paint pulse under, a never-composited tab refuses a screenshot FAST with a clear error (P6)', async () => {
  const ws = newWs(); // no focused workspace, no visible tab
  const t1 = bp.ensurePanel(ws).tabs[0]!;
  const t0 = Date.now();
  await assert.rejects(() => bp.capture(ws, 75, t1.id), /not been on screen since its page loaded/);
  assert.ok(Date.now() - t0 < 500, 'fast');
});

test('designModePoll pins ONE tab: the element screenshot comes from the tab the pick was read on', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  wcOf(t1).evalValue = { url: 'u', title: 't', chain: [], outerHTML: '<b/>', computed: {}, box: { x: 1, y: 1, width: 10, height: 10 }, viewport: { width: 100, height: 100 } };
  wcOf(t1).onCmd = (m: string) => { if (m === 'Runtime.evaluate') bp.activateTab(ws, 't2'); };
  const pick = await bp.designModePoll(ws);
  assert.ok(pick && !('cancelled' in pick), 'a pick was shaped');
  const shots = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Page.captureScreenshot').length;
  assert.equal(shots(t1), 1, 'the screenshot was taken on the tab that held the pick');
  assert.equal(shots(t2), 0, 'and not on the tab that became active meanwhile');
});

// ── explicit tabId NEVER builds a panel: every one of the 15 entry points, three stale situations ──

const ENTRY_POINTS: Record<string, (ws: string) => unknown> = {
  navigate: (ws) => bp.navigate(ws, 'http://localhost:9/x', 't1'),
  goBack: (ws) => bp.goBack(ws, 't1'),
  goForward: (ws) => bp.goForward(ws, 't1'),
  reload: (ws) => bp.reload(ws, 't1'),
  capture: (ws) => bp.capture(ws, 75, 't1'),
  evaluate: (ws) => bp.evaluate(ws, '1', 't1'),
  readPage: (ws) => bp.readPage(ws, 't1'),
  clickAt: (ws) => bp.clickAt(ws, 1, 1, 't1'),
  clickRef: (ws) => bp.clickRef(ws, 1, 't1'),
  typeText: (ws) => bp.typeText(ws, 'x', 't1'),
  formInput: (ws) => bp.formInput(ws, 1, 'v', 't1'),
  scrollBy: (ws) => bp.scrollBy(ws, 5, 't1'),
  designModeArm: (ws) => bp.designModeArm(ws, 't1'),
  designModePoll: (ws) => bp.designModePoll(ws, 't1'),
  designModeDisarm: (ws) => bp.designModeDisarm(ws, 't1'), // swallows "page gone" BY DESIGN: must still not build a panel
};
const SWALLOWS = new Set(['designModeDisarm']);

test('the arm list covers EVERY exported function that takes a trailing tabId (a new entry point needs an arm)', () => {
  const src = readFileSync(new URL('./browser-panel.ts', import.meta.url), 'utf8');
  const found = [...src.matchAll(/export (?:async )?function (\w+)\(([^)]*)\)/g)]
    .filter((m) => /tabId\?: BrowserTabId/.test(m[2]))
    .map((m) => m[1]);
  assert.equal(found.length, 15, `expected 15 explicit-tabId entry points (attachDebugger is gone: #398 — the proxy is the only attacher), found ${found.length}: ${found}`);
  assert.deepEqual(found.sort(), Object.keys(ENTRY_POINTS).sort());
});

const STALE: Record<string, (ws: string) => void> = {
  'after closeTab(last)': (ws) => { openShown(ws); bp.closeTab(ws, 't1'); },
  'after destroyPanel': (ws) => { openShown(ws); bp.destroyPanel(ws); },
  'on a workspace that never opened a panel': () => {},
};
for (const [situation, setup] of Object.entries(STALE)) {
  for (const [name, call] of Object.entries(ENTRY_POINTS)) {
    test(`explicit tabId ${situation}: ${name} fails "not found" and builds no panel / native view`, async () => {
      const ws = newWs();
      setup(ws);
      const views = (globalThis as any).__bpViews.length as number;
      if (SWALLOWS.has(name)) await call(ws);
      else await assert.rejects(async () => { await call(ws); }, /not found/);
      assert.equal(bp.getPanel(ws), undefined, `${name} resurrected a panel`);
      assert.equal((globalThis as any).__bpViews.length, views, `${name} built a native view`);
    });
  }
}
// ── design mode rides the proxy's attach (#398) ─────────────────────────────

const RAW_PICK = {
  url: 'http://localhost:9/p', title: 'P', chain: [{ tag: 'BODY', classes: [], nthOfType: 1 }, { tag: 'BUTTON', id: 'go', classes: [], nthOfType: 1 }],
  outerHTML: '<button id="go">Go</button>', computed: { color: 'red' }, box: { x: 10, y: 10, width: 50, height: 20 }, viewport: { width: 800, height: 600 },
};

test('design mode: arm takes ONE attach and the polling does not churn it; a pick delivers the shaped pick + screenshot, then detaches', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws);
  assert.deepEqual([wcOf(t1).attachCalls, wcOf(t1).dbgAttached], [1, true], 'armed: attached by the seat');
  wcOf(t1).reply = () => Promise.resolve({ result: { value: null } }); // nothing picked yet
  for (let i = 0; i < 5; i++) assert.equal(await bp.designModePoll(ws), null);
  assert.equal(wcOf(t1).attachCalls, 1, '5 polls reused the held attach');
  assert.equal(wcOf(t1).detachCalls, 0);
  wcOf(t1).reply = (m: string) => Promise.resolve(m === 'Page.captureScreenshot' ? { data: 'PNGDATA' } : { result: { value: RAW_PICK } });
  const pick: any = await bp.designModePoll(ws);
  assert.equal(pick.selector, 'body > button#go');
  assert.equal(pick.html, '<button id="go">Go</button>');
  assert.equal(pick.styles.color, 'red');
  assert.equal(pick.screenshotBase64, 'PNGDATA', 'the cropped element screenshot is delivered');
  assert.ok(wcOf(t1).cmds.some((c: any) => c.m === 'Page.captureScreenshot' && c.p.clip));
  assert.deepEqual([wcOf(t1).attachCalls, wcOf(t1).detachCalls, wcOf(t1).dbgAttached], [1, 1, false], 'one attach for arm+polls+pick+screenshot, detached when the pick ended');
});

test('design mode: Escape (cancel) and disarm give the attach back; a failing disarm still does', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws);
  wcOf(t1).reply = () => Promise.resolve({ result: { value: { cancelled: true } } });
  assert.deepEqual(await bp.designModePoll(ws), { cancelled: true });
  assert.equal(wcOf(t1).dbgAttached, false, 'cancel detached');
  wcOf(t1).reply = undefined;
  await bp.designModeArm(ws);
  assert.equal(wcOf(t1).dbgAttached, true);
  wcOf(t1).reply = () => Promise.reject(new Error('Inspected target navigated or closed'));
  await bp.designModeDisarm(ws); // swallowed
  assert.equal(wcOf(t1).dbgAttached, false, 'disarm detached although its evaluate failed');
});

test('design mode: two concurrent arms (and a re-arm after navigation) hold ONE attach, released by ONE disarm', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await Promise.all([bp.designModeArm(ws), bp.designModeArm(ws)]);
  await bp.designModeArm(ws);
  assert.equal(wcOf(t1).attachCalls, 1);
  await bp.designModeDisarm(ws);
  assert.deepEqual([wcOf(t1).dbgAttached, wcOf(t1).detachCalls], [false, 1], 'one disarm drops every arm: no leaked hold keeps the debugger attached');
});

test('design mode: an arm whose script fails does not leave the attach held', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  wcOf(t1).reply = () => Promise.reject(new Error('boom'));
  await assert.rejects(() => bp.designModeArm(ws), /boom/);
  assert.equal(wcOf(t1).dbgAttached, false);
});

test('design mode: disarm on a workspace with no panel builds none; on a closed tab it is a no-op', async () => {
  const ws = newWs();
  await bp.designModeDisarm(ws);
  assert.equal(bp.getPanel(ws), undefined, 'no panel was created just to disarm');
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  bp.closeTab(ws, 't2');
  await bp.designModeDisarm(ws, 't2');
});

test('design mode + a proxy client on the SAME tab: one attach, neither side detaches the other', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const wc = bp.tabContents(ws, 't1') as any;
  seat.seatAcquire(wc); // an agent-browser session holds the tab through the proxy
  await bp.designModeArm(ws);
  assert.equal(wcOf(t1).attachCalls, 1, 'design mode did not attach a second time');
  await bp.designModeDisarm(ws);
  assert.equal(wcOf(t1).dbgAttached, true, 'the agent session still holds the debugger');
  seat.seatRelease(wc, 0);
  assert.equal(wcOf(t1).dbgAttached, false);
});

test('without the proxy host no command can run: a clear error, and still no debugger attached', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  bp.setCdpSeat(null);
  try {
    await assert.rejects(() => bp.evaluate(ws, '1'), /CDP proxy is not running/);
    await assert.rejects(() => bp.designModeArm(ws), /CDP proxy is not running/);
    assert.equal(wcOf(t1).attachCalls ?? 0, 0);
  } finally {
    bp.setCdpSeat(testSeat);
  }
});

test('design mode: the disarm that follows a pick (or Escape) sends nothing and takes no attach — there is nothing armed', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws);
  wcOf(t1).reply = (m: string) => Promise.resolve(m === 'Page.captureScreenshot' ? { data: 'P' } : { result: { value: RAW_PICK } });
  await bp.designModePoll(ws);
  const cmds = wcOf(t1).cmds.length, attaches = wcOf(t1).attachCalls;
  await bp.designModeDisarm(ws); // the renderer's setDesignArmed(false) after the pick
  await bp.designModeDisarm(ws, 't1'); // ...and the explicit-tab form
  assert.deepEqual([wcOf(t1).cmds.length, wcOf(t1).attachCalls], [cmds, attaches], 'no command, no attach');
  assert.equal(wcOf(t1).dbgAttached, false);
});

test('design mode: a disarm that lands while the arm is still attaching runs AFTER it (no orphan overlay, no leaked lease)', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  let openGate!: () => void;
  const gate = new Promise<void>((r) => (openGate = r));
  const slow = { ...testSeat, async hold(w: string, t: string) { await gate; return testSeat.hold(w, t); } } as Parameters<typeof bp.setCdpSeat>[0];
  bp.setCdpSeat(slow);
  try {
    const arm = bp.designModeArm(ws);
    const disarm = bp.designModeDisarm(ws); // the user toggled off before the lease was even granted
    openGate();
    await Promise.all([arm, disarm]);
    const exprs = wcOf(t1).cmds.filter((c: any) => c.m === 'Runtime.evaluate').map((c: any) => c.p.expression as string);
    assert.equal(exprs.length, 2, 'arm script then teardown');
    assert.match(exprs[0], /__orchestra_design_overlay__/);
    assert.match(exprs[1], /__orchestraDesignTeardown/);
    assert.equal(wcOf(t1).dbgAttached, false, 'the lease was given back');
  } finally {
    bp.setCdpSeat(testSeat);
  }
});

test('an explicit stale tabId reaches the proxy seat NEVER and builds NO panel (evaluate / design arm after the last tab closed)', async () => {
  const ws = newWs();
  openShown(ws);
  bp.closeTab(ws, 't1'); // last tab: panel evicted
  let sent = 0;
  bp.setCdpSeat({ send: async () => { sent++; return {}; }, hold: async () => { sent++; return () => undefined; } });
  try {
    await assert.rejects(() => bp.evaluate(ws, '1', 't1'), /not found/);
    await assert.rejects(() => bp.designModeArm(ws, 't1'), /not found/);
    assert.equal(bp.getPanel(ws), undefined, 'no blank native view was resurrected');
    assert.equal(sent, 0, 'nothing reached the seat');
  } finally {
    bp.setCdpSeat(testSeat);
  }
});

test('design mode after a TAB SWITCH: the renderer addresses it by workspace, so disarm reaches every armed tab and a pick on one disarms the rest', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws); // armed on t1
  const t2 = bp.createTab(ws, { openedBy: 'agent', activate: true }); // an agent opens + activates a tab (Target.createTarget)
  await bp.designModeArm(ws); // the renderer re-arms on the new active tab (state.url changed)
  assert.deepEqual([wcOf(t1).dbgAttached, wcOf(t2).dbgAttached], [true, true], 'one lease per armed tab');
  await bp.designModeDisarm(ws); // the user toggles design mode off: resolves the ACTIVE tab (t2) only, before this fix
  assert.deepEqual([wcOf(t1).dbgAttached, wcOf(t2).dbgAttached], [false, false], 'no lease (and no overlay) left on the tab that is no longer active');
  const tore = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Runtime.evaluate' && /^\(\(\) => \{ if \(window\.__orchestraDesignTeardown\)/.test(c.p.expression)).length;
  assert.deepEqual([tore(t1), tore(t2)], [1, 1], 'the overlay was torn down on BOTH pages');
});

test('design mode: a pick on one tab tears the picker down on the others (one-shot per workspace)', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws);
  const t2 = bp.createTab(ws, { openedBy: 'agent', activate: true });
  await bp.designModeArm(ws);
  wcOf(t2).reply = (m: string) => Promise.resolve(m === 'Page.captureScreenshot' ? { data: 'P' } : { result: { value: RAW_PICK } });
  const pick: any = await bp.designModePoll(ws); // polls the active tab (t2)
  assert.ok(pick.selector);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); // the pick itself tears t1 down; NO disarm call is made here
  assert.deepEqual([wcOf(t1).dbgAttached, wcOf(t2).dbgAttached], [false, false]);
  assert.equal(wcOf(t1).cmds.some((c: any) => c.m === 'Runtime.evaluate' && /^\(\(\) => \{ if \(window\.__orchestraDesignTeardown\)/.test(c.p.expression)), true, 't1 overlay torn down');
});

test('design mode: a poll for a workspace with no panel returns null and builds nothing (a late poll after archive)', async () => {
  const ws = newWs();
  assert.equal(await bp.designModePoll(ws), null);
  assert.equal(bp.getPanel(ws), undefined);
});

test('design mode: off→on inside one round trip (arm; disarm; arm) ends ARMED, and the next disarm still cleans up (no orphan overlay or lease)', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws);
  const d = bp.designModeDisarm(ws); // the user toggles off...
  const a = bp.designModeArm(ws); // ...and on again before the first round trip returns
  await Promise.all([d, a]);
  assert.equal(wcOf(t1).dbgAttached, true, 'the last intent (armed) wins: the lease is held');
  const tore = () => wcOf(t1).cmds.filter((c: any) => c.m === 'Runtime.evaluate' && /^\(\(\) => \{ if \(window\.__orchestraDesignTeardown\)/.test(c.p.expression)).length;
  assert.equal(tore(), 0, 'the superseded disarm tore nothing down');
  await bp.designModeDisarm(ws);
  assert.equal(tore(), 1, 'a later disarm still reaches the overlay');
  assert.equal(wcOf(t1).dbgAttached, false, 'and gives the lease back');
});

test('design mode: a re-arm landing during a pick\'s screenshot is not wiped by the pick finishing', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  await bp.designModeArm(ws);
  let openShot!: () => void;
  const shotGate = new Promise<void>((r) => (openShot = r));
  wcOf(t1).reply = async (m: string) => {
    if (m === 'Page.captureScreenshot') { await shotGate; return { data: 'P' }; }
    return { result: { value: RAW_PICK } };
  };
  const poll = bp.designModePoll(ws);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // the poll is now inside finishPick's screenshot
  const rearm = bp.designModeArm(ws); // BrowserPanel's url-change effect (or a toggle) re-arms mid-pick
  openShot();
  await Promise.all([poll, rearm]);
  assert.equal(wcOf(t1).dbgAttached, true, 'the re-armed picker keeps its lease');
  wcOf(t1).reply = undefined;
  await bp.designModeDisarm(ws);
  assert.equal(wcOf(t1).dbgAttached, false, 'and a later disarm releases it (armed mark survived)');
});

// ── every path that clears design-arm state is keyed on the generation captured when ITS work started (round-2 review F5/F6) ──
//
// One table: a superseding re-arm lands INSIDE each clearing path's window. Whatever the path, the re-arm must own the tab afterwards
// (lease held, overlay installed) and one later disarm must tear it down exactly once and release the debugger. A path that clears under
// a newer arm leaves designArmed=false with the overlay up, so that later disarm no-ops: seatCount stays 1 and the click-swallowing overlay stays.

const kindOf = (m: string, p: any): 'install' | 'teardown' | 'read' | 'shot' | 'other' =>
  m === 'Page.captureScreenshot' ? 'shot'
    : /^\(\(\) => \{ if \(window\.__orchestraDesignTeardown\)/.test(p?.expression ?? '') ? 'teardown'
    : /^\(\(\) => \{ const p = window\[/.test(p?.expression ?? '') ? 'read'
    : /__orchestra_design_overlay__/.test(p?.expression ?? '') ? 'install'
    : 'other';

interface Gate { open(): void; wait: Promise<void> }
const gate = (): Gate => { let open!: () => void; const wait = new Promise<void>((r) => (open = r)); return { open, wait }; };
const ticks = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** Script one tab's debugger: per command kind an optional gate to hold it, an optional failure, and the value to answer with. */
function scripted(t: any, opts: { gates?: Partial<Record<string, Gate>>; failOnce?: Partial<Record<string, string>>; pick?: boolean } = {}) {
  const count: Record<string, number> = {};
  wcOf(t).reply = async (m: string, p: any) => {
    const k = kindOf(m, p);
    count[k] = (count[k] ?? 0) + 1;
    const g = opts.gates?.[k];
    if (g) { delete opts.gates![k]; await g.wait; }
    const f = opts.failOnce?.[k];
    if (f) { delete opts.failOnce![k]; throw new Error(f); }
    if (k === 'shot') return { data: 'P' };
    if (k === 'read') return { result: { value: opts.pick ? RAW_PICK : null } };
    return { result: { value: true } };
  };
  return count;
}
const teardowns = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Runtime.evaluate' && kindOf(c.m, c.p) === 'teardown').length;

const OWNERSHIP: Array<{ name: string; run: (ws: string, t1: any) => Promise<void>; teardownsBefore: number }> = [
  {
    // F5: the arm's own catch. A1 fails mid-install ("Execution context was destroyed") while A2 (a URL-change re-arm) is queued behind it.
    name: 'arm catch: A1 fails mid-install while A2 is queued',
    teardownsBefore: 0,
    run: async (ws, t1) => {
      scripted(t1, { failOnce: { install: 'Execution context was destroyed' } });
      const a1 = bp.designModeArm(ws).catch((e) => e);
      const a2 = bp.designModeArm(ws);
      const r1: any = await a1;
      assert.match(String(r1?.message), /Execution context was destroyed/, 'the failing arm still reports its failure');
      await a2;
    },
  },
  {
    // the disarm's own finally: an arm called while the teardown evaluate is in flight
    name: 'disarm finally: A2 is called while the disarm\'s teardown is in flight',
    teardownsBefore: 1,
    run: async (ws, t1) => {
      const g = gate();
      scripted(t1);
      await bp.designModeArm(ws);
      scripted(t1, { gates: { teardown: g } });
      const d = bp.designModeDisarm(ws);
      await ticks();
      assert.equal(wcOf(t1).cmds.filter((x: any) => kindOf(x.m, x.p) === 'teardown').length, 1, 'setup: the teardown is in flight');
      const a2 = bp.designModeArm(ws); // off→on while the first teardown is still on the wire
      g.open();
      await Promise.all([d, a2]);
    },
  },
  {
    // F6: the poll's read round trip. The gen must be read BEFORE it.
    name: 'poll read: A2 lands inside the poll\'s readRawPick round trip',
    teardownsBefore: 0,
    run: async (ws, t1) => {
      await bp.designModeArm(ws);
      const g = gate();
      scripted(t1, { gates: { read: g }, pick: true });
      const poll = bp.designModePoll(ws);
      await ticks();
      const a2 = bp.designModeArm(ws);
      await ticks();
      g.open();
      await Promise.all([poll, a2]);
    },
  },
  {
    // F2: the poll's screenshot
    name: 'poll screenshot: A2 lands inside finishPick\'s screenshot',
    teardownsBefore: 0,
    run: async (ws, t1) => {
      await bp.designModeArm(ws);
      const g = gate();
      scripted(t1, { gates: { shot: g }, pick: true });
      const poll = bp.designModePoll(ws);
      await ticks();
      const a2 = bp.designModeArm(ws);
      await ticks();
      g.open();
      await Promise.all([poll, a2]);
    },
  },
  {
    // F1: the disarm queued ahead of an arm
    name: 'disarm→arm: the arm queued BEHIND a disarm',
    teardownsBefore: 0,
    run: async (ws, t1) => {
      scripted(t1);
      await bp.designModeArm(ws);
      const d = bp.designModeDisarm(ws);
      const a = bp.designModeArm(ws);
      await Promise.all([d, a]);
    },
  },
];

for (const sc of OWNERSHIP) {
  test(`design arm ownership — ${sc.name}: the later arm owns the tab, and ONE later disarm tears it down and frees the debugger`, async () => {
    const ws = newWs();
    openShown(ws);
    const t1 = bp.getActiveTab(ws)!;
    await sc.run(ws, t1);
    assert.equal(wcOf(t1).dbgAttached, true, 'the re-armed picker still holds its lease');
    const before = teardowns(t1);
    scripted(t1);
    await bp.designModeDisarm(ws);
    assert.equal(teardowns(t1), before + 1, 'a later disarm still reaches the overlay (designArmed survived)');
    assert.equal(wcOf(t1).dbgAttached, false, 'and gives the lease back (seat count 0, debugger detached)');
  });
}
