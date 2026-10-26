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
  once(ev, fn) { (this.onceH ||= {})[ev] = ((this.onceH ||= {})[ev] || []).concat(fn); }
  setWindowOpenHandler() {}
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve(); }
  reload() {}
  getURL() { return this.url; } getTitle() { return this.title; }
  close() {
    this.destroyed = true; this.closed++; this._view.webContents = undefined;
    // real Electron closes ASYNC: 'destroyed' fires later, when the harness releases it (globalThis.__bpHoldClose) or right away
    const fire = () => { for (const f of (this.onceH?.destroyed || [])) f(); };
    if (globalThis.__bpHoldClose) (globalThis.__bpHeld ??= []).push(fire); else fire();
  }
}
export class WebContentsView {
  constructor(opts) {
    if (globalThis.__bpFailNext > 0 && --globalThis.__bpFailNext === 0) throw new Error('stub: cannot build a view');
    this.opts = opts; this.webContents = new WebContents(this); this._wc = this.webContents; this.bounds = null; views.push(this); }
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
        cookies: { on(ev, fn) { s.cookieListeners.push([ev, fn]); }, set(d) { (s.cookieSets ??= []).push(d); return Promise.resolve(); }, flushStore() { s.flushedCookies++; return Promise.resolve(); } } };
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

test('a view that cannot be built leaves the panel EXACTLY as it was: old tabs alive, old identity, old view composited, error surfaced', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent', url: 'http://localhost:1/two' });
  bp.createTab(ws, { openedBy: 'human', url: 'http://localhost:1/three', activate: true });
  const before = bp.listTabs(ws).map((t) => bp.getTab(ws, t.id)!);
  const viewsBefore = (globalThis as any).__bpViews.length;
  (globalThis as any).__bpFailNext = 2; // the 2nd view of the rebuild throws
  assert.throws(() => bp.reprofilePanel(ws, P1), /cannot build a view/);
  (globalThis as any).__bpFailNext = 0;
  const after = bp.listTabs(ws).map((t) => bp.getTab(ws, t.id)!);
  assert.deepEqual(after, before, 'the very same tabs');
  for (const t of before) assert.equal(wcOf(t).closed, 0, 'no old view destroyed');
  assert.deepEqual(after.map(partitionOf), [EPH(ws), EPH(ws), EPH(ws)], 'old partition');
  assert.equal('profileId' in bp.getState(ws), false, 'old identity');
  assert.equal(attached.size, 1);
  assert.equal(attached.has(bp.getActiveTab(ws)!.view), true, 'the OLD active view is the composited one');
  assert.equal(bp.getActiveTab(ws)!.id, 't3');
  // the one new view that WAS built before the failure was closed again (no leak)
  const built = (globalThis as any).__bpViews.slice(viewsBefore);
  assert.equal(built.length, 1);
  assert.equal(built[0]._wc.closed, 1, 'the half-built replacement was destroyed');
  // and the panel still works: a later, successful move goes through
  bp.reprofilePanel(ws, P1);
  assert.deepEqual(bp.listTabs(ws).map((t) => partitionOf(bp.getTab(ws, t.id)!)), [PERSIST(P1), PERSIST(P1), PERSIST(P1)]);
});

test('workspacesOnProfile lists the OPEN panels that run on a profile — by what the views do, not by a record', () => {
  const a = newWs(P1), b = newWs(P1), c = newWs(P2), d = newWs();
  for (const w of [a, b, c, d]) bp.ensurePanel(w);
  assert.deepEqual(bp.workspacesOnProfile(P1).sort(), [a, b].sort());
  assert.deepEqual(bp.workspacesOnProfile(P2), [c]);
  bp.reprofilePanel(a, undefined);
  assert.deepEqual(bp.workspacesOnProfile(P1), [b]);
  assert.deepEqual(bp.workspacesOnProfile('bp-cccccccccccc'), []);
});

test('settleClosedViews waits for the views a re-profile closed to be really destroyed (async unload), but never longer than its timeout', { timeout: 8000 }, async () => {
  const ws = newWs();
  openShown(ws);
  (globalThis as any).__bpHoldClose = true;
  (globalThis as any).__bpHeld = [];
  bp.reprofilePanel(ws, P1); // closes the old view; its 'destroyed' is held back
  let settled = false;
  const waiting = bp.settleClosedViews(5000).then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(settled, false, 'still waiting while the old view has not finished closing');
  (globalThis as any).__bpHoldClose = false;
  for (const fire of (globalThis as any).__bpHeld.splice(0)) fire();
  await waiting;
  assert.equal(settled, true, 'released once the view is destroyed');
  // a view that never finishes closing cannot block a delete forever
  (globalThis as any).__bpHoldClose = true;
  bp.reprofilePanel(ws, undefined);
  const t0 = Date.now();
  await bp.settleClosedViews(60);
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 2000, `gave up after its timeout (${Date.now() - t0} ms)`);
  (globalThis as any).__bpHoldClose = false;
  for (const fire of (globalThis as any).__bpHeld.splice(0)) fire();
  await bp.settleClosedViews(10);
});

const cookieEvent = (sesName: string, cookie: Record<string, unknown>, removed = false) => {
  const ses = sessions().get(sesName);
  for (const [, fn] of ses.cookieListeners) fn({}, cookie, 'explicit', removed);
  return ses;
};
const SESSION_COOKIE = { name: 'sid', value: 'v1', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' };

test('PROFILE partition: a session cookie is re-set with a sliding ~30-day expiry (Electron would drop it at quit); a cookie with an expiry or a removal is left alone', () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const t0 = Date.now() / 1000;
  const ses = cookieEvent(PERSIST(P1), SESSION_COOKIE);
  assert.equal(ses.cookieSets?.length, 1, 'one promotion');
  const d = ses.cookieSets[0];
  assert.deepEqual([d.url, d.name, d.value, d.path], ['http://127.0.0.1/', 'sid', 'v1', '/']);
  assert.ok(d.expirationDate >= t0 + 30 * 86400 - 5 && d.expirationDate <= t0 + 30 * 86400 + 5, `expiry ${d.expirationDate - t0}s ahead`);
  assert.equal('domain' in d, false, 'host-only stays host-only');
  cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, session: false, expirationDate: t0 + 99 }); // the promoted copy coming back: no loop
  cookieEvent(PERSIST(P1), SESSION_COOKIE, true); // a removal (logout): nothing re-created
  assert.equal(ses.cookieSets.length, 1, 'still just the one promotion');
});

test('EPHEMERAL partition: session cookies are never promoted (no listener at all)', () => {
  const ws = newWs();
  bp.ensurePanel(ws);
  const ses = sessions().get(EPH(ws));
  assert.equal(ses.cookieListeners.length, 0);
  assert.equal(ses.cookieSets, undefined);
});

test('panelProfileId reads what an OPEN panel runs on — a pure read that never builds a panel', () => {
  const eph = newWs(), prof = newWs(P1), none = newWs(P1);
  bp.ensurePanel(eph);
  bp.ensurePanel(prof);
  const viewsBefore = (globalThis as any).__bpViews.length;
  assert.equal(bp.panelProfileId(prof), P1);
  assert.equal(bp.panelProfileId(eph), undefined);
  assert.equal(bp.panelProfileId(none), undefined, 'a workspace with no panel yet: nothing to read, nothing built');
  assert.equal((globalThis as any).__bpViews.length, viewsBefore);
  bp.reprofilePanel(prof, undefined);
  assert.equal(bp.panelProfileId(prof), undefined, 'follows a re-profile');
});
