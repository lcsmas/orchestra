// #385 — scripts/migrate-parent-names.mjs against a BUILT Orchestra (argv[2] = app dir), inside the contained rig's own headless sway, scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR.
// World: a repo-less orchestrator PARENT, two spawned children under it (C1 not pushed, C2 whose branch is on a local `origin`), one human-created workspace H.
// Flow: dry-run (writes nothing) → `--apply` through the REAL built CLI (dist-electron/cli.js, ORCHESTRA_WS_ID=<parent>) → the store, git and the sidebar are read back → a second `--apply` plans nothing.
// Oracles: store.json (branch / namedByParent / formerBranch / branchManuallySet) · `git branch --show-current` in the worktree · the sidebar DOM (`.ws-name` text + title) · a renderer screenshot per state ·
// the real `orchestra peers`. Positive controls: app identity (target url ⊇ app dir, served bundle md5 == dist file), scratch env read out of the running app, app present in MY sway, live ~/.claude* untouched.
//
// Usage (via scripts/e2e-migrate-parent-names.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-migrate-parent-names.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
if (process.env.ORCHESTRA_SOCK) refuse('ORCHESTRA_SOCK is set — the rig must not see the live app');
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard (everything the drive writes or launches must live under the rig base, never in a live dir) ──
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── world ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo'), originDir = path.join(armDir, 'origin.git');
  const wtDir = path.join(armDir, 'wt'), scratchDir = path.join(armDir, 'scratch', 'parent');
  for (const d of [fakeHome, ohome, cfg, repoDir, originDir, wtDir, scratchDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, origin: originDir })) mustBeScratch(k, v);
  git(originDir, ['init', '-q', '--bare', '-b', 'main'], fakeHome);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repoDir, 'README.md'), '# mig385 seed repo\n'); git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['remote', 'add', 'origin', originDir], fakeHome); git(repoDir, ['push', '-q', 'origin', 'main'], fakeHome);
  const account = { id: 'rig-mig385', label: 'rig (scratch config dir)', configDir: cfg };
  const ids = { parent: randomUUID(), c1: randomUUID(), c2: randomUUID(), human: randomUUID() };
  const wsRec = (id, branch, extra = {}) => ({ id, name: `repo · ${branch}`, repoPath: repoDir, worktreePath: path.join(wtDir, branch), branch, baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id, setupStatus: 'ok', hasInput: false, ...extra });
  for (const b of ['old-child-one', 'old-child-two', 'old-human']) git(repoDir, ['worktree', 'add', '-q', '-b', b, path.join(wtDir, b), 'main'], fakeHome);
  git(repoDir, ['push', '-q', 'origin', 'old-child-two'], fakeHome); // C2's branch is ON origin → the script must skip it
  const parent = { id: ids.parent, name: 'orchestrator · ops-parent', kind: 'orchestrator', canOrchestrate: true, repoPath: '', worktreePath: scratchDir, branch: 'ops-parent', baseBranch: '', createdAt: Date.now() - 1000, status: 'idle', agent: 'claude', accountId: account.id, hasInput: false };
  const workspaces = [parent, wsRec(ids.c1, 'old-child-one', { parentId: ids.parent }), wsRec(ids.c2, 'old-child-two', { parentId: ids.parent }), wsRec(ids.human, 'old-human')];
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'mig385-repo', defaultBranch: 'main', accountId: account.id }], workspaces, accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });
  // `orchestra` = the REAL built CLI of the app under test (what an installed shim execs), never a stub
  fs.writeFileSync(path.join(stubDir, 'orchestra'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(APP_DIR, 'dist-electron', 'cli.js'))} "$@"\n`, { mode: 0o755 });
  return { fakeHome, ohome, cfg, stubDir, ids, repoDir, wtDir, account, storeFile: path.join(dir, 'store.json') };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp);
  }
  return snap;
}

async function main() {
  const before = liveCanary();
  const armDir = path.join(RIG_DIR, `arm-${LABEL}`); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  const { ids } = world;
  clause('ctl/account-pinned', world.account.configDir === world.cfg && checkScratch(world.cfg).ok && JSON.parse(fs.readFileSync(world.storeFile, 'utf8')).workspaces.every((w) => w.accountId === world.account.id), `accountId ${world.account.id} == account.id; configDir ${world.cfg} (scratch)`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(armDir, 'app.log'); const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  const store = () => JSON.parse(fs.readFileSync(world.storeFile, 'utf8')).workspaces.reduce((m, w) => (m[w.id] = w, m), {});
  const storeRaw = () => fs.readFileSync(world.storeFile, 'utf8');
  // The script runs in an `env -i` allowlist: scratch ORCHESTRA_HOME (store + socket pointer), `orchestra` = the real built CLI. NEVER ORCHESTRA_SOCK / the caller's ORCHESTRA_WS_ID.
  const scriptEnv = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, LANG: 'C.UTF-8' };
  const table = path.join(armDir, 'table.json');
  fs.writeFileSync(table, JSON.stringify([
    { id: ids.c1, old: 'old-child-one', new: 'impl-enfant-un-385' },
    { id: ids.c2, old: 'old-child-two', new: 'impl-enfant-deux-385' },
    { id: ids.human, old: 'old-human', new: 'impl-humain-trois-385' },
  ], null, 2));
  mustBeScratch('table', table);
  const migrate = (...extra) => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(APP_DIR, 'scripts', 'migrate-parent-names.mjs'), '--table', table, ...extra], { encoding: 'utf8', env: scriptEnv, timeout: 120_000 });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  };
  const rows = () => cdp.eval(`[...document.querySelectorAll('.ws-name')].map((e) => ({ text: e.textContent.trim(), title: e.getAttribute('title') || '' }))`);
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
    clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(async () => (await rows()).length >= 4, 60000, 'the 4 seeded workspaces in the sidebar');
    const srcs = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`); const bundle = srcs.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id; const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    clause('ctl/app-identity-bundle', !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)), `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file; package.json version ${JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version}; dist-electron/main.js md5 ${md5(fs.readFileSync(path.join(APP_DIR, 'dist-electron', 'main.js')))}`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause('ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `app environ ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause('ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} in my sway's get_tree`);

    // ── P0: the pre-state ──
    const s0 = store(); const r0 = await rows(); const raw0 = storeRaw();
    clause('P0/pre-state', s0[ids.c1].branch === 'old-child-one' && !s0[ids.c1].namedByParent && !s0[ids.c1].formerBranch && r0.some((r) => r.text === 'old-child-one') && r0.some((r) => r.text === 'old-child-two') && r0.some((r) => r.text === 'old-human'),
      `C1 branch ${s0[ids.c1].branch}, namedByParent ${s0[ids.c1].namedByParent ?? '∅'}, formerBranch ${s0[ids.c1].formerBranch ?? '∅'}; sidebar rows [${r0.map((r) => r.text).join(', ')}]`);
    const f0 = saveShot(`${LABEL}-p0-before-renderer.png`, await cdp.shot());

    // ── P1: dry-run writes nothing ──
    const dry = migrate();
    await sleep(1500);
    clause('P1/dry-run-plans-and-writes-nothing', dry.rc === 0 && /DRY RUN/.test(dry.out) && /rename\s+old-child-one -> impl-enfant-un-385/.test(dry.out) && /skip \(branch on origin\)\s+old-child-two/.test(dry.out) && /untouched \(no parent to name it\)\s+old-human/.test(dry.out) && storeRaw() === raw0,
      `rc ${dry.rc}; plan lines ${dry.out.split('\n').filter((l) => l.startsWith('PLAN')).length}; store.json byte-identical: ${storeRaw() === raw0}`);

    // ── P2: --apply through the real CLI ──
    const ap = migrate('--apply');
    clause('P2/apply-ran', ap.rc === 0 && new RegExp(`APPLIED  ${ids.c1.slice(0, 8)}  old-child-one -> impl-enfant-un-385`).test(ap.out) && /DONE  1\/1 renamed/.test(ap.out), `rc ${ap.rc}; ${ap.out.split('\n').filter((l) => /^(APPLIED|FAILED|DONE)/.test(l)).join(' | ')}${ap.err ? ` | stderr: ${ap.err.slice(0, 200)}` : ''}`);
    const s1 = await waitFor(() => { const s = store(); return s[ids.c1].branch === 'impl-enfant-un-385' ? s : null; }, 15000, 'C1 renamed in store.json');
    const c1 = s1[ids.c1];
    clause('P3/store-parent-named-not-human-pinned', c1.namedByParent === ids.parent && c1.branchManuallySet !== true, `C1 branch ${s0[ids.c1].branch} -> ${c1.branch}; namedByParent ${s0[ids.c1].namedByParent ?? '∅'} -> ${c1.namedByParent}; branchManuallySet ${s0[ids.c1].branchManuallySet ?? '∅'} -> ${c1.branchManuallySet ?? '∅'}`);
    clause('P3/store-former-branch-recorded', c1.formerBranch === 'old-child-one', `formerBranch ${s0[ids.c1].formerBranch ?? '∅'} -> ${c1.formerBranch}`);
    clause('P3/git-branch-really-renamed', sh('git', ['-C', c1.worktreePath, 'branch', '--show-current']).trim() === 'impl-enfant-un-385', `git -C ${path.basename(c1.worktreePath)} branch --show-current → ${sh('git', ['-C', c1.worktreePath, 'branch', '--show-current']).trim()}`);
    clause('P3/skipped-and-untouched-workspaces-unchanged', s1[ids.c2].branch === 'old-child-two' && !s1[ids.c2].namedByParent && s1[ids.human].branch === 'old-human' && !s1[ids.human].namedByParent, `C2 (on origin) ${s1[ids.c2].branch}; human ${s1[ids.human].branch}`);

    // ── P4: the sidebar shows it ──
    const r1 = await waitFor(async () => { const r = await rows(); return r.some((x) => x.text === 'impl-enfant-un-385') ? r : null; }, 15000, 'the sidebar row to show the new name');
    const row1 = r1.find((x) => x.text === 'impl-enfant-un-385');
    clause('P4/sidebar-row-text', !r1.some((x) => x.text === 'old-child-one') && r1.some((x) => x.text === 'old-child-two') && r1.some((x) => x.text === 'old-human'), `sidebar rows [${r0.map((r) => r.text).join(', ')}] -> [${r1.map((r) => r.text).join(', ')}]`);
    clause('P4/tooltip-shows-ex-name', /ex-old-child-one/.test(row1.title), `row title ${JSON.stringify(row1.title)}`);
    const f1 = saveShot(`${LABEL}-p4-after-renderer.png`, await cdp.shot());

    // ── P5: `orchestra peers` (the real CLI, as the human-created workspace) shows ex-… ──
    const peers = spawnSync(path.join(world.stubDir, 'orchestra'), ['peers'], { encoding: 'utf8', env: { ...scriptEnv, ORCHESTRA_WS_ID: ids.human }, timeout: 60000 });
    const peerLine = (peers.stdout || '').split('\n').find((l) => l.includes(ids.c1));
    clause('P5/peers-shows-ex-name', peers.status === 0 && !!peerLine && /impl-enfant-un-385/.test(peerLine) && /ex-old-child-one/.test(peerLine), `peers rc ${peers.status}; C1 line ${JSON.stringify(peerLine ?? null)}${peers.stderr ? ` stderr ${peers.stderr.slice(0, 160)}` : ''}`);

    // ── P6: idempotent ──
    const raw1 = storeRaw();
    const again = migrate('--apply');
    await sleep(1500);
    clause('P6/second-apply-plans-nothing', again.rc === 0 && /DONE  0\/0 renamed/.test(again.out) && !/^APPLIED/m.test(again.out) && storeRaw() === raw1, `rc ${again.rc}; ${again.out.split('\n').filter((l) => /^(TOTAL|DONE)/.test(l)).join(' | ')}; store.json byte-identical: ${storeRaw() === raw1}`);

    clause('ctl/no-duplicate-captures', new Set(shots.map((s) => s.md5)).size === shots.length, `${shots.length} captures: ${shots.map((s) => `${path.basename(s.file)}=${s.md5.slice(0, 8)}`).join(', ')}`);
    console.log(`  shots: ${[f0, f1].join(', ')}`);
  } catch (e) {
    clause('rig/completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause('rig/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
  const after = liveCanary();
  clause('ctl/live-claude-dirs-untouched', JSON.stringify(before) === JSON.stringify(after), `${Object.keys(before).length} live ~/.claude* dirs hashed before/after: ${JSON.stringify(before) === JSON.stringify(after) ? 'identical' : 'CHANGED'}`);
}

await main();
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const red = results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${results.length} clauses` : `RED: ${red.map((r) => r.clause).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
