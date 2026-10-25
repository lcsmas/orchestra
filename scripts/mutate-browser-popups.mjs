// Must-FAIL proof for the popup routing (#396, ledger #405): src/shared/browser-tab-policy.test.ts + src/main/browser-popups.test.ts +
// src/main/browser-panel-popups.test.ts. Each mutant edits ONE clause of the real source IN PLACE; the three test files MUST go red on an
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
const TESTS = ['src/shared/browser-tab-policy.test.ts', 'src/main/browser-popups.test.ts', 'src/main/browser-panel-popups.test.ts'];

// [file, name, find (exactly once), replace]
export const MUTANTS = [
  [POL, 'unsafe URLs are no longer refused', "  if (kind === 'unsafe') {", "  if (kind === 'unsafe' && false) {"],
  [POL, 'an OS hand-off needs no click', '    return req.userGesture\n      ? { route: \'external\' }', '    return true\n      ? { route: \'external\' }'],
  [POL, 'the cap ignores child windows', 'ctx.openTabs + ctx.openWindows >= cap', 'ctx.openTabs >= cap'],
  [POL, 'the cap is off by one', 'ctx.openTabs + ctx.openWindows >= cap', 'ctx.openTabs + ctx.openWindows > cap'],
  [POL, 'the budget binds user gestures too', 'if (!req.userGesture && ctx.pageInitiatedOpen >= budget)', 'if (ctx.pageInitiatedOpen >= budget)'],
  [POL, 'the budget is never applied', 'if (!req.userGesture && ctx.pageInitiatedOpen >= budget)', 'if (false)'],
  [POL, 'the budget is off by one', 'ctx.pageInitiatedOpen >= budget)', 'ctx.pageInitiatedOpen > budget)'],
  [POL, 'a named popup is routed as a tab', "if (name !== '' && !['_blank', '_self', '_parent', '_top'].includes(name)) return true;", 'if (false) return true;'],
  [POL, 'a sized popup (new-window) is routed as a tab', "return req.disposition === 'new-window';", 'return false;'],
  [POL, 'noopener is ignored', 'if (featuresDenyOpener(req.features)) return false;', 'if (false) return false;'],
  [POL, 'noopener=0 denies the opener', "!['0', 'no', 'false'].includes(v)", 'true'],
  [POL, '`_blank` counts as a window name', "['_blank', '_self', '_parent', '_top'].includes(name)", "['_self', '_parent', '_top'].includes(name)"],
  [POL, 'a page-initiated popup activates its tab', "activate: req.userGesture && req.disposition !== 'background-tab'", "activate: req.disposition !== 'background-tab'"],
  [POL, 'a background-tab click activates its tab', "activate: req.userGesture && req.disposition !== 'background-tab'", 'activate: req.userGesture'],
  [POL, 'a page-initiated popup is not marked page-initiated', 'const pageInitiated = !req.userGesture;', 'const pageInitiated = false;'],
  [POL, 'the activation window is one minute', 'USER_GESTURE_WINDOW_MS = 5000', 'USER_GESTURE_WINDOW_MS = 60000'],
  [POP, 'a gesture is not consumed by the popup it opens', '  lastActivation.delete(wc);\n', ''],
  [POP, 'a gesture never expires', 'return now - at <= USER_GESTURE_WINDOW_MS;', 'return true;'],
  [POP, 'any input is a gesture', 'if (ACTIVATING_INPUT.has(input.type))', 'if (true)'],
  [POP, 'closing an opener leaves the windows its windows opened', '    if (child) closePopupsOpenedBy(wsId, child);\n', ''],
  [POP, 'closePopupWindows destroys nothing', '  for (const p of livePopupWindows(wsId)) destroyWindow(p);\n  windows.delete(wsId);', '  windows.delete(wsId);'],
  [POP, 'hiding a workspace leaves its child windows up', '    else p.win.hide();', ''],
  [POP, 'destroyed windows are never pruned from the count', '  for (const p of set) if (!alive(p)) set.delete(p);\n', ''],
  [BP, 'a child window is created visible', 'show: false, // shown by adoptPopupWindow', 'show: true, // shown by adoptPopupWindow'],
  [BP, 'a child window is not sandboxed', 'webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },', 'webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },'],
  [BP, 'a child window outlives its opener', 'outlivesOpener: false,', 'outlivesOpener: true,'],
  [BP, 'a child window is resizable (sway tiles it beside the app)', '          resizable: false, // sway TILES a resizable child window beside the app (halving it); a fixed-size one floats (measured)\n', ''],
  [BP, 'a child window has no parent', '          ...(parent ? { parent } : {}),\n', ''],
  [BP, 'child windows are not counted for the cap', '      openWindows: windows.length,', '      openWindows: 0,'],
  [BP, 'page-initiated tabs are not counted for the budget', 'panel.tabs.filter((t) => pageOpenedTabs.has(t)).length + ', '0 + '],
  [BP, 'page-initiated windows are not counted for the budget', 'windows.filter((w) => w.pageInitiated).length,', '0,'],
  [BP, 'a page-opened tab never records its budget', '      if (route.pageInitiated) pageOpenedTabs.add(tab);\n', ''],
  [BP, 'every popup counts as a user gesture', 'userGesture: consumeUserGesture(opener)', 'userGesture: true'],
  [BP, 'every popup tab activates', 'openedBy, activate: route.activate }', 'openedBy, activate: true }'],
  [BP, 'a popup tab is owned by the agent whoever opened it', 'createTab(wsId, { url: d.url, openedBy, activate: route.activate })', "createTab(wsId, { url: d.url, openedBy: 'agent', activate: route.activate })"],
  [BP, 'a popup from an evicted panel is still honoured', "  if (panels.get(wsId) !== panel) return { action: 'deny' }; // the panel was evicted or destroyed under this page\n", ''],
  [BP, 'a child window\'s own popups are not routed', '  watchPopups(panel, win.webContents, meta.openedBy);\n', ''],
  [BP, 'an unrequested window is left open', '    win.destroy(); // not a window routePopup asked for, or its panel is gone: never leave it open\n', '    // left open\n'],
  [BP, 'a child window of a background workspace is shown', '  if (focusedWsId === panel.wsId) {\n    if (meta.pageInitiated)', '  if (true) {\n    if (meta.pageInitiated)'],
  [BP, 'a page-initiated child window steals focus', 'if (meta.pageInitiated) win.showInactive();', 'if (false) win.showInactive();'],
  [BP, 'destroyPanel leaves the child windows', '  closePopupWindows(wsId);\n', ''],
  [BP, 'an opener tab going away leaves its child windows', "  wc.once('destroyed', () => closePopupsOpenedBy(panel.wsId, wc));\n", ''],
  [BP, 'hidePanel leaves the child windows up', '  setPopupWindowsVisible(wsId, false);\n', ''],
  [BP, 'showPanel never brings the child windows back', '  setPopupWindowsVisible(wsId, true);\n', ''],
  [BP, 'a refusal logs the full URL (tokens)', 'url=${origin}`', 'url=${d.url}`'],
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
