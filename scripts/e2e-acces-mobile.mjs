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
import { startFakeApi } from './session-budget/fake-anthropic-api.mjs';
import { createRequire } from 'node:module';
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
function req(socketPath, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath, path: p, headers }, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); });
    r.on('error', reject); r.end();
  });
}
const sockConnects = (socketPath) => new Promise((resolve) => { const s = net.connect({ path: socketPath }); s.setTimeout(1500, () => { s.destroy(); resolve(false); }); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
/** A stand-in for `tailscale serve … unix:<sock>`: TCP on loopback for the browser, strips every client-sent Tailscale-User-*
 *  header and sets the tailnet identity of the device it represents (kb/1312/serve) — 502 when the socket is not there. */
function serveProxy(getSock, login) {
  const srv = http.createServer((inReq, inRes) => {
    const headers = Object.fromEntries(Object.entries(inReq.headers).filter(([k]) => !k.toLowerCase().startsWith('tailscale-user-')));
    if (login) headers['tailscale-user-login'] = login;
    const out = http.request({ socketPath: getSock(), path: inReq.url, method: inReq.method, headers }, (r) => { inRes.writeHead(r.statusCode, r.headers); r.pipe(inRes); });
    out.on('error', () => { inRes.writeHead(502); inRes.end(); });
    inReq.pipe(out);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}
function proxyGet(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); });
    r.on('error', reject); r.end();
  });
}
/** TCP listening sockets owned by pid (its fd table vs /proc/net/tcp{,6}). */
function tcpListenersOf(pid) {
  const inodes = new Map();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.set(m[1], fd); } catch {} }
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c[3] === '0A' && inodes.has(c[9])) out.push(`fd${inodes.get(c[9])}=${c[1]}(port ${parseInt(c[1].split(':')[1], 16)})`);
  }
  return out;
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
const SAMPLE_TRANSCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/payloads/acces-mobile-transcript.sample.jsonl');
const HISTORY_SESSION = JSON.parse(fs.readFileSync(SAMPLE_TRANSCRIPT, 'utf8').split('\n')[0]).sessionId;
const FAKE_REPLY = 'Réponse du faux modèle pour le téléphone';
// #339: the rig ASKS for a question (wantAsk++) and the next main (tool-carrying) model request answers with a real AskUserQuestion
// tool call; everything else gets the canned text.
const ASK_INPUT = { questions: [{ question: 'Quelle option pour le rig ?', header: 'Choix', multiSelect: false, options: [{ label: 'Réponse-rig-A', description: 'la première' }, { label: 'Réponse-rig-B', description: 'la seconde' }] }] };
let wantAsk = 0;
const fakeApi = await startFakeApi({ reply: (rec) => {
  if (rec.tools > 0 && wantAsk > 0) { wantAsk--; return { toolUse: { name: 'AskUserQuestion', input: ASK_INPUT } }; }
  return { text: FAKE_REPLY };
} });
const LOGIN = 'rig.owner@example.invalid';
const world = (() => {
  const d = path.join(RIG_DIR, 'world');
  const fakeHome = path.join(d, 'home'), ohome = path.join(d, 'oh'), cfgA = path.join(d, 'cfg-mc'), cfgB = path.join(d, 'cfg-perso');
  const repoA = path.join(d, 'repo-orchestra'), repoB = path.join(d, 'repo-perso');
  for (const x of [fakeHome, ohome, cfgA, cfgB, repoA, repoB, path.join(d, 'wt')]) { fs.mkdirSync(x, { recursive: true }); mustBeScratch('seed', x); }
  const wts = [];
  const coordDir = path.join(d, 'coord'); fs.mkdirSync(coordDir, { recursive: true });
  for (const [repo, name] of [[repoA, 'am-waiting'], [repoA, 'am-idle'], [repoB, 'am-unread'], [repoB, 'am-archived']]) {
    if (!fs.existsSync(path.join(repo, '.git'))) { git(repo, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo, 'README.md'), '#\n'); git(repo, ['add', '.'], fakeHome); git(repo, ['commit', '-q', '-m', 'seed'], fakeHome); }
    const wt = path.join(d, 'wt', name); git(repo, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome); wts.push(wt);
  }
  // A pinned account DROPS the inherited ANTHROPIC_* (workspaces.ts accountAgentEnv) unless its own env sets them: point mc at the
  // fake API through ${...} templates expanded from the app's env.
  const fakeEnv = { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}', ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}' };
  const accounts = [{ id: 'acc-mc', label: 'mc', configDir: cfgA, env: fakeEnv }, { id: 'acc-perso', label: 'perso', configDir: cfgB }];
  // #337: a transcript captured from the real CLI (texts replaced) as am-unread's history, in ITS account's project dir.
  const histDir = path.join(cfgB, 'projects', fs.realpathSync(wts[2]).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(histDir, { recursive: true });
  fs.copyFileSync(SAMPLE_TRANSCRIPT, path.join(histDir, `${HISTORY_SESSION}.jsonl`));
  const base = { baseBranch: 'main', createdAt: Date.now(), agent: 'claude' };
  const workspaces = [
    { ...base, id: 'ws-am-waiting', name: 'am-waiting', repoPath: repoA, worktreePath: wts[0], branch: 'e2e/am-waiting', status: 'waiting', accountId: 'acc-mc' },
    { ...base, id: 'ws-am-idle', name: 'am-idle', repoPath: repoA, worktreePath: wts[1], branch: 'e2e/am-idle', status: 'idle', accountId: 'acc-mc', parentId: 'ws-am-coord' },
    // #338: am-idle is a FLEET MEMBER of this coordinator's run, whose bus `delivery` switch is ON — the agent `/message` path refuses it.
    { ...base, id: 'ws-am-coord', name: 'am-coord', kind: 'orchestrator', repoPath: '', baseBranch: '', worktreePath: coordDir, branch: 'am-coord', status: 'idle' },
    { ...base, id: 'ws-am-unread', name: 'am-unread', repoPath: repoB, worktreePath: wts[2], branch: 'e2e/am-unread', status: 'idle', autoUnread: true, accountId: 'acc-perso', sdkSessionId: HISTORY_SESSION },
    { ...base, id: 'ws-am-archived', name: 'am-archived', repoPath: repoB, worktreePath: wts[3], branch: 'e2e/am-archived', status: 'idle', archived: true, archivedAt: Date.now(), accountId: 'acc-perso' },
  ];
  return { d, fakeHome, ohome, accounts, workspaces, repos: [{ path: repoA, name: 'orchestra-rig', defaultBranch: 'main', accountId: 'acc-mc' }, { path: repoB, name: 'perso-rig', defaultBranch: 'main', accountId: 'acc-perso' }] };
})();

