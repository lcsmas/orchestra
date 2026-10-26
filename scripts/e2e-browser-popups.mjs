// #396 — popups, on the BUILT app (argv[2] = app dir) inside the contained rig's own headless sway.
//
// One scratch world (ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, TWO seeded workspaces, pinned scratch account, stub `claude`), the shared fixture site
// (scripts/fixtures/browser-site: popups-opener / popups-oauth / popups-blank / popups-storm) and ONE boot of the app. Every click is a TRUSTED CDP click.
//   blank    a `_blank` link opens a NEW TAB (active; the page it was on stays); ctrl-click opens a background tab
//   oauth    a NAMED sized window.open (OAuth shape) is a NATIVE CHILD WINDOW that keeps window.opener: the popup posts a token back to its opener and closes;
//            the window is a real toplevel in MY sway, painted, in the workspace's session
//   xsite    the same flow with a CROSS-SITE IdP (localhost vs 127.0.0.1: another site, another renderer process)
//   storm    40 window.open from a script (no click): the budget of 3 binds (tabs, windows, or both together); near the cap of 8 the cap binds;
//            ONE click firing 20 opens one popup (shown) + the budget; every view and window is accounted for
//   ws       switching workspace takes the child window out of the compositor, switching back restores it
//   cleanup  archiving the workspace leaves no tab view and no popup window
// Every clause prints PASS/FAIL with the value that proves it; ctl/* controls (identity, scratch containment, own sway, trusted click, the page really fired
// its popups) are separate clauses so a red clause can only be blamed on the behaviour. Must-FAIL builds: scripts/e2e-browser-popups-mutants.mjs.
//
// Usage (via scripts/e2e-browser-popups.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--arms blank,oauth,xsite,hostile,s1|s2|s2b|s2c|s3|s4|churn (storm phases),storm,ws,cleanup]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const ARMS = new Set(flag('--arms', 'blank,oauth,xsite,hostile,storm,ws,cleanup').split(','));

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-tabs.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const XDG = privateRuntimeDir(); // the rig's PRIVATE runtime dir (incident Q2, ledger #405): it refuses the human's one
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch containment: a live dir is never handed to the app ───────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)),
  path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/var/empty/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · outside path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what, step = 150) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, bd, ct, il;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG bd=${bd} ct=${ct} il=${il}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
/** mean RGB of a (2r+1)^2 block centred on (cx, cy). */
function blockColor(I, cx, cy, r = 6) {
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(I.h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(I.w - 1, cx + r); x++) { const o = (y * I.w + x) * I.ch; R += I.data[o]; G += I.data[o + 1]; B += I.data[o + 2]; n++; }
  return [Math.round(R / n), Math.round(G / n), Math.round(B / n)];
}
const near = (a, b, tol = 10) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y, modifiers = 0) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, modifiers, ...extra }); await sleep(60); } }
  async key(key, code, vk) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined }); await sleep(30); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

// ── results ───────────────────────────────────────────────────────────────────────────────────────
const results = []; const shots = [];
/** A condition that may throw (an element missing on a broken build) reads as FALSE — a red clause, not an aborted rig. */
const safe = (f) => { try { return !!f(); } catch { return false; } };
/** Wait for a condition without aborting the rig on timeout: resolves true/false (the clause that follows reports it). */
const softWait = async (fn, ms, what) => { try { await waitFor(fn, ms, what); return true; } catch { console.log(`  (soft wait timed out: ${what})`); return false; } };
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
fs.mkdirSync(OUT, { recursive: true });
function saveShot(name, buf) { const f = path.join(OUT, `${LABEL}-${name}`); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }
const grimPath = (name) => path.join(OUT, `${LABEL}-${name}`);
function grim(name) {
  const f = grimPath(name);
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
  const buf = fs.readFileSync(f); shots.push({ file: f, md5: md5(buf) }); return decodePng(buf);
}

// ── fixture site: the shared one (#395) when present, else a throwaway server over the SAME pages dir ─────────
const SITE_DIR = path.join(repoRoot, 'scripts/fixtures/browser-site');
const COLORS = { a: [0xd6, 0x27, 0x28], b: [0x2c, 0xa0, 0x2c], c: [0x1f, 0x77, 0xb4] };
let siteProc = null;
async function startSite() {
  const shared = path.join(SITE_DIR, 'server.mjs');
  if (fs.existsSync(shared)) {
    siteProc = spawn('node', [shared, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('fixture site did not print LISTENING')), 10000); siteProc.stdout.on('data', (d) => { const m = /LISTENING (\d+)/.exec(String(d)); if (m) { clearTimeout(t); res(+m[1]); } }); });
    return { port, kind: 'shared fixture site (scripts/fixtures/browser-site/server.mjs)' };
  }
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    const f = /^[\w.-]+\.html$/.test(name) ? path.join(SITE_DIR, 'pages', name) : null;
    if (f && fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  siteProc = { kill: () => srv.close() };
  return { port: srv.address().port, kind: 'throwaway http server over scripts/fixtures/browser-site/pages (shared site not landed yet)' };
}

