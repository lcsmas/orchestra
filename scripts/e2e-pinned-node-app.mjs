// #390 — the BUILT app: does a keeper started by the shipped AppImage run on the bundled, pinned Node, and does an update leave a running keeper alone?
// Drives the real artifact in the compositor scripts/e2e-contained-rig.sh started (own headless sway, `env -i` allowlist, scratch ORCHESTRA_HOME/HOME/account),
// with the REAL `claude` CLI against the LOCAL fake Anthropic API (zero tokens, egress refused). Run through the wrapper:
//   scripts/e2e-pinned-node-app.sh [<Orchestra.AppImage>]        (default release/Orchestra.AppImage of this checkout; `pnpm run build` first)
// Phases (one story, one process):
//   A  the AppImage, a send from the composer → bundled runtime installed at startup, the keeper's argv[0]/exe is it (not the PATH node, not the mount)
//   B  quit the app → the AppImage mount vanishes; the keeper survives it, still on the installed runtime, still answering
//   C  "the update": a copy of the unpacked app shipping another pin version, same ORCHESTRA_HOME → new runtime dir; the old keeper keeps ITS runtime and still serves a turn; a new keeper gets the new one
//   D  UNFIXED counterpart (must-FAIL): the same package WITHOUT resources/pinned-node → the "keeper on the bundled runtime" clause is FALSE, the keeper itself still starts
// Terminator: `PINNED-NODE-APP: ALL PASS (N/N)` (rc 0). A missing terminator is not a pass.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('./pinned-node/lib.cjs');
const REAL_HOME = os.userInfo().homedir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const sha256 = (f) => lib.sha256File(f);

const RIG = { wayland: process.env.RIG_WAYLAND ?? '', swaysock: process.env.SWAYSOCK ?? '', base: process.env.ORCHESTRA_HOME ?? '', rigDir: process.env.RIG_DIR ?? '', liveCfg: process.env.CLAUDE_CONFIG_DIR ?? '' };
for (const k of ['wayland', 'swaysock', 'base', 'rigDir', 'liveCfg']) if (!RIG[k]) { console.log(`PINNED-NODE-APP: FAIL not launched via scripts/e2e-pinned-node-app.sh (missing ${k})`); process.exit(2); }
if (RIG.wayland === 'wayland-1') { console.log('PINNED-NODE-APP: FAIL refusing wayland-1 (the human\'s compositor)'); process.exit(2); }
const APPIMAGE = path.resolve(process.argv[2] ?? path.join(REPO, 'release', 'Orchestra.AppImage'));
const UNPACKED = path.join(path.dirname(APPIMAGE), `linux-${process.arch}-unpacked`);
for (const f of [APPIMAGE, path.join(UNPACKED, 'orchestra')]) if (!fs.existsSync(f)) { console.log(`PINNED-NODE-APP: FAIL ${f} missing — \`pnpm run build\` first`); process.exit(2); }
const PIN = lib.pinFor(lib.loadPins(), process.arch);
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

// ── clauses ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let nClauses = 0;
const failed = [];
function clause(name, ok, detail = '') {
  nClauses++;
  if (!ok) failed.push(name);
  console.log(`CLAUSE ${name}: ${ok ? 'PASS' : 'FAIL'} ${String(detail).replace(/\s+/g, ' ').slice(0, 330)}`);
  return ok;
}
async function waitFor(what, fn, ms = 15000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(step);
  }
}

