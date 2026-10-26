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
    this.frameUrls = [];
    { const self = this; this.mainFrame = { get framesInSubtree() { if (self.frameBoom) throw new Error('frame tree exploded'); return self.frameUrls.map((url) => ({ url })); } }; }
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
        cookies: { on(ev, fn) { s.cookieListeners.push([ev, fn]); }, removeListener(ev, fn) { s.cookieListeners = s.cookieListeners.filter(([e, f]) => !(e === ev && f === fn)); }, get(filter) { (s.cookieGets ??= []).push(filter); return (s.getGate ?? Promise.resolve()).then(() => (s.liveCookies ?? []).filter((c) => c.name === filter.name)); }, set(d) { (s.cookieSets ??= []).push(d); const dom = d.domain ?? new URL(d.url).hostname; s.liveCookies = (s.liveCookies ?? []).filter((c) => !(c.name === d.name && c.domain === dom && (c.path ?? '/') === d.path)); s.liveCookies.push({ name: d.name, value: d.value, domain: dom, hostOnly: !d.domain, path: d.path, secure: d.secure, httpOnly: d.httpOnly, session: false, expirationDate: d.expirationDate }); if (s.onSet) s.onSet(d); return s.setDelayMs ? new Promise((r) => setTimeout(r, s.setDelayMs)) : Promise.resolve(); },
        remove(url, name) { (s.cookieRemoves ??= []).push({ url, name }); s.liveCookies = (s.liveCookies ?? []).filter((c) => c.name !== name); if (s.onRemove) s.onRemove(name); return Promise.resolve(); }, flushStore() { s.flushedCookies++; return Promise.resolve(); } } };
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
  const waiting = bp.settleClosedViews(5000).then((ok) => { settled = ok; });
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
  assert.equal(await bp.settleClosedViews(60), false, 'reports that it gave up');
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 2000, `gave up after its timeout (${Date.now() - t0} ms)`);
  (globalThis as any).__bpHoldClose = false;
  for (const fire of (globalThis as any).__bpHeld.splice(0)) fire();
  assert.equal(await bp.settleClosedViews(500), true, 'true again once the views are gone');
});

const cookieEvent = (sesName: string, cookie: Record<string, unknown>, removed = false, cause = 'explicit') => {
  const ses = sessions().get(sesName);
  for (const [, fn] of [...ses.cookieListeners]) fn({}, cookie, cause, removed);
  return ses;
};
/** The stub sessions are shared per partition name across arms: forget what an earlier arm recorded on this one. */
const fresh = (ses: any) => { ses.cookieSets = undefined; ses.cookieGets = undefined; ses.cookieRemoves = undefined; ses.liveCookies = undefined; ses.getGate = undefined; ses.onSet = undefined; ses.onRemove = undefined; ses.setDelayMs = undefined; return ses; };
const SESSION_COOKIE = { name: 'sid', value: 'v1', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' };
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms)); // past the 250 ms per-cookie debounce + the re-read

test('PROFILE partition: a session cookie is re-set with a sliding ~30-day expiry — after a debounce, from the LIVE cookie (Electron would drop it at quit)', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  ses.liveCookies = [{ ...SESSION_COOKIE, value: 'v2-newer' }]; // the cookie as it is when the debounce fires, not the event's snapshot
  const t0 = Date.now() / 1000;
  cookieEvent(PERSIST(P1), SESSION_COOKIE);
  assert.equal(ses.cookieSets, undefined, 'nothing set synchronously: debounced');
  await settle();
  assert.equal(ses.cookieSets?.length, 1, 'one promotion');
  const d = ses.cookieSets[0];
  assert.deepEqual([d.url, d.name, d.value, d.path], ['http://127.0.0.1/', 'sid', 'v2-newer', '/'], 'the LIVE value is promoted');
  assert.ok(d.expirationDate >= t0 + 30 * 86400 - 5 && d.expirationDate <= t0 + 30 * 86400 + 5, `expiry ${d.expirationDate - t0}s ahead`);
  assert.equal('domain' in d, false, 'host-only stays host-only');
});

test('PROFILE partition: a removal, an echo of the promoted copy and a cookie that vanished or got an expiry before the debounce fired are NEVER promoted (a logout stays a logout)', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  const t0 = Date.now() / 1000;
  ses.liveCookies = [];
  cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, session: false, expirationDate: t0 + 99 }); // the promoted copy coming back: no loop
  cookieEvent(PERSIST(P1), SESSION_COOKIE, true); // a removal (logout)
  cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, name: 'gone' }); // session cookie in the event … but deleted by the time the debounce fires
  ses.liveCookies = [{ ...SESSION_COOKIE, name: 'rewritten', session: false, expirationDate: t0 + 5 }];
  cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, name: 'rewritten' }); // … or rewritten with an expiry of its own
  await settle();
  assert.equal(ses.cookieSets, undefined, 'nothing promoted at all');
  assert.ok(ses.cookieGets.length >= 2, 'the live cookie WAS re-read before deciding');
});

