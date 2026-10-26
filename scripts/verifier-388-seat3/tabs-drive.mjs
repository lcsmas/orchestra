#!/usr/bin/env node
// VERIFIER-OWNED independent drive of the #393 human tab strip on a BUILT Orchestra (seat 3, vague #388, ledger #405).
// Run: E2E_RIG_BASE=<short dir> CLAUDE_CONFIG_DIR_PIN=<scratch> bash <repo>/scripts/e2e-contained-rig.sh node tabs-drive.mjs <app-dir> [label]
// Every clause = a STATE assertion (renderer DOM / IPC state / CDP /json / browser-tabs.json) AND, for paint, a COMPOSED pixel read (grim on MY sway).
// Real user paths only: real mouse events on the strip (+, tab, ×), the URL bar typed + Enter, sidebar clicks, Help button; restart = Browser.close / SIGKILL.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { sleep, waitFor, checkChildEnv, decodePng, procEnv, descendants, procStart, Cdp, RIG, REAL_HOME, git, freePort, checkScratchConfig, liveDirs, checkHandOff } from './lib.mjs';

const APP_DIR = fs.realpathSync(process.argv[2] ?? '');
const LABEL = process.argv[3] ?? 'tabs';
const ARMS = new Set((process.argv[4] ?? 'all').split(','));
const arm = (n) => ARMS.has('all') || ARMS.has(n);
for (const k of ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', 'RIG_DIR']) if (!process.env[k]) { console.log(`REFUSED: ${k} unset — launch through scripts/e2e-contained-rig.sh`); process.exit(3); }
if (process.env.DISPLAY) { console.log('REFUSED: DISPLAY set'); process.exit(3); }
for (const f of ['package.json', 'dist/index.html', 'dist-electron/main.js']) if (!fs.existsSync(path.join(APP_DIR, f))) { console.log(`ABORT: ${APP_DIR}/${f} missing — build first`); process.exit(2); }

const RESULTS = [];
const clause = (name, ok, detail = '') => { RESULTS.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); return ok; };
const info = (name, detail) => console.log(`INFO  ${name} — ${detail}`);

