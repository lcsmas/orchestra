// #393 — the PURE half of the browser tabs: the cap, close ownership, what is active after a close, the popup-route seam. Each arm names the clause it protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TAB_CAP, decidePopup, decideTabClose, decideTabOpen, type PolicyTab } from './browser-tab-policy.ts';

const tabs = (spec: string): PolicyTab[] => spec.split(' ').map((s) => ({ id: s.slice(1), openedBy: s[0] === 'h' ? 'human' : 'agent' }));

test('cap: 8 tabs per workspace, human and agent combined', () => {
  assert.equal(BROWSER_TAB_CAP, 8);
});

test('decideTabOpen: below the cap is allowed for either opener', () => {
  for (const opener of ['human', 'agent'] as const) {
    assert.deepEqual(decideTabOpen({ openCount: 0, opener }), { ok: true });
    assert.deepEqual(decideTabOpen({ openCount: 7, opener }), { ok: true });
  }
});

test('decideTabOpen: AT the cap (8) is refused with a reason, the numbers and a human-readable message — for the human and the agent alike', () => {
  for (const opener of ['human', 'agent'] as const) {
    const d = decideTabOpen({ openCount: 8, opener });
    assert.equal(d.ok, false);
    if (d.ok) return;
    assert.equal(d.reason, 'cap');
    assert.equal(d.cap, 8);
    assert.equal(d.open, 8);
    assert.match(d.message, /at most 8 browser tabs/);
  }
});

test('decideTabOpen: the cap is combined — 5 human + 3 agent tabs is 8 and refuses a 9th of either kind (the caller counts ALL tabs)', () => {
  const held = tabs('h1 h2 h3 h4 h5 a6 a7 a8');
  assert.equal(decideTabOpen({ openCount: held.length, opener: 'human' }).ok, false);
  assert.equal(decideTabOpen({ openCount: held.length, opener: 'agent' }).ok, false);
});

test('decideTabOpen: an explicit cap overrides the default (and a count above it still refuses)', () => {
  assert.equal(decideTabOpen({ openCount: 2, opener: 'human', cap: 2 }).ok, false);
  assert.equal(decideTabOpen({ openCount: 1, opener: 'human', cap: 2 }).ok, true);
  assert.equal(decideTabOpen({ openCount: 11, opener: 'human' }).ok, false);
});

test('decideTabClose: the human closes any tab, including one the agent opened', () => {
  const t = tabs('h1 a2 h3');
  for (const id of ['1', '2', '3']) assert.equal(decideTabClose({ tabs: t, activeId: '1', tabId: id, actor: 'human' }).ok, true);
});

test('decideTabClose: an agent closes a tab it opened', () => {
  assert.equal(decideTabClose({ tabs: tabs('h1 a2'), activeId: '1', tabId: '2', actor: 'agent' }).ok, true);
});

test('decideTabClose: an agent is REFUSED a tab the human opened — reason not-owner, message names the rule, nothing else decided', () => {
  const d = decideTabClose({ tabs: tabs('h1 a2'), activeId: '1', tabId: '1', actor: 'agent' });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, 'not-owner');
  assert.match(d.message, /only the tabs it opened/);
});

test('decideTabClose: an agent is refused the human tab even when it is the LAST tab (ownership is checked before the last-tab rule)', () => {
  const d = decideTabClose({ tabs: tabs('h1'), activeId: '1', tabId: '1', actor: 'agent' });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'not-owner');
});

test('decideTabClose: an unknown tab id is refused as unknown-tab (a stale id never addresses another tab)', () => {
  const d = decideTabClose({ tabs: tabs('h1 h2'), activeId: '1', tabId: '9', actor: 'human' });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'unknown-tab');
});

test('decideTabClose: closing a BACKGROUND tab keeps the active tab', () => {
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '1', tabId: '3', actor: 'human' }), { ok: true, nextActiveId: '1', replaceWithBlank: false });
});

test('decideTabClose: closing the ACTIVE tab activates its right neighbour', () => {
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '2', tabId: '2', actor: 'human' }), { ok: true, nextActiveId: '3', replaceWithBlank: false });
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '1', tabId: '1', actor: 'human' }), { ok: true, nextActiveId: '2', replaceWithBlank: false });
});

test('decideTabClose: closing the active LAST-in-order tab activates its left neighbour', () => {
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '3', tabId: '3', actor: 'human' }), { ok: true, nextActiveId: '2', replaceWithBlank: false });
});

test('decideTabClose: closing the ONLY tab replaces it with a blank one — the panel never has zero tabs', () => {
  assert.deepEqual(decideTabClose({ tabs: tabs('h1'), activeId: '1', tabId: '1', actor: 'human' }), { ok: true, nextActiveId: null, replaceWithBlank: true });
});

test('decideTabClose: an agent closing its own only tab also gets the blank replacement', () => {
  assert.deepEqual(decideTabClose({ tabs: tabs('a1'), activeId: '1', tabId: '1', actor: 'agent' }), { ok: true, nextActiveId: null, replaceWithBlank: true });
});

test('decidePopup (#396 seam): today a web URL stays in the opener view and a non-web URL goes to the OS — whatever the target name, disposition or gesture', () => {
  const base = { frameName: '', disposition: 'foreground-tab', features: '' };
  assert.deepEqual(decidePopup({ ...base, url: 'https://example.com/x' }), { route: 'same-view' });
  assert.deepEqual(decidePopup({ ...base, url: 'http://127.0.0.1:1/' }), { route: 'same-view' });
  assert.deepEqual(decidePopup({ ...base, url: 'mailto:a@b.c' }), { route: 'external' });
  assert.deepEqual(decidePopup({ ...base, url: 'javascript:alert(1)' }), { route: 'external' });
  assert.deepEqual(decidePopup({ ...base, url: 'https://x/', frameName: '_blank', userGesture: false }), { route: 'same-view' });
});
