// The debugger seat (#398): one attach per contents, shared by every proxy holder, dropped with the last one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatAcquire, seatChannel, seatCount, seatForceDetach, seatRelease, type DebuggerHost } from './browser-cdp-seat.ts';

/** A webContents whose debugger behaves like Electron's: a second attach THROWS, detach emits 'detach'. */
function fakeWc() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const w = {
    attached: false, attaches: 0, detaches: 0, destroyed: false, sent: [] as string[],
    isDestroyed: () => w.destroyed,
    debugger: {
      attach: () => { if (w.attached) throw new Error('Another debugger is already attached to this WebContents.'); w.attached = true; w.attaches++; },
      detach: () => { w.attached = false; w.detaches++; for (const f of [...(handlers.detach ?? [])]) f({}, 'client disconnected'); },
      isAttached: () => w.attached,
      sendCommand: async (m: string) => { w.sent.push(m); return {}; },
      on: (e: string, f: (...a: any[]) => void) => { (handlers[e] ??= []).push(f); },
      off: (e: string, f: (...a: any[]) => void) => { handlers[e] = (handlers[e] ?? []).filter((x) => x !== f); },
    },
    emit: (e: string, ...a: any[]) => { for (const f of [...(handlers[e] ?? [])]) f(...a); },
    listeners: (e: string) => (handlers[e] ?? []).length,
  };
  return w;
}
const host = (w: ReturnType<typeof fakeWc>): DebuggerHost => w as unknown as DebuggerHost;

test('the control: the fake debugger throws on a second raw attach (so "one attach" below is a real claim)', () => {
  const w = fakeWc();
  w.debugger.attach();
  assert.throws(() => w.debugger.attach(), /already attached/);
});

test('N holders share ONE attach; the last release detaches', () => {
  const w = fakeWc();
  seatAcquire(host(w)); seatAcquire(host(w)); seatAcquire(host(w));
  assert.equal(w.attaches, 1);
  assert.equal(seatCount(host(w)), 3);
  seatRelease(host(w)); seatRelease(host(w));
  assert.equal(w.attached, true, 'one holder left: still attached');
  seatRelease(host(w));
  assert.deepEqual([w.attached, w.detaches], [false, 1]);
  assert.equal(w.listeners('detach'), 0, 'the seat leaves no listener behind');
});

test('re-acquiring after the last release attaches again (no stale seat)', () => {
  const w = fakeWc();
  seatAcquire(host(w)); seatRelease(host(w));
  seatAcquire(host(w));
  assert.deepEqual([w.attaches, w.attached], [2, true]);
  seatRelease(host(w));
});

test('a release without a holder is a no-op (never drives the count negative)', () => {
  const w = fakeWc();
  seatRelease(host(w));
  seatAcquire(host(w));
  seatRelease(host(w)); seatRelease(host(w));
  assert.deepEqual([w.attaches, w.detaches, w.attached], [1, 1, false]);
});

test('the debugger going away under the seat (contents closed) empties it; the next acquire attaches fresh', () => {
  const w = fakeWc();
  seatAcquire(host(w));
  w.attached = false; w.emit('detach', {}, 'target closed');
  assert.equal(seatCount(host(w)), 0);
  seatAcquire(host(w));
  assert.equal(w.attaches, 2);
  seatRelease(host(w));
});

test('force-detach (tab destroyed) drops every hold at once; the next acquire attaches fresh', () => {
  const w = fakeWc();
  seatAcquire(host(w)); seatAcquire(host(w));
  seatForceDetach(host(w));
  assert.deepEqual([w.attached, w.detaches, seatCount(host(w))], [false, 1, 0]);
  seatAcquire(host(w));
  assert.deepEqual([w.attaches, w.attached], [2, true]);
  seatRelease(host(w));
});

test('force-detach on a destroyed contents never throws', () => {
  const w = fakeWc();
  seatAcquire(host(w));
  w.destroyed = true;
  assert.doesNotThrow(() => seatForceDetach(host(w)));
});

test('the channel sends through the debugger without attaching; subscribe/onDetach unsubscribe cleanly', async () => {
  const w = fakeWc();
  const ch = seatChannel(host(w));
  assert.equal(w.attaches, 0, 'building a channel attaches nothing');
  seatAcquire(host(w));
  await ch.send('Runtime.evaluate', { expression: '1' });
  assert.deepEqual(w.sent, ['Runtime.evaluate']);
  const got: string[] = [];
  const off = ch.subscribe((m) => got.push(m));
  w.emit('message', {}, 'Page.loadEventFired', {}, '');
  off();
  w.emit('message', {}, 'Page.frameNavigated', {}, '');
  assert.deepEqual(got, ['Page.loadEventFired']);
  const reasons: string[] = [];
  const offD = ch.onDetach((r) => reasons.push(r));
  offD();
  seatRelease(host(w));
  assert.deepEqual(reasons, []);
});
