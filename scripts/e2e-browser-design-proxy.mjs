// #398 — design mode on the CDP proxy (single debugger attacher), end to end against a BUILT Orchestra.
//
// Boots a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway (scripts/e2e-browser-design-proxy.sh →
// e2e-contained-rig.sh), SCRATCH ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, two seeded workspaces, the shared fixture site (pages/design.html)
// and ORCHESTRA_CDP_TRACE=1 (the host logs every debugger acquire/release with ELECTRON'S OWN isAttached()). Page facts are read from an
// INDEPENDENT oracle: the app's own remote-debugging port. The composer is read from the renderer DOM (what the human sees).
//
// Arms: static-attacher (source gate + bundle) · design-pick (the real UI path, design mode alone) · design-while-agent (a pick while an
// `orchestra browser wait --fn` is in flight on the same tab) · design-then-agent (design armed first, the agent attaches second).
// Usage (via scripts/e2e-browser-design-proxy.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--out dir]
//   --mutant <name>: patch the BUILT bundle in place (byte-exact backup, `cmp`-verified restore) and require the mutant's arms RED and every control GREEN.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { abLayout as abLayoutFor } from '../src/main/agent-browser-daemon.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ── arms and mutants (single source of truth for --list, the .sh wrapper and the verdict) ───────────────────────────────────────
const ARMS = ['static-attacher', 'design-pick', 'design-while-agent', 'design-then-agent'];
/** Each edit is a regex that must match EXACTLY once in the BUILT main chunk (so a refactor can never leave a mutant silently inert). */
const MUTANTS = {
  'second-attacher': { edits: [[/(throw new Error\("the browser CDP proxy is not running \(initBrowserCliHost has not run\)"\);)return (\w+)\.send\((\w+),(\w+)\.id,/, '$1$4.view.webContents.debugger.attach("1.3");return $2.send($3,$4.id,']], arms: ['static-attacher', 'design-pick', 'design-while-agent', 'design-then-agent'], why: 'the legacy path attaches a debugger of its own again (unguarded: a second attach throws)' },
  'seat-never-detaches': { edits: [[/--(\w+)\.count>0\?"kept":\((\w+)\((\w+),\1\),"detached"\)/, '--$1.count>0?"kept":"detached"']], arms: ['design-pick'], why: 'the last holder leaves but the debugger stays attached to the human\'s panel' },
  'design-hold-leak': { edits: [[/const (\w+)=(\w+)==null\?void 0:\2\.designHold;!\2\|\|!\1\|\|\(\2\.designHold=null,\1\(\)\)/, 'const $1=$2==null?void 0:$2.designHold;!$2||!$1||($2.designHold=null)']], arms: ['design-pick'], why: 'a pick / cancel / disarm never gives the design-mode lease back' },
  'design-hold-removed': { edits: [[/(\w+)\.designHold\|\|\(\1\.designHold=await (\w+)\.hold\((\w+),\1\.id\)\);/, '']], arms: ['design-pick'], why: 'design mode keeps no lease while armed: every 150 ms poll attaches and detaches the debugger' },
  'pick-screenshot-dropped': { edits: [[/return await (\w+)\.channel\.send\((\w+),(\w+)\)\}finally\{\1\.release\(\)\}/, 'return $2==="Page.captureScreenshot"?{}:await $1.channel.send($2,$3)}finally{$1.release()}']], arms: ['design-pick', 'design-while-agent'], why: 'the cropped element screenshot never reaches the pick' },
  'lease-steals-attach': { edits: [[/this\.tabs\.get\((\w+)\)===(\w+)&&this\.releaseTab\(\1\)/, 'this.port.release($1)']], arms: ['design-while-agent', 'design-then-agent'], why: 'releasing design mode\'s lease detaches the debugger from under the agent\'s session' },
};
if (argv.includes('--list')) {
  console.log(`arms: ${ARMS.join(' ')}`);
  console.log(`mutants: ${Object.keys(MUTANTS).join(' ')}`);
  process.exit(0);
}