// ── fixture site (own, dependency-free) ──
const PAGES = { a: ['TAB-A', '#00c853'], b: ['TAB-B', '#2979ff'], c: ['TAB-C', '#ff6d00'] };
const RGB = { a: [0, 200, 83], b: [41, 121, 255], c: [255, 109, 0] };
const hits = {};
const site = http.createServer((req, res) => {
  const p = req.url.replace(/^\//, '').split('?')[0];
  hits[p] = (hits[p] ?? 0) + 1;
  if (p === 'pop') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>POP</title><body style="margin:0;background:#fff"><a id="l" target="_blank" href="/b">go</a>'); }
  if (!PAGES[p]) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${PAGES[p][0]}</title><body style="margin:0;background:${PAGES[p][1]};height:100vh"><h1 style="color:#fff">${PAGES[p][0]}</h1>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;
const U = (k, q = '') => `${SITE}/${k}${q}`;

// ── world: 2 real git worktrees, scratch pinned account ──
const home = path.join(RIG.base, `tb-${Date.now().toString(36)}`);
fs.mkdirSync(home, { recursive: true });
const fakeHome = path.join(home, 'home'); fs.mkdirSync(fakeHome, { recursive: true });
const repoDir = path.join(home, 'repo'); fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
fs.writeFileSync(path.join(repoDir, 'README.md'), '# tb seed\n');
git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
const mkWt = (n) => { const wt = path.join(home, 'wt', n); fs.mkdirSync(path.dirname(wt), { recursive: true }); git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${n}`, wt], fakeHome); return wt; };
const configDir = path.join(home, 'claude-config'); fs.mkdirSync(configDir, { recursive: true });
const cg = checkScratchConfig(configDir, liveDirs(), home);
if (!cg.ok) { console.log(`REFUSED before seeding [${cg.clause}]: ${cg.detail}`); process.exit(3); }
const account = { id: 'rig-tb', label: 'rig (scratch config dir)', configDir };
const mkWs = (n, wt, t) => ({ id: `ws-tb-${n}`, name: `tb-${n}`, repoPath: repoDir, worktreePath: wt, branch: `e2e/${n}`, baseBranch: 'main', createdAt: t, status: 'idle', agent: 'claude', accountId: account.id });
const ws1 = mkWs('1', mkWt('tb-1'), Date.now() - 2000), ws2 = mkWs('2', mkWt('tb-2'), Date.now() - 1000);
const sd = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(sd, { recursive: true });
fs.writeFileSync(path.join(sd, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'tb-repo', defaultBranch: 'main', scripts: {}, accountId: account.id }], workspaces: [ws1, ws2], accounts: [account], selfTuneRuns: [] }, null, 2));
const stubDir = path.join(home, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });
const TABS_FILE = path.join(sd, 'browser-tabs.json');
const shotDir = path.join(home, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
const electron = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const baseEnv = {
  PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
  XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: home, ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: configDir,
};
{ const pre = checkChildEnv(baseEnv, RIG.wayland); if (!pre.ok) { console.log(`REFUSED [${pre.clause}]: ${pre.detail}`); process.exit(3); }
  const hand = checkHandOff(baseEnv, [account], home); if (!hand.ok) { console.log(`REFUSED [${hand.clause}]: ${hand.detail}`); process.exit(3); } }

// ── processes ──
const sweepHome = () => { for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; try { if (procEnv(d).ORCHESTRA_HOME === home) process.kill(Number(d), 'SIGKILL'); } catch { /* */ } try { if (fs.readFileSync(`/proc/${d}/cmdline`, 'latin1').includes(`--user-data-dir=${home}`)) process.kill(Number(d), 'SIGKILL'); } catch { /* */ } } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const shots = [];
let bootN = 0;
async function boot(tag) {
  bootN++;
  const port = await freePort();
  const logFd = fs.openSync(path.join(home, `app-${bootN}-${tag}.log`), 'w');
  const env = { ...baseEnv, ORCHESTRA_DEBUG_PORT: String(port) };
  const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', logFd, logFd], detached: true });
  const B = { child, port, tag, exited: false, cdp: null, swayNode: null };
  child.on('exit', () => { B.exited = true; });
  const targets = await waitFor(`CDP target on :${port}`, async () => {
    if (B.exited) throw new Error(`electron exited early (see ${home}/app-${bootN}-${tag}.log)`);
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t.length ? t : null; } catch { return null; }
  }, 40000, 300);
  B.target = targets[0];
  B.cdp = await Cdp.connect(B.target.webSocketDebuggerUrl);
  await B.cdp.send('Page.enable');
  B.ev = (x) => B.cdp.eval(x);
  const live = procEnv(child.pid); const g = checkChildEnv(live, RIG.wayland);
  clause(`${tag}/isolation-${g.clause}`, g.ok && live.ORCHESTRA_HOME === home && live.CLAUDE_CONFIG_DIR === configDir && live.HOME === fakeHome, `(read back from /proc/${child.pid}/environ) ${g.detail}; ORCHESTRA_HOME=${live.ORCHESTRA_HOME}`);
  const treeOf = () => JSON.parse(execFileSync('swaymsg', ['-t', 'get_tree'], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock }, encoding: 'utf8' }));
  const findPid = (n) => (n.pid === child.pid ? n : [...(n.nodes ?? []), ...(n.floating_nodes ?? [])].map(findPid).find(Boolean));
  B.swayNode = await waitFor('app window in MY sway tree', () => { try { return findPid(treeOf()) ?? null; } catch { return null; } }, 20000, 500);
  clause(`${tag}/window-in-my-sway`, !!B.swayNode, `app pid ${child.pid} in get_tree of SWAYSOCK=${RIG.swaysock}`);
  await waitFor('toolbar rendered', async () => (await rectOf(B, '.toolbar'))?.w > 0, 30000, 300);
  return B;
}
async function quit(B, how) {
  try { B.cdp?.close(); } catch { /* */ }
  if (how === 'graceful') {
    try {
      const v = await (await fetch(`http://127.0.0.1:${B.port}/json/version`)).json();
      const bc = await Cdp.connect(v.webSocketDebuggerUrl);
      bc.send('Browser.close').catch(() => {});
      await waitFor('graceful exit', () => !alive(B.child.pid), 30000, 200);
      try { bc.close(); } catch { /* */ }
    } catch (e) { info(`${B.tag}/graceful-quit-incomplete`, e.message); }
  } else if (how === 'kill9') {
    try { process.kill(-B.child.pid, 'SIGKILL'); } catch { /* */ }
    for (const p of descendants(B.child.pid)) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
    try { process.kill(B.child.pid, 'SIGKILL'); } catch { /* */ }
    await waitFor('SIGKILLed app gone', () => !alive(B.child.pid), 15000, 100);
  }
  await sleep(800);
  sweepHome(); // keeper + stub claude + gpu/utility helpers outlive the app by design
  await sleep(500);
}

// ── primitives (all on a boot B) ──
const rectOf = (B, sel) => B.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
const mouse = async (B, x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await B.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(250); };
const clickSel = async (B, sel) => { const r = await waitFor(`visible ${sel}`, async () => { const q = await rectOf(B, sel); return q && q.w > 0 ? q : null; }, 10000, 150); const hit = await B.ev(`(() => { const e = document.elementFromPoint(${r.cx}, ${r.cy}); return !!e && !!e.closest(${JSON.stringify(sel)}); })()`); if (!hit) throw new Error(`hit-test missed ${sel}`); await mouse(B, r.cx, r.cy); };
const typeUrl = async (B, u) => { await clickSel(B, '.browser-url-input'); await B.ev(`document.querySelector('.browser-url-input').select()`); await B.cdp.send('Input.insertText', { text: u }); await sleep(150); for (const type of ['keyDown', 'keyUp']) await B.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); await sleep(300); };
const wsOf = async (B) => { const n = await B.ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`); return n.includes('tb-1') ? ws1 : ws2; };
const bstate = (B, id) => B.ev(`window.orchestra.browserState(${JSON.stringify(id)})`);
const strip = (B) => B.ev(`(() => [...document.querySelectorAll('.browser-tab')].map((e) => ({ id: e.dataset.tabId, label: e.querySelector('.browser-tab-label')?.textContent ?? '', active: e.getAttribute('aria-selected') === 'true', by: e.dataset.openedBy })))()`);
const urlValue = (B) => B.ev(`document.querySelector('.browser-url-input')?.value ?? null`);
const notice = (B) => B.ev(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
const ensurePane = async (B) => { if (!(await rectOf(B, '.browser-pane'))) await clickSel(B, '.pane-toggle[aria-label="Show browser pane"]'); await waitFor('browser pane', async () => (await rectOf(B, '.browser-pane'))?.w > 50, 10000, 150); await sleep(500); };
const clickNew = (B) => clickSel(B, '.browser-tab-new');
const clickTab = (B, id) => clickSel(B, `.browser-tab[data-tab-id="${id}"] .browser-tab-label`);
const clickClose = (B, id) => clickSel(B, `.browser-tab[data-tab-id="${id}"] .browser-tab-close`);
const appTargets = async (B) => (await (await fetch(`http://127.0.0.1:${B.port}/json`)).json()).filter((t) => t.type === 'page' && !t.url.includes('dist/index.html'));
const grim = (B, name, expectChange = true) => {
  const file = path.join(shotDir, `${B.tag}-${name}.png`);
  execFileSync('grim', ['-o', 'HEADLESS-1', file], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: baseEnv.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 });
  const buf = fs.readFileSync(file); shots.push({ name: `${B.tag}-${name}`, file, md5: crypto.createHash('md5').update(buf).digest('hex').slice(0, 10), expectChange });
  return decodePng(buf);
};
const off = (B) => ({ x: B.swayNode.rect.x + (B.swayNode.window_rect?.x ?? 0), y: B.swayNode.rect.y + (B.swayNode.window_rect?.y ?? 0) });
// 9-point composed grid inside a rect (CSS px == output px at DPR 1; asserted once)
const GRID = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]];
const pixelsAt = (B, png, r) => { const o = off(B); return GRID.map(([fx, fy]) => { const X = Math.round(o.x + r.x + r.w * fx), Y = Math.round(o.y + r.y + r.h * fy); const i = (Y * png.w + X) * png.ch; return [png.px[i], png.px[i + 1], png.px[i + 2]]; }); };
const near = (p, q) => Math.abs(p[0] - q[0]) <= 3 && Math.abs(p[1] - q[1]) <= 3 && Math.abs(p[2] - q[2]) <= 3;
const isColor = (px, k) => px.every((p) => near(p, RGB[k]));
const anyColor = (px) => Object.keys(RGB).filter((k) => px.some((p) => near(p, RGB[k])));
const holder = (B) => rectOf(B, '.browser-holder');
const paint = async (B, name, expectChange = true) => { const h = await holder(B); const px = pixelsAt(B, grim(B, name, expectChange), h); return { h, px, colours: anyColor(px) }; };
const tabsFile = () => { try { return JSON.parse(fs.readFileSync(TABS_FILE, 'utf8')); } catch { return null; } };
const filePair = (wsId) => { const f = tabsFile()?.workspaces?.[wsId]; return f ? { urls: f.tabs.map((t) => t.url), active: f.activeIndex, by: f.tabs.map((t) => t.openedBy) } : null; };
let urlbarRuns = 0, urlbarEmpty = 0;
// type a URL into the active tab; the URL bar must SHOW the committed url afterwards (the claimed #393 URL-bar fix)
async function navigate(B, wsId, key, q = '') {
  const want = U(key, q);
  await typeUrl(B, want);
  const s = await waitFor(`state ${key}`, async () => { const x = await bstate(B, wsId); return x.url === want && !x.loading ? x : null; }, 15000, 200);
  const v = await waitFor('urlbar settles', async () => { const x = await urlValue(B); return x === want ? x : null; }, 4000, 100).catch(() => urlValue(B));
  urlbarRuns++; if (v !== want) urlbarEmpty++;
  return { s, urlbar: v };
}

