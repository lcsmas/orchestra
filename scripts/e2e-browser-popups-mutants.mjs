// #396 — must-FAIL proof for the BUILT-APP rig (scripts/e2e-browser-popups.sh): each mutant is applied IN PLACE to the real source, the app is
// REBUILT (a stale bundle reproduces perfectly: the bundle hash must differ from the clean build's), the rig runs only the arm(s) that own the
// clause, and the clause(s) named below must be RED while every ctl/* control stays GREEN (a red for the wrong reason is a failure). The sources are
// restored byte-exact (cmp) right after each build; a final CLEAN rebuild leaves dist/ matching the tree. Each find-string is checked LIVE (exactly one hit).
// `unfixed` is the ticket's own must-FAIL: today's same-view window-open handler (every http popup loads into the opener's view).
// Run: node scripts/e2e-browser-popups-mutants.mjs [id ...]      (exit 0 = every mutant killed for its named reason, tree restored)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = process.env.MUT_OUT || path.join(process.env.TMPDIR || os.tmpdir(), 'e2e-browser-popups-mutants');
fs.mkdirSync(OUT, { recursive: true });
const POL = 'src/shared/browser-tab-policy.ts';
const BP = 'src/main/browser-panel.ts';

// controls that only exist to SET UP a popup the broken build never makes: red there is the mutant's own doing, not a rig fault
const SETUP_CTL = ['ctl/surfaces-exist-before-the-archive', 'ctl/child-window-up-before-switching', 'ctl/the-page-really-fired-40-popups'];
const WATCH = "  wc.setWindowOpenHandler((details) => routePopup(panel, wc, openedBy, details));\n";
const SAME_VIEW = "  wc.setWindowOpenHandler((details) => {\n    if (/^https?:/i.test(details.url)) void wc.loadURL(details.url);\n    else void shell.openExternal(details.url);\n    return { action: 'deny' };\n  });\n";

