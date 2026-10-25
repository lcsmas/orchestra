import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpProxyCore,
  type CdpEventListener,
  type CdpPanelPort,
  type CdpTab,
  type CdpTabChannel,
  type CdpTabEvent,
} from './cdp-proxy-core.ts';

class FakeChannel implements CdpTabChannel {
  sent: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  listeners = new Set<CdpEventListener>();
  detachers = new Set<(r: string) => void>();
  answer: (method: string, params: unknown) => Promise<unknown> = async () => ({});
  send(method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    return this.answer(method, params);
  }
  subscribe(l: CdpEventListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onDetach(l: (r: string) => void) { this.detachers.add(l); return () => this.detachers.delete(l); }
  emit(method: string, params: unknown, sessionId?: string) { for (const l of [...this.listeners]) l(method, params, sessionId); }
  detach(reason: string) { for (const d of [...this.detachers]) d(reason); }
}

function fakePanel(initial: CdpTab[] = [{ id: 't1', url: 'http://a/', title: 'A', active: true, openedBy: 'human' }]) {
  const tabs = [...initial];
  const channels = new Map<string, FakeChannel>();
  const subs = new Set<(e: CdpTabEvent) => void>();
  const log = { acquire: [] as string[], release: [] as string[], activate: [] as string[], invalidate: [] as string[], fallback: [] as string[] };
  let frames: string | null = null;
  const port: CdpPanelPort = {
    listTabs: () => tabs.map((t) => ({ ...t })),
    subscribeTabs: (l) => { subs.add(l); return () => subs.delete(l); },
    acquire: async (id) => { log.acquire.push(id); if (!channels.has(id)) channels.set(id, new FakeChannel()); return channels.get(id)!; },
    release: (id) => { log.release.push(id); },
    createTab: async (url) => { const t: CdpTab = { id: `t${tabs.length + 1}`, url: url ?? 'about:blank', title: '', active: false, openedBy: 'agent' }; tabs.push(t); for (const s of subs) s({ kind: 'created', tab: t }); return t; },
    closeTab: async (id) => { const i = tabs.findIndex((t) => t.id === id); const [t] = tabs.splice(i, 1); for (const s of subs) s({ kind: 'destroyed', tab: t! }); },
    activateTab: (id) => { log.activate.push(id); },
    userAgent: () => 'UA/1',
    invalidate: (id) => { log.invalidate.push(id); },
    captureFallback: async (id, fmt) => { log.fallback.push(`${id}:${fmt}`); return 'FALLBACK'; },
    framesError: () => frames,
  };
  return {
    port, channels, log, tabs,
    setFrames: (e: string | null) => { frames = e; },
    emitTab: (e: CdpTabEvent) => { for (const s of subs) s(e); },
  };
}

/** A client that records everything it receives and awaits replies by id. */
function client(core: CdpProxyCore) {
  const inbox: any[] = [];
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => { inbox.push(m); const w = waiters.get(m.id as number); if (w) w(m); } });
  let n = 0;
  const call = (method: string, params?: object, sessionId?: string) => {
    const id = ++n;
    const p = new Promise<any>((res) => waiters.set(id, res));
    void c.message(JSON.stringify({ id, method, params, sessionId }));
    return p;
  };
  return { call, inbox, close: () => c.close(), events: (method: string) => inbox.filter((m) => m.method === method) };
}

const tick = () => new Promise((r) => setImmediate(r));

test('Target.getTargets lists the tabs, ACTIVE first, with hex target ids that are not the registry ids', async () => {
  const p = fakePanel([
    { id: 't1', url: 'http://a/', title: 'A', active: false, openedBy: 'human' },
    { id: 't2', url: 'http://b/', title: 'B', active: true, openedBy: 'agent' },
  ]);
  const core = new CdpProxyCore(p.port, { nonce: 'n' });
  const c = client(core);
  const r = await c.call('Target.getTargets');
  const infos = r.result.targetInfos;
  assert.deepEqual(infos.map((i: any) => i.title), ['B', 'A']);
  assert.ok(infos.every((i: any) => i.type === 'page' && /^[0-9A-F]{32}$/.test(i.targetId)));
  assert.notEqual(infos[0].targetId, 't2');
});