test('PROFILE partition: a cookie rewritten many times is promoted ONCE per debounce window, not once per rewrite', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  ses.liveCookies = [SESSION_COOKIE];
  for (let i = 0; i < 40; i++) cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, value: `v${i}` });
  await settle();
  assert.equal(ses.cookieSets.length, 1);
  assert.equal(ses.cookieGets.length, 1);
});

test('stopSignInPersistence detaches the listener and cancels pending promotions (a deleted profile must not get a cookie re-created by a late event)', async () => {
  const ws = newWs(P2);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P2)));
  ses.liveCookies = [SESSION_COOKIE];
  cookieEvent(PERSIST(P2), SESSION_COOKIE);
  bp.stopSignInPersistence(PERSIST(P2));
  assert.equal(ses.cookieListeners.length, 0, 'listener removed');
  await settle();
  assert.equal(ses.cookieSets, undefined, 'the pending promotion was cancelled');
  assert.equal(ses.cookieGets, undefined, 'and its timer never fired: not even the live READ was issued after the stop');
  // a later panel on the same partition re-arms it (one listener, again)
  bp.createTab(ws, { openedBy: 'agent' });
  assert.equal(ses.cookieListeners.length, 1);
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

test('EVERY view close is tracked (closeTab, destroyPanel — not only a re-profile): a delete issued right after a tab close still waits for it', async () => {
  const ws = newWs(P1);
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent' });
  (globalThis as any).__bpHoldClose = true;
  (globalThis as any).__bpHeld = [];
  bp.closeTab(ws, 't2');
  assert.equal(await bp.settleClosedViews(60), false, 'the closed tab\'s unload is still pending');
  bp.destroyPanel(ws);
  assert.equal(await bp.settleClosedViews(60), false);
  (globalThis as any).__bpHoldClose = false;
  for (const fire of (globalThis as any).__bpHeld.splice(0)) fire();
  assert.equal(await bp.settleClosedViews(500), true);
});

test('a throw while closing an old view or re-compositing after a committed re-profile does NOT roll the move back: the panel stays on the new partition', () => {
  const ws = newWs();
  openShown(ws);
  bp.createTab(ws, { openedBy: 'agent', url: 'http://localhost:1/two' });
  const olds = bp.listTabs(ws).map((t) => bp.getTab(ws, t.id)!);
  wcOf(olds[0]).close = () => { throw new Error('close exploded'); };
  assert.doesNotThrow(() => bp.reprofilePanel(ws, P1));
  assert.equal(bp.panelProfileId(ws), P1);
  assert.deepEqual(bp.listTabs(ws).map((t) => partitionOf(bp.getTab(ws, t.id)!)), [PERSIST(P1), PERSIST(P1)]);
  assert.equal(wcOf(olds[1]).closed, 1, 'the other old view was still closed');
});

/** Hold the next `cookies.get` open until released: the window between the live READ and the WRITE (review F4). */
function gateReads(ses: any): () => void {
  let release!: () => void;
  ses.getGate = new Promise<void>((r) => (release = r));
  return release;
}

test('F4(B): a REMOVAL (logout) that lands while the live read is in flight is never undone by the write that follows', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  ses.liveCookies = [SESSION_COOKIE];
  const release = gateReads(ses);
  cookieEvent(PERSIST(P1), SESSION_COOKIE);
  await settle(); // the debounce fired: the read is now pending on the gate
  assert.equal(ses.cookieGets.length, 1);
  cookieEvent(PERSIST(P1), SESSION_COOKIE, true); // the site logs the user out
  release();
  await settle();
  assert.equal(ses.cookieSets, undefined, 'the stale read was NOT written back');
});

test('F4(B): a NEWER value that lands while the read is in flight is not overwritten by the stale one — the newer change promotes its own, once', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  ses.liveCookies = [{ ...SESSION_COOKIE, value: 'old' }];
  const release = gateReads(ses);
  cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, value: 'old' });
  await settle();
  ses.liveCookies = [{ ...SESSION_COOKIE, value: 'rotated' }];
  cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, value: 'rotated' });
  release();
  await settle(700);
  assert.deepEqual((ses.cookieSets ?? []).map((d: any) => d.value), ['rotated'], 'only the newest value is ever written');
});

