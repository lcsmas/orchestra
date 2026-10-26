// #396 fix round (ledger #405 F1/F2) — the PURE popup window builder: whatever a hostile `window.open` features string produces, the options that reach
// `new BrowserWindow` are an allowlist. `electronMerge` replicates Electron 33.4.11's `openGuestWindow` (read from the shipped binary) so the arms feed the
// builder what Electron really hands a createWindow factory. scripts/mutate-browser-popups.mjs reddens each clause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChildWindowOptions,
  featuresSmuggleWebContents,
  popupOrigin,
  popupWindowTitle,
  POPUP_WEB_PREFERENCES,
  POPUP_WINDOW_DEFAULT,
  POPUP_WINDOW_MAX,
  POPUP_WINDOW_MIN,
} from './browser-popup-window.ts';
import { electronMerge as realMerge } from './electron-guest-window.testlib.ts';

const GUEST = { id: 'the-real-guest-webContents' };
/** What `createWindow` receives for this features string (Electron's own parse + merge, replicated). */
const electronMerge = (features: string, override: object = {}): Record<string, unknown> => realMerge(GUEST, features, override);

const PARENT = { id: 'main-window' };
const build = (features: string, parentSize?: { width: number; height: number }) => buildChildWindowOptions(electronMerge(features), { parent: PARENT, parentSize });

const ALLOWED_KEYS = new Set(['webContents', 'parent', 'show', 'width', 'height', 'autoHideMenuBar', 'resizable', 'webPreferences']);
const DANGEROUS = ['alwaysOnTop', 'frame', 'transparent', 'fullscreen', 'kiosk', 'modal', 'closable', 'focusable', 'skipTaskbar', 'icon', 'type', 'titleBarStyle', 'thickFrame', 'hasShadow', 'opacity', 'movable', 'x', 'y', 'enableLargerThanScreen', 'title'];
const HOSTILE = 'width=4000,height=3000,x=0,y=0,alwaysOnTop,frame=no,transparent,fullscreen,kiosk,modal,closable=no,focusable=no';

test('the builder emits ONLY allow-listed keys, whatever the features string said', () => {
  for (const f of [HOSTILE, 'icon=/etc/passwd,title=pwned,type=desktop,skipTaskbar,enableLargerThanScreen,titleBarStyle=hidden,thickFrame=no,hasShadow=no,opacity=0,movable=no', 'webPreferences=x,parent=y,show=true,resizable=yes,autoHideMenuBar=no', 'left=5,top=7']) {
    const o = build(f);
    for (const k of Object.keys(o)) assert.ok(ALLOWED_KEYS.has(k), `${f} -> leaked key ${k}`);
    for (const k of DANGEROUS) assert.equal(Object.prototype.hasOwnProperty.call(o, k), false, `${f} -> ${k} present`);
  }
});

test('each dangerous page feature is absent from the result, individually (a single leak is a red arm)', () => {
  for (const f of ['alwaysOnTop', 'alwaysOnTop=true', 'frame=no', 'transparent', 'fullscreen', 'kiosk', 'modal', 'closable=no', 'focusable=no', 'skipTaskbar', 'x=0', 'y=0', 'movable=no', 'hasShadow=no', 'opacity=0']) {
    const key = f.split('=')[0];
    assert.equal(Object.prototype.hasOwnProperty.call(build(f), key), false, f);
  }
});

test('our own keys are FIXED: show:false, resizable:false, autoHideMenuBar, the app window as parent, and exactly the secure web preferences', () => {
  for (const f of ['', HOSTILE, 'show=true,resizable=yes,autoHideMenuBar=no,parent=x,webPreferences=evil']) {
    const o = build(f);
    assert.equal(o.show, false, f);
    assert.equal(o.resizable, false, f);
    assert.equal(o.autoHideMenuBar, true, f);
    assert.equal(o.parent, PARENT, f);
    assert.deepEqual(o.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false }, f);
  }
  assert.deepEqual(POPUP_WEB_PREFERENCES, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const a = build(''), b = build('');
  assert.notEqual(a.webPreferences, b.webPreferences, 'a fresh object per window (mutating one cannot weaken the next)');
  assert.ok(Object.isFrozen(POPUP_WEB_PREFERENCES));
});

