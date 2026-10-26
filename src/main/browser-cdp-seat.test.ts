// The debugger seat (#398): one attach per contents, shared by every proxy holder; the last holder leaving starts the
// grace period (#395), after which the agent's overrides are reset and the debugger detaches.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  seatAcquire, seatChannel, seatCount, seatForceDetach, seatPending, seatRelease, setSeatTrace, type DebuggerHost,
} from './browser-cdp-seat.ts';

/** A webContents whose debugger behaves like Electron's: a second attach THROWS, detach emits 'detach'. */
function fakeWc() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const w = {
    attached: false, attaches: 0, detaches: 0, destroyed: false, sent: [] as string[], ua: 'UA/normal',
    isDestroyed: () => w.destroyed,
    getUserAgent: () => w.ua,
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
const flush = () => new Promise((r) => setImmediate(r));

test('the control: the fake debugger throws on a second raw attach (so "one attach" below is a real claim)', () => {
  const w = fakeWc();
  w.debugger.attach();
  assert.throws(() => w.debugger.attach(), /already attached/);
});

test('N holders share ONE attach; the last release (grace 0) detaches', () => {
  const w = fakeWc();
  assert.equal(seatAcquire(host(w)), 'attached');
  assert.equal(seatAcquire(host(w)), 'shared');
  seatAcquire(host(w));
  assert.equal(w.attaches, 1);
  assert.equal(seatCount(host(w)), 3);
  assert.equal(seatRelease(host(w), 0), 'kept');
  seatRelease(host(w), 0);
  assert.equal(w.attached, true, 'one holder left: still attached');
  assert.equal(seatRelease(host(w), 0), 'detached');
  assert.deepEqual([w.attached, w.detaches], [false, 1]);
  assert.equal(w.listeners('detach'), 0, 'the seat leaves no listener behind');
  assert.deepEqual(w.sent, [], 'grace 0 detaches without the reset commands');
});

test('re-acquiring after the last release attaches again (no stale seat)', () => {
  const w = fakeWc();
  seatAcquire(host(w)); seatRelease(host(w), 0);
  seatAcquire(host(w));
  assert.deepEqual([w.attaches, w.attached], [2, true]);
  seatRelease(host(w), 0);
});

test('a release without a holder is a no-op (never drives the count negative)', () => {
  const w = fakeWc();
  assert.equal(seatRelease(host(w), 0), 'none');
  seatAcquire(host(w));
  seatRelease(host(w), 0); seatRelease(host(w), 0);
  assert.deepEqual([w.attaches, w.detaches, w.attached], [1, 1, false]);
});

test('the debugger going away under the seat (contents closed) empties it; the next acquire attaches fresh', () => {
  const w = fakeWc();
  seatAcquire(host(w));
  w.attached = false; w.emit('detach', {}, 'target closed');
  assert.equal(seatCount(host(w)), 0);
  seatAcquire(host(w));
  assert.equal(w.attaches, 2);
  seatRelease(host(w), 0);
});

test('force-detach (tab destroyed) drops every hold at once; the next acquire attaches fresh', () => {
  const w = fakeWc();
  seatAcquire(host(w)); seatAcquire(host(w));
  seatForceDetach(host(w));
  assert.deepEqual([w.attached, w.detaches, seatCount(host(w))], [false, 1, 0]);
  seatAcquire(host(w));
  assert.deepEqual([w.attaches, w.attached], [2, true]);
  seatRelease(host(w), 0);
});

test('force-detach on a destroyed contents never throws', () => {
  const w = fakeWc();
  seatAcquire(host(w));
  w.destroyed = true;
  assert.doesNotThrow(() => seatForceDetach(host(w)));
});

test('grace: the last release keeps the debugger, then resets the agent\'s overrides and detaches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = fakeWc();
  seatAcquire(host(w));
  assert.equal(seatRelease(host(w), 15_000), 'pending');
  assert.deepEqual([w.attached, seatPending(host(w))], [true, true], 'still attached during the grace');
  t.mock.timers.tick(14_999);
  assert.equal(w.attached, true);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual([w.attached, w.detaches], [false, 1], 'detached when the grace is over');
  assert.ok(w.sent.includes('Emulation.clearDeviceMetricsOverride') && w.sent.includes('Fetch.disable'), `reset commands sent: ${w.sent.length}`);
  assert.ok(w.sent.length >= 10, 'the whole reset list ran before the detach');
});

