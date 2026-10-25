// #393 — the PURE half of the browser tabs: the cap, close ownership, what is active after a close, the popup-route seam. Each arm names the clause it protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TAB_CAP, decideBrowserAutoOpen, decidePopup, decideTabClose, decideTabOpen, type PolicyTab } from './browser-tab-policy.ts';

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

test('decideTabClose: closing a BACKGROUND tab keeps the active tab — wherever it is (first, middle, last), whichever side the closed tab is on', () => {
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '1', tabId: '3', actor: 'human' }), { ok: true, nextActiveId: '1', replaceWithBlank: false });
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '2', tabId: '3', actor: 'human' }), { ok: true, nextActiveId: '2', replaceWithBlank: false });
  assert.deepEqual(decideTabClose({ tabs: tabs('h1 h2 h3'), activeId: '3', tabId: '1', actor: 'human' }), { ok: true, nextActiveId: '3', replaceWithBlank: false });
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

const ev = (activeTabId: string, url: string, loading = false) => ({ activeTabId, url, loading });

test('decideBrowserAutoOpen: the first event with a real url opens the pane; an event with no url never does', () => {
  assert.equal(decideBrowserAutoOpen(undefined, ev('t1', 'https://a/')).open, true);
  assert.equal(decideBrowserAutoOpen(undefined, ev('t1', '')).open, false);
  assert.equal(decideBrowserAutoOpen(undefined, ev('t1', '', true)).open, false, 'a loading blank tab has no url to show');
});

test('decideBrowserAutoOpen (#393 F2): the SAME active (tab, url, loading) again — a background tab\'s title/loading event, the active tab\'s late title — does NOT re-open a pane the user closed', () => {
  const first = decideBrowserAutoOpen(undefined, ev('t3', 'https://c/'));
  const again = decideBrowserAutoOpen(first.next, ev('t3', 'https://c/'));
  assert.equal(again.open, false);
  assert.deepEqual(again.next, first.next);
  // the active tab is mid-load when the user closes the pane: a background tab's event keeps reporting loading=true — no rising edge
  const mid = decideBrowserAutoOpen(undefined, ev('t3', 'https://c/', true));
  assert.equal(decideBrowserAutoOpen(mid.next, ev('t3', 'https://c/', true)).open, false);
});

test('decideBrowserAutoOpen: an agent navigation (new url) or a different active tab re-opens; coming back to a url after a blank state counts as a navigation', () => {
  const k = decideBrowserAutoOpen(undefined, ev('t1', 'https://a/')).next;
  assert.equal(decideBrowserAutoOpen(k, ev('t1', 'https://a/next')).open, true, 'new url');
  assert.equal(decideBrowserAutoOpen(k, ev('t2', 'https://a/')).open, true, 'another tab became active');
  const blank = decideBrowserAutoOpen(k, ev('t1', ''));
  assert.equal(blank.open, false);
  assert.equal(decideBrowserAutoOpen(blank.next, ev('t1', 'https://a/')).open, true, 'same url after a blank state');
});

test('decideBrowserAutoOpen (review MAJOR): an agent navigate / reload to the url the active tab is ALREADY on re-opens the pane — the active tab STARTS loading (rising edge)', () => {
  const idle = decideBrowserAutoOpen(undefined, ev('t1', 'https://a/')).next;
  const started = decideBrowserAutoOpen(idle, ev('t1', 'https://a/', true));
  assert.equal(started.open, true, 'did-start-loading on the same url');
  assert.equal(decideBrowserAutoOpen(started.next, ev('t1', 'https://a/', true)).open, false, 'still loading: no second edge');
  const done = decideBrowserAutoOpen(started.next, ev('t1', 'https://a/', false));
  assert.equal(done.open, false, 'load finished: falling edge never opens');
  assert.equal(decideBrowserAutoOpen(done.next, ev('t1', 'https://a/', true)).open, true, 'the next reload opens again');
});
