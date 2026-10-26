// Agent tab operations (#397, ledger #405): the REAL browser-panel.ts over a stubbed `electron` (same seam as browser-panel-tabs.test.ts).
// What the AGENT may do to the panel's tabs: open (cap shared with the human, refused before a view exists), close (only its own),
// bring to front (FOCUSED workspace only — a background workspace's agent never attaches or shows a view, the human is told of
// every swap), and the `read_page` ref pin (a `click ref_N` goes to the tab the ref came from). Mutants: scripts/mutate-browser-agent-tabs.mjs.

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
      sendCommand: (m, p) => { this.cmds.push({ m, p }); if (this.onCmd) this.onCmd(m, p); return Promise.resolve(this.reply ? this.reply(m, p) : { result: { value: 'ev' } }); },
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
const activeOf = (ws: string) => bp.getActiveTab(ws)?.id;
const attachedViews = () => attached.size;

test('agentOpenTab in the FOCUSED workspace opens an agent tab, brings it to the front and tells the human', () => {
  const ws = newWs();
  openShown(ws);
  const r = bp.agentOpenTab(ws, { url: 'http://localhost:1/a' });
  assert.ok(r.ok && r.tabId === 't2');
  assert.deepEqual(bp.listTabs(ws).map((t) => [t.id, t.openedBy, t.active]), [['t1', 'human', false], ['t2', 'agent', true]]);
  assert.equal(attachedViews(), 1, 'exactly one view composited — the new one');
  assert.ok(attached.has(viewOf(bp.getTab(ws, 't2')!)));
  const st = bp.getState(ws);
  assert.deepEqual([st.agentSwitch?.from, st.agentSwitch?.to], ['t1', 't2'], 'the swap is recorded for the notice');
  assert.deepEqual(events().at(-1)!.state.agentSwitch && [events().at(-1)!.state.agentSwitch.from, events().at(-1)!.state.agentSwitch.to], ['t1', 't2'], 'and pushed to the renderer');
  assert.deepEqual(wcOf(bp.getTab(ws, 't2')!).loaded, ['http://localhost:1/a']);
});

test('agentOpenTab in a BACKGROUND workspace opens the tab but never shows it and swaps nothing (story 44)', () => {
  const fg = newWs();
  const bg = newWs();
  openShown(fg);
  bp.ensurePanel(bg);
  const before = attachedViews();
  const r = bp.agentOpenTab(bg, { url: 'http://localhost:1/b' });
  assert.ok(r.ok);
  assert.deepEqual(bp.listTabs(bg).map((t) => [t.id, t.openedBy, t.active]).map((x) => x.slice(1)), [['human', true], ['agent', false]], 'the human\'s tab stays the active one');
  assert.equal(attachedViews(), before, 'no view attached for the background workspace');
  assert.equal(attached.has(viewOf(bp.getActiveTab(fg)!)), true, 'the focused workspace is untouched');
  assert.equal(bp.getState(bg).agentSwitch, undefined, 'nothing swapped, nothing to announce');
});

test('the cap counts the HUMAN\'s tabs too and is decided before a view exists (no leaked view on refusal)', () => {
  const ws = newWs();
  openShown(ws);
  for (let i = 0; i < 3; i++) assert.ok(bp.tryOpenTab(ws, { openedBy: 'human' }).ok);
  for (let i = 0; i < 4; i++) assert.ok(bp.agentOpenTab(ws, {}).ok);
  assert.equal(bp.listTabs(ws).length, 8);
  const viewsBefore = ((globalThis as any).__bpViews as unknown[]).length;
  const r = bp.agentOpenTab(ws, { url: 'http://localhost:1/over' });
  assert.ok(!r.ok && r.reason === 'cap');
  assert.match(r.ok ? '' : r.message, /at most 8 browser tabs/);
  assert.equal(bp.listTabs(ws).length, 8);
  assert.equal(((globalThis as any).__bpViews as unknown[]).length, viewsBefore, 'a refused open allocated no WebContentsView');
});

