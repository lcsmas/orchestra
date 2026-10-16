#!/usr/bin/env node
// #384 G6 drive — `ex-<previous>` in the sidebar tooltip (BOTH row render paths) and in `orchestra peers`, surviving a restart.
// Run through scripts/e2e-former-branch-drive.sh <app-dir> (own headless sway, env -i allowlist, SCRATCH account dir, fake HOME).
//
// Seeded store (real git worktrees): OPS orchestrator ─ C1 (parent-named child: TREE row path) ; D1 (parent-named, detached from
// any parent: REPO-SECTION row path) ; H1 (human-created: the negative control — a self-rename must leave NO `ex-`).
//   C1: renamed twice by its parent through the socket (`orchestra rename`, caller = OPS)  → tooltip must show the LATEST previous
//   D1: renamed by the human in the sidebar (double-click, type, Enter)                     → "(locked) · ex-<old>"
//   H1: renamed through the CLI as itself                                                   → nothing recorded
// Then `orchestra peers` (caller OPS) must show the `ex` column, the app is RESTARTED over the same home, and both again hold.
// Helpers (Cdp, containment, live-dir snapshot) are COPIED from e2e-agent-view-removal.mjs, whose review history they carry.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

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
const OLD = { c1: 'impl-nommage-draft-381', c1mid: 'impl-nommage-brouillon-381', c1new: 'impl-nommage-politique-381', d1: 'verif-ancien-nom-384-draft', d1new: 'verif-ancien-nom-384', h1: 'silver-moth', h1new: 'fix-checkout-typo' };
const ID = { ops: 'ws-efb-ops', c1: 'ws-efb-c1', d1: 'ws-efb-d1', h1: 'ws-efb-h1' };

