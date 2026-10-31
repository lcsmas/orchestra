// #406 phase 2 — the CDP proxy core around `beginAction` / `captureView`: an acting command on a tab nobody looks at is driven in place under a lease
// (never brought to the front), the lease is ended whether the command succeeds or throws, a refusal reaches the client as a CDP error before the
// debugger, and a screenshot of a hidden tab comes from `captureView`. Ports WITHOUT leases keep the pre-#406 rule (tested in cdp-proxy-core-agent-tabs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpProxyCore, type CdpPanelPort, type CdpTab, type CdpTabChannel } from './cdp-proxy-core.ts';

const TABS: CdpTab[] = [
  { id: 't1', url: 'http://a/', title: 'A', active: true, openedBy: 'human' },
  { id: 't2', url: 'http://b/', title: 'B', active: false, openedBy: 'agent' },
];

function fake(opts: { beginAction?: CdpPanelPort['beginAction']; captureView?: CdpPanelPort['captureView']; fail?: Set<string>; delays?: Record<string, number>; windowDark?: CdpPanelPort['windowDark'] } = {}) {
  const sent: Array<{ tab: string; method: string; params?: unknown }> = [];
  const activated: string[] = [];
  const events: string[] = [];
  const channelFor = (id: string): CdpTabChannel => ({
    send: async (method, params) => {
      sent.push({ tab: id, method, params });
      events.push(`send:${method}`);
      if (opts.fail?.has(method)) throw new Error(`${method} exploded`);
      const d = opts.delays?.[method];
      if (d === Infinity) return new Promise(() => undefined); // never acknowledged
      if (d) await new Promise((r) => setTimeout(r, d));
      return method === 'Page.captureScreenshot' ? { data: 'DEBUGGER' } : {};
    },
    subscribe: () => () => undefined,
    onDetach: () => () => undefined,
  });
  const port: CdpPanelPort = {
    listTabs: () => TABS.map((t) => ({ ...t })),
    subscribeTabs: () => () => undefined,
    acquire: async (id) => channelFor(id),
    release: () => undefined,
    activateTab: (id) => { activated.push(id); },
    userAgent: () => 'UA',
    invalidate: () => undefined,
    captureFallback: async () => 'FB',
    framesError: () => 'OLD-RULE REFUSAL',
    ...(opts.beginAction ? { beginAction: async (id, kind) => { events.push(`begin:${id}:${kind}`); const l = await opts.beginAction!(id, kind); return { end: () => { events.push(`end:${id}`); l.end(); }, ...(l.touch ? { touch: () => l.touch!() } : {}) }; } } : {}),
    ...(opts.captureView ? { captureView: opts.captureView } : {}),
    ...(opts.windowDark ? { windowDark: opts.windowDark } : {}),
  };
  return { port, sent, activated, events };
}

function client(core: CdpProxyCore) {
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => waiters.get(m.id as number)?.(m) });
  let n = 0;
  return { call: (method: string, params?: object, sessionId?: string) => { const id = ++n; const p = new Promise<any>((res) => waiters.set(id, res)); void c.message(JSON.stringify({ id, method, params, sessionId })); return p; } };
}
const attachTo = async (core: CdpProxyCore, c: ReturnType<typeof client>, tabId: string): Promise<string> => (await c.call('Target.attachToTarget', { targetId: core.targetIdFor(tabId), flatten: true })).result.sessionId;

test('an acting command on a background tab takes a lease (kind per method), reaches the debugger inside it, and is NOT brought to the front', async () => {
  const f = fake({ beginAction: async () => ({ end: () => undefined }) });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  await c.call('Runtime.evaluate', {}, sid);
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, sid);
  await c.call('Page.captureScreenshot', {}, sid);
  assert.deepEqual(f.activated, [], 'no bring-to-front');
  assert.deepEqual(f.events.filter((e) => e.startsWith('begin') || e.startsWith('end') || e.startsWith('send')), [
    'begin:t2:other', 'send:Runtime.evaluate', 'end:t2',
    'begin:t2:input', 'send:Input.dispatchMouseEvent', 'end:t2',
    'begin:t2:capture', 'send:Page.captureScreenshot', 'end:t2',
  ]);
});

test('attach-time chatter (domain enables, setAutoAttach, getFrameTree) takes NO lease: it is not an action', async () => {
  const f = fake({ beginAction: async () => ({ end: () => undefined }) });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  for (const m of ['Page.enable', 'Runtime.enable', 'Target.setAutoAttach', 'Page.getFrameTree']) await c.call(m, {}, sid);
  assert.deepEqual(f.events.filter((e) => e.startsWith('begin')), []);
});

test('the lease is ENDED when the command fails, too (P7: an aborted action leaves nothing unthrottled)', async () => {
  const f = fake({ beginAction: async () => ({ end: () => undefined }), fail: new Set(['Runtime.evaluate']) });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  const r = await c.call('Runtime.evaluate', {}, sid);
  assert.ok(r.error, 'the failure reaches the client');
  assert.deepEqual(f.events.filter((e) => e.startsWith('begin') || e.startsWith('end')), ['begin:t2:other', 'end:t2']);
});

