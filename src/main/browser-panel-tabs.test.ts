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
    this.debugger = {
      attach: () => { this.dbgAttached = true; },
      detach: () => { this.dbgAttached = false; this.detachCalls++; },
      isAttached: () => this.dbgAttached,
      sendCommand: (m, p) => { this.cmds.push({ m, p }); return Promise.resolve({ result: { value: 'ev' } }); },
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
  close() { this.destroyed = true; this.closed++; this._view.webContents = undefined; }
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
  await bp.evaluate(ws, '1', 't2'); // attaches t2's debugger
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
  await bp.evaluate(ws, '1', 't1');
  await bp.evaluate(ws, '1', 't2');
  await bp.evaluate(ws, '1', 't3');
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
  assert.equal(bp.attachDebugger(ws, 't1').wsId, ws);
  assert.equal(wcOf(t1).dbgAttached, true);
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
