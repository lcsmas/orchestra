#!/usr/bin/env node
// Orca-style sidebar drive (layout C + glyph set G2, 2026-10-31) on a BUILT Orchestra: selection-driven fold/unfold,
// ONE sliding selection frame around the selected tree, the coordinator rollup glyph, root-only unseen-done bell,
// title-only rows (status note in the tooltip), no PR / agent-count badges (absorbs e2e-sidebar-declutter-drive).
// Run through scripts/e2e-sidebar-orca-drive.sh <app-dir>. Helpers COPIED from e2e-sidebar-declutter-drive.mjs.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const APP_DIR = fs.realpathSync(process.argv[2] ?? '');
const RIG = { wayland: process.env.RIG_WAYLAND ?? '', swaysock: process.env.SWAYSOCK ?? '', base: process.env.ORCHESTRA_HOME ?? '', liveCfg: process.env.CLAUDE_CONFIG_DIR ?? '' };
const REAL_HOME = os.userInfo().homedir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 15000, step = 150) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout ${ms}ms: ${what}`); await sleep(step); }
}
const RESULTS = [];
const clause = (name, ok, detail = '') => { RESULTS.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); return !!ok; };
const note = (l) => console.log(`      ${l}`);

// ── copied helpers ───────────────────────────────────────────────────────────
const procEnv = (pid) => { const o = {}; for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1); } return o; };
const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
function descendants(root) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'latin1'); const ppid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(Number(d)); } catch { /* raced */ }
  }
  const out = [], stack = [root];
  while (stack.length) { const p = stack.pop(); for (const k of kids.get(p) ?? []) { out.push(k); stack.push(k); } }
  return out;
}
class Cdp {
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); }); return new Cdp(ws); }
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
const gitEnv = (home) => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_AUTHOR_NAME: 'efb', GIT_AUTHOR_EMAIL: 'efb@example.invalid', GIT_COMMITTER_NAME: 'efb', GIT_COMMITTER_EMAIL: 'efb@example.invalid', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, args, home) => execFileSync('git', args, { cwd, env: gitEnv(home), encoding: 'utf8' });
async function freePort() { return await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

function checkChildEnv(env, mine) {
  const got = env.WAYLAND_DISPLAY;
  if (!got) return { ok: false, clause: 'no-wayland-display' };
  if (got === 'wayland-1') return { ok: false, clause: 'refuse-wayland-1' };
  if (!mine) return { ok: false, clause: 'no-rig-display' };
  if (got !== mine) return { ok: false, clause: 'not-my-compositor', detail: `${got} != ${mine}` };
  if ('DISPLAY' in env) return { ok: false, clause: 'x11-display-set' };
  return { ok: true, clause: 'display-isolated', detail: `WAYLAND_DISPLAY=${got}, DISPLAY absent` };
}
function checkScratchConfig(configDir, live, home) {
  const rp = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const c = rp(configDir);
  if (c === rp(REAL_HOME)) return { ok: false, clause: 'is-real-home' };
  for (const l of live.filter(Boolean)) { const lr = rp(l); if (c === lr || c.startsWith(lr + path.sep) || lr.startsWith(c + path.sep)) return { ok: false, clause: 'overlaps-live-config', detail: `${configDir} vs ${l}` }; }
  if (!c.startsWith(rp(home) + path.sep)) return { ok: false, clause: 'outside-boot-home' };
  return { ok: true, clause: 'scratch-config' };
}
function liveSnapshot(dir) {
  const snap = { dir, exists: fs.existsSync(dir), links: [], managed: [], manifest: null, mcp: null };
  if (!snap.exists) return JSON.stringify(snap);
  for (const sub of ['', 'skills']) {
    let ents = []; try { ents = fs.readdirSync(path.join(dir, sub)); } catch { /* absent */ }
    for (const n of ents.sort()) { const f = path.join(dir, sub, n); try { if (fs.lstatSync(f).isSymbolicLink()) snap.links.push(`${path.join(sub, n)} -> ${fs.readlinkSync(f)}`); } catch { /* raced */ } }
  }
  for (const n of ['CLAUDE.md', 'settings.json', 'LESSONS.md']) if (fs.existsSync(path.join(dir, n))) snap.managed.push(n);
  try { snap.manifest = fs.readFileSync(path.join(dir, '.orchestra-inherited.json'), 'utf8'); } catch { /* none */ }
  try { snap.mcp = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers ?? {}).sort(); } catch { snap.mcp = 'unreadable'; }
  return JSON.stringify(snap);
}
function claudeSiblingDirs(home) {
  let names = []; try { names = fs.readdirSync(home); } catch { return []; }
  const out = [];
  for (const n of names) { if (!n.startsWith('.claude-')) continue; try { if (fs.statSync(path.join(home, n)).isDirectory()) out.push(path.join(home, n)); } catch { /* skip */ } }
  return out;
}
const liveDirs = () => [...new Set([RIG.liveCfg, path.join(REAL_HOME, '.claude'), ...claudeSiblingDirs(REAL_HOME)].filter(Boolean))].filter((d) => fs.existsSync(d));
const shimFile = path.join(REAL_HOME, '.local', 'bin', 'orchestra');
const shimHash = () => { try { return md5(shimFile); } catch { return 'absent'; } };

// ── world ────────────────────────────────────────────────────────────────────
// OPS (orchestrator, pinned tree, idle, status note) ─ C1 (autoUnread child, linked PR), C2 (waiting child)
// P (promoted worktree, repo section) ─ K1, K2 (never ran)      R (root, autoUnread, no kids)      L (root, no kids)
const ID = { ops: 'ws-sor-ops', c1: 'ws-sor-c1', c2: 'ws-sor-c2', p: 'ws-sor-p', k1: 'ws-sor-k1', k2: 'ws-sor-k2', r: 'ws-sor-r', l: 'ws-sor-l', m: 'ws-sor-m' };
const BR = { c1: 'worker-done-c1', c2: 'worker-asks-c2', p: 'promoted-lead-p', k1: 'kid-one-k1', k2: 'kid-two-k2', r: 'root-unseen-r', l: 'root-leaf-l', m: 'other-repo-m' };
const PR = (n) => ({ url: `https://github.com/lcsmas/orchestra/pull/${n}`, owner: 'lcsmas', repo: 'orchestra', number: n });
const NOTE = 'reviewing wave 7 — 2 workers out';

