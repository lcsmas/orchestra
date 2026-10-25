// Profils navigateur (#400): the REAL browser-panel.ts over a stubbed `electron` (loader hook, same seam as
// browser-panel-tabs.test.ts) — which session partition every tab of a panel is built on, and what moving a panel
// from one identity to another does to its tabs and views. Mutants: scripts/mutate-browser-profiles.mjs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const STUB = `
const views = (globalThis.__bpViews ??= []);
const sessions = (globalThis.__bpSessions ??= new Map());
class WebContents {
  constructor(view) {
    this._view = view;
    this.destroyed = false; this.closed = 0; this.url = ''; this.title = '';
    this.dbgAttached = false; this.detachCalls = 0; this.loaded = [];
    this.handlers = {};
    this.debugger = {
      attach: () => { this.dbgAttached = true; },
      detach: () => { this.dbgAttached = false; this.detachCalls++; },
      isAttached: () => this.dbgAttached,
      sendCommand: () => Promise.resolve({}),
    };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  }
  isDestroyed() { return this.destroyed; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  once() {} setWindowOpenHandler() {}
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }
  reload() {}
  getURL() { return this.url; } getTitle() { return this.title; }
  close() { this.destroyed = true; this.closed++; this._view.webContents = undefined; }
}
export class WebContentsView {
  constructor(opts) { this.opts = opts; this.webContents = new WebContents(this); this._wc = this.webContents; this.bounds = null; views.push(this); }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
}
export const Menu = { buildFromTemplate: () => ({ popup() {} }) };
export const clipboard = { writeText() {} };
export const shell = { openExternal() {} };
export const session = {
  fromPartition(name) {
    let s = sessions.get(name);
    if (!s) {
      s = { name, uaSets: 0, flushedStorage: 0, flushedCookies: 0, cookieListeners: [],
        setUserAgent() { this.uaSets++; }, getUserAgent: () => 'UA',
        flushStorageData() { this.flushedStorage++; },
        cookies: { on(ev, fn) { s.cookieListeners.push([ev, fn]); }, flushStore() { s.flushedCookies++; return Promise.resolve(); } } };
      sessions.set(name, s);
    }
    return s;
  },
};
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(STUB);
const platformUrl =
  'data:text/javascript,' +
  encodeURIComponent(
    `export const platform = { broadcast(ch, wsId, state) { (globalThis.__bpEvents ??= []).push({ ch, wsId, state }); } };`,
  );
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

const bp = await import('./browser-panel.ts');

const attached = new Set<unknown>();
const saved = new Map<string, unknown>();
bp.initBrowserPanels(
  () => ({ contentView: { addChildView: (v: unknown) => attached.add(v), removeChildView: (v: unknown) => attached.delete(v) } }) as never,
  { load: (ws: string) => (saved.get(ws) as never) ?? null, save: (ws: string, t: unknown) => void (t === null ? saved.delete(ws) : saved.set(ws, t)), flush() {} },
);

const P1 = 'bp-aaaaaaaaaaaa';
const P2 = 'bp-bbbbbbbbbbbb';
const profileByWs = new Map<string, string>();
bp.setBrowserProfileResolver((ws) => profileByWs.get(ws));

let seq = 0;
const used: string[] = [];
const newWs = (profile?: string) => {
  const ws = `ws-prof-${++seq}`;
  used.push(ws);
  if (profile) profileByWs.set(ws, profile);
  return ws;
};
afterEach(() => {
  for (const ws of used.splice(0)) {
    bp.destroyPanel(ws);
    profileByWs.delete(ws);
  }
  assert.equal(attached.size, 0, 'a composited view leaked past destroyPanel');
});
const RECT = { x: 1, y: 2, width: 640, height: 480 };
const wcOf = (tab: { view: unknown }) => (tab.view as { _wc: any })._wc;
const partitionOf = (tab: { view: unknown }): string => (tab.view as { opts: { webPreferences: { partition: string } } }).opts.webPreferences.partition;
const sessions = () => (globalThis as any).__bpSessions as Map<string, any>;
const openShown = (ws: string) => {
  bp.showPanel(ws);
  bp.setBounds(ws, RECT);
};
const EPH = (ws: string) => `orchestra-browser-${ws}`;
const PERSIST = (id: string) => `persist:orchestra-profile-${id}`;