// ── live-state hygiene (G10): the config/secrets surface of the human's real dirs, hashed before and after ──────────────────────────────────────────
function liveSurface() {
  const out = {};
  const dirs = [path.join(REAL_HOME, '.claude'), ...fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude-')).map((n) => path.join(REAL_HOME, n))];
  for (const d of dirs) {
    for (const n of ['settings.json', 'CLAUDE.md', '.credentials.json', '.claude.json', 'LESSONS.md']) {
      const f = path.join(d, n);
      try { out[f] = fs.lstatSync(f).isSymbolicLink() ? `-> ${fs.readlinkSync(f)}` : sha256(f); } catch { out[f] = 'absent'; }
    }
    try { out[`${d}/(entries)`] = fs.readdirSync(d).filter((n) => { try { return fs.lstatSync(path.join(d, n)).isSymbolicLink(); } catch { return false; } }).sort().join(','); } catch { /* unreadable */ }
  }
  // ~/.config/orchestra: the secrets file + the store backups + the entry NAMES. store.json, usage.json and logs/ are the LIVE app's own constant writes — not a signal.
  const ud = path.join(REAL_HOME, '.config', 'orchestra', 'orchestra');
  try {
    for (const n of fs.readdirSync(ud)) if (n === 'secrets.json' || /^store\.json\.bak/.test(n)) out[path.join(ud, n)] = sha256(path.join(ud, n));
    out[`${ud}/(entries)`] = fs.readdirSync(ud).filter((n) => n !== 'store.json' && n !== 'usage.json').sort().join(',');
  } catch { /* absent */ }
  for (const n of ['keeper.js']) { const f = path.join(REAL_HOME, '.orchestra', 'bin', n); try { out[f] = sha256(f); } catch { out[f] = 'absent'; } }
  try { out[`${REAL_HOME}/.orchestra/bin/(runtime dirs)`] = fs.readdirSync(path.join(REAL_HOME, '.orchestra', 'bin')).filter((n) => n.startsWith('node-')).sort().join(','); } catch { /* none */ }
  return out;
}

// ── tiny CDP client ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); const p = msg.id && this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result); } };
  }
  send(method, params = {}, ms = 15000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`cdp timeout ${ms}ms: ${method}`)); }, ms);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

// ── process helpers (identity = pid + start time; never a host-wide name match) ────────────────────────────────────────────────────────────────────
const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
const cmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const exeOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return null; } };
const procEnvHome = (pid) => { try { return /(?:^|\0)ORCHESTRA_HOME=([^\0]*)/.exec(fs.readFileSync(`/proc/${pid}/environ`, 'latin1'))?.[1] ?? null; } catch { return null; } };
const childPids = (root) => { const out = []; const all = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); const ppid = (p) => { try { const s = fs.readFileSync(`/proc/${p}/stat`, 'latin1'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); } catch { return 0; } }; const kids = new Map(); for (const d of all) { const pp = ppid(d); if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(Number(d)); } const walk = (p) => { for (const k of kids.get(p) ?? []) { out.push(k); walk(k); } }; walk(root); return out; };

/** A `probe` frame over the keeper's own socket: its helloAck, or null. Read-only — never claims the client slot. */
function probe(sockPath, wsId) {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    let buf = '';
    const done = (v) => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(null), 4000);
    s.on('error', () => done(null));
    s.on('connect', () => s.write(JSON.stringify({ t: 'probe', wsId }) + '\n'));
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); } } });
  });
}