// ── world: a real git repo + registered worktree, the PINNED scratch account, a stub `claude` ─────────────
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'bp396-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# bp396 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bp396-1', wtDir], fakeHome);
  if (!git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome).includes(`worktree ${fs.realpathSync(wtDir)}`)) throw new Error('seed worktree not registered');
  const account = { id: 'rig-bp396', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const wtDir2 = path.join(armDir, 'wt', 'bp396-2');
  mustBeScratch('wt2', wtDir2);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bp396-2', wtDir2], fakeHome);
  const ws = { id: 'ws-bp396-1', name: 'bp396-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/bp396-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const ws2 = { ...ws, id: 'ws-bp396-2', name: 'bp396-2', worktreePath: wtDir2, branch: 'e2e/bp396-2', createdAt: Date.now() + 1 };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bp396-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws, ws2], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho BP396-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, ws2, stubDir, tabsFile: path.join(ohome, 'userData', 'orchestra', 'browser-tabs.json'), logFile: path.join(ohome, 'logs', 'orchestra.log') };
}

function procsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── one boot of the app on the world ─────────────────────────────────────────────────────────────
const VIEWPORT = { w: 1500, h: 950 };
async function boot(world, bootName) {
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${VIEWPORT.w}x${VIEWPORT.h}`]);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
    // Belt and braces on top of the rig's private runtime dir (incident Q2, ledger #405): pin the session bus to a PRIVATE nonexistent socket so libdbus has nothing to fall back to
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(RIG_DIR, 'no-session-bus')}` };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(RIG_DIR, `app-${bootName}.log`);
  const fd = fs.openSync(logFile, 'w');
  const APP_ARGS = [APP_DIR, '--ozone-platform=wayland', '--password-store=basic'];
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), APP_ARGS, { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  [${bootName}] app pid ${app.pid} port ${port} log ${logFile}`);
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('!!document.querySelector(".toolbar")'), 60000, 'the toolbar (an ACTIVE workspace)');
  const b = { app, port, cdp, target, bootName, world };
  await selectWorkspace(b, 'e2e/bp396-1'); // two workspaces are seeded: every boot drives the first
  // controls: the app answering is OUR build, on OUR sway, in OUR scratch world
  clause(bootName, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
  // What the driver HANDED the app, not a /proc/<pid>/environ read: Chromium rewrites its own environ area once a DBUS address is set (ledger #405, seat 2 F2).
  clause(bootName, 'ctl/scratch-env', env.ORCHESTRA_HOME === world.ohome && env.CLAUDE_CONFIG_DIR === world.cfg && env.HOME === world.fakeHome && !('DISPLAY' in env) && env.WAYLAND_DISPLAY === RIG_WAYLAND && env.XDG_RUNTIME_DIR === `${RIG_DIR}/xdg`,
    `handed to the app: ORCHESTRA_HOME=${env.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR} DISPLAY=${'DISPLAY' in env ? env.DISPLAY : '<unset>'}`);
  // what the driver HANDED the app (not a /proc read: an Electron process may rewrite its own argv/environ area): the private bus pin and the basic password store
  const handed = { bus: env.DBUS_SESSION_BUS_ADDRESS, args: APP_ARGS };
  clause(bootName, 'ctl/app-cannot-reach-the-real-session-bus-or-keyring', handed.bus === `unix:path=${path.join(RIG_DIR, 'no-session-bus')}` && handed.bus.startsWith(`unix:path=${RIG_DIR}/`) && handed.args.includes('--password-store=basic'),
    `handed to the app: DBUS_SESSION_BUS_ADDRESS=${handed.bus}; argv ${JSON.stringify(handed.args)}`);
  // positive proof it tried ONLY the private bus: Chromium logs the failed connect with the address it used (set at start-up, so wait for it)
  await sleep(2500);
  const busLines = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('bus.cc'));
  const privateTried = busLines.some((l) => l.includes(path.join(RIG_DIR, 'no-session-bus')));
  // positive form: EVERY connection attempt it logged names the rig's own dir (nothing else was tried), and none mentions the secrets service
  const strayed = busLines.filter((l) => !l.includes(RIG_DIR) || /org\.freedesktop\.secrets/.test(l));
  clause(bootName, 'ctl/app-tried-only-the-private-bus', privateTried && strayed.length === 0, `bus.cc lines: ${busLines.length}; mention the private socket: ${privateTried}; lines naming anything else or the secrets service: ${strayed.length}; first: ${JSON.stringify(busLines[0]?.replace(/^\[[^\]]*\]/, '').slice(0, 160) ?? null)}`);
  clause(bootName, 'ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} present in my sway's get_tree`);
  return b;
}
async function teardown(b, how) {
  b.cdp?.close();
  if (how === 'graceful') {
    try {
      const v = await (await fetch(`http://127.0.0.1:${b.port}/json/version`)).json();
      const bc = await Cdp.connect(v.webSocketDebuggerUrl);
      bc.send('Browser.close').catch(() => {});
      await waitFor(() => !pidAlive(b.app.pid), 30000, 'graceful exit of the app main process');
      bc.close();
    } catch (e) { console.log(`  [${b.bootName}] graceful quit did not complete: ${e.message}`); }
  } else if (how === 'kill9') {
    try { process.kill(-b.app.pid, 'SIGKILL'); } catch {}
    await waitFor(() => !pidAlive(b.app.pid), 15000, 'SIGKILLed app to be gone');
  }
  try { process.kill(-b.app.pid, 'SIGTERM'); } catch {}
  await sleep(1500);
  try { process.kill(-b.app.pid, 'SIGKILL'); } catch {}
  for (const p of procsByHome(b.world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} } // keeper + stub claude outlive the app by design
  await sleep(500);
  const left = procsByHome(b.world.ohome);
  clause(b.bootName, 'rig/teardown-no-survivors', left.length === 0, `processes still carrying ${b.world.ohome}: ${left.length ? left.join(',') : 'none'}`);
}

