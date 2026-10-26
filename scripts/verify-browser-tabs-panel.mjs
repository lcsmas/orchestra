// #393 — the main-process tab layer of the browser panel, without launching Electron (same loader-hook pattern as
// verify-browser-panel-focus-steal.mjs): the cap refuses BEFORE a view exists (no leak), close ownership, the last-tab
// rule, only the active tab composited, tabs persisted and restored across a "restart", destroy forgets, popup routing.
// Each arm names the clause it protects; scripts/verify-browser-tabs-panel-mutants.mjs reddens every one.
// Run: node --experimental-strip-types scripts/verify-browser-tabs-panel.mjs   (exit 0 = all pass)

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';

const STUB = `
const S = (globalThis.__tabsStub ??= { views: [], opened: [] });
class WebContents {
  constructor() {
    this.destroyed = false; this.url = ''; this.handlers = {}; this.openHandler = null; this.loads = [];
    this.debugger = { attach(){}, detach(){}, isAttached: () => false, sendCommand: () => Promise.resolve({}) };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack(){}, goForward(){} };
  }
  isDestroyed() { return this.destroyed; }
  on(ev, fn) { (this.handlers[ev] ??= []).push(fn); }
  once() {}
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  loadURL(u) { this.loads.push(u); if (globalThis.__tabsStub.errorPage) { this.url = 'chrome-error://chromewebdata/'; (this.handlers['did-navigate'] ?? []).forEach((f) => f({}, this.url)); return Promise.resolve(); } if (!globalThis.__tabsStub.holdLoads) this.url = u; (this.handlers['did-navigate'] ?? []).forEach((f) => f({}, this.url)); return Promise.resolve(); }
  reload() {} close() { this.destroyed = true; }
  getURL() { return this.url; } getTitle() { return ''; }
  capturePage() { return Promise.resolve({ toJPEG: () => Buffer.from('jpeg') }); }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(); this.bounds = null; S.views.push(this); }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
}
export const Menu = { buildFromTemplate: () => ({ popup(){} }) };
export const clipboard = { writeText(){} };
export const shell = { openExternal(u){ S.opened.push(u); } };
export const session = { fromPartition: () => ({ setUserAgent(){}, getUserAgent: () => 'UA' }) };
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(STUB);
const platformUrl = 'data:text/javascript,' + encodeURIComponent(`export const platform = { broadcast() {} };`);
const loggerUrl = 'data:text/javascript,' + encodeURIComponent(`export const log = { info(){}, warn(){}, debug(){}, error(){} };`);

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === 'electron') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
        if (spec.endsWith('/platform') || spec === './platform') return { url: ${JSON.stringify(platformUrl)}, shortCircuit: true };
        if (spec.endsWith('/logger') || spec === './logger') return { url: ${JSON.stringify(loggerUrl)}, shortCircuit: true };
        return next(spec, ctx);
      }
    `),
  pathToFileURL('./'),
);

const S = (globalThis.__tabsStub ??= { views: [], opened: [] });
const panelUrl = pathToFileURL(new URL('../src/main/browser-panel.ts', import.meta.url).pathname).href;
const storeUrl = pathToFileURL(new URL('../src/main/browser-tabs-store.ts', import.meta.url).pathname).href;
const { createBrowserTabsStore } = await import(storeUrl);
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

function boot(tag, persistence) {
  return import(`${panelUrl}?boot=${tag}`).then((bp) => {
    const attached = new Set();
    const win = { contentView: { addChildView: (v) => attached.add(v), removeChildView: (v) => attached.delete(v) } };
    bp.initBrowserPanels(() => win, persistence);
    return { bp, attached };
  });
}
const live = () => S.views.filter((v) => !v.webContents.destroyed).length;

