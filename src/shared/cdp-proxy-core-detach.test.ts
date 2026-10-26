// A command in flight on an auto-attached child that dies is never answered by Chromium (Electron keeps the promise until the whole debugger detaches):
// the proxy settles it when it announces the child's detach (ledger #405, seat-1 `tchurn`: agent-browser's attach-time chain wedged for its whole timeout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpProxyCore, type CdpEventListener, type CdpPanelPort, type CdpTab, type CdpTabChannel, type CdpTabEvent } from './cdp-proxy-core.ts';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

/** A debugger whose commands only settle when the test says so (a command on a dead child simply never does). */
class HeldChannel implements CdpTabChannel {
  sent: Array<{ method: string; sessionId?: string; settle: (r: unknown) => void }> = [];
  listeners = new Set<CdpEventListener>();
  detachers = new Set<(r: string) => void>();
  send(method: string, _params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> {
    const d = deferred<unknown>();
    this.sent.push({ method, ...(sessionId ? { sessionId } : {}), settle: d.resolve });
    return d.promise;
  }
  subscribe(l: CdpEventListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onDetach(l: (r: string) => void) { this.detachers.add(l); return () => this.detachers.delete(l); }
  emit(method: string, params: unknown, sessionId?: string) { for (const l of [...this.listeners]) l(method, params, sessionId); }
  detach(reason: string) { for (const d of [...this.detachers]) d(reason); }
  last(method: string, sessionId?: string) { return [...this.sent].reverse().find((s) => s.method === method && s.sessionId === sessionId); }
}

function setup() {
  const tab: CdpTab = { id: 't1', url: 'http://a/', title: 'A', active: true, openedBy: 'human' };
  const ch = new HeldChannel();
  const subs = new Set<(e: CdpTabEvent) => void>();
  const refused: string[] = []; // every command the policy hook was asked about (it sees a command only if the core routed it to a live tab session)
  const port: CdpPanelPort = {
    listTabs: () => [{ ...tab }],
    subscribeTabs: (l) => { subs.add(l); return () => subs.delete(l); },
    acquire: async () => ch,
    release: () => undefined,
    activateTab: () => undefined,
    userAgent: () => 'UA',
    invalidate: () => undefined,
    captureFallback: async () => '',
    framesError: () => null,
    refuseMethod: (method) => { refused.push(method); return null; },
  };
  const core = new CdpProxyCore(port, { nonce: 'n' });
  return { core, ch, emitTab: (e: CdpTabEvent) => { for (const s of [...subs]) s(e); }, tab, refused };
}

/** A client that records everything it receives (in order) and awaits replies by id. */
function client(core: CdpProxyCore) {
  const inbox: any[] = [];
  const waiters = new Map<number, (m: any) => void>();
  const c = core.connect({ send: (m) => { inbox.push(m); const w = waiters.get(m.id as number); if (w) w(m); } });
  let n = 0;
  const call = (method: string, params?: object, sessionId?: string) => {
    const id = ++n;
    const p = new Promise<any>((res) => waiters.set(id, res));
    void c.message(JSON.stringify({ id, method, params, sessionId }));
    return { id, reply: p };
  };
  return { call, inbox, close: () => c.close() };
}

async function attached(core: CdpProxyCore, ch: HeldChannel) {
  const c = client(core);
  const { targetInfos } = (await c.call('Target.getTargets').reply).result;
  const attach = c.call('Target.attachToTarget', { targetId: targetInfos[0].targetId, flatten: true });
  const { sessionId } = (await attach.reply).result;
  const child = (sid: string) => ch.emit('Target.attachedToTarget', { sessionId: sid, targetInfo: { type: 'iframe' }, waitingForDebugger: true }, undefined);
  const gone = (sid: string) => ch.emit('Target.detachedFromTarget', { sessionId: sid, targetId: 'X' }, undefined);
  return { c, root: sessionId as string, child, gone };
}
const tick = () => new Promise((r) => setImmediate(r));
/** A reply that never comes must fail THIS test (as 'WEDGED'), not park the runner until the event loop empties and cancels the whole file. */
const answered = async (p: Promise<any>, ms = 1500): Promise<any> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise((r) => { t = setTimeout(() => r({ wedged: true }), ms); })]);
  } finally {
    clearTimeout(t);
  }
};

