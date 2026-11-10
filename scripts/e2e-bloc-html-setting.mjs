// Bloc HTML switch (#418) driven in a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway, scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR.
//   launch 1 (fresh store, no key): default ON → open the dialog from the sidebar header → switch reads ON → one trusted click → OFF (host echo, store.json on disk, store state) → Done.
//   launch 2 (SAME ORCHESTRA_HOME, a restart): still OFF (persisted; the default would read ON) → click → ON, on disk true.
//   launch 3 (a seeded workspace, a replayed reply holding a bloc): ON → one iframe; the dialog click flips it to a CODE BLOCK in the SAME page (no restart, same pid, a page marker survives); back → the frame returns.
//   launch 3m (always run, anchor found by shape in the built bundle): the same on a COPY whose hook ignores the setting — the OFF step must stay a frame, the must-FAIL arm of the clause.
// The instruction half (the model's context, new / resumed / running / sub-agent) is NOT here: scripts/session-budget/bloc-html.mjs.
//
// Usage (via scripts/e2e-bloc-html-setting.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { handedEnvProblems, privateRuntimeDir } from './lib/rig-runtime.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', 'bhs');
// the must-FAIL arm (always run): the hook's read of the setting, found in the built bundle by a stable shape (a minified name moves), replaced on a disposable copy
const HOOK_SHAPE = /function [\w$]+\(\)\{return ([\w$]+)\((\w+)=>\2\.blocHtmlEnabled\)\}/;
function findHookMutant() {
  const dir = path.join(APP_DIR, 'dist', 'assets');
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).flatMap((f) => { const m = HOOK_SHAPE.exec(fs.readFileSync(path.join(dir, f), 'utf8')); return m ? [m[0]] : []; });
  if (hits.length !== 1) refuse(`the hook's read of the setting was found ${hits.length}x in the built bundle (want 1) — the must-FAIL arm cannot be built`);
  return { from: hits[0], to: hits[0].replace(/\)\}$/, ')||!0}') };
}
const HOOK_MUTANT = findHookMutant();
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-bloc-html-setting.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const XDG = privateRuntimeDir();
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard: nothing this driver hands the app may be a live dir ─────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config'), path.join(LIVE_HOME, '.local')].map(real);
function checkScratch(p) {
  const r = real(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.local/bin')), b = checkScratch('/usr/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.local/bin -> ${a.clause} · /usr path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(100); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  async click(x, y) { await this.move(x, y); for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
  async key(key, code, vk) { for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); }
  async shot(clip) { const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }


function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  for (const d of [fakeHome, ohome, cfg]) { fs.mkdirSync(d, { recursive: true }); mustBeScratch('world dir', d); }
  const account = { id: 'rig-bhs', label: 'rig (scratch config dir)', configDir: cfg };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  if (!fs.existsSync(storeFile)) fs.writeFileSync(storeFile, JSON.stringify({ repos: [], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stored = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')).blocHtmlEnabled; } catch { return 'unreadable'; } };
  return { fakeHome, ohome, cfg, stored };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}

const dom = (cdp) => cdp.eval(`(() => {
  const q = (s) => document.querySelector(s), R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const sw = q('[data-bloc-html-switch]'), btn = q('[data-bloc-html-open]'), modal = q('.bloc-html-settings');
  return { vw: innerWidth, vh: innerHeight, btn: R(btn), modal: R(modal), title: modal && modal.querySelector('h2').textContent,
    sw: sw && { state: sw.getAttribute('data-live-state'), checked: sw.getAttribute('aria-checked'), role: sw.getAttribute('role'), label: sw.querySelector('.sound-name').textContent, r: R(sw) } };
})()`);
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
const inside = (r, d) => r.left >= 0 && r.top >= 0 && r.right <= d.vw && r.bottom <= d.vh;

const ARM_DIR = path.join(RIG_DIR, 'arm');
fs.mkdirSync(ARM_DIR, { recursive: true });
const world = seedWorld(ARM_DIR);

async function launch(label) {
  const port = await freePort();
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  const handed = handedEnvProblems(env, { ohome: world.ohome, cfg: world.cfg, home: world.fakeHome, wayland: RIG_WAYLAND, xdg: XDG, noBusPath: path.join(RIG_DIR, 'no-session-bus') });
  if (handed.length) refuse(`child env: ${handed.join('; ')}`);
  const logFile = path.join(ARM_DIR, `app-${label}.log`); const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`\n== launch ${label}: app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  const stop = async () => {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2500);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause(`${label}/teardown-no-survivors`, left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  };
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
    clause(`${label}/ctl-app-identity-path`, target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!document.querySelector('[data-bloc-html-open]')`), 60000, 'the Bloc HTML header button');
    const srcs = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`); const bundle = srcs.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id; const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
    clause(`${label}/ctl-app-identity-bundle`, !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)) && served.toString('utf8').includes('data-bloc-html-switch'), `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file, and contains the switch marker`);
    const version = await cdp.eval(`window.orchestra.getAppVersion ? window.orchestra.getAppVersion() : null`).catch(() => null);
    const built = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    clause(`${label}/ctl-app-identity-version`, version === built, `running app says ${version}, built tree is ${built}`);
    clause(`${label}/ctl-app-in-my-sway`, new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} in my sway's get_tree`);
    const accounts = await cdp.eval(`window.orchestra.listAccounts().then((a) => a.map((x) => x.id))`).catch((e) => String(e));
    clause(`${label}/ctl-scratch-world`, JSON.stringify(accounts) === '["rig-bhs"]', `accounts the running app lists: ${JSON.stringify(accounts)} (the seeded scratch store; configDir ${world.cfg})`);
    return { app, cdp, stop };
  } catch (e) { await stop(); throw e; }
}