test('attach → session id; page-level commands forward to the tab debugger with NO session id', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const { targetInfos } = (await c.call('Target.getTargets')).result;
  const { sessionId } = (await c.call('Target.attachToTarget', { targetId: targetInfos[0].targetId, flatten: true })).result;
  assert.match(sessionId, /^[0-9A-F]{32}$/);
  assert.equal(c.events('Target.attachedToTarget').length, 1, 'announced before the reply, as Chrome does');
  const ch = p.channels.get('t1')!;
  ch.answer = async () => ({ result: { type: 'number', value: 1 } });
  const r = await c.call('Runtime.evaluate', { expression: '1' }, sessionId);
  assert.deepEqual(r.result, { result: { type: 'number', value: 1 } });
  assert.equal(r.sessionId, sessionId);
  assert.deepEqual(ch.sent.map((s) => [s.method, s.sessionId]), [['Runtime.evaluate', undefined]]);
});

test('debugger events fan out to the tab sessions under THEIR session id; a child session keeps its own', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const { targetInfos } = (await c.call('Target.getTargets')).result;
  const { sessionId } = (await c.call('Target.attachToTarget', { targetId: targetInfos[0].targetId })).result;
  const ch = p.channels.get('t1')!;
  ch.emit('Page.loadEventFired', { timestamp: 1 });
  ch.emit('Target.attachedToTarget', { sessionId: 'CHILD', targetInfo: {} });
  ch.emit('Runtime.consoleAPICalled', { type: 'log' }, 'CHILD');
  await tick();
  assert.equal(c.events('Page.loadEventFired')[0].sessionId, sessionId);
  assert.equal(c.events('Runtime.consoleAPICalled')[0].sessionId, 'CHILD');
  // a command naming the child session is routed to the debugger WITH that session id
  await c.call('Runtime.runIfWaitingForDebugger', undefined, 'CHILD');
  assert.deepEqual(ch.sent.at(-1), { method: 'Runtime.runIfWaitingForDebugger', params: undefined, sessionId: 'CHILD' });
});

test('an unknown session id is refused (no cross-client session reuse)', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const a = client(core);
  const b = client(core);
  const { targetInfos } = (await a.call('Target.getTargets')).result;
  const { sessionId } = (await a.call('Target.attachToTarget', { targetId: targetInfos[0].targetId })).result;
  const r = await b.call('Runtime.evaluate', { expression: '1' }, sessionId);
  assert.match(r.error.message, /Session with given id not found/);
});

test('debugger refcount: two clients share one acquire; release only when the LAST session goes', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const a = client(core);
  const b = client(core);
  const tid = (await a.call('Target.getTargets')).result.targetInfos[0].targetId;
  await a.call('Target.attachToTarget', { targetId: tid });
  await b.call('Target.attachToTarget', { targetId: tid });
  assert.deepEqual(p.log.acquire, ['t1']);
  a.close();
  assert.deepEqual(p.log.release, []);
  b.close();
  assert.deepEqual(p.log.release, ['t1']);
  assert.deepEqual(core.attachedTabIds(), []);
});

test('Page.bringToFront and Target.activateTarget activate the tab and never reach the debugger', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const tid = (await c.call('Target.getTargets')).result.targetInfos[0].targetId;
  const { sessionId } = (await c.call('Target.attachToTarget', { targetId: tid })).result;
  await c.call('Page.bringToFront', undefined, sessionId);
  await c.call('Target.activateTarget', { targetId: tid });
  assert.deepEqual(p.log.activate, ['t1', 't1']);
  assert.equal(p.channels.get('t1')!.sent.length, 0);
});

test('Input.* on a panel with no frames fails FAST with the panel reason; the same call passes when frames exist', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const tid = (await c.call('Target.getTargets')).result.targetInfos[0].targetId;
  const { sessionId } = (await c.call('Target.attachToTarget', { targetId: tid })).result;
  p.setFrames('panel not visible: open the workspace');
  const bad = await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, sessionId);
  assert.match(bad.error.message, /panel not visible/);
  assert.equal(p.channels.get('t1')!.sent.length, 0, 'nothing dispatched to a view that cannot paint');
  p.setFrames(null);
  const ok = await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, sessionId);
  assert.equal(ok.error, undefined);
  // non-frame-bound commands are unaffected by a hidden panel
  p.setFrames('panel not visible');
  assert.equal((await c.call('Runtime.evaluate', { expression: '1' }, sessionId)).error, undefined);
});

