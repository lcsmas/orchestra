// #397 — agent tabs through the CDP proxy, END TO END on a BUILT Orchestra inside the contained rig's own headless sway:
// the REAL `orchestra browser tab ...` CLI → host `/browser` route (ADR 0008 identity) → per-workspace loopback proxy → the pinned agent-browser
// daemon → the REAL panel tabs (WebContentsViews). TWO seeded workspaces (W1 focused with its Browser pane open, W2 in the background) and the
// shared fixture site (tabs-a/b/c: red/green/blue pages with distinct titles; cli.html / index.html for the ref arm).
// Every page/registry assertion reads an INDEPENDENT oracle: the app's own state IPC (the tab registry), a second CDP client on the page through
// the app's debug port, and COMPOSITOR PIXELS (grim on the rig's own sway) — never the CLI/proxy chain under test.
//
//   restart     SIGKILL the app, boot it again: restored tabs keep their opener; a stale agent-browser id (session-local, renumbered) that now names the user's tab cannot close it
//   open        `tab new` → an AGENT tab, shown (pixels), marked in the strip, the human is told; `tab list` says who opened which
//   switch      `tab <ref>` to the user's tab: shown, announced, no keyboard-focus steal; « Back » (a human op) restores and clears the notice
//   front       ANY acting command (get url — not frame-bound) on a non-active tab brings it to the front, visibly; `tab list` / idle do not
//   children    the close verbs are refused on a CHILD (worker / frame) session of the user's tab (raw client, auto-attach, then navigate)
//   attach      a PAGE of an agent tab spawns a worker + cross-site iframe while the human is on ANOTHER tab: the daemon's attach-time commands on the new child sessions must not flip the human's tab
//   cap         the 8-tab cap is shared with the human and applies to agent-opened tabs; a refusal leaks no view
//   ownership   `tab close <user's tab>` is refused BEFORE agent-browser (it would print "closed" and drop the tab from its own list), the
//               tab stays loaded, the next `tab list` still has it, the agent's own tab still closes; the PROXY refuses a raw Target.closeTarget too
//   background  W2 (not on screen): tab new / switch / open never activate, attach or show anything, W1's pane is untouched; on arrival W2 shows the user's tab
//   refs        a ref from a tab the user switched away from still clicks THAT tab (brought to the front); after an explicit switch it is a stale ref
//
// Usage (via scripts/e2e-browser-agent-tabs.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--out dir]
//   --mutant <name>: patch the BUILT bundle in place (byte-exact backup, `cmp`-verified restore), run, and require the mutant's arms RED and every ctl/* clause GREEN.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket as WS } from 'ws';
import { abLayout } from '../src/main/agent-browser-daemon.ts';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ── arms and mutants (single source of truth for --list, the .sh wrapper and the verdict) ───────────────────────────────────────
// `restart` runs FIRST: the agent-browser daemon still numbers its tabs t1..t3 (ids are never reused within a session), so the stale-id collision is engineered; it kills and re-boots the app, every later arm runs on boot 2.
const ARMS = ['stale', 'routes', 'capshare', 'strip8', 'notice', 'bg', 'crash']; // seat 3 (verifier) drive for #397: helpers copied from the member's rig, ARMS/oracles are mine
const MUTANTS = {};
if (argv.includes('--list')) {
  console.log(`arms: ${ARMS.join(' ')}`);
  console.log(`mutants: ${Object.keys(MUTANTS).join(' ')}`);
  process.exit(0);
}

const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARM_LIST = (flag('--arm', null) ?? ARMS.join(',')).split(',').sort((a, b) => ARMS.indexOf(a) - ARMS.indexOf(b)); // canonical order whatever --arm lists: `restart` needs the daemon's FIRST ids
const MUTANT = flag('--mutant', null);

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude*, ~/.config, ~/.orchestra and to prove nothing there moved)');
for (const a of ARM_LIST) if (!ARMS.includes(a)) refuse(`unknown arm ${a} (have: ${ARMS.join(', ')})`);
if (MUTANT && !MUTANTS[MUTANT]) refuse(`unknown mutant ${MUTANT} (have: ${Object.keys(MUTANTS).join(', ')})`);
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-agent-tabs.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
// The contained rig's PRIVATE runtime dir (incident Q2): privateRuntimeDir() refuses anything else (a bare run, the human's own runtime dir).
const XDG = privateRuntimeDir();

// ── scratch-containment guard (live dirs are never handed to the app) ─────────────────────────────────────────────────────────
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function waitFor(fn, ms, what, step = 150) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
/** Wait without aborting the arm on timeout: true/false (the clause that follows reports it). */
const softWait = async (fn, ms, what) => { try { await waitFor(fn, ms, what); return true; } catch { console.log(`  (soft wait timed out: ${what})`); return false; } };
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
const COLORS = { a: [0xd6, 0x27, 0x28], b: [0x2c, 0xa0, 0x2c], c: [0x1f, 0x77, 0xb4] };

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  close() { try { this.ws.close(); } catch {} }
}

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WS_NAMES = ['b397-one', 'b397-two', 'b397-three'];
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# b397 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-b397', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const workspaces = WS_NAMES.map((name, i) => {
    const wt = path.join(armDir, 'wt', name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome);
    return { id: `ws-${name}`, name, repoPath: repoDir, worktreePath: wt, branch: `e2e/${name}`, baseBranch: 'main', createdAt: Date.now() + i, status: 'idle', agent: 'claude', accountId: account.id, key: crypto.randomBytes(24).toString('hex') };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'b397-repo', defaultBranch: 'main', accountId: account.id }], workspaces: workspaces.map(({ key, ...w }) => w), accounts: [account], selfTuneRuns: [] }, null, 2));
  // the host vouches for a CLI only through this registry (ADR 0008): hashes, 0600 — exactly what a fresh keeper spawn writes
  fs.writeFileSync(path.join(ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: Object.fromEntries(workspaces.map((w) => [w.id, { hash: sha256(w.key), issuedAt: Date.now() }])) }), { mode: 0o600 });
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho B397-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, workspaces, stubDir };
}

function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}
const daemonPids = (ctx) => { const l = abLayout(ctx.world.ohome, XDG); const dir = path.join(l.socketDir, 'namespaces', 'orchestra', 'run'); const out = {}; try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.pid')) out[f.slice(0, -4)] = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch {} return out; };
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };

const results = []; // {arm, clause, ok, detail}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
const shots = [];
fs.mkdirSync(OUT, { recursive: true });
function grim(name) {
  const f = path.join(OUT, name);
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
  const buf = fs.readFileSync(f); shots.push({ file: f, md5: md5(buf) }); return decodePng(buf);
}

