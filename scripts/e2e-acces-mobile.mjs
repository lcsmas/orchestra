// Accès mobile #334 — end to end on a BUILT Orchestra inside the contained rig's own headless sway.
//
// Seeds a scratch world (two repos on two scratch accounts, three workspaces incl. one archived) with Accès mobile ON, boots the
// app, then proves on the REAL process tree:
//   ctl/*        app identity (target url + served bundle md5), scratch containment, the server process exists with an
//                ALLOWLISTED environ, the token file is 0600 in a 0700 dir
//   sec/*        must-FAIL arms against the live port, each beside a passing control: no identity, colleague identity,
//                no token, bad token, token in the query string, non-loopback interface
//   phone/*      a headless Chromium in iPhone emulation (serve's identity header injected) pairs via #t=, the fragment is
//                stripped, the list shows every non-archived workspace across both accounts, en attente first — DOM + screenshot
//   settings/*   the Settings dialog shows "Listening", the serve command; a TRUSTED click turns it off ⇒ port refused,
//                process gone; on again ⇒ listening — DOM + screenshots
//   supervise/*  SIGKILL the server ⇒ main restarts it (new pid); SIGKILL the app ⇒ the server exits (no orphan listening)
// Usage: scripts/e2e-acces-mobile.sh <app-dir> [--out <dir>]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : refuse('no <app-dir>');
const LIVE_HOME = flag('--live-home', null) ?? refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('run via scripts/e2e-acces-mobile.sh (the contained rig)');
if (process.env.DISPLAY) refuse('X11 DISPLAY set — would reach the human screen');
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} is not the rig's`);
const OUT = flag('--out', path.join(RIG_DIR, 'shots'));
const CHROMIUM = flag('--chromium', '/usr/bin/chromium-browser');

const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(real);
const mustBeScratch = (what, p) => {
  const r = real(p);
  if (LIVE.some((l) => r === l || r.startsWith(l + path.sep))) refuse(`${what}=${p} is a live dir`);
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) refuse(`${what}=${p} is outside the rig base`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(200); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const connects = (host, port) => new Promise((resolve) => { const s = net.connect({ host, port }); s.setTimeout(1500, () => { s.destroy(); resolve(false); }); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
function req(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); });
    r.on('error', reject); r.end();
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async clickSel(sel) { const b = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); if (!b) throw new Error(`no ${sel}`); await this.click(b.x, b.y); }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [], shots = [];
function clause(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); console.log(`  shot ${f} md5 ${md5(buf)}`); return f; }
const environOf = (pid) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
const cmdlineOf = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
/** The Accès mobile server of THIS rig: identity = its environ names this rig's token file. */
function serverPids(tokenFile) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { if (environOf(p).includes(`ACCES_MOBILE_TOKEN_FILE=${tokenFile}`) && fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1][0] !== 'Z') out.push(+p); } catch {}
  }
  return out;
}

// ── seed ──
const LOGIN = 'rig.owner@example.invalid';
const world = (() => {
  const d = path.join(RIG_DIR, 'world');
  const fakeHome = path.join(d, 'home'), ohome = path.join(d, 'oh'), cfgA = path.join(d, 'cfg-mc'), cfgB = path.join(d, 'cfg-perso');
  const repoA = path.join(d, 'repo-orchestra'), repoB = path.join(d, 'repo-perso');
  for (const x of [fakeHome, ohome, cfgA, cfgB, repoA, repoB, path.join(d, 'wt')]) { fs.mkdirSync(x, { recursive: true }); mustBeScratch('seed', x); }
  const wts = [];
  for (const [repo, name] of [[repoA, 'am-waiting'], [repoA, 'am-idle'], [repoB, 'am-unread'], [repoB, 'am-archived']]) {
    if (!fs.existsSync(path.join(repo, '.git'))) { git(repo, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo, 'README.md'), '#\n'); git(repo, ['add', '.'], fakeHome); git(repo, ['commit', '-q', '-m', 'seed'], fakeHome); }
    const wt = path.join(d, 'wt', name); git(repo, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome); wts.push(wt);
  }
  const accounts = [{ id: 'acc-mc', label: 'mc', configDir: cfgA }, { id: 'acc-perso', label: 'perso', configDir: cfgB }];
  const base = { baseBranch: 'main', createdAt: Date.now(), agent: 'claude' };
  const workspaces = [
    { ...base, id: 'ws-am-waiting', name: 'am-waiting', repoPath: repoA, worktreePath: wts[0], branch: 'e2e/am-waiting', status: 'waiting', accountId: 'acc-mc' },
    { ...base, id: 'ws-am-idle', name: 'am-idle', repoPath: repoA, worktreePath: wts[1], branch: 'e2e/am-idle', status: 'idle', accountId: 'acc-mc' },
    { ...base, id: 'ws-am-unread', name: 'am-unread', repoPath: repoB, worktreePath: wts[2], branch: 'e2e/am-unread', status: 'idle', autoUnread: true, accountId: 'acc-perso' },
    { ...base, id: 'ws-am-archived', name: 'am-archived', repoPath: repoB, worktreePath: wts[3], branch: 'e2e/am-archived', status: 'idle', archived: true, archivedAt: Date.now(), accountId: 'acc-perso' },
  ];
  return { d, fakeHome, ohome, accounts, workspaces, repos: [{ path: repoA, name: 'orchestra-rig', defaultBranch: 'main', accountId: 'acc-mc' }, { path: repoB, name: 'perso-rig', defaultBranch: 'main', accountId: 'acc-perso' }] };
})();

