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
// Usage (via scripts/e2e-browser-popups.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--arms blank,oauth,xsite,hostile,extproto,s1|s2|s2b|s2c|s3|s4|churn (storm phases),storm,ws,cleanup]
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
const ARMS = new Set();

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
  // An `xdg-open` that only RECORDS: Chromium/Electron launch external protocols through it (found on PATH, which starts with this dir) — nothing is ever really opened.
  const xdgLog = path.join(armDir, 'xdg-open.log');
  fs.writeFileSync(xdgLog, '');
  fs.writeFileSync(path.join(stubDir, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${xdgLog}'\nexit 0\n`, { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, ws2, stubDir, xdgLog, tabsFile: path.join(ohome, 'userData', 'orchestra', 'browser-tabs.json'), logFile: path.join(ohome, 'logs', 'orchestra.log') };
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
  for (const t of await byUrl(b, /popups-(oauth|blank|extproto)\.html/)) {
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

// ═════════════════════════════════════ seat 3 hostile-page drive for #396 (helpers above are copied from the member's rig; arms + pages + oracles are mine) ═════════════════════════════════════
// ── seat 3: REAL compositor pointer input (raw Wayland virtual-pointer helper, scripts/v3-vptr.py) — the rig's headless sway has no input device, `swaymsg seat cursor` reaches no client ──
function startVptr() {
  const o = JSON.parse(sh('swaymsg', ['-t', 'get_outputs']))[0];
  const p = spawn('python3', ['-I', path.join(path.dirname(fileURLToPath(import.meta.url)), 'v3-vptr.py')], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND, OUT_W: String(o.rect.width), OUT_H: String(o.rect.height) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = []; let acc = '';
  p.stdout.on('data', (d) => { acc += d; let i; while ((i = acc.indexOf('\n')) >= 0) { const line = acc.slice(0, i); acc = acc.slice(i + 1); (waiters.shift() ?? (() => {}))(line); } });
  p.on('exit', () => { while (waiters.length) waiters.shift()('err helper exited'); });
  const next = () => new Promise((res) => waiters.push(res));
  const ready = next();
  const cmd = (c) => { const w = next(); p.stdin.write(c + '\n'); return Promise.race([w, sleep(6000).then(() => 'err timeout')]); };
  return { ready, cmd, off: o.rect, p };
}
async function getVp() { if (!globalThis.__vp) { const v = startVptr(); const r = await v.ready; globalThis.__vp = v; globalThis.__vpReady = r; await sleep(900); } return globalThis.__vp; }
function mkCur(vp) { let pos = { x: 0, y: 0 }; return async (op, a, b) => { if (op === 'set') { pos = { x: a, y: b }; return vp.cmd(`move ${a - vp.off.x} ${b - vp.off.y}`); } if (op === 'move') { pos = { x: pos.x + a, y: pos.y + b }; return vp.cmd(`move ${pos.x - vp.off.x} ${pos.y - vp.off.y}`); } return vp.cmd(op === 'press' ? 'press' : 'release'); }; }
const J = (x) => JSON.stringify(x);
const info396 = (arm, d) => console.log(`  INFO  [${arm}] ${d}`);
const MY_ARMS = new Set(flag('--arms', 'oauthx,xdg,names,title,resize,storm').split(','));
const before = liveCanary();
// ── my own fixture site: two host names on one server (cross-site = 127.0.0.1 vs localhost), a hostile child, an IdP, redirectors ──
const http = await import('node:http');
const PAGES = {
  '/h-opener.html': () => `<!doctype html><title>H opener</title><body style="margin:0;background:#eee">
<button id="named" style="font-size:30px" onclick="window.open('/h-child.html?w=named','hnamed','width=400,height=300')">named popup</button>
<button id="shared" style="font-size:30px" onclick="window.open('/h-child.html?w=shared','shared','width=400,height=300')">shared name</button>
<button id="bigfeat" style="font-size:30px" onclick="window.open('/h-child.html?w=big','hbig','width=99999,height=99999,left=0,top=0,fullscreen=yes,alwaysOnTop=yes,frame=no,transparent=yes,kiosk=yes')">hostile features</button>
<button id="tinyfeat" style="font-size:30px" onclick="window.open('/h-child.html?w=tiny','htiny','width=10,height=10')">tiny</button>
<button id="idp" style="font-size:30px" onclick="window.open('http://localhost:'+location.port+'/h-idp.html?o='+encodeURIComponent(location.origin),'hidp','width=420,height=520')">sign in (cross-site)</button>
<button id="spoof" style="font-size:30px" onclick="window.open('/h-child.html?w=spoof&spoof=1','hspoof','width=400,height=300')">spoof title</button>
<a id="ssh" href="ssh://evil.example/x">ssh</a> <a id="zoom" href="zoommtg://zoom.us/join?confno=1">zoom</a> <a id="smb" href="smb://evil.example/share">smb</a>
<a id="vscode" href="vscode://file/etc/passwd">vscode</a> <a id="steam" href="steam://run/1">steam</a> <a id="slack" href="slack://open">slack</a> <a id="sms" href="sms:+123">sms</a> <a id="facetime" href="facetime:x@y.z">facetime</a>
<a id="mail" href="mailto:a@b.c">mail</a> <a id="tel" href="tel:+123">tel</a> <a id="blank" href="/h-child.html?w=blank" target="_blank">blank</a>
<button id="loc" onclick="location.href='ssh://evil.example/loc'">location=ssh</button>
<button id="frame" onclick="var f=document.createElement('iframe');f.src='zoommtg://zoom.us/frame';document.body.appendChild(f)">iframe=zoommtg</button>
<button id="form" onclick="document.getElementById('f').submit()">form ssh</button><form id="f" action="ssh://evil.example/form" method="get"></form>
<a id="redir" href="/h-redir?to=ssh://evil.example/redirected">302 to ssh</a>
<button id="armtimer" onclick="setTimeout(function(){location.href='mailto:timer@x.y';},300)">mailto by timer (the click only arms it)</button>
<script>if (location.search.includes('nogesture')) { setTimeout(function(){ location.href = 'mailto:auto-load@x.y'; }, 500); setTimeout(function(){ var a = document.createElement('a'); a.href = 'tel:+999'; document.body.appendChild(a); a.click(); }, 900); setTimeout(function(){ window.open('mailto:auto-open@x.y'); }, 1300); }</script>
<div id="status">idle</div><script>window.addEventListener('message', (e) => { document.getElementById('status').textContent = 'token:' + (e.data && e.data.token) + ' from ' + e.origin; });
if (location.search.includes('cycles')) { var cn = +(new URLSearchParams(location.search).get('n') || 20); window.__handles = 0; window.__refused = 0; setTimeout(function cycle(i) { i = typeof i === 'number' ? i : 0; if (i >= cn) { window.__fired = cn; return; } var w = window.open('/h-child.html?w=c' + i, 'churn' + i, 'width=300,height=200'); if (w) { window.__handles++; setTimeout(function () { try { w.close(); } catch (e) {} setTimeout(function () { cycle(i + 1); }, 250); }, 150); } else { window.__refused++; setTimeout(function () { cycle(i + 1); }, 40); } }, 400); }
if (location.search.includes('storm')) { var n = +(new URLSearchParams(location.search).get('n') || 40); var churn = false; setTimeout(function () { for (var i = 0; i < n; i++) { var w = window.open('/h-child.html?w=s' + i, location.search.includes('named') ? 'storm' + i : '_blank', location.search.includes('named') ? 'width=300,height=200' : ''); if (churn && w) setTimeout(function (w) { try { w.close(); } catch (e) {} }.bind(null, w), 50); } window.__fired = n; }, 400); }
if (location.search.includes('auto')) setTimeout(function () { window.open('/h-child.html?w=auto&loop=1', 'hauto', 'width=400,height=300'); }, 400);
</script>`,
  '/h-child.html': (q) => `<!doctype html><title>Child ${q.get('w') ?? ''}</title><body style="margin:0;background:#ffd"><h1>child ${q.get('w') ?? ''}</h1>
<button id="rz" onclick="window.__rz = 0; window.resizeTo(4000, 4000); window.moveTo(0, 0); window.resizeBy(2000, 2000); window.moveBy(-900, -900); var iv = setInterval(function () { window.resizeTo(4000, 4000); window.moveTo(0, 0); window.resizeBy(2000, 2000); window.moveBy(-900, -900); window.__rz++; }, 40); setTimeout(function () { clearInterval(iv); }, 4200);">resize-loop (needs a click)</button> <a id="ssh" href="ssh://evil.example/popup">ssh</a> <a id="zoom" href="zoommtg://zoom.us/popup">zoom</a> <a id="mail" href="mailto:p@q.r">mail</a> <button id="loc" onclick="location.href='ssh://evil.example/popuploc'">location=ssh</button> <a id="mailtel" href="tel:+9">tel</a>
<script>
if (new URLSearchParams(location.search).get('spoof')) { var t = ['https://accounts.google.com — Sign in', '\\u202eelgoog.moc\\u202c', 'Orchestra — Authorize', 'x'.repeat(5000)]; var i = 0; setInterval(function () { document.title = t[i++ % t.length]; }, 120); }
if (new URLSearchParams(location.search).get('loop')) { window.__loops = 0; setInterval(function () { window.resizeTo(4000, 4000); window.moveTo(0, 0); window.resizeBy(2000, 2000); window.moveBy(-900, -900); window.__loops++; }, 40); }
</script>`,
  '/h-idp.html': (q) => `<!doctype html><title>IdP login</title><body><h1>IdP</h1><script>setTimeout(function () { window.opener.postMessage({ token: 'T-' + Math.random().toString(36).slice(2, 8) }, decodeURIComponent(new URLSearchParams(location.search).get('o') || '*')); window.close(); }, 600);</script>`,
};
// ── seat 3, #396 F1 delta: pages for the "mailto:/tel: only on a user click" fix (gate of 15bfbfba) ──
function f1Page(q) {
  const v = q.get('v') ?? 'none';
  const click = q.get('click') === '1';
  const FIRE = {
    loc: "location.href = 'mailto:v-loc@x.y';",
    tel: "location.href = 'tel:+991';",
    aclick: "var a = document.createElement('a'); a.href = 'mailto:v-aclick@x.y'; document.body.appendChild(a); a.click();",
    dispatch: "var a = document.createElement('a'); a.href = 'tel:+992'; document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));",
    winopen: "window.open('mailto:v-winopen@x.y');",
    form: "var f = document.createElement('form'); f.action = 'mailto:v-form@x.y'; f.method = 'get'; document.body.appendChild(f); f.submit();",
    iframe: "var i = document.createElement('iframe'); i.src = 'mailto:v-iframe@x.y'; document.body.appendChild(i);",
    redir: "location.href = '/h-redir?to=' + encodeURIComponent('mailto:v-redir@x.y');",
    meta: "var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=mailto:v-meta@x.y'; document.head.appendChild(m);",
    none: '',
  }[v] ?? '';
  return `<!doctype html><title>H f1 ${v}${click ? ' click' : ''}</title><body style="margin:0;background:#def;font:20px sans-serif">
<button id="go" style="font-size:30px;width:100%;height:90px">go</button>
<button id="multi" style="font-size:24px" onclick="location.href='mailto:m1@x.y'; setTimeout(function(){location.href='mailto:m2@x.y'},120); setTimeout(function(){location.href='mailto:m3@x.y'},240);">three mailto navigations from ONE click</button>
<button id="sshmail" style="font-size:24px" onclick="location.href='ssh://evil.example/x'; setTimeout(function(){location.href='mailto:after-ssh@x.y'},150);">ssh then mailto from ONE click</button>
<a id="chain" href="/h-f1.html?v=loc" style="font-size:24px;display:block;padding:8px">click → next document that fires location=mailto at load</a>
<a id="kmail" href="mailto:kbd@x.y" style="font-size:24px;display:block;padding:8px">kbd mail</a>
<div id="status">f1</div>
<script>
function fire() { ${FIRE} }
${click ? "document.getElementById('go').addEventListener('click', fire);" : 'setTimeout(fire, 500);'}
</script>`;
}
PAGES['/h-f1.html'] = (q) => f1Page(q);
PAGES['/h-big.html'] = (q) => `<!doctype html><title>H big ${q.get('k') ?? ''}</title><body style="margin:0;background:#fd8">
<a id="big" href="${{ mailto: 'mailto:real@x.y', tel: 'tel:+993', ssh: 'ssh://evil.example/real' }[q.get('k') ?? 'mailto'] ?? 'mailto:real@x.y'}" style="position:fixed;left:0;top:0;right:0;bottom:0;display:block"></a>
<script>window.__ev = []; ['pointerdown','pointerup','mousedown','mouseup','click','contextmenu','auxclick'].forEach(function (t) { document.addEventListener(t, function (e) { window.__ev.push(t + ':' + e.isTrusted + ':' + e.button + '@' + e.clientX + ',' + e.clientY); }, true); }); window.addEventListener('blur', function () { window.__ev.push('blur'); }); window.addEventListener('focus', function () { window.__ev.push('focus'); });
window.__mm = null; window.__md = null; document.addEventListener('mousemove', function (e) { window.__mm = { x: e.clientX, y: e.clientY }; }, true); document.addEventListener('mousedown', function (e) { window.__md = { trusted: e.isTrusted, x: e.clientX, y: e.clientY }; }, true);</script>`;

PAGES['/h-f1-inner.html'] = () => `<!doctype html><title>H f1 inner</title><body style="margin:0;background:#cfc"><a id="innermail" href="mailto:inner@x.y" style="position:fixed;left:0;top:0;right:50%;bottom:0;display:block;font:20px sans-serif">mailto link INSIDE the iframe</a><button id="innerwo" style="position:fixed;left:50%;top:0;right:0;bottom:0;font:20px sans-serif" onclick="window.open('mailto:innerwo@x.y')">window.open(mailto) INSIDE the iframe</button>`;
PAGES['/h-f1-frame.html'] = (q) => `<!doctype html><title>H f1 frame ${q.get('h') ?? 'same'}</title><body style="margin:0;background:#eee"><iframe id="fr" src="${q.get('h') === 'cross' ? 'http://localhost:' + HP : ''}/h-f1-inner.html" style="position:fixed;left:0;top:0;width:100%;height:100%;border:0"></iframe>`;
const hostSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = PAGES[u.pathname];
  if (u.pathname === '/h-redir') { res.writeHead(302, { location: u.searchParams.get('to') }); return res.end(); }
  if (p) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(p(u.searchParams)); }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => hostSrv.listen(0, '127.0.0.1', r));
const HP = hostSrv.address().port; const HBASE = `http://127.0.0.1:${HP}`;
console.log(`[rig] my hostile site ${HBASE} (+ http://localhost:${HP} as the other site) arms ${[...MY_ARMS].join(',')} out ${OUT}`);
const world = seedWorld(path.join(RIG_DIR, 'world'));
let b = null;
const xdgLines = () => fs.readFileSync(world.xdgLog, 'utf8').split('\n').filter(Boolean);
const xdgCount = () => xdgLines().length;
async function runArm(arm, fn) { try { await fn(); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } }
const T = (re) => pageTargets(b).then((l) => l.find((t) => re.test(t.url)));
const TS = (re) => pageTargets(b).then((l) => l.filter((t) => re.test(t.url)));
const refusalsOf = (reason) => refusals(world, reason);
async function loadOpener(qs = '') {
  // closes every popup window, leaves ONE tab on my opener page
  for (const t of await TS(/h-(child|idp)/)) { const tabUrls = new Set((await tabs(b)).map((x) => x.tip)); if (!tabUrls.has(t.url)) { try { await evalIn(t, 'window.close()'); } catch {} } }
  await sleep(500); await closeExtraTabs(b, 1);
  await typeUrl(b, `${HBASE}/h-opener.html${qs}`);
  await waitFor(async () => (await tabs(b))[0]?.label === 'H opener', 20000, 'tab 1 to load my opener');
  await sleep(500);
  return T(/h-opener\.html/);
}
const childWins = () => swayWindows(b.app.pid).filter((w) => typeof w.name === 'string' && /^(https?:\/\/|about:blank|unknown origin)/.test(w.name) && w.rect); // our popup titles lead with the origin; size is NOT a filter (a window that outgrew the app must still be seen)
const mainRect = () => swayWindows(b.app.pid).find((w) => /^Orchestra$/i.test(w.name))?.rect ?? swayWindows(b.app.pid)[0]?.rect;
try {
  b = await boot(world, 'boot1');
  await openBrowserPane(b);
  const base = await loadOpener();
  clause('rig', 'ctl/my-opener-page-is-up', !!base && (await evalIn(base, `document.getElementById('status').textContent`)) === 'idle', `target ${base?.url}`);
  await evalIn(base, `document.addEventListener('click', (e) => { window.__clicks = (window.__clicks || 0) + 1; window.__trusted = e.isTrusted; }, true)`);
  await clickIn(base, '#status');
  clause('rig', 'ctl/cdp-click-is-trusted', (await evalIn(base, `[window.__clicks, window.__trusted].join()`)) === '1,true', 'my pages');
  // positive control of the xdg-open SPY: a mailto click IS recorded (and tel)
  { const n0 = xdgCount(); await clickIn(base, '#mail'); await softWait(async () => xdgCount() > n0, 6000, 'xdg-open to record the mailto'); const l = xdgLines().slice(n0);
    clause('rig', 'ctl/the-xdg-open-spy-records-a-clicked-mailto', l.some((x) => x.startsWith('mailto:')), `recorded ${J(l)}`);
    const n1 = xdgCount(); await clickIn(base, '#tel'); await softWait(async () => xdgCount() > n1, 6000, 'xdg-open to record the tel'); clause('rig', 'ctl/the-xdg-open-spy-records-a-clicked-tel', xdgLines().slice(n1).some((x) => x.startsWith('tel:')), `recorded ${J(xdgLines().slice(n1))}`); }

  // ─────────── oauthx: a cross-site IdP popup completes, its window closes, and the title is origin-first ───────────
  if (MY_ARMS.has('oauthx')) await runArm('oauthx', async () => {
    const op = await loadOpener();
    await clickIn(op, '#idp');
    const up = await softWait(async () => childWins().length >= 1, 10000, 'the IdP child window');
    const names = childWins().map((w) => w.name);
    const done = await softWait(async () => /^token:T-/.test((await val(() => evalIn(op, `document.getElementById('status').textContent`), '')) || ''), 12000, 'the token in the opener');
    const status = await val(() => evalIn(op, `document.getElementById('status').textContent`), '');
    await sleep(800);
    clause('oauthx', 'the-cross-site-popup-is-a-native-window-and-its-title-leads-with-its-origin', up && names.some((n) => /^http:\/\/localhost:\d+/.test(n)), `child window names ${J(names)}`);
    clause('oauthx', 'the-token-reaches-window.opener-with-the-IdP-origin', done && new RegExp(`from http://localhost:${HP}$`).test(status), `opener #status = ${J(status)}`);
    clause('oauthx', 'the-popup-closes-itself-and-leaves-no-window', childWins().length === 0, `windows after: ${J(childWins().map((w) => w.name))}`);
  });

  // ─────────── xdg: no OS hand-off for anything but a clicked mailto/tel — in a TAB and in a POPUP, by every navigation vector ───────────
  if (MY_ARMS.has('xdg')) await runArm('xdg', async () => {
    const schemes = ['ssh', 'zoom', 'smb', 'vscode', 'steam', 'slack', 'sms', 'facetime'];
    const op = await loadOpener();
    const n0 = xdgCount();
    for (const id of schemes) { await clickIn(op, `#${id}`); await sleep(400); }
    for (const id of ['loc', 'frame', 'form', 'redir']) { await clickIn(op, `#${id}`); await sleep(700); if (id !== 'frame') { await softWait(async () => (await tabs(b))[0]?.label === 'H opener', 5000, 'back to the opener'); } }
    await sleep(1500);
    clause('xdg', 'tab: 8 scheme links + location + iframe + form + 302 reach no xdg-open', xdgCount() === n0, `xdg-open log grew by ${xdgCount() - n0}: ${J(xdgLines().slice(n0))}`);
    // the same from a POPUP window
    const op2 = await loadOpener();
    await clickIn(op2, '#named'); await softWait(async () => (await T(/h-child\.html\?w=named/)), 10000, 'the named child page');
    const child = await T(/h-child\.html\?w=named/);
    const n1 = xdgCount();
    if (child) { for (const id of ['ssh', 'zoom', 'loc']) { await clickIn(child, `#${id}`); await sleep(700); } }
    await sleep(1200);
    clause('xdg', 'popup: ssh / zoommtg / location=ssh clicks reach no xdg-open', !!child && xdgCount() === n1, `child ${!!child}; xdg-open log grew by ${xdgCount() - n1}: ${J(xdgLines().slice(n1))}`);
    // positive controls in the same two surfaces
    const n2 = xdgCount(); await clickIn(op2, '#mail'); await softWait(async () => xdgCount() > n2, 6000, 'mailto from the tab');
    clause('xdg', 'ctl/tab: mailto IS recorded', xdgLines().slice(n2).some((x) => x.startsWith('mailto:')), J(xdgLines().slice(n2)));
    const n3 = xdgCount(); if (child) { await clickIn(child, '#mail'); await softWait(async () => xdgCount() > n3, 6000, 'mailto from the popup'); }
    clause('xdg', 'ctl/popup: mailto IS recorded', xdgLines().slice(n3).some((x) => x.startsWith('mailto:')), J(xdgLines().slice(n3)));
    // a page that tries mailto:/tel: WITHOUT a user click (load-time navigation, a programmatic a.click(), window.open) — the ticket says only a user's own click may start an OS hand-off
    { const n4 = xdgCount(); const opN = await loadOpener('?nogesture=1'); await sleep(3500);
      const got = xdgLines().slice(n4);
      clause('xdg', 'no-click-mailto-tel-by-load-time-navigation-a.click()-or-window.open-reach-no-xdg-open', got.length === 0, `xdg-open log grew by ${got.length}: ${J(got)} (location.href=mailto at load, programmatic tel: a.click(), window.open(mailto:) — none had a user click)`);
      const n5 = xdgCount(); await clickIn(opN, '#armtimer'); await sleep(2500);
      const got2 = xdgLines().slice(n5);
      info396('xdg', `mailto: by a timer 300 ms after a click (gesture window 5 s): xdg-open recorded ${J(got2)} — an ordinary browser also honours a navigation within the activation window`); }
    const lg = logLines(world).filter((l) => /external protocol refused/.test(l));
    clause('xdg', 'refusals-are-logged-with-the-scheme-only', lg.length >= 5 && lg.every((l) => !/evil\.example|confno|etc\/passwd/.test(l)), `${lg.length} refusal lines; sample ${J(lg.slice(-2).map((l) => l.slice(-60)))}`);
  });

  // ─────────── f1: #396 F1 FIX (gate of 15bfbfba) — mailto:/tel: reach the OS only on a user gesture of the REQUESTING contents ───────────
  if (MY_ARMS.has('f1')) await runArm('f1', async () => {
    let nonce = 0;
    const openF1 = async (qs, label) => {
      await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
      const nn = `${Date.now().toString(36)}${++nonce}`;
      await typeUrl(b, `${HBASE}/h-f1.html${qs}${qs.includes('?') ? '&' : '?'}n=${nn}`);
      await waitFor(async () => (await tabs(b))[0]?.label === label && !!(await T(new RegExp(`h-f1\\.html\\?.*n=${nn}`))), 20000, `tab 1 to load ${label} (n=${nn})`);
      await sleep(400);
      return T(new RegExp(`h-f1\\.html\\?.*n=${nn}`));
    };
    const vectors = ['loc', 'tel', 'aclick', 'dispatch', 'winopen', 'form', 'iframe', 'redir', 'meta'];
    const ctlOK = {};
    for (const v of vectors) {
      // (1) WITH a click: the vector must launch exactly the licensed hand-off (the instrument can SEE this vector)
      const pc = await openF1(`?v=${v}&click=1`, `H f1 ${v} click`);
      const nc = xdgCount(); await clickIn(pc, '#go'); await softWait(async () => xdgCount() > nc, 5000, `${v}: xdg-open after the click`); await sleep(600);
      const lc = xdgLines().slice(nc); ctlOK[v] = lc.length >= 1;
      clause('f1', `ctl/${v}: WITH a click it launches (the vector and the spy work)`, lc.length === 1, `xdg-open after one click: ${J(lc)}`);
      // (2) the same vector fired from a timer, NO click at all: nothing may launch
      const n0 = xdgCount(); await openF1(`?v=${v}`, `H f1 ${v}`); await sleep(3500);
      const l0 = xdgLines().slice(n0);
      clause('f1', `${v}: no click → nothing reaches xdg-open`, l0.length === 0 && ctlOK[v], `xdg-open log grew by ${l0.length}: ${J(l0)}${ctlOK[v] ? '' : '  (UNINFORMATIVE: the licensed variant did not launch either)'}`);
    }
    // a click on a mailto link INSIDE an iframe (same-origin and cross-site/OOPIF): the user's own click must still launch — the gesture is tracked on the TOP contents
    const noClickRefusals = () => logLines(world).filter((l) => /external protocol refused \((mailto|tel): no click\)/.test(l)).length;
    const popRefusals = () => logLines(world).filter((l) => /popup refused/.test(l)).length;
    const frameGeom = {};
    for (const h of ['same', 'cross']) {
      await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
      await typeUrl(b, `${HBASE}/h-f1-frame.html?h=${h}&n=${Date.now().toString(36)}`);
      await waitFor(async () => (await tabs(b))[0]?.label === `H f1 frame ${h}`, 20000, `frame page ${h}`); await sleep(1500);
      const top = await T(/h-f1-frame\.html/);
      const r = await evalIn(top, `(() => { const r = document.getElementById('fr').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
      frameGeom[h] = r;
      const linkPt = { x: r.x + r.w * 0.25, y: r.y + r.h * 0.5 }, woPt = { x: r.x + r.w * 0.75, y: r.y + r.h * 0.5 };
      const clickAtTop = async (pt) => { const c = await Cdp.connect(top.webSocketDebuggerUrl); try { await c.click(pt.x, pt.y); } finally { c.close(); } };
      let n = xdgCount(), r0 = noClickRefusals();
      await clickAtTop(linkPt); await softWait(async () => xdgCount() > n, 6000, `iframe link click ${h}`); await sleep(500);
      let l = xdgLines().slice(n);
      clause('f1', `ctl/CDP-click-on-a-mailto-link-inside-a-${h}-origin-iframe-launches-once`, l.length === 1 && l[0].startsWith('mailto:inner@'), `xdg-open after ONE click in the ${h}-origin iframe: ${J(l)}; 'mailto: no click' refusals +${noClickRefusals() - r0}`);
      n = xdgCount(); r0 = noClickRefusals(); const p0 = popRefusals();
      await clickAtTop(woPt); await softWait(async () => xdgCount() > n, 6000, `iframe window.open click ${h}`); await sleep(500);
      l = xdgLines().slice(n);
      info396('f1', `CDP click on a window.open('mailto:') button inside the ${h}-origin iframe (the PRE-EXISTING popup path, same tracker): xdg-open ${J(l)}; popup refusals +${popRefusals() - p0}`);
    }
    // one input, one launch: a single click that navigates to mailto: three times launches ONCE
    { const p = await openF1('?v=none', 'H f1 none'); const n = xdgCount(); await clickIn(p, '#multi'); await softWait(async () => xdgCount() > n, 5000, 'multi'); await sleep(1500);
      const l = xdgLines().slice(n);
      clause('f1', 'one-click-three-mailto-navigations-launch-once', l.length === 1 && l[0].startsWith('mailto:m1'), `xdg-open after ONE click: ${J(l)}`); }
    // a refused scheme does not eat the click: ssh refused, the mailto of the same click (150 ms later) still launches
    { const p = await openF1('?v=none', 'H f1 none'); const n = xdgCount(); await clickIn(p, '#sshmail'); await softWait(async () => xdgCount() > n, 5000, 'sshmail'); await sleep(1000);
      const l = xdgLines().slice(n);
      clause('f1', 'ssh-then-mailto-from-one-click-ssh-refused-mailto-launches', l.length === 1 && l[0].startsWith('mailto:after-ssh'), `xdg-open after ONE click: ${J(l)}`); }
    // a click does not carry over a navigation: the NEXT document's load-time location=mailto has no gesture
    { const p = await openF1('?v=none', 'H f1 none'); const n = xdgCount(); await clickIn(p, '#chain');
      const nav = await softWait(async () => (await tabs(b))[0]?.label === 'H f1 loc', 15000, 'the chained document'); await sleep(3000);
      const l = xdgLines().slice(n);
      clause('f1', 'a-click-on-page-A-licenses-nothing-on-the-page-it-navigated-to', nav && l.length === 0, `navigated=${nav} (tab label ${J((await tabs(b))[0]?.label)}); xdg-open after click→navigate→load-time mailto: ${J(l)}`); }
    // keyboard activation: a focused mailto link + Enter (keyDown is an activating input)
    { const p = await openF1('?v=none', 'H f1 none'); await evalIn(p, `document.getElementById('kmail').focus(); document.activeElement.id`); const n = xdgCount();
      const c = await Cdp.connect(p.webSocketDebuggerUrl); try { await c.key('Enter', 'Enter', 13); } finally { c.close(); }
      await softWait(async () => xdgCount() > n, 5000, 'kbd'); const l = xdgLines().slice(n);
      clause('f1', 'ctl/keyboard-Enter-on-a-focused-mailto-link-launches', l.length === 1 && l[0].startsWith('mailto:kbd'), `xdg-open after Enter: ${J(l)}`); }
    // the REQUESTING contents: a click in the popup window does not license the opener's later mailto (and the opener's own click does)
    { const op = await loadOpener(); await clickIn(op, '#named'); await softWait(async () => !!(await T(/h-child\.html\?w=named/)), 10000, 'the named child');
      const child = await T(/h-child\.html\?w=named/); const n = xdgCount();
      if (child) { await evalIn(op, `setTimeout(function () { location.href = 'mailto:xtab@x.y'; }, 900); 1`); await clickIn(child, 'h1'); }
      await sleep(2500); const l = xdgLines().slice(n);
      clause('f1', 'a-click-in-the-popup-window-does-not-license-the-opener', !!child && l.length === 0, `child ${!!child}; xdg-open: ${J(l)} (opener timer mailto at +900 ms, the click went to the popup contents)`);
      const n2 = xdgCount(); await evalIn(op, `setTimeout(function () { location.href = 'mailto:own@x.y'; }, 900); 1`); await clickIn(op, '#status'); await softWait(async () => xdgCount() > n2, 5000, 'own click timer'); const l2 = xdgLines().slice(n2);
      clause('f1', 'ctl/the-opener-own-click-licenses-its-own-mailto', l2.length === 1 && l2[0].startsWith('mailto:own'), `xdg-open: ${J(l2)}`);
      for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} } }
    // REAL pointer input from the compositor (sway seat), not CDP: a human's click on a mailto/tel link must still launch; an ssh link must not
    { const vp = await getVp(); const seatCmd = mkCur(vp); clause('f1', 'ctl/virtual-pointer-helper-is-up', /^ok ready/.test(globalThis.__vpReady), `helper: ${J(globalThis.__vpReady)}`);
      for (const kind of ['mailto', 'tel', 'ssh']) {
        await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
        await typeUrl(b, `${HBASE}/h-big.html?k=${kind}`);
        await waitFor(async () => (await tabs(b))[0]?.label === `H big ${kind}`, 20000, `H big ${kind}`); await sleep(500);
        const p = await T(/h-big\.html/); const mr = mainRect();
        let hit = null;
        for (const [fx, fy] of [[0.6, 0.5], [0.5, 0.5], [0.7, 0.6], [0.8, 0.4], [0.65, 0.75], [0.4, 0.6], [0.85, 0.8], [0.3, 0.5]]) {
          const X = Math.round(mr.x + mr.width * fx), Y = Math.round(mr.y + mr.height * fy);
          await evalIn(p, 'window.__mm = null; 1'); const rs = await seatCmd('set', X, Y); await sleep(250); const rm = await seatCmd('move', 3, 3); await sleep(350); if (!/^ok/.test(rs) || !/^ok/.test(rm)) console.log(`  (virtual pointer replies: ${J([rs, rm])})`);
          const mm = await evalIn(p, 'window.__mm'); if (mm) { hit = { X: X + 3, Y: Y + 3, mm }; break; }
        }
        if (hit && !globalThis.__ptrOff) globalThis.__ptrOff = { dx: hit.X - hit.mm.x, dy: hit.Y - hit.mm.y };
        if (!hit) { clause('f1', `ctl/real-pointer-${kind}: the compositor's pointer reaches the page`, false, `no mousemove reached the page from the virtual pointer (window rect ${J(mr)}) — the real-click control is UNVERIFIED, not a verdict`); continue; }
        const n = xdgCount();
        const rp = await seatCmd('press', 'button1'); await sleep(80); const rr = await seatCmd('release', 'button1');
        info396('f1', `real-pointer ${kind}: helper replies ${J([rp, rr])}; page events ${J(await evalIn(p, 'window.__ev'))}; document.hasFocus()=${await evalIn(p, 'document.hasFocus()')}`);
        await softWait(async () => xdgCount() > n, kind === 'ssh' ? 2500 : 6000, `real click on ${kind}`); await sleep(kind === 'ssh' ? 1500 : 500);
        const l = xdgLines().slice(n); const md = await evalIn(p, 'window.__md');
        clause('f1', `ctl/real-pointer-${kind}: a trusted mousedown reached the page`, !!md && md.trusted === true, `pointer at ${hit.X},${hit.Y} (client ${J(hit.mm)}); mousedown ${J(md)}`);
        if (kind === 'ssh') clause('f1', 'real-pointer-click-on-an-ssh-link-launches-nothing', l.length === 0, `xdg-open: ${J(l)}`);
        else clause('f1', `real-pointer-click-on-a-${kind}-link-launches-exactly-once`, l.length === 1 && l[0].startsWith(kind + ':'), `xdg-open after one compositor click: ${J(l)}`);
      } }
    // REAL compositor pointer on a mailto link INSIDE an iframe (the human's flow): offset calibrated on the top-level page above
    if (globalThis.__ptrOff) {
      const vp = await getVp();
      for (const h of ['same', 'cross']) {
        await closeAllPopupWindows(b); await closeExtraTabs(b, 1);
        await typeUrl(b, `${HBASE}/h-f1-frame.html?h=${h}&n=r${Date.now().toString(36)}`);
        await waitFor(async () => (await tabs(b))[0]?.label === `H f1 frame ${h}`, 20000, `frame page ${h}`); await sleep(1500);
        const top = await T(/h-f1-frame\.html/);
        const r = await evalIn(top, `(() => { const r = document.getElementById('fr').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
        const X = Math.round(r.x + r.w * 0.25 + globalThis.__ptrOff.dx), Y = Math.round(r.y + r.h * 0.5 + globalThis.__ptrOff.dy);
        const cur = mkCur(vp);
        await cur('set', X, Y); await sleep(300); await cur('move', 1, 1); await sleep(300);
        const n = xdgCount(); const r0 = noClickRefusals();
        await cur('press', 'button1'); await sleep(80); await cur('release', 'button1');
        await softWait(async () => xdgCount() > n, 6000, `real click in the ${h} iframe`); await sleep(600);
        const l = xdgLines().slice(n);
        clause('f1', `real-pointer-click-on-a-mailto-link-inside-a-${h}-origin-iframe-launches-once`, l.length === 1 && l[0].startsWith('mailto:inner@'), `compositor click at ${X},${Y}: xdg-open ${J(l)}; 'mailto: no click' refusals +${noClickRefusals() - r0}`);
      }
    }
    const rl = logLines(world).filter((l) => /external protocol refused/.test(l));
    clause('f1', 'no-click-refusals-are-logged-without-the-URL', rl.some((l) => /\(mailto: no click\)|\(tel: no click\)/.test(l)) && rl.every((l) => !/@x\.y|\+99/.test(l)), `${rl.length} refusal lines; sample ${J(rl.slice(-3).map((l) => l.slice(-50)))}`);
  });

  // ─────────── names: a live popup name is not retargetable from another tab or another workspace ───────────
  if (MY_ARMS.has('names')) await runArm('names', async () => {
    const op = await loadOpener('?id=ws1t1');
    await clickIn(op, '#shared');
    await softWait(async () => !!(await T(/h-child\.html\?w=shared/)), 10000, 'the shared window');
    const w1 = childWins().length; const first = await T(/h-child\.html\?w=shared/);
    // a second TAB of the same workspace asks for the same name
    await clickSel(b, '.browser-tab-new'); await softWait(async () => (await tabs(b)).length === 2, 8000, 'a 2nd tab');
    await typeUrl(b, `${HBASE}/h-opener.html?id=ws1t2`); await softWait(async () => (await tabs(b))[1]?.label === 'H opener', 15000, 'tab 2 on the opener');
    await sleep(500);
    const op2 = await T(/h-opener\.html\?id=ws1t2/);
    const r0 = refusalsOf('name-in-use');
    await clickIn(op2, '#shared'); await sleep(1500);
    clause('names', 'another-tab-asking-for-a-live-popup-name-is-refused', refusalsOf('name-in-use') === r0 + 1 && childWins().length === w1, `name-in-use refusals ${r0}→${refusalsOf('name-in-use')}; child windows ${w1}→${childWins().length}`);
    clause('names', 'and-the-first-popup-was-not-retargeted', !!first && (await val(() => evalIn(first, 'location.href'), '')).includes('w=shared'), `first popup url ${await val(() => evalIn(first, 'location.href'), '<gone>')}`);
    // ANOTHER WORKSPACE
    await selectWorkspace(b, 'e2e/bp396-2'); await openBrowserPane(b).catch(() => {});
    await softWait(async () => (await tabs(b)).length >= 1, 15000, 'workspace 2 strip');
    await typeUrl(b, `${HBASE}/h-opener.html?id=ws2t1`); await softWait(async () => (await tabs(b))[0]?.label === 'H opener', 20000, 'ws2 on the opener');
    await sleep(500);
    const opW2 = await T(/h-opener\.html\?id=ws2t1/);
    clause('names', 'ctl/the-ws2-opener-page-target-is-the-one-I-click-in', !!opW2 && /id=ws2t1/.test(opW2.url), `target ${opW2?.url}`);
    const r1 = refusalsOf('name-in-use');
    await clickIn(opW2, '#shared'); await sleep(1500);
    clause('names', 'another-WORKSPACE-asking-for-the-name-is-refused-too', refusalsOf('name-in-use') === r1 + 1, `name-in-use refusals ${r1}→${refusalsOf('name-in-use')}`);
    // control: once the holder is gone the name is free again
    await selectWorkspace(b, 'e2e/bp396-1');
    for (const t of await TS(/h-child\.html\?w=shared/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(900);
    await selectWorkspace(b, 'e2e/bp396-2'); await sleep(500);
    const r2 = refusalsOf('name-in-use'); await clickIn(opW2, '#shared'); await sleep(1500);
    clause('names', 'ctl/once-the-holder-is-gone-the-name-is-usable-again', refusalsOf('name-in-use') === r2 && !!(await T(/h-child\.html\?w=shared/)), `refusals ${r2}→${refusalsOf('name-in-use')}; popup exists ${!!(await T(/h-child\.html\?w=shared/))}`);
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await selectWorkspace(b, 'e2e/bp396-1'); await sleep(600);
  });

  // ─────────── title: a page cannot dress its native window up (origin first, bidi/control stripped, length bounded) ───────────
  if (MY_ARMS.has('title')) await runArm('title', async () => {
    const op = await loadOpener();
    await clickIn(op, '#spoof');
    await softWait(async () => childWins().length >= 1, 10000, 'the spoofing window');
    const seen = new Set();
    for (let i = 0; i < 24; i++) { for (const w of childWins()) seen.add(w.name); await sleep(110); }
    const names = [...seen];
    const origin = HBASE;
    clause('title', 'ctl/the-page-really-cycled-through-its-spoof-titles', names.length >= 3, `${names.length} distinct window names seen: ${J(names.map((n) => n.slice(0, 70)))}`);
    clause('title', 'every-window-title-starts-with-the-real-origin', names.length > 0 && names.every((n) => n.startsWith(origin)), `non-conforming: ${J(names.filter((n) => !n.startsWith(origin)).map((n) => n.slice(0, 60)))}`);
    clause('title', 'no-bidi-override-or-control-char-and-length-bounded', names.every((n) => !/[\u0000-\u001f‪-‮⁦-⁩]/.test(n) && n.length <= 140), `max length ${Math.max(...names.map((n) => n.length))}`);
    grim('title-spoof.png');
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
  });

  // ─────────── resize: a resizable:false popup keeps its bounds under resizeTo/moveTo/resizeBy/moveBy loops; features are clamped ───────────
  if (MY_ARMS.has('resize')) await runArm('resize', async () => {
    const main0 = mainRect();
    // (a) a PAGE-INITIATED popup (no click) whose own page loops resizeTo(4000,4000)/moveTo(0,0)/resizeBy/moveBy every 40 ms
    const op = await loadOpener('?auto=1');
    await softWait(async () => childWins().length >= 1, 12000, 'the page-initiated popup');
    await sleep(700);
    const child = await T(/h-child\.html\?w=auto/);
    const r0 = childWins()[0]?.rect; const o0 = child ? await val(() => evalIn(child, `[window.outerWidth, window.outerHeight, window.screenX, window.screenY, window.__loops].join()`), '') : '';
    await sleep(3000);
    const r1 = childWins()[0]?.rect; const o1 = child ? await val(() => evalIn(child, `[window.outerWidth, window.outerHeight, window.screenX, window.screenY, window.__loops].join()`), '') : '';
    const loops = +(o1.split(',')[4] ?? 0);
    clause('resize', 'ctl/the-popup-page-really-ran-its-resize-loop', loops >= 30, `page loop iterations ${loops}; compositor rect ${J(r0)} → ${J(r1)}`);
    clause('resize', 'a-resizable:false-popup-keeps-its-compositor-bounds-under-the-loop', !!r0 && !!r1 && r0.width === r1.width && r0.height === r1.height && r0.x === r1.x && r0.y === r1.y, `rect before ${J(r0)} after 3 s of resizeTo(4000)/moveTo(0)/resizeBy/moveBy: ${J(r1)}`);
    clause('resize', 'and-the-page-itself-sees-unchanged-outer-size-and-position', !!o0 && o0.split(',').slice(0, 4).join() === o1.split(',').slice(0, 4).join(), `outerW,outerH,screenX,screenY before ${o0.split(',').slice(0, 4)} after ${o1.split(',').slice(0, 4)}`);
    clause('resize', 'the-app-window-is-untouched', J(mainRect()) === J(main0), `main window rect ${J(main0)} → ${J(mainRect())}`);
    // (a2) a popup the HUMAN opened (trusted click → shown focused), then a TRUSTED CLICK inside it fires resizeTo/moveTo/resizeBy/moveBy (synchronously in the handler, then looping 4 s):
    //      Chromium applies these only with user activation and Electron applies them to the window unless vetoed — THIS is the arm the content-bounds-updated veto must hold
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(500);
    const opU = await loadOpener();
    await clickIn(opU, '#named'); await softWait(async () => childWins().length >= 1, 10000, 'the click-opened popup'); await sleep(900);
    const childU = await T(/h-child\.html\?w=named/);
    if (childU) {
      const g0 = childWins()[0]?.rect;
      await clickIn(childU, '#rz'); await sleep(1500);
      const g1 = childWins()[0]?.rect; const og1 = await val(() => evalIn(childU, `[window.outerWidth, window.outerHeight, window.screenX, window.screenY, window.__rz].join()`), '');
      await sleep(3000);
      const g2 = childWins()[0]?.rect; const rzN = +(og1.split(',')[4] ?? 0);
      clause('resize', 'ctl/the-click-armed-loop-really-ran', rzN >= 10, `iterations by +1.5 s: ${rzN}; rect ${J(g0)} → ${J(g1)} → ${J(g2)}`);
      clause('resize', 'a-click-armed-resizeTo/moveTo/resizeBy/moveBy-loop-cannot-move-or-resize-a-click-opened-popup', !!g0 && !!g1 && !!g2 && [g1, g2].every((g) => g.width === g0.width && g.height === g0.height && g.x === g0.x && g.y === g0.y), `rect before ${J(g0)}; during ${J(g1)}; after ${J(g2)}`);
      clause('resize', 'and-the-app-window-is-still-untouched-after-it', J(mainRect()) === J(main0), `main window rect ${J(main0)} → ${J(mainRect())}`);
    } else clause('resize', 'ctl/the-click-armed-loop-really-ran', false, 'no click-opened popup page target');
    // positive control of the bounds INSTRUMENT: change the window through the compositor and see the read move
    const nm = childWins()[0]?.name;
    if (nm) { sh('swaymsg', [`[title="${nm.replace(/"/g, '\\"')}"] resize set width ${r1.width + 120} px height ${r1.height + 80} px`]); await sleep(500); }
    const r2 = childWins()[0]?.rect;
    clause('resize', 'ctl/the-bounds-read-moves-when-the-window-really-changes', !!r2 && (r2.width !== r1.width || r2.height !== r1.height), `after a compositor resize ${J(r1)} → ${J(r2)} (floating non-resizable windows may refuse; INFO if equal)`);
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(600);
    // (b) features clamping on a USER click: huge + fullscreen/alwaysOnTop/frame=no/transparent/kiosk, and a 10x10 request
    const op2 = await loadOpener();
    await clickIn(op2, '#bigfeat'); await softWait(async () => childWins().length >= 1, 10000, 'the hostile-features window');
    await sleep(700);
    const big = childWins()[0]; const mr = mainRect();
    clause('resize', 'hostile-features-window-is-not-fullscreen-and-fits-inside-the-app-window', !!big && big.fullscreen !== 1 && big.rect.width <= mr.width && big.rect.height <= mr.height && big.rect.width <= Math.floor(VIEWPORT.w * 0.95), `window ${J(big)} app ${J(mr)}`);
    grim('hostile-features.png');
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(600);
    await clickIn(op2, '#tinyfeat'); await softWait(async () => childWins().length >= 1, 10000, 'the tiny window'); await sleep(500);
    const tiny = childWins()[0];
    clause('resize', 'a-10x10-request-becomes-a-usable-window-not-a-clickjacking-pixel', !!tiny && tiny.rect.width >= 200 && tiny.rect.height >= 150, `window ${J(tiny)}`);
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
  });

  // ─────────── storm: 40 popups (no click): budget/cap/rate; churn defeats the concurrent budget but not the rate cap ───────────
  if (MY_ARMS.has('storm')) await runArm('storm', async () => {
    await sleep(500);
    const r0 = { budget: refusalsOf('budget'), rate: refusalsOf('rate'), cap: refusalsOf('cap') };
    const op = await loadOpener('?storm=1&n=40&named=1');
    await softWait(async () => (await val(() => evalIn(op, 'window.__fired'), 0)) === 40, 15000, 'the page to fire 40 popups');
    await sleep(2500);
    const wins = childWins().length; const tb = (await tabs(b)).length; const tg = (await viewTargets(b)).length;
    clause('storm', 'ctl/the-page-really-fired-40', (await val(() => evalIn(op, 'window.__fired'), 0)) === 40, 'named window.open ×40 from a timer, no click');
    clause('storm', '40-named-popups-without-a-click-open-at-most-3', wins <= 3 && wins >= 1, `child windows ${wins}, tabs ${tb}, page targets ${tg}; refusals budget +${refusalsOf('budget') - r0.budget} rate +${refusalsOf('rate') - r0.rate} cap +${refusalsOf('cap') - r0.cap}`);
    clause('storm', 'the-rest-were-refused-and-counted', (refusalsOf('budget') - r0.budget) + (refusalsOf('rate') - r0.rate) + (refusalsOf('cap') - r0.cap) >= 30, `total refusals ${(refusalsOf('budget') - r0.budget) + (refusalsOf('rate') - r0.rate) + (refusalsOf('cap') - r0.cap)}`);
    await loadOpener(); await sleep(800);
    // churn: SEQUENTIAL open→close cycles (each popup is closed before the next opens), so the CONCURRENT budget never binds — only the per-minute rate cap can stop it.
    // The first storm above opened up to 3 page-initiated popups: let that minute roll off, so the cap starts from zero.
    console.log('  (waiting 62 s for the rate window of the first storm to roll off)'); await sleep(62000);
    const r1 = { rate: refusalsOf('rate'), budget: refusalsOf('budget') };
    const op2 = await loadOpener('?cycles=1&n=20');
    await softWait(async () => (await val(() => evalIn(op2, 'window.__fired'), 0)) === 20, 40000, 'the 20 open+close cycles');
    const handles = await val(() => evalIn(op2, 'window.__handles'), -1); const refusedByPage = await val(() => evalIn(op2, 'window.__refused'), -1);
    await sleep(800);
    clause('storm', 'ctl/the-page-ran-20-sequential-open-close-cycles', (await val(() => evalIn(op2, 'window.__fired'), 0)) === 20, `window.open returned a handle ${handles}× and null ${refusedByPage}×`);
    clause('storm', 'churn-(sequential-open+close)-opens-exactly-6-per-minute', handles === 6, `${handles} windows really opened of 20 attempts without a click (cap 6/min; the budget of 3 never binds: each window is closed before the next)`);
    clause('storm', 'the-rest-were-refused-by-RATE-not-budget', refusalsOf('rate') - r1.rate >= 13 && refusalsOf('budget') === r1.budget, `rate refusals +${refusalsOf('rate') - r1.rate}, budget refusals +${refusalsOf('budget') - r1.budget}`);
    clause('storm', 'no-window-left-behind', childWins().length === 0, `child windows after the churn: ${childWins().length}`);
    // cap 8 with USER clicks: 12 clicks on the named button (distinct names) → never more than 8 tabs+windows
    await loadOpener();
  });

  await teardown(b, 'term'); b = null;
} catch (e) {
  clause('rig', 'harness-completed', false, `ABORTED: ${String(e.stack || e).split('\n').slice(0, 4).join(' | ')}`);
  if (b) { try { await teardown(b, 'term'); } catch {} }
} finally {
  try { globalThis.__vp?.p.kill(); } catch {}
  try { hostSrv.close(); } catch {}
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
