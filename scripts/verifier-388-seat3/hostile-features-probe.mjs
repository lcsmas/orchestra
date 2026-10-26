#!/usr/bin/env node
// HOSTILE-FEATURES PROBE (verifier seat 3, vague #388, #396 BLOCKING "page `features` => BrowserWindow options").
// A page controls the 3rd argument of window.open(url, name, FEATURES). Electron's SHIPPED main-process JS turns it into BrowserWindow
// options:  w = { show:true, width:800, height:600, ...parseFeatures(features).options, ...overrideBrowserWindowOptions }  — so every
// option the app does NOT override comes straight from the page (alwaysOnTop, frame, transparent, fullscreen, kiosk, modal, closable,
// focusable, skipTaskbar, type, x/y/width/height unclamped…). This probe feeds 28 hostile strings through the SHIPPED
// `parseFeatures` + `openGuestWindow` (extracted verbatim from the electron binary of THIS repo's node_modules — no Electron is launched,
// no window, no bus: the binary is only READ as bytes and the two ~1-2 KB modules are evaluated in a node `vm` with stubbed collaborators)
// and asserts invariants on the options that would reach `new BrowserWindow(...)` (or the app's own `createWindow`).
//
// usage (run from a repo checkout that has node_modules/electron):
//   node hostile-features-probe.mjs --selftest                 # the probe can FAIL (current #396@38be17bc override => red) and PASS (reference allowlist builder => green)
//   node hostile-features-probe.mjs --adapter ./my-adapter.mjs # point it at the member's NEW option builder
//   node hostile-features-probe.mjs --table                    # print what the shipped parser yields for each string
// adapter contract: default export async ({ features, shipped, parent }) => the FINAL options object the app would hand to `new BrowserWindow`.
//   `shipped.runOpenGuestWindow({ features, override, createWindow })` runs Electron's real openGuestWindow merge:
//     - `override` = the object the app returns as `overrideBrowserWindowOptions` (null if none);
//     - `createWindow(options)` (optional) = the app's own factory (Electron hands it `{ webContents, ...mergedOptions }` and the app builds the window itself);
//   it returns the options that reached the window constructor / createWindow.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// ── 1. the shipped JS, read from the binary ─────────────────────────────────────────────────────────────────────────────
const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
function electronBinaryPath() {
  if (process.env.ELECTRON_BINARY) return process.env.ELECTRON_BINARY;
  const p = cwdRequire('electron'); // the npm package's index exports the PATH of the binary (never launches it)
  if (typeof p !== 'string' || !fs.existsSync(p)) throw new Error(`cannot resolve the electron binary from ${process.cwd()}`);
  return p;
}
function extractModule(bytes, name) {
  const key = `"${name}":(`;
  const i = bytes.indexOf(key);
  if (i < 0) throw new Error(`module ${name} not found in the electron binary`);
  const j = bytes.indexOf(',"./lib/', i + key.length);
  return bytes.slice(i, j < 0 ? i + 20000 : j);
}
const BIN = electronBinaryPath();
const bytes = fs.readFileSync(BIN).toString('latin1');
const PARSE_SRC = extractModule(bytes, './lib/browser/parse-features-string.ts');
const GUEST_SRC = extractModule(bytes, './lib/browser/guest-window-manager.ts');
const sha = (s) => crypto.createHash('sha256').update(s, 'latin1').digest('hex').slice(0, 16);
const electronVersion = (() => { try { return fs.readFileSync(path.join(path.dirname(BIN), 'version'), 'utf8').trim(); } catch { return 'unknown'; } })();
console.log(`[probe] electron binary ${BIN} version=${electronVersion} · shipped parse-features-string.ts ${PARSE_SRC.length} B sha256:${sha(PARSE_SRC)} · guest-window-manager.ts ${GUEST_SRC.length} B sha256:${sha(GUEST_SRC)}`);