// ---- cap, ownership, last tab, composition ------------------------------------------------------------------------
{
  const { bp, attached } = await boot('a');
  const W = 'ws-cap';
  bp.showPanel(W);
  bp.setBounds(W, { x: 0, y: 0, width: 800, height: 600 });

  await check('the panel starts with exactly one human tab (t-initial) and one live view', () => {
    assert.strictEqual(bp.listTabs(W).length, 1);
    assert.strictEqual(bp.listTabs(W)[0].openedBy, 'human');
    assert.strictEqual(live(), 1);
  });

  await check('cap: the human opens tabs up to 8 (7 more succeed, each activated)', () => {
    for (let i = 0; i < 7; i++) {
      const r = bp.tryOpenTab(W, { openedBy: 'human', activate: true });
      assert.strictEqual(r.ok, true, `open #${i + 2} refused: ${r.message}`);
    }
    assert.strictEqual(bp.listTabs(W).length, 8);
  });

  await check('cap: the 9th tab is REFUSED with reason cap and a message, for the human AND the agent — and NO view is created (no leak)', () => {
    const before = S.views.length;
    for (const openedBy of ['human', 'agent']) {
      const r = bp.tryOpenTab(W, { openedBy, url: 'https://x.example/' });
      assert.strictEqual(r.ok, false, `${openedBy} was allowed a 9th tab`);
      assert.strictEqual(r.reason, 'cap');
      assert.match(r.message, /at most 8/);
    }
    assert.strictEqual(S.views.length, before, `a refused open created ${S.views.length - before} view(s)`);
    assert.strictEqual(live(), 8, `live views = ${live()}`);
    assert.strictEqual(bp.listTabs(W).length, 8);
  });

  await check('only the ACTIVE tab is composited: exactly one view attached, and it is the active tab view', () => {
    assert.strictEqual(attached.size, 1, `attached = ${attached.size}`);
    const active = bp.getActiveTab(W);
    assert.ok(attached.has(active.view), 'the attached view is not the active tab view');
    const first = bp.listTabs(W)[0].id;
    const r = bp.tryActivateTab(W, first);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(attached.size, 1);
    assert.ok(attached.has(bp.getTab(W, first).view), 'after activate, the attached view is not the new active tab view');
  });

  await check('activate of an unknown tab id is refused (unknown-tab), the active tab is unchanged', () => {
    const before = bp.getState(W).activeTabId;
    const r = bp.tryActivateTab(W, 'nope');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unknown-tab');
    assert.strictEqual(bp.getState(W).activeTabId, before);
  });

  await check('close ownership: an agent closing a HUMAN tab is refused (not-owner) and the view survives; closing its OWN tab works', () => {
    const humanTab = bp.listTabs(W)[0].id;
    const viewsLive = live();
    const r = bp.tryCloseTab(W, humanTab, 'agent');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-owner');
    assert.strictEqual(live(), viewsLive, 'a refused close destroyed a view');
    assert.ok(bp.getTab(W, humanTab), 'the human tab is gone');
    // free a slot, let the agent open and close its own
    assert.strictEqual(bp.tryCloseTab(W, bp.listTabs(W)[7].id, 'human').ok, true);
    const opened = bp.tryOpenTab(W, { openedBy: 'agent' });
    assert.strictEqual(opened.ok, true);
    const closed = bp.tryCloseTab(W, opened.tabId, 'agent');
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(bp.getTab(W, opened.tabId), undefined);
  });

  await check('closing the ACTIVE tab activates its right neighbour (left when it was last in order)', () => {
    const ids = bp.listTabs(W).map((t) => t.id);
    bp.tryActivateTab(W, ids[1]);
    assert.strictEqual(bp.tryCloseTab(W, ids[1], 'human').state.activeTabId, ids[2]);
    const last = bp.listTabs(W).at(-1).id;
    bp.tryActivateTab(W, last);
    const after = bp.listTabs(W);
    assert.strictEqual(bp.tryCloseTab(W, last, 'human').state.activeTabId, after.at(-2).id);
  });

  await check('the registry follows the POLICY: after tryCloseTab the active tab is exactly decideTabClose(...).nextActiveId, for every position of the closed tab', async () => {
    const { decideTabClose } = await import(pathToFileURL(new URL('../src/shared/browser-tab-policy.ts', import.meta.url).pathname).href);
    for (const [activeIdx, closeIdx] of [[0, 0], [1, 1], [2, 2], [1, 0], [1, 2], [0, 2], [2, 0]]) {
      const WP = `ws-policy-${activeIdx}-${closeIdx}`;
      bp.ensurePanel(WP);
      for (let i = 0; i < 2; i++) bp.tryOpenTab(WP, { openedBy: 'human' });
      const ids = bp.listTabs(WP).map((t) => t.id);
      bp.tryActivateTab(WP, ids[activeIdx]);
      const want = decideTabClose({ tabs: bp.listTabs(WP).map((t) => ({ id: t.id, openedBy: t.openedBy })), activeId: ids[activeIdx], tabId: ids[closeIdx], actor: 'human' });
      const got = bp.tryCloseTab(WP, ids[closeIdx], 'human');
      assert.strictEqual(got.ok, true);
      assert.strictEqual(got.state.activeTabId, want.nextActiveId, `active ${activeIdx}, closed ${closeIdx}: registry ${got.state.activeTabId} vs policy ${want.nextActiveId}`);
    }
  });

  await check('closing the LAST tab leaves ONE fresh blank human tab (the panel is not evicted, ids are not reused)', () => {
    const W2 = 'ws-last';
    bp.showPanel(W2);
    bp.setBounds(W2, { x: 0, y: 0, width: 800, height: 600 });
    const only = bp.listTabs(W2)[0].id;
    const r = bp.tryCloseTab(W2, only, 'human');
    assert.strictEqual(r.ok, true);
    const tabs = bp.listTabs(W2);
    assert.strictEqual(tabs.length, 1, `tabs after closing the last = ${tabs.length}`);
    assert.notStrictEqual(tabs[0].id, only, 'the closed id was reused');
    assert.strictEqual(tabs[0].openedBy, 'human');
    assert.strictEqual(tabs[0].url, '');
    assert.strictEqual(tabs[0].active, true);
    assert.ok(bp.getPanel(W2), 'the panel was evicted');
  });

  await check('an agent is refused the human LAST tab too (ownership before the last-tab rule)', () => {
    const W3 = 'ws-last-agent';
    bp.ensurePanel(W3);
    const r = bp.tryCloseTab(W3, bp.listTabs(W3)[0].id, 'agent');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-owner');
    assert.strictEqual(bp.listTabs(W3).length, 1);
  });

  await check('popup routing (policy seam): a web URL opened by a page loads in ITS tab; a non-web URL goes to the OS', () => {
    const tab = bp.getActiveTab(W);
    const h = tab.view.webContents.openHandler;
    assert.ok(h, 'no window-open handler installed');
    assert.deepStrictEqual(h({ url: 'https://p.example/x', frameName: '_blank', disposition: 'foreground-tab', features: '' }), { action: 'deny' });
    assert.strictEqual(tab.view.webContents.loads.at(-1), 'https://p.example/x');
    S.opened.length = 0;
    h({ url: 'mailto:a@b.c', frameName: '', disposition: 'foreground-tab', features: '' });
    assert.deepStrictEqual(S.opened, ['mailto:a@b.c']);
  });
}