// ── mutants: patch the BUILT bundle in place; restore byte-exact and prove it with cmp ──────────────────────────────────────────
let mutantRestore = null;
function mutantTarget(kind) {
  if (kind === 'cli') return path.join(APP_DIR, 'dist-electron/cli.js');
  if (kind === 'css') {
    const dir = path.join(APP_DIR, 'dist/assets');
    const f = fs.readdirSync(dir).filter((n) => n.endsWith('.css')).find((n) => fs.readFileSync(path.join(dir, n), 'utf8').includes('.browser-agent-switch{'));
    if (!f) refuse('cannot find the renderer stylesheet holding .browser-agent-switch in dist/assets');
    return path.join(dir, f);
  }
  const m = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8'));
  if (!m) refuse('cannot resolve the main-process chunk from dist-electron/main.js');
  return path.join(APP_DIR, 'dist-electron', m[1]);
}
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b397-mutant-active');
function applyMutant() {
  if (fs.existsSync(MARKER)) refuse(`${MARKER} exists — an earlier mutant run died without restoring the bundle: ${fs.readFileSync(MARKER, 'utf8').trim()} (restore it from that backup, or rebuild, then delete the marker)`);
  if (!MUTANT) return;
  const m = MUTANTS[MUTANT], file = mutantTarget(m.file), backup = path.join(RIG_DIR, `mutant-backup-${path.basename(file)}`);
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of m.edits) {
    const hits = typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length;
    if (hits !== 1) refuse(`mutant ${MUTANT}: ${String(from).slice(0, 80)} occurs ${hits}x in ${path.basename(file)} (must be exactly 1) — the bundle changed, update the mutant`);
    src = typeof from === 'string' ? src.replace(from, () => to) : src.replace(from, to);
  }
  fs.copyFileSync(file, backup);
  fs.writeFileSync(MARKER, `${backup} -> ${file}\n`);
  fs.writeFileSync(file, src);
  console.log(`[mutant] ${MUTANT} applied to ${path.basename(file)} (${m.edits.length} edit(s)): ${m.why}; backup ${backup}`);
  mutantRestore = () => { fs.copyFileSync(backup, file); try { sh('cmp', [backup, file]); fs.rmSync(MARKER, { force: true }); console.log(`[mutant] ${MUTANT} restored byte-exact (cmp OK)`); } catch { console.log(`[mutant] RESTORE NOT BYTE-EXACT — rebuild ${path.basename(file)}`); process.exitCode = 4; } };
}
process.on('exit', () => { try { mutantRestore?.(); } catch {} });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ── the fixture site (shared, owned by #395) ─────────────────────────────────────────────────────────────────────────────────
let fixture = null;
async function startSite() {
  fixture = spawn(process.execPath, [path.join(repoRoot, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => { let b = ''; fixture.stdout.on('data', (d) => { b += d; const m = /LISTENING (\d+)/.exec(b); if (m) res(`http://127.0.0.1:${m[1]}`); }); fixture.on('exit', () => rej(new Error('fixture exited'))); setTimeout(() => rej(new Error('fixture never listened')), 8000); });
}

// ── one world, all arms ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** One boot of the app on the world (the restart arm boots it a second time on the SAME world). */
async function bootApp(world, armDir, tag) {
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
    ...(ARM_LIST.includes('attach') ? { ORCHESTRA_CDP_TRACE: '1' } : {}), // the attach arm MEASURES what agent-browser sends (proxy trace in <ORCHESTRA_HOME>/logs/orchestra.log)
    // OPS freeze (ledger #405 incident Q2): the app must never reach the human's session bus / keyring. `disabled:` stops GLib/GDBus falling back to $XDG_RUNTIME_DIR/bus (libdbus already fails to parse it).
    DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(armDir, `app-${tag}.log`);
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`[rig] app (${tag}) pid ${app.pid} debug port ${port} log ${logFile}`);
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  const target = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
  clause('ctl', `app-identity-path${tag === 'boot1' ? '' : '-' + tag}`, target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
  const ui = await Cdp.connect(target.webSocketDebuggerUrl);
  await ui.send('Page.enable');
  // /proc/<pid>/environ can be BLANKED by the app itself (diag run 2026-10-26 00:37: 660 empty entries, no ORCHESTRA_HOME) — then the control judges by what the
  // app DID: its hooks socket and userData live under the scratch ORCHESTRA_HOME, and `app-in-my-sway` (arms) proves the display.
  let environ = [];
  const haveEnv = await softWait(() => { environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); return environ.some((e) => e.startsWith('ORCHESTRA_HOME=')); }, 8000, 'the app environ to be readable');
  const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  const sockUp = haveEnv || (await softWait(() => fs.existsSync(path.join(world.ohome, 'sock')), 20000, 'the app hooks socket under the scratch ORCHESTRA_HOME'));
  const envOk = haveEnv
    ? ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND
    : sockUp && fs.existsSync(path.join(world.ohome, 'userData')) && !('DISPLAY' in env) && env.WAYLAND_DISPLAY === RIG_WAYLAND;
  clause('ctl', `scratch-env${tag === 'boot1' ? '' : '-' + tag}`, envOk,
    haveEnv
      ? `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`
      : `app environ blanked by the app (${environ.length} empty entries); judged by behaviour: hooks socket ${path.join(world.ohome, 'sock')} present=${sockUp}, userData under the scratch home, child env passed with WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} and no DISPLAY`);
  return { app, port, ui, targets, env };
}

async function main() {
  const armDir = path.join(RIG_DIR, 'world'); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  const [W1, W2, W3] = world.workspaces;
  const FIX = await startSite();
  console.log(`[rig] fixture ${FIX}`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1500x950']);
  sh('swaymsg', ['default_border', 'none']);
  const ctx = { world, armDir, W1, W2, W3, FIX, app: null, ui: null, port: 0, targets: null, env: null, URL: { a: `${FIX}/tabs-a.html`, b: `${FIX}/tabs-b.html`, c: `${FIX}/tabs-c.html`, hitA: `${FIX}/agent-tabs-hit-a.html`, hitB: `${FIX}/agent-tabs-hit-b.html`, spawn: `${FIX}/agent-tabs-spawn.html`, frame: `${FIX}/agent-tabs-frame.html` } };
  try {
    Object.assign(ctx, await bootApp(world, armDir, 'boot1'));
    await runArms(ctx);
  } catch (e) {
    clause('rig', 'completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    ctx.ui?.close();
    if (ctx.app) { try { process.kill(-ctx.app.pid, 'SIGTERM'); } catch {} }
    await sleep(2000);
    if (ctx.app) { try { process.kill(-ctx.app.pid, 'SIGKILL'); } catch {} }
    try { fixture?.kill('SIGKILL'); } catch {}
    { // daemons a leaked mutant run may have left (they carry no ORCHESTRA_HOME), then the scratch socket dir — only ever THIS ORCHESTRA_HOME's hashed one
      const l = abLayout(world.ohome, XDG);
      for (const pid of Object.values(daemonPids({ world }))) { if (environOf(pid)?.includes(`AGENT_BROWSER_SOCKET_DIR=${l.socketDir}`)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      if (/\/orch-ab-[0-9a-f]{8}$/.test(l.socketDir) && l.socketDir.startsWith(XDG + '/')) fs.rmSync(l.socketDir, { recursive: true, force: true });
    }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause('ctl', 'teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

// ── driving helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sel = (n) => JSON.stringify(n);
const rectOf = (ctx, s, nth = 0) => ctx.ui.eval(`(() => { const e = document.querySelectorAll(${sel(s)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
async function clickSel(ctx, s, nth = 0) {
  const r = await rectOf(ctx, s, nth);
  if (!r) throw new Error(`no element for ${s}[${nth}]`);
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await ctx.ui.click(r.x, r.y);
  return r;
}
async function selectWs(ctx, W) {
  const idx = await ctx.ui.eval(`[...document.querySelectorAll('.ws-item')].findIndex((e) => e.textContent.includes(${sel(W.branch)}))`);
  if (idx < 0) throw new Error(`no sidebar row for ${W.branch}`);
  await clickSel(ctx, '.ws-item', idx);
  await waitFor(() => ctx.ui.eval(`[...document.querySelectorAll('.ws-item.active')].some((e) => e.textContent.includes(${sel(W.branch)}))`), 15000, `${W.branch} to be the active workspace`);
  await sleep(500);
}
async function openPane(ctx) {
  const state = await ctx.ui.eval(`(() => { const b = document.querySelector('button[aria-label="Show browser pane"],button[aria-label="Hide browser pane"]'); if (!b) return null; return { open: b.getAttribute('aria-label') === 'Hide browser pane' }; })()`);
  if (!state) throw new Error('browser pane toggle not found');
  if (!state.open) await clickSel(ctx, 'button[aria-label="Show browser pane"]');
  await waitFor(() => ctx.ui.eval(`!!document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-tab')`), 20000, 'the Browser pane (tab strip) to be open');
  await waitFor(() => ctx.ui.eval(`(() => { const h = document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-holder'); if (!h) return false; const r = h.getBoundingClientRect(); return r.width > 100 && r.height > 100; })()`), 15000, 'the browser holder to be laid out');
  await sleep(500);
}
/** The REAL CLI bundle, with an `env -i` allowlist: exactly what an agent's Bash tool hands it. */
function cli(ctx, W, args, { timeoutMs = 60000, key } = {}) {
  const base = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.world.fakeHome, ORCHESTRA_HOME: ctx.world.ohome, ORCHESTRA_WS_ID: W.id, ORCHESTRA_SESSION_KEY: key ?? W.key,
    ORCHESTRA_AGENT_TMPDIR: path.join(ctx.world.fakeHome, 'agent-tmp', W.name), LANG: 'C.UTF-8' };
  fs.mkdirSync(base.ORCHESTRA_AGENT_TMPDIR, { recursive: true });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'browser', ...args], { env: base, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.world.fakeHome });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 0), stdout, stderr, ms: Date.now() - t0 }); });
  });
}
const show = (r) => `rc=${r.code} ${r.ms}ms stdout=${JSON.stringify(r.stdout.trim().slice(0, 200))} stderr=${JSON.stringify(r.stderr.trim().slice(0, 240))}`;
/** The panel's registry as the app itself publishes it to the renderer (an independent oracle of the tab layer). */
const reg = (ctx, W) => ctx.ui.eval(`window.orchestra.browserState(${sel(W.id)}).then((s) => ({ tabs: s.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, openedBy: t.openedBy })), activeTabId: s.activeTabId, agentSwitch: s.agentSwitch ?? null }))`);
const brief = (r) => JSON.stringify(r.tabs.map((t) => `${t.id}:${t.openedBy[0]}${t.active ? '*' : ''}:${(t.title || t.url).slice(-14)}`));
const titled = (r, re) => r.tabs.find((t) => re.test(t.title) || re.test(t.url));
/** page targets of the app's debug port that are not the renderer = one per live tab view (any workspace). */
const viewTargets = async (ctx) => (await ctx.targets()).filter((x) => x.type === 'page' && !x.url.includes('dist/index.html'));
async function oracle(ctx, urlPrefix, ms = 15000) {
  const t = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.startsWith(urlPrefix)) || null, ms, `a page at ${urlPrefix}`);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
