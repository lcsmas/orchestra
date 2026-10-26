// #391 — tabs registry prefactor, on the BUILT app in the contained rig's own headless sway.
//   app    arm: the renderer flow is UNCHANGED (open pane, navigate, back, hide/show) with exactly one
//          tab (t1/human) mirrored into BrowserPanelState; pixels read back from the composited output (grim).
//   probe  arm: the REAL bundled browser-panel.ts over REAL WebContentsViews (scripts/e2e-browser-tabs-probe.cjs):
//          N>1 tabs, activate/close/reap/destroy, composited colour + child-view count after each step.
//   --mutant <name>  rebuilds the probe bundle with one clause broken; the probe arm must go RED on
//          the named clause while its controls stay GREEN (exit 0 only then).
// Usage (via scripts/e2e-browser-tabs-registry.sh): <app-dir> --live-cfg <live claude dir> [--arm app,probe] [--mutant destroy-active-only|no-detach-prev] [--out dir]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { decodePng, share } = require_('./e2e-browser-tabs-png.cjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_CFG = flag('--live-cfg', null);
const ARMS = flag('--arm', 'app,probe').split(',');
const MUTANT = flag('--mutant', null);
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
const MUTANTS = {
  'destroy-active-only': { find: 'for (const tab of panel.tabs) destroyTab(tab);\n  notifyPanelListeners(wsId, [], true);', replace: 'destroyTab(activeTabOf(panel)!);\n  notifyPanelListeners(wsId, [], true);', red: 'destroyPanel closes EVERY tab' },
  'no-detach-prev': { find: 'if (prev) detachTab(panel, prev);', replace: '', red: 'activateTab swaps the composited view' },
};
// Static drift guard (no rig, no app): every mutant's find-string must occur EXACTLY once in src/main/browser-panel.ts, or `--mutant <name>` dies at
// the bundler (this is what #395 did to `destroy-active-only` unnoticed). Run: node scripts/e2e-browser-tabs-registry.mjs --check-anchors
if (argv.includes('--check-anchors')) {
  const src = fs.readFileSync(path.join(repoRoot, 'src/main/browser-panel.ts'), 'utf8');
  let bad = 0;
  for (const [name, m] of Object.entries(MUTANTS)) { const n = src.split(m.find).length - 1; const ok = n === 1 && m.find !== m.replace; if (!ok) bad++; console.log(`${ok ? 'ok ' : 'BAD'} ${name}: find-string occurs ${n}x in src/main/browser-panel.ts (need exactly 1)`); }
  console.log(bad ? `ANCHORS: ${bad} drifted` : `ANCHORS: all ${Object.keys(MUTANTS).length} match exactly once`);
  process.exit(bad ? 1 : 0);
}
if (!APP_DIR) refuse('no <app-dir>');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-tabs-registry.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const mustBeScratch = (what, p) => { const r = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p); if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) refuse(`${what}=${p} is outside the rig base ${RIG_BASE}`); if (/\/\.claude(-[^/]*)?(\/|$)/.test(r) || r.includes('/.config/orchestra') || /\/\.orchestra(\/|$)/.test(r)) refuse(`${what}=${p} is a live dir`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
async function waitFor(fn, ms, what) { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); } throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`); }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async key(key, code, vk) { for (const type of ['keyDown', 'keyUp']) { await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && key === 'Enter' ? '\r' : undefined }); await sleep(40); } }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(arm, name, ok, detail) { results.push({ arm, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function listProcsByHome(home) { const out = []; for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} } return out.filter((p) => p !== process.pid); }
function grim(name) { const f = path.join(OUT, name); sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: RIG_WAYLAND, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } }); const b = fs.readFileSync(f); shots.push({ file: f, md5: md5(b) }); return decodePng(b); }

const COLORS = { green: [0, 200, 83], blue: [41, 98, 255], bg: [26, 31, 38] };
function fixtureServer() {
  const srv = http.createServer((req, res) => { const c = COLORS[req.url.slice(1)] ?? COLORS.bg; res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><title>${req.url.slice(1)} fixture</title><body style="margin:0;background:rgb(${c.join(',')})">`); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function baseEnv(armDir, extra = {}) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  for (const d of [fakeHome, ohome, cfg]) fs.mkdirSync(d, { recursive: true });
  const env = { PATH: `/usr/local/bin:/usr/bin:/bin`, HOME: fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: ohome, ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: cfg, LANG: 'C.UTF-8', ...extra };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  return { env, fakeHome, ohome, cfg };
}

