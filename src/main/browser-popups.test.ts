// #396 — the gesture tracker and the child-window registry of src/main/browser-popups.ts, over plain fakes (no Electron). The wiring into the
// window-open handler is pinned by browser-panel-popups.test.ts; scripts/mutate-browser-popups.mjs reddens each clause here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePopupWindows,
  closePopupsOpenedBy,
  consumeUserGesture,
  livePopupWindows,
  registerPopupWindow,
  setPopupWindowsVisible,
  trackUserGesture,
  type PopupWindow,
} from './browser-popups.ts';
import { USER_GESTURE_WINDOW_MS } from '../shared/browser-tab-policy.ts';

const fakeWc = () => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return { on: (ev: string, f: (...a: any[]) => void) => (handlers[ev] ||= []).push(f), input: (type: string) => handlers['input-event']?.forEach((f) => f({}, { type })), navigate: () => handlers['did-navigate']?.forEach((f) => f({})), handlers } as any;
};
const fakeWin = (wc: any = fakeWc()) => {
  const w: any = { destroyedFlag: false, log: [] as string[], webContents: wc, closed: [] as (() => void)[] };
  w.isDestroyed = () => w.destroyedFlag;
  w.destroy = () => { w.destroyedFlag = true; w.closed.forEach((f: () => void) => f()); };
  w.once = (_ev: string, f: () => void) => w.closed.push(f);
  w.showInactive = () => w.log.push('showInactive');
  w.hide = () => w.log.push('hide');
  return w;
};

test('gesture: an activating input is a gesture for the next popup, and the popup CONSUMES it', () => {
  const wc = fakeWc();
  let t = 1000;
  trackUserGesture(wc, () => t);
  wc.input('mouseDown');
  assert.equal(consumeUserGesture(wc, t + 10), true);
  assert.equal(consumeUserGesture(wc, t + 20), false, 'one input opens one popup');
});

test('gesture: it expires after the 5 s activation window — 5000 ms still counts, 5001 does not', () => {
  assert.equal(USER_GESTURE_WINDOW_MS, 5000);
  const a = fakeWc(), b = fakeWc();
  trackUserGesture(a, () => 0); trackUserGesture(b, () => 0);
  a.input('keyDown'); b.input('keyDown');
  assert.equal(consumeUserGesture(a, 5000), true);
  assert.equal(consumeUserGesture(b, 5001), false);
});

test('gesture: every activating input counts (mouseDown, keyDown, rawKeyDown, touchEnd); moves, wheel and key-ups never do', () => {
  for (const type of ['mouseDown', 'keyDown', 'rawKeyDown', 'touchEnd']) {
    const wc = fakeWc(); trackUserGesture(wc, () => 0); wc.input(type);
    assert.equal(consumeUserGesture(wc, 1), true, type);
  }
  for (const type of ['mouseMove', 'mouseUp', 'keyUp', 'mouseWheel', 'char', 'touchMove']) {
    const wc = fakeWc(); trackUserGesture(wc, () => 0); wc.input(type);
    assert.equal(consumeUserGesture(wc, 1), false, type);
  }
});

test('gesture: no input -> no gesture; each contents has its own (a click on tab A is not a gesture for tab B)', () => {
  const a = fakeWc(), b = fakeWc();
  trackUserGesture(a, () => 0); trackUserGesture(b, () => 0);
  assert.equal(consumeUserGesture(a, 0), false);
  a.input('mouseDown');
  assert.equal(consumeUserGesture(b, 1), false);
  assert.equal(consumeUserGesture(a, 1), true);
});

test('gesture: a main-frame navigation clears it — a click on page A is no gesture for the page it navigated to', () => {
  const wc = fakeWc();
  trackUserGesture(wc, () => 0);
  wc.input('mouseDown');
  wc.navigate();
  assert.equal(consumeUserGesture(wc, 1), false, 'the new document has no activation');
  wc.input('mouseDown');
  assert.equal(consumeUserGesture(wc, 2), true, 'a click on the NEW page still counts');
});

test('gesture: tracking the same contents twice installs ONE listener', () => {
  const wc = fakeWc();
  trackUserGesture(wc); trackUserGesture(wc);
  assert.equal(wc.handlers['input-event'].length, 1);
  assert.equal(wc.handlers['did-navigate'].length, 1);
});

const popup = (wsOpener: any, over: Partial<PopupWindow> = {}): PopupWindow => ({ win: fakeWin(), opener: wsOpener, openedBy: 'agent', pageInitiated: false, ...over });

test('registry: a closed window leaves it (both through the closed event and through isDestroyed pruning)', () => {
  const p = popup(fakeWc()), q = popup(fakeWc());
  registerPopupWindow('wsR1', p); registerPopupWindow('wsR1', q);
  assert.equal(livePopupWindows('wsR1').length, 2);
  (p.win as any).destroy();
  assert.deepEqual(livePopupWindows('wsR1'), [q]);
  (q.win as any).destroyedFlag = true; // destroyed without the event
  assert.deepEqual(livePopupWindows('wsR1'), []);
});

test('registry: per workspace — closePopupWindows destroys only that workspace\'s windows', () => {
  const p = popup(fakeWc()), q = popup(fakeWc());
  registerPopupWindow('wsR2', p); registerPopupWindow('wsR3', q);
  closePopupWindows('wsR2');
  assert.equal((p.win as any).destroyedFlag, true);
  assert.equal((q.win as any).destroyedFlag, false);
  assert.deepEqual(livePopupWindows('wsR2'), []);
  closePopupWindows('wsR3');
});

test('registry: closePopupsOpenedBy destroys the windows an opener opened and, recursively, theirs — and nobody else\'s', () => {
  const opener = fakeWc(), other = fakeWc();
  const a = popup(opener);
  const b = popup((a.win as any).webContents);
  const c = popup(other);
  for (const p of [a, b, c]) registerPopupWindow('wsR4', p);
  closePopupsOpenedBy('wsR4', opener);
  assert.equal((a.win as any).destroyedFlag, true);
  assert.equal((b.win as any).destroyedFlag, true);
  assert.equal((c.win as any).destroyedFlag, false);
  closePopupWindows('wsR4');
});

test('registry: setPopupWindowsVisible hides on false and shows INACTIVE on true', () => {
  const p = popup(fakeWc());
  registerPopupWindow('wsR5', p);
  setPopupWindowsVisible('wsR5', false);
  setPopupWindowsVisible('wsR5', true);
  assert.deepEqual((p.win as any).log, ['hide', 'showInactive']);
  closePopupWindows('wsR5');
});