/** compositor pixel at the centre of the page area (.browser-holder); retried until it matches `want` or the deadline. */
async function holderColor(ctx, name, want, ms = 6000) {
  const r = await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
  if (!r) return { color: null, tries: 0, note: 'no visible .browser-holder' };
  const t0 = Date.now(); let c, tries = 0;
  do {
    const img = grim(`${name}.png`); tries++;
    c = blockColor(img, Math.round(r.x), Math.round(r.y));
    if (!want || near(c, want)) break;
    await sleep(350);
  } while (Date.now() - t0 < ms);
  return { color: c, tries };
}
const colorOk = (h, want) => !!h.color && near(h.color, want);
const colorTxt = (h, want) => `holder pixel ${h.color ? hex(h.color) : 'n/a'} (want ${hex(want)}, ${h.tries} grim tries)`;
const noticeText = (ctx) => ctx.ui.eval(`document.querySelector('.browser-agent-switch .browser-agent-switch-text')?.textContent ?? null`);
const backText = (ctx) => ctx.ui.eval(`document.querySelector('.browser-agent-switch .browser-agent-switch-back')?.textContent ?? null`);
/** agent-browser's own tab list (the daemon's view): [{tabId, title, url, active, targetId}]. */
async function abTabs(ctx, W) {
  const r = await cli(ctx, W, ['--json', 'tab', 'list']);
  try { return JSON.parse(r.stdout.trim()).data.tabs; } catch { return []; }
}
const abLabel = async (ctx, W, re) => (await abTabs(ctx, W)).find((t) => re.test(t.title) || re.test(t.url))?.tabId;
/** Back to a known shape between arms: only the first (human) tab of W1 left, showing page B, W1 focused with its pane open. */
async function reset(ctx) {
  const { ui, W1 } = ctx;
  await selectWs(ctx, W1);
  await openPane(ctx);
  let r = await reg(ctx, W1);
  for (const t of r.tabs.slice(1)) await ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(t.id)}).then(() => true)`);
  await waitFor(async () => (await reg(ctx, W1)).tabs.length === 1, 15000, 'W1 to be down to one tab');
  r = await reg(ctx, W1);
  await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(ctx.URL.b)}).then(() => true)`);
  await waitFor(async () => /Tabs fixture B/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'W1 tab 1 to show page B');
  await sleep(300);
  return reg(ctx, W1);
}
/** Put the human's keyboard focus in the workspace composer and report whether it is there. */
const composerFocus = (ctx) => ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); return t ? { onComposer: document.activeElement === t, windowFocus: document.hasFocus() } : null; })()`);
const focusComposer = async (ctx) => {
  const pos = await ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
  if (!pos) return null;
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await ctx.ui.click(pos.x, pos.y);
  await sleep(250);
  return composerFocus(ctx);
};
const hooksSock = (ctx) => fs.readFileSync(path.join(ctx.world.ohome, 'sock'), 'utf8').trim();
function hostCall(ctx, route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ socketPath: hooksSock(ctx), method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.end(payload);
  });
}
/** A raw CDP client of the PROXY (what agent-browser is, minus its own tab bookkeeping). */
async function rawProxyClient(url) {
  const ws = new WS(url);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map();
  const listeners = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); const p = m.id && pending.get(m.id); if (p) { pending.delete(m.id); p(m); } else if (m.method) for (const l of listeners) l(m); });
  const send = (method, params, sessionId) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { call: (method, params = {}) => send(method, params), callOn: (sessionId, method, params = {}) => send(method, params, sessionId), onEvent: (l) => listeners.push(l), close: () => ws.close() };
}


/** An agent tab on a page that SPAWNS children 4 s after load (a worker and/or a cross-site iframe), the daemon attached (snapshot), the HUMAN on their own tab (unless `background:false`). Measures the proxy trace around the spawn. */
async function spawnChildrenInBackgroundTab(ctx, { worker, frame, background = true }) {
  const { W1, URL: U } = ctx;
  await reset(ctx);
  await cli(ctx, W1, ['tab', 'new', `${U.spawn}?worker=${worker ? 1 : 0}&frame=${frame ? 1 : 0}`]);
  await softWait(async () => !!titled(await reg(ctx, W1), /Spawn fixture/), 15000, 'the agent tab to show the spawn page');
  const snap = await cli(ctx, W1, ['snapshot', '-i']); // the daemon is attached to the agent tab, auto-attach on
  if (background) {
    const idxH = await ctx.ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.openedBy === 'human')`);
    await clickSel(ctx, '.browser-tab', idxH);
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'human', 10000, 'the human tab to be active');
  }
  const before = await reg(ctx, W1);
  const logFile = path.join(ctx.world.ohome, 'logs', 'orchestra.log');
  // The log rotates at 5 MB with ONE backup: a command storm would rotate its own beginning away. A 40 ms follower copies every new byte (capped) so the FIRST requests survive.
  let copied = ''; let last = (() => { try { return fs.statSync(logFile).size; } catch { return 0; } })();
  const follow = setInterval(() => {
    if (copied.length > 6e6) return;
    try {
      const size = fs.statSync(logFile).size;
      if (size < last) last = 0; // rotated: the old bytes are in .1, read what the new file has
      if (size > last) { const fd = fs.openSync(logFile, 'r'); const buf = Buffer.alloc(Math.min(size - last, 2e6)); fs.readSync(fd, buf, 0, buf.length, last); fs.closeSync(fd); copied += buf.toString('utf8'); last += buf.length; }
    } catch {}
  }, 40);
  await sleep(7000); // the page spawns its children (4 s after load), the daemon answers them, and any (wrongful) bring-to-front lands
  clearInterval(follow);
  const after = await reg(ctx, W1); // BEFORE the probe below: `get title` is a real agent action and (correctly) brings its tab to the front
  const probe = await cli(ctx, W1, ['get', 'title'], { timeoutMs: 8000 }); // does the daemon still answer a plain command?
  const reqs = [...copied.matchAll(/client->proxy \{[^\n]*?"method":"([A-Za-z.]+)"/g)].map((m) => m[1]);
  const hist = Object.entries(reqs.reduce((h, m) => ((h[m] = (h[m] ?? 0) + 1), h), {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' ');
  fs.writeFileSync(path.join(OUT, `children-trace-${frame ? 'frame' : 'worker'}-${background ? 'bg' : 'fg'}.txt`), copied.split('\n').slice(0, 400).join('\n'));
  const spawnRuns = new Set((copied.match(/SPAWN-RUN/g) ?? []).length ? ['x'] : []).size; // the page logs once; replays of buffered console messages are not runs
  const attached = (copied.match(/Target\.attachedToTarget/g) ?? []).length;
  return { snap, before, after, probe, spawnErr: probe.code !== 0 ? `get title rc=${probe.code} ${probe.ms}ms` : null, spawnRuns, requests: reqs.length, methods: [...new Set(reqs)].sort(), hist, attached, kb: copied.length / 1024 };
}

// ===== seat 3 arms for #397 (spliced into a copy of the member's driver helpers) =====
const J = (x) => JSON.stringify(x);
const GRID9 = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85], [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]];
/** classify the 9 grid points of the visible .browser-holder by fixture colour (a|b|c|other) */
async function gridColors(ctx, name) {
  const r = await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
  if (!r) return { none: true, cls: [] };
  const img = grim(`${name}.png`);
  const cls = GRID9.map(([fx, fy]) => { const c = blockColor(img, Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy), 4); for (const k of ['a', 'b', 'c']) if (near(c, COLORS[k], 14)) return k; return 'other'; });
  return { none: false, cls, uniq: [...new Set(cls)].join('') };
}
/** Back to ONE blank-then-B HUMAN tab whatever earlier arms did (window.close(), refusals, leftovers): close every tab as the human, the last close leaves a fresh human tab. */
async function hardReset(ctx) {
  const { W1, ui } = ctx;
  await selectWs(ctx, W1); await openPane(ctx);
  for (let i = 0; i < 12; i++) {
    const r = await reg(ctx, W1);
    if (r.tabs.length === 1 && r.tabs[0].openedBy === 'human') break;
    await ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(r.tabs[0].id)}).then(() => true)`);
    await sleep(500);
  }
  const r = await reg(ctx, W1);
  if (!(r.tabs.length === 1 && r.tabs[0].openedBy === 'human')) throw new Error(`hardReset failed: ${brief(r)}`);
  await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(ctx.URL.b)}).then(() => true)`);
  await waitFor(async () => /Tabs fixture B/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'the human tab to show B');
  await sleep(300);
  return reg(ctx, W1);
}
/** human tab on B (+ an agent tab on A when asked); returns the registry ids and agent-browser's own labels */
async function fresh(ctx, withAgent = true) {
  const { W1, URL: U } = ctx;
  await hardReset(ctx);
  if (withAgent) { await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'agent tab A'); }
  const r = await reg(ctx, W1);
  const list = await abTabs(ctx, W1);
  return { r, human: r.tabs.find((t) => t.openedBy === 'human'), agent: r.tabs.find((t) => t.openedBy === 'agent'),
    abB: list.find((t) => /Tabs fixture B/.test(t.title)), abA: list.find((t) => /Tabs fixture A/.test(t.title)) };
}
async function survives(ctx, st, vt0) {
  const { W1 } = ctx; const r = await reg(ctx, W1); const vt = (await viewTargets(ctx)).length;
  return { ok: r.tabs.some((t) => t.id === st.human?.id) && /Tabs fixture B/.test(titled(r, /Tabs fixture B/)?.title ?? '') && vt === vt0, r, vt };
}
async function openRaw(ctx, W) {
  const ep = await hostCall(ctx, '/browser', { id: W.id, key: W.key }); const raw0 = await rawProxyClient(ep.wsUrl);
  const guard = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res({ timeout: true, error: { message: 'NO REPLY in 8 s' } }), 8000))]);
  return { ep, raw: { call: (m, a) => guard(raw0.call(m, a)), callOn: (sid, m, a) => guard(raw0.callOn(sid, m, a)), onEvent: raw0.onEvent, close: raw0.close } };
}
const targetOf = async (raw, re) => (await raw.call('Target.getTargets')).result?.targetInfos?.find((t) => re.test(t.title))?.targetId;
function httpGet(base, p, ms = 8000) {
  return new Promise((resolve) => {
    const u = new URL(p, base); const t0 = Date.now();
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', timeout: ms }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 300), ms: Date.now() - t0 })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ status: 'error', body: String(e.message), ms: Date.now() - t0 }));
    req.end();
  });
}
const refusedMsg = (m) => /opened by the user|may close only the tabs it opened|not_owner|not allowed|refus|not available|not found|wasn't found|Method not found|not supported/i.test(m ?? '');

