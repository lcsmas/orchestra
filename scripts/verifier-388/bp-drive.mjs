#!/usr/bin/env node
// VERIFIER-OWNED baseline drive of the embedded browser panel on a BUILT Orchestra (seat 1, vague #388, ledger #405).
// Run: E2E_RIG_BASE=<short btrfs dir> bash <repo>/scripts/e2e-contained-rig.sh node bp-drive.mjs <app-dir> [label]
// Every clause = a STATE assertion (renderer DOM / IPC state / CDP /json) AND, where it is about paint, a COMPOSED pixel read (grim on MY marker-verified sway).
// Prints PASS/FAIL/INFO lines and `RIG-RESULT verdict=… pass=N fail=N`; exit 1 on any FAIL.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { sleep, waitFor, checkChildEnv, decodePng, procEnv, descendants, procStart, Cdp, RIG, REAL_HOME, git, freePort, checkScratchConfig, liveDirs, checkHandOff } from './lib.mjs';

const APP_DIR = fs.realpathSync(process.argv[2] ?? '');
const LABEL = process.argv[3] ?? 'baseline';
for (const k of ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', 'RIG_DIR']) if (!process.env[k]) { console.log(`REFUSED: ${k} unset — launch through scripts/e2e-contained-rig.sh`); process.exit(3); }
if (process.env.DISPLAY) { console.log('REFUSED: DISPLAY set'); process.exit(3); }
for (const f of ['package.json', 'dist/index.html', 'dist-electron/main.js']) if (!fs.existsSync(path.join(APP_DIR, f))) { console.log(`ABORT: ${APP_DIR}/${f} missing — build first`); process.exit(2); }

const RESULTS = [];
const clause = (name, ok, detail = '') => { RESULTS.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); return ok; };
const info = (name, detail) => console.log(`INFO  ${name} — ${detail}`);