test('no profile: every tab is on the workspace\'s own EPHEMERAL partition (no persist:), state.profileId absent', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  const parts = bp.listTabs(ws).map((t) => partitionOf(bp.getTab(ws, t.id)!));
  assert.deepEqual(parts, [EPH(ws), EPH(ws)]);
  assert.equal(parts.some((p) => p.startsWith('persist:')), false);
  assert.equal('profileId' in bp.getState(ws), false);
});

test('a workspace with a profile: ALL its tabs — the first, a later one, a restored one — use the profile\'s persist: partition', () => {
  const ws = newWs(P1);
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent', url: 'http://localhost:1/x' });
  bp.createTab(ws, { openedBy: 'human' });
  const parts = bp.listTabs(ws).map((t) => partitionOf(bp.getTab(ws, t.id)!));
  assert.deepEqual(parts, [PERSIST(P1), PERSIST(P1), PERSIST(P1)]);
  assert.equal(bp.getState(ws).profileId, P1);
});

test('two workspaces on one profile share its partition (one cookie jar); a workspace without stays ephemeral and apart', () => {
  const a = newWs(P1);
  const b = newWs(P1);
  const c = newWs();
  for (const w of [a, b, c]) bp.ensurePanel(w);
  assert.equal(partitionOf(bp.getActiveTab(a)!), partitionOf(bp.getActiveTab(b)!));
  assert.notEqual(partitionOf(bp.getActiveTab(c)!), partitionOf(bp.getActiveTab(a)!));
  assert.equal(partitionOf(bp.getActiveTab(c)!), EPH(c));
});

test('tabs RESTORED at the first ensurePanel after boot come back on the profile partition', () => {
  const ws = newWs(P2);
  saved.set(ws, { tabs: [{ url: 'http://localhost:1/a', openedBy: 'human' }, { url: 'http://localhost:1/b', openedBy: 'agent' }], activeIndex: 1 });
  bp.ensurePanel(ws);
  const tabs = bp.listTabs(ws);
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map((t) => partitionOf(bp.getTab(ws, t.id)!)), [PERSIST(P2), PERSIST(P2)]);
  assert.deepEqual(wcOf(bp.getTab(ws, tabs[0].id)!).loaded, ['http://localhost:1/a']);
});

test('reprofilePanel ephemeral → profile: EVERY tab is rebuilt on the new partition — same ids, openers, active tab, URLs reloaded; old views destroyed', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent', url: 'http://localhost:1/two' });
  const t3 = bp.createTab(ws, { openedBy: 'human', url: 'http://localhost:1/three', activate: true });
  bp.navigate(ws, 'http://localhost:1/one', 't1');
  const old = bp.listTabs(ws).map((t) => bp.getTab(ws, t.id)!);
  old[1].debuggerAttached = false;
  const oldWcs = old.map(wcOf);
  assert.equal(partitionOf(t3), EPH(ws));

  const state = bp.reprofilePanel(ws, P1);

  const now = bp.listTabs(ws);
  assert.deepEqual(now.map((t) => [t.id, t.openedBy, t.active]), [['t1', 'human', false], ['t2', 'agent', false], ['t3', 'human', true]], 'ids, openers, active tab kept');
  const fresh = now.map((t) => bp.getTab(ws, t.id)!);
  assert.deepEqual(fresh.map(partitionOf), [PERSIST(P1), PERSIST(P1), PERSIST(P1)]);
  assert.deepEqual(fresh.map((t) => wcOf(t).loaded), [['http://localhost:1/one'], ['http://localhost:1/two'], ['http://localhost:1/three']], 'each tab reloaded at its URL');
  for (const [i, o] of oldWcs.entries()) assert.equal(o.closed, 1, `old tab ${i + 1} destroyed`);
  for (const [i, t] of fresh.entries()) assert.notEqual(t, old[i], 'a NEW view');
  assert.equal(state.profileId, P1);
  assert.equal(bp.getState(ws).profileId, P1);
  assert.equal(attached.size, 1, 'exactly the active tab composited');
  assert.equal(attached.has(bp.getActiveTab(ws)!.view), true, 'and it is the NEW active view, not the destroyed one');
  assert.equal(bp.getActiveTab(ws)!.id, 't3');
  assert.equal((bp.getActiveTab(ws)!.view as { bounds: unknown }).bounds !== null, true, 'the new active view got the panel rect');
});

