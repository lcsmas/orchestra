// Must-FAIL proof for the popup routing (#396, ledger #405): src/shared/browser-tab-policy.test.ts + src/main/browser-popups.test.ts +
// src/shared/browser-popup-window.test.ts + src/main/browser-panel-popups.test.ts + src/main/browser-popups-wiring.test.ts. Each mutant edits ONE clause of the real source IN PLACE; the three test files MUST go red on an
// ASSERTION (not a crash), and every file is restored from a byte-exact backup and `cmp`-checked after each mutant and on any exit path.
// Run: node scripts/mutate-browser-popups.mjs [--list]   (RC 0 = every mutant killed, tree restored)

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POL = 'src/shared/browser-tab-policy.ts';
const POP = 'src/main/browser-popups.ts';
const BP = 'src/main/browser-panel.ts';
const BPW = 'src/shared/browser-popup-window.ts';
const WS = 'src/main/workspaces.ts';
const TESTS = ['src/shared/browser-tab-policy.test.ts', 'src/shared/browser-popup-window.test.ts', 'src/main/browser-popups.test.ts', 'src/main/browser-panel-popups.test.ts', 'src/main/browser-popups-wiring.test.ts'];

// [file, name, find (exactly once), replace]
export const MUTANTS = [
  // ---- pure routing policy -------------------------------------------------------------------------------------------------------------------
  [POL, 'unsafe URLs are no longer refused', "  if (kind === 'unsafe') {", "  if (kind === 'unsafe' && false) {"],
  [POL, 'OS hand-off schemes widened (ssh/smb/slack)', '/^(mailto|tel):/i;', '/^(mailto|tel|ssh|smb|slack):/i;'],
  [POL, 'every scheme is an OS hand-off again (blocklist, not allowlist)', "  return 'unsafe';\n}", "  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? 'external' : 'unsafe';\n}"],
  [POL, 'an OS hand-off needs no click', '    return req.userGesture\n      ? { route: \'external\' }', '    return true\n      ? { route: \'external\' }'],
  [POL, 'a `webContents` feature is no longer refused', '  if (featuresSmuggleWebContents(req.features)) {', '  if (false) {'],
  [POL, 'the cap ignores child windows', 'ctx.openTabs + ctx.openWindows >= cap', 'ctx.openTabs >= cap'],
  [POL, 'the cap is off by one', 'ctx.openTabs + ctx.openWindows >= cap', 'ctx.openTabs + ctx.openWindows > cap'],
  [POL, 'a name held by another workspace is ignored', '  if (needsOpener && ctx.nameHeldElsewhere) {', '  if (false) {'],
  [POL, 'a name held elsewhere also refuses the tab route', '  if (needsOpener && ctx.nameHeldElsewhere) {', '  if (ctx.nameHeldElsewhere) {'],
  [POL, 'the budget binds user gestures too', 'if (!req.userGesture && ctx.pageInitiatedOpen >= budget)', 'if (ctx.pageInitiatedOpen >= budget)'],
  [POL, 'the budget is never applied', 'if (!req.userGesture && ctx.pageInitiatedOpen >= budget)', 'if (false)'],
  [POL, 'the budget is off by one', 'ctx.pageInitiatedOpen >= budget)', 'ctx.pageInitiatedOpen > budget)'],
  [POL, 'the rate cap is never applied', "if (!req.userGesture && (ctx.recentPageInitiated ?? 0) >= rateMax) {", 'if (false) {'],
  [POL, 'the rate cap binds user gestures too', "if (!req.userGesture && (ctx.recentPageInitiated ?? 0) >= rateMax) {", 'if ((ctx.recentPageInitiated ?? 0) >= rateMax) {'],
  [POL, 'the rate cap is off by one', '(ctx.recentPageInitiated ?? 0) >= rateMax', '(ctx.recentPageInitiated ?? 0) > rateMax'],
  [POL, 'the rate cap is 60 per minute', 'POPUP_RATE_MAX = 6;', 'POPUP_RATE_MAX = 60;'],
  [POL, 'a named popup is routed as a tab', "if (name !== '' && !['_blank', '_self', '_parent', '_top'].includes(name)) return true;", 'if (false) return true;'],
  [POL, 'a sized popup (new-window) is routed as a tab', "return req.disposition === 'new-window' && req.features.trim() !== '';", 'return false;'],
  [POL, 'a features-less new-window (shift-click) is routed as a sized popup', "req.disposition === 'new-window' && req.features.trim() !== '';", "req.disposition === 'new-window';"],
  [POL, 'noopener is ignored', 'if (featuresDenyOpener(req.features)) return false;', 'if (false) return false;'],
  [POL, 'noopener=0 denies the opener', "!['0', 'no', 'false'].includes(v)", 'true'],
  [POL, '`_blank` counts as a window name', "['_blank', '_self', '_parent', '_top'].includes(name)", "['_self', '_parent', '_top'].includes(name)"],
  [POL, 'a page-initiated popup activates its tab', "activate: req.userGesture && req.disposition !== 'background-tab'", "activate: req.disposition !== 'background-tab'"],
  [POL, 'a background-tab click activates its tab', "activate: req.userGesture && req.disposition !== 'background-tab'", 'activate: req.userGesture'],
  [POL, 'a page-initiated popup is not marked page-initiated', 'const pageInitiated = !req.userGesture;', 'const pageInitiated = false;'],
  [POL, 'the activation window is one minute', 'USER_GESTURE_WINDOW_MS = 5000', 'USER_GESTURE_WINDOW_MS = 60000'],
  // ---- the pure child-window builder ---------------------------------------------------------------------------------------------------------
  [BPW, 'the page\'s options are spread into the window (alwaysOnTop, frame, modal… leak)', '    autoHideMenuBar: true,\n    resizable: false,', '    ...(given as object),\n    autoHideMenuBar: true,\n    resizable: false,'],
  [BPW, 'the size is not clamped to the parent window', 'parentMax === undefined ? POPUP_WINDOW_MAX : Math.max(min, Math.floor(parentMax * POPUP_WINDOW_PARENT_SHARE))', 'POPUP_WINDOW_MAX'],
  [BPW, 'the absolute size ceiling is gone', 'Math.min(POPUP_WINDOW_MAX, parentMax', 'Math.min(Infinity, parentMax'],
  [BPW, 'the minimum size is gone (a 1-pixel popup)', 'Math.min(max, Math.max(min, asked', 'Math.min(max, Math.max(1, asked'],
  [BPW, 'the parent share is 100%', 'POPUP_WINDOW_PARENT_SHARE = 0.9;', 'POPUP_WINDOW_PARENT_SHARE = 1;'],
  [BPW, 'a smuggled non-object webContents is forwarded', "typeof wc === 'object' && wc !== null ? { webContents: wc } : {}", 'wc !== undefined ? { webContents: wc } : {}'],
  [BPW, 'the real guest webContents is not forwarded', "typeof wc === 'object' && wc !== null ? { webContents: wc } : {}", '{}'],
  [BPW, 'the secure web preferences are weakened (sandbox off)', 'Object.freeze({ sandbox: true,', 'Object.freeze({ sandbox: false,'],
  [BPW, 'the web preferences object is shared between windows', 'webPreferences: { ...POPUP_WEB_PREFERENCES },', 'webPreferences: POPUP_WEB_PREFERENCES as never,'],
  [BPW, 'the parent is dropped', '    parent: ctx.parent,\n', ''],
  [BPW, 'the window is created visible', '    show: false,\n', '    show: true,\n'],
  [BPW, 'the window is resizable (sway tiles it beside the app)', '    resizable: false,\n', '    resizable: true,\n'],
  [BPW, 'inherited page properties are read as options', 'Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined', '(o as Record<string, unknown>)[k]'],
  [BPW, 'the webContents feature check is case-insensitive-wrong (never matches)', "=== 'webContents'", "=== 'webContentz'"],
  [BPW, 'the title shows the page title before the origin', '`${origin} — ${title}`', '`${title} — ${origin}`'],
  [BPW, 'bidi override characters survive in the title', '\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', '\\u200e\\u200f]'],
  [BPW, 'the title is not cut', '.slice(0, TITLE_MAX)', '.slice(0, 5000)'],
  [BPW, 'the origin shows the full URL (query tokens)', "return parsed.origin !== 'null' ? parsed.origin : 'unknown origin';", "return parsed.href;"],
  // ---- gesture + registry + rate (main, Electron-free) ---------------------------------------------------------------------------------------
  [POP, 'a gesture is not consumed by the popup it opens', '  lastActivation.delete(wc);\n', ''],
  [POP, 'a gesture never expires', 'return now - at <= USER_GESTURE_WINDOW_MS;', 'return true;'],
  [POP, 'any input is a gesture', 'if (ACTIVATING_INPUT.has(input.type))', 'if (true)'],
  [POP, 'a navigation does not clear the gesture', "  wc.on('did-navigate', () => lastActivation.delete(wc));\n", ''],
  [POP, 'closing an opener leaves the windows its windows opened', '    if (child) closePopupsOpenedBy(wsId, child);\n', ''],
  [POP, 'closePopupWindows destroys nothing', '  for (const p of livePopupWindows(wsId)) destroyWindow(p);\n  windows.delete(wsId);', '  windows.delete(wsId);'],
  [POP, 'closePopupWindows keeps the opening history', '  windows.delete(wsId);\n  forgetPopupRate(wsId);', '  windows.delete(wsId);'],
  [POP, 'hiding a workspace leaves its child windows up', '    else p.win.hide();', ''],
  [POP, 'destroyed windows are never pruned from the count', '  for (const p of set) if (!alive(p)) set.delete(p);\n', ''],
  [POP, 'window ids are reused', '`w${++windowSeq}`', '`w${windowSeq}`'],
  [POP, 'a name held by the SAME workspace counts as held elsewhere', '    if (other === wsId) continue;\n', ''],
  [POP, 'the opening-rate window never expires', 'now - t < POPUP_RATE_WINDOW_MS', 'true'],
  [POP, 'the opening rate is not per workspace', "const list = pageOpens.get(wsId) ?? [];\n  list.push(now);\n  pageOpens.set(wsId, list);", "const list = pageOpens.get('*') ?? [];\n  list.push(now);\n  pageOpens.set('*', list);"],
  // ---- applying it (browser-panel.ts) --------------------------------------------------------------------------------------------------------
  [BP, 'a child window outlives its opener', 'outlivesOpener: false,', 'outlivesOpener: true,'],
  [BP, 'the guest\'s web preferences are not pinned', "overrideBrowserWindowOptions: { webPreferences: { ...POPUP_WEB_PREFERENCES } },\n", ''],
  [BP, 'the size is built without the parent size', '{ parent, parentSize: { width: bounds.width, height: bounds.height } }', '{ parent }'],
  [BP, 'child windows are not counted for the cap', '      openWindows: windows.length,', '      openWindows: 0,'],
  [BP, 'page-initiated tabs are not counted for the budget', 'panel.tabs.filter((t) => pageOpenedTabs.has(t)).length + ', '0 + '],
  [BP, 'page-initiated windows are not counted for the budget', 'windows.filter((w) => w.pageInitiated).length,', '0,'],
  [BP, 'a page-opened tab never records its budget', '        pageOpenedTabs.add(tab);\n', ''],
  [BP, 'a page-opened tab never records its opening', '        notePageInitiatedOpen(wsId, now);\n      }\n      return { action: \'deny\' };', '      }\n      return { action: \'deny\' };'],
  [BP, 'a page-initiated window never records its opening', "      if (route.pageInitiated) notePageInitiatedOpen(wsId, now);\n      return {\n        action: 'allow',", "      return {\n        action: 'allow',"],
  [BP, 'the recent-opens count is not given to the policy', '      recentPageInitiated: recentPageInitiatedOpens(wsId, now),\n', ''],
  [BP, 'the held-name check is not given to the policy', '      nameHeldElsewhere: frameNameHeldElsewhere(wsId, d.frameName),\n', '      nameHeldElsewhere: false,\n'],
  [BP, 'every popup counts as a user gesture', 'userGesture: consumeUserGesture(opener)', 'userGesture: true'],
  [BP, 'every popup tab activates', 'openedBy, activate: route.activate }', 'openedBy, activate: true }'],
  [BP, 'a popup tab is owned by the agent whoever opened it', 'createTab(wsId, { url: d.url, openedBy, activate: route.activate })', "createTab(wsId, { url: d.url, openedBy: 'agent', activate: route.activate })"],
  [BP, 'a popup from an evicted panel is still honoured', "  if (panels.get(wsId) !== panel) return { action: 'deny' }; // the panel was evicted or destroyed under this page\n", ''],
  [BP, 'a child window\'s own popups are not routed', '  watchPopups(panel, wc, openedBy);\n  if (focusedWsId', '  if (focusedWsId'],
  [BP, 'the factory ignores a panel that is gone', 'const gone = panels.get(wsId) !== panel;', 'const gone = false;'],
  [BP, 'the factory does not re-check the cap', 'const full = !gone && panel.tabs.length + livePopupWindows(wsId).length >= BROWSER_TAB_CAP;', 'const full = false;'],
  [BP, 'a refused guest is left windowless (not closed)', '    guest.close();\n    return guest;', '    return guest;'],
  [BP, 'a child window of a background workspace is shown', '  if (focusedWsId === wsId) {\n    if (pageInitiated) win.showInactive();', '  if (true) {\n    if (pageInitiated) win.showInactive();'],
  [BP, 'a page-initiated child window steals focus', 'if (pageInitiated) win.showInactive();', 'if (false) win.showInactive();'],
  [BP, 'the child window title never shows the origin', "  retitle('');\n", ''],
  [BP, 'the page may retitle the child window', '    e.preventDefault(); // the title is ours: the origin first, so a page cannot dress its window up as someone else\n', ''],
  [BP, 'the title is set on the webContents event, which cannot veto the native title', "  win.on('page-title-updated', (e, title) => {", "  wc.on('page-title-updated', (e, title) => {"],
  [BP, 'the popup\'s frame name is not recorded', 'frameName: d.frameName.trim() });', "frameName: '' });"],
  [BP, 'popup windows are not billed to their workspace (#394)', '      ...livePopupWindows(p.wsId).map((w) => ({ wsId: p.wsId, tabId: w.id, pid: w.win.webContents.getOSProcessId() })),\n', ''],
  [BP, 'tryOpenTab ignores popup windows for the cap', 'openCount: panel.tabs.length + livePopupWindows(wsId).length,', 'openCount: panel.tabs.length,'],
  [BP, 'destroyPanel leaves the child windows', '  closePopupWindows(wsId);\n', ''],
  [BP, 'an opener tab going away leaves its child windows', "  wc.once('destroyed', () => closePopupsOpenedBy(panel.wsId, wc));\n", ''],
  [BP, 'hidePanel leaves the child windows up', '  setPopupWindowsVisible(wsId, false);\n', ''],
  [BP, 'showPanel never brings the child windows back', '  setPopupWindowsVisible(wsId, true);\n', ''],
  [BP, 'a refusal logs the full URL (tokens)', 'url=${origin}`', 'url=${d.url}`'],
  [WS, 'a socket / bulk delete leaves the workspace\'s browser panel (and popup windows)', '  destroyBrowserPanel(id); // #396: every delete path (socket `orchestra delete`, bulk, repo removal) — its tabs and popup windows must not outlive it\n', ''],
];