// edits: [file, from, to] (each `from` must occur exactly once in the ORIGINAL file)
const BPW = 'src/shared/browser-popup-window.ts';
const POP = 'src/main/browser-popups.ts';
const MUTANTS = [
  { id: 'R0-unfixed-same-view-handler', arms: 'blank,oauth,xsite,s1', edits: [[BP, WATCH, SAME_VIEW]], setupCtl: true,
    red: ['blank-link-opens-a-new-tab', 'oauth-flow-completes-the-popup-posts-back-to-window-opener', 'cross-site-oauth-flow-completes-through-window-opener', 'script-storm-capped-by-the-budget'] },
  { id: 'R1-named-popup-routed-as-a-tab', arms: 'oauth,xsite', edits: [[POL, "if (name !== '' && !['_blank', '_self', '_parent', '_top'].includes(name)) return true;", 'if (false) return true;'], [POL, "return req.disposition === 'new-window' && req.features.trim() !== '';", 'return false;']], setupCtl: true,
    red: ['oauth-flow-completes-the-popup-posts-back-to-window-opener', 'the-popup-is-a-window-not-a-tab', 'cross-site-oauth-flow-completes-through-window-opener'] },
  { id: 'R2-budget-never-applied', arms: 's1', edits: [[POL, 'if (!req.userGesture && ctx.pageInitiatedOpen >= budget)', 'if (false)']],
    red: ['script-storm-capped-by-the-budget'] },
  { id: 'R3-every-popup-is-a-gesture', arms: 's1,s4', edits: [[BP, 'userGesture: consumeUserGesture(opener)', 'userGesture: true']],
    red: ['script-storm-capped-by-the-budget', 'script-storm-never-steals-the-active-tab'] },
  { id: 'R4-cap-ignored', arms: 's3', edits: [[POL, 'ctx.openTabs + ctx.openWindows >= cap', 'false']],
    red: ['storm-near-the-cap-stops-at-eight-tabs'] },
  { id: 'R5-budget-ignores-windows', arms: 's2,s2b', edits: [[BP, 'windows.filter((w) => w.pageInitiated).length,', '0,']],
    red: ['mixed-storm-budget-counts-tabs-and-windows-together'] },
  { id: 'R6-gesture-not-consumed', arms: 's4', edits: [[POP, '  lastActivation.delete(wc);\n', '']],
    red: ['one-click-opens-one-popup-plus-the-budget'] },
  { id: 'R7-popup-tab-always-activates', arms: 's1,s4', edits: [[BP, 'openedBy, activate: route.activate }', 'openedBy, activate: true }']],
    red: ['script-storm-never-steals-the-active-tab'] },
  { id: 'R8-hidePanel-leaves-the-child-window', arms: 'oauth,ws', edits: [[BP, '  setPopupWindowsVisible(wsId, false);\n', '']], setupCtl: false,
    red: ['switching-workspace-takes-the-child-window-away'] },
  { id: 'R9-child-window-resizable-tiled', arms: 'oauth', edits: [[BPW, '    resizable: false,\n', '    resizable: true,\n']],
    red: ['the-child-window-floats-instead-of-tiling-the-app'] },
  { id: 'R10-archive-leaves-the-child-windows', arms: 'cleanup', edits: [[BP, '  closePopupWindows(wsId);\n', ''], [BP, "  wc.once('destroyed', () => closePopupsOpenedBy(panel.wsId, wc));\n", ''], [BP, 'outlivesOpener: false,', 'outlivesOpener: true,']],
    red: ['closing-the-opener-tab-closes-its-child-window', 'archive-leaves-no-tab-view-and-no-popup-window'] },
  { id: 'R11-gesture-survives-a-navigation', arms: 's2c', edits: [[POP, "  wc.on('did-navigate', () => lastActivation.delete(wc));\n", '']],
    red: ['a-click-on-page-A-is-no-gesture-for-the-page-it-navigated-to'] },
  { id: 'R12-featureless-new-window-is-a-native-window', arms: 'blank', edits: [[POL, "return req.disposition === 'new-window' && req.features.trim() !== '';", "return req.disposition === 'new-window';"]],
    red: ['shift-click-opens-a-tab-not-a-native-window'] },
  { id: 'R13-closed-opener-tab-leaves-its-child-window', arms: 'cleanup', edits: [[BP, "  wc.once('destroyed', () => closePopupsOpenedBy(panel.wsId, wc));\n", ''], [BP, 'outlivesOpener: false,', 'outlivesOpener: true,']],
    red: ['closing-the-opener-tab-closes-its-child-window'] },
  // review fix round (F1-F4)
  { id: 'R14-child-size-not-clamped-to-the-app-window', arms: 'hostile', edits: [[BPW, 'parentMax === undefined ? POPUP_WINDOW_MAX : Math.max(min, Math.floor(parentMax * POPUP_WINDOW_PARENT_SHARE))', 'POPUP_WINDOW_MAX']],
    red: ['hostile-popup-opens-as-a-bounded-window'] },
  { id: 'R15-pages-features-spread-into-the-window', arms: 'hostile', edits: [[BPW, '    autoHideMenuBar: true,\n    resizable: false,', '    ...(given as object),\n    autoHideMenuBar: true,\n    resizable: false,']],
    red: ['hostile-popup-opens-as-a-bounded-window', 'hostile-popup-is-not-fullscreen-and-floats-over-the-app'] },
  { id: 'R16-page-may-retitle-the-child-window', arms: 'oauth', edits: [[BP, '    e.preventDefault(); // the title is ours: the origin first, so a page cannot dress its window up as someone else\n', '']],
    red: ['child-window-title-shows-the-origin-first'] },
  { id: 'R19-page-resize-applies-to-popup-windows', arms: 'hostile', edits: [[BP, "  wc.on('content-bounds-updated', (e) => e.preventDefault());\n  watchPopups(panel, wc, openedBy);", '  watchPopups(panel, wc, openedBy);']],
    red: ['page-resizeTo-moveTo-cannot-change-the-popup-bounds'] },
  { id: 'R21-mailto-tel-need-no-click', arms: 'extproto', edits: [[BP, 'const userGesture = isOsHandoffUrl(url) && !!wc && consumeUserGesture(wc);', 'const userGesture = true;']],
    red: ['no-click-mailto-and-tel-by-load-time-navigation-or-a-click-or-window-open-launch-nothing'] },
  { id: 'R20-external-protocols-reach-the-os', arms: 'extproto', edits: [[BP, '  guardExternalProtocols(ses);\n', '']],
    red: ['ssh-and-zoom-link-clicks-in-a-tab-launch-nothing', 'ssh-and-zoom-link-clicks-in-a-popup-window-launch-nothing'] },
  { id: 'R17-no-per-minute-rate-cap', arms: 'churn', edits: [[POL, "if (!req.userGesture && (ctx.recentPageInitiated ?? 0) >= rateMax) {", 'if (false) {']],
    red: ['churn-named-opens-at-most-6-per-minute'] },
  { id: 'R18-webcontents-feature-not-refused', arms: 'hostile', edits: [[POL, '  if (featuresSmuggleWebContents(req.features)) {', '  if (false) {']],
    red: ['webcontents-feature-is-refused-without-a-window'] },
];