const ARM_FNS = {
  // ── stale `tN` after an app restart (the member's engineered collision, my variants) ───────────────────────────────────────────────
  async stale(ctx) {
    const { W1, URL: U, ui } = ctx; const A = 'stale';
    await hardReset(ctx);
    await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'page A tab');
    await cli(ctx, W1, ['tab', 'new', U.c]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture C/), 15000, 'page C tab');
    const before = await abTabs(ctx, W1); const oldA = before.find((t) => /Tabs fixture A/.test(t.title))?.tabId;
    const tabsFile = path.join(ctx.world.ohome, 'userData', 'orchestra', 'browser-tabs.json');
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(tabsFile, 'utf8')).workspaces?.[W1.id]?.tabs?.length === 3; } catch { return false; } }, 10000, 'the 3 tabs to reach browser-tabs.json');
    ui.close();
    try { process.kill(-ctx.app.pid, 'SIGKILL'); } catch {}
    await waitFor(() => { try { process.kill(ctx.app.pid, 0); return false; } catch { return true; } }, 15000, 'the SIGKILLed app to be gone');
    for (const p of listProcsByHome(ctx.world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(800);
    const layout = abLayout(ctx.world.ohome, XDG);
    if (/\/orch-ab-[0-9a-f]{8}$/.test(layout.socketDir)) fs.rmSync(layout.socketDir, { recursive: true, force: true });
    Object.assign(ctx, await bootApp(ctx.world, ctx.armDir, 'boot2'));
    await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(W1.branch)})`), 60000, 'the seeded workspaces in the sidebar (boot 2)');
    await sleep(1500); await selectWs(ctx, W1); await openPane(ctx);
    await softWait(async () => (await reg(ctx, W1)).tabs.length === 3, 20000, 'the 3 tabs to be restored');
    const after = await abTabs(ctx, W1); const nowOldA = after.find((t) => t.tabId === oldA);
    const user = (await reg(ctx, W1)).tabs.find((t) => /Tabs fixture B/.test(t.title));
    clause(A, 'ctl/the-remembered-id-now-names-the-users-tab', /Tabs fixture B/.test(nowOldA?.title ?? '') && !!user, `the agent remembers A as ${oldA}; after the restart ${oldA} = ${J(nowOldA?.title)} (ids ${J(after.map((t) => [t.tabId, t.title.slice(-1)]))})`);
    const vt0 = (await viewTargets(ctx)).length;
    // every spelling of "close that stale id" must be refused; the user's tab must survive each
    const variants = [['plain', ['tab', 'close', oldA]], ['timeout-before', ['tab', 'close', '--timeout', '3000', oldA]], ['timeout-after', ['tab', 'close', oldA, '--timeout', '3000']], ['json', ['--json', 'tab', 'close', oldA]], ['dashdash', ['tab', 'close', '--', oldA]], ['two-refs', ['tab', 'close', oldA, after.find((t) => /Tabs fixture C/.test(t.title))?.tabId ?? 't9']]];
    for (const [nm, args] of variants) {
      const o = await cli(ctx, W1, args); await sleep(500); const r = await reg(ctx, W1);
      clause(A, `stale-id-close/${nm}-refused-and-the-users-tab-survives`, o.code !== 0 && /browser_tab_not_owner/.test(o.stderr + o.stdout) && !!titled(r, /Tabs fixture B/) && (await viewTargets(ctx)).length === vt0, `${args.join(' ')} → ${show(o)} · registry ${brief(r)}`);
    }
    const sw = await cli(ctx, W1, ['tab', oldA]);
    clause(A, 'stale-id-switch-says-the-users-tab-in-the-first-line', sw.code === 0 && /Tabs fixture B[^\n]*\(the user's\)/.test((sw.stdout.split('\n')[0] ?? '')), show(sw));
    const swj = await cli(ctx, W1, ['--json', 'tab', oldA]); let jd = null; try { jd = JSON.parse(swj.stdout.trim()); } catch {}
    clause(A, 'stale-id-switch-json-carries-openedBy-human', swj.code === 0 && jd?.data?.openedBy === 'human', show(swj));
    for (const [nm, args] of [['timeout-before', ['tab', '--timeout', '3000', oldA]], ['timeout-after', ['tab', oldA, '--timeout', '3000']]]) {
      const o = await cli(ctx, W1, args);
      if (o.code === 0) clause(A, `stale-id-switch/${nm}-is-annotated-too`, /\(the user's\)/.test(o.stdout), show(o));
      else console.log(`  INFO  [${A}] stale-id-switch/${nm}: agent-browser itself failed (${show(o)}) — nothing to annotate; not an Orchestra clause`);
    }
    const list = await cli(ctx, W1, ['tab', 'list']);
    clause(A, 'tab-list-after-restart-marks-every-tab', /Tabs fixture B[^\n]*\(the user's\)/.test(list.stdout) && /Tabs fixture A[^\n]*\(yours\)/.test(list.stdout) && /Tabs fixture C[^\n]*\(yours\)/.test(list.stdout), show(list));
  },

  // ── an agent closing the USER's tab by every route I can reach ─────────────────────────────────────────────────────────────────────
  async routes(ctx) {
    const { W1, URL: U } = ctx; const A = 'routes';
    // CONTROLS first (same routes, allowed target): each route family must be CAPABLE of closing the agent's own tab
    { const st = await fresh(ctx); const o = await cli(ctx, W1, ['tab', 'close', st.abA?.tabId ?? 't0']); await sleep(600);
      clause(A, 'ctl/cli-tab-close-closes-the-agents-own-tab', o.code === 0 && !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent'), `${show(o)}`); }
    { const st = await fresh(ctx); const { ep, raw } = await openRaw(ctx, W1);
      try { const tid = await targetOf(raw, /Tabs fixture A/); const rep = await raw.call('Target.closeTarget', { targetId: tid }); await sleep(600);
        clause(A, 'ctl/raw-Target.closeTarget-closes-the-agents-own-tab', !!tid && !rep.error && !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent'), `reply ${J(rep).slice(0, 160)}`); } finally { raw.close(); } }
    { const st = await fresh(ctx); const { ep, raw } = await openRaw(ctx, W1);
      try { const tid = await targetOf(raw, /Tabs fixture A/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId; const rep = sid ? await raw.callOn(sid, 'Page.close', {}) : null; await sleep(800);
        clause(A, 'ctl/root-session-Page.close-closes-the-agents-own-tab', !!sid && !rep?.error && !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent'), `reply ${J(rep).slice(0, 160)}`); } finally { raw.close(); } }
    { const st = await fresh(ctx); const { ep, raw } = await openRaw(ctx, W1); const base = ep.wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/');
      try { const tid = await targetOf(raw, /Tabs fixture A/); const h = await httpGet(base, `/json/close/${tid}`); await sleep(700);
        clause(A, 'ctl/http-json-close-closes-the-agents-own-tab-or-is-not-served', !(await reg(ctx, W1)).tabs.some((t) => t.openedBy === 'agent') || !String(h.status).startsWith('2'), `GET /json/close/<agent> → ${h.status} ${J(h.body).slice(0, 120)} (if 404/refused the route is simply not served: the user's-tab clause below is then trivially true)`); } finally { raw.close(); } }
    // THE USER'S TAB — each route on a fresh state
    const attack = async (name, runner) => {
      const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length; let out;
      try { out = await runner(st); } catch (e) { out = { error: String(e.message) }; }
      await sleep(900); const s = await survives(ctx, st, vt0);
      clause(A, `${name}: the user's tab survives`, s.ok, `${out?.note ?? J(out).slice(0, 220)} · registry ${brief(s.r)} · page targets ${vt0}→${s.vt}`);
      return { st, out, s };
    };
    const refs = (st) => ({ lab: st.abB?.tabId, tid: st.abB?.targetId, label: st.abB?.label });
    // (1) CLI spellings, including agent-browser's documented numeric `tab [<n>]` index forms
    for (const [nm, mk] of [
      ['cli plain label', (r) => ['tab', 'close', r.lab]],
      ['cli --timeout before the ref', (r) => ['tab', 'close', '--timeout', '3000', r.lab]],
      ['cli --timeout after the ref', (r) => ['tab', 'close', r.lab, '--timeout', '3000']],
      ['cli --json', (r) => ['--json', 'tab', 'close', r.lab]],
      ['cli -- separator', (r) => ['tab', 'close', '--', r.lab]],
      ['cli targetId', (r) => ['tab', 'close', r.tid]],
      ['cli two refs (user first, agent second)', (r, st) => ['tab', 'close', r.lab, st.abA?.tabId ?? 't2']],
      ['cli two refs (AGENT first, user second)', (r, st) => ['tab', 'close', st.abA?.tabId ?? 't2', r.lab]],
      ['cli two refs (agent, user) behind --timeout', (r, st) => ['tab', 'close', '--timeout', '3000', st.abA?.tabId ?? 't2', r.lab]],
      ['cli numeric index 1', () => ['tab', 'close', '1']],
      ['cli numeric index 0', () => ['tab', 'close', '0']],
      ['cli numeric index 2', () => ['tab', 'close', '2']],
      ['cli uppercase id', (r) => ['tab', 'close', String(r.lab).toUpperCase()]],
      ['cli padded id', (r) => ['tab', 'close', ` ${r.lab} `]],
    ]) {
      const res = await attack(`${nm}`, async (st) => { const o = await cli(ctx, W1, mk(refs(st), st)); const lst = await cli(ctx, W1, ['tab', 'list']); const lied = o.code === 0 && /clos/i.test(o.stdout) ; return { note: `${show(o)} | list after: ${show(lst).slice(0, 220)}`, code: o.code, lied, listed: /Tabs fixture B/.test(lst.stdout) }; });
      clause(A, `${nm}: no lie — it is refused (rc≠0) or agent-browser's own list still has the user's tab (no desync)`, res.out?.code !== 0 || res.out?.listed === true, `rc ${res.out?.code}, said "closed": ${res.out?.lied}, user's tab still in \`tab list\`: ${res.out?.listed}`);
    }
    // (2) raw CDP at the proxy (what any same-uid client holding the token can do)
    await attack('raw Target.closeTarget root', async (st) => { const { raw } = await openRaw(ctx, W1); try { const tid = await targetOf(raw, /Tabs fixture B/); const rep = await raw.call('Target.closeTarget', { targetId: tid }); return { note: `reply ${J(rep).slice(0, 200)}`, refused: refusedMsg(rep?.error?.message) }; } finally { raw.close(); } });
    await attack('raw root-session Page.close', async (st) => { const { raw } = await openRaw(ctx, W1); try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const rep = await raw.callOn(att.result?.sessionId, 'Page.close', {}); return { note: `attach ${J(att).slice(0, 100)} → Page.close ${J(rep).slice(0, 180)}` }; } finally { raw.close(); } });
    await attack('raw Target.sendMessageToTarget(Page.close) on a root session', async (st) => { const { raw } = await openRaw(ctx, W1); try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: false }); const sid = att.result?.sessionId; const rep = await raw.call('Target.sendMessageToTarget', { sessionId: sid, message: JSON.stringify({ id: 1, method: 'Page.close' }) }); return { note: `attach(flatten:false) ${J(att).slice(0, 90)} → sendMessageToTarget ${J(rep).slice(0, 180)}` }; } finally { raw.close(); } });
    await attack('raw Browser.close', async () => { const { raw } = await openRaw(ctx, W1); try { const rep = await raw.call('Browser.close', {}); return { note: `reply ${J(rep).slice(0, 200)}` }; } finally { raw.close(); } });
    await attack('raw Target.attachToBrowserTarget + Browser.close', async () => { const { raw } = await openRaw(ctx, W1); try { const att = await raw.call('Target.attachToBrowserTarget', {}); const sid = att.result?.sessionId; const rep = sid ? await raw.callOn(sid, 'Browser.close', {}) : null; return { note: `browser target ${J(att).slice(0, 100)} → Browser.close ${J(rep).slice(0, 160)}` }; } finally { raw.close(); } });
    await attack('raw Target.disposeBrowserContext / closeBrowser-ish', async (st) => { const { raw } = await openRaw(ctx, W1); try { const ctxs = await raw.call('Target.getBrowserContexts', {}); const id0 = ctxs.result?.browserContextIds?.[0]; const rep = id0 ? await raw.call('Target.disposeBrowserContext', { browserContextId: id0 }) : { note: 'no context listed' }; return { note: `contexts ${J(ctxs).slice(0, 120)} → dispose ${J(rep).slice(0, 160)}` }; } finally { raw.close(); } });
    await attack('http /json/close/<user targetId>', async (st) => { const { ep, raw } = await openRaw(ctx, W1); const base = ep.wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/'); try { const tid = await targetOf(raw, /Tabs fixture B/); const a = await httpGet(base, `/json/close/${tid}`); const tok = (/\/devtools\/browser\/([^/?]+)/.exec(ep.wsUrl) ?? [])[1]; const b = tok ? await httpGet(base, `/${tok}/json/close/${tid}`) : null; return { note: `GET /json/close → ${a.status} ${J(a.body).slice(0, 100)}; token-prefixed → ${b?.status} ${J(b?.body ?? '').slice(0, 100)}` }; } finally { raw.close(); } });
    // (3) a CHILD session of the user's tab (worker + cross-site iframe) — member covers Page.close; I add Target.closeTarget(child) and sendMessageToTarget
    {
      const st = await fresh(ctx, true); const vt0 = (await viewTargets(ctx)).length; const humanId = st.human?.id;
      const { ep, raw } = await openRaw(ctx, W1); const evs = []; raw.onEvent((m) => evs.push(m));
      let note = '';
      try {
        await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(humanId ?? '')}).then(() => true)`);
        const tid = await targetOf(raw, /Tabs fixture B/);
        const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const rootSid = att.result?.sessionId;
        if (rootSid) await raw.callOn(rootSid, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.frame)}).then(() => true)`);
        await softWait(async () => evs.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid), 15000, 'a child session'); await sleep(700);
        const kids = evs.filter((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid).map((m) => ({ sid: m.params?.sessionId, tid: m.params?.targetInfo?.targetId, type: m.params?.targetInfo?.type }));
        const outs = [];
        for (const k of kids) {
          outs.push([k.type, 'child Page.close', J(await raw.callOn(k.sid, 'Page.close', {})).slice(0, 110)]);
          outs.push([k.type, 'child Browser.close', J(await raw.callOn(k.sid, 'Browser.close', {})).slice(0, 110)]);
          outs.push([k.type, 'child Target.closeTarget(self)', J(await raw.callOn(k.sid, 'Target.closeTarget', { targetId: k.tid })).slice(0, 110)]);
          outs.push([k.type, 'root closeTarget(child targetId)', J(await raw.call('Target.closeTarget', { targetId: k.tid })).slice(0, 110)]);
          outs.push([k.type, 'child sendMessageToTarget(Page.close)', J(await raw.callOn(k.sid, 'Target.sendMessageToTarget', { sessionId: k.sid, message: JSON.stringify({ id: 9, method: 'Page.close' }) })).slice(0, 110)]);
        }
        outs.push(['root', 'sendMessageToTarget(root, Page.close)', J(await raw.callOn(rootSid, 'Target.sendMessageToTarget', { sessionId: rootSid, message: JSON.stringify({ id: 10, method: 'Page.close' }) })).slice(0, 110)]);
        note = `${kids.length} child session(s) ${kids.map((k) => k.type).join(',') || 'NONE'}; ${outs.map((o) => o.join(': ')).join(' | ')}`;
        clause(A, 'ctl/a-child-session-exists-for-the-child-attacks', kids.length > 0, note.slice(0, 200));
      } finally { raw.close(); }
      await sleep(900); const s = await survives({ ...ctx }, { human: { id: humanId } }, vt0);
      const r = await reg(ctx, W1); const alive = r.tabs.some((t) => t.id === humanId);
      clause(A, 'child-session/worker+iframe close attempts: the user\'s tab survives', alive, `${note.slice(0, 700)} · registry ${brief(r)}`);
    }
    // (4) page-JS `window.close()` in the user's tab — ACCEPTED GAP per the nomination; measured here, not asserted
    {
      const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length;
      await cli(ctx, W1, ['tab', st.abB?.tabId]);
      const o = await cli(ctx, W1, ['eval', 'window.close(); "sent"']); await sleep(1200);
      const s = await survives(ctx, st, vt0);
      console.log(`  INFO  [${A}] page-JS window.close() in the user's tab (accepted-gap in the nomination): ${show(o)} → user's tab survived=${s.ok}; registry ${brief(s.r)}`);
    }
  },

  // ── the cap is shared with the human; real clicks on +, ×; raw / HTTP creation routes ───────────────────────────────────────────────
  async capshare(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'capshare';
    await hardReset(ctx);
    const vtc = async () => (await viewTargets(ctx)).length;
    for (let i = 0; i < 4; i++) { await clickSel(ctx, '.browser-tab-new'); await sleep(450); }
    let r = await reg(ctx, W1);
    clause(A, 'ctl/the-human-opened-4-more-tabs-with-real-clicks', r.tabs.length === 5 && r.tabs.every((t) => t.openedBy === 'human') && (await vtc()) === 5, `registry ${brief(r)} · page targets ${await vtc()}`);
    const outs = []; for (let i = 0; i < 3; i++) outs.push(await cli(ctx, W1, ['tab', 'new', U.c]));
    r = await reg(ctx, W1);
    clause(A, 'ctl/the-agent-fills-the-remaining-3-slots', outs.every((o) => o.code === 0) && r.tabs.length === 8 && r.tabs.filter((t) => t.openedBy === 'agent').length === 3 && (await vtc()) === 8, `rc ${outs.map((o) => o.code).join('')} · registry ${brief(r)} · page targets ${await vtc()}`);
    const g0 = await gridColors(ctx, 'cap-0-eight');
    const over = await cli(ctx, W1, ['tab', 'new', U.a]); await sleep(600);
    clause(A, 'agent-9th-via-cli-is-refused-with-the-reason', over.code !== 0 && /Tab limit reached: a workspace holds at most 8/.test(over.stderr + over.stdout), show(over));
    const { ep, raw } = await openRaw(ctx, W1); const base = ep.wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/');
    let ct, hn;
    try { ct = await raw.call('Target.createTarget', { url: U.a }); } finally { raw.close(); }
    hn = await httpGet(base, `/json/new?${encodeURIComponent(U.a)}`); const hn2 = await httpGet(base, `/json/new?url=${encodeURIComponent(U.a)}`);
    await sleep(700);
    clause(A, 'agent-9th-via-raw-Target.createTarget-is-refused', !!ct?.error && /Tab limit|limit/i.test(ct.error.message ?? ''), `reply ${J(ct).slice(0, 220)}`);
    r = await reg(ctx, W1);
    clause(A, 'agent-9th-via-http-json-new-creates-nothing', r.tabs.length === 8 && (await vtc()) === 8, `GET /json/new → ${hn.status} ${J(hn.body).slice(0, 90)} · ?url= → ${hn2.status} ${J(hn2.body).slice(0, 90)} · registry ${r.tabs.length} tabs · page targets ${await vtc()}`);
    await softWait(async () => (await noticeText(ctx)) === null, 14000, 'the agent-swap notice to lapse (it overlays the + button; that defect is the `notice` arm)');
    await clickSel(ctx, '.browser-tab-new'); await sleep(900);
    const notice = await ctx.ui.eval(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
    r = await reg(ctx, W1);
    clause(A, 'human-9th-via-the-+-button-is-refused-with-a-visible-notice', /Tab limit/.test(notice ?? '') && r.tabs.length === 8 && (await vtc()) === 8, `notice ${J(notice)} · registry ${r.tabs.length} · page targets ${await vtc()}`);
    const g1 = await gridColors(ctx, 'cap-1-after-refusals');
    clause(A, 'refusals-leave-the-screen-as-it-was-no-leaked-view-painted', g0.uniq === g1.uniq && !g1.none, `holder 9-pt colours before ${g0.uniq} after ${g1.uniq}`);
    // free a slot with a REAL click on the × of the last human-opened (blank) tab; the agent can open again, then is refused again
    const humanBlank = r.tabs.filter((t) => t.openedBy === 'human').slice(-1)[0];
    const xi = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.tabId === ${sel(humanBlank.id)})`);
    await clickSel(ctx, '.browser-tab-close', xi); await sleep(800);
    r = await reg(ctx, W1);
    const again = await cli(ctx, W1, ['tab', 'new', U.b]); await sleep(700);
    const r2 = await reg(ctx, W1); const over2 = await cli(ctx, W1, ['tab', 'new', U.a]);
    clause(A, 'a-freed-slot-is-reusable-then-refused-again', r.tabs.length === 7 && again.code === 0 && r2.tabs.length === 8 && over2.code !== 0 && (await vtc()) === 8, `after × click ${r.tabs.length} tabs · agent open rc ${again.code} → ${r2.tabs.length} · next rc ${over2.code} · page targets ${await vtc()}`);
  },

  // ── 8 tabs with agent badges: does every × and the + still hit itself? (the real click on + at the cap closed a tab in capshare) ────────
  async strip8(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'strip8';
    const geom = () => ui.eval(`(() => {
      const tabs = [...document.querySelectorAll('.browser-tab')].map((t, i) => { const c = t.querySelector('.browser-tab-close'); const r = t.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const top = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        return { i, by: t.dataset.openedBy, tab: [Math.round(r.left), Math.round(r.right)], x: [Math.round(cr.left), Math.round(cr.right)], xHitsSelf: !!top && (top === c || c.contains(top)), xTop: top ? String(top.className || top.tagName).slice(0, 40) : null, clipped: cr.right > r.right + 0.5 }; });
      const p = document.querySelector('.browser-tab-new'); const pr = p.getBoundingClientRect(); const ptop = document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2); const strip = document.querySelector('.browser-tabs'); const sr = strip.getBoundingClientRect();
      return { n: tabs.length, tabs, plus: { rect: [Math.round(pr.left), Math.round(pr.right)], hitsSelf: !!ptop && (ptop === p || p.contains(ptop)), top: ptop ? String(ptop.className || ptop.tagName).slice(0, 40) : null, insideStrip: pr.right <= sr.right + 0.5 }, strip: [Math.round(sr.left), Math.round(sr.right)], scrollW: strip.scrollWidth, clientW: strip.clientWidth };
    })()`);
    const verdict = (g) => ({ xBad: g.tabs.filter((t) => !t.xHitsSelf || t.clipped).map((t) => `tab${t.i}(${t.by}) x=${t.x} tab=${t.tab} clipped=${t.clipped} top=${t.xTop}`), plusOk: g.plus.hitsSelf && g.plus.insideStrip, overflow: g.scrollW > g.clientW });
    for (const [label, agentFirst] of [['agent tabs LAST (5 human + 3 agent)', false], ['agent tabs FIRST (3 agent + 5 human)', true]]) {
      await hardReset(ctx);
      const openAgent = async () => { for (let i = 0; i < 3; i++) await cli(ctx, W1, ['tab', 'new', U.c]); };
      const openHuman = async () => { for (let i = 0; i < 4; i++) { await clickSel(ctx, '.browser-tab-new'); await sleep(450); } };
      if (agentFirst) { await openAgent(); await openHuman(); } else { await openHuman(); await openAgent(); }
      await softWait(async () => (await noticeText(ctx)) === null, 14000, 'the notice to lapse');
      const r = await reg(ctx, W1); const g = await geom(); const v = verdict(g);
      grim(`strip8-${agentFirst ? 'agentfirst' : 'agentlast'}.png`);
      clause(A, `ctl/${label}: eight tabs, no notice`, r.tabs.length === 8 && g.n === 8 && (await noticeText(ctx)) === null, `registry ${brief(r)}`);
      clause(A, `${label}: every × hits itself and is inside its tab`, v.xBad.length === 0, v.xBad.length ? `BAD: ${J(v.xBad)}` : `8 × all hit themselves`);
      clause(A, `${label}: the + hits itself and is inside the strip`, v.plusOk, `+ rect ${J(g.plus.rect)} strip ${J(g.strip)} → hits ${J(g.plus.top)} inside=${g.plus.insideStrip}`);
      clause(A, `${label}: the strip does not overflow its box`, !v.overflow, `scrollWidth ${g.scrollW} vs clientWidth ${g.clientW}`);
      const before = await reg(ctx, W1);
      await clickSel(ctx, '.browser-tab-new'); await sleep(900);
      const after = await reg(ctx, W1); const nt = await ui.eval(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
      clause(A, `${label}: a real click on + at the cap shows the refusal and closes nothing`, after.tabs.length === 8 && /Tab limit/.test(nt ?? ''), `tabs ${before.tabs.length}→${after.tabs.length}; notice ${J(nt)}; closed: ${J(before.tabs.filter((t) => !after.tabs.some((x) => x.id === t.id)).map((t) => `${t.id}(${t.openedBy})`))}`);
    }
  },

  // ── the swap notice must not cover or move any human control ─────────────────────────────────────────────────────────────────────────
  async notice(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'notice';
    await hardReset(ctx);
    await clickSel(ctx, '.browser-tab-new'); await sleep(600);
    const r0 = await reg(ctx, W1); const second = r0.tabs[1];
    await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.c)}).then(() => true)`);
    await softWait(async () => /Tabs fixture C/.test((await reg(ctx, W1)).tabs[1]?.title ?? ''), 15000, 'the 2nd human tab to show C');
    await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'agent tab');
    await softWait(async () => (await noticeText(ctx)) !== null, 6000, 'the notice');
    const up = await noticeText(ctx);
    grim('notice-up.png');
    // hit-test the centre of every human control: the notice must be NEITHER above it NOR overlapping its box
    const probe = () => ui.eval(`(() => {
      const nb = document.querySelector('.browser-agent-switch'); const nr = nb ? nb.getBoundingClientRect() : null;
      const sels = ['.browser-tab-new', '.browser-nav-btn[aria-label="Back"]', '.browser-nav-btn[aria-label="Forward"]', '.browser-nav-btn[aria-label="Reload"]', '.browser-url-input', '.browser-design-btn'];
      const out = [];
      const check = (el, name) => { if (!el) { out.push({ name, missing: true }); return; } const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy);
        out.push({ name, top: top ? (top.className || top.tagName) : null, hit: !!top && (top === el || el.contains(top)), coveredByNotice: !!(top && nb && nb.contains(top)), overlaps: !!(nr && !(r.right <= nr.left || r.left >= nr.right || r.bottom <= nr.top || r.top >= nr.bottom)) }); };
      document.querySelectorAll('.browser-tab').forEach((t, i) => { check(t.querySelector('.browser-tab-close'), 'tab' + i + ' ×'); if (t.dataset.openedBy === 'human') check(t.querySelector('.browser-tab-label'), 'tab' + i + ' label'); });
      for (const s of sels) check(document.querySelector(s), s);
      return { notice: !!nb, rect: nr && { l: Math.round(nr.left), t: Math.round(nr.top), r: Math.round(nr.right), b: Math.round(nr.bottom) }, out };
    })()`);
    const p = await probe();
    const isStrip = (o) => /^tab\d+ (×|label)$/.test(o.name) || o.name === '.browser-tab-new';
    const badStrip = p.out.filter((o) => isStrip(o) && o.missing === undefined && (!o.hit || o.coveredByNotice));
    const badTool = p.out.filter((o) => !isStrip(o) && o.missing === undefined && (!o.hit || o.coveredByNotice));
    clause(A, 'ctl/the-notice-is-up-and-there-are-human-controls-to-test', !!up && p.notice && p.out.length >= 8, `notice ${J(up)} rect ${J(p.rect)} · ${p.out.length} controls probed`);
    clause(A, 'no-tab-no-x-no-plus-is-under-the-notice-every-centre-hits-its-own-control', badStrip.length === 0, badStrip.length ? `COVERED/MISSED: ${J(badStrip)}` : `${p.out.filter(isStrip).length} strip controls, all centres hit themselves`);
    console.log(`  INFO  [${A}] toolbar controls under the notice (measured; the member's design says harmless to mis-click): ${badTool.length ? J(badTool.map((o) => ({ name: o.name, top: o.top }))) : 'none covered'}`);
    // a REAL click on the human's + while the notice is up: it must open a tab (it must not land on the notice's « Back » or on nothing)
    { const b0 = await reg(ctx, W1); const noticeStillUp = (await noticeText(ctx)) !== null;
      const topAtPlus = await ui.eval(`(() => { const e = document.querySelector('.browser-tab-new'); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t ? (t.className || t.tagName) : null; })()`);
      await clickSel(ctx, '.browser-tab-new'); await sleep(900); const b1 = await reg(ctx, W1);
      clause(A, 'a-real-click-on-the-+-under-the-notice-opens-a-tab-and-does-not-go-Back', noticeStillUp && b1.tabs.length === b0.tabs.length + 1, `notice up ${noticeStillUp}; element under the + centre: ${J(topAtPlus)}; before ${brief(b0)} → after ${brief(b1)}`);
      grim('notice-after-plus-click.png');
      await softWait(async () => (await noticeText(ctx)) === null, 14000, 'the notice to lapse');
      // restore the 3-tab shape for the × test: close the extra blank tab with a real click once nothing overlays it
      const extra = b1.tabs.find((t) => !b0.tabs.some((x) => x.id === t.id));
      if (extra) { const xi = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.tabId === ${sel(extra.id)})`); if (xi >= 0) { await clickSel(ctx, '.browser-tab-close', xi); await sleep(700); } }
      await cli(ctx, W1, ['tab', 'new', U.a]); await softWait(async () => (await noticeText(ctx)) !== null, 6000, 'the notice again');
    }
    // a REAL click on a human tab's × while the notice is up closes THAT tab only
    const idx = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.tabId === ${sel(second.id)})`);
    const before = await reg(ctx, W1);
    await clickSel(ctx, '.browser-tab-close', idx); await sleep(900);
    const after = await reg(ctx, W1);
    clause(A, 'a-real-click-on-a-human-tab-x-under-the-notice-closes-that-tab-only', after.tabs.length === before.tabs.length - 1 && !after.tabs.some((t) => t.id === second.id) && before.tabs.filter((t) => t.id !== second.id).every((t) => after.tabs.some((x) => x.id === t.id)), `before ${brief(before)} → after ${brief(after)}`);
  },

  // ── a background / archived workspace's agent never attaches or shows a view ───────────────────────────────────────────────────────
  async bg(ctx) {
    const { W1, W2, W3, URL: U, ui } = ctx; const A = 'bg';
    await hardReset(ctx);
    const g0 = await gridColors(ctx, 'bg-0-w1'); const w1r0 = await reg(ctx, W1);
    clause(A, 'ctl/w1-on-screen-shows-only-B', !g0.none && g0.uniq === 'b', `holder 9-pt colours ${g0.uniq}; W1 ${brief(w1r0)}`);
    const w2h0 = await reg(ctx, W2);
    const steps = [];
    const run = async (label, args, o) => { const r = await cli(ctx, W2, args, o); steps.push(`${label}:${r.code}${r.code ? '(' + (r.stderr || r.stdout).trim().slice(0, 90) + ')' : ''}`); return r; };
    await run('open', ['open', U.c]); await run('tab new', ['tab', 'new', U.a]);
    await softWait(async () => (await reg(ctx, W2)).tabs.length === 2, 15000, 'W2 two tabs');
    const labA = await abLabel(ctx, W2, /Tabs fixture A/); const labC = await abLabel(ctx, W2, /Tabs fixture C/);
    await run('switch A', ['tab', labA ?? 't0']); await run('eval', ['eval', 'document.title']); await run('get url', ['get', 'url']);
    await run('switch C', ['tab', labC ?? 't0']); await run('snapshot', ['snapshot', '-i']);
    const shot = path.join(ctx.world.fakeHome, 'bg-shot.png'); await run('screenshot', ['screenshot', shot], { timeoutMs: 45000 }); await run('switch A again', ['tab', labA ?? 't0']);
    // raw: the agent's own proxy client asks for the front itself
    const { raw } = await openRaw(ctx, W2); let fr = [];
    try { const tid = await targetOf(raw, /Tabs fixture A/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
      fr.push(J(await raw.call('Target.activateTarget', { targetId: tid })).slice(0, 80)); if (sid) fr.push(J(await raw.callOn(sid, 'Page.bringToFront', {})).slice(0, 80)); } finally { raw.close(); }
    await sleep(900);
    const w2r = await reg(ctx, W2); const w1r1 = await reg(ctx, W1); const g1 = await gridColors(ctx, 'bg-1-w1-after');
    const vt = (await viewTargets(ctx)).length;
    clause(A, 'ctl/the-background-agent-really-worked-screenshot-aside', steps.filter((s) => !s.startsWith('screenshot')).every((s) => /:0$/.test(s)) && w2r.tabs.length === 2, `steps ${steps.join(' ')}; raw front ${fr.join(' / ')}; W2 ${brief(w2r)}`);
    clause(A, 'background-agent-never-activates-its-tab-the-users-stays-active', w2r.tabs.find((t) => t.active)?.openedBy === 'human' && w2r.agentSwitch === null, `W2 ${brief(w2r)} agentSwitch ${J(w2r.agentSwitch)} (incl. raw Target.activateTarget + Page.bringToFront)`);
    clause(A, 'the-focused-workspace-screen-and-registry-are-untouched', g1.uniq === 'b' && JSON.stringify(w1r1) === JSON.stringify(w1r0) && (await noticeText(ctx)) === null, `holder 9-pt colours ${g1.uniq} (only B); W1 registry unchanged ${JSON.stringify(w1r1) === JSON.stringify(w1r0)}; notice ${J(await noticeText(ctx))}`);
    clause(A, 'one-native-view-per-tab-no-extra-view', vt === w1r1.tabs.length + w2r.tabs.length, `page targets ${vt} = W1 ${w1r1.tabs.length} + W2 ${w2r.tabs.length}`);
    // ARCHIVED workspace: build a panel for W3 as a background agent, archive it, then every agent command must be refused and create nothing
    await cli(ctx, W3, ['open', U.c]); await cli(ctx, W3, ['tab', 'new', U.a]);
    await softWait(async () => (await reg(ctx, W3)).tabs.length === 2, 15000, 'W3 two tabs');
    const vtBefore = (await viewTargets(ctx)).length;
    const arch = await ui.eval(`window.orchestra.archiveWorkspace(${sel(W3.id)}).then(() => 'ok', (e) => 'ERR ' + e.message)`);
    await sleep(2500);
    const vtAfter = (await viewTargets(ctx)).length; const w3reg = await reg(ctx, W3);
    clause(A, 'archive-destroys-the-archived-workspaces-views', arch === 'ok' && vtAfter === vtBefore - 2 && w3reg.tabs.length === 0, `archive ${arch} · page targets ${vtBefore}→${vtAfter} (want −2) · W3 registry ${brief(w3reg)}`);
    const arc = [];
    for (const [nm, args] of [['tab new', ['tab', 'new', U.a]], ['open', ['open', U.b]], ['eval', ['eval', '1+1']], ['tab list', ['tab', 'list']], ['screenshot', ['screenshot', path.join(ctx.world.fakeHome, 'arch-shot.png')]], ['click', ['click', '@e1']]]) { const r = await cli(ctx, W3, args, { timeoutMs: 45000 }); arc.push({ nm, r }); }
    await sleep(900);
    const vtEnd = (await viewTargets(ctx)).length; const w3end = await reg(ctx, W3);
    clause(A, 'an-archived-workspaces-agent-is-refused-on-every-command', arc.every((a) => a.r.code !== 0), arc.map((a) => `${a.nm}:rc${a.r.code}:${(a.r.stderr || a.r.stdout).trim().slice(0, 70)}`).join(' | '));
    clause(A, 'and-resurrects-no-panel-no-view', vtEnd === vtAfter && w3end.tabs.length === 0, `page targets ${vtAfter}→${vtEnd} · W3 registry ${brief(w3end)} (a resurrected panel would create a blank view)`);
    const g2 = await gridColors(ctx, 'bg-2-w1-end');
    clause(A, 'ctl/w1-still-shows-only-B-at-the-end', g2.uniq === 'b', `holder 9-pt colours ${g2.uniq}`);
  },

  // ── LAST: destructive CDP verbs that are not closes but kill the user's tab; measured, never asserted (INFO) ──────────────────────
  async crash(ctx) {
    const { W1 } = ctx; const A = 'crash';
    const st = await fresh(ctx); const vt0 = (await viewTargets(ctx)).length;
    const { raw } = await openRaw(ctx, W1); const outs = [];
    try { const tid = await targetOf(raw, /Tabs fixture B/); const att = await raw.call('Target.attachToTarget', { targetId: tid, flatten: true }); const sid = att.result?.sessionId;
      outs.push(['Page.crash', J(await raw.callOn(sid, 'Page.crash', {})).slice(0, 110)]); } finally { raw.close(); }
    await sleep(1500); const s = await survives(ctx, st, vt0);
    const live = await (async () => { try { const o = await oracle(ctx, ctx.URL.b, 4000); try { return await Promise.race([o.eval('1+1'), new Promise((r) => setTimeout(() => r('NO ANSWER in 4 s (renderer dead)'), 4000))]); } finally { o.close(); } } catch (e) { return `target gone/unreachable: ${e.message}`; } })();
    console.log(`  INFO  [${A}] Page.crash on the user's tab via the proxy (not a close; measured): ${outs.map((o) => o.join(' → ')).join(' | ')} → user's tab still in registry=${s.r.tabs.some((t) => t.id === st.human?.id)}; page targets ${vt0}→${s.vt}; the page's own eval(1+1) → ${J(live)}`);
    const { raw: r2 } = await openRaw(ctx, W1);
    try { const rep = await r2.call('Browser.crash', {}); console.log(`  INFO  [${A}] Browser.crash via the proxy: ${J(rep).slice(0, 160)}`); } finally { r2.close(); }
    await sleep(1500);
    clause(A, 'the-app-is-still-alive-after-the-crash-verbs', await ctx.ui.eval('1+1').then((v) => v === 2, () => false), 'renderer eval(1+1)');
  },
};