const settled = (cdp, pred, what, ms = 10000) => waitFor(async () => { const d = await dom(cdp); return pred(d) ? d : null; }, ms, what);
async function openDialog(cdp) {
  const d0 = await dom(cdp);
  await cdp.click(...centre(d0.btn));
  return settled(cdp, (d) => d.sw, 'the Bloc HTML dialog');
}

async function launch1() {
  const L = await launch('L1');
  const { cdp } = L;
  try {
    const pre = { disk: world.stored(), ipc: await cdp.eval(`window.orchestra.blocHtmlEnabled()`) };
    clause('L1/default-on', pre.disk === undefined && pre.ipc === true, `fresh store: blocHtmlEnabled on disk ${pre.disk}, host answers ${pre.ipc} (absent ⇒ ON)`);
    const d1 = await openDialog(cdp);
    clause('L1/dialog-reads-on', d1.title === 'Bloc HTML' && d1.sw.state === 'ON' && d1.sw.checked === 'true' && d1.sw.role === 'switch', `closed -> open · title « ${d1.title} » · switch ${d1.sw.state} aria-checked=${d1.sw.checked} role=${d1.sw.role} · « ${d1.sw.label} »`);
    clause('L1/dialog-inside-the-window', inside(d1.modal, d1), `modal ${JSON.stringify(d1.modal)} in ${d1.vw}x${d1.vh}`);
    await cdp.move(5, 5);
    saveShot(`${LABEL}-l1-on.png`, await cdp.shot());
    await cdp.click(...centre(d1.sw.r));
    const d2 = await settled(cdp, (d) => d.sw?.state === 'OFF', 'the switch to read OFF');
    const post = { disk: world.stored(), ipc: await cdp.eval(`window.orchestra.blocHtmlEnabled()`) };
    clause('L1/click-turns-off', d2.sw.checked === 'false' && post.disk === false && post.ipc === false, `ON -> ${d2.sw.state} (aria-checked ${d2.sw.checked}) · store.json blocHtmlEnabled ${pre.disk} -> ${post.disk} · host answers ${pre.ipc} -> ${post.ipc}`);
    await cdp.move(5, 5);
    saveShot(`${LABEL}-l1-off.png`, await cdp.shot());
  } catch (e) { clause('L1/completed', false, `ABORTED: ${e.stack || e}`); } finally { await L.stop(); }
}