// `--check`: static anchor proof (no build, no rig, nothing written): every edit's `from` must occur EXACTLY ONCE in its current file.
if (process.argv.includes('--check')) {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, from] of m.edits) {
    total++;
    const n = fs.readFileSync(path.join(ROOT, f), 'utf8').split(from).length - 1;
    if (n !== 1) { bad++; console.log(`ANCHOR ${n === 0 ? 'MISSING' : `x${n}`}  ${m.id}  [${path.basename(f)}] ${from.slice(0, 70).replace(/\n/g, '⏎')}`); }
  }
  console.log(`${total - bad}/${total} edit anchors live`);
  process.exit(bad ? 1 : 0);
}
const only = process.argv.slice(2);
const sh = (cmd, args, opt = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opt });
const files = [...new Set(MUTANTS.flatMap((m) => m.edits.map((e) => e[0])))];
const backups = new Map();
for (const f of files) { const b = path.join(OUT, `${f.replaceAll('/', '__')}.orig`); fs.copyFileSync(path.join(ROOT, f), b); backups.set(f, b); }
const restoreAll = () => { for (const [f, b] of backups) fs.copyFileSync(b, path.join(ROOT, f)); };
let cleaned = false;
process.on('exit', () => { if (!cleaned) restoreAll(); });
process.on('SIGINT', () => process.exit(130));
const cmpAll = () => files.every((f) => fs.readFileSync(path.join(ROOT, f)).equals(fs.readFileSync(backups.get(f))));
/** md5 of dist-electron/main.js: it names its hashed chunks, so a mutant in main.js OR in a shared chunk changes it; stale chunks left by earlier builds (emptyOutDir:false) do not. */
const bundleHash = () => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'dist-electron', 'main.js'))).digest('hex');
const build = () => sh('nice', ['-n', '10', 'pnpm', 'exec', 'vite', 'build']);