function seedWorld(home) {
  const fakeHome = path.join(home, 'home'), repoDir = path.join(home, 'repo');
  fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# sor seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const configDir = path.join(home, 'claude-config'); fs.mkdirSync(configDir, { recursive: true });
  const g = checkScratchConfig(configDir, liveDirs(), home);
  if (!g.ok) throw new Error(`REFUSED before seeding [${g.clause}]: ${g.detail ?? ''}`);
  const account = { id: 'rig-sor', label: 'rig (scratch config dir)', configDir };
  const wt = (key, branch) => { const p = path.join(home, 'wt', key); fs.mkdirSync(path.dirname(p), { recursive: true }); git(repoDir, ['worktree', 'add', '-q', '-b', branch, p], fakeHome); return p; };
  const now = Date.now();
  const base = { baseBranch: 'main', createdAt: now, status: 'idle', agent: 'claude', accountId: account.id };
  const opsDir = path.join(home, 'scratch', 'ops'); fs.mkdirSync(opsDir, { recursive: true });
  const ops = { ...base, id: ID.ops, name: 'ops-wave', kind: 'orchestrator', repoPath: '', worktreePath: opsDir, branch: 'ops-wave', baseBranch: '', setupStatus: 'ok', lastTurnStartAt: now - 60000, statusText: NOTE, statusTextAt: now - 120000 };
  const mk = (key, extra) => ({ ...base, id: ID[key], name: `sor-repo · ${BR[key]}`, repoPath: repoDir, worktreePath: wt(key, BR[key]), branch: BR[key], lastTurnStartAt: now - 30000, ...extra });
  const c1 = mk('c1', { parentId: ID.ops, autoUnread: true, linkedPrs: [PR(1)], linkedLinearKey: 'NMC-2541' });
  const c2 = mk('c2', { parentId: ID.ops }); // a seeded non-idle status is reset at boot: states are driven through the spool
  const p = mk('p', { canOrchestrate: true });
  const k1 = mk('k1', { parentId: ID.p, lastTurnStartAt: undefined });
  const k2 = mk('k2', { parentId: ID.p, lastTurnStartAt: undefined });
  const r = mk('r', { autoUnread: true });
  const l = mk('l', {});
  const repo = { path: repoDir, name: 'sor-repo', defaultBranch: 'main', scripts: {}, accountId: account.id };
  const repo2Dir = path.join(home, 'repo2'); fs.mkdirSync(repo2Dir, { recursive: true });
  git(repo2Dir, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo2Dir, 'README.md'), '# second\n');
  git(repo2Dir, ['add', '.'], fakeHome); git(repo2Dir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const repo2 = { path: repo2Dir, name: 'sor-other', defaultBranch: 'main', scripts: {}, accountId: account.id };
  const mDir = path.join(home, 'wt', 'm'); git(repo2Dir, ['worktree', 'add', '-q', '-b', BR.m, mDir], fakeHome);
  const m = { ...base, id: ID.m, name: `sor-other · ${BR.m}`, repoPath: repo2Dir, worktreePath: mDir, branch: BR.m, lastTurnStartAt: now - 30000 };
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ repos: [repo, repo2], workspaces: [ops, c1, c2, p, k1, k2, r, l, m], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(home, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  const stubLog = path.join(home, 'stub-argv.log');
  fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\necho "$$ $*" >> '${stubLog}'\nsleep 3600\n`, { mode: 0o755 });
  const ghLog = path.join(home, 'gh-calls.log');
  fs.writeFileSync(path.join(stubDir, 'gh'), `#!/bin/sh\necho "$*" >> '${ghLog}'\necho "gh: stub" >&2\nexit 1\n`, { mode: 0o755 });
  return { fakeHome, repoDir, account, stubDir, stubLog, storeFile, ghLog };
}
async function bootApp(home, world, label) {
  const port = await freePort();
  const electron = [path.join(APP_DIR, 'node_modules/electron/dist/electron')].find((p) => fs.existsSync(p));
  if (!electron) throw new Error('no electron binary in the app dir');
  const env = {
    PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: privateRuntimeDir(),
    XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.account.configDir,
  };
  const pre = checkChildEnv(env, RIG.wayland);
  if (!pre.ok) throw new Error(`REFUSED before launch [${pre.clause}]: ${pre.detail ?? ''}`);
  for (const [k, v] of Object.entries({ HOME: env.HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, 'account.configDir': world.account.configDir })) {
    const r = checkScratchConfig(v, liveDirs(), home);
    if (!r.ok && !(k === 'HOME' && v.startsWith(home))) throw new Error(`REFUSED before launch [handoff:${k}:${r.clause}]: ${r.detail ?? v}`);
  }
  const log = fs.openSync(path.join(home, `app-${label}.log`), 'w');
  const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', log, log] });
  const app = { home, port, child, pid: child.pid, env, world, exited: false, cdp: null };
  child.on('exit', () => { app.exited = true; });
  try {
    const targets = await waitFor(`CDP target on :${port}`, async () => {
      if (app.exited) throw new Error(`electron exited early (see ${home}/app-${label}.log)`);
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t.length ? t : null; } catch { return null; }
    }, 40000, 300);
    app.target = targets[0];
    app.cdp = await Cdp.connect(app.target.webSocketDebuggerUrl);
    await app.cdp.send('Page.enable');
  } catch (e) { await closeApp(app); throw e; }
  return app;
}
async function closeApp(app) {
  const pids = descendants(app.pid).map((p) => ({ p, s: procStart(p) }));
  app.cdp?.close();
  try { process.kill(app.pid, 'SIGTERM'); } catch { /* gone */ }
  await waitFor('electron exit', () => app.exited, 8000, 200).catch(() => { try { process.kill(app.pid, 'SIGKILL'); } catch { /* */ } });
  await sleep(500);
  for (const { p, s } of pids) if (procStart(p) === s && s !== null) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; try { if (procEnv(d).ORCHESTRA_HOME === app.home) process.kill(Number(d), 'SIGKILL'); } catch { /* not ours */ } }
}

