// #393 — the PURE half of the browser tabs: the cap, close ownership, what is active after a close, the popup-route seam. Each arm names the clause it protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TAB_CAP, decideBrowserAutoOpen, decidePopup, decideTabClose, decideTabOpen, isOsHandoffUrl, POPUP_BUDGET, POPUP_RATE_MAX, POPUP_RATE_WINDOW_MS, popupNeedsOpener, USER_GESTURE_WINDOW_MS, type PolicyTab, type PopupContext, type PopupRequest } from './browser-tab-policy.ts';

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

// ---- popups (#396) — every routing clause has an arm that names it; scripts/mutate-browser-popups.mjs reddens each one -------------------------------

const click = (over: Partial<PopupRequest> = {}): PopupRequest => ({ url: 'https://app.example/page', frameName: '', disposition: 'foreground-tab', features: '', userGesture: true, ...over });
const script = (over: Partial<PopupRequest> = {}): PopupRequest => click({ userGesture: false, ...over });
const room: PopupContext = { openTabs: 1, openWindows: 0, pageInitiatedOpen: 0 };

test('popup constants: budget of 3 page-initiated popups, Chromium\'s 5 s activation window', () => {
  assert.equal(POPUP_BUDGET, 3);
  assert.equal(USER_GESTURE_WINDOW_MS, 5000);
});

test('route: a clicked `_blank` link (foreground, unnamed) opens a NEW TAB and activates it', () => {
  assert.deepEqual(decidePopup(click(), room), { route: 'new-tab', activate: true, pageInitiated: false });
});

test('route: a literal `_blank` name is still a tab (not a named window)', () => {
  assert.deepEqual(decidePopup(click({ frameName: '_blank' }), room), { route: 'new-tab', activate: true, pageInitiated: false });
  assert.deepEqual(decidePopup(click({ frameName: '_BLANK' }), room), { route: 'new-tab', activate: true, pageInitiated: false });
});

test('route: a ctrl/middle click (background-tab) opens a tab WITHOUT activating it', () => {
  assert.deepEqual(decidePopup(click({ disposition: 'background-tab' }), room), { route: 'new-tab', activate: false, pageInitiated: false });
});

test('route: an unnamed popup opened with no gesture is a tab, never activated, and marked page-initiated', () => {
  assert.deepEqual(decidePopup(script(), room), { route: 'new-tab', activate: false, pageInitiated: true });
});

test('route: a NAMED popup (the page addresses it by name — OAuth) is a native CHILD WINDOW that keeps its opener', () => {
  assert.deepEqual(decidePopup(click({ frameName: 'oauth' }), room), { route: 'child-window', pageInitiated: false });
  assert.deepEqual(decidePopup(click({ frameName: 'oauth', disposition: 'foreground-tab' }), room), { route: 'child-window', pageInitiated: false });
});

test('route: a SIZED popup (disposition new-window, e.g. width/height features) is a child window even when unnamed', () => {
  assert.deepEqual(decidePopup(click({ disposition: 'new-window', features: 'width=500,height=600' }), room), { route: 'child-window', pageInitiated: false });
});

test('route: a features-less `new-window` (a shift-clicked link) is a TAB, not a sized popup', () => {
  assert.deepEqual(decidePopup(click({ disposition: 'new-window' }), room), { route: 'new-tab', activate: true, pageInitiated: false });
  assert.equal(decidePopup(click({ disposition: 'new-window', features: '  ' }), room).route, 'new-tab');
  assert.equal(decidePopup(click({ disposition: 'new-window', features: 'popup' }), room).route, 'child-window', 'any feature makes it a popup window');
});

test('route: the special targets `_self` `_parent` `_top` are not names a page waits on — they route as a tab', () => {
  for (const frameName of ['_self', '_parent', '_top']) assert.equal(decidePopup(click({ frameName }), room).route, 'new-tab', frameName);
});

test('route: an explicit `noopener` feature wins — a tab even when named or sized (no opener to keep)', () => {
  assert.equal(decidePopup(click({ frameName: 'oauth', features: 'noopener' }), room).route, 'new-tab');
  assert.equal(decidePopup(click({ disposition: 'new-window', features: 'width=500,noopener,height=600' }), room).route, 'new-tab');
  assert.equal(decidePopup(click({ frameName: 'x', features: 'NoOpener=yes' }), room).route, 'new-tab');
});

test('route: `noopener=0|no|false` does NOT deny the opener', () => {
  for (const f of ['noopener=0', 'noopener=no', 'noopener=false']) assert.equal(decidePopup(click({ frameName: 'oauth', features: f }), room).route, 'child-window', f);
});

test('route: the Auth0 shape — window.open("", "name", sized) -> about:blank — is a child window; a bare about:blank is a tab', () => {
  assert.equal(decidePopup(click({ url: 'about:blank', frameName: 'auth0:authorize:popup', disposition: 'new-window', features: 'width=400' }), room).route, 'child-window');
  assert.equal(decidePopup(click({ url: 'about:blank' }), room).route, 'new-tab');
});