test('agentCloseTab: the agent closes the tab IT opened; a tab the user opened is refused and stays untouched', () => {
  const ws = newWs();
  openShown(ws);
  bp.agentOpenTab(ws, {});
  const mine = wcOf(bp.getTab(ws, 't2')!);
  const humanWc = wcOf(bp.getTab(ws, 't1')!);
  const refused = bp.agentCloseTab(ws, 't1');
  assert.ok(!refused.ok && refused.reason === 'not-owner');
  assert.equal(humanWc.closed, 0, 'the human\'s contents were not closed');
  assert.deepEqual(bp.listTabs(ws).map((t) => t.id), ['t1', 't2']);
  const ok = bp.agentCloseTab(ws, 't2');
  assert.ok(ok.ok);
  assert.equal(mine.closed, 1);
  assert.deepEqual(bp.listTabs(ws).map((t) => [t.id, t.active]), [['t1', true]], 'the user\'s tab is back on screen');
  const unknown = bp.agentCloseTab(ws, 't99');
  assert.ok(!unknown.ok && unknown.reason === 'unknown-tab');
});

test('agentActivateTab: a non-active tab of the FOCUSED workspace is brought to the front, visibly (agentSwitch); the active one is a no-op', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  assert.equal(activeOf(ws), 't1');
  assert.deepEqual(bp.agentActivateTab(ws, 't2'), { brought: true });
  assert.equal(activeOf(ws), 't2');
  assert.ok(attached.has(viewOf(bp.getTab(ws, 't2')!)) && !attached.has(viewOf(bp.getTab(ws, 't1')!)));
  assert.deepEqual([bp.getState(ws).agentSwitch?.from, bp.getState(ws).agentSwitch?.to], ['t1', 't2']);
  assert.deepEqual(bp.agentActivateTab(ws, 't2'), { brought: false }, 'already in front');
  assert.deepEqual(bp.agentActivateTab(ws, 't42'), { brought: false }, 'unknown tab');
});

test('agentActivateTab in a BACKGROUND workspace never attaches or swaps (the focus-steal rule)', () => {
  const fg = newWs();
  const bg = newWs();
  openShown(fg);
  bp.createTab(bg, { openedBy: 'agent' });
  const before = attachedViews();
  const agentTab = bp.listTabs(bg).find((t) => t.openedBy === 'agent')!;
  assert.deepEqual(bp.agentActivateTab(bg, agentTab.id), { brought: false });
  assert.equal(attachedViews(), before);
  assert.equal(bp.listTabs(bg).find((t) => t.active)?.openedBy, 'human');
  assert.equal(bp.getState(bg).agentSwitch, undefined);
});

test('a swap the HUMAN makes clears the agent notice', () => {
  const ws = newWs();
  openShown(ws);
  bp.agentOpenTab(ws, {});
  assert.ok(bp.getState(ws).agentSwitch);
  assert.ok(bp.tryActivateTab(ws, 't1').ok);
  assert.equal(bp.getState(ws).agentSwitch, undefined, 'the human clicked a tab: the notice is gone');
});

test('read_page pins its tab: a later click ref_N goes to THAT tab (brought back to the front), never the tab active by then', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'human' }); // t2, the tab the human will switch to
  await bp.readPage(ws); // refs stamped on t1 (active)
  assert.ok(bp.tryActivateTab(ws, 't2').ok); // the human moves to t2
  const t1 = wcOf(bp.getTab(ws, 't1')!);
  const t2 = wcOf(bp.getTab(ws, 't2')!);
  t1.cmds.length = 0;
  t2.cmds.length = 0;
  await bp.clickRef(ws, 3);
  assert.equal(activeOf(ws), 't1', 'the pinned tab came back to the front');
  assert.deepEqual([bp.getState(ws).agentSwitch?.from, bp.getState(ws).agentSwitch?.to], ['t2', 't1'], 'and the human is told');
  assert.ok(t1.cmds.some((c: any) => c.m === 'Runtime.evaluate' && String(c.p.expression).includes('data-orch-ref="3"')), 'the ref was looked up on the tab it came from');
  assert.ok(t1.cmds.some((c: any) => c.m === 'Input.dispatchMouseEvent'), 'and clicked there');
  assert.deepEqual(t2.cmds, [], 'the other tab received nothing');
});