test('a refusal from beginAction is a CDP error BEFORE the debugger sees the command, and takes no lease to end', async () => {
  const f = fake({ beginAction: async () => { throw new Error('this tab has not been on screen since its page loaded'); } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  const r = await c.call('Input.dispatchMouseEvent', {}, sid);
  assert.match(r.error.message, /has not been on screen since its page loaded/);
  assert.deepEqual(f.sent.map((s) => s.method), [], 'nothing reached the debugger');
  assert.deepEqual(f.events.filter((e) => e.startsWith('end')), []);
});

test('with leases the old framesError refusal is never consulted (input on a hidden tab is not refused by the pre-#406 rule)', async () => {
  const f = fake({ beginAction: async () => ({ end: () => undefined }) });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  const r = await c.call('Input.dispatchMouseEvent', { type: 'mousePressed' }, sid);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(f.sent.map((s) => s.method), ['Input.dispatchMouseEvent']);
});

test('a screenshot of a tab that is not on screen is answered by captureView (never the debugger chain); null = the normal chain', async () => {
  const seen: unknown[] = [];
  const f = fake({ beginAction: async () => ({ end: () => undefined }), captureView: async (id, p) => { seen.push([id, p]); return id === 't2' ? 'HIDDEN-FRAME' : null; } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const hidden = await c.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } }, await attachTo(core, c, 't2'));
  assert.deepEqual(hidden.result, { data: 'HIDDEN-FRAME' });
  assert.deepEqual(seen[0], ['t2', { format: 'png', clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 } }]);
  assert.deepEqual(f.sent.filter((s) => s.method === 'Page.captureScreenshot'), [], 'the debugger was not asked');
  const visible = await c.call('Page.captureScreenshot', {}, await attachTo(core, c, 't1'));
  assert.equal(visible.result.data, 'DEBUGGER', 'a tab on screen keeps the normal chain');
});

test('a captureView refusal (nothing to cover its first frame, no frame at all) reaches the client as a CDP error', async () => {
  const f = fake({ beginAction: async () => ({ end: () => undefined }), captureView: async () => { throw new Error('the Orchestra window produced no frame'); } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const r = await c.call('Page.captureScreenshot', {}, await attachTo(core, c, 't2'));
  assert.match(r.error.message, /produced no frame/);
});

test('an explicit Page.bringToFront still brings the tab to the front (the switch the human is told about)', async () => {
  const f = fake({ beginAction: async () => ({ end: () => undefined }) });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  await c.call('Page.bringToFront', {}, await attachTo(core, c, 't2'));
  assert.deepEqual(f.activated, ['t2']);
});

test('P7: a command that is still running RENEWS its lease every beat; a client that disconnects mid-command has its lease ENDED long before the command would have finished', async () => {
  const touches: number[] = [];
  let ended = 0;
  const f = fake({ beginAction: async () => ({ end: () => { ended++; }, touch: () => { touches.push(Date.now()); } } as { end(): void }) });
  const slow: CdpPanelPort = { ...f.port, acquire: async () => ({ send: async () => { await new Promise((r) => setTimeout(r, 4000)); return {}; }, subscribe: () => () => undefined, onDetach: () => () => undefined }) };
  const core = new CdpProxyCore(slow);
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => waiters.get(m.id as number)?.(m) });
  const call = (id: number, method: string, params: object, sessionId?: string) => { const p = new Promise<any>((res) => waiters.set(id, res)); void c.message(JSON.stringify({ id, method, params, sessionId })); return p; };
  const sid = (await call(1, 'Target.attachToTarget', { targetId: core.targetIdFor('t2'), flatten: true })).result.sessionId;
  void call(2, 'Runtime.evaluate', {}, sid); // takes 4 s: the check below (at ~2.5 s) is before it can finish, so ONLY the disconnect branch can have ended the lease
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(touches.length >= 1, `renewed at least once while running (${touches.length})`);
  assert.equal(ended, 0, 'still running: the lease is held');
  c.close(); // the client dies mid-command
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(ended >= 1, 'the lease was ended after the disconnect, long before the command finished (by the disconnect itself or the next beat — either mechanism satisfies P7)');
});

test('a command that HANGS on a client that never disconnects stops renewing its lease at the cap, so the watchdog can force the flip-back', async () => {
  const touches: number[] = [];
  let ended = 0;
  const f = fake({ beginAction: async () => ({ end: () => { ended++; }, touch: () => { touches.push(Date.now()); } } as { end(): void }) });
  const hung: CdpPanelPort = { ...f.port, acquire: async () => ({ send: async () => { await new Promise((r) => setTimeout(r, 6000)); return {}; }, subscribe: () => () => undefined, onDetach: () => () => undefined }) };
  const core = new CdpProxyCore(hung, { leaseMaxMs: 1500 });
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => waiters.get(m.id as number)?.(m) });
  const call = (id: number, method: string, params: object, sessionId?: string) => { const p = new Promise<any>((res) => waiters.set(id, res)); void c.message(JSON.stringify({ id, method, params, sessionId })); return p; };
  const sid = (await call(1, 'Target.attachToTarget', { targetId: core.targetIdFor('t2'), flatten: true })).result.sessionId;
  void call(2, 'Runtime.evaluate', {}, sid); // hangs for 6 s; the client stays connected
  await new Promise((r) => setTimeout(r, 3600));
  assert.ok(touches.length >= 1, 'renewed while under the cap');
  assert.equal(ended, 1, 'ended at the first beat past the cap although the client is still connected and the command still hangs');
  const n = touches.length;
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(touches.length, n, 'and it never renews again');
  c.close();
});