test('reprofilePanel profile → profile (switch) and profile → ephemeral (detach) rebuild too', () => {
  const ws = newWs(P1);
  openShown(ws);
  const before = bp.getActiveTab(ws)!;
  bp.reprofilePanel(ws, P2);
  assert.equal(partitionOf(bp.getActiveTab(ws)!), PERSIST(P2));
  assert.equal(wcOf(before).closed, 1);
  assert.equal(attached.has(bp.getActiveTab(ws)!.view), true, 'the switched-to view is the composited one');
  bp.reprofilePanel(ws, undefined);
  assert.equal(partitionOf(bp.getActiveTab(ws)!), EPH(ws));
  assert.equal('profileId' in bp.getState(ws), false, 'detached: no profileId in the state');
  assert.equal(attached.size, 1);
});

test('reprofilePanel to the SAME identity is a no-op: no view is rebuilt or destroyed', () => {
  const ws = newWs(P1);
  openShown(ws);
  const tab = bp.getActiveTab(ws)!;
  const viewsBefore = (globalThis as any).__bpViews.length;
  bp.reprofilePanel(ws, P1);
  assert.equal(bp.getActiveTab(ws), tab);
  assert.equal(wcOf(tab).closed, 0);
  assert.equal((globalThis as any).__bpViews.length, viewsBefore);
});

test('a panel that is not open is NOT built by reprofilePanel — it takes the identity from the record at its first ensurePanel', () => {
  const ws = newWs();
  const viewsBefore = (globalThis as any).__bpViews.length;
  const s = bp.reprofilePanel(ws, P1);
  assert.deepEqual(s.tabs, []);
  assert.equal((globalThis as any).__bpViews.length, viewsBefore, 'no view built');
  profileByWs.set(ws, P1); // the host records it on the workspace
  bp.ensurePanel(ws);
  assert.equal(partitionOf(bp.getActiveTab(ws)!), PERSIST(P1));
});

test('a panel moved to a profile keeps NEW tabs on it, and the rebuilt tabs are remembered under their URLs', () => {
  const ws = newWs();
  openShown(ws);
  bp.navigate(ws, 'http://localhost:1/kept', 't1');
  bp.reprofilePanel(ws, P1);
  bp.createTab(ws, { openedBy: 'agent' });
  assert.deepEqual(bp.listTabs(ws).map((t) => partitionOf(bp.getTab(ws, t.id)!)), [PERSIST(P1), PERSIST(P1)]);
  const rec = saved.get(ws) as { tabs: { url: string }[] };
  assert.equal(rec.tabs[0].url, 'http://localhost:1/kept', 'the persisted record still names the page');
});

test('profile sessions are told to flush sign-ins to disk; ephemeral ones are not; flushProfileStorage hits profile partitions only', () => {
  const eph = newWs();
  const prof = newWs(P2);
  bp.ensurePanel(eph);
  bp.ensurePanel(prof);
  assert.equal(sessions().get(EPH(eph)).cookieListeners.length, 0, 'ephemeral session: no cookie watcher');
  assert.deepEqual(sessions().get(PERSIST(P2)).cookieListeners.map((l: any[]) => l[0]), ['changed'], 'profile session: one watcher');
  bp.createTab(prof, { openedBy: 'agent' });
  assert.equal(sessions().get(PERSIST(P2)).cookieListeners.length, 1, 'still ONE watcher after more tabs');
  const e0 = sessions().get(EPH(eph)).flushedStorage;
  bp.flushProfileStorage();
  assert.ok(sessions().get(PERSIST(P2)).flushedStorage >= 1 && sessions().get(PERSIST(P2)).flushedCookies >= 1);
  assert.equal(sessions().get(EPH(eph)).flushedStorage, e0, 'ephemeral partition untouched');
});