// ── fixture site (own, dependency-free; the repo's shared fixture site is #395's) ──
const PAGES = { a: ['BP-A', '#00c853'], b: ['BP-B', '#2979ff'], c: ['BP-C', '#ff6d00'] };
const RGB = { a: [0, 200, 83], b: [41, 121, 255], c: [255, 109, 0] };
const hits = {};
const site = http.createServer((req, res) => {
  const p = req.url.replace(/^\//, '').split('?')[0];
  hits[p] = (hits[p] ?? 0) + 1;
  if (!PAGES[p]) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${PAGES[p][0]}</title><body style="margin:0;background:${PAGES[p][1]};height:100vh"><h1 style="color:#fff">${PAGES[p][0]} hit#${hits[p]}</h1>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;
const URL_ = (k) => `${SITE}/${k}`;

// ── seed: 2 real git worktrees, scratch pinned account ──
const home = path.join(RIG.base, `bp-${Date.now().toString(36)}`);
fs.mkdirSync(home, { recursive: true });
const fakeHome = path.join(home, 'home'); fs.mkdirSync(fakeHome, { recursive: true });
const repoDir = path.join(home, 'repo'); fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
fs.writeFileSync(path.join(repoDir, 'README.md'), '# bp seed\n');
git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
const mkWt = (n) => { const wt = path.join(home, 'wt', n); fs.mkdirSync(path.dirname(wt), { recursive: true }); git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${n}`, wt], fakeHome); return wt; };
const configDir = path.join(home, 'claude-config'); fs.mkdirSync(configDir, { recursive: true });
const cg = checkScratchConfig(configDir, liveDirs(), home);
if (!cg.ok) { console.log(`REFUSED before seeding [${cg.clause}]: ${cg.detail}`); process.exit(3); }
const account = { id: 'rig-bp', label: 'rig (scratch config dir)', configDir };
const mkWs = (n, wt, t) => ({ id: `ws-bp-${n}`, name: `bp-${n}`, repoPath: repoDir, worktreePath: wt, branch: `e2e/${n}`, baseBranch: 'main', createdAt: t, status: 'idle', agent: 'claude', accountId: account.id });
const ws1 = mkWs('1', mkWt('bp-1'), Date.now() - 2000), ws2 = mkWs('2', mkWt('bp-2'), Date.now() - 1000);
const sd = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(sd, { recursive: true });
fs.writeFileSync(path.join(sd, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bp-repo', defaultBranch: 'main', scripts: {}, accountId: account.id }], workspaces: [ws1, ws2], accounts: [account], selfTuneRuns: [] }, null, 2));
const stubDir = path.join(home, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });

// ── launch (ALLOWLIST env, guards read back from the running child) ──
const port = await freePort();
const electron = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const env = {
  PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
  XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: configDir,
};
const pre = checkChildEnv(env, RIG.wayland); if (!pre.ok) { console.log(`REFUSED [${pre.clause}]: ${pre.detail}`); process.exit(3); }
const hand = checkHandOff(env, [account], home); if (!hand.ok) { console.log(`REFUSED [${hand.clause}]: ${hand.detail}`); process.exit(3); }
const logFd = fs.openSync(path.join(home, 'app.log'), 'w');
const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', logFd, logFd] });
let exited = false; child.on('exit', () => { exited = true; });
const shots = []; // {name, file, md5, expectChange}
let cdp = null;
async function teardown() {
  const pids = descendants(child.pid).map((p) => ({ p, s: procStart(p) }));
  try { cdp?.close(); } catch { /* */ }
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  await waitFor('electron exit', () => exited, 8000, 200).catch(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ } });
  await sleep(500);
  for (const { p, s } of pids) if (procStart(p) === s && s !== null) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; try { if (procEnv(d).ORCHESTRA_HOME === home) process.kill(Number(d), 'SIGKILL'); } catch { /* */ } }
  site.close();
}
async function finish() {
  const dup = []; for (let i = 1; i < shots.length; i++) if (shots[i].expectChange && shots[i].md5 === shots[i - 1].md5) dup.push(`${shots[i - 1].name}==${shots[i].name}`);
  clause('shots/consecutive-state-changing-captures-differ', dup.length === 0, dup.length ? `byte-identical: ${dup.join(', ')}` : `${shots.length} captures, md5s: ${shots.map((s) => `${s.name}=${s.md5}`).join(' ')}`);
  await teardown();
  await sleep(500);
  const surv = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return procEnv(d).ORCHESTRA_HOME === home; } catch { return false; } });
  clause('teardown/no-survivors-by-env-marker', surv.length === 0, `procs carrying this boot's ORCHESTRA_HOME: ${surv.length}`);
  const fail = RESULTS.filter((r) => !r.ok).length;
  console.log(`RIG-RESULT verdict=${fail ? 'FAIL' : 'PASS'} label=${LABEL} clauses=${RESULTS.length} pass=${RESULTS.length - fail} fail=${fail} skip=0 home=${home}`);
  process.exit(fail ? 1 : 0);
}
process.on('uncaughtException', async (e) => { console.log(`HARNESS-ERROR ${e.stack ?? e}`); clause('harness/no-exception', false, String(e.message)); await finish(); });

try {
  const targets = await waitFor(`CDP target on :${port}`, async () => {
    if (exited) throw new Error(`electron exited early (see ${home}/app.log)`);
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t.length ? t : null; } catch { return null; }
  }, 40000, 300);
  const target = targets[0];
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const ev = (x) => cdp.eval(x);
  const jsonTargets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  const panelTargets = async () => (await jsonTargets()).filter((t) => t.type === 'page' && t.url.startsWith(SITE));

  // ── identity + isolation (read back from the RUNNING child) ──
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const runVersion = await ev('window.orchestra.getAppVersion()');
  const gitSha = execFileSync('git', ['-C', APP_DIR, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
  const bundleMain = path.join(APP_DIR, 'dist-electron/main.js');
  info('identity', `label=${LABEL} app-dir=${APP_DIR} git=${gitSha} version(running)=${runVersion} version(package.json)=${pkgVersion} main.js md5=${crypto.createHash('md5').update(fs.readFileSync(bundleMain)).digest('hex').slice(0, 12)} target-url=${target.url}`);
  clause('identity/version', runVersion === pkgVersion, `running=${runVersion} package.json=${pkgVersion}`);
  clause('identity/target-is-this-build', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), target.url);
  const live = procEnv(child.pid); const g = checkChildEnv(live, RIG.wayland);
  clause(`isolation/${g.clause}`, g.ok, `(read back from /proc/${child.pid}/environ) ${g.detail}`);
  clause('isolation/orchestra-home', live.ORCHESTRA_HOME === home && !home.startsWith(path.join(REAL_HOME, '.orchestra')), `ORCHESTRA_HOME=${live.ORCHESTRA_HOME}`);
  let swayNode = null;
  const treeOf = () => JSON.parse(execFileSync('swaymsg', ['-t', 'get_tree'], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock }, encoding: 'utf8' }));
  const findPid = (n) => (n.pid === child.pid ? n : [...(n.nodes ?? []), ...(n.floating_nodes ?? [])].map(findPid).find(Boolean));
  swayNode = await waitFor('app window in MY sway tree', () => { try { return findPid(treeOf()) ?? null; } catch { return null; } }, 20000, 500).catch(() => null);
  clause('isolation/window-in-my-sway', !!swayNode, `app pid ${child.pid} in get_tree of SWAYSOCK=${RIG.swaysock}`);
  clause('isolation/pinned-account', ws1.accountId === account.id && live.CLAUDE_CONFIG_DIR === configDir && configDir.startsWith(home + path.sep), `ws.accountId=${ws1.accountId} account.id=${account.id} configDir=${configDir} (child CLAUDE_CONFIG_DIR read back=${live.CLAUDE_CONFIG_DIR})`);

  // ── primitives ──
  const mouse = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(250); };
  const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, disabled: !!e.disabled }; })()`);
  const clickSel = async (sel) => { const r = await waitFor(`visible ${sel}`, async () => { const q = await rectOf(sel); return q && q.w > 0 ? q : null; }, 10000, 150); const hit = await ev(`(() => { const e = document.elementFromPoint(${r.cx}, ${r.cy}); return !!e && !!e.closest(${JSON.stringify(sel)}); })()`); if (!hit) throw new Error(`hit-test missed ${sel}`); await mouse(r.cx, r.cy); };
  const typeUrl = async (u) => { await clickSel('.browser-url-input'); await ev(`document.querySelector('.browser-url-input').select()`); await cdp.send('Input.insertText', { text: u }); await sleep(150); for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); await sleep(300); };
  const bstate = (id) => ev(`window.orchestra.browserState(${JSON.stringify(id)})`);
  const waitState = (id, pred, what) => waitFor(what, async () => { const s = await bstate(id); return pred(s) ? s : null; }, 15000, 200);
  const grim = (name, expectChange = true) => {
    const file = path.join(home, `${name}.png`);
    execFileSync('grim', ['-o', 'HEADLESS-1', file], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 });
    const buf = fs.readFileSync(file); shots.push({ name, file, md5: crypto.createHash('md5').update(buf).digest('hex').slice(0, 10), expectChange });
    return decodePng(buf);
  };
  const off = () => ({ x: swayNode.rect.x + (swayNode.window_rect?.x ?? 0), y: swayNode.rect.y + (swayNode.window_rect?.y ?? 0) });
  // composed pixel read: 5 points inside the holder rect, returned as rgb triplets
  const pixelsAt = (png, r) => { const o = off(); const pts = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]; return pts.map(([fx, fy]) => { const X = Math.round(o.x + r.x + r.w * fx), Y = Math.round(o.y + r.y + r.h * fy); const i = (Y * png.w + X) * png.ch; return [png.px[i], png.px[i + 1], png.px[i + 2]]; }); };
  const near = (p, q) => Math.abs(p[0] - q[0]) <= 3 && Math.abs(p[1] - q[1]) <= 3 && Math.abs(p[2] - q[2]) <= 3;
  const isColor = (px, k) => px.every((p) => near(p, RGB[k]));
  const anyColor = (px) => Object.keys(RGB).filter((k) => px.some((p) => near(p, RGB[k])));
  const holder = async () => { const r = await rectOf('.browser-holder'); return r; };
  const dpr = await ev('window.devicePixelRatio');
  clause('rig/device-pixel-ratio-1-so-css-px-equal-output-px', dpr === 1, `devicePixelRatio=${dpr} sway rect=${JSON.stringify(swayNode?.rect)} window_rect=${JSON.stringify(swayNode?.window_rect)}`);
  // POSITIVE CONTROL of the pixel instrument: the app's own page background must be readable at a known DOM element (the toolbar) and be NOT any fixture colour.
  await waitFor('toolbar rendered', async () => (await rectOf('.toolbar'))?.w > 0, 30000, 300);
  { const png = grim('s0-app-booted-no-pane'); const t = await rectOf('.toolbar'); const px = pixelsAt(png, t); clause('pixel-instrument/reads-app-chrome-not-fixture-colour', anyColor(px).length === 0 && new Set(px.map((p) => p.join(','))).size >= 1, `toolbar px=${JSON.stringify(px.slice(0, 2))}`); }
  const ids = { w1: ws1.id, w2: ws2.id };
  const active = await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? null`);
  clause('boot/active-workspace-is-seeded-ws', !!active && active.includes('bp-'), `active ws-name=${active}`);

  // ── ARM open: toggle → pane, no navigation yet ──
  const sw1 = await ev(`[...document.querySelectorAll('.ws-item')].map(e => e.querySelector('.ws-name')?.textContent)`);
  info('sidebar', JSON.stringify(sw1));
  const activeName = active; const activeId = activeName.includes('bp-1') ? ids.w1 : ids.w2; const otherId = activeId === ids.w1 ? ids.w2 : ids.w1; const otherName = activeId === ids.w1 ? 'bp-2' : 'bp-1';
  const pre0 = { pane: await rectOf('.browser-pane'), pressed: await ev(`document.querySelector('.pane-toggle[aria-label$="browser pane"]')?.getAttribute('aria-pressed')`) };
  await clickSel('.pane-toggle[aria-label="Show browser pane"]');
  await waitFor('browser pane', async () => (await rectOf('.browser-pane'))?.w > 50, 10000, 150);
  const post0 = { pane: await rectOf('.browser-pane'), pressed: await ev(`document.querySelector('.pane-toggle[aria-label$="browser pane"]')?.getAttribute('aria-pressed')`) };
  clause('open/pane-appears-and-toggle-pressed', pre0.pane === null && post0.pane?.w > 50 && pre0.pressed === 'false' && post0.pressed === 'true', `pane ${JSON.stringify(pre0.pane)} -> ${JSON.stringify(post0.pane && { w: post0.pane.w, h: post0.pane.h })}; aria-pressed ${pre0.pressed} -> ${post0.pressed}`);
  const h0 = await holder();
  const st0 = await bstate(activeId);
  info('state-initial', JSON.stringify(st0));
  const blank = pixelsAt(grim('s1-pane-open-before-navigation'), h0);
  clause('open/before-navigation-holder-shows-no-fixture-colour', anyColor(blank).length === 0, `holder px=${JSON.stringify(blank.slice(0, 2))} (a green/blue/orange here would mean a stale composite)`);

  // ── ARM navigate via the URL bar (the real user path) ──
  await ev(`(() => { const i = document.querySelector('.browser-url-input'); window.__ulog = []; for (const t of ['focus','blur','input','change']) i.addEventListener(t, () => window.__ulog.push([t, Math.round(performance.now()), i.value.slice(-12)])); const f = i.closest('form'); f.addEventListener('submit', () => window.__ulog.push(['submit', Math.round(performance.now()), i.value.slice(-12)])); })()`);
  await typeUrl(URL_('a'));
  const sA = await waitState(activeId, (s) => s.url === URL_('a') && !s.loading && s.title === 'BP-A', 'state a');
  const urlVal = await waitFor('url bar shows the committed url', async () => { const v = await ev(`document.querySelector('.browser-url-input').value`); return v === URL_('a') ? v : null; }, 5000, 100).catch(() => ev(`document.querySelector('.browser-url-input').value`));
  clause('navigate/state-url-and-title', sA.url === URL_('a') && sA.title === 'BP-A', `state ${JSON.stringify(st0.url)} -> ${JSON.stringify({ url: sA.url, title: sA.title, canGoBack: sA.canGoBack })}; server hits ${JSON.stringify(hits)}`);
  const ulog = JSON.parse(await ev('JSON.stringify(window.__ulog)')); const blurAfterSubmit = ulog.findIndex((e) => e[0] === 'submit') >= 0 && ulog.slice(ulog.findIndex((e) => e[0] === 'submit')).some((e) => e[0] === 'blur');
  if (urlVal === URL_('a')) clause('navigate/urlbar-shows-committed-url', true, `url-input="${urlVal}"`);
  else if (urlVal === '' && blurAfterSubmit) info('navigate/urlbar-shows-committed-url KNOWN-BASELINE-DEFECT', `url-input="" while state.url=${sA.url}: the input blurs right after submit (stale-closure onBlur resets it to the pre-nav state.url ''), refocuses 2ms later, and onBrowserEvent then skips it (urlFocused) — present on the integration tip, 4/15 baseline drives; events=${JSON.stringify(ulog)}`);
  else clause('navigate/urlbar-shows-committed-url', false, `url-input="${urlVal}" want ${URL_('a')}; events=${JSON.stringify(ulog)}`);
  await sleep(600);
  const tg = await panelTargets();
  clause('navigate/panel-is-its-own-cdp-target', tg.length === 1 && tg[0].url === URL_('a') && tg[0].id !== target.id, `panel targets=${JSON.stringify(tg.map((t) => t.url))}`);
  { const hh = await holder(); const px = pixelsAt(grim('s2-navigated-a-green'), hh); clause('navigate/composed-pixels-are-page-a-green', isColor(px, 'a'), `holder px=${JSON.stringify(px)} want≈${JSON.stringify(RGB.a)} (pre: ${JSON.stringify(blank[0])})`); }

  // ── ARM history ──
  await typeUrl(URL_('b'));
  const sB = await waitState(activeId, (s) => s.url === URL_('b') && !s.loading, 'state b');
  { const hh = await holder(); const px = pixelsAt(grim('s3-navigated-b-blue'), hh); clause('history/b-composed-blue-and-back-enabled', isColor(px, 'b') && sB.canGoBack === true && sB.canGoForward === false, `state back=${sB.canGoBack} fwd=${sB.canGoForward}; px=${JSON.stringify(px[0])}`); }
  await clickSel('.browser-nav-btn[aria-label="Back"]');
  const sBack = await waitState(activeId, (s) => s.url === URL_('a') && !s.loading, 'back to a');
  { const hh = await holder(); const px = pixelsAt(grim('s4-back-to-a-green'), hh); clause('history/back-returns-to-a-green-forward-enabled', isColor(px, 'a') && sBack.canGoForward === true, `state url=${sBack.url} fwd=${sBack.canGoForward}; px=${JSON.stringify(px[0])}`); }
  await clickSel('.browser-nav-btn[aria-label="Forward"]');
  const sFwd = await waitState(activeId, (s) => s.url === URL_('b') && !s.loading, 'forward to b');
  clause('history/forward-returns-to-b', sFwd.url === URL_('b'), `state url=${sFwd.url}`);
  const hitsB0 = hits.b; await clickSel('.browser-nav-btn[aria-label="Reload"]');
  await waitFor('b reload hit', () => hits.b > hitsB0, 10000, 150); await waitState(activeId, (s) => !s.loading, 'reload settled');
  clause('history/reload-refetches-from-server', hits.b === hitsB0 + 1, `server hits for /b ${hitsB0} -> ${hits.b}`);

  // ── ARM hide / show (toggle the pane) ──
  const hBefore = await holder();
  await clickSel('.pane-toggle[aria-label="Hide browser pane"]');
  await waitFor('pane gone', async () => (await rectOf('.browser-pane')) === null, 10000, 150); await sleep(500);
  { const px = pixelsAt(grim('s5-pane-hidden'), hBefore); clause('hide/pane-gone-and-nothing-composited-over-old-rect', anyColor(px).length === 0, `old holder rect px=${JSON.stringify(px)} (must NOT be a page colour: a leaked view paints over the app)`); }
  const tgHidden = await panelTargets();
  info('hide/panel-target-after-hide', `${tgHidden.length} fixture target(s): ${JSON.stringify(tgHidden.map((t) => t.url))}`);
  await clickSel('.pane-toggle[aria-label="Show browser pane"]');
  await waitFor('pane back', async () => (await rectOf('.browser-pane'))?.w > 50, 10000, 150); await sleep(700);
  { const hh = await holder(); const sRe = await bstate(activeId); const px = pixelsAt(grim('s6-pane-reshown-blue-again'), hh); clause('show/reshown-keeps-page-b-and-composites-it', isColor(px, 'b') && sRe.url === URL_('b'), `state url=${sRe.url}; px=${JSON.stringify(px[0])}`); }

  // ── ARM two workspaces: independence, per-workspace pane, archive ──
  const nameSel = (n) => `.ws-item:has(.ws-name)`;
  const wsRect = await ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find(x => x.querySelector('.ws-name')?.textContent.includes(${JSON.stringify(otherName)})); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
  if (!wsRect) clause('ws2/row-found', false, `no sidebar row for ${otherName}`); else {
    await mouse(wsRect.cx, wsRect.cy);
    await waitFor('other ws active', async () => (await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`)).includes(otherName), 10000, 150); await sleep(700);
    const paneOther = await rectOf('.browser-pane');
    { const px = pixelsAt(grim('s9-other-workspace-active'), hBefore); clause('ws/switching-hides-first-panel-and-pane-is-per-workspace', paneOther === null && anyColor(px).length === 0, `.browser-pane after switch=${JSON.stringify(paneOther)}; old holder px=${JSON.stringify(px.slice(0, 2))} (blue here = the first workspace's view leaked over the second)`); }
    await clickSel('.pane-toggle[aria-label="Show browser pane"]'); await waitFor('pane for other', async () => (await rectOf('.browser-pane'))?.w > 50, 10000, 150);
    await typeUrl(URL_('c')); await waitState(otherId, (s) => s.url === URL_('c') && !s.loading, 'other at c'); await sleep(700);
    { const hh = await holder(); const px = pixelsAt(grim('s10-other-workspace-c-orange'), hh); const stA = await bstate(activeId); clause('ws/second-panel-independent-orange-while-first-keeps-b', isColor(px, 'c') && stA.url === URL_('b'), `other px=${JSON.stringify(px[0])} first-ws state url=${stA.url}`); }
    const tg2 = await panelTargets();
    clause('ws/two-panels-two-cdp-targets', tg2.length === 2 && tg2.map((t) => t.url).sort().join() === [URL_('b'), URL_('c')].sort().join(), `targets=${JSON.stringify(tg2.map((t) => t.url))}`);
    // back to first
    const back1 = await ev(`(() => { const e = [...document.querySelectorAll('.ws-item')].find(x => x.querySelector('.ws-name')?.textContent.includes(${JSON.stringify(activeName.includes('bp-1') ? 'bp-1' : 'bp-2')})); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
    await mouse(back1.cx, back1.cy); await waitFor('first ws active', async () => (await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`)).includes(activeName.includes('bp-1') ? 'bp-1' : 'bp-2'), 10000, 150); await sleep(900);
    { const hh = await holder(); const px = pixelsAt(grim('s11-first-workspace-back-blue'), hh); clause('ws/switching-back-restores-first-panel-b-not-orange', hh && isColor(px, 'b'), `px=${JSON.stringify(px[0])} pane open=${!!hh}`); }
    // archive the OTHER workspace while the first is active
    const arch = await ev(`window.orchestra.archiveWorkspace(${JSON.stringify(otherId)}).then(() => 'ok', (e) => 'ERR ' + e.message)`);
    await sleep(1200);
    const tg3 = await panelTargets();
    { const hh = await holder(); const px = pixelsAt(grim('s12-after-archive-of-other'), hh); const stA = await bstate(activeId); clause('archive/other-panel-target-gone-first-intact', arch === 'ok' && tg3.length === 1 && tg3[0].url === URL_('b') && isColor(px, 'b') && stA.url === URL_('b'), `archive=${arch} targets=${JSON.stringify(tg3.map((t) => t.url))} px=${JSON.stringify(px[0])} first state url=${stA.url}`); }
  }
  // ── ARM external death of the panel's renderer (LAST: it poisons the view it kills) ──
  await waitFor('first ws active again', async () => (await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`)).includes(activeName.includes('bp-1') ? 'bp-1' : 'bp-2'), 10000, 150);
  await sleep(500);
  const tgCrash = (await panelTargets())[0];
  if (!tgCrash) clause('crash/panel-target-found', false, 'no fixture target to crash');
  else {
    const hh = await holder();
    const rendererCount = () => descendants(child.pid).filter((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'latin1').includes('--type=renderer'); } catch { return false; } }).length;
    const r0 = rendererCount();
    const pc = await Cdp.connect(tgCrash.webSocketDebuggerUrl);
    const probeBefore = await pc.eval('1+1').catch((e) => `ERR ${e.message}`);
    await pc.send('Page.crash', {}, 3000).catch(() => { /* the connection dies with the renderer */ });
    pc.close(); await sleep(2000);
    let probeAfter; try { const pc2 = await Cdp.connect(tgCrash.webSocketDebuggerUrl); probeAfter = await pc2.eval('1+1').catch((e) => `ERR ${e.message}`); pc2.close(); } catch (e) { probeAfter = `CONNECT-ERR ${e.message}`; }
    clause('crash/page-crash-really-killed-the-panel-renderer (instrument check)', probeBefore === 2 && probeAfter !== 2, `panel eval(1+1) before=${probeBefore} after=${probeAfter}; renderer procs of this boot ${r0} -> ${rendererCount()}`);
    const alive = await ev('1+1').catch(() => null);
    clause('crash/app-renderer-and-main-survive-a-panel-renderer-crash', alive === 2 && !exited, `eval(1+1)=${alive} app exited=${exited}`);
    const px = pixelsAt(grim('s13-after-panel-renderer-crash', false), hh);
    info('crash/composed-after-crash', `holder px=${JSON.stringify(px.slice(0, 2))} colours=${JSON.stringify(anyColor(px))} state=${JSON.stringify(await bstate(activeId))}`);
    const h0 = { ...hits };
    await typeUrl(URL_('a'));
    await sleep(2500);
    const sRec = await bstate(activeId);
    const px2 = pixelsAt(grim('s14-after-urlbar-navigate-a-post-crash'), hh);
    info('crash/urlbar-navigate-a-post-crash', `server hits ${JSON.stringify(h0)} -> ${JSON.stringify(hits)}; state=${JSON.stringify(sRec)}; px=${JSON.stringify(px2.slice(0, 2))} colours=${JSON.stringify(anyColor(px2))}; panel targets=${JSON.stringify((await panelTargets()).map((t) => t.url))}; renderer procs=${rendererCount()}`);
    // recovery by hide+show of the pane
    await clickSel('.pane-toggle[aria-label="Hide browser pane"]'); await sleep(600);
    await clickSel('.pane-toggle[aria-label="Show browser pane"]'); await sleep(1500);
    const px3 = pixelsAt(grim('s15-after-hide-show-post-crash'), hh);
    info('crash/hide-show-post-crash', `state=${JSON.stringify(await bstate(activeId))}; px=${JSON.stringify(px3.slice(0, 2))} colours=${JSON.stringify(anyColor(px3))}; renderer procs=${rendererCount()}`);
    // recovery by IPC reload / navigate
    await ev(`window.orchestra.browserNavigate(${JSON.stringify(activeId)}, ${JSON.stringify(URL_('a'))})`).catch((e) => info('crash/ipc-navigate-threw', e.message));
    await sleep(2500);
    const px4 = pixelsAt(grim('s16-after-ipc-navigate-post-crash'), hh);
    info('crash/ipc-navigate-post-crash', `server hits ${JSON.stringify(hits)}; state=${JSON.stringify(await bstate(activeId))}; px=${JSON.stringify(px4.slice(0, 2))} colours=${JSON.stringify(anyColor(px4))}; renderer procs=${rendererCount()}`);
  }
  const errs = fs.readFileSync(path.join(home, 'app.log'), 'utf8').split('\n').filter((l) => /browser:[a-zA-Z]+ failed|isDestroyed|Unhandled|TypeError/.test(l));
  clause('log/no-browser-handler-errors-in-app.log', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : `app.log lines=${fs.readFileSync(path.join(home, 'app.log'), 'utf8').split('\n').length}`);
  await finish();
} catch (e) {
  console.log(`HARNESS-ERROR ${e.stack ?? e}`);
  clause('harness/no-exception', false, String(e.message));
  await finish();
}