test('webPreferences smuggled through the features string never weaken the result (`nodeIntegration=1` is dropped by Electron; a literal `webPreferences=` string is ignored here)', () => {
  assert.deepEqual(build('nodeIntegration=1,contextIsolation=0,webviewTag=1,javascript=0').webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.deepEqual(build('webPreferences=sandbox%3Dfalse').webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
});

test('the REAL guest webContents is passed through (the factory must return it); a string/absent one is never forwarded', () => {
  assert.equal(build('').webContents, GUEST);
  assert.equal(build(HOSTILE).webContents, GUEST);
  assert.equal(Object.prototype.hasOwnProperty.call(buildChildWindowOptions({ webContents: 'x' }, { parent: PARENT }), 'webContents'), false, 'a smuggled string');
  assert.equal(Object.prototype.hasOwnProperty.call(buildChildWindowOptions({ webContents: null }, { parent: PARENT }), 'webContents'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(buildChildWindowOptions({}, { parent: PARENT }), 'webContents'), false, 'guest-less path');
});

test('size: a benign request is kept, junk falls back to the default, nothing leaves [MIN, parent share] — NaN, negative, zero, huge, 1e308, int32 overflow, strings', () => {
  assert.deepEqual([build('width=500,height=600').width, build('width=500,height=600').height], [500, 600], 'benign width=500,height=600 stays usable');
  assert.deepEqual([build('').width, build('').height], [800, 600].map((n) => n), 'no features: Electron\'s own 800x600 default is a request like any other');
  for (const f of ['width=abc,height=xyz', 'width=,height=', 'width=-5,height=-9', 'width=0,height=0', 'width=NaN', 'height']) {
    const o = build(f) as { width: number; height: number };
    assert.ok(Number.isInteger(o.width) && Number.isInteger(o.height), f);
    assert.ok(o.width >= POPUP_WINDOW_MIN.width && o.height >= POPUP_WINDOW_MIN.height, `${f}: never below the minimum (${o.width}x${o.height})`);
  }
  assert.deepEqual([build('width=abc,height=xyz').width, build('width=abc,height=xyz').height], [POPUP_WINDOW_DEFAULT.width, POPUP_WINDOW_DEFAULT.height], 'junk -> the popup default, not 800x600');
  for (const f of ['width=4000,height=3000', 'width=1e308,height=1e308', 'width=2147483648,height=2147483649', 'width=99999999999999999999,height=9e99']) {
    const o = build(f) as { width: number; height: number };
    assert.ok(o.width <= POPUP_WINDOW_MAX && o.height <= POPUP_WINDOW_MAX, `${f}: ${o.width}x${o.height}`);
  }
  assert.equal((build('width=100,height=100') as { width: number }).width, POPUP_WINDOW_MIN.width, 'a 1-pixel-ish popup is lifted to the minimum');
});

test('size: clamped to 90% of the PARENT per axis when its size is known — a screen-covering request stays inside the app window', () => {
  const o = build('width=4000,height=3000', { width: 1500, height: 950 }) as { width: number; height: number };
  assert.deepEqual([o.width, o.height], [1350, 855]);
  const small = build('width=500,height=600', { width: 1500, height: 950 }) as { width: number; height: number };
  assert.deepEqual([small.width, small.height], [500, 600], 'a request inside the parent is untouched');
  const tiny = build('width=4000,height=3000', { width: 100, height: 100 }) as { width: number; height: number };
  assert.deepEqual([tiny.width, tiny.height], [POPUP_WINDOW_MIN.width, POPUP_WINDOW_MIN.height], 'a parent smaller than the minimum never shrinks the popup below it');
  const junkParent = build('width=99999,height=99999', { width: NaN, height: Infinity }) as { width: number; height: number };
  assert.deepEqual([junkParent.width, junkParent.height], [POPUP_WINDOW_MAX, POPUP_WINDOW_MAX], 'an unusable parent size falls back to the absolute ceiling');
});

test('prototype pollution and odd keys: `__proto__` / `constructor` / 50k keys / 1e6 empty items change nothing and finish fast', () => {
  const before = Object.keys(Object.prototype).length;
  const evil = build('__proto__=polluted,constructor=x,prototype=y,toString=z');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.keys(Object.prototype).length, before);
  assert.ok(Object.keys(evil).every((k) => ALLOWED_KEYS.has(k)));
  const t0 = Date.now();
  build(Array.from({ length: 50_000 }, (_, i) => `k${i}=${i}`).join(','));
  build(','.repeat(1_000_000));
  assert.ok(Date.now() - t0 < 2000, `parse took ${Date.now() - t0} ms`);
  // an own `width` that is a getter-less inherited property is not read
  const inherited = Object.create({ width: 5000 }) as object;
  assert.equal((buildChildWindowOptions(inherited, { parent: PARENT }) as { width: number }).width, POPUP_WINDOW_DEFAULT.width);
});

test('case variants and exotic separators are inert in Electron and in the builder alike', () => {
  for (const f of ['ALWAYSONTOP', 'AlwaysOnTop=true', 'alwaysontop', 'frame＝no', 'alwaysOnTop　transparent', 'modal ;fullscreen']) {
    const o = build(f);
    for (const k of Object.keys(o)) assert.ok(ALLOWED_KEYS.has(k), `${f} -> ${k}`);
  }
});

test('featuresSmuggleWebContents: Electron\'s parser shape — exact key, first `=` split, trimmed, case-sensitive', () => {
  for (const f of ['webContents=x', 'a=1,webContents=2', ' webContents = y', 'webContents', 'width=1,,webContents=z']) assert.equal(featuresSmuggleWebContents(f), true, f);
  for (const f of ['', 'webContentsX=1', 'WEBCONTENTS=1', 'xwebContents=1', 'width=webContents', 'webPreferences=x']) assert.equal(featuresSmuggleWebContents(f), false, f);
  // control: the replica parser really puts a smuggled key into the options (so refusing it up front is not hypothetical)
  assert.equal(electronMerge('webContents=pwned').webContents, 'pwned', 'Electron spreads the page string OVER the real guest');
});

test('title: the ORIGIN comes first, then the sanitised page title; the page cannot push the origin out or fake it with control / bidi characters', () => {
  assert.equal(popupWindowTitle('https://accounts.example.com/o/oauth2/auth?client_id=x&token=SECRET', 'Sign in'), 'https://accounts.example.com — Sign in');
  assert.equal(popupWindowTitle('http://127.0.0.1:8080/x', ''), 'http://127.0.0.1:8080');
  assert.equal(popupWindowTitle('https://a.example/', 'x'.repeat(500)).length, 'https://a.example — '.length + 80, 'cut at 80');
  const spoof = popupWindowTitle('https://evil.example/', 'Google\u202e\u0007\n\tAccounts\u2066 — https://accounts.google.com');
  assert.ok(spoof.startsWith('https://evil.example — '), spoof);
  assert.ok(!/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(spoof), 'control and bidi characters are stripped');
  assert.equal(popupWindowTitle('https://x.example/', '   \n  '), 'https://x.example', 'a blank page title leaves just the origin');
});

test('popupOrigin: origin only (no path, query, fragment or credentials); blank pages and junk have their own labels; opaque origins are never shown as a site', () => {
  assert.equal(popupOrigin('https://user:pw@host.example:8443/a?b=c#d'), 'https://host.example:8443');
  assert.equal(popupOrigin('about:blank'), 'about:blank');
  assert.equal(popupOrigin(''), 'about:blank');
  assert.equal(popupOrigin('not a url'), 'unknown origin');
  assert.equal(popupOrigin('data:text/html,hi'), 'unknown origin');
});