// ── in-page drivers (all clicks are TRUSTED CDP input) ───────────────────────────────────────────
const TABS_JS = `[...document.querySelectorAll('.browser-tab')].map((e) => ({ id: e.dataset.tabId, label: e.querySelector('.browser-tab-label')?.textContent ?? '', active: e.getAttribute('aria-selected') === 'true', openedBy: e.dataset.openedBy, tip: e.title }))`;
const tabs = (b) => b.cdp.eval(TABS_JS);
const urlBar = (b) => b.cdp.eval(`document.querySelector('.browser-url-input')?.value ?? null`);
const rectOf = (b, sel, nth = 0) => b.cdp.eval(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
async function clickSel(b, sel, nth = 0) {
  const r = await rectOf(b, sel, nth);
  if (!r) throw new Error(`no element for ${sel}[${nth}]`);
  await b.cdp.click(r.x, r.y);
  return r;
}
async function typeUrl(b, url) {
  await clickSel(b, '.browser-url-input');
  await b.cdp.eval(`document.querySelector('.browser-url-input').select()`);
  await b.cdp.send('Input.insertText', { text: url });
  await sleep(80);
  await b.cdp.key('Enter', 'Enter', 13);
}
/** page targets of the debug port that are NOT the app renderer = one per live tab view. */
async function viewTargets(b) {
  const list = await (await fetch(`http://127.0.0.1:${b.port}/json`)).json();
  return list.filter((x) => x.type === 'page' && !x.url.includes('dist/index.html'));
}
async function openBrowserPane(b) {
  const sel = 'button.pane-toggle[aria-label="Show browser pane"]';
  await waitFor(() => b.cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`), 30000, 'the browser pane toggle');
  await clickSel(b, sel);
  await waitFor(() => b.cdp.eval(`!!document.querySelector('.browser-tabs') && document.querySelectorAll('.browser-tab').length > 0`), 30000, 'the tab strip');
  await waitFor(() => b.cdp.eval(`(() => { const h = document.querySelector('.browser-holder'); if (!h) return false; const r = h.getBoundingClientRect(); return r.width > 100 && r.height > 100; })()`), 15000, 'the browser holder to be laid out');
  await sleep(500);
}
/** compositor pixel at the centre of the page area (.browser-holder); retried until it matches `want` or the deadline. */
async function holderColor(b, name, want, ms = 6000) {
  const r = await rectOf(b, '.browser-holder');
  if (!r) throw new Error('no .browser-holder');
  const t0 = Date.now(); let c, img, tries = 0;
  do {
    img = grim(`${name}.png`); tries++;
    c = blockColor(img, Math.round(r.x), Math.round(r.y));
    if (!want || near(c, want)) break;
    await sleep(350);
  } while (Date.now() - t0 < ms);
  return { color: c, tries, rect: r, w: img.w, h: img.h };
}
/** Click the sidebar row whose text contains `branch` (trusted click) and wait until it is the active one. */
async function selectWorkspace(b, branch) {
  const idx = await b.cdp.eval(`[...document.querySelectorAll('.ws-item')].findIndex((e) => e.textContent.includes(${JSON.stringify(branch)}))`);
  if (idx < 0) throw new Error(`no sidebar row for ${branch}`);
  await clickSel(b, '.ws-item', idx);
  await waitFor(() => b.cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some((e) => e.textContent.includes(${JSON.stringify(branch)}))`), 15000, `${branch} to be the active workspace`);
  await sleep(500);
}
// ── live-dir canary (symlink set + mcpServers keys of the live ~/.claude* dirs, before/after) ─────────
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  return snap;
}

// ── popup-specific drivers ────────────────────────────────────────────────────────────────────────
/** page targets of the debug port that are NOT the app renderer = one per live tab view + one per popup child window. */
const pageTargets = viewTargets;
/** One-shot CDP session on a page target: eval an expression and return its value. */
async function evalIn(target, expr) {
  const c = await Cdp.connect(target.webSocketDebuggerUrl);
  try { return await c.eval(expr); } finally { c.close(); }
}
/** Trusted click on the element matching `sel` inside a page target (viewport coordinates), optionally with ctrl held. */
async function clickIn(target, sel, { ctrl = false, shift = false } = {}) {
  const c = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    const r = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!r) throw new Error(`no element ${sel} in ${target.url}`);
    await c.click(r.x, r.y, (ctrl ? 2 : 0) | (shift ? 8 : 0));
  } finally { c.close(); }
}
/** The app's own native windows in MY sway (main window + popup child windows), from the compositor's tree. */
function swayWindows(pid) {
  const tree = JSON.parse(sh('swaymsg', ['-t', 'get_tree']));
  const out = [];
  (function walk(n) {
    for (const c of [...(n.nodes || []), ...(n.floating_nodes || [])]) {
      if (c.pid === pid && c.type !== 'workspace' && c.type !== 'output' && !(c.nodes || []).length) out.push({ name: c.name, floating: c.type === 'floating_con', rect: c.rect, visible: c.visible, fullscreen: c.fullscreen_mode });
      walk(c);
    }
  })(tree);
  return out;
}
const winNames = (b) => swayWindows(b.app.pid).map((w) => w.name);
const byUrl = async (b, re) => (await pageTargets(b)).filter((t) => re.test(t.url));
const logLines = (world) => { try { return fs.readFileSync(world.logFile, 'utf8').split('\n'); } catch { return []; } };
const refusals = (world, reason) => logLines(world).filter((l) => l.includes(`popup refused (${reason})`)).length;
/** The page target whose URL matches. */
const pageOf = async (b, re) => (await pageTargets(b)).find((t) => re.test(t.url));
async function closeExtraTabs(b, keep = 1) {
  for (let n = (await tabs(b)).length; n > keep; n--) {
    await clickSel(b, '.browser-tab-close', n - 1);
    await softWait(async () => (await tabs(b)).length === n - 1, 10000, `close tab ${n} -> ${n - 1}`);
  }
  await clickSel(b, '.browser-tab', 0); await sleep(300);
}
/** Close the popup child WINDOWS (page targets that are not a tab) the way the page itself would. */
async function closeAllPopupWindows(b) {
  const tabUrls = new Set((await tabs(b)).map((x) => x.tip));
  for (const t of await byUrl(b, /popups-(oauth|blank)\.html/)) {
    if (!tabUrls.has(t.url)) { try { await evalIn(t, 'window.close()'); } catch {} }
  }
  await sleep(600);
}
const OPENER_RE = /popups-opener\.html/;
/** A child window's compositor name is OUR title: `<origin> — <the page's own title>` (#396 F2) — never the bare page title. */
const isOauthWin = (w) => typeof w.name === 'string' && w.name.endsWith(` — ${TITLES.oauth}`);
/** The page-initiated opens THIS rig caused, to keep a phase inside the per-minute rate cap (POPUP_RATE_MAX = 6 per workspace): wait for the oldest to age out. */
const RATE_MAX = 6, RATE_WINDOW_MS = 60000;
const rigOpens = [];
async function rateRoom(n) {
  for (;;) {
    while (rigOpens.length && Date.now() - rigOpens[0] >= RATE_WINDOW_MS + 1500) rigOpens.shift();
    if (rigOpens.length + n <= RATE_MAX) return;
    const wait = RATE_WINDOW_MS + 1500 - (Date.now() - rigOpens[0]);
    console.log(`  (rate window: waiting ${Math.ceil(wait / 1000)}s for ${n} free page-initiated opens)`);
    await sleep(wait + 200);
  }
}
const noteOpens = (n) => { for (let i = 0; i < n; i++) rigOpens.push(Date.now()); };
/** Read something that may be gone on a broken build (the page navigated away): a missing value is a red clause, not an aborted arm. */
const val = async (fn, dflt = null) => { try { return await fn(); } catch { return dflt; } };
/** Every arm starts from the same place: popup windows closed, ONE tab, on the opener fixture. */
async function gotoOpener(b) {
  await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
  await typeUrl(b, URLS.opener);
  await waitFor(async () => (await tabs(b))[0]?.label === TITLES.opener, 20000, 'tab 1 to load the opener fixture');
  return pageOf(b, OPENER_RE);
}

