import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMiddleClickPaste, MIDDLE_CLICK_PASTE_WINDOW_MS } from './middle-click-paste.ts';

// Pins the middle-click PRIMARY-selection paste guard used by the composer
// (CmComposer's mousedown/paste domEventHandlers).
//
// Reproduced before fixing: a middle click on the structured-view composer
// inserted the primary selection straight into the prompt. A trackpad on
// `click_method=clickfinger` emits button 2 for a three-finger physical click,
// so this fires by accident with no copy step involved.
//
// Both directions matter: the guard must swallow the click's own paste, and it
// must NOT eat a deliberate Ctrl+V (an over-broad guard breaks paste entirely).

test('paste right after a middle click is swallowed', () => {
  // measured latency in the running app: ~2ms
  assert.equal(isMiddleClickPaste(1000, 1002), true);
});

test('paste with no middle click armed passes through (Ctrl+V)', () => {
  assert.equal(isMiddleClickPaste(null, 1002), false);
});

test('paste at the exact window boundary is still swallowed', () => {
  assert.equal(isMiddleClickPaste(1000, 1000 + MIDDLE_CLICK_PASTE_WINDOW_MS), true);
});

test('paste just past the window passes through', () => {
  assert.equal(isMiddleClickPaste(1000, 1000 + MIDDLE_CLICK_PASTE_WINDOW_MS + 1), false);
});

test('a much later deliberate paste passes through', () => {
  assert.equal(isMiddleClickPaste(1000, 60_000), false);
});

test('a paste BEFORE the armed click is not attributed to it', () => {
  // negative delta (timeStamp origin oddities) must not count as a match
  assert.equal(isMiddleClickPaste(1000, 900), false);
});

test('window is wide enough for jitter but far below a human Ctrl+V gap', () => {
  assert.ok(MIDDLE_CLICK_PASTE_WINDOW_MS >= 100, 'must absorb scheduling jitter');
  assert.ok(MIDDLE_CLICK_PASTE_WINDOW_MS <= 2000, 'must not span a separate deliberate paste');
});