async function launch2() {
  const L = await launch('L2');
  const { cdp } = L;
  try {
    const pre = { disk: world.stored(), ipc: await cdp.eval(`window.orchestra.blocHtmlEnabled()`) };
    clause('L2/persisted-across-restart', pre.disk === false && pre.ipc === false, `after a restart: on disk ${pre.disk}, host answers ${pre.ipc} (the default would read true)`);
    const d1 = await openDialog(cdp);
    clause('L2/dialog-reads-off', d1.sw.state === 'OFF' && d1.sw.checked === 'false', `closed -> open · switch ${d1.sw.state} aria-checked=${d1.sw.checked}`);
    await cdp.move(5, 5);
    saveShot(`${LABEL}-l2-off-after-restart.png`, await cdp.shot());
    await cdp.click(...centre(d1.sw.r));
    const d2 = await settled(cdp, (d) => d.sw?.state === 'ON', 'the switch to read ON');
    const post = { disk: world.stored(), ipc: await cdp.eval(`window.orchestra.blocHtmlEnabled()`) };
    clause('L2/click-turns-on', d2.sw.checked === 'true' && post.disk === true && post.ipc === true, `OFF -> ${d2.sw.state} · store.json ${pre.disk} -> ${post.disk} · host ${pre.ipc} -> ${post.ipc}`);
    await cdp.move(5, 5);
    saveShot(`${LABEL}-l2-on-again.png`, await cdp.shot());
  } catch (e) { clause('L2/completed', false, `ABORTED: ${e.stack || e}`); } finally { await L.stop(); }
}

