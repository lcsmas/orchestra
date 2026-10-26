// Agent tab behaviour of the CDP proxy core (#397): which agent commands bring a tab to the front, and how a refused open / close
// reaches agent-browser. The panel's own rules (cap, ownership, the focus rule) are tested on the real panel in
// src/main/browser-panel-agent-tabs.test.ts; here the port is a fake that records what the core asked of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpProxyCore, type CdpEventListener, type CdpPanelPort, type CdpTab, type CdpTabChannel } from './cdp-proxy-core.ts';

function fake(initial: CdpTab[]) {
  const tabs = [...initial];
  const sent: Array<{ tab: string; method: string }> = [];
  const activated: string[] = [];
  const listeners = new Map<string, Set<CdpEventListener>>();
  let frames: string | null = null;
  const channelFor = (id: string): CdpTabChannel => ({
    send: async (method, _p, sid) => { sent.push({ tab: id, method, ...(sid ? { sid } : {}) } as { tab: string; method: string }); return {}; },
    subscribe: (l) => { (listeners.get(id) ?? listeners.set(id, new Set()).get(id)!).add(l); return () => undefined; },
    onDetach: () => () => undefined,
  });
  const port: CdpPanelPort = {
    listTabs: () => tabs.map((t) => ({ ...t })),
    subscribeTabs: () => () => undefined,
    acquire: async (id) => channelFor(id),
    release: () => undefined,
    createTab: async () => { throw new Error('Tab limit reached: a workspace holds at most 8 browser tabs. Close one first.'); },
    closeTab: async () => { throw new Error('Tab t1 was opened by the user: an agent may close only the tabs it opened.'); },
    activateTab: (id) => { activated.push(id); },
    userAgent: () => 'UA',
    invalidate: () => undefined,
    captureFallback: async () => 'FB',
    framesError: () => frames,
  };
  return {
    port, sent, activated,
    setFrames: (e: string | null) => { frames = e; },
    /** the page's debugger announces an auto-attached CHILD (frame) session of `tabId` */
    attachChild: (tabId: string, child: string) => { for (const l of listeners.get(tabId) ?? []) l('Target.attachedToTarget', { sessionId: child, targetInfo: { type: 'iframe' } }); },
  };
}

function client(core: CdpProxyCore) {
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => waiters.get(m.id as number)?.(m) });
  let n = 0;
  return {
    call: (method: string, params?: object, sessionId?: string) => {
      const id = ++n;
      const p = new Promise<any>((res) => waiters.set(id, res));
      void c.message(JSON.stringify({ id, method, params, sessionId }));
      return p;
    },
  };
}

const TABS: CdpTab[] = [
  { id: 't1', url: 'http://a/', title: 'A', active: true, openedBy: 'human' },
  { id: 't2', url: 'http://b/', title: 'B', active: false, openedBy: 'agent' },
];

async function attachTo(core: CdpProxyCore, c: ReturnType<typeof client>, tabId: string): Promise<string> {
  const r = await c.call('Target.attachToTarget', { targetId: core.targetIdFor(tabId), flatten: true });
  return r.result.sessionId;
}

test('an ACTING command on a non-active tab brings it to the front, once per command (Runtime.evaluate, Accessibility, Page.navigate)', async () => {
  const f = fake(TABS);
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  for (const m of ['Runtime.evaluate', 'Accessibility.getFullAXTree', 'Page.navigate']) await c.call(m, {}, sid);
  assert.deepEqual(f.activated, ['t2', 't2', 't2']);
  assert.deepEqual(f.sent.map((s) => s.method), ['Runtime.evaluate', 'Accessibility.getFullAXTree', 'Page.navigate'], 'and the commands still reach the tab');
});

test('attach-time chatter (domain enables, setAutoAttach, runIfWaitingForDebugger, getFrameTree) does NOT swap the human\'s tab', async () => {
  const f = fake(TABS);
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger', 'Page.getFrameTree']) await c.call(m, {}, sid);
  assert.deepEqual(f.activated, [], 'nothing came to the front');
  assert.equal(f.sent.length, 7, 'every one was still forwarded');
});

test('an action on the tab that is ALREADY active, and browser-level calls (tab list), bring nothing to the front', async () => {
  const f = fake(TABS);
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid1 = await attachTo(core, c, 't1');
  await c.call('Runtime.evaluate', {}, sid1);
  await c.call('Target.getTargets');
  await c.call('Browser.getVersion');
  assert.deepEqual(f.activated, []);
});