const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const mainChunk = () => {
  const m = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8'));
  if (!m) { console.log('REFUSED: cannot resolve the main-process chunk from dist-electron/main.js'); process.exit(3); }
  return path.join(APP_DIR, 'dist-electron', m[1]);
};
const hitsOf = (src, from) => (typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length);
if (argv.includes('--dry-mutants')) { // does every mutant still match the BUILT chunk exactly once? (no app, no sway)
  const src = fs.readFileSync(mainChunk(), 'utf8'); let bad = 0;
  for (const [name, m] of Object.entries(MUTANTS)) for (const [from] of m.edits) { const n = hitsOf(src, from); if (n !== 1) bad++; console.log(`${n === 1 ? 'OK ' : 'BAD'} ${name}: ${n} hit(s)`); }
  process.exit(bad ? 1 : 0);
}

const LIVE_HOME = flag('--live-home', null);
const ARM_LIST = (flag('--arm', null) ?? ARMS.join(',')).split(',');
const MUTANT = flag('--mutant', null);
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude*, ~/.config, ~/.orchestra and to prove nothing there moved)');
for (const a of ARM_LIST) if (!ARMS.includes(a)) refuse(`unknown arm ${a} (have: ${ARMS.join(', ')})`);
if (MUTANT && !MUTANTS[MUTANT]) refuse(`unknown mutant ${MUTANT} (have: ${Object.keys(MUTANTS).join(', ')})`);
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-design-proxy.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

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
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
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
/** share of pixels within `tol` of the RGB colour. */
function colourShare(I, [r, g, b], tol = 4) {
  let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - r) <= tol && Math.abs(I.data[o + 1] - g) <= tol && Math.abs(I.data[o + 2] - b) <= tol) n++; }
  return n / (I.w * I.h);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  close() { try { this.ws.close(); } catch {} }
}

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WS_NAMES = ['b398-one', 'b398-two'];
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# b398 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-b398', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const workspaces = WS_NAMES.map((name, i) => {
    const wt = path.join(armDir, 'wt', name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome);
    return { id: `w${i + 1}-${name}`, name, repoPath: repoDir, worktreePath: wt, branch: `e2e/${name}`, baseBranch: 'main', createdAt: Date.now() + i, status: 'idle', agent: 'claude', accountId: account.id, key: crypto.randomBytes(24).toString('hex') };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'b398-repo', defaultBranch: 'main', accountId: account.id }], workspaces: workspaces.map(({ key, ...w }) => w), accounts: [account], selfTuneRuns: [] }, null, 2));
  fs.writeFileSync(path.join(ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: Object.fromEntries(workspaces.map((w) => [w.id, { hash: sha256(w.key), issuedAt: Date.now() }])) }), { mode: 0o600 });
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho B398-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, workspaces, stubDir };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}

