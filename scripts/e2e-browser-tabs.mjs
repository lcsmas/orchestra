// #393 — browser tabs for the human, on the BUILT app (argv[2] = app dir) inside the contained rig's own headless sway.
//
// One scratch world (ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, one seeded workspace, pinned scratch account, stub `claude`),
// the shared fixture site (three pages, three distinct background colours) and THREE boots of the app on the same world:
//   boot 1  tabs     new tab x2 via the strip, URL bar follows the ACTIVE tab, switching paints the right native view (compositor pixels)
//           urlbar   PROBE of a KNOWN pre-existing defect (NOT fixed): 12x new blank tab -> type a URL -> does the bar SHOW it once loaded? It did not reproduce here (0/36); the verifier saw it 8/26
//           cap      fill to 8, the 9th is refused: notice shown, 8 tabs, 8 page targets (no leaked view)
//           paint    pane hidden / Help overlay up -> no fixture colour left over the app
//           reopen   a BACKGROUND tab's title event must not re-open a pane the user closed; an agent-style navigation still does (F2)
//           ws       a 2nd workspace: switching hides the 1st's views, tab sets are per workspace, switching back restores
//           restore  [A,B,C] with B active reaches disk; GRACEFUL quit (Browser.close)
//   boot 2  restore  first panel open after the restart: 3 tabs back, same URLs, same active tab, pixels = B; click C, SIGKILL
//   boot 3  restore  (debounced write, no quit hook): 3 tabs back, C active
//           last     closing every tab leaves ONE fresh blank tab (not zero, not a crash)
//   boot 4  down     a remembered tab whose server is DOWN at boot keeps its URL in browser-tabs.json after later snapshots (the real chrome-error page)
// Every clause prints PASS/FAIL with the value that proves it; controls (identity, scratch containment, own sway, target counts,
// pixel instrument) are separate clauses so a red clause can only be blamed on the behaviour. Mutant BUILDS that must redden each arm:
// scripts/e2e-browser-tabs-mutants.mjs.
//
// Usage (via scripts/e2e-browser-tabs.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--arms tabs,urlbar,cap,paint,reopen,ws,restore,last,down]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { handedEnvProblems, privateRuntimeDir } from './lib/rig-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const ARMS = new Set(flag('--arms', 'tabs,urlbar,cap,paint,reopen,ws,restore,last,down').split(','));

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-tabs.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
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
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
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
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } });
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
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'bt393-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# bt393 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bt393-1', wtDir], fakeHome);
  if (!git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome).includes(`worktree ${fs.realpathSync(wtDir)}`)) throw new Error('seed worktree not registered');
  const account = { id: 'rig-bt393', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const wtDir2 = path.join(armDir, 'wt', 'bt393-2');
  mustBeScratch('wt2', wtDir2);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bt393-2', wtDir2], fakeHome);
  const ws = { id: 'ws-bt393-1', name: 'bt393-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/bt393-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const ws2 = { ...ws, id: 'ws-bt393-2', name: 'bt393-2', worktreePath: wtDir2, branch: 'e2e/bt393-2', createdAt: Date.now() + 1 };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bt393-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws, ws2], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho BT393-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, ws2, stubDir, tabsFile: path.join(ohome, 'userData', 'orchestra', 'browser-tabs.json') };
}

function procsByHome(home) {
  // identity = this world's ORCHESTRA_HOME in the environ (keeper, stub claude, app) OR its --user-data-dir on the command line
  // (Electron gpu/utility helpers re-exec with a clean environ and used to outlive a SIGKILLed app).
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0');
      if (env.includes(`ORCHESTRA_HOME=${home}`)) { out.push(+p); continue; }
    } catch {}
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(`--user-data-dir=${path.join(home, 'userData')}`)) out.push(+p); } catch {}
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
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: privateRuntimeDir(), XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
    // Never the human's session bus (ledger #405, incident Q2): with the real XDG_RUNTIME_DIR (the sway socket lives there) an UNSET address lets libdbus
    // default to unix:runtime=yes -> /run/user/1000/bus. Pin it to a socket that does not exist, inside the rig dir.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(RIG_DIR, 'no-session-bus')}` };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  if (!env.DBUS_SESSION_BUS_ADDRESS.includes(RIG_DIR) || fs.existsSync(env.DBUS_SESSION_BUS_ADDRESS.slice('unix:path='.length))) refuse(`child D-Bus address ${env.DBUS_SESSION_BUS_ADDRESS} is not a nonexistent socket inside the rig dir`);
  const logFile = path.join(RIG_DIR, `app-${bootName}.log`);
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  [${bootName}] app pid ${app.pid} port ${port} log ${logFile}`);
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('!!document.querySelector(".toolbar")'), 60000, 'the toolbar (an ACTIVE workspace)');
  const b = { app, port, cdp, target, bootName, world };
  await selectWorkspace(b, 'e2e/bt393-1'); // two workspaces are seeded: every boot drives the first
  // controls: the app answering is OUR build, on OUR sway, in OUR scratch world
  clause(bootName, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
  // NOT /proc/<pid>/environ: it goes BLIND once DBUS_SESSION_BUS_ADDRESS is in the app's env (Chromium rewrites its title/environ — src/shared/browser-reliquats.ts:37).
  // Assert what this driver HANDED the app (the spawn object), and prove the app HONOURED it by an effect: the seeded workspace of the world's store is the active row.
  const handed = handedEnvProblems(env, { ohome: world.ohome, cfg: world.cfg, home: world.fakeHome, wayland: RIG_WAYLAND, xdg: privateRuntimeDir(), noBusPath: path.join(RIG_DIR, 'no-session-bus') });
  clause(bootName, 'ctl/scratch-env', handed.length === 0, handed.length ? `env handed to the app: ${handed.join('; ')}` : `env handed to the app (spawn object): ORCHESTRA_HOME=${env.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} DISPLAY=<unset> DBUS=pinned nonexistent, XDG private`);
  const honoured = await b.cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some((e) => e.textContent.includes('e2e/bt393-1'))`);
  clause(bootName, 'ctl/app-honoured-the-world', honoured === true, `the app loaded the seeded store from ORCHESTRA_HOME=${world.ohome}: active row e2e/bt393-1 = ${honoured}`);
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
const labelOf = (letter) => `Tabs fixture ${letter.toUpperCase()}`;
const readTabsFile = (world) => { try { return JSON.parse(fs.readFileSync(world.tabsFile, 'utf8')).workspaces?.[world.ws.id] ?? null; } catch { return null; } };

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