// evaluate `"name":(e,t,o)=>{…}` as an object member in a fresh context (no host objects leak in)
const REALM = vm.createContext(Object.create(null)); // ONE realm for both shipped modules: their object literals share one Object.prototype
const evalModule = (src) => vm.runInContext(`({ ${src} })`, REALM, { timeout: 5000 });
const REALM_OBJECT_PROTO = vm.runInContext('Object.prototype', REALM);
const PRISTINE_PROTO_KEYS = vm.runInContext('Object.getOwnPropertyNames(Object.prototype).sort().join()', REALM);
const parseMod = Object.values(evalModule(PARSE_SRC))[0];
const parseExports = {};
parseMod({}, parseExports);
const guestMod = Object.values(evalModule(GUEST_SRC))[0];

/** Electron's real openGuestWindow, with stubbed collaborators; returns the options that reached the constructor / createWindow. */
function runOpenGuestWindow({ features, override = null, createWindow = null, url = 'https://x.example/', frameName = '' }) {
  let reached = null;
  class StubBrowserWindow {
    constructor(opts) { reached = opts; this.webContents = { once() {}, removeListener() {}, destroy() {}, isDestroyed: () => false }; }
    loadURL() {}
  }
  const fakeRequire = (id) => {
    if (id === './lib/browser/parse-features-string.ts') return parseExports;
    if (id === './lib/browser/api/exports/electron.ts') return { BrowserWindow: StubBrowserWindow };
    throw new Error(`unexpected require ${id}`);
  };
  const guestExports = {};
  guestMod({}, guestExports, fakeRequire);
  const embedder = { once() {}, removeListener() {}, isDestroyed: () => false, emit() {} };
  guestExports.openGuestWindow({
    embedder, guest: null, referrer: undefined, disposition: 'new-window', postData: undefined,
    overrideBrowserWindowOptions: override ?? undefined, windowOpenArgs: { url, frameName, features }, outlivesOpener: false,
    createWindow: createWindow ? (o) => { reached = o; return createWindow(o); } : undefined,
  });
  return reached;
}
export const shipped = { parseFeatures: parseExports.parseFeatures, runOpenGuestWindow };

// ── 2. the hostile corpus ───────────────────────────────────────────────────────────────────────────────────────────────
const BIG = ','.repeat(1_000_000);
const MANY = Array.from({ length: 50_000 }, (_, i) => `k${i}=v${i}`).join(',');
export const CORPUS = [
  ['alwaysOnTop', 'alwaysOnTop=yes'],
  ['frame=no', 'frame=no'],
  ['transparent+frameless', 'transparent=true,frame=false'],
  ['fullscreen', 'fullscreen=1'],
  ['kiosk', 'kiosk=yes'],
  ['modal (blocks the parent window)', 'modal=true'],
  ['closable=no', 'closable=no'],
  ['focusable=no', 'focusable=no'],
  ['huge size', 'width=999999999,height=999999999'],
  ['negative size and position', 'width=-5,height=-9,x=-99999,y=-99999'],
  ['NaN / junk numbers', 'width=NaN,height=abc,x=1e9,y=0x10'],
  ['1e308 / Infinity', 'width=1e308,height=Infinity'],
  ['int32 overflow', 'x=2147483648,y=-2147483649'],
  ['duplicated + case variants of width', 'width=300,width=999999,WIDTH=5,Width=7'],
  ['case variants of a dangerous key', 'ALWAYSONTOP=yes,AlwaysOnTop=yes,alwaysontop=yes'],
  ['unicode line separator', 'width=300 height=300 alwaysOnTop=yes'],
  ['fullwidth equals / comma', 'width＝800，height＝800，alwaysOnTop＝yes'],
  ['padding + spacing', ' alwaysOnTop = yes , frame = no '],
  ['webPreferences smuggling', 'webPreferences=x,nodeIntegration=yes,sandbox=no,contextIsolation=no,javascript=no,webviewTag=yes'],
  ['icon / title', 'icon=/etc/passwd,title=<img src=x onerror=1>'],
  ['type / skipTaskbar / enableLargerThanScreen', 'type=desktop,skipTaskbar=yes,enableLargerThanScreen=yes'],
  ['titleBarStyle / thickFrame / hasShadow / opacity', 'titleBarStyle=hidden,thickFrame=no,hasShadow=no,opacity=0'],
  ['prototype keys', '__proto__=x,constructor=y,toString=z,hasOwnProperty=1,__defineGetter__=1'],
  ['parent / show / webContents / movable', 'show=true,parent=x,webContents=y,movable=no,minimizable=no,maximizable=no,fullscreenable=no'],
  ['noopener / popup noise', 'noopener,noreferrer,popup=yes,scrollbars=no,toolbar=no'],
  ['left/top aliases', 'left=-50000,top=50000'],
  ['1e6 empty items (parse cost)', BIG],
  ['50k unknown keys (option bloat)', MANY],
  ['BENIGN sized popup (must stay usable)', 'width=500,height=600'],
];