test('an explicit switch (Page.bringToFront / Target.activateTarget) activates the tab and Page.bringToFront is not forwarded', async () => {
  const f = fake(TABS);
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  await c.call('Page.bringToFront', {}, sid);
  await c.call('Target.activateTarget', { targetId: core.targetIdFor('t2') });
  assert.deepEqual(f.activated, ['t2', 't2']);
  assert.deepEqual(f.sent, [], 'bringToFront never reached the debugger (it would take OS focus)');
});

test('a refused Target.createTarget / Target.closeTarget reaches the client as a CDP error carrying the policy message, and changes nothing', async () => {
  const f = fake(TABS);
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const created = await c.call('Target.createTarget', { url: 'http://x/' });
  assert.equal(created.result, undefined);
  assert.match(created.error.message, /Tab limit reached: a workspace holds at most 8 browser tabs/);
  const closed = await c.call('Target.closeTarget', { targetId: core.targetIdFor('t1') });
  assert.equal(closed.result, undefined);
  assert.match(closed.error.message, /opened by the user: an agent may close only the tabs it opened/);
  assert.deepEqual(f.port.listTabs().map((t) => t.id), ['t1', 't2']);
});

// ---- #397 review F1: the close verbs are gated on EVERY session of a tab, not only the root one ---------------------------------------------

async function withChild(tabId = 't1') {
  const f = fake(TABS);
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, tabId);
  f.attachChild(tabId, 'CHILD1');
  return { f, core, c, sid };
}

test('F1: a CHILD session of the user\'s tab answers the close verbs exactly as the ROOT session does (#395\'s shared isBrowserLevelMethod): ownership refusal, no-op Browser.close, nothing reaches the debugger', async () => {
  const { f, core, c, sid } = await withChild('t1');
  const targetId = core.targetIdFor('t1');
  for (const m of ['Page.close', 'Target.closeTarget']) {
    const child = await c.call(m, { targetId }, 'CHILD1');
    const root = await c.call(m, { targetId }, sid);
    assert.match(child.error.message, /opened by the user: an agent may close only the tabs it opened/, `${m} on the child`);
    assert.equal(child.error.message, root.error.message, `${m}: child and root answer identically`);
  }
  assert.deepEqual((await c.call('Browser.close', {}, 'CHILD1')).result, {}, 'Browser.close is a no-op on the child too');
  assert.deepEqual(f.sent, [], 'nothing was forwarded to the page debugger');
});

test('F1 control: the same verb on the ROOT tab session takes the browser-level rules (ownership) — the instrument can say "gated"', async () => {
  const { f, c, sid } = await withChild('t1');
  const r = await c.call('Page.close', {}, sid);
  assert.match(r.error.message, /opened by the user: an agent may close only the tabs it opened/);
  assert.deepEqual(f.sent, []);
});

test('F1: a CHILD session\'s legitimate commands are untouched — Runtime.evaluate and a nested Target.setAutoAttach are forwarded with the child session id', async () => {
  const { f, c } = await withChild('t1');
  await c.call('Runtime.evaluate', { expression: '1' }, 'CHILD1');
  await c.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 'CHILD1');
  assert.deepEqual(f.sent.map((s: any) => [s.method, s.sid]), [['Runtime.evaluate', 'CHILD1'], ['Target.setAutoAttach', 'CHILD1']]);
});

// ---- #397 review F3: a frame session meets the same fail-fast and the same bring-to-front ---------------------------------------------------

test('F3: Input.* on a CHILD session of a tab whose frames cannot be produced fails fast (a hidden pane queues them: a phantom click when the pane is shown later)', async () => {
  const { f, c, sid } = await withChild('t1');
  f.setFrames("this workspace's Browser pane is not on screen");
  const root = await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, sid);
  const child = await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, 'CHILD1');
  assert.match(root.error.message, /not on screen/, 'control: the root session already failed fast');
  assert.match(child.error.message, /not on screen/);
  assert.deepEqual(f.sent, [], 'nothing reached the debugger on either session');
  f.setFrames(null);
  const ok = await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, 'CHILD1');
  assert.equal(ok.error, undefined, 'and with frames available the child Input is forwarded');
});

test('F3: an ACTING command on a CHILD session of a background tab brings that tab to the front (it is the same tab the human is not looking at)', async () => {
  const { f, c } = await withChild('t2');
  await c.call('Runtime.evaluate', { expression: '1' }, 'CHILD1');
  assert.deepEqual(f.activated, ['t2']);
  await c.call('Runtime.enable', {}, 'CHILD1');
  assert.deepEqual(f.activated, ['t2'], 'a domain enable on the child is not an action');
});