test('a command in flight on a child that detaches is answered "Session with given id not found." — after the client saw the detach', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  const cmd = c.call('Runtime.enable', {}, 'CH1');
  await tick();
  assert.equal(ch.sent.filter((s) => s.sessionId === 'CH1').length, 1, 'forwarded to the debugger on the child session');
  gone('CH1'); // Chromium never answers `Runtime.enable`
  const reply = await answered(cmd.reply);
  assert.ok(!reply.wedged, 'the command in flight on the dead child was never answered');
  assert.deepEqual(reply.error, { code: -32000, message: 'Session with given id not found.' });
  assert.equal(reply.sessionId, 'CH1');
  const iDetach = c.inbox.findIndex((m) => m.method === 'Target.detachedFromTarget' && m.params?.sessionId === 'CH1');
  const iReply = c.inbox.findIndex((m) => m.id === cmd.id);
  assert.ok(iDetach >= 0 && iReply > iDetach, `detach event (#${iDetach}) comes before the error reply (#${iReply})`);
});

test('the incident: a serial client chain (runIfWaitingForDebugger → Page.enable → Runtime.enable) on a child that dies mid-chain COMPLETES', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  const chain = (async () => {
    const out: string[] = [];
    for (const m of ['Runtime.runIfWaitingForDebugger', 'Page.enable', 'Runtime.enable', 'Network.enable']) {
      const call = c.call(m, {}, 'CH1');
      await tick();
      const sent = ch.last(m, 'CH1');
      if (m === 'Runtime.enable') gone('CH1'); // the child dies with this one in flight
      else sent?.settle({});
      const r = await answered(call.reply, 400);
      if (r.wedged) { out.push(`${m}:WEDGED`); break; }
      out.push(`${m}:${r.error ? 'error' : 'ok'}`);
    }
    return out;
  })();
  const done = await chain;
  assert.deepEqual(done, ['Runtime.runIfWaitingForDebugger:ok', 'Page.enable:ok', 'Runtime.enable:error', 'Network.enable:error']);
});

test('Chromium answering late, after the abort, produces no second reply', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  const cmd = c.call('Page.enable', {}, 'CH1');
  await tick();
  const sent = ch.last('Page.enable', 'CH1')!;
  gone('CH1');
  assert.ok(!(await answered(cmd.reply)).wedged, 'the command in flight on the dead child was never answered');
  sent.settle({});
  await tick();
  assert.equal(c.inbox.filter((m) => m.id === cmd.id).length, 1);
});

test('a sibling child\'s detach settles neither another child\'s nor the root session\'s in-flight commands', async () => {
  const { core, ch } = setup();
  const { c, root, child, gone } = await attached(core, ch);
  child('CH1'); child('CH2');
  const onOther = c.call('Page.enable', {}, 'CH2');
  const onRoot = c.call('Runtime.evaluate', { expression: '1' }, root);
  await tick();
  gone('CH1');
  await tick();
  assert.equal(c.inbox.filter((m) => m.id === onOther.id || m.id === onRoot.id).length, 0, 'still waiting for the debugger');
  ch.last('Page.enable', 'CH2')!.settle({ ok: 'child' });
  ch.last('Runtime.evaluate', undefined)!.settle({ ok: 'root' });
  assert.deepEqual((await onOther.reply).result, { ok: 'child' });
  assert.deepEqual((await onRoot.reply).result, { ok: 'root' });
});

test('a reply that arrives BEFORE the detach is delivered as the answer; the later detach changes nothing', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  const cmd = c.call('Page.getFrameTree', {}, 'CH1');
  await tick();
  ch.last('Page.getFrameTree', 'CH1')!.settle({ frameTree: 1 });
  assert.deepEqual((await cmd.reply).result, { frameTree: 1 });
  gone('CH1');
  await tick();
  assert.equal(c.inbox.filter((m) => m.id === cmd.id).length, 1);
});

test('a command sent AFTER the detach is refused at once and never reaches the debugger (the existing path, pinned)', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  gone('CH1');
  const cmd = c.call('Page.enable', {}, 'CH1');
  assert.equal((await cmd.reply).error.message, 'Session with given id not found.');
  assert.equal(ch.sent.filter((s) => s.sessionId === 'CH1').length, 0);
});

test('two clients on the tab: only the one whose command was in flight gets the error reply', async () => {
  const { core, ch } = setup();
  const a = await attached(core, ch);
  const b = await attached(core, ch);
  a.child('CH1');
  const cmd = a.c.call('Runtime.enable', {}, 'CH1');
  await tick();
  a.gone('CH1');
  assert.ok((await answered(cmd.reply)).error, 'the command in flight on the dead child was never answered');
  assert.equal(b.c.inbox.filter((m) => m.error).length, 0);
});