// ── 3. invariants on the options that would reach `new BrowserWindow` ───────────────────────────────────────────────────
const DANGEROUS_SAFE = { // absent, or exactly this value
  alwaysOnTop: false, frame: true, transparent: false, fullscreen: false, kiosk: false, modal: false, closable: true, focusable: true,
  skipTaskbar: false, enableLargerThanScreen: false, movable: true, minimizable: true, maximizable: true, fullscreenable: true, hasShadow: true, thickFrame: true,
  opacity: 1, titleBarStyle: 'default', type: undefined, icon: undefined, visualEffectState: undefined, vibrancy: undefined,
};
const SAFE_KEYS = new Set(['parent', 'show', 'autoHideMenuBar', 'resizable', 'webPreferences', 'width', 'height', 'x', 'y', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'webContents', 'title']);
const MAX_PX = 8192, MIN_PX = 1;
const PRISTINE_HOST_PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype).sort().join();
const SAFE_WEBPREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false };

/** @returns string[] violations for `opts` (the options reaching the window constructor) */
export function violations(opts, { features, parent }) {
  const v = [];
  if (!opts || typeof opts !== 'object') return ['no options object reached the constructor'];
  const proto = Object.getPrototypeOf(opts);
  if (proto !== Object.prototype && proto !== REALM_OBJECT_PROTO) v.push('options object prototype was changed');
  if (vm.runInContext('Object.getOwnPropertyNames(Object.prototype).sort().join()', REALM) !== PRISTINE_PROTO_KEYS || Object.getOwnPropertyNames(Object.prototype).sort().join() !== PRISTINE_HOST_PROTO_KEYS) v.push('Object.prototype polluted');
  if ('webContents' in opts && typeof opts.webContents === 'string') v.push(`webContents=${JSON.stringify(opts.webContents)} (a page-controlled string replaced Electron's guest contents)`);
  const keys = Object.keys(opts);
  const extra = keys.filter((k) => !SAFE_KEYS.has(k));
  if (extra.length) v.push(`page-controlled/unknown keys reach the constructor: ${extra.slice(0, 8).join(',')}${extra.length > 8 ? `,… (+${extra.length - 8})` : ''}`);
  for (const [k, safe] of Object.entries(DANGEROUS_SAFE)) {
    if (k in opts && opts[k] !== safe) v.push(`${k}=${JSON.stringify(opts[k])} (safe: ${safe === undefined ? 'absent' : JSON.stringify(safe)})`);
  }
  for (const k of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight']) {
    if (k in opts && !(Number.isInteger(opts[k]) && opts[k] >= MIN_PX && opts[k] <= MAX_PX)) v.push(`${k}=${String(opts[k])} not an integer in [${MIN_PX},${MAX_PX}]`);
  }
  for (const k of ['x', 'y']) {
    if (k in opts && !(Number.isInteger(opts[k]) && Math.abs(opts[k]) <= 2 * MAX_PX)) v.push(`${k}=${String(opts[k])} not an integer within ±${2 * MAX_PX}`);
  }
  if ('show' in opts && opts.show !== false) v.push(`show=${JSON.stringify(opts.show)} (the app shows it itself, only for the workspace on screen)`);
  if ('resizable' in opts && opts.resizable !== false) v.push(`resizable=${JSON.stringify(opts.resizable)} (sway tiles a resizable child; the app fixes it)`);
  if ('parent' in opts && opts.parent !== parent) v.push('parent is not the app window');
  if (parent && !('parent' in opts)) v.push('parent was dropped (the child window would not float over / belong to the main window)');
  const wp = opts.webPreferences;
  if (!wp || typeof wp !== 'object') v.push(`webPreferences=${JSON.stringify(wp)} (must be the app's safe object)`);
  else {
    for (const [k, val] of Object.entries(SAFE_WEBPREFS)) if (wp[k] !== val) v.push(`webPreferences.${k}=${JSON.stringify(wp[k])} (want ${val})`);
    const wpExtra = Object.keys(wp).filter((k) => !(k in SAFE_WEBPREFS));
    if (wpExtra.length) v.push(`webPreferences has extra keys: ${wpExtra.join(',')}`);
  }
  return v;
}