// ── app arm ───────────────────────────────────────────────────────────────────────────────────────
async function appArm() {
  const arm = 'app';
  console.log(`\n== arm ${arm} ==`);
  const armDir = path.join(RIG_DIR, 'arm-app'); fs.mkdirSync(armDir, { recursive: true });
  const port = await freePort();
  const { env, fakeHome, ohome, cfg } = baseEnv(armDir, { ORCHESTRA_DEBUG_PORT: String(port) });
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'tabs-1'); fs.mkdirSync(repoDir, { recursive: true }); fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repoDir, 'README.md'), '# seed\n'); git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/tabs-1', wtDir], fakeHome);
  const account = { id: 'rig-tabs', label: 'rig (scratch config dir)', configDir: cfg }; mustBeScratch('account.configDir', cfg);
  const WS = 'ws-tabs-1';
  const ws = { id: WS, name: 'tabs-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/tabs-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const sdir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'tabs-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stub = path.join(armDir, 'stub-bin'); fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'claude'), '#!/bin/sh\necho TABS-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  env.PATH = `${stub}:${env.PATH}`;
  clause(arm, 'ctl/pin', ws.accountId === account.id && account.configDir.startsWith(RIG_DIR), `workspace.accountId=${ws.accountId} account.id=${account.id} configDir=${account.configDir}`);

  const fx = await fixtureServer(); const FX = `http://127.0.0.1:${fx.address().port}`;
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const fd = fs.openSync(path.join(armDir, 'app.log'), 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port}`);
  let cdp;
  try {
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
    clause(arm, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
    const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!document.querySelector('.toolbar') && !!document.querySelector('[aria-label="Show browser pane"]')`), 60000, 'toolbar + browser toggle');
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
    const served = Buffer.from((await cdp.send('Page.getResourceContent', { frameId, url: bundle })).content, 'utf8');
    const onDisk = fs.readFileSync(path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]));
    clause(arm, 'ctl/app-identity-bundle', md5(served) === md5(onDisk), `renderer bundle as served md5 ${md5(served)} == ${path.basename(bundle)} in the app dir md5 ${md5(onDisk)}; package.json version ${ver}`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === ohome && ev('CLAUDE_CONFIG_DIR') === cfg && !environ.some((e) => e.startsWith('DISPLAY=')), `app environ ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);

    const st = () => cdp.eval(`window.orchestra.browserState(${JSON.stringify(WS)})`);
    const holder = () => cdp.eval(`(() => { const b = document.querySelector('.browser-holder')?.getBoundingClientRect(); return b ? { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) } : null; })()`);
    const inner = (h) => ({ x: h.x + 20, y: h.y + 20, width: h.width - 40, height: h.height - 40 });
    const pre = await st();
    clause(arm, 'pre-state: no panel yet (empty tabs, activeTabId "")', pre.tabs.length === 0 && pre.activeTabId === '' && pre.url === '', `tabs=${JSON.stringify(pre.tabs)} activeTabId=${JSON.stringify(pre.activeTabId)}`);

    // open the pane with a trusted click; the panel (and its ONE tab) is created lazily by browserShow
    const tb = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Show browser pane"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(tb.x, tb.y);
    await waitFor(() => cdp.eval(`!!document.querySelector('.browser-url-input')`), 20000, 'the browser pane');
    // URL bar: focus, type, Enter — all trusted input
    const inp = await cdp.eval(`(() => { const b = document.querySelector('.browser-url-input').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    const navigateVia = async (url) => { await cdp.click(inp.x, inp.y); await cdp.eval(`document.querySelector('.browser-url-input').select()`); await cdp.send('Input.insertText', { text: url }); await cdp.key('Enter', 'Enter', 13); };
    await navigateVia(`${FX}/green`);
    const s1 = await waitFor(async () => { const s = await st(); return s.url === `${FX}/green` && !s.loading ? s : null; }, 20000, 'state url = fixture /green');
    clause(arm, 'one tab t1/human mirrors the panel state', s1.tabs.length === 1 && s1.tabs[0].id === 't1' && s1.tabs[0].openedBy === 'human' && s1.tabs[0].active && s1.activeTabId === 't1' && s1.tabs[0].url === s1.url && s1.title === s1.tabs[0].title, `${JSON.stringify({ url: s1.url, title: s1.title, activeTabId: s1.activeTabId, tabs: s1.tabs })}`);
    clause(arm, 'URL bar shows the navigated URL (renderer unchanged)', (await cdp.eval(`document.querySelector('.browser-url-input').value`)) === `${FX}/green`, `input=${await cdp.eval(`document.querySelector('.browser-url-input').value`)}`);
    await sleep(700);
    const h = await holder(); const A = grim('app-1-green.png');
    const shareGreen = share(A, inner(h), COLORS.green);
    clause(arm, 'composited pixels: the pane region is the fixture green', shareGreen > 0.95, `holder ${JSON.stringify(h)} green share ${shareGreen.toFixed(3)} (shot ${path.join(OUT, 'app-1-green.png')})`);
    clause(arm, 'ctl/pre-vs-post: green was NOT there before navigation', shareGreen > 0.95 && share(A, { x: 5, y: h.y + 20, width: 40, height: 100 }, COLORS.green) < 0.01, `green share outside the pane ${share(A, { x: 5, y: h.y + 20, width: 40, height: 100 }, COLORS.green).toFixed(3)}`);

    await navigateVia(`${FX}/blue`);
    const s2 = await waitFor(async () => { const s = await st(); return s.url === `${FX}/blue` && !s.loading ? s : null; }, 20000, 'state url = /blue');
    await cdp.eval(`document.querySelector('[aria-label="Back"]').click()`);
    const s3 = await waitFor(async () => { const s = await st(); return s.url === `${FX}/green` && !s.loading ? s : null; }, 20000, 'back to /green');
    clause(arm, 'back navigation: tab state follows (url blue -> green, canGoForward)', s2.canGoBack && s3.canGoForward && s3.tabs[0].url === s3.url, `blue.canGoBack=${s2.canGoBack}; after back url=${s3.url} canGoForward=${s3.canGoForward} tab.url=${s3.tabs[0].url}`);

    // hide the pane: the view must leave the window; show: it comes back with its page
    const hide = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Hide browser pane"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(hide.x, hide.y); await sleep(900);
    const B = grim('app-2-hidden.png');
    clause(arm, 'hiding the pane detaches the view (no green left on screen)', share(B, { x: 0, y: 0, width: B.w, height: B.h }, COLORS.green) < 0.001, `green share of the whole output ${share(B, { x: 0, y: 0, width: B.w, height: B.h }, COLORS.green).toFixed(4)}`);
    const show = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Show browser pane"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(show.x, show.y); await waitFor(() => cdp.eval(`!!document.querySelector('.browser-holder')`), 20000, 'pane reopened'); await sleep(1200);
    const h2 = await holder(); const C = grim('app-3-reshown.png');
    const sh3 = share(C, inner(h2), COLORS.green); const s4 = await st();
    clause(arm, 're-showing restores the SAME tab + page (green again, still t1, 1 tab)', sh3 > 0.95 && s4.tabs.length === 1 && s4.tabs[0].id === 't1', `green share ${sh3.toFixed(3)} tabs=${s4.tabs.map((t) => t.id)} (shot ${path.join(OUT, 'app-3-reshown.png')})`);
  } catch (e) { clause(arm, 'arm completed without error', false, String(e.stack || e)); }
  finally {
    cdp?.close(); fx.close();
    const procs = listProcsByHome(ohome);
    for (const p of procs) { try { process.kill(p, 'SIGTERM'); } catch {} }
    await sleep(1500);
    for (const p of listProcsByHome(ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    clause(arm, 'ctl/teardown: no process left carrying this arm\'s ORCHESTRA_HOME', listProcsByHome(ohome).length === 0, `survivors ${JSON.stringify(listProcsByHome(ohome))}`);
  }
}

// ── probe arm ─────────────────────────────────────────────────────────────────────────────────────

async function bundleBp(armDir) {
  const { build } = (() => { try { return require_('esbuild'); } catch { const g = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? []; if (!g.length) throw new Error('esbuild not resolvable'); return require_(g[0]); } })();
  const out = path.join(armDir, 'bp-bundle.cjs');
  const stubs = { './platform': 'module.exports.platform = { broadcast() {} };', './logger': 'module.exports.log = { info() {}, warn() {}, debug() {}, error() {} };' };
  const m = MUTANT ? MUTANTS[MUTANT] : null;
  if (MUTANT && !m) throw new Error(`unknown mutant ${MUTANT}`);
  await build({ entryPoints: [path.join(repoRoot, 'src/main/browser-panel.ts')], outfile: out, bundle: true, format: 'cjs', platform: 'node', external: ['electron'], logLevel: 'silent',
    plugins: [{ name: 'bp-stubs-and-mutant', setup(b) {
      b.onResolve({ filter: /^\.\/(platform|logger)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      b.onLoad({ filter: /browser-panel\.ts$/ }, (a) => { let src = fs.readFileSync(a.path, 'utf8'); if (m) { const n = src.split(m.find).length - 1; if (n !== 1) throw new Error(`mutant find-string occurs ${n}x`); src = src.replace(m.find, m.replace); } return { contents: src, loader: 'ts' }; });
    } }] });
  return out;
}
async function probeArm() {
  const arm = MUTANT ? `probe[mutant ${MUTANT}]` : 'probe';
  console.log(`\n== arm ${arm} ==`);
  const armDir = path.join(RIG_DIR, MUTANT ? `arm-probe-${MUTANT}` : 'arm-probe'); fs.mkdirSync(armDir, { recursive: true });
  const bundle = await bundleBp(armDir);
  const { env } = baseEnv(armDir, { PROBE_OUT: armDir, BP_BUNDLE: bundle });
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const r = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [path.join(repoRoot, 'scripts/e2e-browser-tabs-probe.cjs'), '--ozone-platform=wayland'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = ''; r.stdout.on('data', (d) => { out += d; }); r.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((res) => r.on('exit', res));
  await Promise.race([exited, sleep(120000).then(() => { try { process.kill(-r.pid, 'SIGKILL'); } catch {} })]);
  const line = out.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (!line) { clause(arm, 'probe produced a result', false, out.slice(-1500)); return; }
  const res = JSON.parse(line.slice('PROBE_RESULT '.length));
  if (res.error) clause(arm, 'probe ran to completion', false, res.error);
  for (const c of res.results) { clause(arm, c.name, c.ok, c.detail); }
  for (const f of fs.readdirSync(armDir).filter((n) => n.endsWith('.png'))) shots.push({ file: path.join(armDir, f), md5: md5(fs.readFileSync(path.join(armDir, f))) });
  clause(arm, 'ctl/electron-real', typeof res.electron === 'string' && res.wayland === RIG_WAYLAND, `electron ${res.electron} on ${res.wayland}`);
}

const snap = () => { const files = []; if (LIVE_CFG) for (const n of ['CLAUDE.md', 'settings.json', '.credentials.json', '.claude.json', 'LESSONS.md']) files.push(path.join(LIVE_CFG, n)); const oc = path.join(process.env.REAL_HOME || '', '.config/orchestra'); return Object.fromEntries(files.filter((f) => fs.existsSync(f)).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')])); };
const before = snap();
if (ARMS.includes('app') && !MUTANT) await appArm();
if (ARMS.includes('probe')) await probeArm();
const after = snap();
clause('hygiene', 'live config files byte-equal around the rig (sha256)', JSON.stringify(before) === JSON.stringify(after) && Object.keys(before).length > 0, `${Object.keys(before).length} files compared under ${LIVE_CFG}`);
// App-arm captures each record a state CHANGE, so identical md5s there mean a no-opped step. Probe captures are
// expected to repeat where the assertion IS "the window did not change" (1==2 inactive tab, 3==5==6).
const appShots = shots.filter((s) => path.basename(s.file).startsWith('app-'));
const dup = appShots.map((s) => s.md5).filter((m, i, a) => a.indexOf(m) !== i);
console.log('\nSHOTS:'); for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
if (appShots.length || ARMS.includes('app') && !MUTANT) clause('shots', 'app-arm captures all distinct (md5)', appShots.length >= 3 && !dup.length, `${appShots.length} captures, duplicates ${[...new Set(dup)].join(',') || 'none'}`);

const fails = results.filter((r) => !r.ok);
if (MUTANT) {
  const want = MUTANTS[MUTANT].red;
  const redOnWanted = fails.some((f) => f.name.includes(want));
  const redControls = fails.filter((f) => f.name.startsWith('ctl/') || f.name === 'hygiene');
  console.log(`\nMUTANT ${MUTANT}: red clauses = ${fails.map((f) => f.name).join(' | ') || 'none'}`);
  console.log(redOnWanted && !redControls.length ? `MUTANT KILLED on the intended clause ("${want}"), controls green` : `MUTANT NOT KILLED CLEANLY (intended-red=${redOnWanted}, red controls=${redControls.length})`);
  process.exit(redOnWanted && !redControls.length ? 0 : 1);
}
console.log(`\n${results.length - fails.length}/${results.length} clauses PASS${fails.length ? `; FAIL: ${fails.map((f) => f.name).join(' | ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
