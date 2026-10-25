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
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  }
  isDestroyed() { return this.destroyed; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emitEvent(ev, ...a) { for (const f of (this.handlers[ev] || [])) f(...a); }
  once() {} setWindowOpenHandler() {}
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }
  reload() { this.reloaded = true; }
  capturePage() { return Promise.resolve({ toJPEG: () => Buffer.from('x') }); }
  getURL() { return this.url; } getTitle() { return this.title; }
  // Real Electron closes ASYNCHRONOUSLY: with __bpAsyncClose the contents stay live until finishClose().
  close() { this.closed++; if (globalThis.__bpAsyncClose) { this.pendingClose = true; return; } this.destroyed = true; this._view.webContents = undefined; }
  finishClose() { this.destroyed = true; this._view.webContents = undefined; }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(this); this._wc = this.webContents; this.bounds = null; views.push(this); }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
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
  return { wc, release: () => seat.seatRelease(wc) };
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

const attached = new Set<unknown>();
bp.initBrowserPanels(() => ({
  contentView: {
    addChildView: (v: unknown) => attached.add(v),
    removeChildView: (v: unknown) => attached.delete(v),
  },
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
  assert.equal(attached.size, 0, 'a composited view leaked past destroyPanel');
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

test('capture / input on a BACKGROUND tab are refused (only the active tab produces frames)', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  await assert.rejects(() => bp.capture(ws, 75, 't2'), /not the active tab/);
  await assert.rejects(() => bp.clickAt(ws, 1, 1, 't2'), /not the active tab/);
  await assert.rejects(() => bp.typeText(ws, 'x', 't2'), /not the active tab/);
  await assert.rejects(() => bp.scrollBy(ws, 5, 't2'), /not the active tab/);
  assert.ok((await bp.capture(ws, 75, 't1')).length > 0, 'the active tab still captures');
  bp.activateTab(ws, 't2');
  assert.ok((await bp.capture(ws, 75, 't2')).length > 0, 'and so does t2 once active');
  await assert.rejects(() => bp.capture(ws, 75, 't1'), /not the active tab/);
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

test('clickRef pins ONE tab: a tab switch between resolving the ref and clicking never lands on the new tab', async () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  const t2 = bp.createTab(ws, { openedBy: 'agent' });
  wcOf(t1).evalValue = { x: 5, y: 6 };
  wcOf(t1).onCmd = (m: string) => { if (m === 'Runtime.evaluate') bp.activateTab(ws, 't2'); };
  await assert.rejects(() => bp.clickRef(ws, 1), /not the active tab/, 'the pinned click refuses a tab that is no longer composited');
  const mouse = (t: any) => wcOf(t).cmds.filter((c: any) => c.m === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse(t2), [], 'nothing was clicked on the tab that became active');
  assert.deepEqual(mouse(t1), [], 'and the click was not half-delivered to the first tab either');
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
  seat.seatRelease(wc);
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