test('a late event carrying a detached child\'s session id does not bring it back: a command on it is refused at once, not forwarded', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  gone('CH1');
  ch.emit('Runtime.executionContextDestroyed', {}, 'CH1'); // the child set learns children from any event that carries a session id
  const cmd = c.call('Page.enable', {}, 'CH1');
  const r = await answered(cmd.reply);
  assert.ok(!r.wedged, 'the command on the dead child was forwarded into the void and never answered');
  assert.equal(r.error.message, 'Session with given id not found.');
  assert.equal(ch.sent.filter((s) => s.sessionId === 'CH1').length, 0);
});

// The whole debugger going away (tab replaced by #400, destroyed, DevTools took it): the old TabState is dropped and unsubscribed, so no child detach will ever
// arrive for what is in flight on its children — the proxy settles those commands itself.
for (const how of ['debugger detach', 'replaced', 'destroyed'] as const) {
  test(`${how}: a command in flight on a child is answered, behind the client's session detach — and a later command on that child never reaches the (new) debugger`, async () => {
    const { core, ch, emitTab, tab } = setup();
    const { c, root, child } = await attached(core, ch);
    child('CH1');
    const cmd = c.call('Runtime.enable', {}, 'CH1');
    await tick();
    assert.equal(ch.sent.filter((s) => s.sessionId === 'CH1').length, 1);
    if (how === 'debugger detach') ch.detach('target closed');
    else emitTab({ kind: how, tab });
    const r = await answered(cmd.reply);
    assert.ok(!r.wedged, 'the command in flight on the child was never answered');
    assert.equal(r.error.message, 'Session with given id not found.');
    const iDetach = c.inbox.findIndex((m) => m.method === 'Target.detachedFromTarget' && m.params?.sessionId === root);
    const iReply = c.inbox.findIndex((m) => m.id === cmd.id);
    assert.ok(iDetach >= 0 && iReply > iDetach, `the root session's detach (#${iDetach}) comes before the error reply (#${iReply})`);
    const late = c.call('Page.enable', {}, 'CH1');
    assert.equal((await answered(late.reply)).error?.message, 'Session with given id not found.');
    assert.equal(ch.sent.filter((s) => s.sessionId === 'CH1' && s.method === 'Page.enable').length, 0);
  });
}

test('a late event carrying a retired child\'s session id does not bring it back: the policy hook never sees a command on it', async () => {
  const { core, ch, refused } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  gone('CH1');
  ch.emit('Runtime.executionContextDestroyed', {}, 'CH1');
  const r = await answered(c.call('Page.enable', {}, 'CH1').reply);
  assert.equal(r.error?.message, 'Session with given id not found.');
  assert.deepEqual(refused.filter((m) => m === 'Page.enable'), [], 'the child was re-admitted: its command reached the policy hook');
  assert.equal(ch.sent.filter((s) => s.sessionId === 'CH1').length, 0);
});

// #397 F4's history lookup (`Page.getNavigationHistory`) is a command in flight on the child like any other, and `st` is stale after its await.
test('Page.navigateToHistoryEntry on a user tab\'s child that dies during the history lookup is answered "Session with given id not found." — not left hanging, not refused as an internal URL', async () => {
  const { core, ch } = setup();
  const { c, child, gone } = await attached(core, ch);
  child('CH1');
  const cmd = c.call('Page.navigateToHistoryEntry', { entryId: 1 }, 'CH1');
  await tick();
  assert.equal(ch.sent.filter((s) => s.method === 'Page.getNavigationHistory' && s.sessionId === 'CH1').length, 1, 'the lookup went to the child');
  gone('CH1');
  const r = await answered(cmd.reply);
  assert.ok(!r.wedged, 'the history lookup on the dead child was never answered');
  assert.equal(r.error?.message, 'Session with given id not found.');
  assert.equal(ch.sent.filter((s) => s.method === 'Page.navigateToHistoryEntry').length, 0, 'the navigation itself was never forwarded');
});

test('Page.navigateToHistoryEntry: a tab replaced while its history is looked up is refused ("Target closed.") and nothing is forwarded through the stale state', async () => {
  const { core, ch, emitTab, tab } = setup();
  const { c, root } = await attached(core, ch);
  const cmd = c.call('Page.navigateToHistoryEntry', { entryId: 1 }, root);
  await tick();
  const lookup = ch.last('Page.getNavigationHistory', undefined)!;
  emitTab({ kind: 'replaced', tab });
  lookup.settle({ entries: [{ id: 1, url: 'http://fine.example/' }] }); // the OLD debugger's late answer
  const r = await answered(cmd.reply);
  assert.equal(r.error?.message, 'Target closed.');
  assert.equal(ch.sent.filter((s) => s.method === 'Page.navigateToHistoryEntry').length, 0);
});