test('F4(A): stopSignInPersistence while a promotion\'s read is in flight ⇒ nothing is written afterwards (a deleted profile gets no 30-day cookie)', async () => {
  const ws = newWs(P2);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P2)));
  ses.liveCookies = [SESSION_COOKIE];
  const release = gateReads(ses);
  cookieEvent(PERSIST(P2), SESSION_COOKIE);
  await settle();
  bp.stopSignInPersistence(PERSIST(P2));
  release();
  await settle();
  assert.equal(ses.cookieSets, undefined);
  bp.createTab(ws, { openedBy: 'agent' }); // re-arm for the next arm that uses P2
});

test('F4(C): the cookie promoted is the one the EVENT named — never a same-name sibling on a subdomain that `cookies.get({domain})` also returns', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  const own = { name: 'sid', value: 'own', domain: 'example.com', hostOnly: false, path: '/', secure: true, httpOnly: true, session: true, sameSite: 'lax' };
  const sibling = { ...own, value: 'sibling', domain: 'a.example.com', hostOnly: true };
  ses.liveCookies = [sibling, own]; // the sibling is listed FIRST
  cookieEvent(PERSIST(P1), own);
  await settle();
  assert.equal(ses.cookieSets.length, 1);
  assert.deepEqual([ses.cookieSets[0].value, ses.cookieSets[0].url, ses.cookieSets[0].domain], ['own', 'https://example.com/', 'example.com']);
});

test('tabFrameUrls: the live frame tree of ONE tab (main + subframes), a pure read; unknown tab / dead view / unreadable tree ⇒ undefined (the policy then refuses what it cannot judge)', () => {
  const ws = newWs();
  openShown(ws);
  const t1 = bp.getActiveTab(ws)!;
  wcOf(t1).frameUrls = ['https://app.example.com/', 'https://idp.other.org/sso'];
  const viewsBefore = (globalThis as any).__bpViews.length;
  assert.deepEqual(bp.tabFrameUrls(ws, 't1'), ['https://app.example.com/', 'https://idp.other.org/sso']);
  assert.equal(bp.tabFrameUrls(ws, 't99'), undefined, 'unknown tab');
  assert.equal(bp.tabFrameUrls('ws-nope', 't1'), undefined, 'unknown workspace — and nothing is built for it');
  wcOf(t1).frameBoom = true;
  assert.equal(bp.tabFrameUrls(ws, 't1'), undefined, 'a throwing tree');
  wcOf(t1).frameBoom = false;
  assert.equal((globalThis as any).__bpViews.length, viewsBefore, 'a read builds nothing');
});

// ── review of seat 1 (G5 of #400): a logout that the network service processes BETWEEN the promotion's read and its write reaches the main process only
//    AFTER the write was issued — the order the earlier stub could not show. The post-write reconciliation must undo OUR copy, and only ours.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('LOGOUT RACE: a removal delivered AFTER the write (read → write → removal event) removes the 30-day copy — checked right away and again after the settle', async () => {
  for (const deliverAfterMs of [5, 200]) { // right after the write's promise, and late (the settle re-check must still catch it)
    const ws = newWs(P1);
    bp.ensurePanel(ws);
    const ses = fresh(sessions().get(PERSIST(P1)));
    const cookie = { ...SESSION_COOKIE, name: `sid-late-${deliverAfterMs}` }; // its own key per iteration
    ses.liveCookies = [cookie];
    ses.onSet = () => setTimeout(() => cookieEvent(PERSIST(P1), cookie, true, 'expired-overwrite'), deliverAfterMs); // the site's logout, delivered late
    cookieEvent(PERSIST(P1), cookie);
    await settle(260 + deliverAfterMs + 450);
    assert.equal(ses.cookieSets?.length, 1, 'the cookie WAS promoted (the removal was not yet visible to the pre-write guard)');
    assert.deepEqual(ses.cookieRemoves, [{ url: ses.cookieSets[0].url, name: cookie.name }], `the resurrected copy was removed (removal delivered ${deliverAfterMs} ms after the write)`);
    assert.equal(ses.liveCookies.some((c: any) => c.name === cookie.name), false, 'nothing of the cookie is left alive');
    bp.destroyPanel(ws);
  }
});