const { startFakeApi } = await import(`${REPO}/scripts/session-budget/fake-anthropic-api.mjs`);
const api = await startFakeApi({});
// ── the world: scratch repo + 2 worktrees, scratch account, fake API ──────────────────────────────────────────────────────────────────────────────
const gitEnv = (home) => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_AUTHOR_NAME: 'pn', GIT_AUTHOR_EMAIL: 'pn@example.invalid', GIT_COMMITTER_NAME: 'pn', GIT_COMMITTER_EMAIL: 'pn@example.invalid', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, args, home) => execFileSync('git', args, { cwd, env: gitEnv(home), encoding: 'utf8' });
function liveDirs() { return [RIG.liveCfg, path.join(REAL_HOME, '.claude'), ...fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude-')).map((n) => path.join(REAL_HOME, n))].filter(Boolean); }
function assertScratchDir(dir, home) {
  const rp = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const c = rp(dir);
  for (const l of liveDirs()) { const lr = rp(l); if (c === lr || c.startsWith(lr + path.sep) || lr.startsWith(c + path.sep)) throw new Error(`REFUSED: ${dir} is/overlaps the live config dir ${l}`); }
  if (!c.startsWith(rp(home) + path.sep)) throw new Error(`REFUSED: ${dir} is not under this boot's home ${home}`);
}
function seedWorld(home) {
  const fakeHome = path.join(home, 'home');
  const repoDir = path.join(home, 'repo');
  fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# pn390 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const configDir = path.join(home, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  assertScratchDir(configDir, home);
  // The pinned account strips ambient ANTHROPIC_* from the agent env unless the account's OWN env re-supplies them (accountAgentEnv) — that is how the real CLI reaches the fake API.
  const account = { id: 'rig-pn390', label: 'rig (scratch config dir)', configDir, env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-pinned-node-390-fake-key-not-real' } };
  const workspaces = [1, 2].map((n) => {
    const wt = path.join(home, 'wt', `pn-${n}`);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/pn-${n}`, wt], fakeHome);
    return { id: `ws-pn-${n}`, name: `pn-${n}`, repoPath: repoDir, worktreePath: wt, branch: `e2e/pn-${n}`, baseBranch: 'main', createdAt: Date.now() + n, status: 'idle', agent: 'claude', accountId: account.id };
  });
  const listed = git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome);
  for (const w of workspaces) if (!listed.includes(`worktree ${fs.realpathSync(w.worktreePath)}`)) throw new Error(`seed worktree ${w.id} not registered`);
  const repo = { path: repoDir, name: 'pn-repo', defaultBranch: 'main', scripts: {}, accountId: account.id };
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [repo], workspaces, accounts: [account], selfTuneRuns: [] }, null, 2));
  return { fakeHome, account, workspaces };
}

async function freePort() {
  return await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const modelRequests = () => api.requests.filter((r) => r.type === 'model').length;

/** Boot one app (AppImage or an unpacked copy) on `home` (reusable across boots for the same story). */
async function boot(label, exe, home, world) {
  const port = await freePort();
  const claudeBin = path.join(REAL_HOME, '.local', 'bin');
  const env = {
    PATH: `${claudeBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: world.fakeHome, XDG_RUNTIME_DIR: privateRuntimeDir(),
    XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true',
    CLAUDE_CONFIG_DIR: world.account.configDir,
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-pinned-node-390-fake-key-not-real',
    HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    ORCHESTRA_KEEPER_LINGER_MS: '900000', ORCHESTRA_KEEPER_WEDGE_MS: '900000', // a keeper whose rig died still ends itself
  };
  if (env.WAYLAND_DISPLAY !== RIG.wayland || 'DISPLAY' in env) throw new Error('REFUSED: child env would reach a compositor that is not mine');
  const log = fs.openSync(path.join(home, `app-${label}.log`), 'w');
  const child = spawn(exe, ['--ozone-platform=wayland'], { env, stdio: ['ignore', log, log], cwd: world.fakeHome });
  const app = { label, home, port, child, pid: child.pid, exited: false, env, world };
  child.on('exit', () => { app.exited = true; });
  try {
    const targets = await waitFor(`CDP target on :${port}`, async () => {
      if (app.exited) throw new Error(`app exited early (see ${home}/app-${label}.log)`);
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t.length ? t : null; } catch { return null; }
    }, 60000, 300);
    app.target = targets[0];
    app.cdp = await Cdp.connect(app.target.webSocketDebuggerUrl);
    await app.cdp.send('Page.enable');
  } catch (e) { await quit(app); throw e; }
  app.logText = () => { try { return fs.readFileSync(path.join(home, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
  return app;
}
/** Quit by resolved pid (SIGTERM → the app detaches keepers); returns the descendant set it had. */
async function quit(app) {
  app.cdp?.close();
  try { process.kill(app.pid, 'SIGTERM'); } catch { /* gone */ }
  await waitFor('app exit', () => app.exited, 15000, 200).catch(() => { try { process.kill(app.pid, 'SIGKILL'); } catch { /* */ } });
  await sleep(500);
}

async function click(app, x, y) {
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
}
async function activate(app, name) {
  const row = await waitFor(`sidebar row ${name}`, () => app.cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-item')].find(x => x.textContent.includes(${JSON.stringify(name)})); if (!e) return null; const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return null;
    for (const f of [0.5, 0.12, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9]) { const cx = r.x + r.width * f, cy = r.y + r.height / 2; const h = document.elementFromPoint(cx, cy); if (h && e.contains(h) && !h.closest('button, .account-badge, .ws-icon-btn, a, input')) return { cx, cy }; }
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`), 20000);
  await click(app, row.cx, row.cy);
  await waitFor(`${name} active`, () => app.cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some(x => x.textContent.includes(${JSON.stringify(name)}))`), 8000, 100);
}
async function openAgentTab(app) {
  const t = await waitFor('Agent tab', () => app.cdp.eval(`(() => { const b = [...document.querySelectorAll('.toolbar .tabs .tab')].find(x => /^(Agent|Structured)/.test(x.textContent.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? { cx: r.x + r.width / 2, cy: r.y + r.height / 2, active: b.classList.contains('active') } : null; })()`), 20000);
  if (!t.active) await click(app, t.cx, t.cy);
}
/** Type into the visible composer through TRUSTED input and press Enter (the user's send path). */
async function composerSend(app, text) {
  const box = await waitFor('visible composer', () => app.cdp.eval(`(() => { for (const e of document.querySelectorAll('.cm-content')) { const r = e.getBoundingClientRect(); if (r.width > 50 && r.height > 5) return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; } return null; })()`), 20000);
  await click(app, box.cx, box.cy);
  await app.cdp.send('Input.insertText', { text });
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
const messageText = (app) => app.cdp.eval(`(() => { for (const l of document.querySelectorAll('.av-message-list')) { const r = l.getBoundingClientRect(); if (r.width > 50 && r.height > 50) return l.innerText; } return ''; })()`);

const keeperFiles = (home, ws) => ({ pid: path.join(home, 'keepers', `${ws}.pid`), sock: path.join(home, 'keepers', `${ws}.sock`) });
async function keeperOf(home, ws) {
  const f = keeperFiles(home, ws);
  const pid = await waitFor(`keeper pid file ${ws}`, () => { try { const p = JSON.parse(fs.readFileSync(f.pid, 'utf8')).pid; return procStart(p) ? p : null; } catch { return null; } }, 60000, 200);
  return { ws, pid, start: procStart(pid), sock: f.sock };
}
/** Send a message from the composer in the workspace row and wait for a settled turn on its keeper (everStarted, no turn in flight) AND the rendered reply. */
async function turnOn(app, name, ws, text) {
  await activate(app, name);
  await openAgentTab(app);
  const before = modelRequests();
  await composerSend(app, text);
  const k = await keeperOf(app.home, ws);
  await waitFor(`a model request for "${text}"`, () => modelRequests() > before, 60000, 200);
  const settled = await waitFor(`${ws} turn settled`, async () => { const a = await probe(k.sock, ws); return a && a.running && a.everStarted && !a.turnInFlight ? a : null; }, 60000, 400);
  await waitFor(`rendered reply for "${text}"`, async () => (await messageText(app)).includes(text) , 30000, 300).catch(() => {});
  return { keeper: k, ack: settled };
}

/** The clause set for "this keeper runs on the bundled runtime" — returned as data so the UNFIXED arm can require it FALSE through the SAME code. */
function bundledEvidence(app, k) {
  const argv = cmdline(k.pid);
  const dirs = fs.existsSync(path.join(app.home, 'bin')) ? fs.readdirSync(path.join(app.home, 'bin')).filter((n) => /^node-\d/.test(n)) : [];
  const installed = dirs.map((d) => path.join(app.home, 'bin', d, 'node'));
  const argv0IsBundled = installed.includes(argv[0]);
  let exeReal = null;
  try { exeReal = fs.realpathSync(`/proc/${k.pid}/exe`); } catch { /* gone */ }
  return { argv, argv0: argv[0], installed, argv0IsBundled, exeReal, exeIsBundled: installed.some((p) => exeReal === fs.realpathSync(p)), keeperJsArg: argv[1], dirs };
}

function snapshotRuntime(file) { const st = fs.statSync(file); return { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, sha: sha256(file) }; }

// ═══ the story ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const before = liveSurface();
const shots = [];
const apps = [];
let storyErr = null;
const home1 = path.join(RIG.base, 'a');
const homeD = path.join(RIG.base, 'd');
fs.mkdirSync(home1, { recursive: true });
fs.mkdirSync(homeD, { recursive: true });
const pathNode = ['/usr/local/bin', '/usr/bin', '/bin'].map((d) => path.join(d, 'node')).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
console.log(`PINNED-NODE-APP: AppImage ${APPIMAGE} (${fs.statSync(APPIMAGE).size} B) · repo package.json ${PKG_VERSION} · pin v${PIN.version} ${process.arch} nodeSha256 ${PIN.nodeSha256.slice(0, 12)} · rig ${RIG.rigDir} · wayland ${RIG.wayland}`);

try {
  // ── Phase A: the AppImage ──
  const world1 = seedWorld(home1);
  const A = await boot('A', APPIMAGE, home1, world1); apps.push(A);
  const running = await A.cdp.eval('window.orchestra.getAppVersion()');
  const mount = /^file:\/\/(\/tmp\/\.mount_[^/]+)\//.exec(A.target.url)?.[1] ?? null;
  console.log(`IDENTITY  version(running)=${running} version(package.json)=${PKG_VERSION} target=${A.target.url}`);
  clause('A/identity-version', running === PKG_VERSION, `running=${running} package.json=${PKG_VERSION}`);
  clause('A/target-is-the-appimage-mount', !!mount && fs.existsSync(mount), `mount=${mount}`);
  const live = (() => { try { return fs.readFileSync(`/proc/${A.pid}/environ`, 'latin1').split('\0'); } catch { return []; } })();
  clause('A/isolation', live.includes(`ORCHESTRA_HOME=${home1}`) && live.includes(`WAYLAND_DISPLAY=${RIG.wayland}`) && !live.some((e) => e.startsWith('DISPLAY=')) && live.includes(`CLAUDE_CONFIG_DIR=${world1.account.configDir}`) && live.some((e) => e.startsWith('APPIMAGE=')), `read back from /proc/${A.pid}/environ: home, my wayland socket, scratch account, APPIMAGE set`);
  clause('A/positive-control-path-node-exists', !!pathNode, `a PATH node (${pathNode}) exists — the pre-change launcher would have picked it under this AppImage`);

  const runtimeDir = await waitFor('runtime dir installed at startup', () => fs.readdirSync(path.join(home1, 'bin')).find((n) => /^node-\d/.test(n)), 20000, 200).catch(() => null);
  const installed = runtimeDir ? path.join(home1, 'bin', runtimeDir, 'node') : null;
  clause('A/runtime-installed-before-any-session', !!installed && runtimeDir === `node-${PIN.version}-${PIN.nodeSha256.slice(0, 12)}`, `bin/${runtimeDir} (before any send; keepers dir exists: ${fs.existsSync(path.join(home1, 'keepers'))})`);
  clause('A/installed-bytes-are-the-pin', !!installed && sha256(installed) === PIN.nodeSha256 && (fs.statSync(installed).mode & 0o111) !== 0, `sha256 ${installed ? sha256(installed).slice(0, 16) : '-'} vs pin ${PIN.nodeSha256.slice(0, 16)}`);
  const runtimeSnap = snapshotRuntime(installed);

  const t1 = await turnOn(A, 'pn-1', 'ws-pn-1', 'pinned-node-390 first turn');
  const kA = t1.keeper;
  const evA = bundledEvidence(A, kA);
  console.log(`KEEPER A  pid=${kA.pid} argv=${evA.argv.join(' ').slice(0, 200)} exe=${evA.exeReal}`);
  clause('A/keeper-argv0-is-the-bundled-runtime', evA.argv0IsBundled && evA.argv0 === installed, `argv[0]=${evA.argv0}`);
  clause('A/keeper-exe-is-the-bundled-runtime', evA.exeIsBundled, `/proc/${kA.pid}/exe → ${evA.exeReal}`);
  clause('A/keeper-not-on-the-mount-or-path-node', !!evA.exeReal && !evA.exeReal.startsWith('/tmp/.mount_') && evA.exeReal !== fs.realpathSync(pathNode), `exe=${evA.exeReal} (PATH node ${pathNode} → ${fs.realpathSync(pathNode)})`);
  clause('A/keeper-script-is-the-copied-out-bundle', evA.keeperJsArg === path.join(home1, 'bin', 'keeper.js'), `argv[1]=${evA.keeperJsArg}`);
  // Nothing the keeper EXECUTES or maps comes from the mount (exe, cwd, root, mapped files). Inherited Chromium fds into the mount are a separate, pre-existing fact: printed, not asserted.
  const onMount = (pid) => { const hits = []; for (const f of ['exe', 'cwd', 'root']) { try { if (fs.readlinkSync(`/proc/${pid}/${f}`).startsWith(mount)) hits.push(f); } catch { /* */ } } try { if (fs.readFileSync(`/proc/${pid}/maps`, 'utf8').includes(mount)) hits.push('maps'); } catch { /* */ } return hits; };
  const leakedFds = (pid) => { let n = 0; try { for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith(mount)) n++; } catch { /* */ } } } catch { /* */ } return n; };
  clause('A/keeper-executes-nothing-from-the-mount', onMount(kA.pid).length === 0, `exe/cwd/root/maps on ${mount}: [${onMount(kA.pid).join(',')}]`);
  console.log(`NOTE  keeper pid ${kA.pid} holds ${leakedFds(kA.pid)} inherited fd(s) into the AppImage mount (Chromium's, pre-existing: it keeps the mount pinned while any keeper lives; the 11 live fleet keepers do the same)`);
  clause('A/app-log-names-the-runtime', A.logText().includes(`runtime: bundled ${installed}`), `orchestra.log: ${(A.logText().split('\n').find((l) => l.includes('runtime: ')) ?? '(no line)').slice(-160)}`);
  const reply = await messageText(A);
  clause('A/session-works-end-to-end', reply.includes('pinned-node-390 first turn') && t1.ack.everStarted === true && modelRequests() >= 1, `user row rendered, keeper everStarted=${t1.ack.everStarted}, fake API model requests=${modelRequests()}`);
  shots.push(await shot(A, 'A-agent-view-after-turn'));
  const cliPid = t1.ack.pid;
  clause('A/cli-child-of-keeper', !!cliPid && procStart(cliPid) !== null, `claude CLI pid ${cliPid}`);

  // ── Phase B: quit, then take the mount away (lazy unmount — what a real quit does once nothing pins it) → the keeper survives on the installed runtime ──
  await quit(A);
  const mountedBefore = fs.readFileSync('/proc/self/mountinfo', 'utf8').includes(` ${mount} `);
  execFileSync('fusermount', ['-uz', mount], { env: { PATH: '/usr/bin:/bin' } });
  const mountedAfter = await waitFor('mount detached', () => !fs.readFileSync('/proc/self/mountinfo', 'utf8').includes(` ${mount} `), 15000, 200).then(() => false).catch(() => true);
  clause('B/appimage-mount-taken-away', mountedBefore && !mountedAfter, `mounted before=${mountedBefore} after \`fusermount -uz\`=${mountedAfter}; /proc/${kA.pid}/fd links into it are now stale`);
  try { fs.rmdirSync(mount); } catch { /* the runtime may remove it itself */ }
  const stillA = procStart(kA.pid) === kA.start;
  const pA = stillA ? await probe(kA.sock, 'ws-pn-1') : null;
  clause('B/keeper-survived-quit-and-mount', stillA && !!pA && pA.running === true, `pid ${kA.pid} same start-time=${stillA}; probe running=${pA?.running}`);
  const exeB = exeOf(kA.pid);
  clause('B/keeper-runtime-still-installed-not-deleted', !!exeB && !/\(deleted\)/.test(exeB) && fs.realpathSync(exeB) === fs.realpathSync(installed), `/proc/${kA.pid}/exe → ${exeB}`);

  // ── Phase C: the update — same home, an unpacked copy shipping another pin version ──
  const updApp = path.join(RIG.rigDir, 'upd-app');
  execFileSync('cp', ['-a', '--reflink=auto', UNPACKED, updApp]);
  const mf = path.join(updApp, 'resources', 'pinned-node', 'manifest.json');
  const m0 = JSON.parse(fs.readFileSync(mf, 'utf8'));
  fs.writeFileSync(mf, JSON.stringify({ ...m0, version: '22.99.0' })); // same bytes, other version → another versioned dir (an update that ships another Node)
  const C = await boot('C', path.join(updApp, 'orchestra'), home1, world1); apps.push(C);
  const newDirName = `node-22.99.0-${PIN.nodeSha256.slice(0, 12)}`;
  const newInstalled = path.join(home1, 'bin', newDirName, 'node');
  await waitFor('new runtime dir', () => fs.existsSync(newInstalled), 20000, 200).catch(() => {});
  clause('C/update-installed-a-new-versioned-dir', fs.existsSync(newInstalled) && sha256(newInstalled) === PIN.nodeSha256, `bin/ now: ${fs.readdirSync(path.join(home1, 'bin')).filter((n) => /^node-/.test(n)).join(', ')}`);
  const snapAfter = snapshotRuntime(installed);
  clause('C/old-runtime-untouched', snapAfter.ino === runtimeSnap.ino && snapAfter.mtimeMs === runtimeSnap.mtimeMs && snapAfter.sha === runtimeSnap.sha, `inode ${runtimeSnap.ino}→${snapAfter.ino}, mtime equal=${snapAfter.mtimeMs === runtimeSnap.mtimeMs}, sha equal=${snapAfter.sha === runtimeSnap.sha}`);
  clause('C/running-keeper-still-on-old-runtime', procStart(kA.pid) === kA.start && cmdline(kA.pid)[0] === installed && fs.realpathSync(exeOf(kA.pid)) === fs.realpathSync(installed), `pid ${kA.pid} argv[0]=${cmdline(kA.pid)[0]}`);
  const t2 = await turnOn(C, 'pn-1', 'ws-pn-1', 'pinned-node-390 second turn after the update');
  clause('C/old-keeper-serves-a-turn-after-the-update', t2.keeper.pid === kA.pid && cmdline(kA.pid)[0] === installed && (await messageText(C)).includes('second turn after the update'), `same keeper pid ${t2.keeper.pid}, still argv[0] ${path.basename(path.dirname(cmdline(kA.pid)[0]))}`);
  const t3 = await turnOn(C, 'pn-2', 'ws-pn-2', 'pinned-node-390 new session on the new runtime');
  const evNew = bundledEvidence(C, t3.keeper);
  clause('C/new-keeper-on-the-new-runtime', evNew.argv0 === newInstalled && evNew.argv0 !== installed && t3.keeper.pid !== kA.pid, `ws-pn-2 keeper pid ${t3.keeper.pid} argv[0]=${evNew.argv0}`);
  shots.push(await shot(C, 'C-agent-view-new-keeper'));
  await quit(C);

  // ── Phase D: the UNFIXED counterpart — the same package without resources/pinned-node ──
  const noBundle = path.join(RIG.rigDir, 'nobundle-app');
  execFileSync('cp', ['-a', '--reflink=auto', UNPACKED, noBundle]);
  fs.rmSync(path.join(noBundle, 'resources', 'pinned-node'), { recursive: true, force: true });
  const worldD = seedWorld(homeD);
  const D = await boot('D', path.join(noBundle, 'orchestra'), homeD, worldD); apps.push(D);
  const tD = await turnOn(D, 'pn-1', 'ws-pn-1', 'pinned-node-390 unfixed arm');
  const evD = bundledEvidence(D, tD.keeper);
  console.log(`KEEPER D (no bundle)  pid=${tD.keeper.pid} argv[0]=${evD.argv0}`);
  clause('D/control-the-keeper-still-starts-and-serves', tD.ack.everStarted === true && (await messageText(D)).includes('unfixed arm'), `keeper pid ${tD.keeper.pid} everStarted=${tD.ack.everStarted}`);
  clause('D/MUST-FAIL-bundled-clause-is-false-without-the-bundle', evD.argv0IsBundled === false && evD.exeIsBundled === false && evD.dirs.length === 0, `argv[0]=${evD.argv0} (not a bin/node-* runtime), no runtime dirs: ${evD.dirs.length === 0}`);
  await quit(D);
} catch (e) {
  storyErr = e;
  console.log(`STORY ERROR: ${String(e?.stack ?? e).split('\n').slice(0, 4).join(' ⏎ ')}`);
}

async function shot(app, name) {
  const r = await app.cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
  const file = path.join(app.home, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  const g = path.join(app.home, `${name}-compositor.png`);
  try { execFileSync('grim', ['-o', 'HEADLESS-1', g], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 }); } catch { /* compositor capture is corroboration */ }
  return { name, file, grim: fs.existsSync(g) ? g : null };
}

// ── teardown: everything carrying one of THIS rig's ORCHESTRA_HOMEs, by (pid, start-time) identity ────────────────────────────────────────────────
for (const a of apps) if (!a.exited) await quit(a);
const mine = new Set([home1, homeD]);
for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).map(Number)) {
  const h = procEnvHome(d);
  if (h && mine.has(h)) { const s = procStart(d); try { process.kill(d, 'SIGKILL'); } catch { /* gone */ } void s; }
}
api.stop?.();

// ── hygiene + screenshots ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const after = liveSurface();
const diffs = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
clause('hygiene/live-config-surface-byte-equal', diffs.length === 0, diffs.length ? `CHANGED: ${diffs.join(', ')}` : `${Object.keys(before).length} files/entries under ~/.claude*, ~/.config/orchestra, ~/.orchestra/bin hashed before == after`);
const hashes = shots.flatMap((s) => [s.file, s.grim].filter(Boolean)).map((f) => ({ f, md5: md5(f) }));
for (const h of hashes) console.log(`SHOT ${h.f} md5=${h.md5}`);
clause('hygiene/screenshots-distinct', hashes.length >= 2 && new Set(hashes.map((h) => h.md5)).size === hashes.length, `${hashes.length} captures, ${new Set(hashes.map((h) => h.md5)).size} distinct md5`);
const outDir = process.env.PN390_SHOTS || path.join(RIG.rigDir, 'shots'); // inside the rig dir (disk-backed); never a new path in /tmp
fs.mkdirSync(outDir, { recursive: true });
for (const h of hashes) fs.copyFileSync(h.f, path.join(outDir, path.basename(h.f).replace(/^/, `${path.basename(path.dirname(h.f))}-`)));
console.log(`SHOTS copied to ${outDir}`);

const ok = !storyErr && failed.length === 0 && nClauses > 0;
console.log(ok ? `PINNED-NODE-APP: ALL PASS (${nClauses}/${nClauses})` : `PINNED-NODE-APP: FAIL (${failed.length} of ${nClauses} clauses${storyErr ? ', story error' : ''}): ${failed.join(', ')}`);
process.exit(ok ? 0 : 1);