async function mouse(app, type, x, y, extra = {}) { await app.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }); }
async function shot(app, name) { const r = await app.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000); const f = path.join(app.home, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; }
function grim(app, name) { const f = path.join(app.home, `${name}.png`); execFileSync('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 }); return f; }
async function click(app, x, y) { await mouse(app, 'mouseMoved', x, y); await sleep(80); await mouse(app, 'mousePressed', x, y, { clickCount: 1 }); await mouse(app, 'mouseReleased', x, y, { clickCount: 1 }); await sleep(400); }
const SHOTS = [];
// ── observables ──────────────────────────────────────────────────────────────
const stateJs = `(() => {
  const list = document.querySelector('.ws-list'); const fr = document.querySelector('.ws-selection-frame');
  if (!list || !fr) return { rows: [], repos: [], frame: { on: false }, sidebarBg: null, rowFont: null, orch: 0, innerWidth }; // not rendered yet
  const fb = fr.getBoundingClientRect();
  const rows = [...document.querySelectorAll('.ws-list .ws-item')].filter((r) => r.querySelector('.ws-name')).map((row) => {
    const name = row.querySelector('.ws-name'); const g = row.querySelector('.ws-glyph'); const b = row.getBoundingClientRect();
    const gb = g ? getComputedStyle(g, '::before') : null;
    return { text: name.textContent.trim(), title: name.title, cls: row.className, folded: row.classList.contains('ws-folded'), inert: row.inert,
      tree: row.classList.contains('ws-in-selected-tree'), active: row.classList.contains('active'), h: Math.round(b.height),
      top: Math.round(b.top), bottom: Math.round(b.bottom), glyph: g ? g.className : null, glyphTitle: g ? g.title : null, glyphSvg: !!g?.querySelector('svg'),
      glyphDotW: gb && gb.content !== 'none' ? gb.width : null, glyphDotBg: gb && gb.content !== 'none' ? gb.backgroundColor : null,
      hidden: [...row.querySelectorAll('.ws-hidden-count')].filter((x) => x.closest('.ws-item') === row).map((x) => ({ dots: [...x.querySelectorAll('.ws-hidden-dot')].map((d) => d.className.replace('ws-hidden-dot ', '')), n: x.querySelector('b')?.textContent })),
      note: !!row.querySelector('.ws-status-note'), pr: row.querySelectorAll('.pr-badge').length,
      chevron: (() => { const c = row.querySelector('.ws-chevron'); if (!c) return null; const cb = c.getBoundingClientRect(); return { cx: cb.x + cb.width / 2, cy: cb.y + cb.height / 2 }; })(),
      cx: b.x + 60, cy: b.y + b.height / 2 };
  });
  return { rows, frame: { on: fr.classList.contains('on'), tree: fr.classList.contains('tree'), top: Math.round(fb.top), bottom: Math.round(fb.bottom), left: Math.round(fb.left), right: Math.round(fb.right) },
    sidebarBg: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
    rowFont: (() => { const n = document.querySelector('.ws-item:not(.ws-folded) .ws-name'); return n ? getComputedStyle(n).fontSize : null; })(),
    repos: [...document.querySelectorAll('.ws-list .repo-section')].filter((sec) => sec.style.getPropertyValue('--repo-color')).map((sec) => {
      const probe = document.createElement('i'); probe.style.color = sec.style.getPropertyValue('--repo-color'); sec.append(probe); const want = getComputedStyle(probe).color; probe.remove();
      const cs = getComputedStyle(sec); const h = sec.querySelector('.repo-header');
      return { name: sec.querySelector('.repo-name')?.textContent.trim(), want, rail: cs.borderLeftColor, railW: cs.borderLeftWidth, header: h ? getComputedStyle(h).color : null };
    }), orch: document.querySelectorAll('.orchestrator-pill, .orch-count').length, innerWidth };
})()`;
const state = (app) => app.cdp.eval(stateJs);
/** Append one hook event to the workspace's events spool — the exact line orchestra-hook.sh writes. */
const SEQ = {};
function spool(home, id, event) {
  SEQ[id] = (SEQ[id] ?? 1000) + 1;
  const dir = path.join(home, 'events'); fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ seq: SEQ[id], event, tool: '', toolUseId: '', transcript: '' }) + '\n');
}
const storeWs = (home, id) => JSON.parse(fs.readFileSync(path.join(home, 'userData', 'orchestra', 'store.json'), 'utf8')).workspaces.find((w) => w.id === id);
const row = (s, text) => s.rows.find((r) => r.text === text);
const visible = (s) => s.rows.filter((r) => !r.folded).map((r) => r.text);
/** The frame must wrap exactly the given rows (±2px). */
function frameWraps(s, texts) {
  const rs = texts.map((t) => row(s, t)).filter(Boolean);
  if (rs.length !== texts.length) return false;
  const top = Math.min(...rs.map((r) => r.top)), bottom = Math.max(...rs.map((r) => r.bottom));
  return s.frame.on && Math.abs(s.frame.top - top) <= 2 && Math.abs(s.frame.bottom - bottom) <= 2;
}
const fmtFrame = (s) => `frame on=${s.frame.on} tree=${s.frame.tree} top=${s.frame.top} bottom=${s.frame.bottom}`;