test('grace: a holder coming back inside it cancels the reset and the detach', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = fakeWc();
  seatAcquire(host(w));
  seatRelease(host(w), 15_000);
  t.mock.timers.tick(10_000);
  assert.equal(seatAcquire(host(w)), 'shared', 'the seat is still there: nothing was re-attached');
  assert.deepEqual([seatPending(host(w)), w.attaches], [false, 1]);
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual([w.attached, w.detaches, w.sent], [true, 0, []], 'no reset, no detach while a holder is in');
  seatRelease(host(w), 0);
});

test('grace: a holder arriving while the resets are in flight keeps the debugger', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = fakeWc();
  let gate!: () => void;
  const hold = new Promise<void>((r) => (gate = r));
  w.debugger.sendCommand = async (m: string) => { w.sent.push(m); await hold; return {}; };
  seatAcquire(host(w));
  seatRelease(host(w), 1000);
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(w.sent.length >= 1, 'the reset started');
  seatAcquire(host(w)); // the agent is back mid-reset
  gate();
  await flush(); await flush();
  assert.deepEqual([w.attached, w.detaches], [true, 0], 'the late holder kept the debugger');
  assert.equal(w.sent.length, 1, 'and the rest of the reset list was NOT sent over the returning holder\'s state');
  seatRelease(host(w), 0);
});

test('grace: a second release restarts the clock; force-detach cancels it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = fakeWc();
  seatAcquire(host(w)); seatRelease(host(w), 1000);
  t.mock.timers.tick(900);
  seatAcquire(host(w)); seatRelease(host(w), 1000);
  t.mock.timers.tick(900);
  await flush();
  assert.equal(w.attached, true, '900 ms after the second release: still inside the grace');
  seatForceDetach(host(w));
  assert.equal(seatPending(host(w)), false);
  t.mock.timers.tick(5000);
  await flush();
  assert.deepEqual([w.detaches, w.sent], [1, []], 'the timer died with the force-detach: no reset on a closed tab');
});

test('the trace says every transition with the debugger\'s own isAttached', () => {
  const w = fakeWc();
  const lines: string[] = [];
  setSeatTrace((l) => lines.push(l));
  try {
    seatAcquire(host(w), 'seat[w1] t1');
    seatRelease(host(w), 0);
  } finally {
    setSeatTrace(null);
  }
  assert.deepEqual(lines, ['seat[w1] t1 acquire attached isAttached=true', 'seat[w1] t1 release detached isAttached=false']);
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
  seatRelease(host(w), 0);
  assert.deepEqual(reasons, []);
});

test('grace over, NO agent session held the seat: it detaches WITHOUT writing the reset commands to the human\'s tab', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = fakeWc();
  const lines: string[] = [];
  setSeatTrace((l) => lines.push(l));
  try {
    seatAcquire(host(w), 'seat[w1] t1');
    assert.equal(seatRelease(host(w), 15_000, false), 'pending');
    t.mock.timers.tick(15_000);
    await flush();
  } finally {
    setSeatTrace(null);
  }
  assert.deepEqual([w.attached, w.detaches, w.sent], [false, 1, []], 'design mode / legacy tools alone leave nothing to undo');
  assert.ok(lines.some((l) => /grace-over plain/.test(l)) && lines.every((l) => !/grace-over reset/.test(l)), lines.join(' | '));
});

test('the agent mark is sticky: an agent release, then an in-process holder coming and going, still resets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = fakeWc();
  seatAcquire(host(w));
  seatRelease(host(w), 1000, true); // the agent's last session leaves
  t.mock.timers.tick(500);
  seatAcquire(host(w));
  seatRelease(host(w), 1000, false); // design mode pokes the tab inside the grace
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(w.sent.includes('Emulation.clearDeviceMetricsOverride'), 'the agent\'s leftovers are still undone');
  assert.equal(w.attached, false);
});

test('an external detach removes the seat\'s own listener (no listener per re-attach cycle)', () => {
  const w = fakeWc();
  for (let i = 0; i < 4; i++) {
    seatAcquire(host(w));
    w.attached = false; w.emit('detach', {}, 'target closed');
  }
  assert.equal(w.listeners('detach'), 0);
});