function seedWorld(home) {
  const fakeHome = path.join(home, 'home'), repoDir = path.join(home, 'repo');
  fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# efb seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const configDir = path.join(home, 'claude-config'); fs.mkdirSync(configDir, { recursive: true });
  const g = checkScratchConfig(configDir, liveDirs(), home);
  if (!g.ok) throw new Error(`REFUSED before seeding [${g.clause}]: ${g.detail ?? ''}`);
  const account = { id: 'rig-efb', label: 'rig (scratch config dir)', configDir };
  const wt = (key, branch) => { const p = path.join(home, 'wt', key); fs.mkdirSync(path.dirname(p), { recursive: true }); git(repoDir, ['worktree', 'add', '-q', '-b', branch, p], fakeHome); return p; };
  const base = { baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const opsDir = path.join(home, 'scratch', 'ops'); fs.mkdirSync(opsDir, { recursive: true });
  const ops = { ...base, id: ID.ops, name: 'ops-demo', kind: 'orchestrator', repoPath: '', worktreePath: opsDir, branch: 'ops-demo', baseBranch: '', setupStatus: 'ok' };
  const mk = (key, extra) => ({ ...base, id: ID[key], name: `efb-repo · ${extra.branch}`, repoPath: repoDir, worktreePath: wt(key, extra.branch), ...extra });
  const c1 = mk('c1', { branch: OLD.c1, parentId: ID.ops, namedByParent: ID.ops });
  const d1 = mk('d1', { branch: OLD.d1, namedByParent: ID.ops });            // detached child: no parentId, still parent-named
  const h1 = mk('h1', { branch: OLD.h1 });                                    // human-created
  for (const [k, p] of [['c1', c1], ['d1', d1], ['h1', h1]]) {
    const listed = git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome);
    if (!listed.includes(`worktree ${fs.realpathSync(p.worktreePath)}`)) throw new Error(`seed worktree ${k} not registered`);
  }
  const repo = { path: repoDir, name: 'efb-repo', defaultBranch: 'main', scripts: {}, accountId: account.id };
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ repos: [repo], workspaces: [ops, c1, d1, h1], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(home, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  const stubLog = path.join(home, 'stub-argv.log');
  fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\necho "$$ $*" >> '${stubLog}'\nsleep 3600\n`, { mode: 0o755 });
  return { fakeHome, repoDir, account, stubDir, stubLog, storeFile };
}

async function bootApp(home, world, label) {
  const port = await freePort();
  const electron = [path.join(APP_DIR, 'node_modules/electron/dist/electron')].find((p) => fs.existsSync(p));
  if (!electron) throw new Error('no electron binary in the app dir');
  const env = {
    PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
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

// ── observables ──────────────────────────────────────────────────────────────
/** Every `.ws-name` row the sidebar renders: its text, tooltip, which render path it is on, its rect. */
const rows = (app) => app.cdp.eval(`(() => [...document.querySelectorAll('.ws-name')].map((e) => { const r = e.getBoundingClientRect();
  return { text: e.textContent.trim(), title: e.getAttribute('title') || '', path: e.closest('.ws-tree') ? 'tree' : 'repo', x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2,
    inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; }))()`);
const rowOf = async (app, text) => (await rows(app)).find((r) => r.text === text);
async function mouse(app, type, x, y, extra = {}) { await app.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }); }
async function key(app, k, code, extra = {}) { await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, ...extra }); await sleep(40); await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, ...extra }); await sleep(80); }
async function uiRename(app, from, to) {
  const r = await waitFor(`row ${from}`, () => rowOf(app, from), 15000, 200);
  await mouse(app, 'mouseMoved', r.cx, r.cy); await sleep(150);
  for (const n of [1, 2]) { await mouse(app, 'mousePressed', r.cx, r.cy, { clickCount: n }); await mouse(app, 'mouseReleased', r.cx, r.cy, { clickCount: n }); await sleep(60); }
  await waitFor('rename input', () => app.cdp.eval(`!!document.querySelector('.ws-name-input')`), 5000, 100);
  // select the whole draft, then TYPE the replacement (trusted insertText); a stray append would be caught by the row lookup below
  await app.cdp.eval(`(() => { const i = document.querySelector('.ws-name-input'); i.focus(); i.select(); return i.value; })()`); await sleep(80);
  await app.cdp.send('Input.insertText', { text: to }); await sleep(120);
  const typed = await app.cdp.eval(`document.querySelector('.ws-name-input')?.value`);
  if (typed !== to) throw new Error(`rename input holds "${typed}", wanted "${to}"`);
  await key(app, 'Enter', 'Enter', { windowsVirtualKeyCode: 13 });
}
function cli(app, wsId, args) {
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: app.world.fakeHome, ORCHESTRA_HOME: app.home, ORCHESTRA_WS_ID: wsId, LANG: 'C.UTF-8' };
  try { return { code: 0, stdout: execFileSync(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), ...args], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
  catch (e) { return { code: e.status ?? -1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' }; }
}
const storeWs = (app) => Object.fromEntries(JSON.parse(fs.readFileSync(app.world.storeFile, 'utf8')).workspaces.map((w) => [w.id, w]));
async function shot(app, name) { const r = await app.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000); const f = path.join(app.home, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; }
function grim(app, name) { const f = path.join(app.home, `${name}.png`); execFileSync('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 }); return f; }
const SHOTS = [];
// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const missing = ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR'].filter((k) => !process.env[k]);
  if (missing.length) { console.error(`not launched via scripts/e2e-former-branch-drive.sh (missing ${missing.join(', ')})`); process.exit(2); }
  const built = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  console.log(`BUILD  app dir ${APP_DIR}  package.json version ${built}`);
  const liveBefore = Object.fromEntries(liveDirs().map((d) => [d, liveSnapshot(d)]));
  const shimBefore = shimHash();
  const home = path.join(RIG.base, `efb-${Date.now().toString(36)}`);
  fs.mkdirSync(home, { recursive: true });
  const world = seedWorld(home);
  const seeded = JSON.parse(fs.readFileSync(world.storeFile, 'utf8'));
  clause('seed/account-pinned', seeded.workspaces.every((w) => w.accountId === seeded.accounts[0].id) && seeded.accounts[0].configDir.startsWith(home + path.sep),
    `accountId=${seeded.workspaces[0].accountId} account.id=${seeded.accounts[0].id} configDir=${seeded.accounts[0].configDir}`);
  let app = await bootApp(home, world, 'a');
  try {
    // identity + isolation
    const running = await app.cdp.eval('window.orchestra.getAppVersion()');
    clause('identity/version', running === built, `running=${running} built=${built}`);
    clause('identity/url', app.target.url.includes(APP_DIR) && !app.target.url.includes('app.asar'), app.target.url);
    const penv = procEnv(app.pid);
    clause('isolation/display', penv.WAYLAND_DISPLAY === RIG.wayland && penv.WAYLAND_DISPLAY !== 'wayland-1' && !('DISPLAY' in penv), `pid ${app.pid} WAYLAND_DISPLAY=${penv.WAYLAND_DISPLAY} DISPLAY=${penv.DISPLAY ?? '<absent>'}`);
    const wsList = await waitFor('seeded workspaces loaded', async () => { const l = await app.cdp.eval('window.orchestra.listWorkspaces()'); return l.length >= 4 ? l : null; }, 20000, 250);
    clause('seed/loaded', ['ops', 'c1', 'd1', 'h1'].every((k) => wsList.some((w) => w.id === ID[k])), wsList.map((w) => `${w.id}:${w.branch}`).join(' '));

    // ── PRE-state ──
    await waitFor('rows rendered', async () => (await rows(app)).some((r) => r.text === OLD.c1) && (await rows(app)).some((r) => r.text === OLD.d1), 20000, 250);
    const pre = { c1: await rowOf(app, OLD.c1), d1: await rowOf(app, OLD.d1), h1: await rowOf(app, OLD.h1) };
    clause('render-path/c1-is-tree', pre.c1?.path === 'tree', `C1 row path=${pre.c1?.path}`);
    clause('render-path/d1-is-repo', pre.d1?.path === 'repo', `D1 row path=${pre.d1?.path}`);
    clause('pre/no-ex-in-any-tooltip', [pre.c1, pre.d1, pre.h1].every((r) => r && !r.title.includes('ex-')), [pre.c1, pre.d1, pre.h1].map((r) => `"${r?.title}"`).join(' | '));
    const peersPre = cli(app, ID.ops, ['peers']);
    clause('pre/peers-no-ex-column', peersPre.code === 0 && !/\bex\b|ex-/.test(peersPre.stdout) && peersPre.stdout.includes(OLD.c1), `rc=${peersPre.code}\n${peersPre.stdout}`);
    SHOTS.push(['pre-rename', await shot(app, 'pre-rename')]);

    // ── renames ──
    // C1 (tree path), twice, by its PARENT through the socket: the LATEST previous name must win.
    let r1 = cli(app, ID.ops, ['rename', ID.c1, OLD.c1mid]);
    clause('rename/c1-first', r1.code === 0 && /Renamed to/.test(r1.stdout), `rc=${r1.code} ${r1.stdout.trim()} ${r1.stderr.trim()}`);
    await waitFor('c1 title shows first former', async () => (await rowOf(app, OLD.c1mid))?.title.includes(`ex-${OLD.c1}`), 10000, 200);
    const midTitle = (await rowOf(app, OLD.c1mid)).title;
    let r2 = cli(app, ID.ops, ['rename', ID.c1, OLD.c1new]);
    clause('rename/c1-second', r2.code === 0 && /Renamed to/.test(r2.stdout), `rc=${r2.code} ${r2.stdout.trim()} ${r2.stderr.trim()}`);
    await waitFor('c1 title shows latest former', async () => (await rowOf(app, OLD.c1new))?.title.includes(`ex-${OLD.c1mid}`), 10000, 200);
    // D1 (repo path), by the HUMAN in the sidebar.
    await uiRename(app, OLD.d1, OLD.d1new);
    await waitFor('d1 renamed', () => rowOf(app, OLD.d1new), 10000, 200);
    // H1 (human-created), a self-rename through the CLI: nothing may be recorded.
    let r3 = cli(app, ID.h1, ['rename', ID.h1, OLD.h1new]);
    clause('rename/h1-self', r3.code === 0 && /Renamed to/.test(r3.stdout), `rc=${r3.code} ${r3.stdout.trim()} ${r3.stderr.trim()}`);
    await waitFor('h1 renamed', () => rowOf(app, OLD.h1new), 10000, 200);
    await sleep(600);

    // ── POST-state: tooltips ──
    const post = { c1: await rowOf(app, OLD.c1new), d1: await rowOf(app, OLD.d1new), h1: await rowOf(app, OLD.h1new) };
    const tipC1 = `${OLD.c1new} — spawned by this orchestrator · double-click to rename · ex-${OLD.c1mid}`;
    const tipD1 = `${OLD.d1new} (locked) · ex-${OLD.d1}`;
    note(`tooltip pre -> post (C1, tree path): "${pre.c1?.title}" -> "${post.c1?.title}"`);
    note(`tooltip pre -> post (D1, repo path): "${pre.d1?.title}" -> "${post.d1?.title}"`);
    note(`tooltip pre -> post (H1, human-created): "${pre.h1?.title}" -> "${post.h1?.title}"`);
    clause('tooltip/tree-path', post.c1?.path === 'tree' && post.c1.title === tipC1, `title="${post.c1?.title}"`);
    clause('tooltip/tree-path-latest-only', !post.c1?.title.includes(`ex-${OLD.c1}`) && post.c1?.title.includes(`ex-${OLD.c1mid}`) && midTitle.includes(`ex-${OLD.c1}`), `after 1st rename "${midTitle}" ; after 2nd "${post.c1?.title}"`);
    clause('tooltip/repo-path', post.d1?.path === 'repo' && post.d1.title === tipD1, `title="${post.d1?.title}"`);
    clause('tooltip/human-created-has-no-ex', post.h1?.path === 'repo' && !post.h1.title.includes('ex-') && post.h1.title === `${OLD.h1new} — double-click to rename`, `title="${post.h1?.title}"`);
    clause('tooltip/kept-existing-text', post.c1?.title.includes('double-click to rename') && post.d1?.title.includes('(locked)'), 'tree keeps "double-click to rename", locked repo row keeps "(locked)"');

    // ── POST-state: store.json, peers ──
    const st = storeWs(app);
    clause('store/former-recorded', st[ID.c1].formerBranch === OLD.c1mid && st[ID.d1].formerBranch === OLD.d1 && !('formerBranch' in st[ID.h1]), `c1=${st[ID.c1].formerBranch} d1=${st[ID.d1].formerBranch} h1=${st[ID.h1].formerBranch ?? '<absent>'}`);
    const peersPost = cli(app, ID.ops, ['peers']);
    const lines = peersPost.stdout.trimEnd().split('\n');
    const cells = (id) => (lines.find((l) => l.startsWith(id.slice(0, 8))) ?? '').split(/\s+/);
    clause('peers/ex-column-after-branch', peersPost.code === 0 && lines[0].split(/\s+/).slice(0, 3).join(' ') === 'id branch ex', `header="${lines[0]}"`);
    clause('peers/renamed-rows', cells(ID.c1).includes(`ex-${OLD.c1mid}`) && cells(ID.d1).includes(`ex-${OLD.d1}`), `\n${peersPost.stdout}`);
    clause('peers/never-renamed-blank', !cells(ID.h1).some((c) => c.startsWith('ex-')) && cells(ID.h1).includes(OLD.h1new), `H1 row: ${cells(ID.h1).join(' | ')}`);

    // ── screenshots: pixels ──
    // park the pointer, capture the post-rename sidebar (renderer DOM) and the composed window
    await mouse(app, 'mouseMoved', 5, 5); await sleep(300);
    SHOTS.push(['post-rename-renderer', await shot(app, 'post-rename-renderer')]);
    SHOTS.push(['post-rename-composed', grim(app, 'post-rename-composed')]);
    const inVp = [post.c1, post.d1].every((r) => r?.inViewport);
    clause('rows/in-viewport', inVp, `C1 x=${post.c1?.x} w=${post.c1?.w}; D1 x=${post.d1?.x} w=${post.d1?.w} (viewport inner width asserted by inViewport)`);
    // Hover each renamed row with TRUSTED CDP input and compose-capture: proves the rows paint in the hover state next to their
    // tooltip. Chromium's NATIVE title-tooltip popup never appears here (it needs real seat pointer motion; CDP events never raise it
    // and this box has no pointer-injection tool, MEASURED: `swaymsg seat - cursor set` left the capture byte-identical to the
    // un-hovered one) — the tooltip TEXT is therefore asserted from the DOM `title` attribute, which is what the native popup prints.
    for (const [label, r] of [['hover-tree-c1-title-in-dom', post.c1], ['hover-repo-d1-title-in-dom', post.d1]]) {
      await mouse(app, 'mouseMoved', 5, 5); await sleep(400);
      await mouse(app, 'mouseMoved', r.cx - 6, r.cy); await sleep(150); await mouse(app, 'mouseMoved', r.cx, r.cy); await sleep(900);
      SHOTS.push([label, grim(app, label)]);
    }
    await mouse(app, 'mouseMoved', 5, 5);

    // ── RESTART over the same home ──
    await closeApp(app);
    const stDisk = storeWs({ world });
    clause('restart/store-on-disk-after-quit', stDisk[ID.c1].formerBranch === OLD.c1mid && stDisk[ID.d1].formerBranch === OLD.d1, `c1=${stDisk[ID.c1].formerBranch} d1=${stDisk[ID.d1].formerBranch}`);
    app = await bootApp(home, world, 'b');
    const running2 = await app.cdp.eval('window.orchestra.getAppVersion()');
    clause('restart/identity', running2 === built && app.target.url.includes(APP_DIR), `running=${running2} built=${built} url=${app.target.url}`);
    await waitFor('rows after restart', async () => (await rows(app)).some((r) => r.text === OLD.c1new) && (await rows(app)).some((r) => r.text === OLD.d1new), 25000, 250);
    const re = { c1: await rowOf(app, OLD.c1new), d1: await rowOf(app, OLD.d1new), h1: await rowOf(app, OLD.h1new) };
    note(`tooltip after restart (C1): "${re.c1?.title}"`); note(`tooltip after restart (D1): "${re.d1?.title}"`);
    clause('restart/tooltips-persist', re.c1?.title === tipC1 && re.d1?.title === tipD1 && !re.h1?.title.includes('ex-'), `c1="${re.c1?.title}" d1="${re.d1?.title}" h1="${re.h1?.title}"`);
    const peersRe = cli(app, ID.ops, ['peers']);
    clause('restart/peers-persist', peersRe.code === 0 && peersRe.stdout.includes(`ex-${OLD.c1mid}`) && peersRe.stdout.includes(`ex-${OLD.d1}`), `\n${peersRe.stdout}`);
    await mouse(app, 'mouseMoved', 5, 5); await sleep(300);
    SHOTS.push(['post-restart-renderer', await shot(app, 'post-restart-renderer')]);
    SHOTS.push(['post-restart-composed', grim(app, 'post-restart-composed')]);
  } finally {
    await closeApp(app).catch((e) => console.log(`teardown: ${e.message}`));
  }

  // ── screenshots: hashes ──
  const hashes = SHOTS.map(([n, f]) => [n, f, md5(f)]);
  for (const [n, f, h] of hashes) console.log(`SHOT  ${n}  ${f}  md5=${h}`);
  clause('shots/distinct-hashes', new Set(hashes.map((x) => x[2])).size === hashes.length, `${hashes.length} captures, ${new Set(hashes.map((x) => x[2])).size} distinct`);

  // ── live isolation ──
  const rows2 = liveDirs().map((d) => ({ d, same: (liveBefore[d] ?? '') === liveSnapshot(d) }));
  clause('live/config-dirs-untouched', rows2.every((r) => r.same), rows2.map((r) => `${r.d}:${r.same ? 'same' : 'CHANGED'}`).join(' '));
  clause('live/cli-shim-untouched', shimBefore === shimHash(), `${shimFile} md5 before=${shimBefore} after=${shimHash()}`);
  const leftovers = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return procEnv(d).ORCHESTRA_HOME === home; } catch { return false; } });
  clause('teardown/no-survivors', leftovers.length === 0, `processes still carrying this boot's ORCHESTRA_HOME: ${leftovers.join(',') || 'none'}`);

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\nRESULT  clauses=${RESULTS.length} pass=${RESULTS.length - failed.length} fail=${failed.length}${failed.length ? '  FAILED: ' + failed.map((f) => f.name).join(', ') : ''}  home=${home}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(`DRIVE ERROR: ${e.stack ?? e}`); process.exit(3); });