async function main() {
  const missing = ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR'].filter((k) => !process.env[k]);
  if (missing.length) { console.error(`not launched via scripts/e2e-sidebar-orca-drive.sh (missing ${missing.join(', ')})`); process.exit(2); }
  const built = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
  console.log(`BUILD  app dir ${APP_DIR}  version ${built}  HEAD ${head}`);
  const liveBefore = Object.fromEntries(liveDirs().map((d) => [d, liveSnapshot(d)]));
  const shimBefore = shimHash();
  const home = path.join(RIG.base, `sor-${Date.now().toString(36)}`);
  fs.mkdirSync(home, { recursive: true });
  const world = seedWorld(home);
  const seeded = JSON.parse(fs.readFileSync(world.storeFile, 'utf8'));
  clause('seed/account-pinned', seeded.workspaces.every((w) => w.accountId === seeded.accounts[0].id) && seeded.accounts[0].configDir.startsWith(home + path.sep),
    `accountId=${seeded.workspaces[0].accountId} account.id=${seeded.accounts[0].id} configDir=${seeded.accounts[0].configDir}`);
  const app = await bootApp(home, world, 'a');
  try {
    const running = await app.cdp.eval('window.orchestra.getAppVersion()');
    clause('identity/version', running === built, `running=${running} built=${built}`);
    clause('identity/url', app.target.url.includes(APP_DIR) && !app.target.url.includes('app.asar'), app.target.url);
    const penv = procEnv(app.pid);
    clause('isolation/display', penv.WAYLAND_DISPLAY === RIG.wayland && penv.WAYLAND_DISPLAY !== 'wayland-1' && !('DISPLAY' in penv), `WAYLAND_DISPLAY=${penv.WAYLAND_DISPLAY}`);
    await waitFor('rows rendered', async () => { const s = await state(app); return Object.values(BR).every((b) => row(s, b)) && row(s, 'ops-wave'); }, 25000, 250);
    await mouse(app, 'mouseMoved', 900, 5); await sleep(900);

    // S0 — boot: the app selects workspaces[0] = OPS.
    const s0 = await state(app);
    for (const r of s0.rows) note(`boot ${r.text.padEnd(18)} folded=${r.folded} tree=${r.tree} active=${r.active} glyph="${r.glyph}" hidden=${JSON.stringify(r.hidden)}`);
    note(fmtFrame(s0));
    clause('skin/near-canvas-sidebar', s0.sidebarBg === 'rgb(23, 27, 33)', `sidebar background=${s0.sidebarBg} (Agent view canvas is #1a1f26)`);
    clause('skin/default-density', s0.rowFont === '11.5px', `row title font=${s0.rowFont} (DEFAULT_DENSITY 11.5px)`);
    for (const r of s0.repos) note(`repo ${r.name}: want=${r.want} rail=${r.railW} ${r.rail} header=${r.header}`);
    clause('repos/rail-and-name-in-repo-colour', s0.repos.length === 2 && s0.repos.every((r) => r.railW === '2px' && r.rail === r.want && r.header === r.want),
      s0.repos.map((r) => `${r.name}:${r.railW}/${r.rail === r.want}/${r.header === r.want}`).join(' '));
    clause('repos/distinct-colours', new Set(s0.repos.map((r) => r.want)).size === s0.repos.length, s0.repos.map((r) => r.want).join(' vs '));
    clause('boot/ops-tree-open', ['ops-wave', BR.c1, BR.c2].every((t) => !row(s0, t).folded), visible(s0).join(','));
    clause('boot/other-tree-folded', row(s0, BR.k1).folded && row(s0, BR.k2).folded && row(s0, BR.k1).inert && row(s0, BR.k1).h === 0, `K1 folded=${row(s0, BR.k1).folded} inert=${row(s0, BR.k1).inert} h=${row(s0, BR.k1).h}`);
    const pHidden = row(s0, BR.p).hidden[0];
    clause('boot/folded-summary-dots', !!pHidden && pHidden.n === '2' && pHidden.dots.length === 2, `P ${JSON.stringify(pHidden)}`);
    clause('frame/wraps-ops-tree', s0.frame.tree && frameWraps(s0, ['ops-wave', BR.c1, BR.c2]), fmtFrame(s0));
    const ops0 = row(s0, 'ops-wave');
    const c1 = row(s0, BR.c1), rr = row(s0, BR.r);
    clause('bell/child-has-none', !/autounread/.test(c1.glyph) && /ws-glyph-sm/.test(c1.glyph), `C1 glyph="${c1.glyph}"`);
    clause('bell/root-keeps-it', /ws-glyph-autounread/.test(rr.glyph), `R glyph="${rr.glyph}"`);
    clause('child/never-ran-grey', /never-ran/.test(row(s0, BR.k1).glyph), `K1 glyph="${row(s0, BR.k1).glyph}"`);
    clause('row/title-only-note-in-tooltip', !ops0.note && ops0.title.includes(NOTE), `note line=${ops0.note} title has note=${ops0.title.includes(NOTE)}`);
    clause('row/no-pr-or-agent-count-badges', s0.rows.every((r) => r.pr === 0) && s0.orch === 0, `pr=${s0.rows.reduce((a, r) => a + r.pr, 0)} orch=${s0.orch}`);
    SHOTS.push(['boot-ops-selected', await shot(app, 'boot-ops-selected')]);

    // N — real hook events through the spool: rollup on the idle lead, root-only turn-end bell in MAIN.
    clause('rollup/pre-lead-shows-own-idle', /ws-glyph-idle/.test(ops0.glyph), `OPS glyph="${ops0.glyph}"`);
    spool(home, ID.c1, 'submit');
    const n1 = await waitFor('C1 running', async () => { const s = await state(app); return /running/.test(row(s, BR.c1).glyph) ? s : null; }, 10000, 150).catch(() => null);
    const opsN1 = n1 && row(n1, 'ops-wave');
    clause('rollup/idle-lead-spins-for-running-child', !!opsN1 && /ws-glyph-running/.test(opsN1.glyph) && /spawned agent running/.test(opsN1.glyphTitle),
      `OPS glyph "${ops0.glyph}" -> "${opsN1?.glyph}" title="${opsN1?.glyphTitle}"`);
    SHOTS.push(['rollup-running', await shot(app, 'rollup-running')]);
    spool(home, ID.c2, 'notify');
    const n2 = await waitFor('C2 waiting', async () => { const s = await state(app); return /waiting/.test(row(s, BR.c2).glyph) ? s : null; }, 10000, 150).catch(() => null);
    const opsN2 = n2 && row(n2, 'ops-wave');
    clause('rollup/question-beats-running', !!opsN2 && /ws-glyph-waiting/.test(opsN2.glyph) && /running/.test(row(n2, BR.c1).glyph),
      `OPS glyph -> "${opsN2?.glyph}" (C1 still "${n2 && row(n2, BR.c1).glyph}") title="${opsN2?.glyphTitle}"`);
    SHOTS.push(['rollup-question', await shot(app, 'rollup-question')]);
    // turn ends: the child C1 and the (unselected) root L
    const preC1 = storeWs(home, ID.c1).autoUnread, preL = storeWs(home, ID.l).autoUnread;
    spool(home, ID.c1, 'stop');
    spool(home, ID.l, 'submit'); await sleep(400); spool(home, ID.l, 'stop');
    const done = await waitFor('store: L autoUnread', async () => (storeWs(home, ID.l).autoUnread === true && storeWs(home, ID.c1).status === 'idle' ? true : null), 10000, 200).catch(() => null);
    const postC1 = storeWs(home, ID.c1), postL = storeWs(home, ID.l);
    clause('notify/root-turn-end-bells', done && postL.autoUnread === true, `store L.autoUnread ${preL} -> ${postL.autoUnread}`);
    clause('notify/child-turn-end-no-bell', done && postC1.status === 'idle' && !postC1.autoUnread, `store C1.status=${postC1.status} autoUnread ${preC1} -> ${postC1.autoUnread}`);
    const n3 = await state(app);
    clause('bell/root-l-shows-it', /ws-glyph-autounread/.test(row(n3, BR.l).glyph), `L glyph="${row(n3, BR.l).glyph}"`);

    // S1 — click P (repo section): its tree unfolds, OPS folds, the frame slides; sample the slide.
    const pr0 = row(s0, BR.p);
    await mouse(app, 'mouseMoved', pr0.cx, pr0.cy); await sleep(80);
    const samplesP = app.cdp.eval(`new Promise((res) => { const f = document.querySelector('.ws-selection-frame'); const out = []; const t0 = performance.now();
      const tick = () => { out.push(Math.round(f.getBoundingClientRect().top)); if (performance.now() - t0 < 500) requestAnimationFrame(tick); else res(out); }; requestAnimationFrame(tick); })`);
    await mouse(app, 'mousePressed', pr0.cx, pr0.cy, { clickCount: 1 }); await mouse(app, 'mouseReleased', pr0.cx, pr0.cy, { clickCount: 1 });
    const tops = await samplesP; await mouse(app, 'mouseMoved', 900, 5); await sleep(500);
    const s1 = await state(app);
    note(`P click: visible ${visible(s0).join(',')} -> ${visible(s1).join(',')}`);
    note(`P click: ${fmtFrame(s0)} -> ${fmtFrame(s1)}`);
    clause('select-p/its-tree-unfolds', [BR.p, BR.k1, BR.k2].every((t) => !row(s1, t).folded) && row(s1, BR.k1).h > 0, `K1 h ${row(s0, BR.k1).h} -> ${row(s1, BR.k1).h}`);
    clause('select-p/ops-tree-folds', row(s1, BR.c1).folded && row(s1, BR.c2).folded, `C1 folded ${row(s0, BR.c1).folded} -> ${row(s1, BR.c1).folded}`);
    clause('frame/moved-to-p-tree', frameWraps(s1, [BR.p, BR.k1, BR.k2]) && s1.frame.top !== s0.frame.top, fmtFrame(s1));
    const mono = tops.every((v, i) => i === 0 || (tops[tops.length - 1] >= tops[0] ? v >= tops[i - 1] - 1 : v <= tops[i - 1] + 1));
    const span = [Math.min(...tops), Math.max(...tops)], ends = [tops[0], tops[tops.length - 1]];
    clause('frame/slide-monotonic-no-overshoot', tops.length > 10 && new Set(tops).size > 3 && mono && span[0] >= Math.min(...ends) - 1 && span[1] <= Math.max(...ends) + 1,
      `${tops.length} frames, top ${ends[0]} -> ${ends[1]}, distinct=${new Set(tops).size}, range=[${span}]`);
    SHOTS.push(['p-tree-selected', await shot(app, 'p-tree-selected')]);

    // S2 — click the leaf root L: no tree, everything folds, the frame shrinks to the one row.
    const l1 = row(s1, BR.l);
    await click(app, l1.cx, l1.cy); await mouse(app, 'mouseMoved', 900, 5); await sleep(600);
    const s2 = await state(app);
    note(`L click: ${fmtFrame(s1)} -> ${fmtFrame(s2)}`);
    clause('select-leaf/no-tree-frame', !s2.frame.tree && frameWraps(s2, [BR.l]) && !s2.rows.some((r) => r.tree), fmtFrame(s2));
    clause('select-leaf/all-trees-fold', [BR.c1, BR.c2, BR.k1, BR.k2].every((t) => row(s2, t).folded), visible(s2).join(','));
    SHOTS.push(['leaf-selected', await shot(app, 'leaf-selected')]);

    // S3 — the chevron still folds/unfolds by hand without moving the selection.
    const p2 = row(s2, BR.p);
    if (!p2.chevron) clause('chevron/present', false, 'no .ws-chevron on P');
    else {
      await mouse(app, 'mouseMoved', p2.chevron.cx, p2.chevron.cy); await sleep(150);
      await click(app, p2.chevron.cx, p2.chevron.cy); await mouse(app, 'mouseMoved', 900, 5); await sleep(600);
      const s3 = await state(app);
      clause('chevron/manual-unfold-keeps-selection', !row(s3, BR.k1).folded && row(s3, BR.l).active && frameWraps(s3, [BR.l]),
        `K1 folded ${row(s2, BR.k1).folded} -> ${row(s3, BR.k1).folded}, L active=${row(s3, BR.l).active}`);
      SHOTS.push(['chevron-unfold', await shot(app, 'chevron-unfold')]);
      SHOTS.push(['chevron-unfold-composed', grim(app, 'chevron-unfold-composed')]);
    }
    clause('rows/in-viewport', s2.rows.filter((r) => !r.folded).every((r) => r.top >= 0) && s2.frame.right <= s2.innerWidth, '');

    // D — the "Aa" window: trusted click, trusted ArrowLeft on the text-size slider, effect on rows, persistence.
    const dens = (k) => app.cdp.eval(`(() => { const rows = [...document.querySelectorAll('.ws-item:not(.ws-folded)')].filter((x) => x.querySelector('.ws-name'));
      const tall = rows.find((x) => x.querySelector('.ws-chevron')) ?? rows[0]; const leaf = rows.find((x) => !x.querySelector('.ws-chevron') && !x.querySelector('.ws-hidden-count')) ?? rows[0];
      const n = leaf.querySelector('.ws-name'); const r = leaf.getBoundingClientRect(); const rt = tall.getBoundingClientRect();
      const sl = document.querySelector('input[data-density="font"]'); return { font: getComputedStyle(n).fontSize, rowH: Math.round(r.height), tallH: Math.round(rt.height), slider: sl ? sl.value : null,
      dialog: (() => { const d = document.querySelector('.density-settings'); if (!d) return null; const b = d.getBoundingClientRect(); const sb = document.querySelector('aside.sidebar').getBoundingClientRect();
        return { inViewport: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, besideSidebar: b.left >= sb.right, backdropFilter: getComputedStyle(d.parentElement).backdropFilter }; })() }; })()`);
    const btn = await app.cdp.eval(`(() => { const b = document.querySelector('[data-density-open]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const d0 = await dens();
    await click(app, btn.x, btn.y); await sleep(300);
    const d1 = await dens();
    clause('density/aa-opens-dialog-in-viewport', !!d1.dialog?.inViewport && d1.slider === '11.5', `dialog=${JSON.stringify(d1.dialog)} slider=${d1.slider}`);
    clause('density/sidebar-stays-visible-while-tuning', !!d1.dialog?.besideSidebar && d1.dialog?.backdropFilter === 'none', `beside sidebar=${d1.dialog?.besideSidebar} backdrop-filter=${d1.dialog?.backdropFilter}`);
    const sb = await app.cdp.eval(`(() => { const b = document.querySelector('input[data-density="font"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await click(app, sb.x, sb.y); await sleep(150); // focuses the slider (a click on its middle also moves it to ~12px)
    for (let i = 0; i < 6; i++) { await app.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); await sleep(60); }
    await sleep(300);
    const d2 = await dens();
    SHOTS.push(['density-dialog', await shot(app, 'density-dialog')]);
    clause('density/default-row-is-the-knob', d0.rowH === 28 && d0.tallH === 28, `leaf row ${d0.rowH}px, row with chevron ${d0.tallH}px (knob 28px)`);
    clause('density/slider-shrinks-text-never-grows-rows', parseFloat(d2.font) < parseFloat(d0.font) && d2.rowH <= d0.rowH && d2.tallH <= d0.tallH,
      `font ${d0.font} -> ${d2.font}, leaf ${d0.rowH} -> ${d2.rowH}, chevron row ${d0.tallH} -> ${d2.tallH}, slider ${d2.slider}`);
    // the row-height slider: Home = its minimum (20px) — leaf rows follow, a chevron row is capped by its content
    const rh = await app.cdp.eval(`(() => { const b = document.querySelector('input[data-density="rowH"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await click(app, rh.x, rh.y); await sleep(150);
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }); await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await sleep(400);
    const d2b = await dens();
    const rhVal = await app.cdp.eval(`document.querySelector('input[data-density="rowH"]').value`);
    clause('density/row-height-slider-tightens-rows', rhVal === '20' && d2b.rowH < d2.rowH && d2b.rowH === 20, `row height slider ${rhVal}px: leaf ${d2.rowH} -> ${d2b.rowH}, chevron row ${d2.tallH} -> ${d2b.tallH}`);
    SHOTS.push(['density-row-height-min', await shot(app, 'density-row-height-min')]);
    await app.cdp.send('Page.reload'); await sleep(3500);
    await waitFor('rows after reload', async () => (await app.cdp.eval(`document.querySelectorAll('.ws-item .ws-name').length`)) > 3, 20000, 250);
    const d3 = await dens();
    clause('density/persists-across-reload', d3.font === d2.font && d3.rowH === d2b.rowH && !d3.dialog, `after reload font ${d3.font} (set ${d2.font}), leaf ${d3.rowH}px (set ${d2b.rowH}), dialog closed=${!d3.dialog}`);
    SHOTS.push(['density-after-reload', await shot(app, 'density-after-reload')]);
  } finally {
    await closeApp(app).catch((e) => console.log(`teardown: ${e.message}`));
  }
  const hashes = SHOTS.map(([n, f]) => [n, f, md5(f)]);
  for (const [n, f, h] of hashes) console.log(`SHOT  ${n}  ${f}  md5=${h}`);
  clause('shots/distinct-hashes', new Set(hashes.map((x) => x[2])).size === hashes.length, `${hashes.length} captures`);
  const rows2 = liveDirs().map((d) => ({ d, same: (liveBefore[d] ?? '') === liveSnapshot(d) }));
  clause('live/config-dirs-untouched', rows2.every((r) => r.same), rows2.filter((r) => !r.same).map((r) => r.d).join(' ') || 'all same');
  clause('live/cli-shim-untouched', shimBefore === shimHash(), '');
  const leftovers = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return procEnv(d).ORCHESTRA_HOME === home; } catch { return false; } });
  clause('teardown/no-survivors', leftovers.length === 0, leftovers.join(',') || 'none');
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\nRESULT  clauses=${RESULTS.length} pass=${RESULTS.length - failed.length} fail=${failed.length}${failed.length ? '  FAILED: ' + failed.map((f) => f.name).join(', ') : ''}  home=${home}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(`DRIVE ERROR: ${e.stack ?? e}`); process.exit(3); });