// ═════════════════════════════════════ main ═════════════════════════════════════
const before = liveCanary();
const site = await startSite();
const BASE = `http://127.0.0.1:${site.port}`;
const URLS = { opener: `${BASE}/popups-opener.html`, storm: (q) => `${BASE}/popups-storm.html${q}` };
console.log(`[rig] app ${APP_DIR} label ${LABEL} arms ${[...ARMS].join(',')} out ${OUT}\n[rig] fixture: ${site.kind} on ${BASE}`);
const world = seedWorld(path.join(RIG_DIR, 'world'));
const TITLES = { opener: 'Popups fixture opener', oauth: 'OAuth popup fixture', blank: 'Popups fixture blank', storm: 'Popups fixture storm' };
let b = null;
/** An arm that throws (a broken build leaves the page in a shape the driver cannot read) is ONE red clause, not an aborted rig: later arms still run. */
async function runArm(arm, fn) {
  try { await fn(); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); }
}
try {
  b = await boot(world, 'boot1');
  await openBrowserPane(b);
  const t0 = await tabs(b);
  const baseWins = winNames(b);
  const baseMainWidth = swayWindows(b.app.pid)[0]?.rect?.width;
  clause('rig', 'ctl/one-tab-one-view-one-window-at-first-open', t0.length === 1 && (await pageTargets(b)).length === 1 && baseWins.length === 1, `tabs ${t0.length}, page targets ${(await pageTargets(b)).length}, app windows in my sway ${JSON.stringify(baseWins)}`);

  // the opener page in the first tab (typed in the URL bar, like the human)
  await typeUrl(b, URLS.opener);
  await waitFor(async () => (await tabs(b))[0]?.label === TITLES.opener, 20000, 'tab 1 to load the opener fixture');
  let opener = await pageOf(b, OPENER_RE);
  clause('rig', 'ctl/fixture-served-and-page-target-found', !!opener && (await evalIn(opener, `document.getElementById('status').textContent`)) === 'idle', `page target ${opener?.url}`);
  // the instrument: a CDP click reaches the page as a TRUSTED event (otherwise every gesture clause below measures nothing)
  await evalIn(opener, `document.addEventListener('click', (e) => { window.__clicks = (window.__clicks || 0) + 1; window.__trusted = e.isTrusted; }, true)`);
  await clickIn(opener, '#status');
  clause('rig', 'ctl/cdp-click-is-a-trusted-click', (await evalIn(opener, `[window.__clicks, window.__trusted].join()`)) === '1,true', `clicks,isTrusted = ${await evalIn(opener, `[window.__clicks, window.__trusted].join()`)}`);

  // ────────────────────────────── blank: `_blank` -> a tab ──────────────────────────────
  if (ARMS.has('blank')) await runArm('blank', async () => {
    opener = await gotoOpener(b);
    await clickIn(opener, '#blank');
    const opened = await softWait(async () => (await tabs(b)).length === 2, 15000, 'a new tab for the _blank link');
    await sleep(800);
    const ts = await tabs(b);
    clause('blank', 'blank-link-opens-a-new-tab', opened && ts.length === 2, `tabs ${JSON.stringify(ts.map((t) => [t.label, t.active]))}`);
    clause('blank', 'new-tab-loads-the-link-and-is-active', safe(() => ts[1].active && ts[1].tip.endsWith('/popups-blank.html?from=link') && ts[1].label === TITLES.blank), `tab 2 = ${JSON.stringify(ts[1])}`);
    clause('blank', 'the-page-the-link-was-on-stays-where-it-was', safe(() => ts[0].label === TITLES.opener && ts[0].tip === URLS.opener), `tab 1 = ${JSON.stringify(ts[0])}`);
    clause('blank', 'link-popup-makes-a-tab-not-a-window', (await pageTargets(b)).length === ts.length && winNames(b).length === baseWins.length, `page targets ${(await pageTargets(b)).length} for ${ts.length} tabs; app windows ${JSON.stringify(winNames(b))}`);
    const px = await holderColor(b, 'blank-new-tab', [0x1f, 0x9e, 0x6e]);
    clause('blank', 'new-tab-is-painted-in-the-pane', near(px.color, [0x1f, 0x9e, 0x6e], 14), `pane pixel ${hex(px.color)} (the blank fixture's green)`);
    saveShot('blank-renderer.png', await b.cdp.shot());
    // ctrl-click opens in the BACKGROUND
    await clickSel(b, '.browser-tab', 0); await softWait(async () => (await tabs(b))[0]?.active, 10000, 'tab 1 active');
    opener = await pageOf(b, OPENER_RE);
    await clickIn(opener, '#blank', { ctrl: true });
    await softWait(async () => (await tabs(b)).length === 3, 15000, 'a background tab for the ctrl-click');
    const tc = await tabs(b);
    clause('blank', 'ctrl-click-opens-a-background-tab', tc.length === 3 && tc[0].active && !tc[2].active, `tabs ${JSON.stringify(tc.map((t) => [t.label, t.active]))}`);
    await closeExtraTabs(b, 1);
    // shift-click: Chromium says `new-window` with NO features (a shifted link, not a sized popup) -> still a tab, never a fixed-size native window
    opener = await pageOf(b, OPENER_RE);
    await clickIn(opener, '#blank', { shift: true });
    await softWait(async () => (await tabs(b)).length === 2, 15000, 'a tab for the shift-click');
    await sleep(600);
    const tsh = await tabs(b);
    clause('blank', 'shift-click-opens-a-tab-not-a-native-window', tsh.length === 2 && winNames(b).length === baseWins.length && (await pageTargets(b)).length === 2, `tabs ${JSON.stringify(tsh.map((t) => [t.label, t.active]))}; app windows ${JSON.stringify(winNames(b))}; page targets ${(await pageTargets(b)).length}`);
    await closeExtraTabs(b, 1);
  });

  // ────────────────────────────── oauth: opener-dependent popup -> native child window ──────────────────────────────
  if (ARMS.has('oauth')) await runArm('oauth', async () => {
    opener = await gotoOpener(b);
    await clickIn(opener, '#signin-hold');
    const signed = await softWait(async () => (await evalIn(opener, `document.getElementById('status').textContent`)) === 'signed-in tok-hold', 15000, 'the OAuth popup to post its token back to window.opener');
    const status = await val(() => evalIn(opener, `document.getElementById('status').textContent`), '<the opener page is gone>');
    clause('oauth', 'oauth-flow-completes-the-popup-posts-back-to-window-opener', signed, `opener #status = ${JSON.stringify(status)} (a handler that loads the popup in the opener's own view makes window.open return null: "no-window")`);
    const child = await softWait(async () => (await byUrl(b, /popups-oauth\.html/)).length === 1, 10000, 'the OAuth child window page target');
    const ct = (await byUrl(b, /popups-oauth\.html/))[0];
    const tsO = await tabs(b);
    clause('oauth', 'the-popup-is-a-window-not-a-tab', child && tsO.length === 1 && tsO[0].label === TITLES.opener, `tabs ${JSON.stringify(tsO.map((t) => t.label))}; popup target ${ct?.url}`);
    const sees = ct ? await evalIn(ct, `document.getElementById('opener').textContent`).catch(() => 'n/a') : 'n/a';
    clause('oauth', 'the-popup-kept-its-window-opener', sees === 'opener: yes', `child page says ${JSON.stringify(sees)}`);
    await sleep(900);
    const wins = swayWindows(b.app.pid);
    const cw = wins.find((w) => isOauthWin(w));
    clause('oauth', 'child-window-title-shows-the-origin-first', !!cw && cw.name === `${new URL(URLS.opener).origin} — ${TITLES.oauth}`, `compositor name of the child window: ${JSON.stringify(cw?.name)} (want "<origin> — <page title>")`);
    clause('oauth', 'a-real-native-window-appears-in-the-compositor', wins.length === baseWins.length + 1 && !!cw, `app windows in my sway: ${JSON.stringify(wins.map((w) => [w.name, w.floating, w.rect && `${w.rect.width}x${w.rect.height}`]))}`);
    const mainW = wins.find((w) => !isOauthWin(w));
    clause('oauth', 'the-child-window-floats-instead-of-tiling-the-app', !!cw && cw.floating === true && mainW?.rect?.width === baseMainWidth, `child floating=${cw?.floating} ${cw && `${cw.rect.width}x${cw.rect.height}`}; main window width ${baseMainWidth} -> ${mainW?.rect?.width} (sway tiles a resizable child beside the app and halves it)`);
    if (cw) {
      const img = grim('oauth-child-window.png');
      const c = blockColor(img, Math.round(cw.rect.x + cw.rect.width / 2), Math.round(cw.rect.y + cw.rect.height / 2));
      clause('oauth', 'the-child-window-paints-the-idp-page', near(c, [0x7a, 0x2c, 0xa0], 16), `pixel at the window's centre ${hex(c)} (the OAuth fixture's purple), rect ${JSON.stringify(cw.rect)}`);
    } else clause('oauth', 'the-child-window-paints-the-idp-page', false, 'no child window to look at');
    // a cookie the POPUP set must be in the OPENER's jar: same workspace session (a popup in another partition would not share it)
    const sidLine = (await val(() => evalIn(opener, `document.getElementById('sid').textContent`), '')) ?? '';
    const sentSid = /sent (hold-[0-9a-f]+) \|/.exec(sidLine)?.[1];
    const shared = !!sentSid && sidLine.includes(`popup_sid=${sentSid}`);
    const sharedDetail = `opener's #sid line: ${JSON.stringify(sidLine)}`;
    clause('oauth', 'the-popup-shares-the-workspace-session', shared, sharedDetail);
    // the IdP page closes itself: the opener sees it
    if (ct) await evalIn(ct, 'window.close()').catch(() => {});
    const closed = await softWait(async () => (await evalIn(opener, `document.getElementById('closed').textContent`)) === 'popup-closed' && swayWindows(b.app.pid).length === baseWins.length, 10000, 'the popup to close and the opener to notice');
    clause('oauth', 'popup-closes-and-the-opener-sees-it', closed && (await byUrl(b, /popups-oauth\.html/)).length === 0, `#closed = ${JSON.stringify(await val(() => evalIn(opener, `document.getElementById('closed').textContent`)))}; child targets ${(await byUrl(b, /popups-oauth\.html/)).length}; app windows ${JSON.stringify(winNames(b))}`);
    // the full unattended flow: the popup posts back and closes ITSELF
    await val(() => evalIn(opener, `document.getElementById('status').textContent = 'idle'; document.getElementById('closed').textContent = ''`));
    await clickIn(opener, '#signin');
    const full = await softWait(async () => (await evalIn(opener, `document.getElementById('status').textContent + '|' + document.getElementById('closed').textContent`)) === 'signed-in tok-auto|popup-closed', 15000, 'the unattended OAuth flow (post back + self-close)');
    clause('oauth', 'unattended-oauth-flow-posts-back-and-closes-itself', full && swayWindows(b.app.pid).length === baseWins.length, `${await val(() => evalIn(opener, `document.getElementById('status').textContent + '|' + document.getElementById('closed').textContent`))}; app windows ${JSON.stringify(winNames(b))}`);
  });

  // ────────────────────────────── xsite: the same flow with a CROSS-SITE IdP ──────────────────────────────
  if (ARMS.has('xsite')) await runArm('xsite', async () => {
    // a CROSS-SITE IdP (another host name = another site, another renderer process), the shape real OAuth has: the token still reaches window.opener
    opener = await gotoOpener(b);
    await clickIn(opener, '#signin-x');
    const cross = await softWait(async () => (await evalIn(opener, `document.getElementById('status').textContent + '|' + document.getElementById('closed').textContent`)) === 'signed-in tok-cross|popup-closed', 15000, 'the cross-site OAuth flow');
    const orig = await val(() => evalIn(opener, `document.getElementById('origin').textContent`), '');
    clause('xsite', 'cross-site-oauth-flow-completes-through-window-opener', cross && /from http:\/\/localhost:\d+$/.test(orig) && swayWindows(b.app.pid).length === baseWins.length, `status|closed = ${await val(() => evalIn(opener, `document.getElementById('status').textContent + '|' + document.getElementById('closed').textContent`))}; message origin ${JSON.stringify(orig)} (the opener is on 127.0.0.1); app windows ${JSON.stringify(winNames(b))}`);
  });

  // ────────────────────────────── hostile: a hostile `features` string cannot shape the child window (review F1) ──────────────────────────────
  if (ARMS.has('hostile')) await runArm('hostile', async () => {
    await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
    await typeUrl(b, `${BASE}/popups-hostile.html`);
    await waitFor(async () => (await tabs(b))[0]?.label === 'Popups fixture hostile', 20000, 'tab 1 to load the hostile fixture');
    const page = await pageOf(b, /popups-hostile\.html/);
    const mainBefore = swayWindows(b.app.pid).find((w) => !isOauthWin(w));
    await clickIn(page, '#go');
    const up = await softWait(async () => swayWindows(b.app.pid).some((w) => isOauthWin(w)), 10000, 'the hostile popup window');
    await sleep(1000);
    const wins = swayWindows(b.app.pid);
    const hw = wins.find((w) => isOauthWin(w));
    const out = await val(() => evalIn(page, `document.getElementById('out').textContent`), '<page gone>');
    const MAXW = Math.floor(1500 * 0.9), MAXH = Math.floor(950 * 0.9);
    const DECO = 16; // sway's border/title around the content (a 480x520 popup reads 484x522 in the tree); a leak is 4000x3000 or at least the 1500x950 output
    clause('hostile', 'hostile-popup-opens-as-a-bounded-window', up && out === 'opened' && !!hw && hw.rect.width <= MAXW + DECO && hw.rect.height <= MAXH + DECO, `page says ${JSON.stringify(out)}; child window ${hw ? `${hw.rect.width}x${hw.rect.height}` : 'none'} (asked 4000x3000; the cap is ${MAXW}x${MAXH} = 90% of the 1500x950 app window, + up to ${DECO}px of sway decoration)`);
    clause('hostile', 'hostile-popup-is-not-fullscreen-and-floats-over-the-app', !!hw && hw.fullscreen === 0 && hw.floating === true, `fullscreen_mode=${hw?.fullscreen} floating=${hw?.floating} (the features string said fullscreen,kiosk)`);
    clause('hostile', 'hostile-popup-does-not-resize-or-tile-the-app-window', !!hw && wins.find((w) => !isOauthWin(w))?.rect.width === mainBefore?.rect.width, `main window width ${mainBefore?.rect.width} -> ${wins.find((w) => !isOauthWin(w))?.rect.width}`);
    clause('hostile', 'hostile-popup-title-shows-the-origin', !!hw && hw.name === `${new URL(BASE).origin} — ${TITLES.oauth}`, `compositor name ${JSON.stringify(hw?.name)}`);
    clause('hostile', 'app-still-answers-while-the-hostile-popup-is-up', (await b.cdp.eval('1 + 1')) === 2 && (await tabs(b)).length === 1, 'renderer alive, one tab (the popup is not a tab)');
    saveShot('hostile-renderer.png', await b.cdp.shot());
    if (hw) grim('hostile-compositor.png');
    // the page can still close its own popup (a closable=no feature must not take that away)
    for (const t of await byUrl(b, /popups-oauth\.html/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await softWait(async () => swayWindows(b.app.pid).length === baseWins.length, 8000, 'the hostile popup to close');
    clause('hostile', 'hostile-popup-closes-when-the-page-closes-it', swayWindows(b.app.pid).length === baseWins.length, `app windows ${JSON.stringify(winNames(b))}`);
    // a `webContents` feature (Electron would hand our factory a string for the real guest) is refused: no window, no leak
    const logBefore = refusals(world, 'unsafe-features');
    await clickIn(page, '#goweb');
    await sleep(1200);
    clause('hostile', 'webcontents-feature-is-refused-without-a-window', (await val(() => evalIn(page, `document.getElementById('out').textContent`))) === 'no-window' && swayWindows(b.app.pid).length === baseWins.length && refusals(world, 'unsafe-features') - logBefore === 1 && (await pageTargets(b)).length === 1, `page says ${JSON.stringify(await val(() => evalIn(page, `document.getElementById('out').textContent`)))}; app windows ${JSON.stringify(winNames(b))}; page targets ${(await pageTargets(b)).length}; "(unsafe-features)" +${refusals(world, 'unsafe-features') - logBefore}`);
  });

  // ────────────────────────────── storm: page-initiated popups -> budget + cap, nothing leaked ──────────────────────────────
  const STORM_PHASES = ['s1', 's2', 's2b', 's2c', 's3', 's4', 'churn'];
  const ph = (n) => ARMS.has('storm') || ARMS.has(n);
  if (['storm', ...STORM_PHASES].some((a) => ARMS.has(a))) await runArm('storm', async () => {
    const stormTo = async (q, n = 3) => {
      await rateRoom(n); // keep this phase inside the per-minute rate cap (the rig's own earlier opens count against it)
      await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
      await typeUrl(b, URLS.storm(q));
      await waitFor(async () => (await tabs(b))[0]?.label === TITLES.storm, 20000, 'tab 1 to load the storm fixture');
      return pageOf(b, /popups-storm\.html/);
    };
    let page, ts;
    // (1) 40 unnamed popups from a script, no click: the budget (3) binds
    if (ph('s1')) {
    page = await stormTo('?auto=40&kind=tab');
    await softWait(async () => (await evalIn(page, `document.getElementById('calls').textContent`)) === 'calls 40', 15000, 'the page to fire 40 window.open calls');
    await sleep(1500);
    ts = await tabs(b);
    clause('storm', 'ctl/the-page-really-fired-40-popups', (await val(() => evalIn(page, `document.getElementById('calls').textContent`))) === 'calls 40', `${await val(() => evalIn(page, `document.getElementById('calls').textContent`), '<the storm page is gone>')}`);
    clause('storm', 'script-storm-capped-by-the-budget', ts.length === 4, `tabs after 40 window.open without a click: ${ts.length} (1 + the budget of 3)`);
    clause('storm', 'script-storm-never-steals-the-active-tab', ts[0]?.active === true && ts.filter((t) => t.active).length === 1, `active = ${JSON.stringify(ts.map((t) => [t.id, t.active]))}`);
    clause('storm', 'script-storm-leaks-no-view', (await pageTargets(b)).length === ts.length, `page targets ${(await pageTargets(b)).length} for ${ts.length} tabs`);
    clause('storm', 'refusals-are-logged-with-their-reason', refusals(world, 'budget') >= 30, `${refusals(world, 'budget')} "popup refused (budget)" lines in ${world.logFile}`);
    noteOpens(3);
    }
    // (2) mixed tabs + native windows: the budget counts both
    if (ph('s2')) {
    page = await stormTo('?auto=40&kind=mixed');
    await softWait(async () => (await evalIn(page, `document.getElementById('calls').textContent`)) === 'calls 40', 15000, 'the mixed storm to fire');
    await sleep(2000);
    ts = await tabs(b);
    const wns = swayWindows(b.app.pid).length - baseWins.length;
    const handles = Number((await evalIn(page, `document.getElementById('handles').textContent`)).split(' ')[1]);
    clause('storm', 'mixed-storm-budget-counts-tabs-and-windows-together', (ts.length - 1) + wns === 3, `new tabs ${ts.length - 1} + new native windows ${wns} = ${(ts.length - 1) + wns} (budget 3)`);
    clause('storm', 'mixed-storm-window-handles-match-the-windows', handles === wns, `window.open returned a handle ${handles}x; native windows ${wns}`);
    clause('storm', 'mixed-storm-leaks-no-view-or-window', (await pageTargets(b)).length === ts.length + wns, `page targets ${(await pageTargets(b)).length} = ${ts.length} tabs + ${wns} windows`);
    noteOpens(3);
    }
    // (2b) 40 NAMED popups (native windows only): the budget counts windows alone, and every handle matches a real window
    if (ph('s2b')) {
    page = await stormTo('?auto=40&kind=named');
    await softWait(async () => (await val(() => evalIn(page, `document.getElementById('calls').textContent`))) === 'calls 40', 15000, 'the named storm to fire');
    await sleep(2000);
    const nTabs = (await tabs(b)).length, nWins = swayWindows(b.app.pid).length - baseWins.length;
    const nHandles = Number(((await val(() => evalIn(page, `document.getElementById('handles').textContent`), 'handles -1')) ?? 'handles -1').split(' ')[1]);
    clause('storm', 'named-storm-opens-exactly-the-budget-of-windows', nTabs === 1 && nWins === 3 && nHandles === 3, `tabs ${nTabs}; new native windows ${nWins}; window.open handles ${nHandles} (budget 3; 40 calls)`);
    clause('storm', 'named-storm-leaks-no-view-or-window', (await pageTargets(b)).length === nTabs + nWins, `page targets ${(await pageTargets(b)).length} = ${nTabs} tab + ${nWins} windows`);
    noteOpens(3);
    }
    // (2c) a click on page A that NAVIGATES to the storm page gives the new page NO gesture: all 5 popups are page-initiated (budget 3), none shown
    if (ph('s2c')) {
    await rateRoom(3);
    await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
    opener = await gotoOpener(b);
    await clickIn(opener, '#to-storm');
    await softWait(async () => (await tabs(b))[0]?.label === TITLES.storm, 15000, 'the click to navigate tab 1 to the storm page');
    await sleep(2500);
    ts = await tabs(b);
    clause('storm', 'a-click-on-page-A-is-no-gesture-for-the-page-it-navigated-to', ts.length === 4 && ts[0].active && ts.filter((t) => t.active).length === 1, `after click -> navigate -> 5 on-load window.open: tabs ${ts.length} (1 + budget 3; a stale gesture would add a 4th popup and show it); active ${JSON.stringify(ts.map((t) => [t.id, t.active]))}`);
    noteOpens(3);
    }
    // (3) the CAP binds before the budget: 6 tabs open, storm in tab 1 -> only 2 more surfaces
    if (ph('s3')) {
    await rateRoom(2);
    page = await stormTo('?kind=tab', 0);
    await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
    for (let i = 0; i < 5; i++) { await clickSel(b, '.browser-tab-new'); await softWait(async () => (await tabs(b)).length === 2 + i, 10000, `blank tab ${2 + i}`); }
    await clickSel(b, '.browser-tab', 0); await sleep(400);
    const six = (await tabs(b)).length;
    page = await pageOf(b, /popups-storm\.html/);
    await evalIn(page, `storm(40, 'tab')`);
    await sleep(2000);
    ts = await tabs(b);
    clause('storm', 'ctl/six-tabs-before-the-capped-storm', six === 6, `tabs before ${six}`);
    clause('storm', 'storm-near-the-cap-stops-at-eight-tabs', ts.length === 8 && (await pageTargets(b)).length === 8, `tabs ${six} -> ${ts.length}; page targets ${(await pageTargets(b)).length} (the cap is 8, the budget alone would allow 9)`);
    clause('storm', 'cap-refusals-are-logged', refusals(world, 'cap') >= 1, `${refusals(world, 'cap')} "popup refused (cap)" lines`);
    noteOpens(2);
    }
    // (4) ONE click, 20 window.open: the click opens ONE popup (shown), the other 19 are page-initiated (budget)
    if (ph('s4')) {
    page = await stormTo('?kind=tab');
    await clickIn(page, '#go');
    await softWait(async () => (await tabs(b)).length >= 5, 15000, 'the click storm to open tabs');
    await sleep(1500);
    ts = await tabs(b);
    clause('storm', 'one-click-opens-one-popup-plus-the-budget', ts.length === 5, `tabs after ONE click firing 20 window.open: ${ts.length} (1 + 1 gesture + 3 budget)`);
    clause('storm', 'the-clicked-popup-is-shown-the-rest-stay-in-the-background', ts[1]?.active === true && ts.filter((t) => t.active).length === 1, `active = ${JSON.stringify(ts.map((t) => [t.id, t.active]))}`);
    saveShot('storm-click-renderer.png', await b.cdp.shot());
    noteOpens(3);
    }
    // (5) CHURN: popups that close themselves again never hold the budget, so only the per-minute RATE cap (6) can stop them (#396 review F4)
    if (ph('churn')) {
      for (const kind of ['named']) { // a TAB popup returns no handle to the page (we build the tab ourselves), so only windows can be closed by the page: the tab route's rate is pinned by the unit arms
        await rateRoom(6);
        const budgetBefore = refusals(world, 'budget'), rateBefore = refusals(world, 'rate');
        page = await stormTo(`?churn=12&kind=${kind}`, 6);
        await softWait(async () => (await val(() => evalIn(page, `document.getElementById('calls').textContent`))) === 'calls 12', 15000, `the ${kind} churn to fire 12 window.open calls`);
        await sleep(1200);
        const handlesN = Number(((await val(() => evalIn(page, `document.getElementById('handles').textContent`), 'handles -1')) ?? 'handles -1').split(' ')[1]);
        clause('storm', `churn-${kind}-opens-at-most-6-per-minute`, handlesN === 6, `12 open+close cycles without a click: window.open returned a handle ${handlesN}x (the rate cap is 6/min; the budget of 3 never binds because each popup closes at once)`);
        clause('storm', `churn-${kind}-refusals-are-rate-not-budget`, refusals(world, 'rate') - rateBefore === 6 && refusals(world, 'budget') === budgetBefore, `"popup refused (rate)" +${refusals(world, 'rate') - rateBefore}; "(budget)" +${refusals(world, 'budget') - budgetBefore}`);
        noteOpens(6);
      }
    }
    await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
  });

  // ────────────────────────────── ws: switching workspace takes the child window away, switching back restores it ──────────────────────────────
  if (ARMS.has('ws')) await runArm('ws', async () => {
    opener = await gotoOpener(b);
    await clickIn(opener, '#signin-hold');
    await softWait(async () => swayWindows(b.app.pid).some((w) => isOauthWin(w)), 10000, 'the child window');
    clause('ws', 'ctl/child-window-up-before-switching', swayWindows(b.app.pid).some((w) => isOauthWin(w)), `app windows ${JSON.stringify(winNames(b))}`);
    await selectWorkspace(b, 'e2e/bp396-2');
    const gone = await softWait(async () => !swayWindows(b.app.pid).some((w) => isOauthWin(w)), 8000, 'the child window to leave the compositor');
    clause('ws', 'switching-workspace-takes-the-child-window-away', gone, `app windows after switching to workspace 2: ${JSON.stringify(winNames(b))}`);
    await selectWorkspace(b, 'e2e/bp396-1');
    await openBrowserPane(b).catch(() => {});
    const back = await softWait(async () => swayWindows(b.app.pid).some((w) => isOauthWin(w)), 8000, 'the child window to come back');
    clause('ws', 'switching-back-restores-the-child-window', back, `app windows after switching back: ${JSON.stringify(winNames(b))}`);
    await closeAllPopupWindows(b);
  });

  // ────────────────────────────── cleanup: archiving the workspace leaves no popup window behind ──────────────────────────────
  if (ARMS.has('cleanup')) await runArm('cleanup', async () => {
    await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
    // closing the OPENER tab closes the child window it opened (a tab's popup must not outlive the tab)
    await clickSel(b, '.browser-tab-new');
    await softWait(async () => (await tabs(b)).length === 2, 10000, 'a second tab');
    await typeUrl(b, `${URLS.opener}?t=2`);
    await waitFor(async () => (await tabs(b))[1]?.label === TITLES.opener, 20000, 'tab 2 to load the opener fixture');
    const opener2 = await pageOf(b, /popups-opener\.html\?t=2/);
    await clickIn(opener2, '#signin-hold');
    const up = await softWait(async () => swayWindows(b.app.pid).some((w) => isOauthWin(w)), 10000, 'the child window of tab 2');
    clause('cleanup', 'ctl/tab-two-has-a-child-window-before-it-is-closed', up && (await tabs(b)).length === 2, `app windows ${JSON.stringify(winNames(b))}; tabs ${(await tabs(b)).length}`);
    await clickSel(b, '.browser-tab-close', 1);
    const gone = await softWait(async () => (await tabs(b)).length === 1 && swayWindows(b.app.pid).length === baseWins.length, 10000, 'the child window to follow its closed opener tab');
    clause('cleanup', 'closing-the-opener-tab-closes-its-child-window', gone, `after closing tab 2: tabs ${(await tabs(b)).length}; app windows ${JSON.stringify(winNames(b))} (baseline ${JSON.stringify(baseWins)})`);
    await rateRoom(3); // the storm below is page-initiated: stay inside the per-minute rate cap the earlier phases used up
    await typeUrl(b, URLS.storm('?auto=40&kind=mixed'));
    await waitFor(async () => (await tabs(b))[0]?.label === TITLES.storm, 20000, 'tab 1 on the storm fixture');
    await sleep(2500);
    noteOpens(3);
    const tsB = await tabs(b); const winsB = swayWindows(b.app.pid).length - baseWins.length; const tgB = (await pageTargets(b)).length;
    clause('cleanup', 'ctl/surfaces-exist-before-the-archive', tsB.length + winsB >= 3 && winsB >= 1 && tgB >= 3, `tabs ${tsB.length}, child windows ${winsB}, page targets ${tgB}`);
    await b.cdp.eval(`window.orchestra.archiveWorkspace(${JSON.stringify(world.ws.id)})`);
    const clean = await softWait(async () => (await pageTargets(b)).length === 0 && swayWindows(b.app.pid).length === baseWins.length, 15000, 'every tab view and child window to be gone');
    clause('cleanup', 'archive-leaves-no-tab-view-and-no-popup-window', clean, `after archiving ${world.ws.id}: page targets ${(await pageTargets(b)).length}, app windows ${JSON.stringify(winNames(b))} (baseline ${JSON.stringify(baseWins)})`);
    saveShot('cleanup-renderer.png', await b.cdp.shot());
  });
  await teardown(b, 'term'); b = null;
} catch (e) {
  clause('rig', 'rig/completed', false, `ABORTED: ${e.stack || e}`);
  if (b) { try { await teardown(b, 'term'); } catch {} }
} finally {
  try { siteProc?.kill(); } catch {}
}

const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-claude-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs, symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const red = results.filter((c) => !c.ok);
console.log(`\nVERDICT: ${red.length ? `RED: ${red.map((c) => `[${c.arm}] ${c.clause}`).join('; ')}` : `ALL GREEN: ${results.length} clauses`}`);
process.exit(red.length ? 1 : 0);