const SERVE_PORT = 8445;
const storeDir = path.join(world.ohome, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: world.repos, workspaces: world.workspaces, accounts: world.accounts, selfTuneRuns: [], accesMobile: { enabled: true, port: 47823 /* a pre-review store: must be ignored */, servePort: SERVE_PORT, allowedLogin: LOGIN } }, null, 2));
// #337: the REAL claude CLI (structured sessions resolve `claude` on PATH) against the LOCAL FAKE Anthropic API — zero tokens;
// every other egress goes to the fake's refusing proxy.
const stubDir = path.join(world.d, 'bin'); fs.mkdirSync(stubDir, { recursive: true });
const REAL_CLAUDE = fs.realpathSync(path.join(LIVE_HOME, '.local/bin/claude'));
fs.symlinkSync(REAL_CLAUDE, path.join(stubDir, 'claude'));
const TOKEN_FILE = path.join(world.ohome, 'acces-mobile', 'token');

// #338: the coordinator's run with the bus `delivery` switch ON, written by the REAL bus module (bundled, run under Electron-as-node
// for the better-sqlite3 ABI), exactly as the bus-page rig does.
{
  const require_ = createRequire(import.meta.url);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const { build } = (() => { try { return require_('esbuild'); } catch { const g = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? []; if (!g.length) throw new Error('esbuild not resolvable'); return require_(g[0]); } })();
  const entry = path.join(world.d, 'bus-seed-entry.ts');
  fs.writeFileSync(entry, `export { openBus, busPath } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};\nexport { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};\nexport { DEFAULT_BUS_SWITCHES } from ${JSON.stringify(path.join(repoRoot, 'src/shared/bus-switches.ts'))};\n`);
  const bundle = path.join(world.d, 'bus-seed.cjs');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'cjs', platform: 'node', external: ['electron', 'better-sqlite3', 'node-pty'], logLevel: 'silent', nodePaths: [path.join(repoRoot, 'node_modules')] });
  const runner = path.join(world.d, 'bus-seed-run.cjs');
  fs.writeFileSync(runner, `const m = require(${JSON.stringify(bundle)}); const db = m.openBus(m.busPath()); m.startRun(db, { id: 'ws-am-coord', kind: 'mission', coordinator: 'ws-am-coord', title: 'am rig fleet' }, { ...m.DEFAULT_BUS_SWITCHES, delivery: true }); db.close(); console.log('SEEDED ' + m.busPath());`);
  const out = sh(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [runner], { env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(repoRoot, 'node_modules') } });
  if (!out.includes(`SEEDED ${path.join(world.ohome, 'bus.sqlite')}`)) throw new Error(`bus seeding did not report the scratch path: ${out}`);
}