const results = []; // {arm, clause, ok, detail}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
const shots = [];
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── mutants: patch the BUILT bundle in place; restore byte-exact and prove it with cmp ──────────────────────────────────────────
let mutantRestore = null;
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b398-mutant-active');
function applyMutant() {
  if (fs.existsSync(MARKER)) refuse(`${MARKER} exists — an earlier mutant run died without restoring the bundle: ${fs.readFileSync(MARKER, 'utf8').trim()} (restore it from that backup, or rebuild, then delete the marker)`);
  if (!MUTANT) return;
  const m = MUTANTS[MUTANT], file = mainChunk(), backup = path.join(RIG_DIR, `mutant-backup-${path.basename(file)}`);
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of m.edits) {
    const hits = hitsOf(src, from);
    if (hits !== 1) refuse(`mutant ${MUTANT}: ${String(from).slice(0, 70)} occurs ${hits}x in ${path.basename(file)} (must be exactly 1) — the bundle changed, update the mutant`);
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

// ── one world, all arms ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const armDir = path.join(RIG_DIR, 'world'); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  const [W1, W2] = world.workspaces;
  const fixture = spawn(process.execPath, [path.join(repoRoot, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  const FIX = await new Promise((res, rej) => { let b = ''; fixture.stdout.on('data', (d) => { b += d; const m = /LISTENING (\d+)/.exec(b); if (m) res(`http://127.0.0.1:${m[1]}`); }); fixture.on('exit', () => rej(new Error('fixture exited'))); setTimeout(() => rej(new Error('fixture never listened')), 8000); });
  console.log(`[rig] fixture ${FIX}`);

  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8', ORCHESTRA_CDP_TRACE: '1' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const fd = fs.openSync(path.join(armDir, 'app.out'), 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`[rig] app pid ${app.pid} debug port ${port} log ${path.join(world.ohome, 'logs/orchestra.log')}`);
  let ui;
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  try {
    const target = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
    clause('ctl', 'app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    ui = await Cdp.connect(target.webSocketDebuggerUrl);
    await ui.send('Page.enable');
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
    const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause('ctl', 'scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND && ev('ORCHESTRA_CDP_TRACE') === '1',
      `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'} ORCHESTRA_CDP_TRACE=${ev('ORCHESTRA_CDP_TRACE')}`);
    await runArms({ world, W1, W2, FIX, port, app, ui, targets, env });
  } catch (e) {
    clause('rig', 'completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    ui?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    try { fixture.kill('SIGKILL'); } catch {}
    { // agent-browser daemons the host started carry no ORCHESTRA_HOME: find them by the scratch socket dir, then remove that dir (only THIS ORCHESTRA_HOME's hashed one)
      const l = abLayoutFor(world.ohome, process.env.XDG_RUNTIME_DIR);
      for (const pid of Object.values(daemonPids(l))) { if (environOf(pid)?.includes(`AGENT_BROWSER_SOCKET_DIR=${l.socketDir}`)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      if (/\/orch-ab-[0-9a-f]{8}$/.test(l.socketDir) && l.socketDir.startsWith((process.env.XDG_RUNTIME_DIR ?? '/nonexistent') + '/')) fs.rmSync(l.socketDir, { recursive: true, force: true });
    }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause('ctl', 'teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

const daemonPids = (l) => { const dir = path.join(l.socketDir, 'namespaces', 'orchestra', 'run'); const out = {}; try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.pid')) out[f.slice(0, -4)] = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch {} return out; };
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };

// ── driving helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sel = (n) => JSON.stringify(n);
const appLog = (ctx) => { try { return fs.readFileSync(path.join(ctx.world.ohome, 'logs/orchestra.log'), 'utf8'); } catch { return ''; } };
/** Seat trace lines of `W` after byte offset `from`: [{tab, op, what, attached}] in log order. */
function seatLines(ctx, W, from = 0) {
  const re = new RegExp(`seat\\[${W.id.slice(0, 8)}\\] (t\\d+) (acquire|release) (\\w+) isAttached=(true|false)`, 'g');
  const text = appLog(ctx).slice(from), out = [];
  for (const m of text.matchAll(re)) out.push({ tab: m[1], op: m[2], what: m[3], attached: m[4] === 'true' });
  return out;
}
const logMark = (ctx) => appLog(ctx).length;
const countWhat = (lines, op, what) => lines.filter((l) => l.op === op && l.what === what).length;
const attachErrors = (ctx, from = 0) => (appLog(ctx).slice(from).match(/already attached|Another debugger|Debugger is not attached|Target closed/gi) ?? []);
async function selectWs(ctx, W) {
  const { ui } = ctx;
  const pos = await ui.eval(`(() => { const n = [...document.querySelectorAll('.ws-item .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
  if (!pos) throw new Error(`sidebar row for ${W.branch} not found`);
  await ui.click(pos.x, pos.y);
  await waitFor(() => ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}))`), 15000, `${W.branch} to become the active workspace`);
}
async function openPane(ctx) {
  const { ui } = ctx;
  const state = await ui.eval(`(() => { const b = document.querySelector('button[aria-label="Show browser pane"],button[aria-label="Hide browser pane"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { open: b.getAttribute('aria-label') === 'Hide browser pane', x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!state) throw new Error('browser pane toggle not found');
  if (!state.open) await ui.click(state.x, state.y);
  await waitFor(() => ui.eval(`!!document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-url-input')`), 15000, 'the Browser pane to be open');
}
async function oracle(ctx, urlPrefix, ms = 20000) {
  const t = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.startsWith(urlPrefix)) || null, ms, `a panel page at ${urlPrefix}`);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
/** The REAL CLI bundle, with an `env -i` allowlist: exactly what an agent's Bash tool hands it. */
function cli(ctx, W, args, { timeoutMs = 60000 } = {}) {
  const base = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.world.fakeHome, ORCHESTRA_HOME: ctx.world.ohome, ORCHESTRA_WS_ID: W.id, ORCHESTRA_SESSION_KEY: W.key,
    ORCHESTRA_AGENT_TMPDIR: path.join(ctx.world.fakeHome, 'agent-tmp', W.name), LANG: 'C.UTF-8' };
  fs.mkdirSync(base.ORCHESTRA_AGENT_TMPDIR, { recursive: true });
  const t0 = Date.now();
  let child, settled = false;
  const done = new Promise((resolve) => {
    child = spawn(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'browser', ...args], { env: base, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.world.fakeHome });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); settled = true; resolve({ code: code ?? (signal ? 137 : 0), stdout, stderr, ms: Date.now() - t0, endedAt: Date.now() }); });
  });
  done.isSettled = () => settled;
  done.startedAt = t0;
  return done;
}
const show = (r) => `rc=${r.code} ${r.ms}ms stdout=${JSON.stringify(r.stdout.trim().slice(0, 160))} stderr=${JSON.stringify(r.stderr.trim().slice(0, 200))}`;

/** The composer as the human sees it: draft text + attached thumbnails (decoded PNGs). */
async function readComposer(ctx) {
  // several workspaces' composers can be mounted at once (the others hidden): read the VISIBLE one, the one the human is looking at
  const r = await ctx.ui.eval(`(() => { const box = [...document.querySelectorAll('.av-composer')].find((e) => e.offsetWidth || e.offsetHeight); const c = box?.querySelector('.cm-content'); const imgs = box ? [...box.querySelectorAll('.av-composer-attachment img')].map((i) => i.src) : []; return c ? { text: c.innerText, imgs } : null; })()`);
  if (!r) return null;
  return { text: r.text, thumbs: r.imgs.map((src) => { const m = /^data:image\/png;base64,(.+)$/.exec(src); try { return m ? decodePng(Buffer.from(m[1], 'base64')) : null; } catch { return null; } }), rawThumbs: r.imgs };
}
const PICK_HEADER = 'Selected element from the browser pane (Design Mode):';
const countPicks = (text) => text.split(PICK_HEADER).length - 1;
async function toggleDesign(ctx) {
  const pos = await ctx.ui.eval(`(() => { const b = document.querySelector('.browser-panel:not(.browser-panel-hidden) button[aria-label="Design mode"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: b.getAttribute('aria-pressed') === 'true' }; })()`);
  if (!pos) throw new Error('the Design mode toolbar button was not found');
  await ctx.ui.click(pos.x, pos.y);
  return pos.on;
}
const designPressed = (ctx) => ctx.ui.eval(`document.querySelector('.browser-panel:not(.browser-panel-hidden) button[aria-label="Design mode"]')?.getAttribute('aria-pressed') === 'true'`);
const wholeScreen = (name) => { const f = path.join(OUT, name); fs.mkdirSync(OUT, { recursive: true }); sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: RIG_WAYLAND, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } }); shots.push({ file: f, md5: md5(fs.readFileSync(f)) }); return f; };

/** Wait for the pick's text block, then its thumbnail; on a timeout say WHICH half is missing. */
async function pickLanded(ctx, picksBefore) {
  let c = null;
  try { c = await waitFor(async () => { const x = await readComposer(ctx); return x && countPicks(x.text) === picksBefore + 1 ? x : null; }, 15000, 'the pick text to land in the composer'); }
  catch (e) {
    const x = await readComposer(ctx);
    const all = await ctx.ui.eval(`[...document.querySelectorAll('.av-composer')].map((c) => ({ visible: !!(c.offsetWidth || c.offsetHeight), text: (c.querySelector('.cm-content')?.innerText ?? '').slice(0, 50), imgs: c.querySelectorAll('.av-composer-attachment img').length, ws: c.closest('[data-workspace-id]')?.getAttribute('data-workspace-id') ?? null }))`);
    throw new Error(`${e.message}; composer now: ${JSON.stringify({ picks: x ? countPicks(x.text) : null, thumbs: x?.rawThumbs.length, head: x?.text.slice(0, 80) })}; all composers: ${JSON.stringify(all)}`);
  }
  try { return await waitFor(async () => { const x = await readComposer(ctx); return x && x.thumbs.length === picksBefore + 1 && x.thumbs.every(Boolean) ? x : null; }, 15000, 'the pick thumbnail'); }
  catch (e) { throw new Error(`${e.message}; the TEXT half landed but the cropped screenshot did not (thumbs: ${c.thumbs.length})`); }
}

/** Arm design mode from the real toolbar, hover + click the card in the page with trusted input, and wait for the pick to land in the composer. */
async function pickCard(ctx, o, A, label, picksBefore) {
  if (await toggleDesign(ctx)) throw new Error('design mode was already armed');
  await waitFor(() => designPressed(ctx), 8000, 'the toolbar to show design mode armed');
  await waitFor(() => o.eval(`!!document.getElementById('__orchestra_design_overlay__')`), 10000, 'the design overlay to be injected into the page');
  const rect = await o.eval(`(() => { const r = document.getElementById('pick-me').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  await o.move(cx, cy);
  const hl = await waitFor(() => o.eval(`(() => { const b = document.getElementById('__orchestra_design_overlay__')?.firstChild; return b && parseFloat(b.style.width) > 0 ? { w: parseFloat(b.style.width), h: parseFloat(b.style.height) } : null; })()`), 5000, 'the hover highlight');
  clause(A, `${label}/hover-highlight-painted`, Math.abs(hl.w - rect.width) < 2 && Math.abs(hl.h - rect.height) < 2, `overlay box ${hl.w}x${hl.h} vs the card ${rect.width}x${rect.height}`);
  await sleep(1200); // ~8 renderer polls (150 ms) while armed: the lease must make them free
  const mark = logMark(ctx);
  await o.click(cx, cy);
  const comp = await pickLanded(ctx, picksBefore);
  return { rect, comp, mark };
}
function assertPick(ctx, A, label, comp, rect, picks) {
  const text = comp.text, last = text.slice(text.lastIndexOf(PICK_HEADER));
  const thumb = comp.thumbs[picks - 1];
  clause(A, `${label}/selector`, /selector: `[^`]*div#pick-me`/.test(last), `selector line: ${JSON.stringify((/- selector: `[^`]*`/.exec(last) ?? [''])[0])}`);
  clause(A, `${label}/outerHTML`, /```html\s*<div id="pick-me" class="card promo" data-testid="promo">.*Pick this card/s.test(last), `html block carries the card's markup: ${JSON.stringify((/```html\n([^\n]*)/.exec(last) ?? ['', ''])[1].slice(0, 110))}`);
  clause(A, `${label}/styles`, /padding: 14px 22px/.test(last) && /border-radius: 12px/.test(last) && /background-color: rgb\(253, 230, 138\)/.test(last), `css block: ${JSON.stringify([/padding: [^;]*;/, /border-radius: [^;]*;/, /background-color: [^;]*;/].map((r) => (r.exec(last) ?? [''])[0]))}`);
  const share = thumb ? colourShare(thumb, [253, 230, 138]) : 0;
  clause(A, `${label}/cropped-screenshot`, !!thumb && thumb.w >= rect.width && thumb.w <= rect.width + 18 && thumb.h >= rect.height && thumb.h <= rect.height + 18 && share > 0.5,
    `thumbnail ${thumb ? `${thumb.w}x${thumb.h}` : 'missing'} vs card ${Math.round(rect.width)}x${Math.round(rect.height)} (+8px padding each side); card-fill share ${(share * 100).toFixed(0)}% (a full-page shot would be mostly page background)`);
  if (thumb) saveShot(`${label}-thumbnail.png`, Buffer.from(comp.rawThumbs[picks - 1].replace(/^data:image\/png;base64,/, ''), 'base64'));
}

const ARM_FNS = {
  async 'static-attacher'(ctx) {
    const A = 'static-attacher';
    let g; try { g = { rc: 0, out: sh('node', [path.join(repoRoot, 'scripts/check-single-debugger-attacher.mjs'), '--list', '--root', repoRoot]) }; } catch (e) { g = { rc: e.status, out: String(e.stdout ?? '') }; }
    const seatAttach = g.out.split('\n').filter((l) => /^src\/main\/browser-cdp-seat\.ts:\d+: \[attach\(\]/.test(l));
    clause(A, 'ctl/gate-matches-the-proxys-own-attach', seatAttach.length === 1, `the SAME scan lists the proxy seat's attach: ${JSON.stringify(seatAttach[0] ?? null)}`);
    clause(A, 'source-has-one-attacher', g.rc === 0 && /^CLEAN/m.test(g.out) && !g.out.split('\n').some((l) => /^src\/main\/(?!browser-cdp-seat\.ts)/.test(l)), `scripts/check-single-debugger-attacher.mjs → rc ${g.rc}: ${g.out.trim().split('\n').pop()}`);
    let st; try { st = { rc: 0, out: sh('node', [path.join(repoRoot, 'scripts/check-single-debugger-attacher.mjs'), '--self-test', '--root', repoRoot]) }; } catch (e) { st = { rc: e.status, out: String(e.stdout ?? '') }; }
    clause(A, 'ctl/gate-can-say-dirty', st.rc === 0 && /SELF-TEST OK/.test(st.out), st.out.trim());
    // the BUILT bundle: one `.attach("1.3")`, and every `.debugger` reference sits in the seat's code
    const src = fs.readFileSync(mainChunk(), 'utf8');
    const attaches = [...src.matchAll(/\.attach\("1\.3"\)/g)].map((m) => m.index);
    const seatAt = attaches.length === 1 ? attaches[0] : -1;
    const seatFn = seatAt >= 0 ? src.slice(Math.max(0, seatAt - 120), seatAt + 1500) : '';
    clause(A, 'ctl/bundle-attach-is-the-seat', attaches.length >= 1 && /isAttached\(\)\|\|\w+\.attach\("1\.3"\)/.test(src) && /"attached":"shared"|\?"attached":"shared"/.test(seatFn), `${attaches.length} attach("1.3") call(s) in ${path.basename(mainChunk())}; the first sits in the seat function: ${/"attached":"shared"/.test(seatFn)}`);
    const dbgRefs = [...src.matchAll(/\.debugger\b/g)].map((m) => m.index);
    const outside = seatAt < 0 ? dbgRefs : dbgRefs.filter((i) => i < seatAt - 120 || i > seatAt + 1500);
    clause(A, 'bundle-has-one-attacher', attaches.length === 1 && dbgRefs.length > 0 && outside.length === 0, `built bundle: attach("1.3") ×${attaches.length}; .debugger references ×${dbgRefs.length}, outside the seat: ${outside.length}${outside.length ? ' e.g. ' + JSON.stringify(src.slice(outside[0] - 60, outside[0] + 60)) : ''}`);
  },

  async 'design-pick'(ctx) {
    // Design mode ALONE (no agent command yet), through the real UI: arm from the toolbar, hover, click, and read what the composer shows.
    const { W1, FIX, ui } = ctx; const A = 'design-pick';
    await selectWs(ctx, W1); await openPane(ctx);
    await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(FIX + '/design.html?ws=1')}).then(() => true)`);
    const o = await oracle(ctx, `${FIX}/design.html?ws=1`); ctx.o1 = o;
    clause(A, 'ctl/oracle-sees-the-page', (await o.eval('document.title')) === 'Design fixture', `oracle (the app's own debug port) title = ${JSON.stringify(await o.eval('document.title'))}`);
    const pre = await readComposer(ctx);
    clause(A, 'ctl/composer-starts-without-a-pick', !!pre && countPicks(pre.text) === 0 && pre.thumbs.length === 0, `composer draft ${JSON.stringify(pre?.text.slice(0, 40))}, ${pre?.thumbs.length} attachment(s)`);
    const log0 = logMark(ctx);
    const { rect, comp, mark } = await pickCard(ctx, o, A, 'pick', 0);
    assertPick(ctx, A, 'pick', comp, rect, 1);
    await waitFor(async () => !(await designPressed(ctx)), 8000, 'the toolbar to disarm after the pick').catch(() => {});
    clause(A, 'pick-disarms-one-shot', !(await designPressed(ctx)) && !(await o.eval(`!!document.getElementById('__orchestra_design_overlay__')`)), 'toolbar not pressed and no overlay left in the page (a pick is one-shot)');
    await sleep(500);
    const lines = seatLines(ctx, W1, log0);
    clause(A, 'one-attach-for-arm-polls-pick-and-screenshot', countWhat(lines, 'acquire', 'attached') === 1 && lines.filter((l) => l.op === 'acquire').length === 1, `seat trace for ${W1.id} since arming (${lines.length} line(s)): ${lines.map((l) => `${l.op}:${l.what}/${l.attached}`).join(' ')} — ~8 renderer polls and the cropped screenshot rode the ONE attach`);
    const last = lines[lines.length - 1];
    clause(A, 'debugger-released-after-the-pick', last?.op === 'release' && last.what === 'detached' && last.attached === false, `last seat line ${JSON.stringify(last)} (isAttached is Electron's own answer)`);
    clause(A, 'no-attach-error-in-the-app-log', attachErrors(ctx, log0).length === 0, `app log since arming: ${attachErrors(ctx, log0).join(' | ') || 'no "already attached"/"not attached"/"Target closed"'}`);
    ctx.pickMark = mark;
    wholeScreen('design-pick-screen.png');
  },

  async 'design-while-agent'(ctx) {
    // An agent command is IN FLIGHT on the same tab (`wait --fn` polls the page through the proxy) while the human picks. Neither may break.
    const { W1 } = ctx; const A = 'design-while-agent';
    const o = ctx.o1;
    const log0 = logMark(ctx);
    const wait = cli(ctx, W1, ['wait', '--fn', 'window.__release === true'], { timeoutMs: 120000 });
    await waitFor(() => seatLines(ctx, W1, log0).some((l) => l.op === 'acquire' && l.what === 'attached'), 30000, 'the agent session to take the debugger through the proxy');
    await sleep(800);
    clause(A, 'ctl/agent-command-is-in-flight', !wait.isSettled(), `\`orchestra browser wait --fn …\` started ${Date.now() - wait.startedAt} ms ago and has not returned; the proxy holds the debugger (${JSON.stringify(seatLines(ctx, W1, log0).map((l) => `${l.op}:${l.what}`))})`);
    const picksBefore = countPicks((await readComposer(ctx)).text);
    const { rect, comp } = await pickCard(ctx, o, A, 'pick-during-wait', picksBefore);
    const pickDoneAt = Date.now();
    assertPick(ctx, A, 'pick-during-wait', comp, rect, picksBefore + 1);
    clause(A, 'the-pick-finished-while-the-wait-was-still-running', !wait.isSettled() && pickDoneAt > wait.startedAt, `pick delivered ${pickDoneAt - wait.startedAt} ms after the wait started; the wait ${wait.isSettled() ? 'ALREADY RETURNED' : 'is still pending'}`);
    await o.eval('window.__release = true');
    const r = await Promise.race([wait, sleep(30000).then(() => null)]);
    clause(A, 'agent-wait-survives-the-pick-and-completes', !!r && r.code === 0 && !/detach|not attached|closed|error/i.test(r.stderr), r ? show(r) : 'the wait never returned after the flag was set (the debugger was pulled from under it?)');
    const lines = seatLines(ctx, W1, log0);
    clause(A, 'still-one-attach-and-no-detach-under-the-agent', countWhat(lines, 'acquire', 'attached') === 1 && countWhat(lines, 'release', 'detached') === 0 && lines.every((l) => l.attached), `seat trace since the wait began: ${lines.map((l) => `${l.op}:${l.what}/${l.attached}`).join(' ')} (the agent's daemon session holds the one attach; design mode shared it and left it alone)`);
    clause(A, 'no-attach-error-in-the-app-log', attachErrors(ctx, log0).length === 0, `app log since the wait began: ${attachErrors(ctx, log0).join(' | ') || 'clean'}`);
    const after = await cli(ctx, W1, ['eval', 'document.title']);
    clause(A, 'agent-still-drives-the-tab-afterwards', after.code === 0 && /Design fixture/.test(after.stdout), show(after));
    wholeScreen('design-while-agent-screen.png');
  },

  async 'design-then-agent'(ctx) {
    // The other order, on a workspace no agent ever touched: design mode takes the attach first; the agent's first command (which starts the host-owned daemon) joins it.
    const { W2, FIX, ui } = ctx; const A = 'design-then-agent';
    await selectWs(ctx, W2); await openPane(ctx);
    await ui.eval(`window.orchestra.browserNavigate(${sel(W2.id)}, ${sel(FIX + '/design.html?ws=2')}).then(() => true)`);
    const o = await oracle(ctx, `${FIX}/design.html?ws=2`); ctx.o2 = o;
    await waitFor(() => o.eval(`document.readyState === 'complete'`), 10000, 'W2 design page');
    const log0 = logMark(ctx);
    if (await toggleDesign(ctx)) throw new Error('design mode was already armed on W2');
    await waitFor(() => o.eval(`!!document.getElementById('__orchestra_design_overlay__')`), 10000, 'the design overlay on W2');
    await waitFor(() => seatLines(ctx, W2, log0).some((l) => l.op === 'acquire' && l.what === 'attached'), 5000, 'design mode to hold the attach');
    const first = seatLines(ctx, W2, log0);
    clause(A, 'design-armed-holds-the-attach-before-any-agent', first.length === 1 && first[0].attached === true, `seat trace after arming: ${first.map((l) => `${l.op}:${l.what}/${l.attached}`).join(' ')}`);
    // the agent's first-ever command on W2 now attaches a session WHILE design mode is armed
    const snap = await cli(ctx, W2, ['snapshot', '-i'], { timeoutMs: 60000 });
    const ev1 = await cli(ctx, W2, ['eval', 'document.title']);
    clause(A, 'agent-commands-work-while-design-is-armed', snap.code === 0 && /button "count"/.test(snap.stdout) && ev1.code === 0 && /Design fixture/.test(ev1.stdout), `${show(snap)} · ${show(ev1)}`);
    const picksBefore = countPicks((await readComposer(ctx)).text);
    // pick now (the toggle is already armed): hover + trusted click
    const rect = await o.eval(`(() => { const r = document.getElementById('pick-me').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    await o.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const comp = await pickLanded(ctx, picksBefore);
    assertPick(ctx, A, 'pick-agent-attached', comp, rect, picksBefore + 1);
    const ev2 = await cli(ctx, W2, ['eval', 'document.title']);
    const lines = seatLines(ctx, W2, log0);
    clause(A, 'one-attach-and-the-agents-session-keeps-it-after-the-pick', countWhat(lines, 'acquire', 'attached') === 1 && countWhat(lines, 'release', 'detached') === 0 && lines.every((l) => l.attached) && ev2.code === 0, `seat trace: ${lines.map((l) => `${l.op}:${l.what}/${l.attached}`).join(' ')}; agent eval after the pick: ${show(ev2)}`);
    clause(A, 'no-attach-error-in-the-app-log', attachErrors(ctx, log0).length === 0, `app log since arming: ${attachErrors(ctx, log0).join(' | ') || 'clean'}`);
    wholeScreen('design-then-agent-screen.png');
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
  return snap;
}

const before = liveCanary();
console.log(`[rig] app ${APP_DIR} arms ${ARM_LIST.join(',')} mutant=${MUTANT ?? 'none'} out=${OUT}`);
applyMutant();
await main();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('ctl', 'live-dirs-untouched', same, `${Object.keys(before).length} live probes (symlink-set + mcpServers hashes of each ~/.claude*) ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isCtl = (c) => c.arm === 'ctl' || c.clause.startsWith('ctl/');
const targetArms = new Set(MUTANT ? MUTANTS[MUTANT].arms : ARM_LIST);
// A mutant may break OTHER arms (collateral): their arm-scoped controls are not the mutant's concern. Global controls always are.
const ctlRed = results.filter((c) => isCtl(c) && !c.ok && (c.arm === 'ctl' || targetArms.has(c.arm))), armRed = results.filter((c) => !isCtl(c) && !c.ok);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, mutant: MUTANT, results, shots }, null, 2));
let verdict, rc;
if (MUTANT) {
  const want = MUTANTS[MUTANT].arms;
  const redArms = new Set(armRed.map((c) => c.arm));
  const missed = want.filter((a) => !redArms.has(a) && ARM_LIST.includes(a));
  ({ verdict, rc } = ctlRed.length === 0 && missed.length === 0 && want.some((a) => redArms.has(a))
    ? { verdict: `MUTANT ${MUTANT} KILLED: arm(s) ${want.filter((a) => redArms.has(a)).join(', ')} red (${armRed.filter((c) => want.includes(c.arm)).map((c) => c.clause).join(', ')}), every control green; other red arms: ${[...redArms].filter((a) => !want.includes(a)).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: arms not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => `${c.arm}:${c.clause}`).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && armRed.length === 0
    ? { verdict: `ALL GREEN: ${results.length} clauses (${results.filter(isCtl).length} controls, ${results.length - results.filter(isCtl).length} arm clauses) over ${ARM_LIST.length} arms`, rc: 0 }
    : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm}:${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