const bail = async (e) => { console.log(`HARNESS-ERROR ${e.stack ?? e}`); clause('harness/no-exception', false, String(e.message)); await finish(); };
async function finish() {
  const dup = []; for (let i = 1; i < shots.length; i++) if (shots[i].expectChange && shots[i].md5 === shots[i - 1].md5) dup.push(`${shots[i - 1].name}==${shots[i].name}`);
  clause('shots/consecutive-state-changing-captures-differ', dup.length === 0, dup.length ? `byte-identical: ${dup.join(', ')}` : `${shots.length} captures`);
  sweepHome(); await sleep(500); site.close();
  const surv = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return procEnv(d).ORCHESTRA_HOME === home; } catch { return false; } });
  clause('teardown/no-survivors-by-env-marker', surv.length === 0, `procs carrying this world's ORCHESTRA_HOME: ${surv.length}`);
  info('urlbar-tally', `${urlbarEmpty} of ${urlbarRuns} navigations left the URL bar != the committed url`);
  const fail = RESULTS.filter((r) => !r.ok).length;
  console.log(`RIG-RESULT verdict=${fail ? 'FAIL' : 'PASS'} label=${LABEL} clauses=${RESULTS.length} pass=${RESULTS.length - fail} fail=${fail} skip=0 urlbar_empty=${urlbarEmpty}/${urlbarRuns} home=${home} shots=${shotDir}`);
  process.exit(fail ? 1 : 0);
}
process.on('uncaughtException', bail);

