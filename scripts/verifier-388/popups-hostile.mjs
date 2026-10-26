#!/usr/bin/env node
// VERIFIER-OWNED HOSTILE-PAGE drive of the popup policy (#396; derived from bp-drive.mjs) on a BUILT Orchestra (seat 1, vague #388, ledger #405). [orig: baseline drive of the embedded browser panel] on a BUILT Orchestra (seat 1, vague #388, ledger #405).
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

// ── hostile fixture site (own; two ORIGINS = two sites: 127.0.0.1 and localhost reach the same server) ──
const hits = {};
const HUB = (port) => `<!doctype html><title>HUB</title><body style="margin:0;background:#222;color:#eee;font:14px sans-serif">
<h3>popup hostile hub</h3><div id=grid></div><a id="l-blank" target="_blank" href="/hub" style="color:#8cf">blank link</a>
<script>
window.__w=[]; window.__tok=null; window.__log=[];
addEventListener('message',(e)=>{window.__tok={data:e.data,origin:e.origin}});
const O=location.origin, X='http://'+(location.hostname==='localhost'?'127.0.0.1':'localhost')+':${port}';
const F='alwaysOnTop,frame=no,transparent,fullscreen,kiosk,modal,closable=no,focusable=no,skipTaskbar,x=-5000,y=-5000,';
const wo=(u,n,f)=>{const w=window.open(u,n,f); window.__log.push([u,n,f,!!w]); if(w) window.__w.push(w); return w;};
const C={
  hostile:()=>wo(O+'/pop?t=hostile','hostile',F+'width=4000,height=4000'),
  neg:()=>wo(O+'/pop?t=neg','neg','width=-5,height=-5,left=-100,top=-100'),
  tiny:()=>wo(O+'/pop?t=tiny','tiny','width=1,height=1'),
  nan:()=>wo(O+'/pop?t=nan','nan','width=abc,height=xyz'),
  huge:()=>wo(O+'/pop?t=huge','huge','width=99999,height=99999,left=99999,top=99999'),
  wc:()=>wo(O+'/pop?t=wc','wc','width=400,height=300,webContents=x'),
  oauth:()=>wo(O+'/idp','oauth','width=500,height=600'),
  oauthx:()=>wo(X+'/idp','oauthx','width=500,height=600'),
  dup:()=>wo(O+'/pop?t=dup','dup','width=420,height=320'),
  mailto:()=>wo('mailto:a@b.c?subject=hostile'),
  tel:()=>wo('tel:+123'),
  ssh:()=>wo('ssh://user@host'), smb:()=>wo('smb://host/share'), zoom:()=>wo('zoommtg://zoom.us/join?confno=1'),
  js:()=>wo('javascript:alert(1)'), jsmark:()=>wo("javascript:document.title='JSRAN'"), jsmark:()=>wo("javascript:document.title='JSRAN'"), data:()=>wo('data:text/html,<h1>x</h1>'), file:()=>wo('file:///etc/hostname'), blob:()=>wo(URL.createObjectURL(new Blob(['<h1>b</h1>'],{type:'text/html'}))),
  multi20:()=>{for(let i=0;i<20;i++) wo(O+'/pop?t=m'+i,'m'+i,'width=300,height=300');},
  noopener:()=>wo(O+'/pop?t=nop','nop','noopener,width=300,height=300'),
};
window.run=(k)=>C[k]();
window.later=(k,ms)=>setTimeout(()=>C[k](),ms);
for (const k of Object.keys(C)) { const b=document.createElement('button'); b.id='b-'+k; b.textContent=k; b.style.cssText='margin:3px;padding:6px'; b.onclick=()=>C[k](); grid.appendChild(b); }
</script>`;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; hits[p] = (hits[p] ?? 0) + 1;
  const port = site.address().port;
  res.setHeader('content-type', 'text/html');
  if (p === '/hub') return res.end(HUB(port));
  if (p === '/pop') return res.end(`<!doctype html><title>${u.searchParams.get('t') ?? 'pop'}</title><body style="margin:0;background:#a33;color:#fff"><h2>POP ${u.searchParams.get('t')}</h2><script>window.__origin=location.origin</script>`);
  if (p === '/idp') return res.end(`<!doctype html><title>IdP sign-in</title><body style="background:#336;color:#fff"><h2>IdP</h2><script>try { window.opener.postMessage({ token: 'IDP-TOKEN', from: location.origin, hasOpener: !!window.opener }, '*'); } catch (e) { document.title = 'ERR ' + e; } setTimeout(() => window.close(), 2500);</script>`);
  if (p === '/storm') return res.end(`<!doctype html><title>storm</title><script>window.__w=[]; for (let i=0;i<40;i++) { try { const w=window.open(location.origin+'/pop?t=s'+i, ${u.searchParams.get('named') === '1' ? "'s'+i" : "''"}, ${u.searchParams.get('named') === '1' ? "'width=300,height=300'" : "''"}); if (w) window.__w.push(w); } catch (e) {} }</script>`);
  res.statusCode = 404; res.end('nope');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;