const rows = []; let bad = 0;
const rowsPush = rows.push.bind(rows);
rows.push = (...r) => { for (const x of r) console.log(`${x[0].padEnd(18)} ${x[1]}`); return rowsPush(...r); }; // progress is printed as it happens: an aborted sweep must not hide the rows it finished
const base = build();
if (base.status !== 0) { console.log('CLEAN BUILD FAILED\n' + base.stderr.slice(-1500)); process.exit(2); }
const cleanHash = bundleHash();
console.log(`clean bundle ${cleanHash}`);
for (const m of MUTANTS) {
  if (only.length && !only.includes(m.id)) continue;
  const orig = new Map();
  let live = true;
  for (const [f, from] of m.edits) { const s = orig.get(f) ?? fs.readFileSync(path.join(ROOT, f), 'utf8'); orig.set(f, s); if (s.split(from).length - 1 !== 1) { rows.push(['STRING-NOT-LIVE', `${m.id}: ${from.slice(0, 60).replace(/\n/g, '⏎')}`]); live = false; } }
  if (!live) { bad++; continue; }
  const mutated = new Map(orig);
  for (const [f, from, to] of m.edits) mutated.set(f, mutated.get(f).replace(from, () => to));
  for (const [f, s] of mutated) fs.writeFileSync(path.join(ROOT, f), s);
  let built;
  try { built = build(); } finally { restoreAll(); }
  if (!cmpAll()) { rows.push(['NOT-RESTORED', m.id]); bad++; continue; }
  if (built.status !== 0) { rows.push(['BUILD-FAILED', `${m.id}: ${built.stderr.split('\n').slice(-5).join(' ')}`]); bad++; continue; }
  const h = bundleHash();
  if (h === cleanHash) { rows.push(['STALE-BUNDLE', `${m.id}: the mutant never reached dist-electron/`]); bad++; continue; }
  // RC 90 + "cannot prove which display is mine" = the marker race under load (fail-closed): retried. ANY other RC 90 (the private-runtime PREFLIGHT, incident Q2)
  // is never worked around: the run stops. A VERDICT is never retried.
  let rig;
  for (let attempt = 1; attempt <= 4; attempt++) {
    // fleet rule (ledger #405, 2026-10-26): at most 3 contained-rig Electron trees at once — one slot per rig RUN, never per sweep
    const slot = process.env.GUI_SLOT ?? '/var/tmp/orch-1000-b17728/gui-slot.sh';
    const rigArgs = [path.join(ROOT, 'scripts/e2e-browser-popups.sh'), ROOT, '--arms', m.arms, '--label', m.id, '--out', OUT];
    rig = fs.existsSync(slot) ? sh(slot, rigArgs) : sh(rigArgs[0], rigArgs.slice(1));
    const out = rig.stdout + rig.stderr;
    // compositor start-up failures under load (my own sway died / never mapped): retried like the marker race; the private-runtime PREFLIGHT is neither of these
    const startupRace = out.includes('cannot prove which display is mine') || out.includes('could not set the marker on my own output');
    if (rig.status === 90 && !startupRace) { console.log(`RIG PREFLIGHT ABORT (rc 90) on ${m.id} — not retried, tell OPS:\n${out.split('\n').filter((l) => l.includes('ABORT')).join('\n')}`); process.exit(90); }
    if (rig.status !== 90) break;
    spawnSync('sleep', ['20']);
  }
  fs.writeFileSync(path.join(OUT, `${m.id}.log`), rig.stdout + rig.stderr);
  let res = null; try { res = JSON.parse(fs.readFileSync(path.join(OUT, `${m.id}-result.json`), 'utf8')); } catch {}
  if (!res) { rows.push(['RIG-NO-RESULT', `${m.id} rc=${rig.status} (see ${m.id}.log)`]); bad++; continue; }
  const redNames = res.results.filter((r) => !r.ok).map((r) => r.clause);
  const ctlRed = redNames.filter((c) => (c.startsWith('ctl/') || c.startsWith('rig/')) && !(m.setupCtl && SETUP_CTL.includes(c)));
  const namedRed = m.red.every((c) => redNames.includes(c));
  const ok = rig.status !== 0 && namedRed && ctlRed.length === 0;
  if (!ok) bad++;
  rows.push([ok ? 'KILLED' : rig.status === 0 ? 'SURVIVED' : ctlRed.length ? 'WRONG-REASON' : 'NOT-NAMED-CLAUSE', `${m.id} [${h.slice(0, 8)}]: red = ${redNames.join(', ') || 'none'}${ctlRed.length ? ` | CONTROLS RED: ${ctlRed.join(', ')}` : ''}${namedRed ? '' : ` | wanted ${m.red.join(', ')}`}`]);
}

// leave a CLEAN build behind (full bundles, so dist/ matches the restored tree)
cleaned = true;
restoreAll();
const clean = sh('nice', ['-n', '10', 'pnpm', 'run', 'build:bundles']);
rows.push([clean.status === 0 && bundleHash() === cleanHash ? 'CLEAN-REBUILD-OK' : 'CLEAN-REBUILD-DIFFERS', `dist-electron hash ${bundleHash()} (clean ${cleanHash})`]);
if (clean.status !== 0 || bundleHash() !== cleanHash) bad++;
console.log(`\n${rows.filter((r) => r[0] === 'KILLED').length}/${only.length || MUTANTS.length} killed; ${bad ? `${bad} PROBLEM(S)` : 'all clean'}`);
process.exit(bad ? 1 : 0);