test('route: a page-initiated child window is marked page-initiated (it draws on the budget)', () => {
  assert.deepEqual(decidePopup(script({ frameName: 'oauth' }), room), { route: 'child-window', pageInitiated: true });
});

test('popupNeedsOpener: the table', () => {
  const t = (r: Partial<PopupRequest>) => popupNeedsOpener({ frameName: '', disposition: 'foreground-tab', features: '', ...r });
  assert.equal(t({}), false);
  assert.equal(t({ frameName: 'w' }), true);
  assert.equal(t({ disposition: 'new-window', features: 'width=400' }), true);
  assert.equal(t({ disposition: 'new-window' }), false);
  assert.equal(t({ disposition: 'background-tab' }), false);
  assert.equal(t({ frameName: 'w', features: 'noopener' }), false);
});

test('cap: tabs + popup windows share the cap of 8 — a tab-route and a window-route popup are both refused AT it, gesture or not', () => {
  for (const req of [click(), script(), click({ frameName: 'oauth' }), script({ frameName: 'oauth' })]) {
    const d = decidePopup(req, { openTabs: 8, openWindows: 0, pageInitiatedOpen: 0 });
    assert.equal(d.route, 'refuse');
    if (d.route === 'refuse') { assert.equal(d.reason, 'cap'); assert.match(d.message, /at most 8/); }
  }
});

test('cap: open windows count against it — 5 tabs + 3 windows is full, 5 + 2 still has one slot', () => {
  assert.equal(decidePopup(click(), { openTabs: 5, openWindows: 3, pageInitiatedOpen: 0 }).route, 'refuse');
  assert.equal(decidePopup(click(), { openTabs: 5, openWindows: 2, pageInitiatedOpen: 0 }).route, 'new-tab');
  assert.equal(decidePopup(click(), { openTabs: 7, openWindows: 0, pageInitiatedOpen: 0 }).route, 'new-tab');
});

test('budget: a page-initiated popup is refused once 3 are already open, and allowed with 2', () => {
  const d = decidePopup(script(), { openTabs: 1, openWindows: 0, pageInitiatedOpen: 3 });
  assert.equal(d.route, 'refuse');
  if (d.route === 'refuse') { assert.equal(d.reason, 'budget'); assert.match(d.message, /at most 3 popups/); }
  assert.equal(decidePopup(script(), { openTabs: 1, openWindows: 0, pageInitiatedOpen: 2 }).route, 'new-tab');
  assert.equal(decidePopup(script({ frameName: 'oauth' }), { openTabs: 1, openWindows: 0, pageInitiatedOpen: 3 }).route, 'refuse');
});

test('budget: a user-gesture popup does NOT draw on the budget (only the cap bounds it)', () => {
  assert.equal(decidePopup(click(), { openTabs: 1, openWindows: 0, pageInitiatedOpen: 3 }).route, 'new-tab');
  assert.equal(decidePopup(click({ frameName: 'oauth' }), { openTabs: 1, openWindows: 0, pageInitiatedOpen: 99 }).route, 'child-window');
});

test('cap + budget compose: a storm of page-initiated popups stops at min(budget, cap - open)', () => {
  const run = (openTabs: number) => {
    let open = openTabs, page = 0, opened = 0;
    for (let i = 0; i < 100; i++) {
      const d = decidePopup(script(), { openTabs: open, openWindows: 0, pageInitiatedOpen: page });
      if (d.route === 'new-tab') { open++; page++; opened++; }
    }
    return opened;
  };
  assert.equal(run(1), 3, 'budget binds on a roomy workspace');
  assert.equal(run(7), 1, 'the cap binds near it');
  assert.equal(run(8), 0);
});

test('OS hand-off is an ALLOWLIST of mailto:/tel: — every other scheme is refused outright, with or without a gesture (an agent\'s CDP click is a click)', () => {
  const unsafe = [
    'javascript:alert(1)', 'JAVASCRIPT:1', 'vbscript:msgbox(1)', 'data:text/html,<b>x', 'file:///etc/passwd', 'blob:https://x/1', 'about:srcdoc', 'chrome://settings',
    'chrome-untrusted://x', 'devtools://devtools/bundled/inspector.html', 'view-source:https://x', 'filesystem:https://x/t/a', 'not a url',
    // registered OS handlers a prompt-injected page + an agent click could otherwise launch
    'ssh://root@host', 'smb://host/share', 'zoommtg://zoom.us/join?confno=1', 'slack://channel?id=1', 'vscode://file/etc/passwd', 'steam://run/1', 'x-apple.systempreferences:', 'intent://x#Intent;end', 'ftp://x/y',
  ];
  for (const url of unsafe) {
    for (const userGesture of [true, false]) {
      const d = decidePopup(click({ url, userGesture }), room);
      assert.equal(d.route, 'refuse', url);
      if (d.route === 'refuse') assert.equal(d.reason, 'unsafe-url', url);
    }
  }
});