// ── launch 3: the setting against a conversation on screen (replayed through the app's own event path) ──
const WS = 'ws-bhs-1';
let SEQ = 1, IDX = 0;
const at = () => 1754300000000 + SEQ;
const evText = (t) => { const index = IDX++; return [{ type: 'block-start', seq: SEQ++, at: at(), index, kind: 'text' }, { type: 'text-delta', seq: SEQ++, at: at(), index, text: t }, { type: 'block-stop', seq: SEQ++, at: at(), index }]; };
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const BLOC = '<div id="card" style="height:120px;background:var(--bloc-accent)">BLOC-RENDERED-MARK</div>';
function seedConvWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'bhs-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) { fs.mkdirSync(d, { recursive: true }); mustBeScratch('conv world dir', d); }
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# bhs seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bhs-1', wtDir], fakeHome);
  const account = { id: 'rig-bhs', label: 'rig (scratch config dir)', configDir: cfg };
  const ws = { id: WS, name: 'bhs-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/bhs-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bhs-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho BHS-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, stubDir };
}
/** a disposable COPY of the built app with ONE string changed (counted == 1); the built dir is never touched */
function makeMutantCopy(armDir, dir, from, to) {
  const copy = path.join(armDir, 'app'); fs.mkdirSync(copy, { recursive: true });
  for (const d of ['dist', 'dist-electron']) fs.cpSync(path.join(APP_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(copy, 'node_modules'));
  for (const extra of ['build']) if (fs.existsSync(path.join(APP_DIR, extra))) fs.symlinkSync(path.join(APP_DIR, extra), path.join(copy, extra));
  const hit = walk(path.join(copy, dir)).filter((f) => f.endsWith('.js')).map((f) => ({ f, n: fs.readFileSync(f, 'utf8').split(from).length - 1 })).filter((x) => x.n > 0);
  if (hit.length !== 1 || hit[0].n !== 1) throw new Error(`mutation string ${JSON.stringify(from)} found ${JSON.stringify(hit)} — must be exactly 1 occurrence in 1 file`);
  const before = fs.readFileSync(hit[0].f, 'utf8'); fs.writeFileSync(hit[0].f, before.replace(from, to));
  return { copy, file: path.relative(copy, hit[0].f), beforeMd5: md5(before), afterMd5: md5(fs.readFileSync(hit[0].f)) };
}

async function launch3(label, { mutant }) {
  const armDir = path.join(RIG_DIR, `arm-${label}`); fs.mkdirSync(armDir, { recursive: true });
  const w3 = seedConvWorld(armDir);
  let appDir = APP_DIR, proof = null;
  if (mutant) { proof = makeMutantCopy(armDir, 'dist/assets', mutant.from, mutant.to); appDir = proof.copy; }
  const port = await freePort();
  const env = { PATH: `${w3.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: w3.fakeHome, XDG_RUNTIME_DIR: XDG, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_CONFIG_HOME: path.join(w3.fakeHome, '.config'), XDG_CACHE_HOME: path.join(w3.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: w3.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: w3.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  const handed = handedEnvProblems(env, { ohome: w3.ohome, cfg: w3.cfg, home: w3.fakeHome, wayland: RIG_WAYLAND, xdg: XDG, noBusPath: path.join(RIG_DIR, 'no-session-bus') });
  if (handed.length) refuse(`child env: ${handed.join('; ')}`);
  const fd = fs.openSync(path.join(armDir, 'app.log'), 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [appDir, '--ozone-platform=wayland'], { cwd: appDir, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`\n== launch ${label}: app pid ${app.pid} port ${port}${mutant ? ` — MUTANT COPY ${proof.file} md5 ${proof.beforeMd5} -> ${proof.afterMd5}` : ''}`);
  let cdp;
  const stop = async () => {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2500);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(w3.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(w3.ohome);
    clause(`${label}/teardown-no-survivors`, left.length === 0, `processes still carrying ${w3.ohome}: ${left.length ? left.join(',') : 'none'}`);
  };
  const inject = async (evs) => { for (const e of [].concat(evs)) await cdp.eval(`window.__injectAgentEvent(${JSON.stringify(WS)}, ${JSON.stringify(e)}); 1`); };
  const view = () => cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('CONV-MARK') || e.querySelector('iframe.av-bloc-frame'));
    return { frames: document.querySelectorAll('iframe.av-bloc-frame').length, langs: m ? [...m.querySelectorAll('.av-code-lang')].map((x) => x.textContent) : null, hasSource: !!m && m.textContent.includes('BLOC-RENDERED-MARK'), marker: window.__bhsMarker || null, title: (document.querySelector('iframe.av-bloc-frame') || {}).title || null }; })()`);
  const setSwitch = async (want) => { // the real dialog, trusted clicks
    const d0 = await dom(cdp); await cdp.click(...centre(d0.btn));
    const d1 = await settled(cdp, (d) => d.sw, 'the dialog');
    if (d1.sw.state !== want) { await cdp.click(...centre(d1.sw.r)); await settled(cdp, (d) => d.sw?.state === want, `the switch to read ${want}`); }
    await cdp.click(...centre((await cdp.eval(`(() => { const b = [...document.querySelectorAll('.bloc-html-settings .modal-actions button')][0].getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; })()`)))); // Done
    await settled(cdp, (d) => !d.sw, 'the dialog to close');
  };
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
    clause(`${label}/ctl-app-identity-path`, target.url.includes(appDir) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${appDir}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!window.__orchestraSetState && !!window.__injectAgentEvent && !!document.querySelector('[data-bloc-html-open]')`), 60000, 'the toolbar + the test seams');
    await cdp.eval(`window.__bhsMarker = 'same-page'; window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
    await sleep(500);
    await inject(evText('CONV-MARK\n```html-render title="Carte"\n' + BLOC + '\n```\nAFTER-MARK'));
    const on = await waitFor(async () => { const v = await view(); return v.frames === 1 ? v : null; }, 30000, 'the bloc to render as a frame (switch ON by default)');
    clause(`${label}/on-renders-a-frame`, on.frames === 1 && on.title === 'Carte' && on.langs.length === 0, `default ON: iframes ${on.frames} (title « ${on.title} »), code blocks in the reply ${JSON.stringify(on.langs)}`);
    await cdp.move(5, 5); await sleep(700);
    if (!mutant) saveShot(`${LABEL}-${label}-1-on-frame.png`, await cdp.shot()); // the mutant's ON state is the same picture by design
    const pid0 = app.pid;
    await setSwitch('OFF');
    const off = await waitFor(async () => { const v = await view(); return v.frames === 0 || mutant ? v : null; }, 8000, 'the frame to go away').catch(() => view());
    await sleep(500);
    const off2 = await view();
    if (mutant) {
      // the must-FAIL arm: with the hook ignoring the setting, the switch reads OFF but the frame stays — the clause above WOULD be red; it is reported as the control it is
      const dlg = await dom(cdp);
      clause(`${label}/must-fail-hook-ignoring-the-setting-keeps-the-frame`, off2.frames === 1 && off2.langs.length === 0 && !off2.hasSource, `mutant copy, switch driven to OFF: iframes ${on.frames} -> ${off2.frames} · code blocks ${JSON.stringify(off2.langs)} (the real build: 1 -> 0 and ["html-render"])`);
      await cdp.move(5, 5);
      saveShot(`${LABEL}-${label}-2-off-still-frame.png`, await cdp.shot());
      return;
    }
    clause(`${label}/off-shows-a-code-block-without-restart`, off2.frames === 0 && off2.langs?.includes('html-render') && off2.hasSource && off2.marker === 'same-page' && app.pid === pid0,
      `switch ON -> OFF in the same page: iframes ${on.frames} -> ${off2.frames} · code blocks ${JSON.stringify(on.langs)} -> ${JSON.stringify(off2.langs)} · source text visible ${off2.hasSource} · page marker ${off2.marker} · app pid ${pid0} -> ${app.pid}`);
    await cdp.move(5, 5);
    saveShot(`${LABEL}-${label}-2-off-code.png`, await cdp.shot());
    await setSwitch('ON');
    const back = await waitFor(async () => { const v = await view(); return v.frames === 1 ? v : null; }, 15000, 'the frame to come back').catch(() => view());
    clause(`${label}/on-again-renders-the-frame`, back.frames === 1 && back.langs.length === 0 && back.marker === 'same-page', `OFF -> ON: iframes ${off2.frames} -> ${back.frames} · code blocks ${JSON.stringify(off2.langs)} -> ${JSON.stringify(back.langs)}`);
  } catch (e) { clause(`${label}/completed`, false, `ABORTED: ${e.stack || e}`); } finally { await stop(); }
}

sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x1000']); sh('swaymsg', ['default_border', 'none']);
await launch1();
await launch2();
await launch3('L3', {});
await launch3('L3m', { mutant: HOOK_MUTANT });
// only pairs of states that MUST differ (a state legitimately painted twice — e.g. ON before and after a round trip — is not a no-op)
const shotMd5 = (n) => shots.find((s) => path.basename(s.file) === `${LABEL}-${n}.png`)?.md5;
for (const [a, b] of [['l1-on', 'l1-off'], ['l2-off-after-restart', 'l2-on-again'], ['L3-1-on-frame', 'L3-2-off-code'], ['L3-2-off-code', 'L3m-2-off-still-frame']]) {
  clause(`ctl/captures-differ ${a} vs ${b}`, !!shotMd5(a) && !!shotMd5(b) && shotMd5(a) !== shotMd5(b), `${shotMd5(a)} vs ${shotMd5(b)}`);
}
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const red = results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${results.length} clauses` : `RED: ${red.map((r) => r.clause).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