test('a client that disconnects while the lease is still being TAKEN (a surface pulse can take seconds) gets nothing dispatched and its lease is ended', async () => {
  let ended = 0;
  const f = fake({ beginAction: async () => { await new Promise((r) => setTimeout(r, 400)); return { end: () => { ended++; } }; } });
  const core = new CdpProxyCore(f.port);
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => waiters.get(m.id as number)?.(m) });
  const call = (id: number, method: string, params: object, sessionId?: string) => { const p = new Promise<any>((res) => waiters.set(id, res)); void c.message(JSON.stringify({ id, method, params, sessionId })); return p; };
  const sid = (await call(1, 'Target.attachToTarget', { targetId: core.targetIdFor('t2'), flatten: true })).result.sessionId;
  void call(2, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, sid);
  await new Promise((r) => setTimeout(r, 100));
  c.close(); // gone before beginAction resolved
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(f.sent.filter((x) => x.method === 'Input.dispatchMouseEvent').length, 0, 'the click was NOT dispatched for a client that left');
  assert.equal(ended, 1, 'and the lease it took was ended');
});

test('captureView is told when the agent has an Emulation.setDeviceMetricsOverride in force on the tab, and when it is cleared (a hidden screenshot cannot honour it)', async () => {
  const seen: Array<boolean | undefined> = [];
  const f = fake({ beginAction: async () => ({ end: () => undefined }), captureView: async (_t, _p, info) => { seen.push(info?.deviceMetricsOverride); return 'IMG'; } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  await c.call('Page.captureScreenshot', { format: 'png' }, sid);
  await c.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true }, sid);
  await c.call('Page.captureScreenshot', { format: 'png' }, sid);
  await c.call('Emulation.clearDeviceMetricsOverride', {}, sid);
  await c.call('Page.captureScreenshot', { format: 'png' }, sid);
  assert.deepEqual(seen, [false, true, false]);
});

test('D1 an Input.* command that is never acknowledged (DPMS off / a lock: the renderer gets no frame to ack it) is refused with the window\'s own answer after INPUT_ACK_MS — not left to hang to the 6 s bound (#406)', async () => {
  let asked = 0;
  const f = fake({ beginAction: async () => ({ end: () => undefined }), delays: { 'Input.dispatchMouseEvent': Infinity }, windowDark: async () => { asked++; return 'the Orchestra window is not painting right now (DARK)'; } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  const t0 = Date.now();
  const r = await c.call('Input.dispatchMouseEvent', { type: 'mouseWheel' }, sid);
  assert.match(r.error?.message ?? '', /not painting right now \(DARK\)/);
  assert.ok(Date.now() - t0 >= 900 && Date.now() - t0 < 1600, `after the ack bound (${Date.now() - t0} ms)`);
  assert.equal(asked, 1);
  assert.deepEqual(f.events.filter((e) => e.startsWith('end')), ['end:t2'], 'and the lease ended');
});

test('D1 a slow acknowledgement on a PAINTING window is waited for (the window says it is not dark), and a prompt one never asks (#406)', async () => {
  let asked = 0;
  const f = fake({ beginAction: async () => ({ end: () => undefined }), delays: { 'Input.insertText': 1500 }, windowDark: async () => { asked++; return null; } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't2');
  const r = await c.call('Input.insertText', { text: 'a' }, sid);
  assert.equal(r.error, undefined, 'answered after 1.5 s, not refused');
  assert.equal(asked, 1);
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown' }, sid);
  await c.call('Runtime.evaluate', {}, sid);
  assert.equal(asked, 1, 'a prompt Input.* and a non-input command never ask');
});

test('S2-F2 the screenshot of the tab the human has IN FRONT is bounded the same way: a window that paints nothing refuses it after INPUT_ACK_MS instead of hanging to the 5 s "no frame" (#406)', async () => {
  let asked = 0;
  const f = fake({ beginAction: async () => ({ end: () => undefined }), delays: { 'Page.captureScreenshot': Infinity }, windowDark: async () => { asked++; return 'the Orchestra window is not painting right now (DARK)'; } });
  const core = new CdpProxyCore(f.port);
  const c = client(core);
  const sid = await attachTo(core, c, 't1'); // t1 is the active (visible) tab
  const t0 = Date.now();
  const r = await c.call('Page.captureScreenshot', { format: 'png' }, sid);
  assert.match(r.error?.message ?? '', /not painting right now \(DARK\)/);
  assert.ok(Date.now() - t0 >= 900 && Date.now() - t0 < 1700, `after the ack bound (${Date.now() - t0} ms)`);
  assert.equal(asked, 1);
});