// ── boot ──
const cdpPort = await freePort();
const env = { PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(cdpPort), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.accounts[0].configDir, LANG: 'C.UTF-8',
  SECRET_CANARY_FROM_MAIN: 'must-not-reach-the-server',
  ANTHROPIC_BASE_URL: fakeApi.url, ANTHROPIC_API_KEY: 'sk-ant-fake-rig-key', HTTPS_PROXY: fakeApi.proxyUrl, HTTP_PROXY: fakeApi.proxyUrl, NO_PROXY: '127.0.0.1,localhost' };
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
const logFile = path.join(world.d, 'app.log'); const fd = fs.openSync(logFile, 'w');
const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
console.log(`app pid ${app.pid}, cdp ${cdpPort}, log ${logFile}`);
let SOCK = null;
const ownerProxy = await serveProxy(() => SOCK, LOGIN);
const colleagueProxy = await serveProxy(() => SOCK, 'colleague@example.invalid');
const taggedProxy = await serveProxy(() => SOCK, null); // a tagged device: serve sets no identity
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
  const view = await cdp.eval(`window.orchestra.accesMobile()`);
  SOCK = view.socketPath;
  await waitFor(() => sockConnects(SOCK), 30000, 'the server socket');
  const sst = fs.statSync(SOCK);
  clause('ctl/socket-0600', sst.isSocket() && (sst.mode & 0o777) === 0o600 && (fs.statSync(path.dirname(SOCK)).mode & 0o077) === 0, `${SOCK} mode ${(sst.mode & 0o777).toString(8)}, dir ${(fs.statSync(path.dirname(SOCK)).mode & 0o777).toString(8)}`);
  clause('ctl/settings-port-ignored', !('port' in view.settings) && view.serveCommand === `sudo tailscale serve --bg --https=${SERVE_PORT} unix:${SOCK}`, `settings ${JSON.stringify(view.settings)}; "${view.serveCommand}"`);
  const srvEnv = environOf(pids[0]).map((e) => e.split('=')[0]).sort();
  clause('ctl/server-one-process', pids.length === 1, `pids ${pids.join(',')} argv ${cmdlineOf(pids[0]).join(' ')}`);
  clause('ctl/server-env-allowlisted', !srvEnv.includes('SECRET_CANARY_FROM_MAIN') && !srvEnv.includes('HOME') && !srvEnv.includes('CLAUDE_CONFIG_DIR') && srvEnv.includes('ACCES_MOBILE_SOCKET') && !srvEnv.includes('ACCES_MOBILE_PORT'), `server environ keys: ${srvEnv.join(' ')}`);
  const tokStat = fs.statSync(TOKEN_FILE), dirStat = fs.statSync(path.dirname(TOKEN_FILE));
  clause('ctl/token-file-mode', (tokStat.mode & 0o777) === 0o600 && (dirStat.mode & 0o777) === 0o700, `token ${(tokStat.mode & 0o777).toString(8)}, dir ${(dirStat.mode & 0o777).toString(8)}`);
  const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const ID = { 'Tailscale-User-Login': LOGIN }, AUTH = { ...ID, Authorization: `Bearer ${TOKEN}` };

  // security arms against the live port
  const ctl = await req(SOCK, '/api/workspaces', AUTH);
  const rows = ctl.status === 200 ? JSON.parse(ctl.body).workspaces : [];
  clause('sec/control-200', ctl.status === 200 && rows.length === 4 && rows.some((r) => r.name === "am-coord" && r.group === "Orchestrators"), `status ${ctl.status}; rows ${rows.map((r) => `${r.name}[${r.status}${r.unread ? ',unread' : ''}/${r.account}/${r.group}]`).join(' ')}`);
  // A seeded `waiting` is resolved to idle + non lu at store load (store.ts: no live process can still be asking), so a real
  // en attente needs a live AskUserQuestion (#339). Here: attention rank never decreases, both accounts, archived dropped.
  const rank = (r) => (r.status === 'waiting' ? 0 : r.unread ? 1 : 2);
  const sorted = rows.every((r, i) => i === 0 || rank(rows[i - 1]) <= rank(r));
  clause('phone-api/order-and-accounts', sorted && rows.filter((r) => r.unread).length === 2 && rank(rows[2]) === 2 && rows.some((r) => r.account === 'mc') && rows.some((r) => r.account === 'perso') && !rows.some((r) => r.name === 'am-archived'), `ranks ${rows.map(rank).join(',')}; non lu first; both accounts; archived dropped`);
  const BEARER = { Authorization: `Bearer ${TOKEN}` };
  const viaOwner = await proxyGet(ownerProxy.port, '/api/workspaces', BEARER);
  clause('sec/control-through-serve', viaOwner.status === 200, `owner device through the serve stand-in: ${viaOwner.status}`);
  for (const [name, fn, want] of [
    ['sec/no-identity', () => req(SOCK, '/api/workspaces', BEARER), 403],
    ['sec/colleague-through-serve', () => proxyGet(colleagueProxy.port, '/api/workspaces', BEARER), 403],
    ['sec/colleague-forges-owner-header', () => proxyGet(colleagueProxy.port, '/api/workspaces', { ...BEARER, 'Tailscale-User-Login': LOGIN }), 403],
    ['sec/tagged-device-forges-owner-header', () => proxyGet(taggedProxy.port, '/api/workspaces', { ...BEARER, 'Tailscale-User-Login': LOGIN }), 403],
    ['sec/no-token', () => proxyGet(ownerProxy.port, '/api/workspaces'), 401],
    ['sec/bad-token', () => proxyGet(ownerProxy.port, '/api/workspaces', { Authorization: `Bearer ${'x'.repeat(43)}` }), 401],
    ['sec/query-token', () => proxyGet(ownerProxy.port, `/api/workspaces?t=${TOKEN}`), 401],
    ['sec/shell-no-identity', () => req(SOCK, '/'), 403],
  ]) {
    const r = await fn();
    clause(name, r.status === want && !r.body.includes('am-'), `status ${r.status} (want ${want}), body ${r.body.length} bytes`);
  }
  const tcp = tcpListenersOf(pids[0]);
  clause('sec/no-tcp-listener', tcp.length === 0, `server pid ${pids[0]} TCP listening sockets: [${tcp.join(', ')}] (app CDP port ${cdpPort})`);

  // phone: headless chromium, iPhone metrics, serve's identity header injected
  const chromeDir = path.join(world.d, 'chromium'); fs.mkdirSync(chromeDir, { recursive: true });
  const chromePort = await freePort();
  chrome = spawn(CHROMIUM, ['--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { env: { PATH: process.env.PATH, HOME: world.fakeHome }, stdio: 'ignore', detached: true });
  const ptarget = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find((x) => x.type === 'page') || null, 30000, 'chromium page');
  phone = await Cdp.connect(ptarget.webSocketDebuggerUrl);
  await phone.send('Page.enable'); await phone.send('Network.enable');
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await phone.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const prePhone = await phone.eval(`location.href`);
  await phone.send('Page.navigate', { url: `http://127.0.0.1:${ownerProxy.port}/#t=${TOKEN}` });
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length === 4`), 20000, "four rows on the phone (incl. the coordinator)");
  const P = await phone.eval(`({ href: location.href, stored: localStorage.getItem('orchestra.accesMobile.token') === ${JSON.stringify(TOKEN)}, ids: [...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id), groups: [...document.querySelectorAll('h2')].map((h) => h.textContent), text: document.body.innerText })`);
  clause('phone/paired-fragment-stripped', P.stored && !P.href.includes('#') && !P.href.includes(TOKEN), `${prePhone} -> ${P.href}; token stored=${P.stored}`);
  const apiOrder = rows.map((r) => r.id);
  clause('phone/list', JSON.stringify(P.ids) === JSON.stringify(apiOrder) && !P.ids.includes('ws-am-archived') && (P.text.match(/non lu/g) || []).length === 2 && /perso-rig · e2e\/am-unread · perso/.test(P.text) && /e2e\/am-idle · mc/.test(P.text) && P.groups[0] === 'Pour toi' && P.groups.length === 3 && P.groups.includes('Orchestrators'), `phone rows ${P.ids.join(',')} == api order; groups ${P.groups.join(' | ')}; 2× "non lu"; group · branch · account shown`);
  saveShot('phone-list.png', await phone.shot());
  await phone.send('Page.reload');
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length === 4`), 20000, 'rows after reload without the fragment');
  clause('phone/reload-still-paired', true, 'reload without #t= still lists 4 rows (token from localStorage)');
  await phone.eval(`(() => { const c = document.getElementById('needsMe'); c.click(); return true; })()`);
  await sleep(200);
  const filtered = await phone.eval(`[...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id)`);
  clause('phone/filter-needs-me', filtered.length === 2 && !filtered.includes('ws-am-idle'), `4 -> ${filtered.length} rows: ${filtered.join(',')}`);
  saveShot('phone-list-needs-me.png', await phone.shot());
  await phone.eval(`(() => { const c = document.getElementById('needsMe'); if (c.checked) c.click(); return true; })()`);

  // #337 history: open am-unread on the phone ⇒ its transcript (other account) reads as user / tool / assistant, and the desktop's
  // bell clears (the phone's « seen » is the desktop's).
  const unreadBefore = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-unread').autoUnread;
  await phone.eval(`window.__noReload = 1; document.querySelector('li[data-id="ws-am-unread"]').click(); true`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .conv-lines [data-kind]').length === 3`), 20000, 'the history on the phone');
  const H = await phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind]')].map((e) => e.dataset.kind + ':' + e.textContent)`);
  clause('conv/history', H[0] === 'user:Liste les fichiers du dépôt, s’il te plaît.' && /^tool:✓ Bash · List repository files$/.test(H[1]) && H[2] === 'assistant:Voici les fichiers : README.md et src/.', `phone lines ${JSON.stringify(H)}`);
  saveShot('phone-conversation-history.png', await phone.shot());
  await waitFor(() => !JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-unread').autoUnread, 10000, 'the bell cleared in the store').catch(() => null);
  const unreadAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-unread').autoUnread;
  const deskBell = await cdp.eval(`(() => { const s = window.__orchestraGetState ? window.__orchestraGetState() : null; return s ? (s.workspaces || []).find((w) => w.id === 'ws-am-unread')?.autoUnread ?? null : 'n/a'; })()`).catch(() => 'n/a');
  clause('conv/seen-clears-bell', unreadBefore === true && !unreadAfter, `store autoUnread ${unreadBefore} -> ${unreadAfter} (desktop state: ${deskBell})`);

  // #337 live: open am-idle, drive a REAL turn from the desktop IPC (real CLI, fake API) ⇒ the phone shows it without a reload.
  await phone.eval(`location.hash = 'w=ws-am-idle'; true`);
  await waitFor(() => phone.eval(`document.querySelector('#conv')?.dataset.id === 'ws-am-idle' && !!document.querySelector('#conv')?.dataset.version`), 15000, 'am-idle conversation open');
  const pre = await phone.eval(`document.querySelectorAll('#conv .conv-lines [data-kind]').length`);
  const modelBefore = fakeApi.requests.filter((r) => r.type === 'model').length;
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', 'Bonjour depuis le rig').then(() => true)`);
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].some((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)}))`), 90000, 'the fake reply on the phone');
  const L = await phone.eval(`({ lines: [...document.querySelectorAll('#conv .conv-lines [data-kind]')].map((e) => e.dataset.kind + ':' + e.textContent.slice(0, 60)), noReload: window.__noReload === 1 })`);
  const modelAfter = fakeApi.requests.filter((r) => r.type === 'model').length;
  clause('conv/live-turn', L.noReload && pre === 0 && L.lines.some((l) => l === 'user:Bonjour depuis le rig') && modelAfter > modelBefore, `${pre} -> ${L.lines.length} lines without reload: ${JSON.stringify(L.lines)}; fake API model requests ${modelBefore} -> ${modelAfter}; refused egress ${fakeApi.egress.length}`);
  saveShot('phone-conversation-live.png', await phone.shot());

  // #338 must-FAIL control: the AGENT path (`/message` on the hooks socket) refuses am-idle — its run has bus delivery ON …
  const mainSock = environOf(serverPids(TOKEN_FILE)[0]).find((e) => e.startsWith('ORCHESTRA_SOCK=')).slice('ORCHESTRA_SOCK='.length);
  const viaAgentPath = await new Promise((resolve, reject) => {
    const r = http.request({ socketPath: mainSock, path: '/message', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
    r.on('error', reject); r.end(JSON.stringify({ to: 'ws-am-idle', text: 'coordination via the agent path' }));
  });
  clause('send/agent-path-refused', viaAgentPath.ok === false && /delivery switch ON/.test(viaAgentPath.error ?? ''), `hooks /message to the fleet member: ${JSON.stringify(viaAgentPath).slice(0, 160)}`);
  // … while the SAME member takes the human's message from the phone composer (trusted typing + click), and the turn runs.
  const beforeSend = fakeApi.requests.filter((r) => r.type === 'model').length;
  await phone.eval(`document.querySelector('.conv-input').focus(); true`);
  await phone.send('Input.insertText', { text: 'Message tapé sur le téléphone' });
  const sendBtn = await phone.eval(`(() => { const r = document.querySelector('.conv-send').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await phone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sendBtn.x, y: sendBtn.y }] }).catch(() => {});
  await phone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
  await sleep(300);
  if ((await phone.eval(`document.querySelector('.conv-compose').dataset.state || ''`)) === '') {
    for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: sendBtn.x, y: sendBtn.y, ...extra });
  }
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].some((e) => e.textContent === 'Message tapé sur le téléphone')`), 60000, 'the phone message in the conversation');
  await waitFor(() => fakeApi.requests.filter((r) => r.type === 'model').length > beforeSend, 60000, 'a model request for the phone message');
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].filter((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)})).length >= 2`), 60000, 'the reply to the phone message');
  const S = await phone.eval(`({ state: document.querySelector('.conv-compose').dataset.state, input: document.querySelector('.conv-input').value, err: document.querySelector('.conv-send-error').textContent })`);
  clause('send/phone-to-fleet-member', S.state === 'sent' && S.input === '' && !S.err, `composer state ${S.state}, input cleared ${S.input === ''}; model requests ${beforeSend} -> ${fakeApi.requests.filter((r) => r.type === 'model').length}; reply shown`);
  saveShot('phone-conversation-sent.png', await phone.shot());
  // errors are never a false « sent »: an archived workspace is refused with a reason
  const arch = await phone.eval(`fetch('/api/send?id=ws-am-archived', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') }, body: JSON.stringify({ text: 'x' }) }).then((r) => r.json())`);
  clause('send/archived-refused', arch.ok === false && /archived/.test(arch.error), JSON.stringify(arch));

  // #339 round 1 — the real CLI parks an AskUserQuestion; the PHONE answers it; the card leaves both surfaces; a 2nd answer is refused.
  wantAsk = 1;
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', 'Pose-moi une question').then(() => true)`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"] .ask-opt').length === 2`), 90000, 'the question on the phone');
  const deskPending1 = await cdp.eval(`(window.__readAgentSession('ws-am-idle')?.pendingAnswerables ?? []).map((a) => a.requestId)`);
  const reqId1 = deskPending1[0];
  const optB = await phone.eval(`(() => { const b = [...document.querySelectorAll('#conv .ask-opt')].find((x) => x.textContent === 'Réponse-rig-B'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: optB.x, y: optB.y, ...extra });
  await waitFor(() => phone.eval(`!!document.querySelector('#conv .ask-opt.picked') && !document.querySelector('#conv .ask-submit').disabled`), 5000, 'option picked, submit enabled');
  saveShot('phone-ask-picked.png', await phone.shot());
  const sub = await phone.eval(`(() => { const r = document.querySelector('#conv .ask-submit').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: sub.x, y: sub.y, ...extra });
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"]').length === 0`), 30000, 'the question gone from the phone');
  await waitFor(() => cdp.eval(`(window.__readAgentSession('ws-am-idle')?.pendingAnswerables ?? []).length === 0`), 15000, 'the card gone from the desktop');
  const toolRes = await waitFor(() => cdp.eval(`(() => { const m = (window.__readAgentSession('ws-am-idle')?.messages ?? []).filter((x) => x.toolUse?.name === 'AskUserQuestion').at(-1); const c = m?.toolResult?.content; return c ? (typeof c === 'string' ? c : JSON.stringify(c)) : null; })()`), 30000, 'the AskUserQuestion tool result');
  clause('ask/phone-answers', deskPending1.length === 1 && /Réponse-rig-B/.test(toolRes) && !/Réponse-rig-A"/.test(toolRes), `desktop card ${deskPending1.length} -> 0; phone card gone; the CLI's tool result: ${toolRes.slice(0, 140)}`);
  const again = await phone.eval(`fetch('/api/answer?id=ws-am-idle&request=' + encodeURIComponent(${JSON.stringify(reqId1)}), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') }, body: JSON.stringify({ answers: { 'Quelle option pour le rig ?': ['Réponse-rig-A'] } }) }).then((r) => r.json())`);
  clause('ask/second-answer-refused', again.ok === false && /already answered/.test(again.error), JSON.stringify(again));
  saveShot('phone-ask-answered.png', await phone.shot());

  // #339 round 2 — the DESKTOP answers (its real IPC); the phone's card goes away without a reload.
  wantAsk = 1;
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', 'Encore une question').then(() => true)`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"]').length === 1`), 90000, 'the second question on the phone');
  const p2 = await cdp.eval(`(window.__readAgentSession('ws-am-idle')?.pendingAnswerables ?? []).map((a) => ({ requestId: a.requestId, input: a.input }))`);
  await cdp.eval(`window.orchestra.agentSdkPermissionReply('ws-am-idle', ${JSON.stringify(p2[0].requestId)}, { behavior: 'allow', updatedInput: { ...${JSON.stringify(p2[0].input)}, answers: { 'Quelle option pour le rig ?': 'Réponse-rig-A' } } }).then(() => true)`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"]').length === 0`), 30000, 'the second question gone from the phone');
  clause('ask/desktop-answers', p2.length === 1 && (await phone.eval(`window.__noReload === 1`)), `desktop answered ${p2[0]?.requestId}; phone card 1 -> 0 without reload`);
  await phone.eval(`location.hash = ''; true`);

  // settings dialog in the app: health, serve command; TRUSTED toggle off/on
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
  const preDlg = await cdp.eval(`!!document.querySelector('.acces-mobile-settings')`);
  await cdp.clickSel('[data-am-open]');
  await waitFor(() => cdp.eval(`(document.querySelector('[data-am-health]')||{}).dataset?.amHealth === 'listening'`), 15000, 'dialog health listening');
  const D = await cdp.eval(`(() => { const d = document.querySelector('.acces-mobile-settings'); const r = d.getBoundingClientRect(); return { health: d.querySelector('[data-am-health]').textContent, cmd: d.querySelector('[data-am-serve-cmd]').textContent, login: d.querySelector('[data-am-login]').value, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  clause('settings/dialog', !preDlg && D.inView && /private local socket/.test(D.health) && D.cmd === `sudo tailscale serve --bg --https=${SERVE_PORT} unix:${SOCK}` && D.login === LOGIN, `dialog false->true, in viewport ${D.inView}; "${D.health}"; "${D.cmd}"`);
  saveShot('settings-on.png', await cdp.shot());
  const pidOn = serverPids(TOKEN_FILE)[0];
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'off'`), 15000, 'health off');
  await waitFor(async () => !fs.existsSync(SOCK) && serverPids(TOKEN_FILE).length === 0, 15000, 'socket removed + process gone');
  const storedOff = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).accesMobile;
  clause('settings/toggle-off', storedOff.enabled === false, `listening(pid ${pidOn}) -> off: socket removed, no server process, store.accesMobile.enabled=${storedOff.enabled}`);
  saveShot('settings-off.png', await cdp.shot());
  const phoneOff = await phone.eval(`fetch('/api/workspaces', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => 'status ' + r.status, () => 'network error')`);
  clause('settings/phone-sees-off', phoneOff === 'status 502', `phone fetch while off (serve stand-in, nothing behind it): ${phoneOff}`);
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'listening'`), 20000, 'health listening again');
  const pidOn2 = serverPids(TOKEN_FILE)[0];
  await waitFor(() => sockConnects(SOCK), 15000, 'socket back');
  clause('settings/toggle-on-again', pidOn2 && pidOn2 !== pidOn && (await req(SOCK, '/api/workspaces', AUTH)).status === 200, `off -> listening, new pid ${pidOn2}`);

  // perf: Accès mobile ON, the phone polling every 5 s, dialog closed — main and server CPU over 30 s (/proc utime+stime delta)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' }).catch(() => {});
  const ticks = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
  const HZ = 100;
  const t0 = { main: ticks(app.pid), srv: ticks(pidOn2), at: Date.now() };
  await sleep(30000);
  const secs = (Date.now() - t0.at) / 1000;
  const mainPct = ((ticks(app.pid) - t0.main) / HZ / secs) * 100, srvPct = ((ticks(pidOn2) - t0.srv) / HZ / secs) * 100;
  const polled = await phone.eval(`document.querySelectorAll('li[data-id]').length`);
  clause('perf/idle-cpu', mainPct < 10 && srvPct < 5 && polled === 4, `over ${secs.toFixed(0)} s with the phone streaming + polling: main ${mainPct.toFixed(1)}% CPU, server ${srvPct.toFixed(2)}% CPU (phone lists ${polled})`);

  // supervision: SIGKILL the server ⇒ restarted
  process.kill(pidOn2, 'SIGKILL');
  const pidOn3 = await waitFor(() => { const p = serverPids(TOKEN_FILE); return p.length && p[0] !== pidOn2 ? p[0] : null; }, 20000, 'a restarted server');
  await waitFor(() => sockConnects(SOCK), 15000, 'socket back');
  clause('supervise/restart-after-kill', (await req(SOCK, '/api/workspaces', AUTH)).status === 200, `SIGKILL pid ${pidOn2} -> restarted as pid ${pidOn3} (stale socket replaced)`);

  // app crash ⇒ the server exits (no orphan listening)
  cdp.close(); cdp = null;
  process.kill(app.pid, 'SIGKILL');
  await waitFor(() => serverPids(TOKEN_FILE).length === 0, 15000, 'server gone after app SIGKILL').catch(() => null);
  const left = serverPids(TOKEN_FILE);
  const stillServing = await sockConnects(SOCK);
  clause('supervise/dies-with-app', left.length === 0 && !stillServing, `after app SIGKILL: server pids [${left.join(',')}], socket ${stillServing ? 'STILL ANSWERS' : 'dead'} (${fs.existsSync(SOCK) ? 'file left' : 'file removed'})`);

  const dup = shots.length !== new Set(shots.map((s) => s.md5)).size;
  clause('ctl/screenshots-distinct', !dup, shots.map((s) => `${path.basename(s.file)}=${s.md5.slice(0, 8)}`).join(' '));
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log(`ERROR: ${e.stack || e}`);
  exitCode = 2;
} finally {
  try { cdp?.close(); phone?.close(); } catch {}
  for (const p of [ownerProxy, colleagueProxy, taggedProxy]) p.srv.close();
  if (SOCK && fs.existsSync(SOCK)) { try { fs.unlinkSync(SOCK); } catch {} }
  for (const p of [chrome, app]) { if (p?.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } }
  // keepers + CLIs are detached from the app: select them by identity (this rig's ORCHESTRA_HOME in their environ)
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { if (environOf(pid).includes(`ORCHESTRA_HOME=${world.ohome}`) && +pid !== process.pid) process.kill(+pid, 'SIGKILL'); } catch {}
  }
  try { await fakeApi.stop(); } catch {}
  for (const p of serverPids(TOKEN_FILE)) { try { process.kill(p, 'SIGKILL'); } catch {} }
}
const fails = results.filter((r) => !r.ok).map((r) => r.name);
console.log(`\n${results.length} clauses, ${fails.length} failed${fails.length ? ': ' + fails.join(', ') : ''}`);
console.log(exitCode === 0 ? 'CLEAN' : 'DIRTY');
process.exit(exitCode);