const AM_PORT = await freePort();
const SERVE_PORT = AM_PORT === 8445 ? 8446 : 8445;
const storeDir = path.join(world.ohome, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: world.repos, workspaces: world.workspaces, accounts: world.accounts, selfTuneRuns: [], accesMobile: { enabled: true, port: AM_PORT, servePort: SERVE_PORT, allowedLogin: LOGIN } }, null, 2));
const stubDir = path.join(world.d, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho AM-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
const TOKEN_FILE = path.join(world.ohome, 'acces-mobile', 'token');

// ── boot ──
const cdpPort = await freePort();
const env = { PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(cdpPort), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.accounts[0].configDir, LANG: 'C.UTF-8',
  SECRET_CANARY_FROM_MAIN: 'must-not-reach-the-server' };
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
const logFile = path.join(world.d, 'app.log'); const fd = fs.openSync(logFile, 'w');
const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
console.log(`app pid ${app.pid}, cdp ${cdpPort}, acces-mobile port ${AM_PORT}, log ${logFile}`);
let cdp, chrome, phone, exitCode = 1;
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'app page target');
  clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval(`!!document.querySelector('[data-am-open]')`), 60000, 'the Accès mobile header button');
  const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
  const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
  const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
  const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
  const onDisk = path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const runningVer = await cdp.eval(`(window.orchestra && window.orchestra.appVersion) ? window.orchestra.appVersion() : null`).catch(() => null);
  clause('ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(onDisk)), `served ${path.basename(bundle)} md5 ${md5(served)} == ${onDisk}; package.json ${ver}; running reports ${runningVer ?? 'n/a'}`);
  const appEnv = environOf(app.pid);
  clause('ctl/scratch-env', appEnv.includes(`ORCHESTRA_HOME=${world.ohome}`) && !appEnv.some((e) => e.startsWith('DISPLAY=')), `app ORCHESTRA_HOME=${world.ohome}, no DISPLAY`);

  // server process + token file
  const pids = await waitFor(() => { const p = serverPids(TOKEN_FILE); return p.length ? p : null; }, 30000, 'the Accès mobile server process');
  await waitFor(() => connects('127.0.0.1', AM_PORT), 30000, 'the server port');
  const srvEnv = environOf(pids[0]).map((e) => e.split('=')[0]).sort();
  clause('ctl/server-one-process', pids.length === 1, `pids ${pids.join(',')} argv ${cmdlineOf(pids[0]).join(' ')}`);
  clause('ctl/server-env-allowlisted', !srvEnv.includes('SECRET_CANARY_FROM_MAIN') && !srvEnv.includes('HOME') && !srvEnv.includes('CLAUDE_CONFIG_DIR') && srvEnv.includes('ACCES_MOBILE_PORT'), `server environ keys: ${srvEnv.join(' ')}`);
  const tokStat = fs.statSync(TOKEN_FILE), dirStat = fs.statSync(path.dirname(TOKEN_FILE));
  clause('ctl/token-file-mode', (tokStat.mode & 0o777) === 0o600 && (dirStat.mode & 0o777) === 0o700, `token ${(tokStat.mode & 0o777).toString(8)}, dir ${(dirStat.mode & 0o777).toString(8)}`);
  const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const ID = { 'Tailscale-User-Login': LOGIN }, AUTH = { ...ID, Authorization: `Bearer ${TOKEN}` };

  // security arms against the live port
  const ctl = await req(AM_PORT, '/api/workspaces', AUTH);
  const rows = ctl.status === 200 ? JSON.parse(ctl.body).workspaces : [];
  clause('sec/control-200', ctl.status === 200 && rows.length === 3, `status ${ctl.status}; rows ${rows.map((r) => `${r.name}[${r.status}${r.unread ? ',unread' : ''}/${r.account}/${r.group}]`).join(' ')}`);
  // A seeded `waiting` is resolved to idle + non lu at store load (store.ts: no live process can still be asking), so a real
  // en attente needs a live AskUserQuestion (#339). Here: attention rank never decreases, both accounts, archived dropped.
  const rank = (r) => (r.status === 'waiting' ? 0 : r.unread ? 1 : 2);
  const sorted = rows.every((r, i) => i === 0 || rank(rows[i - 1]) <= rank(r));
  clause('phone-api/order-and-accounts', sorted && rows.filter((r) => r.unread).length === 2 && rank(rows[2]) === 2 && rows.some((r) => r.account === 'mc') && rows.some((r) => r.account === 'perso') && !rows.some((r) => r.name === 'am-archived'), `ranks ${rows.map(rank).join(',')}; non lu first; both accounts; archived dropped`);
  for (const [name, p, h, want] of [
    ['sec/no-identity', '/api/workspaces', { Authorization: `Bearer ${TOKEN}` }, 403],
    ['sec/colleague-identity', '/api/workspaces', { 'Tailscale-User-Login': 'colleague@example.invalid', Authorization: `Bearer ${TOKEN}` }, 403],
    ['sec/no-token', '/api/workspaces', ID, 401],
    ['sec/bad-token', '/api/workspaces', { ...ID, Authorization: `Bearer ${'x'.repeat(43)}` }, 401],
    ['sec/query-token', `/api/workspaces?t=${TOKEN}`, ID, 401],
    ['sec/shell-no-identity', '/', {}, 403],
  ]) {
    const r = await req(AM_PORT, p, h);
    clause(name, r.status === want && !r.body.includes('am-'), `status ${r.status} (want ${want}), body ${r.body.length} bytes`);
  }
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  clause('sec/loopback-only', (await connects('127.0.0.1', AM_PORT)) && (!lan || !(await connects(lan, AM_PORT))), `127.0.0.1 connects; ${lan ?? 'no non-loopback IPv4'} refused`);

  // phone: headless chromium, iPhone metrics, serve's identity header injected
  const chromeDir = path.join(world.d, 'chromium'); fs.mkdirSync(chromeDir, { recursive: true });
  const chromePort = await freePort();
  chrome = spawn(CHROMIUM, ['--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { env: { PATH: process.env.PATH, HOME: world.fakeHome }, stdio: 'ignore', detached: true });
  const ptarget = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find((x) => x.type === 'page') || null, 30000, 'chromium page');
  phone = await Cdp.connect(ptarget.webSocketDebuggerUrl);
  await phone.send('Page.enable'); await phone.send('Network.enable');
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await phone.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await phone.send('Network.setExtraHTTPHeaders', { headers: ID });
  const prePhone = await phone.eval(`location.href`);
  await phone.send('Page.navigate', { url: `http://127.0.0.1:${AM_PORT}/#t=${TOKEN}` });
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length === 3`), 20000, 'three rows on the phone');
  const P = await phone.eval(`({ href: location.href, stored: localStorage.getItem('orchestra.accesMobile.token') === ${JSON.stringify(TOKEN)}, ids: [...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id), groups: [...document.querySelectorAll('h2')].map((h) => h.textContent), text: document.body.innerText })`);
  clause('phone/paired-fragment-stripped', P.stored && !P.href.includes('#') && !P.href.includes(TOKEN), `${prePhone} -> ${P.href}; token stored=${P.stored}`);
  const apiOrder = rows.map((r) => r.id);
  clause('phone/list', JSON.stringify(P.ids) === JSON.stringify(apiOrder) && !P.ids.includes('ws-am-archived') && (P.text.match(/non lu/g) || []).length === 2 && /perso-rig · e2e\/am-unread · perso/.test(P.text) && /e2e\/am-idle · mc/.test(P.text) && P.groups[0] === 'Pour toi' && P.groups.length === 2, `phone rows ${P.ids.join(',')} == api order; groups ${P.groups.join(' | ')}; 2× "non lu"; group · branch · account shown`);
  saveShot('phone-list.png', await phone.shot());
  await phone.send('Page.reload');
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length === 3`), 20000, 'rows after reload without the fragment');
  clause('phone/reload-still-paired', true, 'reload without #t= still lists 3 rows (token from localStorage)');
  await phone.eval(`(() => { const c = document.getElementById('needsMe'); c.click(); return true; })()`);
  await sleep(200);
  const filtered = await phone.eval(`[...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id)`);
  clause('phone/filter-needs-me', filtered.length === 2 && !filtered.includes('ws-am-idle'), `3 -> ${filtered.length} rows: ${filtered.join(',')}`);
  saveShot('phone-list-needs-me.png', await phone.shot());

  // settings dialog in the app: health, serve command; TRUSTED toggle off/on
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
  const preDlg = await cdp.eval(`!!document.querySelector('.acces-mobile-settings')`);
  await cdp.clickSel('[data-am-open]');
  await waitFor(() => cdp.eval(`(document.querySelector('[data-am-health]')||{}).dataset?.amHealth === 'listening'`), 15000, 'dialog health listening');
  const D = await cdp.eval(`(() => { const d = document.querySelector('.acces-mobile-settings'); const r = d.getBoundingClientRect(); return { health: d.querySelector('[data-am-health]').textContent, cmd: d.querySelector('[data-am-serve-cmd]').textContent, login: d.querySelector('[data-am-login]').value, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  clause('settings/dialog', !preDlg && D.inView && D.health.includes(`127.0.0.1:${AM_PORT}`) && D.cmd === `tailscale serve --bg --https=${SERVE_PORT} http://127.0.0.1:${AM_PORT}` && D.login === LOGIN, `dialog false->true, in viewport ${D.inView}; "${D.health}"; "${D.cmd}"`);
  saveShot('settings-on.png', await cdp.shot());
  const pidOn = serverPids(TOKEN_FILE)[0];
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'off'`), 15000, 'health off');
  await waitFor(async () => !(await connects('127.0.0.1', AM_PORT)) && serverPids(TOKEN_FILE).length === 0, 15000, 'port closed + process gone');
  const storedOff = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).accesMobile;
  clause('settings/toggle-off', storedOff.enabled === false, `listening(pid ${pidOn}) -> off: port refused, no server process, store.accesMobile.enabled=${storedOff.enabled}`);
  saveShot('settings-off.png', await cdp.shot());
  const phoneOff = await phone.eval(`fetch('/api/workspaces', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => 'status ' + r.status, () => 'network error')`);
  clause('settings/phone-sees-off', phoneOff === 'network error', `phone fetch while off: ${phoneOff}`);
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'listening'`), 20000, 'health listening again');
  const pidOn2 = serverPids(TOKEN_FILE)[0];
  clause('settings/toggle-on-again', pidOn2 && pidOn2 !== pidOn && (await req(AM_PORT, '/api/workspaces', AUTH)).status === 200, `off -> listening, new pid ${pidOn2}`);

  // supervision: SIGKILL the server ⇒ restarted
  process.kill(pidOn2, 'SIGKILL');
  const pidOn3 = await waitFor(() => { const p = serverPids(TOKEN_FILE); return p.length && p[0] !== pidOn2 ? p[0] : null; }, 20000, 'a restarted server');
  await waitFor(() => connects('127.0.0.1', AM_PORT), 15000, 'port back');
  clause('supervise/restart-after-kill', (await req(AM_PORT, '/api/workspaces', AUTH)).status === 200, `SIGKILL pid ${pidOn2} -> restarted as pid ${pidOn3}`);

  // app crash ⇒ the server exits (no orphan listening)
  cdp.close(); cdp = null;
  process.kill(app.pid, 'SIGKILL');
  await waitFor(() => serverPids(TOKEN_FILE).length === 0, 15000, 'server gone after app SIGKILL').catch(() => null);
  const left = serverPids(TOKEN_FILE);
  clause('supervise/dies-with-app', left.length === 0 && !(await connects('127.0.0.1', AM_PORT)), `after app SIGKILL: server pids [${left.join(',')}], port ${await connects('127.0.0.1', AM_PORT) ? 'OPEN' : 'closed'}`);

  const dup = shots.length !== new Set(shots.map((s) => s.md5)).size;
  clause('ctl/screenshots-distinct', !dup, shots.map((s) => `${path.basename(s.file)}=${s.md5.slice(0, 8)}`).join(' '));
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log(`ERROR: ${e.stack || e}`);
  exitCode = 2;
} finally {
  try { cdp?.close(); phone?.close(); } catch {}
  for (const p of [chrome, app]) { if (p?.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } }
  for (const p of serverPids(TOKEN_FILE)) { try { process.kill(p, 'SIGKILL'); } catch {} }
}
const fails = results.filter((r) => !r.ok).map((r) => r.name);
console.log(`\n${results.length} clauses, ${fails.length} failed${fails.length ? ': ' + fails.join(', ') : ''}`);
console.log(exitCode === 0 ? 'CLEAN' : 'DIRTY');
process.exit(exitCode);