test('form_input follows the same pin; with no read_page yet a ref falls on the active tab (the old behaviour)', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'human' });
  const t1 = wcOf(bp.getTab(ws, 't1')!);
  const t2 = wcOf(bp.getTab(ws, 't2')!);
  await bp.formInput(ws, 5, 'x');
  assert.ok(t1.cmds.some((c: any) => c.m === 'Runtime.evaluate'), 'no pin: the active tab');
  assert.deepEqual(t2.cmds, []);
  await bp.readPage(ws); // pin t1
  bp.tryActivateTab(ws, 't2');
  t1.cmds.length = 0;
  await bp.formInput(ws, 5, 'y');
  assert.equal(activeOf(ws), 't1');
  assert.ok(t1.cmds.some((c: any) => c.m === 'Runtime.evaluate' && String(c.p.expression).includes('data-orch-ref="5"')));
  assert.deepEqual(t2.cmds, []);
});

test('a pin on a tab that was closed is an error that says so — never a click on whichever tab is active', async () => {
  const ws = newWs();
  openShown(ws);
  bp.agentOpenTab(ws, {}); // t2 agent, active
  await bp.readPage(ws); // pin t2
  assert.ok(bp.agentCloseTab(ws, 't2').ok);
  const t1 = wcOf(bp.getTab(ws, 't1')!);
  t1.cmds.length = 0;
  await assert.rejects(() => bp.clickRef(ws, 1), /came from was closed.*read_page again/);
  assert.deepEqual(t1.cmds, [], 'the surviving tab received nothing');
});

test('an explicit tabId beats the pin', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'human' });
  await bp.readPage(ws); // pin t1
  const t2 = wcOf(bp.getTab(ws, 't2')!);
  t2.cmds.length = 0;
  await bp.formInput(ws, 2, 'z', 't2');
  assert.ok(t2.cmds.some((c: any) => c.m === 'Runtime.evaluate' && String(c.p.expression).includes('data-orch-ref="2"')));
});

test('chained agent swaps keep « Back » on the tab the HUMAN was last on (not on the agent\'s own previous stop)', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' }); // t2
  bp.createTab(ws, { openedBy: 'agent' }); // t3
  assert.deepEqual(bp.agentActivateTab(ws, 't2'), { brought: true });
  assert.deepEqual(bp.agentActivateTab(ws, 't3'), { brought: true });
  const sw = bp.getState(ws).agentSwitch;
  assert.deepEqual([sw?.from, sw?.to], ['t1', 't3'], 'back goes to t1 (the human\'s), not t2');
  // the agent returns to the tab the human was on: « Back » toggles to the tab it just left (never « Back to » the tab you are on)
  assert.deepEqual(bp.agentActivateTab(ws, 't1'), { brought: true });
  assert.deepEqual([bp.getState(ws).agentSwitch?.from, bp.getState(ws).agentSwitch?.to], ['t3', 't1']);
  assert.deepEqual(bp.agentActivateTab(ws, 't3'), { brought: true });
  // a human swap in between breaks the chain: the next agent swap starts from where the human put themselves
  assert.ok(bp.tryActivateTab(ws, 't2').ok);
  bp.agentActivateTab(ws, 't3');
  assert.deepEqual([bp.getState(ws).agentSwitch?.from, bp.getState(ws).agentSwitch?.to], ['t2', 't3']);
});