const SITEX = `http://localhost:${site.address().port}`;

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
fs.writeFileSync(path.join(stubDir, 'xdg-open'), `#!/bin/sh\necho "$*" >> '${path.join(home, 'xdg-open.log')}'\n`, { mode: 0o755 });
fs.writeFileSync(path.join(stubDir, 'gio'), `#!/bin/sh\necho "gio $*" >> '${path.join(home, 'xdg-open.log')}'\n`, { mode: 0o755 });

// ── launch (ALLOWLIST env, guards read back from the running child) ──
const port = await freePort();
const electron = path.join(APP_DIR, 'node_modules/electron/dist/electron');
const env = {
  PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
  XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: configDir,
  ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
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
  const g = checkChildEnv(env, RIG.wayland);   // the env OBJECT handed to the app (the app's own /proc environ is rewritten by Chromium once DBUS_SESSION_BUS_ADDRESS is set — measured, ledger #405)
  clause(`isolation/${g.clause}`, g.ok, `(spawn env object) ${g.detail}`);
  clause('isolation/orchestra-home', env.ORCHESTRA_HOME === home && !home.startsWith(path.join(REAL_HOME, '.orchestra')), `ORCHESTRA_HOME=${env.ORCHESTRA_HOME}`);
  clause('isolation/dbus-pinned-nonexistent-and-xdg-private', /^unix:path=.*\/no-session-bus$/.test(env.DBUS_SESSION_BUS_ADDRESS ?? '') && !fs.existsSync((env.DBUS_SESSION_BUS_ADDRESS ?? '').replace(/^unix:path=/, '')) && env.XDG_RUNTIME_DIR.startsWith(process.env.RIG_DIR + '/'), `DBUS=${env.DBUS_SESSION_BUS_ADDRESS} XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`);
  let swayNode = null;
  const treeOf = () => JSON.parse(execFileSync('swaymsg', ['-t', 'get_tree'], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock }, encoding: 'utf8' }));
  const findPid = (n) => (n.pid === child.pid ? n : [...(n.nodes ?? []), ...(n.floating_nodes ?? [])].map(findPid).find(Boolean));
  swayNode = await waitFor('app window in MY sway tree', () => { try { return findPid(treeOf()) ?? null; } catch { return null; } }, 20000, 500).catch(() => null);
  clause('isolation/window-in-my-sway', !!swayNode, `app pid ${child.pid} in get_tree of SWAYSOCK=${RIG.swaysock}`);
  clause('isolation/pinned-account', ws1.accountId === account.id && env.CLAUDE_CONFIG_DIR === configDir && configDir.startsWith(home + path.sep), `ws.accountId=${ws1.accountId} account.id=${account.id} configDir=${configDir} (handed CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR})`);

  // ── primitives ──
  const mouse = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await sleep(250); };
  const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, disabled: !!e.disabled }; })()`);
  const clickSel = async (sel) => { const r = await waitFor(`visible ${sel}`, async () => { const q = await rectOf(sel); return q && q.w > 0 ? q : null; }, 10000, 150); const hit = await ev(`(() => { const e = document.elementFromPoint(${r.cx}, ${r.cy}); return !!e && !!e.closest(${JSON.stringify(sel)}); })()`); if (!hit) throw new Error(`hit-test missed ${sel}`); await mouse(r.cx, r.cy); };
  const typeUrl = async (u) => { await clickSel('.browser-url-input'); await ev(`document.querySelector('.browser-url-input').select()`); await cdp.send('Input.insertText', { text: u }); await sleep(150); for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); await sleep(300); };
  const bstate = (id) => ev(`window.orchestra.browserState(${JSON.stringify(id)})`);
  const waitState = (id, pred, what, ms = 15000) => waitFor(what, async () => { const s = await bstate(id); return pred(s) ? s : null; }, ms, 200);
  const grim = (name, expectChange = true) => {
    const file = path.join(home, `${name}.png`);
    execFileSync('grim', ['-o', 'HEADLESS-1', file], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 });
    const buf = fs.readFileSync(file); shots.push({ name, file, md5: crypto.createHash('md5').update(buf).digest('hex').slice(0, 10), expectChange });
    return decodePng(buf);
  };
  const off = () => ({ x: swayNode.rect.x + (swayNode.window_rect?.x ?? 0), y: swayNode.rect.y + (swayNode.window_rect?.y ?? 0) });
  // composed pixel read: 5 points inside the holder rect, returned as rgb triplets
  const pixelsAt = (png, r) => { const o = off(); const pts = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]; return pts.map(([fx, fy]) => { const X = Math.round(o.x + r.x + r.w * fx), Y = Math.round(o.y + r.y + r.h * fy); const i = (Y * png.w + X) * png.ch; return [png.px[i], png.px[i + 1], png.px[i + 2]]; }); };

  // ── popup arms: a HOSTILE page driven by TRUSTED CDP clicks on the panel's own page target ──
  const treeNow = () => treeOf();
  const collect = (n, out = []) => { if (n.pid === child.pid && (n.type === 'con' || n.type === 'floating_con') && (!n.nodes || n.nodes.length === 0)) out.push(n); for (const k of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) collect(k, out); return out; };
  const appWins = () => collect(treeNow()).map((n) => ({ id: n.id, name: n.name, w: n.rect.width, h: n.rect.height, x: n.rect.x, y: n.rect.y, floating: n.type === 'floating_con', fs: n.fullscreen_mode, visible: n.visible }));
  const mainId = swayNode.id; const mainW = swayNode.rect.width, mainH = swayNode.rect.height;
  const popWins = () => appWins().filter((w) => w.id !== mainId);
  const activeName = await ev(`document.querySelector('.ws-item.active .ws-name')?.textContent ?? ''`);
  let WS = activeName.includes('bp-1') ? ws1.id : ws2.id; // re-pinned below to the workspace whose panel really loaded the hub
  const hubTargets = async () => (await jsonTargets()).filter((t) => t.type === 'page' && /\/hub(\?|$)/.test(t.url) && (t.url.startsWith(SITE) || t.url.startsWith(SITEX)));
  const xdgLog = () => { try { return fs.readFileSync(path.join(home, 'xdg-open.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const tabsNow = async () => (await bstate(WS)).tabs ?? [];
  const settle = async (ms = 1800) => { await sleep(ms); };
  // open the pane and navigate to the hub through the URL bar (the real user path)
  await clickSel('.pane-toggle[aria-label="Show browser pane"]'); await waitFor('pane', async () => (await rectOf('.browser-pane'))?.w > 50, 10000, 150);
  await typeUrl(`${SITE}/hub`);
  await waitFor('hub loaded (either workspace)', async () => { for (const w of [ws1, ws2]) { const s = await bstate(w.id); if (s.url === `${SITE}/hub` && !s.loading) return w.id; } return null; }, 60000, 200).then((id) => { if (id !== WS) info('hub/ws-pin', `active-name guess ${WS} was wrong; the panel that loaded the hub is ${id} (activeName=${JSON.stringify(activeName)})`); WS = id; }).catch(async (e) => { info('hub/load-diagnostics', `activeName=${JSON.stringify(activeName)} state1=${JSON.stringify(await bstate(ws1.id))} state2=${JSON.stringify(await bstate(ws2.id))} hits=${JSON.stringify(hits)} urlbar=${JSON.stringify(await ev("document.querySelector('.browser-url-input')?.value"))}`); throw e; });
  let hub = await waitFor('hub page target', async () => (await hubTargets())[0] ?? null, 15000, 200);
  let hubCdp = await Cdp.connect(hub.webSocketDebuggerUrl);
  const hev = (x) => hubCdp.eval(x);
  const click = async (c, id) => { const r = await c.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`); if (!r) throw new Error(`no #${id}`); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: r.cx, y: r.cy, button: 'left', clickCount: 1 }); };
  const cleanup = async () => {
    for (const t of await hubTargets()) { try { const c = await Cdp.connect(t.webSocketDebuggerUrl); await c.eval('(window.__w||[]).forEach(w=>{try{w.close()}catch(e){}}); window.__w=[]; window.__tok=null; window.__log=[]; 0'); c.close(); } catch { /* */ } }
    for (const t of await tabsNow()) if (t.id !== 't1') await ev(`window.orchestra.browserTabClose(${JSON.stringify(WS)}, ${JSON.stringify(t.id)})`).catch(() => {});
    await waitFor('windows gone', async () => popWins().length === 0, 3000, 250).catch(() => {});
    for (const w of popWins()) { try { execFileSync('swaymsg', [`[con_id=${w.id}]`, 'kill'], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock }, stdio: 'ignore' }); } catch { /* */ } }
    await waitFor('windows gone (compositor close)', async () => popWins().length === 0, 8000, 250).catch(() => {});
    await sleep(300);
  };
  const fireAndSee = async (id, wait = 1800) => { const before = { tabs: (await tabsNow()).length, wins: popWins().length, xdg: xdgLog().length }; await click(hubCdp, `b-${id}`); await settle(wait); const wins = popWins(); const tabs = await tabsNow(); return { before, wins, tabs, xdg: xdgLog(), dTabs: tabs.length - before.tabs, dWins: wins.length - before.wins, dXdg: xdgLog().length - before.xdg }; };
  // CONTROL: the click mechanism produces a popup at all (otherwise every "refused" below is vacuous)
  { const r = await fireAndSee('dup'); clause('ctl/trusted-cdp-click-opens-a-popup-window', r.dWins === 1 && r.dTabs === 0, `after #b-dup: +${r.dWins} window(s) ${JSON.stringify(r.wins.map((w) => [w.name?.slice(0, 40), w.w, w.h]))} +${r.dTabs} tab(s)`); grim('p0-first-popup-window'); await cleanup(); }
  clause('ctl/stub-xdg-open-is-reachable', (() => { try { return fs.statSync(path.join(stubDir, 'xdg-open')).mode & 0o111; } catch { return 0; } })() !== 0, `${path.join(stubDir, 'xdg-open')} (PATH of the app starts with the stub dir)`);

  // ── H1-H5: window.open features strings ──
  const geom = async (id, label, test) => { const r = await fireAndSee(id); const w = r.wins[0]; clause(`features/${id}`, r.wins.length === 1 && r.dTabs === 0 && !!w && test(w), `${label}: ${r.wins.length} window(s) ${w ? `${w.w}x${w.h} @${w.x},${w.y} floating=${w.floating} fullscreen_mode=${w.fs} title=${JSON.stringify((w.name ?? '').slice(0, 60))}` : '-'} (app window ${mainW}x${mainH})`); return { r, w }; };
  { const { r } = await geom('hostile', 'alwaysOnTop/frame=no/transparent/fullscreen/kiosk/modal/closable=no/focusable=no/4000x4000', (w) => w.w <= Math.floor(mainW * 0.9) && w.h <= Math.floor(mainH * 0.9) && w.fs === 0 && w.floating);
    grim('p1-hostile-features-window');
    const w = r.wins[0];
    clause('features/hostile-title-origin-first', !!w && (w.name ?? '').startsWith(SITE) , `title=${JSON.stringify(w?.name)}`);
    await hev('window.__w.forEach(w=>{try{w.close()}catch(e){}}); 0'); const gone = await waitFor('hostile popup closed by its opener', async () => popWins().length === 0, 6000, 250).catch(() => false);
    clause('features/hostile-popup-is-closable-despite-closable=no', !!gone, `windows after window.close(): ${popWins().length}`); await cleanup(); }
  await geom('neg', 'width=-5,height=-5 → default size', (w) => w.w === 480 && w.h === 520 || (w.w >= 200 && w.h >= 150)); await cleanup();
  await geom('tiny', 'width=1,height=1 → at least 200x150', (w) => w.w >= 200 && w.h >= 150); await cleanup();
  await geom('nan', 'width=abc → default', (w) => w.w >= 200 && w.h >= 150 && w.w <= Math.floor(mainW * 0.9)); await cleanup();
  await geom('huge', 'width=99999,left=99999 → ≤90% of the app window', (w) => w.w <= Math.floor(mainW * 0.9) && w.h <= Math.floor(mainH * 0.9) && w.fs === 0); await cleanup();
  { const r = await fireAndSee('wc'); clause('features/webContents-feature-refused', r.dWins === 0 && r.dTabs === 0, `+${r.dWins} windows +${r.dTabs} tabs after window.open(…,'width=400,height=300,webContents=x')`); const lg = await hev('JSON.stringify(window.__log)'); info('features/webContents-opener-saw', `window.open returned: ${lg}`); await cleanup(); }
  { const r = await fireAndSee('noopener'); clause('features/noopener-is-a-tab-not-a-window', r.dTabs === 1 && r.dWins === 0, `+${r.dTabs} tab(s) +${r.dWins} window(s)`); await cleanup(); }

  // ── OS hand-off: mailto:/tel: only on a click; everything else never ──
  { const r = await fireAndSee('mailto'); clause('handoff/mailto-click-reaches-xdg-open-once', r.dXdg === 1 && /mailto:/.test(r.xdg[r.xdg.length - 1] ?? ''), `xdg-open log +${r.dXdg}: ${JSON.stringify(r.xdg.slice(-1))}`); await cleanup(); }
  { const r = await fireAndSee('tel'); clause('handoff/tel-click-reaches-xdg-open-once', r.dXdg === 1 && /tel:/.test(r.xdg[r.xdg.length - 1] ?? ''), `xdg-open log +${r.dXdg}: ${JSON.stringify(r.xdg.slice(-1))}`); await cleanup(); }
  for (const k of ['ssh', 'smb', 'zoom', 'js', 'jsmark', 'data', 'file', 'blob']) { const r = await fireAndSee(k, 1400); const isJs = k.startsWith('js'); clause(`handoff/${k}-on-a-CLICK-never-leaves-the-panel`, r.dXdg === 0 && r.dWins === 0 && (isJs || r.dTabs === 0), `+${r.dXdg} xdg-open, +${r.dWins} windows, +${r.dTabs} tabs${isJs ? ' (a blank tab is tolerated here — see INFO)' : ''}`); if (isJs) info(`handoff/${k}-tabs-created`, JSON.stringify(r.tabs.filter((t) => t.id !== 't1').map((t) => [t.id, t.url, t.title, t.openedBy]))); await cleanup(); }
  for (const k of ['mailto', 'tel', 'ssh', 'smb', 'zoom', 'js', 'data', 'file']) { const x0 = xdgLog().length, t0 = (await tabsNow()).length; await hev(`window.later(${JSON.stringify(k)}, 50); 0`); await settle(1500); clause(`handoff/${k}-WITHOUT-a-click-does-nothing`, xdgLog().length === x0 && popWins().length === 0 && ((await tabsNow()).length === t0 || k === 'js'), `xdg-open +${xdgLog().length - x0}, windows ${popWins().length}, tabs ${(await tabsNow()).length - t0}`); await cleanup(); }

  // ── storms ──
  { const base = (await tabsNow()).length; await ev(`window.orchestra.browserNavigate(${JSON.stringify(WS)}, ${JSON.stringify(`${SITE}/storm?named=0`)})`); await settle(3500);
    const tabs = await tabsNow(), wins = popWins(); clause('storm/40-unnamed-script-opens-bounded-by-the-budget', tabs.length - base + wins.length <= 3, `40 window.open() from a script on load: +${tabs.length - base} tabs, +${wins.length} windows (budget 3, cap 8)`); grim('p2-after-unnamed-storm'); }
  await ev(`window.orchestra.browserNavigate(${JSON.stringify(WS)}, ${JSON.stringify(`${SITE}/hub`)})`); await settle(2000); await cleanup();
  hub = await waitFor('hub back', async () => (await hubTargets())[0] ?? null, 15000, 200); hubCdp.close(); hubCdp = await Cdp.connect(hub.webSocketDebuggerUrl);
  { const base = (await tabsNow()).length; await ev(`window.orchestra.browserNavigate(${JSON.stringify(WS)}, ${JSON.stringify(`${SITE}/storm?named=1`)})`); await settle(3500);
    const tabs = await tabsNow(), wins = popWins(); clause('storm/40-named-sized-script-opens-bounded-by-the-budget', tabs.length - base + wins.length <= 3, `named+sized: +${tabs.length - base} tabs, +${wins.length} windows`); }
  await ev(`window.orchestra.browserNavigate(${JSON.stringify(WS)}, ${JSON.stringify(`${SITE}/hub`)})`); await settle(2000); await cleanup();
  hub = await waitFor('hub back', async () => (await hubTargets())[0] ?? null, 15000, 200); hubCdp.close(); hubCdp = await Cdp.connect(hub.webSocketDebuggerUrl);
  { const r = await fireAndSee('multi20', 2600); clause('storm/one-click-firing-20-opens-is-1-plus-budget', r.dTabs + r.dWins <= 4 && r.dTabs + r.dWins >= 1, `one click, 20 named window.open: +${r.dTabs} tabs +${r.dWins} windows (1 gestured + budget 3)`); await cleanup(); }

  // ── OAuth: opener-dependent popup completes, same-site and CROSS-site ──
  for (const [id, label] of [['oauth', 'same-site'], ['oauthx', 'CROSS-site (localhost vs 127.0.0.1)']]) {
    const r = await fireAndSee(id, 1100); grim(`p4-${id}-idp-window`);
    const tok = await waitFor('token posted back to the opener', async () => { const t = await hev('JSON.stringify(window.__tok)'); return t && t !== 'null' ? JSON.parse(t) : null; }, 8000, 250).catch(() => null);
    clause(`oauth/${id}-completes-through-a-real-child-window`, r.dWins === 1 && !!tok && tok.data?.token === 'IDP-TOKEN' && tok.data?.hasOpener === true, `${label}: window appeared (+${r.dWins}), opener received ${JSON.stringify(tok)}`);
    await waitFor('idp popup closed itself', async () => popWins().length === 0, 6000, 250).catch(() => {});
    clause(`oauth/${id}-popup-closed-itself`, popWins().length === 0, `windows after the IdP's window.close(): ${popWins().length}`);
    await cleanup();
  }

  // ── name collisions: another TAB of the same workspace may not retarget a live named popup; the holder may reuse its own ──
  { await click(hubCdp, 'b-dup'); await settle(1500); const w1 = popWins().length;
    await click(hubCdp, 'b-dup'); await settle(1500); const w2 = popWins().length;
    clause('names/holder-may-reuse-its-own-popup-name', w1 === 1 && w2 === 1, `first open → ${w1} window, second open by the SAME opener → ${w2} (reused, not doubled)`);
    await click(hubCdp, 'l-blank'); await settle(2500);
    const t2 = (await tabsNow()); const hubs = await hubTargets();
    const other = hubs.find((h) => h.id !== hub.id);
    if (!other || t2.length < 2) { clause('names/second-tab-exists', false, `tabs=${t2.length} hub targets=${hubs.length}`); }
    else {
      const c2 = await Cdp.connect(other.webSocketDebuggerUrl); const before = popWins().length; const tokBefore = await hev('window.__w.length');
      await click(c2, 'b-dup'); await settle(1800);
      const after = popWins();
      clause('names/another-tab-cannot-retarget-a-live-named-popup', after.length === before, `windows before ${before} / after ${after.length} (tab B opened the name tab A holds)`);
      grim('p3-name-collision');
      c2.close();
    }
    await cleanup(); }

  // ── app still healthy after the storm of hostility ──
  clause('health/app-main-and-renderer-alive', (await ev('1+1')) === 2 && !exited, `eval=${await ev('1+1')} exited=${exited}`);
  const errs2 = fs.readFileSync(path.join(home, 'app.log'), 'utf8').split('\n').filter((l) => /Unhandled|TypeError|ReferenceError|isDestroyed/.test(l));
  clause('log/no-unhandled-errors-in-app.log', errs2.length === 0, errs2.length ? errs2.slice(0, 3).join(' | ') : 'clean');
  hubCdp.close();
  await finish();
} catch (e) {
  console.log(`HARNESS-ERROR ${e.stack ?? e}`);
  clause('harness/no-exception', false, String(e.message));
  await finish();
}