async function runArms(ctx) {
  await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(ctx.W1.branch)})`), 60000, 'the seeded workspaces in the sidebar');
  await sleep(1500);
  clause('ctl', 'app-in-my-sway', new RegExp(`"pid":\\s*${ctx.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${ctx.app.pid} present in my sway's get_tree`);
  for (const arm of ARM_LIST) {
    console.log(`\n== arm ${arm} ==`);
    try { await ARM_FNS[arm](ctx); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${e.stack || e}`); }
  }
}

// ── live-dir canary: independent tool (find) + json, before/after ─────────────────────────────────────────────────────────────
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  const abDot = path.join(LIVE_HOME, '.agent' + '-browser');
  snap['agent-browser dot-dir in the real home'] = fs.existsSync(abDot) ? 'exists' : 'absent';
  return snap;
}

const before = liveCanary();
console.log(`[rig] app ${APP_DIR} arms ${ARM_LIST.join(',')} mutant=${MUTANT ?? 'none'} out=${OUT}`);
applyMutant();
await main();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('ctl', 'live-dirs-untouched', same, `${Object.keys(before).length} live probes (symlink-set + mcpServers hashes of each ~/.claude*, agent-browser dot-dir existence) ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isCtl = (c) => c.arm === 'ctl' || c.clause.startsWith('ctl/');
const targetArms = new Set(MUTANT ? MUTANTS[MUTANT].arms : ARM_LIST);
// A mutant may break OTHER arms (collateral): their arm-scoped controls are not the mutant's concern. Global controls always are.
const ctlRed = results.filter((c) => isCtl(c) && !c.ok && (c.arm === 'ctl' || targetArms.has(c.arm))), armRed = results.filter((c) => !isCtl(c) && !c.ok);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, mutant: MUTANT, results, shots }, null, 2));
let verdict, rc;
if (MUTANT) {
  const want = MUTANTS[MUTANT].arms;
  const redArms = new Set(armRed.map((c) => c.arm));
  const missed = want.filter((a) => !redArms.has(a));
  ({ verdict, rc } = ctlRed.length === 0 && missed.length === 0
    ? { verdict: `MUTANT ${MUTANT} KILLED: arm(s) ${want.join(', ')} red (${armRed.filter((c) => want.includes(c.arm)).map((c) => c.clause).join(', ')}), every control green; other red arms: ${[...redArms].filter((a) => !want.includes(a)).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: arms not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && armRed.length === 0
    ? { verdict: `ALL GREEN: ${results.length} clauses (${results.filter(isCtl).length} controls, ${results.length - results.filter(isCtl).length} arm clauses) over ${ARM_LIST.length} arms`, rc: 0 }
    : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm}:${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
