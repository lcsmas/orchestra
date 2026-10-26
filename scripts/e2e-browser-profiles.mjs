// #400 — profils navigateur, on the BUILT app (argv[2] = app dir) inside the contained rig's own headless sway.
//
// One scratch world (ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, TWO seeded workspaces, pinned scratch account, stub `claude`), the shared
// fixture site (/signin sets a persistent `sid`, /whoami echoes it) and THREE boots of the app on the same world:
//   boot 1  settings  Settings > Browser: create / duplicate refused / rename (same id) / the unencrypted-storage warning at creation (+ screenshot)
//           attach    URL-bar chip -> attach: ALL tabs rebuilt on the profile (same ids/URLs, no leaked view, page still painted), one shared jar for
//                     every tab (sign in on tab 2 -> tab 1 sees it), a 2nd workspace WITHOUT the profile is signed out, a 2nd workspace WITH it shares
//                     the sign-in, detach / switch return to ephemeral / another jar; disk: only the profile is a persist: partition
//           human     the agent paths cannot attach: real CLI verbs, hooks-socket routes, the agent's page (no bridge), and IPC from a FOREIGN
//                     webContents (main-process inspector -> a hidden window) on all four write channels — refused, nothing moved; the app's own window works
//           restore   session / persistent cookie + localStorage written; GRACEFUL quit
//   boot 2  restore   same tabs back SIGNED IN, the other workspace signed out, a dangling profile id reads as ephemeral; a NEW sign-in then SIGKILL
//   boot 3  restore   the sign-in made seconds before the SIGKILL survived (cookie store flushed on change)
//           flush     (own boots) the same, 9 s margin — the timing arm run 10x unmutated
//           session   (own boots) a SESSION-cookie sign-in (no expiry): promoted to 30 days in the profile, survives a restart; the workspace without the profile does not
//           delete    delete an attached profile: carriers detached, tabs reloaded ephemeral & signed out, cookie DB emptied on disk, another profile untouched
// Every clause prints PASS/FAIL with the value that proves it; ctl/* clauses are controls (identity, scratch containment, own sway, instrument).
// Mutant BUILDS that must redden each arm: scripts/e2e-browser-profiles-mutants.mjs.
//
// Usage (via scripts/e2e-browser-profiles.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--arms settings,attach,human,restore,delete,flush,session]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
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
const ARMS = new Set(flag('--arms', 'settings,attach,human,restore,delete,flush,session').split(','));

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-profiles.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
// the contained rig's PRIVATE runtime dir (incident Q2): a named refusal unless this really runs inside it — never the human's /run/user/<uid>
let XDG;
try { XDG = privateRuntimeDir(); } catch (e) { refuse(String(e.message ?? e)); }
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
const safe = (f) => { try { return !!f(); } catch { return false; } };
const softWait = async (fn, ms, what) => { try { await waitFor(fn, ms, what); return true; } catch { console.log(`  (soft wait timed out: ${what})`); return false; } };
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
fs.mkdirSync(OUT, { recursive: true });
function saveShot(name, buf) { const f = path.join(OUT, `${LABEL}-${name}`); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }
function grim(name) {
  const f = path.join(OUT, `${LABEL}-${name}`);
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
  const buf = fs.readFileSync(f); shots.push({ file: f, md5: md5(buf) }); return decodePng(buf);
}