// ---- persistence across a restart ---------------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-harness-'));
  const file = path.join(dir, 'orchestra', 'browser-tabs.json');
  const W = 'ws-persist';
  const first = await boot('p1', createBrowserTabsStore({ file }));
  first.bp.showPanel(W);
  first.bp.setBounds(W, { x: 0, y: 0, width: 800, height: 600 });
  first.bp.navigate(W, 'https://one.example/a');
  const t2 = first.bp.tryOpenTab(W, { openedBy: 'human', activate: true, url: 'https://two.example/b' });
  const t3 = first.bp.tryOpenTab(W, { openedBy: 'agent', activate: true, url: 'https://three.example/c' });
  first.bp.tryActivateTab(W, t2.tabId);
  await new Promise((r) => setTimeout(r, 20));
  first.bp.flushBrowserTabs();

  await check('persist: 3 tabs with their URLs, openers and the active one are on disk after a flush', () => {
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const e = disk.workspaces[W];
    assert.ok(e, 'no entry for the workspace');
    assert.deepStrictEqual(e.tabs.map((t) => t.url), ['https://one.example/a', 'https://two.example/b', 'https://three.example/c']);
    assert.deepStrictEqual(e.tabs.map((t) => t.openedBy), ['human', 'human', 'agent']);
    assert.strictEqual(e.activeIndex, 1);
  });

  // "restart": a brand-new module instance (empty registry) and a new store reading the same file.
  const viewsBefore = S.views.length;
  const second = await boot('p2', createBrowserTabsStore({ file }));
  second.bp.ensurePanel(W);

  await check('restore: a fresh process gets the same 3 tabs back (URLs loaded, openers kept) with the SAME tab active', () => {
    const tabs = second.bp.listTabs(W);
    assert.strictEqual(tabs.length, 3, `restored ${tabs.length} tabs`);
    assert.deepStrictEqual(tabs.map((t) => t.url), ['https://one.example/a', 'https://two.example/b', 'https://three.example/c']);
    assert.deepStrictEqual(tabs.map((t) => t.openedBy), ['human', 'human', 'agent']);
    assert.strictEqual(tabs.findIndex((t) => t.active), 1, `active index ${tabs.findIndex((t) => t.active)}`);
    assert.strictEqual(S.views.length - viewsBefore, 3, 'restore built a different number of views than tabs');
  });

  await check('restore does not re-save blanks: a restored tab whose load has not committed keeps its remembered URL on the next snapshot', async () => {
    S.holdLoads = true; // loadURL resolves but the "page" never commits (server down at boot)
    const third = await boot('p3', createBrowserTabsStore({ file }));
    third.bp.ensurePanel(W);
    third.bp.tryOpenTab(W, { openedBy: 'human' }); // any state change forces a snapshot while the restored tabs have no URL of their own
    third.bp.flushBrowserTabs();
    S.holdLoads = false;
    const e = JSON.parse(fs.readFileSync(file, 'utf8')).workspaces[W];
    assert.deepStrictEqual(e.tabs.slice(0, 3).map((t) => t.url), ['https://one.example/a', 'https://two.example/b', 'https://three.example/c']);
    assert.strictEqual(e.tabs.length, 4);
  });

  await check('restore: a load that ends on an ERROR page (chrome-error://, server down at boot) keeps the remembered URLs on the next snapshot', async () => {
    S.errorPage = true;
    const fourth = await boot('p3b', createBrowserTabsStore({ file }));
    fourth.bp.ensurePanel(W);
    fourth.bp.tryOpenTab(W, { openedBy: 'human' });
    fourth.bp.flushBrowserTabs();
    S.errorPage = false;
    const e = JSON.parse(fs.readFileSync(file, 'utf8')).workspaces[W];
    assert.deepStrictEqual(e.tabs.slice(0, 3).map((t) => t.url), ['https://one.example/a', 'https://two.example/b', 'https://three.example/c']);
  });

  await check('F1: BARE closeTab on the LAST tab (the #395 host path) forgets the saved tabs — a fresh process opens ONE blank tab, loads nothing', async () => {
    const WL = 'ws-bare-last';
    const s1 = createBrowserTabsStore({ file });
    const one = await boot('p3c', s1);
    one.bp.ensurePanel(WL);
    one.bp.navigate(WL, 'https://closed.example/x');
    one.bp.flushBrowserTabs();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).workspaces[WL]?.tabs[0].url, 'https://closed.example/x', 'control: the URL was on disk before the close');
    one.bp.closeTab(WL, one.bp.listTabs(WL)[0].id);
    one.bp.flushBrowserTabs();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).workspaces[WL], undefined, 'the closed tab is still remembered');
    const viewsBefore = S.views.length;
    const two = await boot('p3d', createBrowserTabsStore({ file }));
    two.bp.ensurePanel(WL);
    const tabs = two.bp.listTabs(WL);
    assert.strictEqual(tabs.length, 1);
    assert.strictEqual(tabs[0].url, '');
    assert.strictEqual(S.views.slice(viewsBefore).flatMap((v) => v.webContents.loads).length, 0, 'the closed URL was reloaded');
  });

  await check('destroyPanel (workspace deleted / archived) forgets the tabs, even when this process never opened the panel', () => {
    const W2 = 'ws-never-opened';
    const store = createBrowserTabsStore({ file });
    store.save(W2, { tabs: [{ url: 'https://z.example/', openedBy: 'human' }], activeIndex: 0 });
    store.flush();
    return boot('p4', createBrowserTabsStore({ file })).then(({ bp }) => {
      bp.destroyPanel(W2); // never ensured in this process
      bp.destroyPanel(W); // opened by an earlier "process" only
      bp.flushBrowserTabs();
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(disk.workspaces[W2], undefined, 'never-opened workspace still remembered');
      assert.strictEqual(disk.workspaces[W], undefined, 'deleted workspace still remembered');
    });
  });

  await check('a corrupt tabs file never breaks the panel: it opens one blank human tab', async () => {
    fs.writeFileSync(file, '{ corrupt');
    const { bp } = await boot('p5', createBrowserTabsStore({ file }));
    bp.ensurePanel('ws-corrupt');
    assert.strictEqual(bp.listTabs('ws-corrupt').length, 1);
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

let failed = 0;
for (const [status, name, msg] of results) {
  if (status === 'FAIL') failed++;
  console.log(`${status}  ${name}${msg ? ` — ${msg}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
