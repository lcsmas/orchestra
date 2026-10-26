// #396 — the gesture tracker and the child-window registry of src/main/browser-popups.ts, over plain fakes (no Electron). The wiring into the
// window-open handler is pinned by browser-panel-popups.test.ts; scripts/mutate-browser-popups.mjs reddens each clause here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePopupWindows,
  forgetPopupRate,
  frameNameHeldByOther,
  notePageInitiatedOpen,
  recentPageInitiatedOpens,
  closePopupsOpenedBy,
  consumeUserGesture,
  livePopupWindows,
  registerPopupWindow,
  setPopupWindowsVisible,
  trackUserGesture,
  type PopupWindow,
} from './browser-popups.ts';
import { POPUP_RATE_WINDOW_MS, USER_GESTURE_WINDOW_MS } from '../shared/browser-tab-policy.ts';

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

const popup = (wsOpener: any, over: Partial<Omit<PopupWindow, 'id'>> = {}): Omit<PopupWindow, 'id'> => ({ win: fakeWin(), opener: wsOpener, openedBy: 'agent', pageInitiated: false, frameName: '', ...over });

test('registry: a closed window leaves it (both through the closed event and through isDestroyed pruning)', () => {
  const p = registerPopupWindow('wsR1', popup(fakeWc())), q = registerPopupWindow('wsR1', popup(fakeWc()));
  assert.equal(livePopupWindows('wsR1').length, 2);
  (p.win as any).destroy();
  assert.deepEqual(livePopupWindows('wsR1'), [q]);
  (q.win as any).destroyedFlag = true; // destroyed without the event
  assert.deepEqual(livePopupWindows('wsR1'), []);
});

test('registry: per workspace — closePopupWindows destroys only that workspace\'s windows', () => {
  const p = registerPopupWindow('wsR2', popup(fakeWc())), q = registerPopupWindow('wsR3', popup(fakeWc()));
  closePopupWindows('wsR2');
  assert.equal((p.win as any).destroyedFlag, true);
  assert.equal((q.win as any).destroyedFlag, false);
  assert.deepEqual(livePopupWindows('wsR2'), []);
  closePopupWindows('wsR3');
});

test('registry: closePopupsOpenedBy destroys the windows an opener opened and, recursively, theirs — and nobody else\'s', () => {
  const opener = fakeWc(), other = fakeWc();
  const a = registerPopupWindow('wsR4', popup(opener));
  const b = registerPopupWindow('wsR4', popup((a.win as any).webContents));
  const c = registerPopupWindow('wsR4', popup(other));
  closePopupsOpenedBy('wsR4', opener);
  assert.equal((a.win as any).destroyedFlag, true);
  assert.equal((b.win as any).destroyedFlag, true);
  assert.equal((c.win as any).destroyedFlag, false);
  closePopupWindows('wsR4');
});

test('registry: setPopupWindowsVisible hides on false and shows INACTIVE on true', () => {
  const p = registerPopupWindow('wsR5', popup(fakeWc()));
  setPopupWindowsVisible('wsR5', false);
  setPopupWindowsVisible('wsR5', true);
  assert.deepEqual((p.win as any).log, ['hide', 'showInactive']);
  closePopupWindows('wsR5');
});

test('registry: each window gets a stable, never-reused id (the memory attribution names it); destroyed windows\' ids are not handed out again', () => {
  const a = registerPopupWindow('wsR6', popup(fakeWc())), b = registerPopupWindow('wsR6', popup(fakeWc()));
  assert.match(a.id, /^w\d+$/);
  assert.notEqual(a.id, b.id);
  (a.win as any).destroy();
  const c = registerPopupWindow('wsR6', popup(fakeWc()));
  assert.notEqual(c.id, a.id);
  assert.notEqual(c.id, b.id);
  closePopupWindows('wsR6');
});

test('frame names: a live popup named N is "held by another" for every OTHER opener — other workspace or the same one — never for its own opener; unnamed and destroyed ones hold nothing', () => {
  const tabA = fakeWc(), tabB = fakeWc(), otherWsTab = fakeWc();
  const p = registerPopupWindow('wsN1', popup(tabA, { frameName: 'oauth' }));
  registerPopupWindow('wsN1', popup(tabA, { frameName: '' }));
  assert.equal(frameNameHeldByOther('oauth', otherWsTab), true, 'another workspace');
  assert.equal(frameNameHeldByOther('oauth', tabB), true, 'another tab of the SAME workspace (a hostile tab must not retarget the holder\'s popup)');
  assert.equal(frameNameHeldByOther('oauth', tabA), false, 'the holder itself may reuse its own popup');
  assert.equal(frameNameHeldByOther(' oauth ', tabB), true, 'trimmed like the registry key');
  assert.equal(frameNameHeldByOther('other', tabB), false);
  assert.equal(frameNameHeldByOther('', tabB), false, 'an unnamed popup never collides');
  (p.win as any).destroy();
  assert.equal(frameNameHeldByOther('oauth', tabB), false, 'a closed popup frees its name');
  closePopupWindows('wsN1');
});

test('rate: page-initiated opens are counted per workspace inside a sliding window, pruned on read, and forgotten with the workspace', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) notePageInitiatedOpen('wsT1', t0 + i * 1000);
  notePageInitiatedOpen('wsT2', t0);
  assert.equal(recentPageInitiatedOpens('wsT1', t0 + 5000), 4);
  assert.equal(recentPageInitiatedOpens('wsT2', t0 + 5000), 1, 'per workspace');
  assert.equal(recentPageInitiatedOpens('wsT1', t0 + POPUP_RATE_WINDOW_MS - 1), 4, 'just inside the window');
  assert.equal(recentPageInitiatedOpens('wsT1', t0 + POPUP_RATE_WINDOW_MS), 3, 'the oldest fell out at exactly the window length');
  assert.equal(recentPageInitiatedOpens('wsT1', t0 + POPUP_RATE_WINDOW_MS + 10_000), 0, 'all gone');
  assert.equal(recentPageInitiatedOpens('wsNever', t0), 0);
  forgetPopupRate('wsT2');
  assert.equal(recentPageInitiatedOpens('wsT2', t0 + 1), 0);
  notePageInitiatedOpen('wsT3', t0);
  closePopupWindows('wsT3');
  assert.equal(recentPageInitiatedOpens('wsT3', t0 + 1), 0, 'closePopupWindows (delete / archive) forgets the history too');
});