test('LOGOUT RACE: a removal that reaches us BEFORE the write resolves is compensated right away — not left to the settle re-check (a 300 ms longer window)', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  const cookie = { ...SESSION_COOKIE, name: 'sid-early' };
  ses.liveCookies = [cookie];
  ses.setDelayMs = 40; // the write is slow: the site's logout is delivered while it is in flight
  ses.onSet = () => setTimeout(() => cookieEvent(PERSIST(P1), cookie, true, 'expired-overwrite'), 10);
  cookieEvent(PERSIST(P1), cookie);
  await settle(250 + 40 + 120); // promotion at 250, write resolves ~40 ms later; the settle re-check is ~300 ms after that
  assert.equal(ses.cookieRemoves?.length, 1, 'the copy was removed as soon as the write resolved, well before the settle re-check');
  await settle(400); // let the settle re-check run inside this test: it finds nothing of ours left
  assert.equal(ses.cookieRemoves.length, 1, 'removed exactly once');
});

test('LOGOUT RACE: the `overwrite` removal that OUR OWN write emits (the session cookie replaced by its promoted copy) is not a logout — the copy stays', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  ses.liveCookies = [SESSION_COOKIE];
  ses.onSet = () => setTimeout(() => cookieEvent(PERSIST(P1), SESSION_COOKIE, true, 'overwrite'), 5); // the echo of replacing the old cookie
  cookieEvent(PERSIST(P1), SESSION_COOKIE);
  await settle(900);
  assert.equal(ses.cookieSets?.length, 1);
  assert.equal(ses.cookieRemoves, undefined, 'an overwrite is not a logout: the promoted copy is kept');
  assert.equal(ses.liveCookies.some((c: any) => c.name === 'sid'), true);
});

test('LOGOUT RACE: the user logged IN AGAIN meanwhile (a different live cookie) — the old value\'s removal never deletes the NEW login', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  ses.liveCookies = [SESSION_COOKIE];
  ses.onSet = () => {
    setTimeout(() => {
      cookieEvent(PERSIST(P1), SESSION_COOKIE, true, 'explicit'); // logout of the old value …
      ses.liveCookies = [{ ...SESSION_COOKIE, value: 'v-new-login' }]; // … and a fresh session cookie set by the next login
      cookieEvent(PERSIST(P1), { ...SESSION_COOKIE, value: 'v-new-login' });
    }, 5);
  };
  cookieEvent(PERSIST(P1), SESSION_COOKIE);
  await settle(1500);
  assert.equal(ses.cookieRemoves, undefined, 'the live cookie is not OUR copy any more: left alone');
  assert.ok(ses.liveCookies.some((c: any) => c.value === 'v-new-login'), 'the new login survives');
});

test('LOGOUT RACE: our own compensating remove emits a removal event of its own — it is neither a logout nor a reason to cancel the NEXT login\'s promotion', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  const cookie = { ...SESSION_COOKIE, name: 'sid-echo' };
  ses.liveCookies = [cookie];
  let echo: () => void = () => {};
  ses.onSet = () => setTimeout(() => cookieEvent(PERSIST(P1), cookie, true, 'expired-overwrite'), 5); // the late logout
  ses.onRemove = () => { echo = () => cookieEvent(PERSIST(P1), cookie, true, 'explicit'); }; // OUR remove's own event, delivered when the test says
  cookieEvent(PERSIST(P1), cookie);
  await settle(260 + 450);
  assert.equal(ses.cookieRemoves?.length, 1, 'compensated once');
  // the user logs in again; that promotion's live read is IN FLIGHT when the echo of our earlier remove arrives
  ses.onSet = undefined;
  ses.liveCookies = [cookie];
  const release = gateReads(ses);
  cookieEvent(PERSIST(P1), cookie);
  await settle(320); // debounce fired, the read is pending on the gate
  echo();
  release();
  await settle(500);
  assert.equal(ses.cookieRemoves.length, 1, 'the echo did not trigger a second remove');
  assert.equal(ses.cookieSets.length, 2, 'the echo was swallowed: it did NOT cancel the new login\'s promotion');
});

test('LOGOUT RACE: an echo that never comes does not swallow a LATER, genuine logout (the suppression is dropped shortly after the remove resolves)', async () => {
  const ws = newWs(P1);
  bp.ensurePanel(ws);
  const ses = fresh(sessions().get(PERSIST(P1)));
  const cookie = { ...SESSION_COOKIE, name: 'sid-noecho' };
  for (let cycle = 1; cycle <= 2; cycle++) {
    ses.liveCookies = [cookie];
    ses.onSet = () => setTimeout(() => cookieEvent(PERSIST(P1), cookie, true, 'expired-overwrite'), 5);
    cookieEvent(PERSIST(P1), cookie);
    await settle(260 + 450);
    assert.equal(ses.cookieRemoves?.length, cycle, `cycle ${cycle}: the late logout was compensated (no echo of our remove was ever delivered)`);
    await settle(700); // past OWN_ECHO_MS
  }
});
