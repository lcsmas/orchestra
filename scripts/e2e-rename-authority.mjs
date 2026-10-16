// #383 G6 — rename authority (human > parent > child) driven on a BUILT Orchestra, inside the contained rig's own headless sway.
//
// Boots the built app (argv[2] = app dir) with a SCRATCH ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR and a seeded store of REAL git worktrees:
//   ws-rd-par    the parent (orchestrator-capable)
//   ws-rd-kid    a spawned child NAMED BY ITS PARENT      (parentId + namedByParent = ws-rd-par)        -> state P
//   ws-rd-legacy a legacy spawned child, nobody named it  (parentId only, autoRenameCount 2)            -> state U
//   ws-rd-legacy2 same, but the HUMAN renames it from the sidebar (D6: its parent is then refused too)
//   ws-rd-human  a human-created workspace                (no parent)                                    -> state U (human-created)
// plus a REAL `orchestra spawn --name` (the real claude CLI against #382's local FAKE Anthropic API — zero tokens): the child is born parent-named,
// then drives the BUILT CLI (dist-electron/cli.js, ORCHESTRA_WS_ID = the caller) and the sidebar (TRUSTED double-click + typing) and
// asserts, per scenario, `pre -> post` on THREE independent surfaces: the real git branch, the rendered sidebar row, the persisted store.
//   A* = the authority clauses (must be RED on a build without #383), K* = keepers (green on both: today's behaviour, and a parent renaming a child that #382 already
//   made parent-named — it already landed uncounted — which #383 must not break), ctl/* = controls.
// --expect-red = the must-FAIL arm (run against a pre-#383 build): exit 0 only if every A* is RED and every K*/ctl is GREEN.
// Usage (via scripts/e2e-rename-authority.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--expect-red]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './session-budget/fake-anthropic-api.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const EXPECT_RED = argv.includes('--expect-red');
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-rename-authority.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch containment (a live dir is never handed to the app or the CLI) ───────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(real);
function checkScratch(p) {
  const r = real(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{ const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · other path -> ${b.clause} · rig path -> ${c.clause}`); }

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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async mouse(type, x, y, extra = {}) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(50); }
  async dblclick(x, y) { await this.mouse('mouseMoved', x, y); for (const n of [1, 2]) { await this.mouse('mousePressed', x, y, { button: 'left', clickCount: n }); await this.mouse('mouseReleased', x, y, { button: 'left', clickCount: n }); } }
  async key(type, key, extra = {}) { await this.send('Input.dispatchKeyEvent', { type, key, ...extra }); await sleep(50); }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

// ── seed: a real repo + 4 REGISTERED worktrees (prune deletes what it cannot verify), the PINNED scratch account, a stub `claude` ──
const IDS = { par: 'ws-rd-par', kid: 'ws-rd-kid', legacy: 'ws-rd-legacy', legacy2: 'ws-rd-legacy2', human: 'ws-rd-human' };
const START = { par: 'ops-rename-drive', kid: 'impl-drive-kid-1', legacy: 'legacy-agent-x', legacy2: 'legacy-agent-y', human: 'witty-falcon' };
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.join(armDir, 'wt')]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# rename-authority seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  // a pinned account drops the inherited ANTHROPIC_* unless its env names them: the real claude CLI talks to the LOCAL fake API only
  const account = { id: 'rig-rd', label: 'rig (scratch config dir)', configDir: cfg, env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}', ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}' } };
  mustBeScratch('account.configDir', account.configDir);
  const wts = {}, wss = [];
  let t = Date.now();
  for (const k of Object.keys(IDS)) {
    const wt = path.join(armDir, 'wt', k); wts[k] = wt;
    git(repoDir, ['worktree', 'add', '-q', '-b', START[k], wt], fakeHome);
    fs.mkdirSync(path.join(wt, '.orchestra'), { recursive: true }); // a real workspace has it from creation (hooks/sentinels live there); writes into it are best-effort
    const base = { id: IDS[k], name: `repo · ${START[k]}`, repoPath: repoDir, worktreePath: wt, branch: START[k], baseBranch: 'main', createdAt: t++, status: 'idle', agent: 'claude', accountId: account.id, branchManuallySet: false };
    if (k === 'par') wss.push({ ...base, canOrchestrate: true });
    else if (k === 'kid') wss.push({ ...base, parentId: IDS.par, namedByParent: IDS.par });
    else if (k === 'legacy' || k === 'legacy2') wss.push({ ...base, parentId: IDS.par, autoRenameCount: 2 });
    else wss.push(base);
  }
  const list = git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome);
  for (const wt of Object.values(wts)) if (!list.includes(`worktree ${fs.realpathSync(wt)}`)) throw new Error(`seed worktree not registered: ${wt}`);
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'rd-repo', defaultBranch: 'main', accountId: account.id }], workspaces: wss, accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(LIVE_HOME, '.local/bin/claude')), path.join(stubDir, 'claude')); // the REAL claude CLI (read-only link); its API is the local fake
  return { fakeHome, ohome, cfg, account, wts, repoDir, stubDir, storeFile: path.join(dir, 'store.json') };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}

const results = [], shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

async function main() {
  const armDir = path.join(RIG_DIR, `arm-${LABEL}`); fs.mkdirSync(armDir, { recursive: true });
  const W = seedWorld(armDir);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const fakeApi = await startFakeApi({ markers: {}, reply: () => ({ text: 'ok' }) });
  const port = await freePort();
  const env = { PATH: `${W.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: W.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(W.fakeHome, '.config'), XDG_CACHE_HOME: path.join(W.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: W.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: W.cfg, LANG: 'C.UTF-8',
    ANTHROPIC_BASE_URL: fakeApi.url, ANTHROPIC_API_KEY: 'sk-ant-fake-rig-key', HTTPS_PROXY: fakeApi.proxyUrl, HTTP_PROXY: fakeApi.proxyUrl, NO_PROXY: '127.0.0.1,localhost' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const fd = fs.openSync(path.join(armDir, 'app.log'), 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${path.join(armDir, 'app.log')}`);
  let cdp;
  try {
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
    clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-name').length >= 5`), 60000, 'the 5 seeded sidebar rows');
    const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    clause('ctl/app-identity-bundle', fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)), `renderer bundle ${path.basename(bundle)} as served md5 ${md5(served)} == file in app dir md5 ${fs.existsSync(onDisk) ? md5(fs.readFileSync(onDisk)) : 'n/a'} (package.json ${ver})`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause('ctl/scratch-env', ev('ORCHESTRA_HOME') === W.ohome && ev('CLAUDE_CONFIG_DIR') === W.cfg && ev('HOME') === W.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND,
      `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause('ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} present in my sway's get_tree`);
    clause('ctl/account-pinned', W.account.configDir === W.cfg && checkScratch(W.cfg).ok, `seeded accountId ${W.account.id}, workspaces carry it; configDir ${W.cfg} (scratch)`);

    // ── instruments ──
    const CLI = path.join(APP_DIR, 'dist-electron', 'cli.js');
    const cliEnv = (who) => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: W.fakeHome, ORCHESTRA_HOME: W.ohome, ...(who ? { ORCHESTRA_WS_ID: who } : {}) });
    const cli = (who, args, timeout = 30000) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cliEnv(who), timeout }); return { rc: r.status, out: r.stdout, err: r.stderr }; };
    const rename = (who, target, name) => cli(who, ['rename', target, name]);
    const gitBranch = (k) => git(W.wts[k], ['rev-parse', '--abbrev-ref', 'HEAD'], W.fakeHome).trim();
    const rows = () => cdp.eval(`[...document.querySelectorAll('.ws-name')].map((e) => e.textContent.trim())`);
    const storeById = (id) => JSON.parse(fs.readFileSync(W.storeFile, 'utf8')).workspaces.find((w) => w.id === id);
    const store = (k) => storeById(IDS[k]);
    const settle = async (k, pred, what) => { try { return await waitFor(() => pred(store(k)) && store(k), 10000, what); } catch { return store(k); } };
    const snap = async (k) => ({ git: gitBranch(k), ui: (await rows()).includes(gitBranch(k)), store: store(k) });
    const fmt = (s) => `git=${s.git} ui-row-present=${s.ui} store{branch=${s.store.branch},namedByParent=${s.store.namedByParent ?? '∅'},manual=${s.store.branchManuallySet ?? '∅'},count=${s.store.autoRenameCount ?? '∅'}}`;
    const full = async (name) => { saveShot(`${LABEL}-${name}-renderer.png`, await cdp.shot()); const g = path.join(OUT, `${LABEL}-${name}-compositor.png`); sh('grim', ['-o', 'HEADLESS-1', g], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } }); shots.push({ file: g, md5: md5(fs.readFileSync(g)) }); };
    await cdp.mouse('mouseMoved', 5, 895);
    await sleep(600);

    // ── pre-state ──
    const pre = {}; for (const k of Object.keys(IDS)) pre[k] = await snap(k);
    console.log(`  pre-state rows: ${JSON.stringify(await rows())}`);
    for (const k of Object.keys(IDS)) console.log(`    ${k}: ${fmt(pre[k])}`);
    { const r0 = await rows(); clause('ctl/seeded-rows-rendered', Object.values(START).every((b) => r0.includes(b)), `sidebar shows ${JSON.stringify(r0)} ⊇ every seeded branch ${JSON.stringify(Object.values(START))}`); }
    await full('00-initial');

    // ── S0 positive control: the CLI→socket→app path works at all (a human-created workspace renames itself, as today) ──
    const s0 = rename(IDS.human, IDS.human, 'nudge-first-name');
    const s0s = await settle('human', (w) => w.branch === 'nudge-first-name', 'human self-rename #1');
    clause('ctl/cli-reaches-app', s0.rc === 0 && /^Renamed to nudge-first-name/.test(s0.out) && gitBranch('human') === 'nudge-first-name', `ws-rd-human self-rename: rc=${s0.rc} stdout=${JSON.stringify(s0.out.trim())} git ${START.human} -> ${gitBranch('human')}`);

    // ── K5 + A15-A17: a REAL `orchestra spawn --name` (the #382 path) — the child is BORN parent-named; it cannot rename itself, its parent can, and it cannot overwrite ──
    const rsp = cli(IDS.par, ['spawn', '--name', 'impl-real-spawn-1', '--task', 'RENAME-DRIVE-CHILD-SENTINEL — reply ok and stop.'], 90000);
    const rspM = /^Spawned (\S+) on branch (\S+)$/m.exec(rsp.out);
    const realId = rspM?.[1];
    let realRec = null; try { realRec = await waitFor(() => (realId && storeById(realId)) || null, 20000, 'the spawned child in the store'); } catch {}
    const gitAt = (wt) => git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], W.fakeHome).trim();
    clause('K5/real-spawn-born-named-by-parent', rsp.rc === 0 && !!rspM && rspM[2] === 'impl-real-spawn-1' && !!realRec && realRec.parentId === IDS.par && realRec.namedByParent === IDS.par && !realRec.branchManuallySet && gitAt(realRec.worktreePath) === 'impl-real-spawn-1' && (await rows()).includes('impl-real-spawn-1'),
      `spawn rc=${rsp.rc} stdout=${JSON.stringify(rsp.out.trim())}; record parentId=${realRec?.parentId} namedByParent=${realRec?.namedByParent} manual=${realRec?.branchManuallySet}; git HEAD=${realRec ? gitAt(realRec.worktreePath) : 'n/a'}; sidebar row present=${(await rows()).includes('impl-real-spawn-1')}`);
    if (!realRec) throw new Error('the real spawn produced no workspace record — cannot drive the real-child clauses');
    await full('00b-after-real-spawn'); // the new row `impl-real-spawn-1` (distinct from the initial and from every later state)
    const realBranch = () => gitAt(realRec.worktreePath);
    const rs1 = cli(realId, ['rename', realId, 'real-child-picks-its-own']);
    clause('A15/real-spawned-child-self-rename-refused', rs1.rc !== 0 && /named by your parent \(ops-rename-drive\) — ask them to run `orchestra rename`/.test(rs1.err) && realBranch() === 'impl-real-spawn-1', `rc=${rs1.rc} stderr=${JSON.stringify(rs1.err.trim())}; branch impl-real-spawn-1 -> ${realBranch()}`);
    const rs2 = cli(IDS.par, ['rename', realId, 'impl-real-spawn-renamed-by-parent']);
    const rs2s = await waitFor(() => { const w = storeById(realId); return w.branch === 'impl-real-spawn-renamed-by-parent' ? w : null; }, 10000, 'the parent rename of the real child').catch(() => storeById(realId));
    clause('K7/parent-rename-of-the-real-spawned-child-lands-and-keeps-the-namer', rs2.rc === 0 && realBranch() === 'impl-real-spawn-renamed-by-parent' && rs2s.namedByParent === IDS.par && !rs2s.branchManuallySet && !(rs2s.autoRenameCount > 0) && (await rows()).includes('impl-real-spawn-renamed-by-parent'),
      `rc=${rs2.rc}; impl-real-spawn-1 -> ${realBranch()}; store{namedByParent=${rs2s.namedByParent},manual=${rs2s.branchManuallySet ?? '∅'},count=${rs2s.autoRenameCount ?? '∅'}}`);
    const rs3 = cli(realId, ['rename', realId, 'real-child-overwrites']);
    clause('A17/real-child-cannot-overwrite-the-parent', rs3.rc !== 0 && /named by your parent/.test(rs3.err) && realBranch() === 'impl-real-spawn-renamed-by-parent', `rc=${rs3.rc} stderr=${JSON.stringify(rs3.err.trim())}; branch stays ${realBranch()}`);

    // ── A1-A3: the child (state P) cannot rename itself; an unknown caller and an unrelated agent cannot either ──
    const preKid = await snap('kid');
    const a1 = rename(IDS.kid, IDS.kid, 'child-picks-its-own');
    const a1s = await snap('kid');
    clause('A1/child-self-rename-refused', a1.rc !== 0 && /named by your parent \(ops-rename-drive\) — ask them to run `orchestra rename`/.test(a1.err) && !/Renamed/.test(a1.out) && a1s.git === preKid.git && a1s.store.branch === preKid.store.branch,
      `rc=${a1.rc} stderr=${JSON.stringify(a1.err.trim())}; branch unchanged: ${preKid.git} -> ${a1s.git}; ${fmt(a1s)}`);
    const a2 = rename(null, IDS.kid, 'old-cli-no-from'); const a2s = await snap('kid');
    clause('A2/unknown-caller-refused', a2.rc !== 0 && /named by your parent/.test(a2.err) && a2s.git === preKid.git, `no ORCHESTRA_WS_ID (an old CLI / plain shell): rc=${a2.rc} stderr=${JSON.stringify(a2.err.trim())}; branch ${preKid.git} -> ${a2s.git}`);
    const a3 = rename(IDS.human, IDS.kid, 'some-other-agent'); const a3s = await snap('kid');
    clause('A3/other-agent-refused', a3.rc !== 0 && /named by your parent/.test(a3.err) && a3s.git === preKid.git, `caller ws-rd-human on ws-rd-kid: rc=${a3.rc} stderr=${JSON.stringify(a3.err.trim())}; branch ${preKid.git} -> ${a3s.git}`);
    await full('01-after-refusals');

    // ── A4-A5: the parent renames its child, it lands and sticks; the child cannot overwrite it ──
    const a4 = rename(IDS.par, IDS.kid, 'impl-drive-kid-renamed-by-parent');
    const a4s = await settle('kid', (w) => w.branch === 'impl-drive-kid-renamed-by-parent', 'parent rename'); const a4n = await snap('kid');
    clause('K6/parent-rename-of-a-parent-named-child-lands-and-keeps-the-namer', a4.rc === 0 && /^Renamed to impl-drive-kid-renamed-by-parent/.test(a4.out) && a4n.git === 'impl-drive-kid-renamed-by-parent' && a4n.ui && a4s.namedByParent === IDS.par && !a4s.branchManuallySet && !(a4s.autoRenameCount > 0),
      `rc=${a4.rc} stdout=${JSON.stringify(a4.out.trim())}; ${preKid.git} -> ${a4n.git}; ${fmt(a4n)} (counter not bumped, not human-pinned, namer kept)`);
    const a5 = rename(IDS.kid, IDS.kid, 'child-overwrites-parent'); const a5n = await snap('kid');
    clause('A5/child-cannot-overwrite', a5.rc !== 0 && /named by your parent/.test(a5.err) && a5n.git === 'impl-drive-kid-renamed-by-parent', `rc=${a5.rc} stderr=${JSON.stringify(a5.err.trim())}; branch stays ${a5n.git}`);
    await full('02-after-parent-rename');

    // ── K2 + A6-A7: a HUMAN sidebar rename lands (trusted double-click + typing), then BOTH parent and child are refused ──
    const sidebarRename = async (oldName, newName) => {
      const rect = await cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-name')].find((x) => x.textContent.trim() === ${JSON.stringify(oldName)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 60), y: b.top + b.height / 2, inView: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth }; })()`);
      if (!rect || !rect.inView) throw new Error(`row "${oldName}" not drivable: ${JSON.stringify(rect)}`);
      await cdp.dblclick(rect.x, rect.y);
      await waitFor(() => cdp.eval(`!!document.querySelector('input.ws-name-input')`), 10000, 'the inline rename input');
      await cdp.key('keyDown', 'a', { modifiers: 2, commands: ['selectAll'] }); await cdp.key('keyUp', 'a', { modifiers: 2 });
      await cdp.send('Input.insertText', { text: newName }); await sleep(100);
      const typedIn = await cdp.eval(`document.querySelector('input.ws-name-input')?.value`);
      await cdp.key('keyDown', 'Enter', { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await cdp.key('keyUp', 'Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });
      return typedIn;
    };
    const typed = await sidebarRename(a5n.git, 'impl-drive-kid-human-typed');
    const k2s = await settle('kid', (w) => w.branch === 'impl-drive-kid-human-typed', 'sidebar rename'); const k2n = await snap('kid');
    await waitFor(async () => (await rows()).includes('impl-drive-kid-human-typed'), 10000, 'the typed name in the sidebar');
    clause('K2/sidebar-rename-lands-and-pins', typed === 'impl-drive-kid-human-typed' && k2n.git === 'impl-drive-kid-human-typed' && k2s.branchManuallySet === true && k2s.namedByParent === IDS.par,
      `typed "${typed}"; ${a5n.git} -> ${k2n.git}; ${fmt(k2n)} (human pin set, namer kept)`);
    await cdp.mouse('mouseMoved', 5, 895);
    await full('03-after-sidebar-rename');
    const a6 = rename(IDS.par, IDS.kid, 'parent-after-human'); const a6n = await snap('kid');
    clause('A6/parent-refused-after-human-pin', a6.rc !== 0 && /^named by the human/.test(a6.err) && a6n.git === 'impl-drive-kid-human-typed', `rc=${a6.rc} stderr=${JSON.stringify(a6.err.trim())}; branch stays ${a6n.git}`);
    const a7 = rename(IDS.kid, IDS.kid, 'child-after-human'); const a7n = await snap('kid');
    clause('A7/child-refused-after-human-pin', a7.rc !== 0 && /^named by the human/.test(a7.err) && a7n.git === 'impl-drive-kid-human-typed', `rc=${a7.rc} stderr=${JSON.stringify(a7.err.trim())}; branch stays ${a7n.git}`);

    // ── K1: a human-created workspace keeps today's self-naming: 2 counted renames, then on-demand, never refused ──
    const k1 = [rename(IDS.human, IDS.human, 'nudge-second-name'), rename(IDS.human, IDS.human, 'on-demand-third-name')];
    const k1s = await settle('human', (w) => w.branch === 'on-demand-third-name', 'human self-rename #3'); const k1n = await snap('human');
    clause('K1/human-created-self-renames-as-today', k1.every((r) => r.rc === 0) && k1n.git === 'on-demand-third-name' && k1s.autoRenameCount === 2 && !k1s.namedByParent && !k1s.branchManuallySet,
      `3 self-renames (first in ctl/cli-reaches-app): ${START.human} -> ${k1n.git}; ${fmt(k1n)} (counter 1,2,then not counted; never pinned)`);

    // ── A8-A10: a legacy child (state U) renamed by its parent becomes parent-named (what the migration #385 relies on); the nudge retires ──
    const preLeg = await snap('legacy');
    const a8 = rename(IDS.legacy, IDS.legacy, 'legacy-renames-itself-before');
    const a8s = await settle('legacy', (w) => w.branch === 'legacy-renames-itself-before', 'legacy self-rename');
    clause('K3/legacy-agent-still-self-renames', a8.rc === 0 && gitBranch('legacy') === 'legacy-renames-itself-before' && !a8s.namedByParent, `unnamed legacy child + self: rc=${a8.rc}; ${preLeg.git} -> ${gitBranch('legacy')}; namedByParent ${a8s.namedByParent ?? '∅'} (today's behaviour)`);
    const a9 = rename(IDS.par, IDS.legacy, 'review-legacy-named-by-parent');
    const a9s = await settle('legacy', (w) => w.branch === 'review-legacy-named-by-parent' && w.namedByParent === IDS.par, 'parent rename of the legacy child'); const a9n = await snap('legacy');
    clause('A9/parent-rename-of-unnamed-child-pins-P', a9.rc === 0 && a9n.git === 'review-legacy-named-by-parent' && a9s.namedByParent === IDS.par && !a9s.branchManuallySet,
      `rc=${a9.rc}; branch -> ${a9n.git}; ${fmt(a9n)} (namedByParent now ${IDS.par})`);
    const a10 = rename(IDS.legacy, IDS.legacy, 'legacy-after-pin'); const a10n = await snap('legacy');
    clause('A10/pinned-legacy-child-now-refused', a10.rc !== 0 && /named by your parent \(ops-rename-drive\)/.test(a10.err) && a10n.git === 'review-legacy-named-by-parent', `rc=${a10.rc} stderr=${JSON.stringify(a10.err.trim())}; branch stays ${a10n.git}`);
    const sentinel = path.join(W.wts.legacy, '.orchestra', '.branch-renamed');
    const sent = fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8').trim() : null;
    clause('A11/live-nudge-retired-by-parent-pin', sent === '2', `${sentinel} = ${JSON.stringify(sent)} (MAX_AUTO_RENAMES=2 -> the live session's rename hook exits)`);
    // ── A12 / K4 (D6): a legacy child (state U) the HUMAN renamed from the sidebar — its PARENT is refused, the agent itself is not ──
    const typed2 = await sidebarRename(START.legacy2, 'legacy-agent-y-human-typed');
    const l2s = await settle('legacy2', (w) => w.branch === 'legacy-agent-y-human-typed' && w.branchManuallySet === true, 'sidebar rename of legacy2');
    const a12 = rename(IDS.par, IDS.legacy2, 'parent-overrides-human-on-legacy'); const a12n = await snap('legacy2');
    clause('A12/parent-refused-on-human-pinned-legacy-child (D6)', typed2 === 'legacy-agent-y-human-typed' && l2s.branchManuallySet === true && !l2s.namedByParent && a12.rc !== 0 && /^named by the human/.test(a12.err) && a12n.git === 'legacy-agent-y-human-typed',
      `typed "${typed2}" -> pinned (manual=${l2s.branchManuallySet}, namedByParent ${l2s.namedByParent ?? '∅'}); parent rename: rc=${a12.rc} stderr=${JSON.stringify(a12.err.trim())}; branch stays ${a12n.git}`);
    const k4 = rename(IDS.legacy2, IDS.legacy2, 'legacy-y-agent-after-human'); const k4n = await snap('legacy2');
    clause('K4/human-pinned-legacy-agent-still-self-renames', k4.rc === 0 && k4n.git === 'legacy-y-agent-after-human', `self-rename of a human-pinned legacy child (no namer): rc=${k4.rc}; ${a12n.git} -> ${k4n.git} (today's behaviour — only the parent is refused)`);

    // ── A13 / A14: a child REFUSED by /rename that runs \`git branch -m\` itself must not mint a human pin and lock its parent out ──
    const oob = 'child-git-renamed-itself';
    const legacyNow = gitBranch('legacy'); // the fixed build: review-legacy-named-by-parent; a pre-#383 build let the child rename itself, so follow the real branch
    git(W.wts.legacy, ['branch', '-m', legacyNow, oob], W.fakeHome);
    const lrect = await cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-name')].find((x) => x.textContent.trim() === ${JSON.stringify(legacyNow)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
    if (lrect) { await cdp.mouse('mouseMoved', lrect.x, lrect.y); await cdp.mouse('mousePressed', lrect.x, lrect.y, { button: 'left', clickCount: 1 }); await cdp.mouse('mouseReleased', lrect.x, lrect.y, { button: 'left', clickCount: 1 }); } // select it: the stats poll (and the branch probe) runs for the selected workspace
    let adopted = null;
    try { adopted = await waitFor(() => { const w = store('legacy'); return w.branch === oob ? w : null; }, 100000, 'the out-of-band branch to be adopted by the stats-poll probe'); } catch (e) { adopted = null; }
    const a13n = await snap('legacy');
    clause('A13/out-of-band-git-rename-adopted-without-human-pin', !!adopted && a13n.git === oob && a13n.ui && !adopted.branchManuallySet && adopted.namedByParent === IDS.par, `git branch -m by the child: stored branch ${adopted ? adopted.branch : '(not adopted within 100 s)'}; ${fmt(a13n)} (must adopt the name but leave manual=∅/false and the namer)`);
    const a14 = rename(IDS.par, IDS.legacy, 'review-legacy-parent-restored'); const a14n = await snap('legacy');
    const a14c = rename(IDS.legacy, IDS.legacy, 'child-again-after-git'); const a14cn = await snap('legacy');
    clause('A14/parent-still-in-charge-after-out-of-band-rename', a14.rc === 0 && a14n.git === 'review-legacy-parent-restored' && a14c.rc !== 0 && /named by your parent/.test(a14c.err) && a14cn.git === 'review-legacy-parent-restored', `parent rename: rc=${a14.rc} ${oob} -> ${a14n.git}; child again: rc=${a14c.rc} stderr=${JSON.stringify(a14c.err.trim())}; branch stays ${a14cn.git}`);
    await full('04-final');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${LABEL}-states.json`), JSON.stringify({ pre, rows: await rows(), final: Object.fromEntries(Object.keys(IDS).map((k) => [k, store(k)])), version: ver }, null, 2));
  } catch (e) {
    clause('rig/completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(W.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(W.ohome);
    try { await fakeApi.stop(); } catch {}
    clause('rig/teardown-no-survivors', left.length === 0, `processes still carrying ${W.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  // ~/.orchestra is written continuously by the LIVE fleet, so a content hash there is not an instrument; the drive's own fixtures must simply never appear in it.
  let leaked = ''; try { leaked = sh('grep', ['-rlsE', 'ws-rd-(par|kid|legacy|human)', path.join(LIVE_HOME, '.orchestra', 'userData'), path.join(LIVE_HOME, '.orchestra', 'bus.sqlite')]).trim(); } catch {}
  snap['~/.orchestra fixture-id leaks'] = leaked || 'none';
  return snap;
}

const before = liveCanary();
console.log(`[rig] app ${APP_DIR} label ${LABEL} expect-red=${EXPECT_RED} out=${OUT}`);
await main();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('ctl/live-dirs-untouched', same && after['~/.orchestra fixture-id leaks'] === 'none', `${Object.keys(before).length - 1} live ~/.claude* dirs symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED ' + JSON.stringify({ before, after })}; fixture ids in live ~/.orchestra: ${after['~/.orchestra fixture-id leaks']}`);

console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const isA = (c) => /^A\d+\//.test(c.clause);
const aRed = results.filter((c) => isA(c) && !c.ok), aAll = results.filter(isA), otherRed = results.filter((c) => !isA(c) && !c.ok);
let verdict, rc;
if (EXPECT_RED) ({ verdict, rc } = otherRed.length === 0 && aAll.length > 0 && aRed.length === aAll.length ? { verdict: `EXPECTED-RED CONFIRMED: ${aRed.length}/${aAll.length} authority clauses red (${aRed.map((c) => c.clause.split('/')[0]).join(', ')}), every keeper/control green`, rc: 0 } : { verdict: `EXPECTED-RED NOT MET: authority red ${aRed.length}/${aAll.length}; keeper/control red: ${otherRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
else ({ verdict, rc } = results.every((c) => c.ok) && dup === 0 ? { verdict: `ALL GREEN: ${results.length} clauses (${aAll.length} authority, ${results.length - aAll.length} keeper/control), 0 duplicate captures`, rc: 0 } : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => c.clause).join('; ')}${dup ? `; ${dup} duplicate capture(s)` : ''}`, rc: 1 });
console.log(`\nVERDICT: ${verdict}`);
process.exit(rc);