// ── fixture site: the shared one (#395) — /signin sets a persistent `sid`, /whoami echoes it ───────────────
const SITE_DIR = path.join(repoRoot, 'scripts/fixtures/browser-site');
let siteProc = null;
async function startSite() {
  siteProc = spawn('node', [path.join(SITE_DIR, 'server.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('fixture site did not print LISTENING')), 10000); siteProc.stdout.on('data', (d) => { const m = /LISTENING (\d+)/.exec(String(d)); if (m) { clearTimeout(t); res(+m[1]); } }); });
}

// ── world: a real git repo + TWO registered worktrees, the PINNED scratch account, a stub `claude` ────────
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.join(armDir, 'wt')]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# bp400 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-bp400', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const wss = [1, 2].map((n) => {
    const wt = path.join(armDir, 'wt', `bp400-${n}`); mustBeScratch(`wt${n}`, wt);
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/bp400-${n}`, wt], fakeHome);
    return { id: `ws-bp400-${n}`, name: `bp400-${n}`, repoPath: repoDir, worktreePath: wt, branch: `e2e/bp400-${n}`, baseBranch: 'main', createdAt: Date.now() + n, status: 'idle', agent: 'claude', accountId: account.id };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bp400-repo', defaultBranch: 'main', accountId: account.id }], workspaces: wss, accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho BP400-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws1: wss[0], ws2: wss[1], stubDir, storeFile: path.join(dir, 'store.json'), partitions: path.join(ohome, 'userData', 'Partitions') };
}
const readStore = (w) => JSON.parse(fs.readFileSync(w.storeFile, 'utf8'));
const wsRec = (w, id) => readStore(w).workspaces.find((x) => x.id === id);
const profilesOnDisk = (w) => readStore(w).browserProfiles ?? [];
const partDirs = (w) => (fs.existsSync(w.partitions) ? fs.readdirSync(w.partitions) : []);
/** Cookie rows of a profile's persistent partition, read from a COPY of its cookie DB (Chromium keeps the live one locked). */
function cookieRows(w, profileId) {
  const base = path.join(w.partitions, `orchestra-profile-${profileId}`);
  const cand = ['Network/Cookies', 'Cookies'].map((p) => path.join(base, p)).find((p) => fs.existsSync(p));
  if (!cand) return null;
  const tmp = fs.mkdtempSync(path.join(RIG_DIR, 'cookies-'));
  for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.copyFileSync(cand + suffix, path.join(tmp, 'Cookies' + suffix)); } catch {} }
  const py = 'import sqlite3,sys,json\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True,timeout=3)\nprint(json.dumps(c.execute("select host_key,name,is_persistent,expires_utc from cookies").fetchall()))\n';
  try { return JSON.parse(sh('python3', ['-I', '-c', py, path.join(tmp, 'Cookies')]).trim()); } catch (e) { return { error: String(e.message ?? e).slice(0, 200) }; }
}

function procsByHome(home) {
  // identity = this world's ORCHESTRA_HOME in the environ (keeper, stub claude, app) OR its --user-data-dir on the command line
  // (Electron gpu/utility helpers re-exec with a clean environ and outlive a SIGKILLed app — 24 orphans measured on this rig's first runs).
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
async function boot(world, bootName, { inspect = false } = {}) {
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${VIEWPORT.w}x${VIEWPORT.h}`]);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const inspectPort = inspect ? await freePort() : 0;
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
    // the contained rig pins this to a path that must never exist (private runtime world, incident Q2) — pass it through, never invent one
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(RIG_DIR, `app-${bootName}.log`);
  const fd = fs.openSync(logFile, 'w');
  // --password-store=basic is an EXPLICIT switch (#389 leaves it alone): a scratch app never binds to the human's login keyring (G10b)
  const args = [...(inspect ? [`--inspect=127.0.0.1:${inspectPort}`] : []), APP_DIR, '--ozone-platform=wayland', '--password-store=basic'];
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), args, { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  [${bootName}] app pid ${app.pid} port ${port}${inspect ? ` inspector ${inspectPort}` : ''} log ${logFile}`);
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('!!document.querySelector(".toolbar")'), 60000, 'the toolbar (an ACTIVE workspace)');
  const b = { app, port, inspectPort, cdp, target, bootName, world };
  await selectWorkspace(b, 'e2e/bp400-1');
  clause(bootName, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
  // What the DRIVER handed the app (Chromium rewrites the main process's environ once DBUS_SESSION_BUS_ADDRESS is set — /proc/<pid>/environ goes blind)
  clause(bootName, 'ctl/scratch-env', env.ORCHESTRA_HOME === world.ohome && env.CLAUDE_CONFIG_DIR === world.cfg && env.HOME === world.fakeHome && !('DISPLAY' in env) && env.WAYLAND_DISPLAY === RIG_WAYLAND && env.XDG_RUNTIME_DIR === XDG && !env.XDG_RUNTIME_DIR.startsWith('/run/user/'),
    `handed env: ORCHESTRA_HOME=${env.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR} DBUS_SESSION_BUS_ADDRESS=${env.DBUS_SESSION_BUS_ADDRESS ?? '<unset>'} DISPLAY=${'DISPLAY' in env ? env.DISPLAY : '<unset>'}`);
  const sec = await cdp.eval(`window.orchestra.getSecretsState()`);
  clause(bootName, 'ctl/app-not-bound-to-a-keyring', sec?.backend === 'basic_text' && sec?.encrypted === false, `getSecretsState() = ${JSON.stringify(sec)} (the explicit basic backend: no Secret Service)`);
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
  for (const p of procsByHome(b.world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
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
async function typeInto(b, sel, text, { clear = true } = {}) {
  await clickSel(b, sel);
  if (clear) await b.cdp.eval(`document.querySelector(${JSON.stringify(sel)}).select()`);
  await b.cdp.send('Input.insertText', { text });
  await sleep(80);
}
const typeUrl = async (b, url) => { await typeInto(b, '.browser-url-input', url); await b.cdp.key('Enter', 'Enter', 13); };
async function viewTargets(b) {
  const list = await (await fetch(`http://127.0.0.1:${b.port}/json`)).json();
  return list.filter((x) => x.type === 'page' && !x.url.includes('dist/index.html'));
}
async function openBrowserPane(b) {
  const sel = 'button.pane-toggle[aria-label="Show browser pane"]';
  if (!(await b.cdp.eval(`!!document.querySelector('.browser-tabs')`))) {
    await waitFor(() => b.cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`), 30000, 'the browser pane toggle');
    await clickSel(b, sel);
  }
  await waitFor(() => b.cdp.eval(`!!document.querySelector('.browser-tabs') && document.querySelectorAll('.browser-tab').length > 0`), 30000, 'the tab strip');
  await waitFor(() => b.cdp.eval(`(() => { const h = document.querySelector('.browser-holder'); if (!h) return false; const r = h.getBoundingClientRect(); return r.width > 100 && r.height > 100; })()`), 15000, 'the browser holder to be laid out');
  await sleep(500);
}
async function holderColor(b, name, want, ms = 6000) {
  const r = await rectOf(b, '.browser-holder');
  if (!r) throw new Error('no .browser-holder');
  const t0 = Date.now(); let c, img, tries = 0;
  do { img = grim(`${name}.png`); tries++; c = blockColor(img, Math.round(r.x), Math.round(r.y)); if (!want || near(c, want)) break; await sleep(350); } while (Date.now() - t0 < ms);
  return { color: c, tries, rect: r };
}
async function selectWorkspace(b, branch) {
  const idx = await b.cdp.eval(`[...document.querySelectorAll('.ws-item')].findIndex((e) => e.textContent.includes(${JSON.stringify(branch)}))`);
  if (idx < 0) throw new Error(`no sidebar row for ${branch}`);
  await clickSel(b, '.ws-item', idx);
  await waitFor(() => b.cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some((e) => e.textContent.includes(${JSON.stringify(branch)}))`), 15000, `${branch} to be the active workspace`);
  await sleep(500);
}
const chip = (b) => b.cdp.eval(`(() => { const e = document.querySelector('[data-browser-profile-chip]'); return e ? { id: e.dataset.profileId, label: e.textContent.trim() } : null; })()`);
/** Pick a profile ('' = ephemeral) in the URL-bar bar and wait for the chip to follow. */
async function chooseProfile(b, id) {
  if (!(await b.cdp.eval(`!!document.querySelector('[data-browser-profile-bar]')`))) await clickSel(b, '[data-browser-profile-chip]');
  await waitFor(() => b.cdp.eval(`!!document.querySelector('[data-browser-profile-bar]')`), 10000, 'the profile bar');
  await clickSel(b, `[data-profile-choice="${id}"]`);
  await waitFor(async () => (await chip(b))?.id === id, 20000, `the chip to show profile '${id}'`);
  await sleep(1200); // tabs rebuilt + reloaded
}
/** What the cookie jar of the tab showing `urlPart` holds, asked FROM that tab's page (same-origin /whoami → anon | <sid>). */
async function jarOf(b, urlPart) {
  const t = (await viewTargets(b)).find((x) => x.url.includes(urlPart));
  if (!t) return `<no tab target for ${urlPart}>`;
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  try { return await c.eval(`fetch('/whoami', { cache: 'no-store' }).then((r) => r.text())`); } catch (e) { return `<error ${String(e.message).slice(0, 80)}>`; } finally { c.close(); }
}
async function pageText(b, urlPart) {
  const t = (await viewTargets(b)).find((x) => x.url.includes(urlPart));
  if (!t) return null;
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  try { return await c.eval(`document.body ? document.body.innerText : ''`); } finally { c.close(); }
}
/** Run `expr` inside the page of the tab showing `urlPart` (awaits promises). */
async function evalIn(b, urlPart, expr) {
  const t = (await viewTargets(b)).find((x) => x.url.includes(urlPart));
  if (!t) return `<no tab target for ${urlPart}>`;
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  try { return await c.eval(expr); } catch (e) { return `<error ${String(e.message).slice(0, 80)}>`; } finally { c.close(); }
}
/** `expires` of the page's `sid` cookie in ms (null = a SESSION cookie), straight from the page's CookieStore. */
const sidExpiry = (b, urlPart) => evalIn(b, urlPart, `cookieStore.get('sid').then((c) => (c ? (c.expires ?? null) : 'absent'))`);
const SETTINGS_BTN = '[data-bp-open]';
async function openSettings(b) {
  await clickSel(b, SETTINGS_BTN);
  await waitFor(() => b.cdp.eval(`!!document.querySelector('[data-bp-settings]')`), 10000, 'Settings > Browser');
  await waitFor(() => b.cdp.eval(`!!document.querySelector('[data-bp-empty], .bp-list')`), 10000, 'the profile list to load');
  await sleep(300);
}
const closeSettings = async (b) => { await b.cdp.click(...(await (async () => { const r = await rectOf(b, '[data-bp-settings] .modal-actions button'); return [r.x, r.y]; })())); await waitFor(() => b.cdp.eval(`!document.querySelector('[data-bp-settings]')`), 10000, 'Settings to close'); await sleep(300); };
const rows = (b) => b.cdp.eval(`[...document.querySelectorAll('.bp-row')].map((e) => ({ id: e.dataset.profileId, name: e.dataset.profileName, meta: e.querySelector('.bp-meta')?.textContent.trim() }))`);
async function createProfile(b, name) {
  await typeInto(b, 'input[aria-label="New profile name"]', name);
  await clickSel(b, '[data-bp-create]');
  await sleep(500);
}
const idOf = async (b, name) => (await rows(b)).find((r) => r.name === name)?.id ?? null;