test('the agent closing the tab ON SCREEN hands the screen to a neighbour — announced (no « Back »: its source is gone); a background tab\'s close announces nothing', () => {
  const ws = newWs();
  openShown(ws);
  bp.agentOpenTab(ws, {}); // t2, active
  bp.createTab(ws, { openedBy: 'agent' }); // t3, background
  assert.ok(bp.agentCloseTab(ws, 't3').ok);
  assert.equal(bp.getState(ws).agentSwitch?.to, 't2', 'closing a background tab leaves the earlier notice as it was');
  assert.ok(bp.agentCloseTab(ws, 't2').ok);
  const sw = bp.getState(ws).agentSwitch;
  assert.deepEqual([sw?.from, sw?.to, activeOf(ws)], ['t2', 't1', 't1'], 'the user\'s tab came back: the human is told, `from` is a tab that no longer exists');
  const bg = newWs();
  bp.ensurePanel(bg);
  bp.agentOpenTab(bg, {});
  assert.ok(bp.agentCloseTab(bg, bp.listTabs(bg).find((t) => t.openedBy === 'agent')!.id).ok);
  assert.equal(bp.getState(bg).agentSwitch, undefined, 'a workspace nobody looks at announces nothing');
});

test('the FIRST read_page of a workspace (no panel yet) still pins the tab it read', async () => {
  const ws = newWs();
  openShown(ws);
  bp.destroyPanel(ws); // no panel: readPage\'s evaluate creates it
  assert.equal(bp.getPanel(ws), undefined);
  await bp.readPage(ws);
  assert.ok(bp.getPanel(ws)?.refTabId !== undefined && bp.getPanel(ws)?.refTabId === bp.getActiveTab(ws)?.id, 'pinned the tab it read');
});

test('a STALE ref fails before anything is swapped on the human\'s screen (click_ref and form_input)', async () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'human' }); // t2
  await bp.readPage(ws); // pin t1
  assert.ok(bp.tryActivateTab(ws, 't2').ok); // the human is on t2
  const t1 = wcOf(bp.getTab(ws, 't1')!);
  t1.reply = (m: string, p: any) => (m === 'Runtime.evaluate' && String(p.expression).includes('data-orch-ref') ? { result: { value: m === 'x' ? 0 : null } } : { result: { value: 'ev' } });
  await assert.rejects(() => bp.clickRef(ws, 7), /ref_7 not found/);
  assert.equal(activeOf(ws), 't2', 'no swap for a ref that does not exist');
  assert.equal(bp.getState(ws).agentSwitch, undefined);
  t1.reply = (m: string) => ({ result: { value: m === 'Runtime.evaluate' ? false : 'ev' } });
  await assert.rejects(() => bp.formInput(ws, 7, 'v'), /ref_7 not found/);
  assert.equal(activeOf(ws), 't2', 'form_input of a missing ref swaps nothing either');
});

test('a chained agent swap whose remembered human tab was CLOSED meanwhile falls back to the tab it really left (« Back » never points at a tab that is gone)', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' }); // t2
  bp.createTab(ws, { openedBy: 'human' }); // t3
  assert.ok(bp.tryActivateTab(ws, 't3').ok);
  assert.deepEqual(bp.agentActivateTab(ws, 't1'), { brought: true }); // swap: from t3, to t1
  assert.deepEqual([bp.getState(ws).agentSwitch?.from, bp.getState(ws).agentSwitch?.to], ['t3', 't1']);
  assert.ok(bp.tryCloseTab(ws, 't3', 'human').ok); // the human closes the tab « Back » remembered (a background-tab close does not clear the notice)
  assert.deepEqual(bp.agentActivateTab(ws, 't2'), { brought: true }); // chained agent swap: t1 -> t2
  const sw = bp.getState(ws).agentSwitch;
  assert.deepEqual([sw?.from, sw?.to], ['t1', 't2'], 'from is the tab it left (t1), not the closed t3');
  assert.ok(bp.listTabs(ws).some((t) => t.id === sw?.from), 'and it exists, so the Back button can render');
});