try {
  // ═══════════════════════════════ BOOT 1 ═══════════════════════════════
  const B = await boot('b1');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const gitSha = execFileSync('git', ['-C', APP_DIR, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
  info('identity', `label=${LABEL} app-dir=${APP_DIR} git=${gitSha} version=${pkgVersion} main.js md5=${crypto.createHash('md5').update(fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'))).digest('hex').slice(0, 12)}`);
  clause('identity/target-is-this-build', B.target.url.includes(APP_DIR) && !B.target.url.includes('app.asar'), B.target.url);
  const dpr = await B.ev('window.devicePixelRatio');
  clause('rig/device-pixel-ratio-1', dpr === 1, `devicePixelRatio=${dpr}`);
  const wsA = await wsOf(B); const wsB = wsA === ws1 ? ws2 : ws1;
  const nameOf = (w) => w.name; // 'tb-1' / 'tb-2'

  // ── open the pane: one blank human tab ──
  await clickSel(B, '.pane-toggle[aria-label="Show browser pane"]');
  await waitFor('browser pane', async () => (await rectOf(B, '.browser-pane'))?.w > 50, 10000, 150);
  await sleep(600);
  let st = await bstate(B, wsA.id); let sp = await strip(B);
  clause('open/one-blank-human-tab', sp.length === 1 && sp[0].active && sp[0].by === 'human' && st.tabs.length === 1 && st.activeTabId === sp[0].id && st.url === '', `strip=${JSON.stringify(sp)} state.tabs=${st.tabs.length} activeTabId=${st.activeTabId}`);
  const idA = sp[0].id;
  { const p = await paint(B, 's0-blank-pane'); clause('open/blank-pane-shows-no-fixture-colour', p.colours.length === 0, `holder px=${JSON.stringify(p.px.slice(0, 2))}`); }

  // ── tab 1 -> A ; new tab -> B ; new tab -> C (real clicks) ──
  let r = await navigate(B, wsA.id, 'a');
  clause('nav1/urlbar-shows-committed-url-first-navigation-from-blank', r.urlbar === U('a'), `url-input="${r.urlbar}" want ${U('a')}`);
  { const p = await paint(B, 's1-tab1-A'); clause('nav1/composed-green', isColor(p.px, 'a'), `px=${JSON.stringify(p.px.slice(0, 3))}`); }
  const ids = { a: idA };
  for (const k of ['b', 'c']) {
    const nBefore = (await strip(B)).length;
    await clickNew(B);
    await waitFor(`strip has ${nBefore + 1} tabs`, async () => (await strip(B)).length === nBefore + 1, 8000, 150);
    sp = await strip(B); const nt = sp.find((t) => !Object.values(ids).includes(t.id)); ids[k] = nt.id;
    st = await bstate(B, wsA.id);
    const foc = await B.ev(`document.activeElement === document.querySelector('.browser-url-input')`);
    const p0 = await paint(B, `s2-new-tab-${k}-blank`);
    clause(`new-${k}/new-tab-active-blank-url-bar-focused-nothing-composited`, nt.active && st.activeTabId === nt.id && st.url === '' && (await urlValue(B)) === '' && foc && p0.colours.length === 0, `new=${nt.id} active=${nt.active} state.url="${st.url}" focused=${foc} colours=${JSON.stringify(p0.colours)}`);
    r = await navigate(B, wsA.id, k);
    clause(`nav-${k}/urlbar-shows-committed-url-first-navigation-from-blank`, r.urlbar === U(k), `url-input="${r.urlbar}" want ${U(k)}`);
    const p = await paint(B, `s3-tab-${k}-loaded`); clause(`nav-${k}/composed-colour`, isColor(p.px, k) && anyColor(p.px).length === 1, `px=${JSON.stringify(p.px.slice(0, 3))}`);
  }
  sp = await strip(B);
  clause('strip/three-tabs-labels-in-open-order', sp.map((t) => t.label).join('|') === 'TAB-A|TAB-B|TAB-C' && sp.every((t) => t.by === 'human'), `labels=${sp.map((t) => t.label).join('|')} by=${sp.map((t) => t.by).join(',')}`);

  // ── switch by clicking tabs: URL bar follows, ONLY the active tab composites ──
  for (const k of ['a', 'c', 'b', 'a']) {
    await clickTab(B, ids[k]);
    await waitFor(`active ${k}`, async () => (await bstate(B, wsA.id)).activeTabId === ids[k], 8000, 150); await sleep(400);
    st = await bstate(B, wsA.id); sp = await strip(B); const uv = await urlValue(B); const tg = await appTargets(B);
    const p = await paint(B, `s4-switch-${k}`);
    clause(`switch-${k}/active-flag-urlbar-and-only-this-colour-composited`, sp.find((t) => t.active)?.id === ids[k] && sp.filter((t) => t.active).length === 1 && uv === U(k) && st.url === U(k) && isColor(p.px, k) && p.colours.join() === k, `active=${sp.find((t) => t.active)?.label} urlbar=${uv} px colours=${JSON.stringify(p.colours)} page-targets=${tg.length}`);
    clause(`switch-${k}/all-three-tabs-stay-alive-as-page-targets`, tg.length === 3, `non-app page targets=${tg.length} (${tg.map((t) => t.url.slice(-2)).join(',')})`);
  }
  // ── design mode is DISARMED before the active tab changes (the overlay lives in the page being left) ──
  if (arm('design')) {
    const tA = (await appTargets(B)).find((t) => t.url === U('a'));
    const pageA = await Cdp.connect(tA.webSocketDebuggerUrl);
    await clickSel(B, '.browser-design-btn'); await sleep(1200);
    const armed1 = await B.ev(`document.querySelector('.browser-design-btn')?.getAttribute('aria-pressed')`);
    const ov1 = await pageA.eval(`!!document.getElementById('__orchestra_design_overlay__')`);
    await clickTab(B, ids.c); await waitFor('c active (design)', async () => (await bstate(B, wsA.id)).activeTabId === ids.c, 8000, 150); await sleep(1200);
    const armed2 = await B.ev(`document.querySelector('.browser-design-btn')?.getAttribute('aria-pressed')`);
    const ov2 = await pageA.eval(`!!document.getElementById('__orchestra_design_overlay__')`);
    clause('design/switching-tab-disarms-design-mode-and-removes-the-overlay-from-the-tab-left', armed1 === 'true' && ov1 === true && armed2 === 'false' && ov2 === false, `armed ${armed1}->${armed2}; overlay in the left tab's page ${ov1}->${ov2}`);
    pageA.close();
  }
  // ── closing: active middle (neighbour right), then rightmost active (neighbour left), then a BACKGROUND close ──
  await clickTab(B, ids.b); await waitFor('b active', async () => (await bstate(B, wsA.id)).activeTabId === ids.b, 8000, 150); await sleep(300);
  await clickClose(B, ids.b); await waitFor('b gone', async () => (await strip(B)).length === 2, 8000, 150); await sleep(500);
  st = await bstate(B, wsA.id); sp = await strip(B);
  { const p = await paint(B, 's5-closed-active-middle-B');
    clause('close/active-middle-activates-right-neighbour-C', sp.map((t) => t.label).join('|') === 'TAB-A|TAB-C' && st.activeTabId === ids.c && isColor(p.px, 'c') && (await urlValue(B)) === U('c') && (await notice(B)) === null, `labels=${sp.map((t) => t.label).join('|')} active=${st.activeTabId}(want ${ids.c}) colours=${JSON.stringify(p.colours)} urlbar=${await urlValue(B)}`);
    clause('close/closed-tab-view-is-destroyed-not-just-hidden', (await appTargets(B)).length === 2, `non-app page targets=${(await appTargets(B)).length}`); }
  await clickClose(B, ids.c); await waitFor('c gone', async () => (await strip(B)).length === 1, 8000, 150); await sleep(500);
  st = await bstate(B, wsA.id); sp = await strip(B);
  { const p = await paint(B, 's6-closed-rightmost-C');
    clause('close/rightmost-active-activates-left-neighbour-A', sp.map((t) => t.label).join('|') === 'TAB-A' && st.activeTabId === ids.a && isColor(p.px, 'a'), `labels=${sp.map((t) => t.label).join('|')} active=${st.activeTabId} colours=${JSON.stringify(p.colours)}`); }
  for (const k of ['b', 'c']) { // rebuild [A,B,C]
    const known = new Set((await strip(B)).map((t) => t.id)); await clickNew(B);
    await waitFor('new tab', async () => (await strip(B)).length === known.size + 1, 8000, 150);
    ids[k] = (await strip(B)).find((t) => !known.has(t.id)).id; await navigate(B, wsA.id, k);
  }
  await clickTab(B, ids.c); await waitFor('c active', async () => (await bstate(B, wsA.id)).activeTabId === ids.c, 8000, 150); await sleep(300);
  // BACKGROUND close: B is not active; closing it must neither switch the active tab nor raise "No such browser tab" (stopPropagation on the ×)
  await clickClose(B, ids.b); await waitFor('b gone (background)', async () => (await strip(B)).length === 2, 8000, 150); await sleep(800);
  st = await bstate(B, wsA.id); sp = await strip(B);
  { const p = await paint(B, 's7-background-close');
    clause('close/background-tab-close-keeps-active-and-shows-no-error', st.activeTabId === ids.c && sp.map((t) => t.label).join('|') === 'TAB-A|TAB-C' && isColor(p.px, 'c') && (await notice(B)) === null, `active=${st.activeTabId}(want ${ids.c}) notice=${JSON.stringify(await notice(B))} labels=${sp.map((t) => t.label).join('|')}`); }
  { const known = new Set((await strip(B)).map((t) => t.id)); await clickNew(B); await waitFor('new tab', async () => (await strip(B)).length === known.size + 1, 8000, 150);
    ids.b = (await strip(B)).find((t) => !known.has(t.id)).id; await navigate(B, wsA.id, 'b'); } // order now [A, C, B]

  // ── cap: fill to 8, the 9th is refused with a notice and creates NOTHING ──
  if (arm('cap')) {
    let n = (await strip(B)).length;
    while (n < 8) { const known = new Set((await strip(B)).map((t) => t.id)); await clickNew(B); await waitFor('new tab', async () => (await strip(B)).length === known.size + 1, 8000, 150); await navigate(B, wsA.id, 'a', `?n=${n}`); n++; }
    const before = { tabs: (await strip(B)).length, targets: (await appTargets(B)).length, active: (await bstate(B, wsA.id)).activeTabId };
    clause('cap/eight-tabs-eight-page-targets', before.tabs === 8 && before.targets === 8, `strip=${before.tabs} page-targets=${before.targets}`);
    const rb = await paint(B, 's8-eight-tabs');
    await clickNew(B); await sleep(900);
    const after = { tabs: (await strip(B)).length, targets: (await appTargets(B)).length, active: (await bstate(B, wsA.id)).activeTabId, st: await bstate(B, wsA.id) };
    const nt = await notice(B);
    const ra = await paint(B, 's9-ninth-refused');
    clause('cap/ninth-refused-with-notice-creates-no-tab-and-no-view', after.tabs === 8 && after.st.tabs.length === 8 && after.targets === 8 && after.active === before.active && /Tab limit/.test(nt ?? ''), `notice=${JSON.stringify(nt)} strip=${after.tabs} state.tabs=${after.st.tabs.length} page-targets=${after.targets} active unchanged=${after.active === before.active}`);
    clause('cap/refused-click-leaves-the-composited-page-unchanged', JSON.stringify(rb.colours) === JSON.stringify(ra.colours) && ra.colours.length === 1, `before=${JSON.stringify(rb.colours)} after=${JSON.stringify(ra.colours)}`);
    // back down to three: [A, C, B] stay, close the five extras (from the right)
    const extras = (await strip(B)).filter((t) => !Object.values(ids).includes(t.id));
    for (const t of extras.reverse()) { await clickClose(B, t.id); await sleep(350); }
    await waitFor('back to 3', async () => (await strip(B)).length === 3, 10000, 200);
    clause('cap/closing-extras-returns-to-three-and-a-new-tab-opens-again', (await appTargets(B)).length === 3, `strip=${(await strip(B)).length} page-targets=${(await appTargets(B)).length}`);
  }
  // normalise to the persisted order [A, C, B] with B active
  await clickTab(B, ids.b); await waitFor('b active', async () => (await bstate(B, wsA.id)).activeTabId === ids.b, 8000, 150); await sleep(500);

  // ── paint: hide pane, Help overlay, workspace switch — no inactive native view over the app ──
  const h1 = await holder(B);
  await clickSel(B, '.pane-toggle[aria-label="Hide browser pane"]');
  await waitFor('pane gone', async () => (await rectOf(B, '.browser-pane')) === null, 10000, 150); await sleep(600);
  { const px = pixelsAt(B, grim(B, 's10-pane-hidden'), h1); clause('paint/pane-hidden-no-view-composited-over-old-rect', anyColor(px).length === 0, `old holder px colours=${JSON.stringify(anyColor(px))}`); }
  await clickSel(B, '.pane-toggle[aria-label="Show browser pane"]');
  await waitFor('pane back', async () => (await rectOf(B, '.browser-pane'))?.w > 50, 10000, 150); await sleep(800);
  { const p = await paint(B, 's11-pane-reshown'); clause('paint/reshown-composites-the-active-tab-only', p.colours.join() === 'b' && isColor(p.px, 'b'), `colours=${JSON.stringify(p.colours)}`); }
  await clickSel(B, '[aria-label="Help — feature guide"]');
  await waitFor('help', () => B.ev(`!!document.querySelector('.help-view')`), 10000, 150); await sleep(700);
  { const px = pixelsAt(B, grim(B, 's12-help-overlay'), h1); clause('paint/help-overlay-no-view-composited-over-it', anyColor(px).length === 0, `old holder px colours=${JSON.stringify(anyColor(px))}`); }
  await clickSel(B, '[aria-label="Close help"]'); await sleep(900);
  { const p = await paint(B, 's13-help-closed'); clause('paint/help-closed-active-tab-back', p.colours.join() === 'b', `colours=${JSON.stringify(p.colours)}`); }

  // ── second workspace: independent tab set, views hidden on switch ──
  const otherRow = await B.ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find((x) => x.querySelector('.ws-name')?.textContent.includes(${JSON.stringify(nameOf(wsB))})); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
  const firstRow = await B.ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find((x) => x.querySelector('.ws-name')?.textContent.includes(${JSON.stringify(nameOf(wsA))})); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
  await mouse(B, otherRow.cx, otherRow.cy);
  await waitFor('other ws active', async () => (await B.ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`)).includes(nameOf(wsB)), 10000, 150); await sleep(800);
  { const px = pixelsAt(B, grim(B, 's14-switched-to-ws2'), h1); clause('ws/switch-hides-all-three-views-of-the-first-workspace', anyColor(px).length === 0 && (await rectOf(B, '.browser-pane')) === null, `old holder colours=${JSON.stringify(anyColor(px))} pane=${JSON.stringify(await rectOf(B, '.browser-pane'))}`); }
  await clickSel(B, '.pane-toggle[aria-label="Show browser pane"]'); await waitFor('pane for ws2', async () => (await rectOf(B, '.browser-pane'))?.w > 50, 10000, 150); await sleep(600);
  sp = await strip(B);
  clause('ws/second-workspace-has-its-own-single-blank-tab', sp.length === 1 && sp[0].label === 'New tab', `strip=${JSON.stringify(sp)} (first ws had ${Object.values(ids).join(',')})`);
  if (arm('popup')) { // pre-#396 popup behaviour is preserved: a target=_blank link loads in the SAME tab, no tab is created
    await navigate(B, wsB.id, 'pop');
    const tP = (await appTargets(B)).find((t) => t.url === U('pop'));
    const pg = await Cdp.connect(tP.webSocketDebuggerUrl);
    await pg.eval(`document.getElementById('l').click()`);
    const sP = await waitFor('popup lands in same view', async () => { const x = await bstate(B, wsB.id); return x.url === U('b') && !x.loading ? x : null; }, 8000, 200).catch(() => bstate(B, wsB.id));
    const spP = await strip(B);
    clause('popup/target-blank-link-loads-in-the-same-tab-and-creates-no-tab', sP.url === U('b') && spP.length === 1 && sP.tabs.length === 1, `state.url=${sP.url} strip=${spP.length} tabs=${sP.tabs.length}`);
    try { pg.close(); } catch { /* */ }
  }
  r = await navigate(B, wsB.id, 'c'); clause('ws/second-workspace-navigate-urlbar', r.urlbar === U('c'), `url-input="${r.urlbar}"`);
  { const known = new Set((await strip(B)).map((t) => t.id)); await clickNew(B); await waitFor('ws2 new tab', async () => (await strip(B)).length === known.size + 1, 8000, 150); await navigate(B, wsB.id, 'a'); }
  { const p = await paint(B, 's15-ws2-two-tabs'); clause('ws/second-workspace-two-tabs-composite-its-active-only', (await strip(B)).map((t) => t.label).join('|') === 'TAB-C|TAB-A' && p.colours.join() === 'a', `labels=${(await strip(B)).map((t) => t.label).join('|')} colours=${JSON.stringify(p.colours)} page-targets=${(await appTargets(B)).length} (want 5 = 3 + 2)`); }
  await mouse(B, firstRow.cx, firstRow.cy);
  await waitFor('first ws active', async () => (await B.ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`)).includes(nameOf(wsA)), 10000, 150); await sleep(1000);
  sp = await strip(B); st = await bstate(B, wsA.id);
  { const p = await paint(B, 's16-back-to-ws1');
    clause('ws/switch-back-restores-the-first-workspace-strip-and-active-tab', sp.map((t) => t.label).join('|') === 'TAB-A|TAB-C|TAB-B' && sp.find((t) => t.active)?.label === 'TAB-B' && p.colours.join() === 'b' && (await urlValue(B)) === U('b'), `labels=${sp.map((t) => t.label).join('|')} active=${sp.find((t) => t.active)?.label} colours=${JSON.stringify(p.colours)} urlbar=${await urlValue(B)}`); }

  // ── persistence on disk, then GRACEFUL restart ──
  const wantUrls1 = [U('a'), U('c'), U('b')].join('|');
  const f1 = await waitFor('tabs file has ws1', async () => { const f = filePair(wsA.id); return f && f.urls.join('|') === wantUrls1 && f.active === 2 ? f : null; }, 8000, 200).catch(() => filePair(wsA.id));
  clause('persist/file-holds-ws1-three-urls-in-order-and-active-index', !!f1 && f1.urls.join('|') === wantUrls1 && f1.active === 2, `file ws1=${JSON.stringify(f1)}`);
  const f2 = filePair(wsB.id);
  clause('persist/file-holds-ws2-two-urls', !!f2 && f2.urls.join('|') === [U('c'), U('a')].join('|') && f2.active === 1, `file ws2=${JSON.stringify(f2)}`);
  if (arm('restart')) {
    // last change INSIDE the 400 ms debounce, then a graceful quit: the quit hook must flush it
    { const idToA = (await strip(B)).find((t) => t.label === 'TAB-A').id;
      await B.ev(`document.querySelector('.browser-tab[data-tab-id="${idToA}"] .browser-tab-label').click()`);
      await waitFor('main saw the activation', async () => (await bstate(B, wsA.id)).activeTabId === idToA, 3000, 5);
      info('quit-inside-debounce', `activation seen by main at ${Date.now() % 100000} ms; quitting at once (debounce is 400 ms)`);
    }
    await quit(B, 'graceful');
    const fq = filePair(wsA.id);
    clause('persist/graceful-quit-flushes-a-change-made-inside-the-debounce', !!fq && fq.active === 0, `file ws1 after quit=${JSON.stringify(fq)} (active 0 = the click that happened <400 ms before quit)`);

    // ═══════════════════════════════ BOOT 2: restore after graceful quit ═══════════════════════════════
    const B2 = await boot('b2');
    const wsR = await wsOf(B2);
    const row1 = wsR === ws1;
    info('boot2', `active workspace after restart = ${wsR.name}`);
    if (!row1) { const rw = await B2.ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find((x) => x.querySelector('.ws-name')?.textContent.includes('tb-1')); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`); await mouse(B2, rw.cx, rw.cy); await sleep(800); }
    await ensurePane(B2);
    await waitFor('3 tabs restored', async () => (await strip(B2)).length === 3, 15000, 250); await sleep(1500);
    sp = await strip(B2); st = await bstate(B2, ws1.id); const tg2 = await appTargets(B2);
    { const p = await paint(B2, 's20-restored-after-graceful');
      clause('restore-graceful/three-tabs-same-urls-same-order-same-active', st.tabs.map((t) => t.url).join('|') === wantUrls1 && sp.find((t) => t.active)?.label === 'TAB-A' && st.tabs.findIndex((t) => t.active) === 0 && p.colours.join() === 'a', `urls=${st.tabs.map((t) => t.url.slice(-2)).join(',')} active idx=${st.tabs.findIndex((t) => t.active)} (want 0 = A) colours=${JSON.stringify(p.colours)} page-targets=${tg2.length}`);
      clause('restore-graceful/urlbar-follows-the-restored-active-tab', (await urlValue(B2)) === U('a'), `urlbar=${await urlValue(B2)}`); }
    // restored tabs are fully live: switch to B (restored in the background), click works, then change active to C and SIGKILL
    await clickTab(B2, sp.find((t) => t.label === 'TAB-B').id); await sleep(700);
    { const p = await paint(B2, 's21-restored-switch-to-B'); clause('restore-graceful/restored-background-tab-composites-when-activated', p.colours.join() === 'b', `colours=${JSON.stringify(p.colours)}`); }
    await clickTab(B2, sp.find((t) => t.label === 'TAB-C').id); await sleep(300);
    await waitFor('file active=1 (C)', async () => filePair(ws1.id)?.active === 1, 6000, 150).catch(() => {});
    const preKill = filePair(ws1.id);
    clause('persist/debounced-write-reaches-disk-without-a-quit-hook', preKill?.active === 1, `file ws1 before SIGKILL=${JSON.stringify(preKill)} (active idx 1 = C)`);
    await quit(B2, 'kill9');

    // ═══════════════════════════════ BOOT 3: restore after SIGKILL ═══════════════════════════════
    const B3 = await boot('b3');
    const w3 = await wsOf(B3);
    if (w3 !== ws1) { const rw = await B3.ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find((x) => x.querySelector('.ws-name')?.textContent.includes('tb-1')); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`); await mouse(B3, rw.cx, rw.cy); await sleep(800); }
    await ensurePane(B3);
    await waitFor('3 tabs restored', async () => (await strip(B3)).length === 3, 15000, 250); await sleep(1500);
    sp = await strip(B3); st = await bstate(B3, ws1.id);
    { const p = await paint(B3, 's30-restored-after-sigkill');
      clause('restore-sigkill/three-tabs-same-urls-and-the-active-one', st.tabs.map((t) => t.url).join('|') === wantUrls1 && sp.find((t) => t.active)?.label === 'TAB-C' && st.tabs.findIndex((t) => t.active) === 1 && p.colours.join() === 'c', `urls=${st.tabs.map((t) => t.url.slice(-2)).join(',')} active=${sp.find((t) => t.active)?.label} idx=${st.tabs.findIndex((t) => t.active)} (want TAB-C idx 1) colours=${JSON.stringify(p.colours)}`); }
    // workspace 2 restores lazily at ITS first panel open
    const rw2 = await B3.ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find((x) => x.querySelector('.ws-name')?.textContent.includes('tb-2')); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    const tgBefore = (await appTargets(B3)).length;
    await mouse(B3, rw2.cx, rw2.cy); await waitFor('ws2 active', async () => (await B3.ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`)).includes('tb-2'), 10000, 150); await sleep(500);
    await ensurePane(B3);
    await waitFor('ws2 2 tabs', async () => (await strip(B3)).length === 2, 15000, 250); await sleep(1200);
    { const sp2 = await strip(B3); const p = await paint(B3, 's31-ws2-restored');
      clause('restore-sigkill/second-workspace-restores-at-its-first-open', sp2.map((t) => t.label).join('|') === 'TAB-C|TAB-A' && sp2.find((t) => t.active)?.label === 'TAB-A' && p.colours.join() === 'a', `labels=${sp2.map((t) => t.label).join('|')} active=${sp2.find((t) => t.active)?.label} page-targets ${tgBefore}->${(await appTargets(B3)).length} colours=${JSON.stringify(p.colours)}`); }

    // ── last tab: close every tab in ws2 -> exactly ONE fresh blank tab, panel still works ──
    if (arm('last')) {
      for (let i = 0; i < 2; i++) { const t = (await strip(B3))[0]; await clickClose(B3, t.id); await sleep(700); }
      sp = await strip(B3); st = await bstate(B3, ws2.id);
      { const p = await paint(B3, 's32-last-tab-closed'); clause('last/closing-every-tab-leaves-one-fresh-blank-tab', sp.length === 1 && sp[0].label === 'New tab' && st.tabs.length === 1 && st.url === '' && p.colours.length === 0 && (await appTargets(B3)).length === 4, `strip=${JSON.stringify(sp)} state.tabs=${st.tabs.length} colours=${JSON.stringify(p.colours)} page-targets=${(await appTargets(B3)).length} (4 = ws1's 3 + the fresh blank tab's about:blank)`); }
      r = await navigate(B3, ws2.id, 'b'); const pl = await paint(B3, 's33-last-tab-navigates');
      clause('last/the-replacement-tab-is-a-working-tab', r.urlbar === U('b') && pl.colours.join() === 'b', `urlbar=${r.urlbar} colours=${JSON.stringify(pl.colours)}`);
    }
    // ── archive ws2 -> its tabs are forgotten on disk, its views destroyed ──
    if (arm('archive')) {
      const arch = await B3.ev(`window.orchestra.archiveWorkspace(${JSON.stringify(ws2.id)}).then(() => 'ok', (e) => 'ERR ' + e.message)`);
      await sleep(1500);
      const tgA = await appTargets(B3);
      const ff = await waitFor('tabs file forgets ws2', async () => (tabsFile() && !tabsFile().workspaces?.[ws2.id]) ? true : null, 6000, 200).catch(() => false);
      clause('archive/archived-workspace-views-destroyed-and-tabs-forgotten-on-disk', arch === 'ok' && tgA.length === 3 && !!ff && !!filePair(ws1.id), `archive=${arch} page-targets=${tgA.length} (want 3 = ws1's) file has ws2=${!!filePair(ws2.id)} ws1=${!!filePair(ws1.id)}`);
    }
    const errs = fs.readFileSync(path.join(home, `app-3-b3.log`), 'utf8').split('\n').filter((l) => /browser:[a-zA-Z]+ failed|isDestroyed|Unhandled|TypeError/.test(l));
    clause('log/no-browser-handler-errors-in-boot3-app.log', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');
    await quit(B3, 'graceful');
  } else await quit(B, 'graceful');
  await finish();
} catch (e) { await bail(e); }