test('external schemes: a clicked mailto:/tel: goes to the OS; the same without a gesture is refused', () => {
  for (const url of ['mailto:a@b.c', 'MAILTO:a@b.c', 'tel:+33123456789']) {
    assert.deepEqual(decidePopup(click({ url }), room), { route: 'external' }, url);
    const d = decidePopup(script({ url }), room);
    assert.equal(d.route, 'refuse', url);
    if (d.route === 'refuse') assert.equal(d.reason, 'no-gesture-external', url);
  }
});

test('a `webContents` feature is refused (Electron would hand the factory a string for the real guest): any position, spacing, with or without a gesture; other keys are not', () => {
  for (const features of ['webContents=x', 'width=500,webContents=1,height=600', ' webContents = y ', 'webContents']) {
    for (const userGesture of [true, false]) {
      const d = decidePopup(click({ frameName: 'oauth', disposition: 'new-window', features, userGesture }), room);
      assert.equal(d.route, 'refuse', features);
      if (d.route === 'refuse') assert.equal(d.reason, 'unsafe-features', features);
    }
  }
  for (const features of ['webContentsX=1', 'WEBCONTENTS=1', 'width=500,height=600', 'noopener']) {
    assert.notEqual(decidePopup(click({ frameName: 'oauth', disposition: 'new-window', features }), room).route, 'refuse', features);
  }
});

test('rate: page-initiated popups OPENED per minute are capped even when each one is closed again (the budget alone is concurrent); user-gesture popups are not rate-limited', () => {
  const churned = { openTabs: 1, openWindows: 0, pageInitiatedOpen: 0, recentPageInitiated: 6 };
  const d = decidePopup(script(), churned);
  assert.equal(d.route, 'refuse');
  if (d.route === 'refuse') { assert.equal(d.reason, 'rate'); assert.match(d.message, /at most 6 popups per minute/); }
  assert.equal(decidePopup(script({ frameName: 'oauth' }), churned).route, 'refuse', 'the window route too');
  assert.equal(decidePopup(script(), { ...churned, recentPageInitiated: 5 }).route, 'new-tab', 'one below the cap');
  assert.equal(decidePopup(click(), { ...churned, recentPageInitiated: 99 }).route, 'new-tab', 'a click is bounded by the user');
  assert.equal(POPUP_RATE_MAX, 6);
  assert.equal(POPUP_RATE_WINDOW_MS, 60_000);
});

test('name in use: a named popup is refused while a window of that name was opened by ANOTHER opener (Electron\'s frame-name registry is global and would load the URL into it); a tab-route and an unnamed popup are not', () => {
  const held = { ...room, nameHeldByOtherOpener: true };
  const d = decidePopup(click({ frameName: 'oauth' }), held);
  assert.equal(d.route, 'refuse');
  if (d.route === 'refuse') assert.equal(d.reason, 'name-in-use');
  assert.equal(decidePopup(click({ frameName: 'oauth', disposition: 'new-window', features: 'width=400' }), held).route, 'refuse');
  assert.equal(decidePopup(click(), held).route, 'new-tab', 'unnamed: no registry entry involved');
  assert.equal(decidePopup(click({ frameName: 'oauth', features: 'noopener' }), held).route, 'new-tab', 'noopener -> a tab we build ourselves');
  assert.equal(decidePopup(click({ frameName: 'oauth' }), { ...room, nameHeldByOtherOpener: false }).route, 'child-window');
});

test('classifyUrl trims: surrounding whitespace never hides a scheme or turns a web URL into a refusal', () => {
  assert.equal(decidePopup(click({ url: '  https://x.example/a  ' }), room).route, 'new-tab');
  const d = decidePopup(click({ url: '  javascript:alert(1)' }), room);
  assert.equal(d.route, 'refuse');
  assert.deepEqual(decidePopup(click({ url: ' mailto:a@b.c ' }), room), { route: 'external' });
});

test('http and https are both web; the scheme match is case-insensitive', () => {
  for (const url of ['http://127.0.0.1:1/', 'HTTPS://EXAMPLE.COM/x']) assert.equal(decidePopup(click({ url }), room).route, 'new-tab', url);
});

test('the cap and budget are overridable (callers/tests pass their own numbers)', () => {
  assert.equal(decidePopup(click(), { openTabs: 2, openWindows: 0, pageInitiatedOpen: 0, cap: 2 }).route, 'refuse');
  assert.equal(decidePopup(script(), { openTabs: 1, openWindows: 0, pageInitiatedOpen: 1, budget: 1 }).route, 'refuse');
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

test('isOsHandoffUrl — the ONE allowlist behind the popup path AND the session `openExternal` permission: mailto:/tel: (any case, surrounding whitespace) and nothing else', () => {
  for (const u of ['mailto:a@b.c', 'MAILTO:a@b.c', ' tel:+33123456789 ', 'Tel:1']) assert.equal(isOsHandoffUrl(u), true, u);
  for (const u of ['', 'ssh://x', 'zoommtg://x', 'smb://x', 'slack://x', 'vscode://x', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://x/', 'http://x/', 'about:blank', 'xmailto:a@b.c', 'mailto', 'tel']) assert.equal(isOsHandoffUrl(u), false, u || '(empty)');
});