function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  return snap;
}

// ── agent-path probes ──────────────────────────────────────────────────────────────────────────────
function orch(world, args, wsId) {
  const sock = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
  const r = spawnSync(process.execPath, [path.join(APP_DIR, 'dist-electron', 'cli.js'), ...args], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ORCHESTRA_SOCK: sock, ...(wsId ? { ORCHESTRA_WS_ID: wsId } : {}) } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function postHooks(world, route, body) {
  const socketPath = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ socketPath, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: t })); });
    r.on('error', reject); r.end(payload);
  });
}
/** Run `snippet` in the MAIN process through the Node inspector (--inspect): a hidden window with node integration = a FOREIGN webContents. */
async function inMain(b, expression) {
  const list = await (await fetch(`http://127.0.0.1:${b.inspectPort}/json/list`)).json();
  const c = await Cdp.connect(list[0].webSocketDebuggerUrl);
  try {
    // includeCommandLineAPI exposes `require` (the DevTools-for-Node console API); `process.mainModule` is undefined under Electron's loader
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }, 30000);
    if (r.exceptionDetails) throw new Error(`main eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  } finally { c.close(); }
}
const FOREIGN_INVOKE = (calls) => `(async () => {
  const { BrowserWindow } = require('electron');
  const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  try {
    await w.loadURL('about:blank');
    const out = [];
    for (const [ch, ...args] of ${JSON.stringify(calls)}) {
      out.push(await w.webContents.executeJavaScript('require("electron").ipcRenderer.invoke(' + JSON.stringify(ch) + ',' + args.map((a) => JSON.stringify(a)).join(',') + ')'));
    }
    return JSON.stringify(out);
  } finally { w.destroy(); }
})()`;

// ═════════════════════════════════════ main ═════════════════════════════════════
const before = liveCanary();
const sitePort = await startSite();
const BASE = `http://127.0.0.1:${sitePort}`;
// every workspace gets its OWN urls (?ws=N): the views of a workspace that is not selected stay live debug targets, and a jar read must hit the right one
const P = (n, extra = '') => `${BASE}/profiles.html?ws=${n}${extra}`;
const A = (n) => `${BASE}/tabs-a.html?ws=${n}`;
const PQ = (n) => `/profiles.html?ws=${n}`;
const AQ = (n) => `/tabs-a.html?ws=${n}`;
const COLOR_P = [0x8e, 0x44, 0xad];
console.log(`[rig] app ${APP_DIR} label ${LABEL} arms ${[...ARMS].join(',')} out ${OUT}\n[rig] fixture: shared site (scripts/fixtures/browser-site/server.mjs) on ${BASE}`);
const world = seedWorld(path.join(RIG_DIR, 'world'));
let b = null;
const S = { staging: null, other: null, doomed: null }; // profile ids
const MAIN = ['settings', 'attach', 'human', 'restore', 'delete'].some((a) => ARMS.has(a));
try {
  // ────────────────────────────── boot 1 ──────────────────────────────
  if (MAIN) b = await boot(world, 'boot1', { inspect: ARMS.has('human') });
  const ws1 = world.ws1.id, ws2 = world.ws2.id;

  // ── settings: Settings > Browser ──
  if (MAIN) {
    await openSettings(b);
    const secrets = await b.cdp.eval(`window.orchestra.getSecretsState()`);
    clause('settings', 'ctl/empty-start', (await b.cdp.eval(`!!document.querySelector('[data-bp-empty]')`)) && (await rows(b)).length === 0 && profilesOnDisk(world).length === 0, `no profile yet in the dialog (${(await rows(b)).length} rows) nor on disk (${profilesOnDisk(world).length})`);
    clause('settings', 'ctl/secrets-state-read', typeof secrets?.encrypted === 'boolean', `getSecretsState() = ${JSON.stringify(secrets)} (the rig has no keyring: scratch ORCHESTRA_HOME skips the probe)`);
    const warn = await b.cdp.eval(`document.querySelector('[data-profile-warning="create"]')?.textContent ?? null`);
    clause('settings', 'unencrypted-storage-warning-shown-at-creation', secrets.encrypted === false ? !!warn && /not encrypted/.test(warn) : warn === null, `secrets.encrypted=${secrets.encrypted} → create form warning ${JSON.stringify(warn)} (warning iff not encrypted)`);

    await createProfile(b, 'Staging');
    S.staging = await idOf(b, 'Staging');
    clause('settings', 'create-adds-a-row-with-a-minted-id', /^bp-[0-9a-f]{12}$/.test(S.staging ?? ''), `row id ${S.staging}`);
    await softWait(() => profilesOnDisk(world).length === 1, 8000, 'the profile on disk');
    clause('settings', 'create-persists-in-the-store', safe(() => profilesOnDisk(world)[0].id === S.staging && profilesOnDisk(world)[0].name === 'Staging'), `store.json browserProfiles = ${JSON.stringify(profilesOnDisk(world))}`);
    const rowWarn = await b.cdp.eval(`!!document.querySelector('.bp-row [data-profile-unencrypted]')`);
    clause('settings', 'new-profile-row-carries-the-unencrypted-tag', secrets.encrypted === false ? rowWarn : !rowWarn, `row tag present=${rowWarn} (encrypted=${secrets.encrypted})`);

    await createProfile(b, 'staging'); // duplicate (case-insensitive)
    const err = await b.cdp.eval(`document.querySelector('[data-bp-error]')?.textContent ?? null`);
    clause('settings', 'duplicate-name-refused-with-a-message', !!err && /already exists/.test(err) && (await rows(b)).length === 1 && profilesOnDisk(world).length === 1, `error ${JSON.stringify(err)}; rows ${(await rows(b)).length}; disk ${profilesOnDisk(world).length}`);

    // rename keeps the id
    await clickSel(b, '[data-bp-rename]');
    await waitFor(() => b.cdp.eval(`!!document.querySelector('input[aria-label^="New name for"]')`), 8000, 'the rename input');
    await typeInto(b, 'input[aria-label^="New name for"]', 'Staging admin');
    await b.cdp.key('Enter', 'Enter', 13);
    await softWait(async () => (await rows(b))[0]?.name === 'Staging admin', 8000, 'the renamed row');
    await softWait(() => profilesOnDisk(world)[0]?.name === 'Staging admin', 8000, 'the rename on disk');
    clause('settings', 'rename-keeps-the-id-and-persists', safe(() => profilesOnDisk(world)[0].id === S.staging && profilesOnDisk(world)[0].name === 'Staging admin') && (await idOf(b, 'Staging admin')) === S.staging, `row ${JSON.stringify((await rows(b))[0])}; disk ${JSON.stringify(profilesOnDisk(world))}`);

    await createProfile(b, 'Other'); S.other = await idOf(b, 'Other');
    await createProfile(b, 'Doomed'); S.doomed = await idOf(b, 'Doomed');
    clause('settings', 'three-profiles-listed-and-stored', (await rows(b)).length === 3 && profilesOnDisk(world).length === 3 && new Set([S.staging, S.other, S.doomed]).size === 3, `rows ${JSON.stringify((await rows(b)).map((r) => [r.name, r.meta]))}`);
    saveShot('settings-renderer.png', await b.cdp.shot());
    await closeSettings(b);
  }

  // ── attach: the panel's URL bar ──
  if (ARMS.has('attach') || ARMS.has('human') || ARMS.has('restore') || ARMS.has('delete')) {
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await typeUrl(b, P(1));
    await waitFor(async () => (await tabs(b))[0]?.label.includes('Profiles fixture'), 20000, 'tab 1 to load the profiles fixture');
    await clickSel(b, '.browser-tab-new');
    await waitFor(async () => (await tabs(b)).length === 2, 10000, 'a 2nd tab');
    await typeUrl(b, A(1));
    await waitFor(async () => (await tabs(b))[1]?.label.includes('Tabs fixture A'), 20000, 'tab 2 to load fixture A');
    const preTabs = await tabs(b);
    const c0 = await chip(b);
    clause('attach', 'ctl/starts-ephemeral', c0.id === '' && /Ephemeral/.test(c0.label) && !wsRec(world, ws1).browserProfileId && partDirs(world).every((d) => !d.startsWith('orchestra-profile-')), `chip ${JSON.stringify(c0)}; ws1 record profile=${wsRec(world, ws1).browserProfileId ?? '<none>'}; Partitions on disk ${JSON.stringify(partDirs(world))}`);
    clause('attach', 'ephemeral-partition-is-not-on-disk', partDirs(world).every((d) => !d.startsWith('orchestra-browser-')), `Partitions/ entries ${JSON.stringify(partDirs(world))} — an ephemeral (non-persist:) partition leaves no directory`);
    const j0 = await jarOf(b, PQ(1));
    clause('attach', 'ctl/ephemeral-jar-is-signed-out', j0 === 'anon', `/whoami from tab 1 = ${j0}`);

    // open the bar: choices = Ephemeral + the 3 profiles
    await clickSel(b, '[data-browser-profile-chip]');
    await waitFor(() => b.cdp.eval(`!!document.querySelector('[data-browser-profile-bar]')`), 10000, 'the profile bar');
    const choices = await b.cdp.eval(`[...document.querySelectorAll('[data-profile-choice]')].map((e) => [e.dataset.profileChoice, e.textContent.trim(), e.getAttribute('aria-checked')])`);
    clause('attach', 'url-bar-lists-ephemeral-and-every-profile', choices.length === 4 && choices[0][0] === '' && choices[0][2] === 'true' && [S.staging, S.other, S.doomed].every((id) => choices.some((c) => c[0] === id)), `choices ${JSON.stringify(choices)}`);
    saveShot('chip-bar-renderer.png', await b.cdp.shot());

    await chooseProfile(b, S.staging);
    const c1 = await chip(b);
    clause('attach', 'chip-shows-the-attached-profile', c1.id === S.staging && /Staging admin/.test(c1.label), `chip ${JSON.stringify(c1)}`);
    clause('attach', 'attach-records-the-profile-on-the-workspace', wsRec(world, ws1).browserProfileId === S.staging && !wsRec(world, ws2).browserProfileId, `store.json ws1.browserProfileId=${wsRec(world, ws1).browserProfileId}; ws2=${wsRec(world, ws2).browserProfileId ?? '<none>'}`);
    const postTabs = await tabs(b);
    clause('attach', 'every-tab-is-rebuilt-in-place-same-ids-and-urls', safe(() => postTabs.length === 2 && postTabs.map((t) => t.id).join() === preTabs.map((t) => t.id).join() && postTabs.map((t) => t.tip).join() === preTabs.map((t) => t.tip).join() && postTabs.findIndex((t) => t.active) === preTabs.findIndex((t) => t.active)), `before ${JSON.stringify(preTabs.map((t) => [t.id, t.tip, t.active]))} → after ${JSON.stringify(postTabs.map((t) => [t.id, t.tip, t.active]))}`);
    await softWait(async () => (await viewTargets(b)).length === 2 && (await viewTargets(b)).every((t) => t.url.startsWith('http')), 15000, 'two live loaded views');
    clause('attach', 'no-view-leaked-by-the-rebuild', (await viewTargets(b)).length === 2, `page targets besides the app renderer = ${(await viewTargets(b)).length} (2 tabs → 2 views; a leak would show 4)`);
    // the ACTIVE tab (2) is fixture A (red): the rebuilt, re-composited view must be on screen
    const wantA = [0xd6, 0x27, 0x28];
    const pA = await holderColor(b, 'attach-painted-A', wantA, 8000);
    clause('attach', 'rebuilt-active-view-is-painted-on-screen', near(pA.color, wantA), `compositor pixel at the page area = ${hex(pA.color)} (want fixture A ${hex(wantA)}; ${pA.tries} grim tries)`);
    saveShot('attached-renderer.png', await b.cdp.shot());
    grim('attached-compositor.png');

    // sign in on the ACTIVE tab (2): every tab of the workspace shares the profile's jar
    await typeUrl(b, `${BASE}/signin`);
    await softWait(async () => (await pageText(b, '/signin'))?.startsWith('signed-in'), 15000, 'sign-in page');
    const sid = ((await pageText(b, '/signin')) ?? '').replace('signed-in ', '').trim();
    await typeUrl(b, A(1)); // back to the fixture so tab 2 has a normal page
    await softWait(async () => (await tabs(b))[1]?.label.includes('Tabs fixture A'), 15000, 'tab 2 back on fixture A');
    const jar1 = await jarOf(b, PQ(1)), jar2 = await jarOf(b, AQ(1));
    S.sid1 = sid;
    clause('attach', 'one-sign-in-is-shared-by-all-the-tabs', /^[0-9a-f]{16}$/.test(sid) && jar1 === sid && jar2 === sid, `signed in on tab 2 (sid ${sid}); /whoami from tab 1 = ${jar1}, tab 2 = ${jar2}`);
    // the SIGN-IN itself must land in the profile's persistent cookie DB (the partition DIRECTORY alone proves nothing: merely asking Electron for the session creates it)
    let rows1 = null;
    await softWait(() => { rows1 = cookieRows(world, S.staging); return Array.isArray(rows1) && rows1.some((r) => r[1] === 'sid'); }, 12000, 'the sign-in in the profile cookie DB');
    clause('attach', 'profile-partition-holds-the-sign-in-on-disk', Array.isArray(rows1) && rows1.some((r) => r[1] === 'sid') && partDirs(world).every((d) => !d.startsWith('orchestra-browser-')), `Partitions/ = ${JSON.stringify(partDirs(world))}; cookie DB of "Staging admin" (copy) = ${JSON.stringify(rows1)}`);

    // a second workspace WITHOUT the profile is signed out
    await selectWorkspace(b, 'e2e/bp400-2');
    await openBrowserPane(b);
    await typeUrl(b, P(2));
    await waitFor(async () => (await tabs(b))[0]?.label.includes('Profiles fixture'), 20000, 'ws2 tab 1 to load');
    const c2 = await chip(b), j2 = await jarOf(b, PQ(2));
    clause('attach', 'second-workspace-without-the-profile-is-signed-out', c2.id === '' && j2 === 'anon', `ws2 chip ${JSON.stringify(c2)}; /whoami = ${j2} (ws1 is signed in as ${sid})`);
    // …and WITH the profile it shares the sign-in (one profile, several workspaces)
    await chooseProfile(b, S.staging);
    const j2b = await jarOf(b, PQ(2));
    clause('attach', 'two-workspaces-share-one-profile-and-its-sign-in', j2b === sid && wsRec(world, ws2).browserProfileId === S.staging, `ws2 attached to the same profile: /whoami = ${j2b} (want ${sid}); record ${wsRec(world, ws2).browserProfileId}`);
    // detach returns it to navigation éphémère; ws1 keeps its sign-in
    await chooseProfile(b, '');
    const j2c = await jarOf(b, PQ(2));
    clause('attach', 'detach-returns-to-ephemeral-signed-out', j2c === 'anon' && !wsRec(world, ws2).browserProfileId && (await chip(b)).id === '', `after detach: /whoami = ${j2c}; ws2 record profile=${wsRec(world, ws2).browserProfileId ?? '<none>'}`);
    // the RENDERER's own view of who carries the profile (Settings counts from its workspace store): a detach must reach it
    await openSettings(b);
    const usage = (await rows(b)).find((r) => r.id === S.staging)?.meta ?? null;
    await closeSettings(b);
    clause('attach', 'settings-usage-count-follows-a-detach', /^1 workspace\b/.test(usage ?? ''), `Settings row "Staging admin" says ${JSON.stringify(usage)} after ws2 detached (ws1 still carries it; a stale record in the renderer would say 2 workspaces)`);
    await selectWorkspace(b, 'e2e/bp400-1');
    await sleep(800);
    const j1b = await jarOf(b, PQ(1));
    clause('attach', 'detaching-one-workspace-leaves-the-others-sign-in', j1b === sid, `ws1 /whoami = ${j1b} (want ${sid})`);
    // switch ws1 to another profile (its own, empty jar), then back
    await chooseProfile(b, S.other);
    const jo = await jarOf(b, PQ(1));
    await chooseProfile(b, S.staging);
    const jb = await jarOf(b, PQ(1));
    clause('attach', 'switching-profile-switches-the-jar', jo === 'anon' && jb === sid, `on "Other": ${jo}; back on "Staging admin": ${jb} (want anon then ${sid})`);
  }

  // ── human: no agent path can attach / switch / create ──
  if (ARMS.has('human')) {
    const stateBefore = JSON.stringify({ ws: readStore(world).workspaces.map((w) => [w.id, w.browserProfileId ?? null]), profiles: profilesOnDisk(world) });
    await selectWorkspace(b, 'e2e/bp400-2');
    const ctlPeers = orch(world, ['peers'], ws2);
    clause('human', 'ctl/cli-reaches-the-app', ctlPeers.code === 0, `orchestra peers → rc ${ctlPeers.code} (the instrument can reach the app's socket)`);
    const verbs = [['browser', 'profile', 'attach', S.staging], ['profile', 'attach', S.staging], ['browser', 'attach-profile', S.staging], ['browser', 'use-profile', S.staging], ['profiles', 'create', 'Evil'], ['browser', 'profile', 'create', 'Evil']];
    const verbRes = verbs.map((v) => ({ v: v.join(' '), ...orch(world, v, ws2) }));
    clause('human', 'cli-has-no-profile-verb', verbRes.every((r) => r.code !== 0), `orchestra <verb> → rc ${verbRes.map((r) => `${r.v}: ${r.code}`).join(' | ')}`);
    const routes = ['/browserProfileAttach', '/profile', '/browser/profile', '/attachProfile', '/browserProfiles/create'];
    const routeRes = [];
    for (const r of routes) routeRes.push({ r, ...(await postHooks(world, r, { id: ws2, profileId: S.staging, name: 'Evil', from: ws2 })) });
    const ctlRoute = await postHooks(world, '/whoami', { id: ws2 });
    clause('human', 'ctl/socket-answers-a-real-route', ctlRoute.status === 200 && /"ok":\s*true/.test(ctlRoute.body), `POST /whoami → ${ctlRoute.status} ${ctlRoute.body.slice(0, 80)}`);
    clause('human', 'socket-has-no-profile-route', routeRes.every((x) => x.status === 200 && x.body.trim() === '{}'), `unknown routes answer an empty {}: ${routeRes.map((x) => `${x.r}: ${x.status} ${x.body.slice(0, 20)}`).join(' | ')}`);
    // the agent's own page: no bridge at all
    await openBrowserPane(b);
    const pageHasBridge = async () => { const t = (await viewTargets(b))[0]; if (!t) return '<no target>'; const c = await Cdp.connect(t.webSocketDebuggerUrl); try { return await c.eval(`JSON.stringify([typeof window.orchestra, typeof require, typeof process, typeof ipcRenderer])`); } finally { c.close(); } };
    const pb = await pageHasBridge();
    const rendererBridge = await b.cdp.eval(`typeof window.orchestra`);
    clause('human', 'agents-page-has-no-ipc-bridge', pb === '["undefined","undefined","undefined","undefined"]' && rendererBridge === 'object', `panel page: ${pb}; app renderer: typeof window.orchestra = ${rendererBridge} (control)`);
    // a FOREIGN webContents (not the app window) invokes every write channel
    const foreign = JSON.parse(await inMain(b, FOREIGN_INVOKE([
      ['browser:profileAttach', ws2, S.staging],
      ['browser:profileAttach', ws1, null],
      ['browserProfiles:create', 'Evil'],
      ['browserProfiles:rename', S.staging, 'Evil'],
      ['browserProfiles:delete', S.other],
      ['browserProfiles:list'],
    ])));
    const refusedAll = foreign.slice(0, 5).every((r) => r && r.ok === false && r.reason === 'not-human');
    clause('human', 'foreign-webcontents-refused-on-every-write-channel', refusedAll, `attach/attach/create/rename/delete from a hidden foreign window → ${JSON.stringify(foreign.slice(0, 5).map((r) => r && [r.ok, r.reason]))}`);
    clause('human', 'foreign-webcontents-can-still-read-the-list', Array.isArray(foreign[5]) && foreign[5].length === 3, `browserProfiles:list from the foreign window → ${JSON.stringify(foreign[5]?.map?.((p) => p.name))}`);
    await sleep(800);
    const stateAfter = JSON.stringify({ ws: readStore(world).workspaces.map((w) => [w.id, w.browserProfileId ?? null]), profiles: profilesOnDisk(world) });
    const j2d = await jarOf(b, PQ(2));
    clause('human', 'nothing-moved-after-every-agent-path-attempt', stateBefore === stateAfter && j2d === 'anon' && (await chip(b)).id === '', `store (workspaces' profile ids + profiles) identical before/after: ${stateBefore === stateAfter}; ws2 chip ${JSON.stringify(await chip(b))}; ws2 jar ${j2d}`);
    // control: the app's OWN window can attach (so the refusals above are about the SENDER, not a dead channel)
    const own = await b.cdp.eval(`window.orchestra.browserProfileAttach(${JSON.stringify(ws2)}, ${JSON.stringify(S.staging)}).then((r) => ({ ok: r.ok, profileId: r.state?.profileId ?? null }))`);
    clause('human', 'ctl/the-apps-own-window-can-attach', own.ok === true && own.profileId === S.staging && wsRec(world, ws2).browserProfileId === S.staging, `window.orchestra.browserProfileAttach → ${JSON.stringify(own)}; record ${wsRec(world, ws2).browserProfileId}`);
    await b.cdp.eval(`window.orchestra.browserProfileAttach(${JSON.stringify(ws2)}, null)`);
    await sleep(800);
    await selectWorkspace(b, 'e2e/bp400-1');
  }

  // ── restore prep: write storage, graceful quit ──
  if (ARMS.has('restore')) {
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await clickSel(b, '.browser-tab', 0);
    await waitFor(async () => (await tabs(b))[0]?.active, 8000, 'tab 1 active');
    await typeUrl(b, P(1, '&w=1#set')); // full load (the query differs): the page script writes the storage
    await sleep(1500);
    await typeUrl(b, P(1, '&w=2')); // plain reload: what it shows is what is in the jar, and the URL that gets restored does NOT rewrite it
    await softWait(async () => /"cookie"/.test((await pageText(b, '&w=2')) ?? ''), 15000, 'the readback page');
    const t0 = await pageText(b, '&w=2');
    clause('restore', 'ctl/storage-written-before-quit', /sess=1/.test(t0 ?? '') && /perm=1/.test(t0 ?? '') && /ls1/.test(t0 ?? ''), `profiles.html?ws=1&w=2 (no #set) shows ${JSON.stringify(t0)}`);
    // ws2 gets a DANGLING profile id behind the app's back (a deleted profile still recorded): it must read as ephemeral at the next boot
    S.tabsBeforeQuit = (await tabs(b)).map((t) => [t.id, t.tip, t.active]);
    await sleep(2500); // past the cookie flush
    await teardown(b, 'graceful'); b = null;
    const st = readStore(world);
    st.workspaces.find((w) => w.id === ws2).browserProfileId = 'bp-ffffffffffff';
    fs.writeFileSync(world.storeFile, JSON.stringify(st, null, 2));

    // ────────────── boot 2 ──────────────
    b = await boot(world, 'boot2');
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await softWait(async () => (await tabs(b)).length === 2 && (await viewTargets(b)).filter((t) => t.url.startsWith('http')).length === 2, 25000, 'both restored tabs to load');
    const rt = (await tabs(b)).map((t) => [t.id, t.tip, t.active]);
    const c = await chip(b);
    clause('restore', 'restored-tabs-keep-profile-and-url', JSON.stringify(rt.map((t) => [t[1], t[2]])) === JSON.stringify(S.tabsBeforeQuit.map((t) => [t[1], t[2]])) && c.id === S.staging, `tabs before quit ${JSON.stringify(S.tabsBeforeQuit.map((t) => [t[1], t[2]]))}; restored ${JSON.stringify(rt.map((t) => [t[1], t[2]]))}; chip ${JSON.stringify(c)}`);
    const jr1 = await jarOf(b, '/profiles.html?ws=1'), jr2 = await jarOf(b, AQ(1));
    clause('restore', 'restored-tabs-come-back-signed-in', S.sid1 && jr1 === S.sid1 && jr2 === S.sid1, `after the restart /whoami from both restored tabs = ${jr1} / ${jr2} (signed in as ${S.sid1})`);
    const ptxt = await pageText(b, '/profiles.html?ws=1');
    clause('restore', 'persistent-cookie-and-localstorage-survive-the-restart', /perm=1/.test(ptxt ?? '') && /ls1/.test(ptxt ?? ''), `restored profiles.html shows ${JSON.stringify(ptxt)}`);
    clause('restore', 'session-cookie-survives-the-restart-in-a-profile', /sess=1/.test(ptxt ?? ''), `restored profiles.html shows ${JSON.stringify(ptxt)} (the page wrote \`sess=1\` WITHOUT an expiry before the quit — Electron alone drops those)`);
    const dbRows = cookieRows(world, S.staging);
    const sessRow = Array.isArray(dbRows) ? dbRows.find((r) => r[1] === 'sess') : null;
    const sessDays = sessRow ? (sessRow[3] / 1e6 - 11644473600 - Date.now() / 1000) / 86400 : null;
    clause('restore', 'promoted-session-cookie-is-persistent-for-30-days-in-the-cookie-db', !!sessRow && sessRow[2] === 1 && sessDays > 29 && sessDays < 31, `cookie DB row ${JSON.stringify(sessRow)} → expires in ${sessDays === null ? 'n/a' : sessDays.toFixed(2)} days`);
    // the other workspace: signed out, dangling id → ephemeral
    await selectWorkspace(b, 'e2e/bp400-2');
    await openBrowserPane(b);
    await typeUrl(b, P(2));
    await waitFor(async () => (await tabs(b))[0]?.label.includes('Profiles fixture'), 20000, 'ws2 tab to load');
    const c2 = await chip(b), jr3 = await jarOf(b, PQ(2));
    clause('restore', 'workspace-without-the-profile-is-signed-out-after-restart', jr3 === 'anon', `ws2 /whoami = ${jr3}`);
    clause('restore', 'dangling-profile-id-reads-as-ephemeral', c2.id === '' && partDirs(world).every((d) => d !== 'orchestra-profile-bp-ffffffffffff'), `ws2 records bp-ffffffffffff (no such profile): chip ${JSON.stringify(c2)}; Partitions ${JSON.stringify(partDirs(world))}`);
    saveShot('restored-renderer.png', await b.cdp.shot());
    // a NEW sign-in, then SIGKILL a few seconds later: the cookie store must have been flushed on change
    await selectWorkspace(b, 'e2e/bp400-1');
    await typeUrl(b, `${BASE}/signin`);
    await softWait(async () => (await pageText(b, '/signin'))?.startsWith('signed-in'), 15000, 'sign-in page');
    S.sid2 = ((await pageText(b, '/signin')) ?? '').replace('signed-in ', '').trim();
    clause('restore', 'ctl/new-sign-in-differs', /^[0-9a-f]{16}$/.test(S.sid2) && S.sid2 !== S.sid1, `second sign-in sid ${S.sid2} ≠ first ${S.sid1}`);
    await typeUrl(b, P(1, '&w=3')); // leave /signin: restoring that URL would sign in AGAIN (every GET /signin mints a sid) and fake the oracle
    await softWait(async () => (await tabs(b))[0]?.tip?.includes('&w=3'), 15000, 'tab 1 off /signin');
    await sleep(4000); // > the 1.5 s change-flush, < Chromium's own 30 s timer
    await teardown(b, 'kill9'); b = null;

    // ────────────── boot 3 ──────────────
    b = await boot(world, 'boot3');
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await softWait(async () => (await viewTargets(b)).filter((t) => t.url.startsWith('http')).length >= 2, 25000, 'restored views');
    await sleep(2000);
    const jk = await jarOf(b, AQ(1));
    clause('restore', 'sign-in-made-seconds-before-a-sigkill-survives', jk === S.sid2, `after SIGKILL + restart /whoami = ${jk} (want the second sign-in ${S.sid2}; the first was ${S.sid1})`);
  }

  // ── delete ──
  if (ARMS.has('delete')) {
    if (!b) { b = await boot(world, 'boot-delete'); }
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await typeUrl(b, P(1));
    await waitFor(async () => (await tabs(b)).some((t) => t.label.includes('Profiles fixture')), 20000, 'a profiles fixture tab');
    if (!S.staging) { // arm run alone: recover ids from the store
      const ps = profilesOnDisk(world); S.staging = ps.find((p) => p.name === 'Staging admin')?.id; S.doomed = ps.find((p) => p.name === 'Doomed')?.id;
    }
    // both workspaces on "Doomed", signed in there
    await chooseProfile(b, S.doomed);
    await typeUrl(b, `${BASE}/signin`);
    await softWait(async () => (await pageText(b, '/signin'))?.startsWith('signed-in'), 15000, 'sign-in page');
    S.sidD = ((await pageText(b, '/signin')) ?? '').replace('signed-in ', '').trim();
    await typeUrl(b, P(1));
    await softWait(async () => (await tabs(b)).some((t) => t.label.includes('Profiles fixture')), 15000, 'fixture back');
    await selectWorkspace(b, 'e2e/bp400-2');
    await openBrowserPane(b);
    await typeUrl(b, A(2));
    await softWait(async () => (await tabs(b))[0]?.label.includes('Tabs fixture A'), 15000, 'ws2 fixture A');
    await chooseProfile(b, S.doomed);
    const jd2 = await jarOf(b, AQ(2));
    clause('delete', 'ctl/both-workspaces-signed-in-on-the-doomed-profile', jd2 === S.sidD && wsRec(world, world.ws1.id).browserProfileId === S.doomed && wsRec(world, world.ws2.id).browserProfileId === S.doomed, `ws2 /whoami = ${jd2} (sid ${S.sidD}); records ws1=${wsRec(world, world.ws1.id).browserProfileId} ws2=${wsRec(world, world.ws2.id).browserProfileId}`);
    await sleep(3500); // cookie flush
    const rowsBefore = cookieRows(world, S.doomed);
    clause('delete', 'ctl/cookie-db-holds-the-sign-in-before-the-delete', Array.isArray(rowsBefore) && rowsBefore.some((r) => r[1] === 'sid'), `cookie DB of the profile (copy) = ${JSON.stringify(rowsBefore)} — the on-disk oracle can SEE a sign-in`);
    const stagingBefore = S.staging ? cookieRows(world, S.staging) : null;
    await selectWorkspace(b, 'e2e/bp400-1');
    const tabsBeforeDelete1 = (await tabs(b)).map((t) => t.tip);
    await selectWorkspace(b, 'e2e/bp400-2');
    const tabsBeforeDelete2 = (await tabs(b)).map((t) => t.tip);

    await openSettings(b);
    const rowCount = (await rows(b)).length;
    const doomedIdx = (await rows(b)).findIndex((r) => r.id === S.doomed);
    await clickSel(b, '[data-bp-delete]', doomedIdx);
    await waitFor(() => b.cdp.eval(`!!document.querySelector('.dialog-actions .danger-primary')`), 8000, 'the delete confirmation');
    const detail = await b.cdp.eval(`document.querySelector('.dialog-detail')?.textContent ?? ''`);
    clause('delete', 'confirmation-names-the-workspaces-that-lose-it', /2 workspaces/.test(detail), `confirm detail: ${JSON.stringify(detail)}`);
    saveShot('delete-confirm-renderer.png', await b.cdp.shot());
    await clickSel(b, '.dialog-actions .danger-primary');
    await softWait(async () => (await rows(b)).length === rowCount - 1, 15000, 'the row to disappear');
    clause('delete', 'profile-gone-from-dialog-and-store', (await rows(b)).every((r) => r.id !== S.doomed) && profilesOnDisk(world).every((p) => p.id !== S.doomed), `rows ${JSON.stringify((await rows(b)).map((r) => r.name))}; disk ${JSON.stringify(profilesOnDisk(world).map((p) => p.name))}`);
    await closeSettings(b);
    clause('delete', 'carriers-detached-in-the-store', !wsRec(world, world.ws1.id).browserProfileId && !wsRec(world, world.ws2.id).browserProfileId, `ws1=${wsRec(world, world.ws1.id).browserProfileId ?? '<none>'} ws2=${wsRec(world, world.ws2.id).browserProfileId ?? '<none>'}`);
    await sleep(1500);
    const cw2 = await chip(b), jw2 = await jarOf(b, AQ(2));
    const tabsAfter2 = (await tabs(b)).map((t) => t.tip);
    clause('delete', 'open-workspace-tabs-reload-ephemeral-and-signed-out', cw2.id === '' && jw2 === 'anon' && JSON.stringify(tabsAfter2) === JSON.stringify(tabsBeforeDelete2), `ws2 (open): chip ${JSON.stringify(cw2)}, /whoami = ${jw2}; tabs ${JSON.stringify(tabsBeforeDelete2)} → ${JSON.stringify(tabsAfter2)}`);
    await selectWorkspace(b, 'e2e/bp400-1');
    await sleep(1200);
    const cw1 = await chip(b), jw1 = await jarOf(b, PQ(1)), tabsAfter = (await tabs(b)).map((t) => t.tip);
    clause('delete', 'other-workspace-detached-too-tabs-kept', cw1.id === '' && jw1 === 'anon' && JSON.stringify(tabsAfter) === JSON.stringify(tabsBeforeDelete1), `ws1: chip ${JSON.stringify(cw1)}, /whoami = ${jw1}; tabs ${JSON.stringify(tabsBeforeDelete1)} → ${JSON.stringify(tabsAfter)}`);
    let rowsAfter = null;
    await softWait(() => { rowsAfter = cookieRows(world, S.doomed); return Array.isArray(rowsAfter) && rowsAfter.length === 0; }, 15000, 'the profile cookie DB to be emptied');
    clause('delete', 'partition-storage-cleared-on-disk', Array.isArray(rowsAfter) && rowsAfter.length === 0, `cookie DB of the deleted profile (copy): ${JSON.stringify(rowsAfter)} (was ${JSON.stringify(rowsBefore)})`);
    if (S.staging && Array.isArray(stagingBefore)) {
      const stagingAfter = cookieRows(world, S.staging);
      clause('delete', 'another-profile-is-untouched', Array.isArray(stagingAfter) && stagingAfter.some((r) => r[1] === 'sid') && stagingAfter.length === stagingBefore.length, `Staging admin cookie DB before ${JSON.stringify(stagingBefore)} / after ${JSON.stringify(stagingAfter)}`);
    }
    await teardown(b, 'term'); b = null;
  }
  // ── flush: a sign-in made seconds before a SIGKILL survives (the cookie store is flushed on change, not on Chromium's 30 s timer) ──
  if (ARMS.has('flush')) {
    if (b) { await teardown(b, 'term'); b = null; }
    b = await boot(world, 'boot-flush');
    const made = await b.cdp.eval(`window.orchestra.browserProfileCreate('Flush').then((r) => r.profile?.id ?? null)`);
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await chooseProfile(b, made);
    await typeUrl(b, `${BASE}/signin`);
    await softWait(async () => (await pageText(b, '/signin'))?.startsWith('signed-in'), 15000, 'sign-in page');
    const sidF = ((await pageText(b, '/signin')) ?? '').replace('signed-in ', '').trim();
    await typeUrl(b, P(1, '&f=1')); // leave /signin: restoring that URL would sign in AGAIN
    await softWait(async () => (await tabs(b))[0]?.tip?.includes('&f=1'), 15000, 'tab 1 off /signin');
    await sleep(9000); // > the 1.5 s change-flush with a wide margin for a loaded host, < Chromium's own 30 s timer
    await teardown(b, 'kill9'); b = null;
    b = await boot(world, 'boot-flush2');
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await softWait(async () => (await viewTargets(b)).some((t) => t.url.includes('&f=1')), 25000, 'the restored view');
    await sleep(1500);
    const jf = await jarOf(b, '/profiles.html?ws=1');
    clause('flush', 'sign-in-made-9s-before-a-sigkill-survives', /^[0-9a-f]{16}$/.test(sidF) && jf === sidF, `signed in as ${sidF}; SIGKILL 9 s later; after the restart /whoami = ${jf}`);
    await teardown(b, 'term'); b = null;
  }
  // ── session: a SESSION-cookie sign-in (no expiry) survives a restart in a profile; the workspace without one does not (OPS ruling) ──
  if (ARMS.has('session')) {
    if (b) { await teardown(b, 'term'); b = null; }
    b = await boot(world, 'boot-session');
    const made = await b.cdp.eval(`window.orchestra.browserProfileCreate('Session').then((r) => r.profile?.id ?? null)`);
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await chooseProfile(b, made);
    await typeUrl(b, P(1, '&signin=session'));
    await softWait(async () => /sid=sess/.test((await pageText(b, '&signin=session')) ?? ''), 15000, 'the session sign-in page');
    const sidS = (/sid=(sess[0-9a-f]+)/.exec((await pageText(b, '&signin=session')) ?? '') ?? [])[1];
    const expProfile = await sidExpiry(b, '&signin=session');
    const daysAhead = typeof expProfile === 'number' ? (expProfile - Date.now()) / 86400000 : null;
    // control: the SAME page + cookie in a workspace WITHOUT a profile stays a true session cookie (expires = null) — so the promotion is what differs
    await selectWorkspace(b, 'e2e/bp400-2');
    await openBrowserPane(b);
    await typeUrl(b, P(2, '&signin=session'));
    await softWait(async () => /sid=sess/.test((await pageText(b, 'ws=2&signin=session')) ?? ''), 15000, 'ws2 session sign-in page');
    const expEph = await sidExpiry(b, 'ws=2&signin=session');
    clause('session', 'ctl/the-same-cookie-is-a-session-cookie-without-a-profile', expEph === null, `ws2 (ephemeral) cookieStore sid.expires = ${JSON.stringify(expEph)} (null = session)`);
    clause('session', 'profile-session-cookie-gets-a-30-day-expiry', daysAhead !== null && daysAhead > 29 && daysAhead < 31, `ws1 (profile) cookieStore sid.expires = ${JSON.stringify(expProfile)} → ${daysAhead === null ? 'n/a' : daysAhead.toFixed(2)} days ahead (sid ${sidS})`);
    await sleep(2500); // the change-flush
    await teardown(b, 'graceful'); b = null;
    b = await boot(world, 'boot-session2');
    await selectWorkspace(b, 'e2e/bp400-1');
    await openBrowserPane(b);
    await softWait(async () => (await viewTargets(b)).some((t) => t.url.includes('&signin=session')), 25000, 'the restored view');
    await sleep(1500);
    const jS1 = await jarOf(b, '&signin=session');
    clause('session', 'session-cookie-sign-in-survives-the-restart', !!sidS && jS1 === sidS, `after the restart /whoami = ${jS1} (signed in with the session cookie ${sidS})`);
    await selectWorkspace(b, 'e2e/bp400-2');
    await openBrowserPane(b);
    await softWait(async () => (await viewTargets(b)).some((t) => t.url.includes('ws=2&signin=session')), 25000, 'ws2 view');
    await typeUrl(b, P(2));
    await softWait(async () => (await tabs(b))[0]?.label.includes('Profiles fixture'), 15000, 'ws2 plain page');
    const jS2 = await jarOf(b, PQ(2));
    clause('session', 'workspace-without-the-profile-is-signed-out-after-the-restart', jS2 === 'anon', `ws2 /whoami = ${jS2}`);
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
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const red = results.filter((c) => !c.ok);
console.log(`\nVERDICT: ${red.length ? `RED: ${red.map((c) => `[${c.arm}] ${c.clause}`).join('; ')}` : `ALL GREEN: ${results.length} clauses`}`);
process.exit(red.length ? 1 : 0);