if (process.argv.includes('--list')) { for (const [f, n] of MUTANTS) console.log(`${path.basename(f)}  ${n}`); process.exit(0); }

const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'popup-mut-'));
const files = [...new Set(MUTANTS.map((m) => m[0]))];
const backups = new Map(files.map((f) => { const b = path.join(dir, f.replaceAll('/', '__') + '.orig'); copyFileSync(path.join(root, f), b); return [f, b]; }));
const origs = new Map(files.map((f) => [f, readFileSync(path.join(root, f), 'utf8')]));
const restoreAll = () => { for (const [f, b] of backups) copyFileSync(b, path.join(root, f)); };
process.on('exit', restoreAll);
const same = () => files.every((f) => readFileSync(path.join(root, f)).equals(readFileSync(backups.get(f))));
const run = () => spawnSync('node', ['--test', '--experimental-strip-types', ...TESTS], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const count = (out, k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);

// Positive control: the UNMUTATED tree passes with real tests and 0 skipped (a rig that cannot say PASS proves nothing).
const base = run();
const bt = count(base.stdout, 'tests');
if (base.status !== 0 || !(bt > 0) || count(base.stdout, 'skipped') !== 0) { console.log(`BASELINE NOT CLEAN (rc ${base.status}, tests ${bt}) — abort\n` + base.stdout.slice(-1500)); process.exit(2); }
console.log(`baseline PASS (${bt} tests, 0 skipped)`);

let killed = 0; const bad = [];
for (const [file, name, find, replace] of MUTANTS) {
  const orig = origs.get(file);
  const n = orig.split(find).length - 1;
  if (n !== 1) { console.log(`ABORT: "${name}" find-string occurs ${n}x in ${file} (need exactly 1)`); restoreAll(); process.exit(2); }
  writeFileSync(path.join(root, file), orig.replace(find, () => replace));
  if (readFileSync(path.join(root, file), 'utf8') === orig) { console.log(`ABORT: "${name}" did not change ${file}`); restoreAll(); process.exit(2); }
  const r = run();
  restoreAll();
  const reds = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const crashed = /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|cancelled [1-9]/.test(r.stdout + r.stderr) || count(r.stdout, 'tests') !== bt;
  const dead = r.status !== 0 && reds.length > 0 && !crashed;
  if (dead) killed++; else bad.push(name);
  console.log(`${dead ? 'KILLED  ' : crashed ? 'CRASHED ' : 'SURVIVED'} [${path.basename(file)}] ${name}${dead ? `  (${reds.length} red; first: ${reds[0].slice(0, 70)})` : ''}`);
}
const ok = same();
console.log(`\n${killed}/${MUTANTS.length} killed; restore byte-exact (cmp): ${ok}`);
process.exit(bad.length || !ok ? 1 : 0);
