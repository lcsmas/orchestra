// Self-test of the UI idle-budget gate (#215 / C8): drives scripts/e2e-ui-idle-budget.sh through must-PASS and must-FAIL arms.
// The MUTANTS are in-place edits of the BUILT renderer (dist/assets/index-*.{js,css}): byte-exact backup, restored + `cmp`-ed
// on every exit path. Every arm asserts the rc AND the clause/site STRING it must name (an rc alone is never the verdict).
//   node scripts/verify-ui-idle-budget.mjs [<app-dir>] [--window-ms N] [--only a,b] [--unfixed-app <built pre-T9 checkout>]
//   (build first: pnpm run build:bundles). --unfixed-app adds the REAL historical defect: a build from before #198 T9 (e.g. 4c1d2dc5) must FAIL.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const APP = fs.realpathSync(argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--'))) ?? path.join(HERE, '..'));
const WINDOW_MS = flag('window-ms', '5000');
const ONLY = flag('only', '') ? flag('only', '').split(',') : null;
const UNFIXED = flag('unfixed-app', '');
const GATE = path.join(HERE, 'e2e-ui-idle-budget.sh');
const REAL_HOME = os.userInfo().homedir;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── host guard: a timing-free gate still needs a machine that can boot Electron promptly ──
const load = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const memAvailGb = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
if (load > 20 || memAvailGb < 6) { console.error(`VOID: load ${load} (max 20) / MemAvailable ${memAvailGb.toFixed(1)} GB (min 6) — re-run later`); process.exit(3); }

// The gate runs with --require-bus (as the release gate does): the shipped app has a fleet bus. That needs the Electron-ABI
// binding stash (pnpm run build:bus-abi) — refuse up front rather than fail every arm for that one reason.
if (!fs.existsSync(path.join(APP, 'build', 'bus-abi', 'better_sqlite3-abi130.node'))) { console.error(`ABORT: ${APP}/build/bus-abi/better_sqlite3-abi130.node missing — run pnpm run build:bus-abi (the app's fleet bus cannot open without it)`); process.exit(2); }

