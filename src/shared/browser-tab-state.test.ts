// #393 — persisted tabs: what survives a restart and the defensive parse (a corrupt file is a fresh start, never a boot crash).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserTabsFile, parsePersistedTabs, restorableUrl, serializeBrowserTabsFile, snapshotTabs, tabLabel } from './browser-tab-state.ts';

test('restorableUrl: web and file URLs restore; about:blank, javascript:, chrome:, data:, non-strings and junk restore as a blank tab', () => {
  assert.equal(restorableUrl('https://a.example/x?y=1#z'), 'https://a.example/x?y=1#z');
  assert.equal(restorableUrl('http://127.0.0.1:8080/p'), 'http://127.0.0.1:8080/p');
  assert.equal(restorableUrl('file:///tmp/a.html'), 'file:///tmp/a.html');
  for (const bad of ['about:blank', '', 'javascript:alert(1)', 'chrome://gpu', 'data:text/html,x', 'view-source:https://a', 42, null, undefined, {}]) {
    assert.equal(restorableUrl(bad), '', String(bad));
  }
});

test('snapshotTabs: keeps order, URLs and openers; the active tab becomes an index', () => {
  const s = snapshotTabs(
    [
      { id: 't1', url: 'https://a/', openedBy: 'human' },
      { id: 't2', url: 'https://b/', openedBy: 'agent' },
      { id: 't3', url: 'https://c/', openedBy: 'human' },
    ],
    't2',
  );
  assert.deepEqual(s, { tabs: [{ url: 'https://a/', openedBy: 'human' }, { url: 'https://b/', openedBy: 'agent' }, { url: 'https://c/', openedBy: 'human' }], activeIndex: 1 });
});

test('snapshotTabs: an unknown active id falls back to index 0; an unsafe URL is blanked but the tab is kept (3 tabs in, 3 tabs out)', () => {
  const s = snapshotTabs([{ id: 't1', url: 'javascript:1', openedBy: 'human' }, { id: 't2', url: '', openedBy: 'human' }], 'gone');
  assert.equal(s.tabs.length, 2);
  assert.equal(s.tabs[0].url, '');
  assert.equal(s.activeIndex, 0);
});

test('snapshotTabs: never writes more than the cap', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, url: 'https://x/', openedBy: 'human' as const }));
  assert.equal(snapshotTabs(many, 't0').tabs.length, 8);
});

test('round trip: serialize -> parse returns exactly the snapshot (3 tabs, the same active one)', () => {
  const snap = snapshotTabs(
    [
      { id: 't1', url: 'https://a/', openedBy: 'human' },
      { id: 't2', url: 'https://b/', openedBy: 'human' },
      { id: 't3', url: 'https://c/', openedBy: 'agent' },
    ],
    't3',
  );
  const back = parseBrowserTabsFile(serializeBrowserTabsFile({ w1: snap }));
  assert.deepEqual(back, { w1: snap });
  assert.equal(back.w1.tabs.length, 3);
  assert.equal(back.w1.activeIndex, 2);
});

test('parsePersistedTabs: clamps to the cap, defaults an unknown opener to human, drops non-object tab entries', () => {
  const p = parsePersistedTabs({ tabs: [null, 1, ...Array.from({ length: 20 }, () => ({ url: 'https://x/', openedBy: 'weird' }))], activeIndex: 0 });
  assert.ok(p);
  assert.equal(p!.tabs.length, 8);
  assert.ok(p!.tabs.every((t) => t.openedBy === 'human'));
});

test('parsePersistedTabs: an out-of-range / fractional / non-number activeIndex becomes 0; an empty or missing tab list is null', () => {
  const t = [{ url: 'https://a/', openedBy: 'human' }, { url: 'https://b/', openedBy: 'human' }];
  for (const bad of [5, -1, 0.5, '1', null, undefined]) assert.equal(parsePersistedTabs({ tabs: t, activeIndex: bad })!.activeIndex, 0, String(bad));
  assert.equal(parsePersistedTabs({ tabs: t, activeIndex: 1 })!.activeIndex, 1);
  assert.equal(parsePersistedTabs({ tabs: [], activeIndex: 0 }), null);
  assert.equal(parsePersistedTabs({ activeIndex: 0 }), null);
  assert.equal(parsePersistedTabs(null), null);
  assert.equal(parsePersistedTabs('x'), null);
});

test('parseBrowserTabsFile: corrupt, empty or foreign content is an empty map, never a throw', () => {
  for (const text of ['', '{', 'null', '[]', '"x"', '{"workspaces":[]}', '{"workspaces":null}', '{"version":1}']) {
    assert.deepEqual(parseBrowserTabsFile(text), {}, text);
  }
});

test('parseBrowserTabsFile: one bad workspace entry does not lose the good ones', () => {
  const text = JSON.stringify({ version: 1, workspaces: { good: { tabs: [{ url: 'https://a/', openedBy: 'human' }], activeIndex: 0 }, bad: { tabs: 'nope' }, empty: { tabs: [] } } });
  assert.deepEqual(Object.keys(parseBrowserTabsFile(text)), ['good']);
});

test('tabLabel: title wins; else host; else the file name; else "New tab"', () => {
  assert.equal(tabLabel({ title: ' Docs ', url: 'https://a.example/x' }), 'Docs');
  assert.equal(tabLabel({ title: '', url: 'https://a.example:8080/x?y' }), 'a.example:8080');
  assert.equal(tabLabel({ title: '', url: 'file:///srv/pages/index.html' }), 'index.html');
  assert.equal(tabLabel({ title: '', url: '' }), 'New tab');
  assert.equal(tabLabel({ title: '', url: 'not a url' }), 'not a url');
});
