#!/usr/bin/env node
// Sidebar declutter drive — a BUILT Orchestra shows NO PR / Linear / agent-count badges on sidebar rows, while a COLLAPSED
// coordinator still shows its hidden-agents count (`.ws-hidden-count`, both render paths). Run on master to see the must-FAIL arm.
// Run through scripts/e2e-sidebar-declutter-drive.sh <app-dir>. Helpers COPIED from e2e-former-branch-drive.mjs.
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
// OPS (orchestrator, pinned tree) ─ C1 (linked PR + Linear key), C2 ; P (promoted worktree, repo section, linked PR) ─ K1, K2.
const ID = { ops: 'ws-sdc-ops', c1: 'ws-sdc-c1', c2: 'ws-sdc-c2', p: 'ws-sdc-p', k1: 'ws-sdc-k1', k2: 'ws-sdc-k2' };
const BR = { c1: 'impl-linked-c1', c2: 'impl-plain-c2', p: 'promoted-coord-p', k1: 'kid-one-k1', k2: 'kid-two-k2' };
const PR = (n) => ({ url: `https://github.com/lcsmas/orchestra/pull/${n}`, owner: 'lcsmas', repo: 'orchestra', number: n });

function seedWorld(home) {
  const fakeHome = path.join(home, 'home'), repoDir = path.join(home, 'repo');
  fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# sdc seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const configDir = path.join(home, 'claude-config'); fs.mkdirSync(configDir, { recursive: true });
  const g = checkScratchConfig(configDir, liveDirs(), home);
  if (!g.ok) throw new Error(`REFUSED before seeding [${g.clause}]: ${g.detail ?? ''}`);
  const account = { id: 'rig-sdc', label: 'rig (scratch config dir)', configDir };
  const wt = (key, branch) => { const p = path.join(home, 'wt', key); fs.mkdirSync(path.dirname(p), { recursive: true }); git(repoDir, ['worktree', 'add', '-q', '-b', branch, p], fakeHome); return p; };
  const base = { baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const opsDir = path.join(home, 'scratch', 'ops'); fs.mkdirSync(opsDir, { recursive: true });
  const ops = { ...base, id: ID.ops, name: 'ops-demo', kind: 'orchestrator', repoPath: '', worktreePath: opsDir, branch: 'ops-demo', baseBranch: '', setupStatus: 'ok', linkedPrs: [PR(2)], linkedLinearKey: 'NMC-298' };
  const mk = (key, extra) => ({ ...base, id: ID[key], name: `sdc-repo · ${BR[key]}`, repoPath: repoDir, worktreePath: wt(key, BR[key]), branch: BR[key], ...extra });
  const c1 = mk('c1', { parentId: ID.ops, linkedPrs: [PR(1)], linkedLinearKey: 'NMC-2541' });
  const c2 = mk('c2', { parentId: ID.ops });
  const p = mk('p', { canOrchestrate: true, linkedPrs: [PR(3)], linkedLinearKey: 'NMC-1902' });
  const k1 = mk('k1', { parentId: ID.p });
  const k2 = mk('k2', { parentId: ID.p, status: 'waiting' });
  const repo = { path: repoDir, name: 'sdc-repo', defaultBranch: 'main', scripts: {}, accountId: account.id };
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ repos: [repo], workspaces: [ops, c1, c2, p, k1, k2], accounts: [account], selfTuneRuns: [] }, null, 2));
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
/** Per sidebar row: branch text, render path, and the badge classes present on the row. */
const rowsJs = `(() => [...document.querySelectorAll('.ws-name')].map((e) => { const row = e.closest('.ws-item') ?? e.parentElement; const r = row.getBoundingClientRect();
  const q = (s) => [...row.querySelectorAll(s)].filter((x) => x.closest('.ws-item') === row);
  return { text: e.textContent.trim(), path: e.closest('.ws-tree') ? 'tree' : 'repo',
    pr: q('.pr-badge').map((x) => x.className + ':' + x.textContent.trim()), orch: q('.orchestrator-pill').map((x) => x.textContent.trim()),
    hidden: q('.ws-hidden-count').map((x) => x.className + ':' + x.textContent.trim()), chevron: (() => { const c = row.parentElement?.querySelector(':scope > .ws-chevron') ?? row.querySelector('.ws-chevron'); if (!c) return null; const b = c.getBoundingClientRect(); return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; })(),
    inViewport: r.left >= 0 && r.right <= innerWidth }; }))()`;