// ═════════════════════════════════════ main ═════════════════════════════════════
const before = liveCanary();
const site = await startSite();
const BASE = `http://127.0.0.1:${site.port}`;
const URLS = { a: `${BASE}/tabs-a.html`, b: `${BASE}/tabs-b.html`, c: `${BASE}/tabs-c.html` };
console.log(`[rig] app ${APP_DIR} label ${LABEL} arms ${[...ARMS].join(',')} out ${OUT}\n[rig] fixture: ${site.kind} on ${BASE}`);
const world = seedWorld(path.join(RIG_DIR, 'world'));
const needBoot1 = ['tabs', 'urlbar', 'cap', 'paint', 'ws', 'reopen', 'restore'].some((a) => ARMS.has(a));
let b = null;
try {
  // ────────────────────────────── boot 1 ──────────────────────────────
  if (needBoot1) {
    b = await boot(world, 'boot1');
    await openBrowserPane(b);
    const t0 = await tabs(b);
    clause('tabs', 'ctl/one-blank-tab-at-first-open', t0.length === 1 && t0[0].active && t0[0].openedBy === 'human', `tabs ${JSON.stringify(t0.map((t) => [t.label, t.active, t.openedBy]))}`);
    clause('tabs', 'ctl/own-sway-and-view-target-count', (await viewTargets(b)).length === 1, `page targets besides the app renderer = ${(await viewTargets(b)).length} (one live view for one tab: the instrument counts views)`);

    // tab A: navigate the first tab through the URL bar
    await typeUrl(b, URLS.a);
    await waitFor(async () => (await tabs(b))[0]?.label === labelOf('a'), 20000, 'tab 1 to load fixture A');
    // + -> tab 2 (B), + -> tab 3 (C), each through the strip
    const preCount = (await tabs(b)).length;
    await clickSel(b, '.browser-tab-new');
    await waitFor(async () => (await tabs(b)).length === 2, 10000, 'a 2nd tab after clicking +');
    const t2 = await tabs(b);
    clause('tabs', 'new-tab-is-activated-and-url-bar-blank', preCount === 1 && t2.length === 2 && t2[1].active && !t2[0].active && (await urlBar(b)) === '', `tabs ${preCount} -> ${t2.length}; active=${JSON.stringify(t2.map((t) => t.active))}; URL bar after + = ${JSON.stringify(await urlBar(b))}`);
    await typeUrl(b, URLS.b);
    await waitFor(async () => (await tabs(b))[1]?.label === labelOf('b'), 20000, 'tab 2 to load fixture B');
    await clickSel(b, '.browser-tab-new');
    await waitFor(async () => (await tabs(b)).length === 3, 10000, 'a 3rd tab');
    await typeUrl(b, URLS.c);
    await waitFor(async () => (await tabs(b))[2]?.label === labelOf('c'), 20000, 'tab 3 to load fixture C');

    // URL bar follows the ACTIVE tab; switching paints the right native view
    for (const [step, [letter, idx]] of [['a', 0], ['b', 1], ['c', 2], ['a', 0]].entries()) {
      await clickSel(b, '.browser-tab', idx);
      await waitFor(async () => (await tabs(b))[idx]?.active, 10000, `tab ${idx + 1} to become active`);
      await sleep(250);
      const bar = await urlBar(b);
      const act = (await tabs(b)).map((t) => t.active);
      clause('tabs', `url-bar-follows-active-tab/${letter.toUpperCase()}`, bar === URLS[letter] && act.filter(Boolean).length === 1 && act[idx], `after clicking tab ${idx + 1}: URL bar ${JSON.stringify(bar)} (want ${URLS[letter]}), active flags ${JSON.stringify(act)}`);
      const hc = await holderColor(b, `paint-${step}-${letter}`, COLORS[letter]);
      clause('tabs', `switch-paints-the-active-view/${letter.toUpperCase()}`, near(hc.color, COLORS[letter]), `compositor pixel at the page area centre = ${hex(hc.color)} (want ${hex(COLORS[letter])}; ${hc.tries} grim tries)`);
    }
    // the three fixture colours must be distinguishable, or the pixel clauses above prove nothing
    clause('tabs', 'ctl/fixture-colours-distinct', !near(COLORS.a, COLORS.b, 40) && !near(COLORS.b, COLORS.c, 40) && !near(COLORS.a, COLORS.c, 40), `A ${hex(COLORS.a)} B ${hex(COLORS.b)} C ${hex(COLORS.c)}`);
    clause('tabs', 'three-live-views-three-tabs', (await viewTargets(b)).length === 3, `page targets = ${(await viewTargets(b)).length}, tabs = ${(await tabs(b)).length}`);

    // ── urlbar: PROBE of a KNOWN pre-existing defect — the bar can stay empty after the FIRST navigation of a blank tab (verifier: 4/14 on the old code, 8/26 on this, 3/26 on the code before it). NOT a guard of a fix ──
    if (ARMS.has('urlbar')) {
      const empty = [];
      const N = 12;
      for (let i = 0; i < N; i++) {
        const letter = 'abc'[i % 3];
        await clickSel(b, '.browser-tab-new');
        await softWait(async () => (await tabs(b)).length === 4, 10000, 'a 4th (blank) tab');
        await typeUrl(b, URLS[letter]);
        // In the verifier's drives the input blurs 10-38 ms after a submit (then is refocused 1-11 ms later); a CDP-driven Enter leaves it focused,
        // so force a blur at a varying delay (2..40 ms) to try to hit the same window. It never reproduced the empty bar here.
        await sleep([2, 6, 11, 16, 25, 40][i % 6]);
        await b.cdp.eval(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
        await softWait(async () => (await tabs(b))[3]?.label === labelOf(letter), 20000, `blank tab to load fixture ${letter.toUpperCase()}`);
        await sleep(700); // past the load events and React's flush
        const bar = await urlBar(b);
        if (bar !== URLS[letter]) empty.push(`#${i + 1} ${letter}: bar ${JSON.stringify(bar)}`);
        await clickSel(b, '.browser-tab-close', 3);
        await softWait(async () => (await tabs(b)).length === 3, 10000, 'the extra tab to close');
      }
      clause('urlbar', 'url-bar-shows-the-url-after-the-first-navigation-of-a-blank-tab', empty.length === 0, `${N} blank-tab navigations, bar wrong in ${empty.length}${empty.length ? `: ${empty.join('; ')}` : ' (0/12 with a forced blur 2-40 ms after each submit. This is a PROBE of a known pre-existing defect, not evidence of a fix: the verifier measured the empty bar 8/26 on this code and 3/26 before it; CDP timing here never reproduced it)'}`);
      clause('urlbar', 'ctl/three-tabs-left-after-the-loop', (await tabs(b)).length === 3, `tabs ${(await tabs(b)).length}`);
    }

    // ── cap ──
    if (ARMS.has('cap')) {
      for (let i = 4; i <= 8; i++) { await clickSel(b, '.browser-tab-new'); await waitFor(async () => (await tabs(b)).length === i, 10000, `tab ${i}`); }
      const at8 = await tabs(b); const v8 = (await viewTargets(b)).length;
      clause('cap', 'ctl/eight-tabs-eight-views', at8.length === 8 && v8 === 8 && !(await b.cdp.eval(`!!document.querySelector('.browser-tab-notice')`)), `tabs ${at8.length}, page targets ${v8}, no notice yet`);
      await clickSel(b, '.browser-tab-new'); // the 9th
      await sleep(900);
      const notice = await b.cdp.eval(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
      const after = await tabs(b); const vAfter = (await viewTargets(b)).length;
      clause('cap', 'ninth-tab-refused-with-a-clear-notice', !!notice && /at most 8/.test(notice), `notice ${JSON.stringify(notice)}`);
      clause('cap', 'ninth-tab-creates-no-tab-and-no-view', after.length === 8 && vAfter === 8, `tabs ${at8.length} -> ${after.length}; page targets ${v8} -> ${vAfter} (a leaked view would be 9)`);
      clause('cap', 'app-still-responsive-after-refusal', (await b.cdp.eval(`1 + 1`)) === 2 && !!(await rectOf(b, '.browser-tab-new')), 'renderer answers, the + control is still there');
      saveShot('cap-refusal-renderer.png', await b.cdp.shot());
      grim('cap-refusal-compositor.png');
      // back to [A,B,C]: close the five blanks from the right via their × (background closes keep B... first activate B)
      await clickSel(b, '.browser-tab', 1);
      await waitFor(async () => (await tabs(b))[1]?.active, 10000, 'tab B active before closing the blanks');
      for (let i = 0; i < 5; i++) { const n = (await tabs(b)).length; await clickSel(b, '.browser-tab-close', n - 1); await waitFor(async () => (await tabs(b)).length === n - 1, 10000, `a tab to close (${n} -> ${n - 1})`); }
      const back = await tabs(b);
      clause('cap', 'closing-background-tabs-keeps-the-active-one', back.length === 3 && back[1].active && back.map((t) => t.label).join('|') === [labelOf('a'), labelOf('b'), labelOf('c')].join('|') && (await viewTargets(b)).length === 3, `tabs ${JSON.stringify(back.map((t) => [t.label, t.active]))}; page targets ${(await viewTargets(b)).length}`);
    } else {
      await clickSel(b, '.browser-tab', 1);
      await waitFor(async () => (await tabs(b))[1]?.active, 10000, 'tab B active');
    }

    // ── paint: nothing of an inactive/hidden view is left over the app ──
    if (ARMS.has('paint')) {
      const isFix = (c) => Object.values(COLORS).some((k) => near(c, k, 24));
      const base = await holderColor(b, 'paint-before-hide', COLORS.b);
      clause('paint', 'ctl/page-visible-before-hiding', near(base.color, COLORS.b), `pixel ${hex(base.color)} (B active, pane open)`);
      await clickSel(b, 'button.pane-toggle[aria-label="Hide browser pane"]');
      await waitFor(() => b.cdp.eval(`!document.querySelector('.browser-tabs')`), 10000, 'the pane to close');
      await sleep(700);
      const hid = grim('paint-pane-hidden.png'); const hc = blockColor(hid, Math.round(base.rect.x), Math.round(base.rect.y));
      const stripe = blockColor(hid, Math.round(base.rect.x), Math.round(base.rect.top + 4), 3);
      clause('paint', 'pane-hidden-leaves-no-view-over-the-app', !isFix(hc) && !isFix(stripe), `pixels where the page was: centre ${hex(hc)}, top stripe ${hex(stripe)} — neither is a fixture colour (A/B/C)`);
      await clickSel(b, 'button.pane-toggle[aria-label="Show browser pane"]');
      await waitFor(() => b.cdp.eval(`!!document.querySelector('.browser-tabs')`), 10000, 'the pane to reopen');
      const reopened = await holderColor(b, 'paint-pane-reopened', COLORS.b);
      clause('paint', 'reopening-the-pane-shows-the-active-tab-again', near(reopened.color, COLORS.b), `pixel ${hex(reopened.color)} (B still active)`);
      // an app overlay (Help) must cover the pane, not sit under a native view
      await clickSel(b, '[aria-label="Help — feature guide"]');
      await waitFor(() => b.cdp.eval(`!!document.querySelector('.help-view')`), 10000, 'the Help overlay');
      await sleep(800);
      const help = grim('paint-help-overlay.png'); const hh = blockColor(help, Math.round(base.rect.x), Math.round(base.rect.y));
      clause('paint', 'overlay-over-the-pane-is-not-covered-by-a-tab-view', !isFix(hh), `pixel under the Help overlay where the page was: ${hex(hh)} (not a fixture colour)`);
      await clickSel(b, '[aria-label="Close help"]');
      await waitFor(() => b.cdp.eval(`!document.querySelector('.help-view')`), 10000, 'Help to close');
      const back = await holderColor(b, 'paint-after-help', COLORS.b);
      clause('paint', 'closing-the-overlay-restores-the-active-tab', near(back.color, COLORS.b), `pixel ${hex(back.color)}`);
    }

    // ── reopen (#393 F2) — BEFORE `ws`: a second workspace holds another tab at the same fixture url, and the target lookup is by url ──
    //    a closed pane stays closed when a BACKGROUND tab publishes; an agent-style navigation re-opens it ──
    if (ARMS.has('reopen')) {
      const WSID = world.ws.id;
      await clickSel(b, 'button.pane-toggle[aria-label="Hide browser pane"]');
      await waitFor(() => b.cdp.eval(`!document.querySelector('.browser-tabs')`), 10000, 'the pane to close');
      const urlMatches = (await viewTargets(b)).filter((t) => t.url === URLS.a);
      clause('reopen', 'ctl/exactly-one-page-target-for-tab-a', urlMatches.length === 1, `page targets at ${URLS.a}: ${urlMatches.length} (a second workspace's tab would make the lookup ambiguous)`);
      const bgTarget = urlMatches[0];
      clause('reopen', 'ctl/background-tab-target-found', !!bgTarget, `page target for tab A (a background tab, pane closed): ${bgTarget?.url ?? 'NOT FOUND'}`);
      if (bgTarget) {
        const pc = await Cdp.connect(bgTarget.webSocketDebuggerUrl);
        await pc.eval(`document.title = 'bg-title-changed'`);
        pc.close();
      }
      const published = await softWait(() => b.cdp.eval(`window.orchestra.browserState(${JSON.stringify(WSID)}).then((s) => s.tabs.some((t) => t.title === 'bg-title-changed' && !t.active))`), 8000, 'main to publish the background title');
      clause('reopen', 'ctl/background-title-event-reached-main', published, 'browserState(ws).tabs holds the changed title on a NON-active tab (the event ran through main)');
      await sleep(1500);
      const stillClosed = await b.cdp.eval(`!document.querySelector('.browser-tabs') && !!document.querySelector('button.pane-toggle[aria-label="Show browser pane"]')`);
      clause('reopen', 'background-tab-event-does-not-reopen-a-closed-pane', stillClosed, `after the background title event: tab strip ${stillClosed ? 'absent' : 'PRESENT'}, toggle ${stillClosed ? 'reads "Show browser pane"' : 'reopened'}`);
      grim('reopen-pane-still-closed.png');
      // control: what the agent's navigate does (same main primitive) re-opens it — the auto-open feature is intact
      await b.cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(WSID)}, ${JSON.stringify(URLS.b + '?agent=1')})`);
      const reopened = await softWait(() => b.cdp.eval(`!!document.querySelector('.browser-tabs')`), 10000, 'the pane to re-open after an agent-style navigation');
      clause('reopen', 'agent-style-navigation-still-reopens-the-pane', reopened, `tab strip ${reopened ? 'present' : 'ABSENT'} after browserNavigate(ws, ${URLS.b}?agent=1)`);
      // review MAJOR: the agent navigates to the url the active tab is ALREADY on while the pane is closed — only did-start-loading tells the renderer
      await clickSel(b, 'button.pane-toggle[aria-label="Hide browser pane"]');
      await waitFor(() => b.cdp.eval(`!document.querySelector('.browser-tabs')`), 10000, 'the pane to close again');
      await sleep(600);
      await b.cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(WSID)}, ${JSON.stringify(URLS.b + '?agent=1')})`); // SAME url as the active tab
      const reopenedSame = await softWait(() => b.cdp.eval(`!!document.querySelector('.browser-tabs')`), 10000, 'the pane to re-open after a SAME-url agent navigation');
      clause('reopen', 'same-url-agent-navigation-reopens-the-pane', reopenedSame, `tab strip ${reopenedSame ? 'present' : 'ABSENT'} after browserNavigate(ws, ${URLS.b}?agent=1) with the active tab already there`);
      // put things back: B at its fixture url, A at its title (the restore arm asserts [A,B,C] with B active)
      await b.cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(WSID)}, ${JSON.stringify(URLS.b)})`);
      await softWait(async () => (await urlBar(b)) === URLS.b && (await tabs(b))[1]?.label === labelOf('b'), 15000, 'B back at its url');
      if (bgTarget) { const pc = await Cdp.connect(bgTarget.webSocketDebuggerUrl).catch(() => null); if (pc) { await pc.eval(`document.title = ${JSON.stringify(labelOf('a'))}`).catch(() => {}); pc.close(); } }
    }

    // ── ws: a second workspace never sees (or is covered by) the first one's tabs ──
    if (ARMS.has('ws')) {
      const isFix = (c) => Object.values(COLORS).some((k) => near(c, k, 24));
      const wsBase = await holderColor(b, 'ws-ws1-before', COLORS.b);
      clause('ws', 'ctl/ws1-page-visible-before-switching', near(wsBase.color, COLORS.b), `pixel ${hex(wsBase.color)} (ws1, B active)`);
      await selectWorkspace(b, 'e2e/bt393-2');
      const away = grim('ws-ws2-selected.png'); const ac = blockColor(away, Math.round(wsBase.rect.x), Math.round(wsBase.rect.y));
      clause('ws', 'switching-workspace-leaves-no-view-over-the-app', !isFix(ac), `pixel where ws1's page was, ws2 selected: ${hex(ac)} (not a fixture colour)`);
      clause('ws', 'second-workspace-pane-starts-closed', await b.cdp.eval(`!document.querySelector('.browser-tabs')`), 'ws2: no tab strip until its pane is opened');
      await openBrowserPane(b);
      const w2 = await tabs(b);
      clause('ws', 'tab-sets-are-per-workspace', w2.length === 1 && w2[0].label === 'New tab' && w2[0].active, `ws2 tabs ${JSON.stringify(w2.map((t) => [t.label, t.active]))} (ws1 holds 3)`);
      await typeUrl(b, URLS.a);
      await softWait(async () => (await tabs(b))[0]?.label === labelOf('a'), 20000, 'ws2 tab to load fixture A');
      const w2c = await holderColor(b, 'ws-ws2-page', COLORS.a);
      clause('ws', 'second-workspace-paints-its-own-active-tab', near(w2c.color, COLORS.a), `pixel ${hex(w2c.color)} (want A ${hex(COLORS.a)})`);
      await selectWorkspace(b, 'e2e/bt393-1');
      await softWait(() => b.cdp.eval(`!!document.querySelector('.browser-tabs')`), 10000, 'ws1 pane to be open again');
      const back1 = await holderColor(b, 'ws-ws1-back', COLORS.b);
      const w1 = await tabs(b);
      clause('ws', 'switching-back-restores-the-first-workspaces-tabs', near(back1.color, COLORS.b) && safe(() => w1.length === 3 && w1[1].active), `ws1 tabs ${JSON.stringify(w1.map((t) => [t.label, t.active]))}; pixel ${hex(back1.color)} (want B ${hex(COLORS.b)})`);
    }

    // ── persistence reaches disk, then a GRACEFUL quit ──
    if (ARMS.has('restore')) {
      await softWait(() => { const e = readTabsFile(world); return e && e.tabs.length === 3 && e.activeIndex === 1; }, 8000, 'browser-tabs.json to hold [A,B,C] with B active');
      const onDisk = readTabsFile(world);
      clause('restore', 'tabs-file-holds-three-tabs-and-the-active-index', safe(() => onDisk.tabs.map((t) => t.url).join('|') === [URLS.a, URLS.b, URLS.c].join('|') && onDisk.activeIndex === 1), `${world.tabsFile}: ${JSON.stringify(onDisk)}`);
      saveShot('boot1-before-quit-renderer.png', await b.cdp.shot());
      grim('boot1-before-quit-compositor.png');
      await teardown(b, 'graceful'); b = null;

      // ────────────────────────────── boot 2: restore after a graceful quit ──────────────────────────────
      b = await boot(world, 'boot2');
      const pre = await b.cdp.eval(`({ pane: !!document.querySelector('.browser-pane'), tabs: document.querySelectorAll('.browser-tab').length })`);
      clause('restore', 'ctl/pane-closed-after-restart', !pre.pane && pre.tabs === 0, `before opening the pane: pane=${pre.pane}, tab elements=${pre.tabs}`);
      await openBrowserPane(b);
      await softWait(async () => (await tabs(b)).length === 3 && (await tabs(b)).every((t) => t.label.startsWith('Tabs fixture')), 20000, 'the three restored tabs to load their titles');
      const rt = await tabs(b);
      clause('restore', 'graceful-restart-restores-three-tabs-same-urls', safe(() => rt.length === 3 && rt.map((t) => t.tip).join('|') === [URLS.a, URLS.b, URLS.c].join('|')), `tabs ${JSON.stringify(rt.map((t) => [t.label, t.tip]))}`);
      clause('restore', 'graceful-restart-restores-the-same-active-tab', rt.findIndex((t) => t.active) === 1 && (await urlBar(b)) === URLS.b, `active index ${rt.findIndex((t) => t.active)} (want 1 = B); URL bar ${JSON.stringify(await urlBar(b))}`);
      clause('restore', 'restored-views-match-restored-tabs', (await viewTargets(b)).length === 3, `page targets ${(await viewTargets(b)).length} (ws1's 3 tabs; ws2's remembered tab is NOT loaded until its pane opens — restore is lazy)`);
      const rp = await holderColor(b, 'boot2-restored-active', COLORS.b);
      clause('restore', 'restored-active-tab-is-the-one-painted', near(rp.color, COLORS.b), `compositor pixel ${hex(rp.color)} (want B ${hex(COLORS.b)})`);
      saveShot('boot2-restored-renderer.png', await b.cdp.shot());
      // change the active tab, then die WITHOUT any quit hook
      await clickSel(b, '.browser-tab', 2).catch((e) => console.log(`  (no third tab to click: ${e.message})`));
      await softWait(async () => (await tabs(b))[2]?.active, 10000, 'tab C active');
      await softWait(() => readTabsFile(world)?.activeIndex === 2, 8000, 'the debounced write of active=C');
      await sleep(300);
      await teardown(b, 'kill9'); b = null;

      // ────────────────────────────── boot 3: restore after SIGKILL ──────────────────────────────
      b = await boot(world, 'boot3');
      await openBrowserPane(b);
      await softWait(async () => (await tabs(b)).length === 3 && (await tabs(b)).every((t) => t.label.startsWith('Tabs fixture')), 20000, 'the three restored tabs (after SIGKILL)');
      const kt = await tabs(b);
      clause('restore', 'sigkill-restart-restores-three-tabs-with-the-active-one', kt.length === 3 && kt.findIndex((t) => t.active) === 2 && (await urlBar(b)) === URLS.c, `tabs ${JSON.stringify(kt.map((t) => [t.label, t.active]))}; URL bar ${JSON.stringify(await urlBar(b))}`);
      const kp = await holderColor(b, 'boot3-restored-active', COLORS.c);
      clause('restore', 'sigkill-restored-active-tab-is-the-one-painted', near(kp.color, COLORS.c), `compositor pixel ${hex(kp.color)} (want C ${hex(COLORS.c)})`);
    } else {
      await teardown(b, 'term'); b = null;
    }
  }

  // ────────────────────────────── last tab ──────────────────────────────
  if (ARMS.has('last')) {
    if (!b) { b = await boot(world, 'boot-last'); await openBrowserPane(b); await waitFor(async () => (await tabs(b)).length >= 1, 20000, 'tabs'); }
    for (let n = (await tabs(b)).length; n >= 2; n--) { await clickSel(b, '.browser-tab-close', 0); await softWait(async () => (await tabs(b)).length === n - 1, 10000, `close ${n} -> ${n - 1}`); }
    const lastBefore = (await tabs(b))[0] ?? { id: null };
    await clickSel(b, '.browser-tab-close', 0);
    await sleep(1200);
    const lt = await tabs(b);
    clause('last', 'closing-the-last-tab-leaves-one-fresh-blank-tab', safe(() => lt.length === 1 && lt[0].active && lt[0].openedBy === 'human' && lt[0].label === 'New tab' && lt[0].id !== lastBefore.id) && (await urlBar(b)) === '', `before ${JSON.stringify(lastBefore)} -> after ${JSON.stringify(lt)}; URL bar ${JSON.stringify(await urlBar(b))}`);
    clause('last', 'closing-the-last-tab-leaves-exactly-one-view', (await viewTargets(b)).length === 1 && (await b.cdp.eval(`1 + 1`)) === 2, `page targets ${(await viewTargets(b)).length}; renderer alive`);
    await softWait(() => { const e = readTabsFile(world); return e && e.tabs.length === 1 && e.tabs[0].url === ''; }, 8000, 'the file to hold the single blank tab');
    clause('last', 'single-blank-tab-is-what-is-remembered', safe(() => { const e = readTabsFile(world); return e.tabs.length === 1 && e.tabs[0].url === '' && e.activeIndex === 0; }), `file ${JSON.stringify(readTabsFile(world))}`);
    saveShot('last-tab-renderer.png', await b.cdp.shot());
    grim('last-tab-compositor.png');
    await teardown(b, 'term'); b = null;
  }

  // ────────────────────────────── boot 4: server down at boot ──────────────────────────────
  if (ARMS.has('down')) {
    const deadPort = await freePort(); // bound then released: nothing listens there
    const DEAD = `http://127.0.0.1:${deadPort}/gone.html`;
    fs.mkdirSync(path.dirname(world.tabsFile), { recursive: true });
    fs.writeFileSync(world.tabsFile, JSON.stringify({ version: 1, workspaces: { [world.ws.id]: { tabs: [{ url: DEAD, openedBy: 'human' }, { url: URLS.a, openedBy: 'human' }], activeIndex: 1 } } }));
    b = await boot(world, 'boot-down');
    await openBrowserPane(b);
    await softWait(async () => (await tabs(b)).length === 2 && (await tabs(b))[1].label === labelOf('a'), 20000, 'the live restored tab to load');
    await sleep(2500); // the dead tab's load has failed by now
    // force snapshots while the dead tab sits in its error page: open a tab, close it again
    await clickSel(b, '.browser-tab-new');
    await softWait(async () => (await tabs(b)).length === 3, 10000, 'a third tab');
    await clickSel(b, '.browser-tab-close', 2);
    await softWait(async () => (await tabs(b)).length === 2, 10000, 'back to two tabs');
    await sleep(1000);
    const dt = await tabs(b); const dfile = readTabsFile(world);
    clause('down', 'ctl/dead-url-really-fails', await b.cdp.eval(`fetch(${JSON.stringify(DEAD)}).then(() => false, () => true)`).catch(() => true), `nothing answers on ${DEAD}`);
    clause('down', 'dead-tab-is-restored-as-a-tab', safe(() => dt.length === 2 && dt[0].tip === DEAD), `tabs ${JSON.stringify(dt.map((t) => [t.label, t.tip]))}`);
    clause('down', 'failed-restore-keeps-the-remembered-url', safe(() => dfile.tabs.length === 2 && dfile.tabs[0].url === DEAD && dfile.tabs[1].url === URLS.a && dfile.activeIndex === 1), `${world.tabsFile}: ${JSON.stringify(dfile)}`);
    saveShot('down-renderer.png', await b.cdp.shot());
    await teardown(b, 'term'); b = null;
  }
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