// ── the built bundles, mutated in place ──
const assets = path.join(APP, 'dist', 'assets');
const jsFiles = fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f) && fs.readFileSync(path.join(assets, f), 'utf8').includes('row-measure loop guard tripped'));
const cssFiles = fs.readdirSync(assets).filter((f) => /^index-.*\.css$/.test(f));
if (jsFiles.length !== 1 || cssFiles.length !== 1) { console.error(`ABORT: expected exactly one renderer index js (${jsFiles}) and css (${cssFiles}) in ${assets} — rebuild`); process.exit(2); }
const JS = path.join(assets, jsFiles[0]), CSS = path.join(assets, cssFiles[0]);
const backupDir = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'ui-idle-budget-selftest.'));
const ORIG = new Map([[JS, fs.readFileSync(JS)], [CSS, fs.readFileSync(CSS)]]);
for (const [f, b] of ORIG) fs.writeFileSync(path.join(backupDir, path.basename(f)), b);
let restored = 0;
function restoreAll() {
  for (const [f, b] of ORIG) {
    fs.writeFileSync(f, b);
    if (Buffer.compare(fs.readFileSync(f), fs.readFileSync(path.join(backupDir, path.basename(f)))) !== 0 || sha(fs.readFileSync(f)) !== sha(b)) throw new Error(`RESTORE FAILED for ${f}`);
    restored++;
  }
}
let mutated = false;
const cleanup = () => { if (mutated) { restoreAll(); mutated = false; } };
process.on('exit', () => { try { cleanup(); } catch (e) { console.error(String(e)); process.exitCode = 9; } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

// ── mutants ──
// Each mutant is an in-place edit of the BUILT renderer: `js(src)` / `css` transform the ORIGINAL bytes. Per-pane code goes in front of
// `return{recordPass(` (createMeasurePassGuard's construction: StructuredView builds one per mounted pane), so it runs once per pane.
const JS_ANCHOR = /const (\w+)=(\w+)\(\(\)=>(\w+)=0,(\w+),(\w+)\);return\{recordPass\(/g;
const paneInject = (code) => (src) => {
  const hits = [...src.matchAll(JS_ANCHOR)];
  if (hits.length !== 1) throw new Error(`PATTERN-GONE (not a survivor): mutant anchor matched ${hits.length}x in ${JS} (want exactly 1) — the minified shape changed, re-aim the mutant`);
  const out = src.replace(JS_ANCHOR, (m) => m.replace('return{recordPass(', `${code}return{recordPass(`));
  if (out === src) throw new Error('mutant replacement was a no-op');
  return out;
};
const MUTANTS = {
  // T9's defect, re-introduced per pane: a self-rescheduling rAF started when the pane's guard is created.
  paneRaf: { js: paneInject('(function __c8MutantPaneRafLoop(){requestAnimationFrame(__c8MutantPaneRafLoop)})();') },
  // An infinite CSS animation on every pane's message list (only the visible pane runs it: hidden panes are display:none).
  paneCss: { css: '\n.av-message-list{animation:c8-mutant-infinite-pane 1s linear infinite}@keyframes c8-mutant-infinite-pane{from{opacity:1}to{opacity:.999}}\n' },
  // F1 classes the rAF counter never sees. One mutant per class; each must redden ITS clause and name itself.
  timer16: { js: paneInject('(function __c8MutantTimer16(){setInterval(function(){document.body.style.setProperty("--c8-t",String(performance.now()))},16)})();') },
  timeoutChain: { js: paneInject('(function __c8MutantTimeoutChain(){setTimeout(__c8MutantTimeoutChain,0)})();') },
  roLoop: { js: paneInject('(function __c8MutantRoInit(){var d=document.createElement("div");d.style.cssText="position:fixed;left:0;top:0;width:100px;height:10px";document.body.appendChild(d);new ResizeObserver(function(){d.style.width=(parseInt(d.style.width,10)===100?101:100)+"px"}).observe(d)})();') },
  // 200 ms period: NOT a short timer, so only the MutationObserver clause can name it.
  moLoop: { js: paneInject('(function __c8MutantMoInit(){var d=document.createElement("div");document.body.appendChild(d);var n=0,mo=new MutationObserver(function(){setTimeout(function(){d.setAttribute("data-c8",String(n++))},200)});mo.observe(d,{attributes:true});d.setAttribute("data-c8","0")})();') },
  // No rAF / timer / RO / MO at all: a MessageChannel ping-pong forcing a style recalc per message — only the getMetrics catch-all sees it.
  mcLoop: { js: paneInject('(function __c8MutantMcInit(){if(window.__c8mc)return;window.__c8mc=1;var ch=new MessageChannel(),d=document.createElement("div");document.body.appendChild(d);var n=0;ch.port1.onmessage=function __c8MutantMcLoop(){d.style.width=(n++%2?"7px":"8px");void getComputedStyle(d).width;ch.port2.postMessage(0)};ch.port2.postMessage(0)})();') },
  // F3 census evasions in ONE mutant: iteration count 1e8 (CSS), a class that churns every 500 ms, an animation inside an OPEN shadow root.
  evasions: {
    js: paneInject('(function __c8MutantEvade(){if(window.__c8ev)return;window.__c8ev=1;var f=document.createElement("div");f.style.cssText="position:fixed;left:0;top:2px;width:3px;height:3px";document.body.appendChild(f);var st=document.createElement("style");st.textContent="@keyframes c8-flip{from{opacity:1}to{opacity:.99}}.c8f{animation:c8-flip 1s linear infinite}";document.head.appendChild(st);var i=0;f.className="c8f c8flip-0";setInterval(function(){f.className="c8f c8flip-"+(++i)},500);var h=document.createElement("div");document.body.appendChild(h);var sr=h.attachShadow({mode:"open"});var e=document.createElement("div");e.style.cssText="width:3px;height:3px";sr.appendChild(e);e.animate([{opacity:1},{opacity:.99}],{duration:1000,iterations:Infinity,id:"c8-shadow"})})();'),
    css: '\n@keyframes c8-big{from{opacity:1}to{opacity:.999}}.av-message-list{animation:c8-big 1s linear 100000000}\n',
  },
  // F4: the bundle captures requestAnimationFrame AT MODULE LOAD and loops through the captured reference.
  capturedRaf: { js: (src) => paneInject('(function __c8MutantCapturedRafLoop(){__c8Raf(__c8MutantCapturedRafLoop)})();')(`var __c8Raf=window.requestAnimationFrame.bind(window);\n${src}`) },
};
function applyMutant(name) {
  restoreIfDirty();
  if (!name) return;
  mutated = true;
  const m = MUTANTS[name];
  if (!m) throw new Error(`unknown mutant ${name}`);
  if (m.js) fs.writeFileSync(JS, m.js(ORIG.get(JS).toString('utf8')));
  if (m.css) fs.writeFileSync(CSS, `${ORIG.get(CSS).toString('utf8')}${m.css}`);
  for (const [f, want] of [[JS, m.js], [CSS, m.css]]) {
    if (want && sha(fs.readFileSync(f)) === sha(ORIG.get(f))) throw new Error(`mutant ${name} left ${f} byte-identical`);
  }
}
function restoreIfDirty() { if (mutated) { restoreAll(); mutated = false; } }

// ── one gate run ──
function runGate(args, { env = {}, app = APP } = {}) {
  const t0 = Date.now();
  const r = spawnSync(GATE, [app, '--window-ms', WINDOW_MS, ...(args.includes('--no-require-bus') ? args.filter((a) => a !== '--no-require-bus') : ['--require-bus', ...args])], { encoding: 'utf8', timeout: 240000, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: REAL_HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/run/user/1000', ...env } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { rc: r.status, out, sec: Math.round((Date.now() - t0) / 1000), pageSha: /page sha256 ([0-9a-f]{16})/.exec(out)?.[1] ?? null, launched: /app pid \d+ in my sway/.test(out) };
}

const RESULTS = [];
let cleanSha = null;
function arm(name, { mutant = null, args = [], env = {}, app = APP, rc, must = [], mustNot = [], note = '', extra = null }) {
  if (ONLY && !ONLY.includes(name)) return;
  applyMutant(mutant);
  const r = runGate(args, { env, app });
  const fails = [];
  if (r.rc !== rc) fails.push(`rc ${r.rc} != ${rc}`);
  for (const s of must) if (!r.out.includes(s)) fails.push(`output lacks «${s}»`);
  for (const s of mustNot) if (r.out.includes(s)) fails.push(`output contains forbidden «${s}»`);
  if (extra) { const e = extra(r); if (e) fails.push(e); }
  const ok = fails.length === 0;
  RESULTS.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''} (rc ${r.rc}, ${r.sec}s, page sha ${r.pageSha})`);
  if (!ok) { console.log(`      why: ${fails.join(' | ')}`); console.log(r.out.split('\n').filter((l) => /^(ok |FAIL|REFUSE|ui-idle|REFUSED|ABORT|FATAL|\[uib\] (budget|bundle|settled))/.test(l)).slice(0, 14).map((l) => `      | ${l.slice(0, 300)}`).join('\n')); }
  return r;
}
const shaDiffers = (r) => (r.pageSha && cleanSha && r.pageSha !== cleanSha ? null : `page sha ${r.pageSha} must differ from the clean build's ${cleanSha} (the MUTATED bytes must be what ran)`);
const liveDir = [path.join(REAL_HOME, '.claude'), ...fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude-')).map((n) => path.join(REAL_HOME, n))].find((d) => fs.existsSync(d));

// A0: clean build, shipped budget → PASS (also the reference bundle hash)
const a0 = arm('clean-passes', { rc: 0, must: ['ok     control/bus-open', 'ui-idle-budget: PASS', 'ok     budget/idle-raf: 0 rAF callback(s)', 'ok     budget/infinite-animations', 'ok     control/panes-mounted', 'ok     control/rich-subject', 'ok     control/panes-idle', 'ok     control/raf-instrument', 'ok     control/observer-instrument', 'ok     control/instrument-first', 'ok     control/turn-animations', 'ok     control/bundle-identity', 'ok     budget/short-timer-loops', 'ok     budget/resize-observer', 'ok     budget/mutation-observer', 'ok     budget/metrics'], note: 'must-PASS: 6 idle panes with a rich real-transcript subject, 0 per-frame work, only the allowlisted caret blink' });
cleanSha = a0?.pageSha ?? null;
// A1: the T9 loop re-introduced in every pane (in-place mutant of the built renderer) → FAIL naming the loop
arm('mutant-pane-raf-loop', { mutant: 'paneRaf', rc: 1, must: ['FAIL   budget/idle-raf', '__c8MutantPaneRafLoop'], mustNot: ['ui-idle-budget: PASS'], extra: shaDiffers, note: 'must-FAIL: perpetual rAF per pane → budget/idle-raf naming __c8MutantPaneRafLoop' });
// A2: an infinite CSS animation on an idle pane → FAIL naming the animation
arm('mutant-pane-infinite-css', { mutant: 'paneCss', rc: 1, must: ['FAIL   budget/infinite-animations', 'c8-mutant-infinite-pane'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: infinite CSS animation on an idle pane → budget/infinite-animations naming it' });
// A3: a BLIND counter over a real loop must be REFUSED, never PASS (the false-green this rig exists to prevent)
arm('blind-counter-refused', { mutant: 'paneRaf', args: ['--selftest-blind-raf'], rc: 4, must: ['REFUSE control/raf-instrument'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: counter forwards without counting + a real loop → control/raf-instrument REFUSES' });
// A4: panes never mount → REFUSED (a 0 over no panes is vacuous)
arm('unmounted-panes-refused', { args: ['--selftest-no-seed'], rc: 4, must: ['REFUSED: 6 structured panes never all mounted'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: no seed → subject absent → REFUSED' });
// A5: a pane left mid-turn is not idle → REFUSED naming panes-idle
arm('open-turns-refused', { args: ['--selftest-leave-turns-open'], rc: 4, must: ['REFUSE control/panes-idle', 'REFUSE control/turn-animations'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: turns left open → control/panes-idle REFUSES' });
// A5b: a HIDDEN window delivers no frames, so its 0 rAF is vacuous — with a real loop mounted it must be REFUSED, never PASS
arm('hidden-window-refused', { mutant: 'paneRaf', args: ['--selftest-hide-window'], rc: 4, must: ['REFUSE control/frames-delivered'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: window moved to the scratchpad (page hidden) + a real loop → control/frames-delivered REFUSES' });
// F1: per-frame work that is NOT rAF / CSS — one mutant per class, each must FAIL naming ITS clause and the site
arm('mutant-timer-16ms', { mutant: 'timer16', rc: 1, must: ['FAIL   budget/short-timer-loops', '__c8MutantTimer16'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: setInterval(16 ms) style writes → budget/short-timer-loops naming __c8MutantTimer16' });
arm('mutant-timeout0-chain', { mutant: 'timeoutChain', rc: 1, must: ['FAIL   budget/short-timer-loops', '__c8MutantTimeoutChain'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: self-rescheduling setTimeout(0) chain → budget/short-timer-loops naming __c8MutantTimeoutChain' });
arm('mutant-resize-observer-loop', { mutant: 'roLoop', rc: 1, must: ['FAIL   budget/resize-observer', '__c8MutantRoInit'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: ResizeObserver self-resize loop → budget/resize-observer naming __c8MutantRoInit' });
arm('mutant-mutation-observer-loop', { mutant: 'moLoop', rc: 1, must: ['FAIL   budget/mutation-observer', '__c8MutantMoInit', 'ok     budget/short-timer-loops'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: MutationObserver re-mutate loop (200 ms, not a short timer) → budget/mutation-observer only' });
arm('mutant-metrics-only-loop', { mutant: 'mcLoop', rc: 1, must: ['FAIL   budget/metrics', 'OVER:', 'ok     budget/idle-raf', 'ok     budget/short-timer-loops', 'ok     budget/resize-observer', 'ok     budget/mutation-observer'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: MessageChannel loop no counter names → ONLY the getMetrics catch-all reddens' });
// F3: census evasions (iteration count 1e8, churning class, open shadow root)
arm('mutant-census-evasions', { mutant: 'evasions', rc: 1, must: ['FAIL   budget/infinite-animations', 'c8-big@', 'c8-flip@', 'wapi:c8-shadow@'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: 1e8 iterations + class churn + open shadow root → all three named' });
// F4: a bundle that captured requestAnimationFrame at module load — caught by the first-script instrument, escapes a late one (which must REFUSE)
arm('mutant-captured-raf', { mutant: 'capturedRaf', rc: 1, must: ['FAIL   budget/idle-raf', '__c8MutantCapturedRafLoop'], mustNot: ['ui-idle-budget: PASS'], note: 'must-FAIL: module-load rAF capture loop → counted because the instrument precedes the bundle' });
arm('late-install-refused', { mutant: 'capturedRaf', args: ['--selftest-late-install'], rc: 4, must: ['REFUSE control/instrument-first'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: instrument installed after boot + captured-rAF loop → control/instrument-first REFUSES' });
arm('blind-observers-refused', { mutant: 'timer16', args: ['--selftest-blind-observers'], rc: 4, must: ['REFUSE control/observer-instrument'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: timer/RO/MO wrappers forward without counting + a real 16 ms loop → REFUSED, never PASS' });
arm('no-rich-subject-refused', { args: ['--selftest-no-rich'], rc: 4, must: ['REFUSE control/rich-subject'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: no real transcript / task panel mounted → control/rich-subject REFUSES' });
// A5c: the fleet bus is part of the shipped app — a run whose bus failed to open is REFUSED when the bus is required (release gate)…
arm('bus-required-refused', { args: ['--selftest-break-bus'], rc: 4, must: ['REFUSE control/bus-open', 'FAILED to open'], mustNot: ['ui-idle-budget: PASS'], note: 'rig mutant: bus.sqlite is a directory → bus: FAILED to open + --require-bus → REFUSED' });
// …and only reported (never refused) on a dev run
arm('bus-down-informational', { args: ['--no-require-bus', '--selftest-break-bus'], rc: 0, must: ['ui-idle-budget: PASS', 'ok     control/bus-open', 'informational'], note: 'same broken bus without --require-bus → PASS, reported as informational' });
// A6: strict zero on the CLEAN build fails naming the caret blink — the allowlist is load-bearing
arm('strict-zero-names-caret-blink', { args: ['--budget', 'none'], rc: 1, must: ['FAIL   budget/infinite-animations', 'cm-blink'], mustNot: ['ui-idle-budget: PASS'], note: 'the allowlist is what lets the clean build pass: strict zero → FAIL naming cm-blink' });
// A7-A9: isolation refusals — each names ITS clause and launches nothing
arm('refuse-wayland-1', { args: ['--selftest-force-wayland', 'wayland-1'], rc: 90, must: ['REFUSED before launch [refuse-wayland-1]'], mustNot: ['app pid'], note: "child forced onto the human's compositor" });
arm('refuse-x11-display', { args: ['--selftest-add-display', ':0'], rc: 90, must: ['REFUSED before launch [x11-display-set]'], mustNot: ['app pid'], note: 'DISPLAY injected into the child env' });
if (liveDir) arm('refuse-live-config-dir', { env: { CLAUDE_CONFIG_DIR_PIN: liveDir }, rc: 90, must: ['REFUSED before launch [handoff:CLAUDE_CONFIG_DIR:is-live-config]'], mustNot: ['app pid'], note: `config dir pinned at the LIVE ${liveDir}` });
// A9b (optional): the REAL unfixed build (pre-#198-T9: a perpetual rAF per pane, measured 372/s at 6 panes) fails through the same rig
if (UNFIXED) arm('unfixed-build-fails', { app: fs.realpathSync(UNFIXED), args: ['--no-require-bus'], rc: 1, must: ['FAIL   budget/idle-raf', 'ok     control/raf-instrument', 'ok     control/panes-mounted'], mustNot: ['ui-idle-budget: PASS'], note: `must-FAIL: the historical defect (${UNFIXED}) → budget/idle-raf` });
// A10: after every mutant is restored the clean build passes again on the SAME bytes (restore proven, not assumed)
arm('restored-clean-passes', { rc: 0, must: ['ui-idle-budget: PASS'], extra: (r) => (r.pageSha === cleanSha ? null : `page sha ${r.pageSha} != first clean run ${cleanSha}`), note: 'after cmp-verified restore, same bundle bytes, PASS again' });

restoreIfDirty();
const stillClean = [...ORIG].every(([f, b]) => Buffer.compare(fs.readFileSync(f), b) === 0);
console.log(`restore: ${restored} file restore(s) cmp-verified; bundles byte-identical to the originals: ${stillClean ? 'YES' : 'NO'}`);
const bad = RESULTS.filter((r) => !r.ok);
console.log(`${bad.length ? 'FAIL' : 'PASS'}: ${RESULTS.length - bad.length}/${RESULTS.length} arms${bad.length ? ` — failing: ${bad.map((r) => r.name).join(', ')}` : ''}`);
process.exit(bad.length || !stillClean ? 1 : 0);