test('Page.captureScreenshot: primary result passes through; hung primary → capturePage fallback; clip disables the fallback', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const tid = (await c.call('Target.getTargets')).result.targetInfos[0].targetId;
  const { sessionId } = (await c.call('Target.attachToTarget', { targetId: tid })).result;
  const ch = p.channels.get('t1')!;
  ch.answer = async (m) => (m === 'Page.captureScreenshot' ? { data: 'PRIMARY' } : {});
  const r = await c.call('Page.captureScreenshot', { format: 'png' }, sessionId);
  assert.deepEqual(r.result, { data: 'PRIMARY' });
  assert.deepEqual(p.log.invalidate, ['t1']);
  // failing primary + fallback-able request → fallback image
  ch.answer = async (m) => { if (m === 'Page.captureScreenshot') throw new Error('Not allowed'); return {}; };
  const r2 = await c.call('Page.captureScreenshot', { format: 'jpeg', quality: 50 }, sessionId);
  assert.deepEqual(r2.result, { data: 'FALLBACK' });
  assert.deepEqual(p.log.fallback, ['t1:jpeg']);
  // a clipped request cannot be served by capturePage → the primary's own error, never a wrong image
  const r3 = await c.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 5, height: 5, scale: 1 } }, sessionId);
  assert.match(r3.error.message, /Not allowed/);
});

test('Target.createTarget maps onto the panel tab creation; closeTarget onto closeTab; both announced to discoverers', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  await c.call('Target.setDiscoverTargets', { discover: true });
  await tick();
  assert.equal(c.events('Target.targetCreated').length, 1, 'existing targets announced when discovery turns on');
  const created = (await c.call('Target.createTarget', { url: 'http://b/' })).result;
  assert.match(created.targetId, /^[0-9A-F]{32}$/);
  assert.equal(p.tabs.length, 2);
  assert.equal(c.events('Target.targetCreated').length, 2);
  assert.equal((await c.call('Target.closeTarget', { targetId: created.targetId })).result.success, true);
  assert.equal(c.events('Target.targetDestroyed').length, 1);
});

test('createTarget without panel support is a CDP error, not a crash', async () => {
  const p = fakePanel();
  delete (p.port as any).createTab;
  const core = new CdpProxyCore(p.port);
  const r = await client(core).call('Target.createTarget', { url: 'x' });
  assert.match(r.error.message, /not supported/);
});

test('a tab closed under a live session detaches it (Target.detachedFromTarget) and later commands fail', async () => {
  const p = fakePanel([
    { id: 't1', url: 'http://a/', title: 'A', active: true, openedBy: 'human' },
    { id: 't2', url: 'http://b/', title: 'B', active: false, openedBy: 'agent' },
  ]);
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const infos = (await c.call('Target.getTargets')).result.targetInfos;
  const t2 = infos.find((i: any) => i.title === 'B');
  const { sessionId } = (await c.call('Target.attachToTarget', { targetId: t2.targetId })).result;
  await p.port.closeTab!('t2');
  await tick();
  assert.equal(c.events('Target.detachedFromTarget')[0].params.sessionId, sessionId);
  const r = await c.call('Runtime.evaluate', { expression: '1' }, sessionId);
  assert.match(r.error.message, /Session with given id not found/);
});

test('the debugger detaching (DevTools opened on the tab) detaches the sessions with the reason', async () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port);
  const c = client(core);
  const tid = (await c.call('Target.getTargets')).result.targetInfos[0].targetId;
  await c.call('Target.attachToTarget', { targetId: tid });
  p.channels.get('t1')!.detach('replaced_with_devtools');
  assert.equal(c.events('Target.detachedFromTarget')[0].params.reason, 'replaced_with_devtools');
  assert.deepEqual(core.attachedTabIds(), []);
});

test('browser-level: version, destructive Browser.close is a no-op, unknown methods are "wasn\'t found"', async () => {
  const p = fakePanel();
  const c = client(new CdpProxyCore(p.port));
  assert.equal((await c.call('Browser.getVersion')).result.userAgent, 'UA/1');
  assert.deepEqual((await c.call('Browser.close')).result, {});
  assert.equal(p.tabs.length, 1);
  assert.match((await c.call('Browser.grantPermissions')).error.message, /wasn't found/);
  assert.match((await c.call('Target.attachToTarget', { targetId: 'NOPE' })).error.message, /No target with given id/);
});

test('/json: version carries the ws url; list is active-first with a per-target ws url', () => {
  const p = fakePanel();
  const core = new CdpProxyCore(p.port, { nonce: 'n' });
  assert.equal(core.jsonVersion('ws://x/y').webSocketDebuggerUrl, 'ws://x/y');
  const l = core.jsonList('ws://127.0.0.1:9/tok');
  assert.equal(l.length, 1);
  assert.match(l[0]!.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:9\/tok\/devtools\/page\/[0-9A-F]{32}$/);
});