// ── 4. adapters ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const PARENT = Object.freeze({ __stub: 'main-window' });
/** The #396 override as shipped at impl-popups-fenetre-oauth-396 @38be17bc (src/main/browser-panel.ts routePopup `child-window` arm). */
const current396 = async ({ features, parent }) => runOpenGuestWindow({
  features,
  override: { parent, show: false, autoHideMenuBar: true, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } },
});
/** Reference: what a correct fix looks like (the app's own createWindow with an allowlist + clamp). Used only by --selftest. */
const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt);
// the app's createWindow factory builds the window from an allowlist: capture what IT builds (not what Electron handed it)
const referenceBuilt = async ({ features, parent }) => {
  let built = null;
  runOpenGuestWindow({ features, override: null, createWindow: (given) => {
    const f = shipped.parseFeatures(features).options;
    built = { parent, show: false, autoHideMenuBar: true, resizable: false, width: clampInt(f.width, 200, 1600, 500), height: clampInt(f.height, 200, 1200, 600),
      ...(Number.isFinite(f.x) ? { x: clampInt(f.x, -MAX_PX, MAX_PX, 0) } : {}), ...(Number.isFinite(f.y) ? { y: clampInt(f.y, -MAX_PX, MAX_PX, 0) } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
    return {};
  } });
  return built;
};

async function runAdapter(adapter) {
  const rows = [];
  for (const [name, features] of CORPUS) {
    const t0 = process.hrtime.bigint();
    let opts, err = null;
    try { opts = await adapter({ features, shipped, parent: PARENT }); } catch (e) { err = e; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const v = err ? [`threw: ${err.message}`] : violations(opts, { features, parent: PARENT });
    if (ms > 2000) v.push(`took ${ms.toFixed(0)} ms (parse DoS)`);
    rows.push({ name, features: features.length > 70 ? `${features.slice(0, 60)}…(${features.length} chars)` : features, ms: +ms.toFixed(1), violations: v });
  }
  return rows;
}
function report(label, rows) {
  const bad = rows.filter((r) => r.violations.length);
  for (const r of rows) console.log(`${r.violations.length ? 'FAIL' : 'PASS'}  [${label}] ${r.name} — ${r.violations.length ? r.violations.join(' | ').slice(0, 330) : `ok (${r.ms} ms)`}`);
  console.log(`PROBE-RESULT adapter=${label} strings=${rows.length} red=${bad.length} green=${rows.length - bad.length}`);
  return bad.length;
}

const args = process.argv.slice(2);
if (args.includes('--table')) {
  for (const [name, features] of CORPUS) {
    if (features.length > 200) continue;
    const { options, webPreferences } = shipped.parseFeatures(features);
    console.log(`${name}: ${JSON.stringify(features)} -> options ${JSON.stringify(options)} webPreferences ${JSON.stringify(webPreferences)}`);
  }
}
if (args.includes('--selftest')) {
  // must-FAIL: today's override leaves the page in charge of everything it does not name
  const cur = await runAdapter(current396);
  const curRed = report('current-396@38be17bc', cur);
  // must-PASS: a correct allowlist builder (positive control for the invariants + the harness)
  const ref = await runAdapter(referenceBuilt);
  const refRed = report('reference-allowlist', ref);
  // the benign string must stay usable under the reference (the probe must not reject everything)
  const benign = (await referenceBuilt({ features: 'width=500,height=600', parent: PARENT }));
  const benignOk = benign && benign.width === 500 && benign.height === 600;
  // each invariant must be able to fire: a reference builder that leaks exactly ONE thing must go red, naming it
  const leaks = {
    'leaks alwaysOnTop': [(b, f) => ({ ...b, ...(/alwaysOnTop/.test(f) ? { alwaysOnTop: true } : {}) }), 'alwaysOnTop'],
    'leaks modal': [(b, f) => ({ ...b, ...(/modal=/.test(f) ? { modal: true } : {}) }), 'modal'],
    'unclamped width': [(b, f) => ({ ...b, ...(/width=999999999/.test(f) ? { width: 999999999 } : {}) }), 'not an integer in'],
    'NaN height': [(b, f) => ({ ...b, ...(/NaN/.test(f) ? { height: NaN } : {}) }), 'not an integer in'],
    'webPreferences string from the page': [(b, f) => ({ ...b, ...(/webPreferences=x/.test(f) ? { webPreferences: 'x' } : {}) }), 'webPreferences'],
    'weakened webPreferences': [(b, f) => ({ ...b, ...(/nodeIntegration=yes/.test(f) ? { webPreferences: { ...b.webPreferences, nodeIntegration: true } } : {}) }), 'webPreferences.nodeIntegration'],
    'icon passes': [(b, f) => ({ ...b, ...(/icon=/.test(f) ? { icon: '/etc/passwd' } : {}) }), 'icon'],
    'parent dropped': [(b) => { const { parent: _p, ...rest } = b; return rest; }, 'parent was dropped'],
    'page string replaces webContents': [(b, f) => ({ ...b, ...(/webContents=y/.test(f) ? { webContents: 'y' } : {}) }), 'webContents'],
    'prototype polluted': [(b, f) => { if (/__proto__/.test(f)) Object.prototype.polluted = 'x'; return b; }, 'prototype polluted'],
  };
  let leakOk = true;
  for (const [name, [inject, want]] of Object.entries(leaks)) {
    const rows = await runAdapter(async (a) => inject(await referenceBuilt(a), a.features));
    delete Object.prototype.polluted;
    const hit = rows.some((r) => r.violations.some((x) => x.includes(want)));
    if (!hit) leakOk = false;
    console.log(`${hit ? 'PASS' : 'FAIL'}  [selftest-leak] ${name} -> probe goes red naming "${want}": ${hit}`);
  }
  console.log(`SELFTEST current-red=${curRed} (want >= 15) reference-red=${refRed} (want 0) benign-kept=${benignOk} leaks-each-detected=${leakOk} ${curRed >= 15 && refRed === 0 && benignOk && leakOk ? 'OK: the probe can fail and can pass' : 'BROKEN INSTRUMENT'}`);
  process.exit(curRed >= 15 && refRed === 0 && benignOk && leakOk ? 0 : 3);
}
const ai = args.indexOf('--adapter');
if (ai >= 0) {
  const mod = await import(path.resolve(args[ai + 1]));
  const red = report(path.basename(args[ai + 1]), await runAdapter(mod.default));
  process.exit(red ? 1 : 0);
}
if (!args.includes('--table')) console.log('usage: --selftest | --adapter <file.mjs> | --table');