const rows = (app) => app.cdp.eval(rowsJs);
const rowOf = async (app, text) => (await rows(app)).find((r) => r.text === text);
const globalCounts = (app) => app.cdp.eval(`({ pr: document.querySelectorAll('.ws-list .pr-badge, .sidebar .pr-badge').length, orch: document.querySelectorAll('.orchestrator-pill').length, orchCount: document.querySelectorAll('.orch-count').length })`);
async function mouse(app, type, x, y, extra = {}) { await app.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }); }
async function shot(app, name) { const r = await app.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000); const f = path.join(app.home, `${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); return f; }
function grim(app, name) { const f = path.join(app.home, `${name}.png`); execFileSync('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 }); return f; }
const SHOTS = [];
async function click(app, x, y) { await mouse(app, 'mouseMoved', x, y); await sleep(80); await mouse(app, 'mousePressed', x, y, { clickCount: 1 }); await mouse(app, 'mouseReleased', x, y, { clickCount: 1 }); await sleep(400); }
async function main() {
  const missing = ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR'].filter((k) => !process.env[k]);
  if (missing.length) { console.error(`not launched via scripts/e2e-sidebar-declutter-drive.sh (missing ${missing.join(', ')})`); process.exit(2); }
  const built = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
  console.log(`BUILD  app dir ${APP_DIR}  version ${built}  HEAD ${head}`);
  const liveBefore = Object.fromEntries(liveDirs().map((d) => [d, liveSnapshot(d)]));
  const shimBefore = shimHash();
  const home = path.join(RIG.base, `sdc-${Date.now().toString(36)}`);
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
    await waitFor('rows rendered', async () => { const r = await rows(app); return Object.values(BR).every((b) => r.some((x) => x.text === b)); }, 25000, 250);
    // PR data reaches the renderer (the badge input is present, so an absent badge is the rendering's doing)
    const prRec = await app.cdp.eval(`window.orchestra.findPR(${JSON.stringify(ID.c1)})`);
    clause('data/pr-record-for-c1-present', prRec && (Array.isArray(prRec.all) && prRec.all.length > 0 || !!prRec.error), JSON.stringify(prRec).slice(0, 220));
    await sleep(4000); // let the PR / Linear polls land in the store
    await mouse(app, 'mouseMoved', 5, 5); await sleep(300);
    const all = await rows(app);
    for (const r of all) note(`row ${r.path.padEnd(4)} ${r.text.padEnd(18)} pr=${JSON.stringify(r.pr)} orch=${JSON.stringify(r.orch)} hidden=${JSON.stringify(r.hidden)}`);
    const g = await globalCounts(app);
    clause('rows/no-pr-or-linear-badge', all.every((r) => r.pr.length === 0) && g.pr === 0, `.pr-badge in sidebar=${g.pr}`);
    clause('rows/no-agent-count-glyph', g.orch === 0 && g.orchCount === 0, `.orchestrator-pill=${g.orch} .orch-count=${g.orchCount}`);
    const pRow = all.find((r) => r.text === BR.p), opsRow = all.find((r) => r.text === 'ops-demo');
    clause('expanded/no-hidden-count', pRow?.hidden.length === 0 && opsRow?.hidden.length === 0, `P hidden=${JSON.stringify(pRow?.hidden)} OPS hidden=${JSON.stringify(opsRow?.hidden)}`);
    SHOTS.push(['expanded-renderer', await shot(app, 'expanded-renderer')]);
    // collapse P (repo path) and OPS (tree path) with trusted clicks on their chevrons
    for (const [label, text] of [['P', BR.p], ['OPS', 'ops-demo']]) {
      const r = await rowOf(app, text);
      if (!r?.chevron) { clause(`collapse/${label}-chevron-present`, false, 'no .ws-chevron'); continue; }
      await mouse(app, 'mouseMoved', r.chevron.cx, r.chevron.cy); await sleep(150);
      await click(app, r.chevron.cx, r.chevron.cy);
    }
    await mouse(app, 'mouseMoved', 5, 5); await sleep(400);
    const col = await rows(app);
    const pC = col.find((r) => r.text === BR.p), oC = col.find((r) => r.text === 'ops-demo');
    for (const r of col) note(`collapsed row ${r.path.padEnd(4)} ${r.text.padEnd(18)} pr=${JSON.stringify(r.pr)} orch=${JSON.stringify(r.orch)} hidden=${JSON.stringify(r.hidden)}`);
    note(`P hidden pre -> post: ${JSON.stringify(pRow?.hidden)} -> ${JSON.stringify(pC?.hidden)} ; OPS: ${JSON.stringify(opsRow?.hidden)} -> ${JSON.stringify(oC?.hidden)}`);
    clause('collapsed/kids-hidden', !col.some((r) => [BR.k1, BR.k2, BR.c1, BR.c2].includes(r.text)), col.map((r) => r.text).join(','));
    clause('collapsed/repo-path-hidden-count', pC?.path === 'repo' && pC.hidden.length === 1 && /:2$/.test(pC.hidden[0]) && /\bwaiting\b/.test(pC.hidden[0]), `P ${JSON.stringify(pC?.hidden)} (2 kids, one waiting ⇒ waiting tint)`);
    clause('collapsed/tree-path-hidden-count', oC?.path === 'tree' && oC.hidden.length === 1 && /:2$/.test(oC.hidden[0]), `OPS ${JSON.stringify(oC?.hidden)}`);
    const g2 = await globalCounts(app);
    clause('collapsed/still-no-agent-count-glyph', g2.orch === 0 && g2.pr === 0, JSON.stringify(g2));
    clause('rows/in-viewport', [pC, oC].every((r) => r?.inViewport), '');
    SHOTS.push(['collapsed-renderer', await shot(app, 'collapsed-renderer')]);
    SHOTS.push(['collapsed-composed', grim(app, 'collapsed-composed')]);
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
