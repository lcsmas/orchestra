// #382 (vague #380) — `orchestra spawn --name` end to end on a BUILT Orchestra inside the contained rig's own headless sway.
// The REAL claude CLI (structured session, real SessionStart/UserPromptSubmit hooks) runs against a LOCAL FAKE Anthropic API — zero tokens.
//   ctl/*      app identity (target url + served bundle md5 + version), scratch env, the account PIN (id / configDir), live-config hashes
//   refuse/*   built cli.js against the live socket: no name / unknown rôle → rc 1, convention restated, NOTHING created (workspaces, branches);
//              the same two bodies POSTed to the hooks socket by hand (an OLD CLI/skill) → ok:false, nothing created
//   named/*    `spawn --name impl-x-1` → record (branch, parentId, namedByParent, branchManuallySet), the git branch, the sidebar row text === name
//              (DOM) + screenshot; a collision is suffixed and the FINAL branch printed; `--detached` still records the namer
//   nudge/*    the child's requests to the model carry NO rename instruction (first prompt, a second prompt, after promote+restart); its CLI env
//              has ORCHESTRA_BRANCH_AUTO=0; the CONTROL (a human-created workspace) DOES receive it with BRANCH_AUTO=1 — the instrument can say "yes"
//   promote/*  spawn → promote keeps the name (story 14)
// Usage: scripts/e2e-spawn-name.sh <app-dir> [--out <dir>]   (build first: pnpm run build:bundles && pnpm run build:bus-abi)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { startFakeApi } from './session-budget/fake-anthropic-api.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : refuse('no <app-dir>');
const LIVE_HOME = flag('--live-home', null) ?? refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('run via scripts/e2e-spawn-name.sh (the contained rig)');
if (process.env.DISPLAY) refuse('X11 DISPLAY set — would reach the human screen');
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} is not the rig's`);
const OUT = flag('--out', path.join(RIG_DIR, 'shots'));

const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(real);
const mustBeScratch = (what, p) => {
  const r = real(p);
  if (LIVE.some((l) => r === l || r.startsWith(l + path.sep))) refuse(`${what}=${p} is a live dir`);
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) refuse(`${what}=${p} is outside the rig base`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const gitIn = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const environOf = (pid) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
const cmdlineOf = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}
const results = [], shots = [];
function clause(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); console.log(`  shot ${f} md5 ${md5(buf)}`); return f; }

// ── live-config fingerprint (G8): the files a rig could rewrite. projects/ and ~/.orchestra change under siblings and are NOT hashed. ──
function liveFingerprint() {
  const out = {};
  for (const d of LIVE.filter((l) => path.basename(l).startsWith('.claude'))) {
    for (const f of ['CLAUDE.md', 'settings.json', 'LESSONS.md', '.claude.json']) {
      const p = path.join(d, f);
      try { out[`${path.basename(d)}/${f}`] = md5(fs.readFileSync(p)); } catch { out[`${path.basename(d)}/${f}`] = 'absent'; }
    }
    try { out[`${path.basename(d)}/skills`] = fs.readdirSync(path.join(d, 'skills')).sort().join(','); } catch { out[`${path.basename(d)}/skills`] = 'absent'; }
    try { out[`${path.basename(d)}/top`] = fs.readdirSync(d).filter((n) => !['projects', 'todos', 'statsig', 'shell-snapshots', 'session-env', 'sessions', 'file-history', 'cache', 'backups', 'history.jsonl', 'telemetry', 'plugins', 'ide', 'debug', 'paste-cache', 'tasks', 'usage-data', 'mcp-needs-auth-cache.json', 'stats-cache.json'].includes(n)).sort().join(','); } catch { /* */ }
  }
  return out;
}
const liveBefore = liveFingerprint();

// ── world ──
const CHILD = 'SPAWN-NAME-CHILD-SENTINEL-1a2b', CHILD2 = 'SPAWN-NAME-CHILD-SECOND-3c4d', CHILD3 = 'SPAWN-NAME-CHILD-THIRD-5e6f', CTL = 'SPAWN-NAME-CONTROL-SENTINEL-7a8b';
const fakeApi = await startFakeApi({ markers: { nudge: 'Rename it NOW', refine: 'REFINE the branch name', autoBranch: 'auto-generated branch', child: CHILD, child2: CHILD2, child3: CHILD3, ctl: CTL }, reply: () => ({ text: 'ok' }) });
const world = (() => {
  const d = path.join(RIG_DIR, 'world');
  const fakeHome = path.join(d, 'home'), ohome = path.join(d, 'oh'), cfg = path.join(d, 'cfg'), repo = path.join(d, 'repo-nom'), wt = path.join(d, 'wt-ops');
  for (const x of [fakeHome, ohome, cfg, repo]) { fs.mkdirSync(x, { recursive: true }); mustBeScratch('seed', x); }
  gitIn(repo, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo, 'README.md'), '#\n'); gitIn(repo, ['add', '.'], fakeHome); gitIn(repo, ['commit', '-q', '-m', 'seed'], fakeHome);
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'ops-rig-parent', wt], fakeHome);
  const fakeEnv = { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}', ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}' }; // a pinned account drops the inherited ANTHROPIC_* unless its env names them
  const accounts = [{ id: 'acc-rig', label: 'rig', configDir: cfg, env: fakeEnv }];
  const base = { baseBranch: 'main', createdAt: Date.now(), agent: 'claude' };
  const workspaces = [{ ...base, id: 'ws-ops', name: `${path.basename(repo)} · ops-rig-parent`, repoPath: repo, worktreePath: wt, branch: 'ops-rig-parent', status: 'idle', accountId: 'acc-rig', canOrchestrate: true, branchManuallySet: true }];
  return { d, fakeHome, ohome, cfg, repo, wt, accounts, workspaces, repos: [{ path: repo, name: 'rig-repo', defaultBranch: 'main', accountId: 'acc-rig' }] };
})();
const storeDir = path.join(world.ohome, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: world.repos, workspaces: world.workspaces, accounts: world.accounts, selfTuneRuns: [] }, null, 2));
const stubDir = path.join(world.d, 'bin'); fs.mkdirSync(stubDir, { recursive: true });
fs.symlinkSync(fs.realpathSync(path.join(LIVE_HOME, '.local/bin/claude')), path.join(stubDir, 'claude'));
const cdpPort = await freePort();
const env = { PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(cdpPort), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
  ANTHROPIC_BASE_URL: fakeApi.url, ANTHROPIC_API_KEY: 'sk-ant-fake-rig-key', HTTPS_PROXY: fakeApi.proxyUrl, HTTP_PROXY: fakeApi.proxyUrl, NO_PROXY: '127.0.0.1,localhost' };
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
const logFile = path.join(world.d, 'app.log'); const fd = fs.openSync(logFile, 'w');
const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
console.log(`app pid ${app.pid}, cdp ${cdpPort}, log ${logFile}`);

const CLI = path.join(APP_DIR, 'dist-electron', 'cli.js');
let cdp, exitCode = 1;
/** Run the BUILT cli.js as `wsId` against the rig's app socket. */
function orch(args, wsId = 'ws-ops') {
  const sock = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ORCHESTRA_SOCK: sock, ...(wsId ? { ORCHESTRA_WS_ID: wsId } : {}) } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function postHooks(route, body) {
  const socketPath = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ socketPath, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
    r.on('error', reject); r.end(payload);
  });
}
const wsList = () => cdp.eval(`window.orchestra.listWorkspaces().then((l) => l.map((w) => ({ id: w.id, name: w.name, branch: w.branch, parentId: w.parentId ?? null, namedByParent: w.namedByParent ?? null, branchManuallySet: w.branchManuallySet ?? null, autoRenameCount: w.autoRenameCount ?? null, canOrchestrate: !!w.canOrchestrate, archived: !!w.archived })))`);
const branches = () => gitIn(world.repo, ['branch', '--format=%(refname:short)'], world.fakeHome).trim().split('\n').sort();
const rowTexts = () => cdp.eval(`[...document.querySelectorAll('.ws-name')].map((e) => e.textContent)`);
/** pids (not zombies) whose environ names this workspace AND whose argv is the claude CLI. */
function cliPids(wsId) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      if (fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1][0] === 'Z') continue;
      const e = environOf(p);
      if (e.includes(`ORCHESTRA_WS_ID=${wsId}`) && e.includes(`ORCHESTRA_HOME=${world.ohome}`) && cmdlineOf(p).some((a) => /claude/.test(path.basename(a)) || /claude/.test(a)) && e.some((x) => x.startsWith('ORCHESTRA_BRANCH_AUTO='))) out.push(+p);
    } catch { /* gone */ }
  }
  return out;
}
const branchAutoOf = (pid) => environOf(pid).find((x) => x.startsWith('ORCHESTRA_BRANCH_AUTO='))?.split('=')[1];
const modelReqs = () => fakeApi.requests.filter((r) => r.type === 'model');
const withMark = (m) => modelReqs().filter((r) => r.marks?.includes(m));

try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'app page target');
  clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-name').length > 0`), 60000, 'the sidebar rows');
  const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
  const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
  const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
  const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
  const onDisk = path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  clause('ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(onDisk)), `served ${path.basename(bundle)} md5 ${md5(served)} == ${onDisk}; package.json ${ver}`);
  clause('ctl/cli-bundle-has-the-flag', fs.readFileSync(CLI, 'utf8').includes('Nothing was created'), `${CLI} carries the refusal text`);
  const appEnv = environOf(app.pid);
  clause('ctl/scratch-env', appEnv.includes(`ORCHESTRA_HOME=${world.ohome}`) && !appEnv.some((e) => e.startsWith('DISPLAY=')), `app ORCHESTRA_HOME=${world.ohome}, no DISPLAY`);
  const st = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8'));
  const pinOk = st.accounts[0].id === st.workspaces[0].accountId && real(st.accounts[0].configDir).startsWith(real(world.ohome).replace(/oh$/, ''));
  clause('ctl/account-pin', pinOk && !LIVE.some((l) => real(st.accounts[0].configDir).startsWith(l)), `accountId ${st.workspaces[0].accountId} == account.id ${st.accounts[0].id}; configDir ${st.accounts[0].configDir} (scratch)`);

  // ── refusals, on the live socket ──
  const before = { ws: (await wsList()).length, branches: branches() };
  const shotPre = saveShot('01-sidebar-before-spawn.png', await cdp.shot());
  const preRows = await rowTexts();
  const refusals = [['no --name', ['spawn', '--task', 'x']], ['unknown rôle', ['spawn', '--name', 'fix-checkout-typo', '--task', 'x']], ['rôle without object', ['spawn', '--name', 'impl-', '--task', 'x']]];
  const CONV = '<rôle>-<objet en mots humains>[-<ticket>]';
  for (const [label, args] of refusals) {
    const r = orch(args);
    clause(`refuse/cli/${label}`, r.code === 1 && r.stderr.includes(CONV) && r.stderr.includes('Nothing was created') && r.stdout === '', `rc ${r.code}, stderr «${r.stderr.trim().slice(0, 150)}»`);
  }
  for (const [label, body] of [['old CLI: no name', { task: 'x', from: 'ws-ops' }], ['old CLI shape, unknown rôle', { task: 'x', from: 'ws-ops', name: 'fix-checkout-typo' }]]) {
    const r = await postHooks('/spawn', body);
    clause(`refuse/route/${label}`, r.ok === false && String(r.error).includes(CONV) && String(r.error).includes('Nothing was created') && !r.id, `reply ${JSON.stringify(r).slice(0, 200)}`);
  }
  const afterRefusals = { ws: (await wsList()).length, branches: branches() };
  clause('refuse/nothing-created', afterRefusals.ws === before.ws && JSON.stringify(afterRefusals.branches) === JSON.stringify(before.branches), `workspaces ${before.ws} -> ${afterRefusals.ws}; branches ${before.branches.join(',')} -> ${afterRefusals.branches.join(',')}`);

  // ── a named spawn ──
  const sp = orch(['spawn', '--name', 'impl-x-1', '--task', `${CHILD} — reply ok and stop.`]);
  const spM = /^Spawned (\S+) on branch (\S+)$/m.exec(sp.stdout);
  clause('named/cli-prints-final-branch', sp.code === 0 && spM && spM[2] === 'impl-x-1', `rc ${sp.code}, stdout «${sp.stdout.trim()}», stderr «${sp.stderr.trim().slice(0, 120)}»`);
  const childId = spM?.[1];
  await waitFor(async () => (await rowTexts()).includes('impl-x-1'), 20000, 'the sidebar row impl-x-1').catch(() => null);
  const rec = (await wsList()).find((w) => w.id === childId);
  clause('named/record', rec && rec.branch === 'impl-x-1' && rec.parentId === 'ws-ops' && rec.namedByParent === 'ws-ops' && rec.branchManuallySet === false && rec.name === `${path.basename(world.repo)} · impl-x-1`, JSON.stringify(rec));
  const wtChild = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === childId)?.worktreePath;
  clause('named/git-branch', branches().includes('impl-x-1') && gitIn(wtChild, ['rev-parse', '--abbrev-ref', 'HEAD'], world.fakeHome).trim() === 'impl-x-1', `repo branches ${branches().join(',')}; worktree HEAD ${gitIn(wtChild, ['rev-parse', '--abbrev-ref', 'HEAD'], world.fakeHome).trim()}`);
  const postRows = await rowTexts();
  const exact = postRows.filter((t) => t === 'impl-x-1');
  clause('named/sidebar-row-text-equals-name', preRows.filter((t) => t === 'impl-x-1').length === 0 && exact.length === 1, `rows before [${preRows.join(' | ')}] -> after [${postRows.join(' | ')}]`);
  const rowRect = await cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-name')].find((x) => x.textContent === 'impl-x-1'); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })()`);
  clause('named/sidebar-row-visible', rowRect && rowRect.w > 0 && rowRect.h > 0 && rowRect.inside, JSON.stringify(rowRect));
  await sleep(600);
  saveShot('02-sidebar-after-named-spawn.png', await cdp.shot());

  // collision + detached
  const sp2 = orch(['spawn', '--name', 'impl-x-1', '--task', 'collision — reply ok and stop.']);
  clause('named/collision-suffixed-final-branch-printed', sp2.code === 0 && /on branch impl-x-1-2$/m.test(sp2.stdout), `stdout «${sp2.stdout.trim()}»`);
  const sp3 = orch(['spawn', '--detached', '--name', 'explo-detached-y', '--task', 'detached — reply ok and stop.']);
  const id3 = /^Spawned (\S+) on branch (\S+)$/m.exec(sp3.stdout)?.[1];
  const rec3 = (await wsList()).find((w) => w.id === id3);
  clause('named/detached-keeps-the-namer', sp3.code === 0 && rec3 && rec3.branch === 'explo-detached-y' && rec3.parentId === null && rec3.namedByParent === 'ws-ops', JSON.stringify(rec3));

  // ── no rename instruction: first prompt ──
  await waitFor(() => withMark('child').length > 0, 90000, 'the child\'s first model request');
  const pidsChild = await waitFor(() => { const p = cliPids(childId); return p.length ? p : null; }, 30000, 'the child CLI process');
  const nudgeOnChild = modelReqs().filter((r) => r.marks?.includes('child') && (r.marks.includes('nudge') || r.marks.includes('refine') || r.marks.includes('autoBranch')));
  clause('nudge/child-first-prompt-no-instruction', withMark('child').length > 0 && nudgeOnChild.length === 0, `${withMark('child').length} request(s) carry the child's brief; ${nudgeOnChild.length} carry a rename instruction`);
  clause('nudge/child-env-branch-auto-0', pidsChild.every((p) => branchAutoOf(p) === '0'), `claude pid(s) ${pidsChild.join(',')} ORCHESTRA_BRANCH_AUTO=${pidsChild.map(branchAutoOf).join(',')}`);

  // CONTROL: a human-created workspace IS nudged (the instrument can say yes)
  const ctl = await cdp.eval(`window.orchestra.createWorkspace(${JSON.stringify({ repoPath: world.repo })}).then((x) => ({ id: x.id, branch: x.branch, namedByParent: x.namedByParent ?? null }))`);
  await cdp.eval(`window.orchestra.agentSdkSend(${JSON.stringify(ctl.id)}, ${JSON.stringify(`${CTL} — reply ok and stop.`)})`);
  await waitFor(() => withMark('ctl').length > 0, 90000, 'the control\'s first model request');
  const ctlNudged = withMark('ctl').filter((r) => r.marks.includes('nudge'));
  const pidsCtl = await waitFor(() => { const p = cliPids(ctl.id); return p.length ? p : null; }, 30000, 'the control CLI process');
  clause('nudge/control-human-created-IS-nudged', ctl.namedByParent === null && ctlNudged.length > 0 && pidsCtl.every((p) => branchAutoOf(p) === '1'), `control ${ctl.branch}: ${ctlNudged.length}/${withMark('ctl').length} request(s) carry « Rename it NOW »; BRANCH_AUTO=${pidsCtl.map(branchAutoOf).join(',')}`);

  // second prompt (UserPromptSubmit again)
  await cdp.eval(`window.orchestra.agentSdkSend(${JSON.stringify(childId)}, ${JSON.stringify(`${CHILD2} — second prompt, reply ok and stop.`)})`);
  await waitFor(() => withMark('child2').length > 0, 90000, 'the child\'s second-prompt request');
  const nudge2 = withMark('child2').filter((r) => r.marks.includes('nudge') || r.marks.includes('refine') || r.marks.includes('autoBranch'));
  clause('nudge/child-second-prompt-no-instruction', nudge2.length === 0, `${withMark('child2').length} request(s) carry the second prompt; ${nudge2.length} carry a rename instruction`);
  const ctl2 = await cdp.eval(`window.orchestra.agentSdkSend(${JSON.stringify(ctl.id)}, 'control second prompt')`).then(() => true).catch(() => false);
  void ctl2;

  // ── promote keeps the name (story 14), and a restarted session is still not nudged ──
  const pr = orch(['promote', childId]);
  await sleep(1500);
  const afterPromote = (await wsList()).find((w) => w.id === childId);
  clause('promote/keeps-the-name', pr.code === 0 && afterPromote.branch === 'impl-x-1' && afterPromote.canOrchestrate === true && afterPromote.namedByParent === 'ws-ops' && (await rowTexts()).includes('impl-x-1'), `promote rc ${pr.code} «${pr.stdout.trim().slice(0, 100)}»; record ${JSON.stringify(afterPromote)}`);
  const oldPids = cliPids(childId);
  const rs = orch(['restart', childId]);
  const newPids = await waitFor(() => { const p = cliPids(childId); return p.length && !p.some((x) => oldPids.includes(x)) ? p : null; }, 60000, 'a new child CLI process after restart').catch(() => null);
  clause('promote/restarted-session-still-branch-auto-0', !!newPids && newPids.every((p) => branchAutoOf(p) === '0'), `restart rc ${rs.code} «${rs.stdout.trim().slice(0, 100)}»; old pids ${oldPids.join(',')} -> new ${newPids?.join(',')} BRANCH_AUTO=${newPids?.map(branchAutoOf).join(',')}`);
  await cdp.eval(`window.orchestra.agentSdkSend(${JSON.stringify(childId)}, ${JSON.stringify(`${CHILD3} — third prompt after promote + restart, reply ok and stop.`)})`);
  await waitFor(() => withMark('child3').length > 0, 90000, 'the child\'s third-prompt request');
  const nudge3 = withMark('child3').filter((r) => r.marks.includes('nudge') || r.marks.includes('refine') || r.marks.includes('autoBranch'));
  clause('promote/after-restart-no-instruction', nudge3.length === 0, `${withMark('child3').length} request(s) after promote+restart carry the brief; ${nudge3.length} carry a rename instruction`);
  await sleep(600);
  saveShot('03-sidebar-after-promote.png', await cdp.shot());

  // ── no live contact (G8) ──
  const liveAfter = liveFingerprint();
  clause('ctl/live-config-untouched', JSON.stringify(liveAfter) === JSON.stringify(liveBefore), `${Object.keys(liveBefore).length} fingerprinted entries (CLAUDE.md/settings.json/LESSONS.md/.claude.json md5, skills + top-level listing of each ~/.claude*) identical before/after`);
  const dupes = shots.map((s) => s.md5).filter((m, i, a) => a.indexOf(m) !== i);
  clause('ctl/screenshots-distinct', dupes.length === 0, shots.map((s) => `${path.basename(s.file)}=${s.md5}`).join('  '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} clauses PASS${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(`DRIVE ERROR: ${e.stack ?? e}`);
  try { if (cdp) saveShot('99-error-state.png', await cdp.shot()); } catch { /* */ }
} finally {
  try { cdp?.close(); } catch { /* */ }
  // kill by resolved identity: every process whose environ names THIS rig's ORCHESTRA_HOME (app, keepers, claude CLIs), then the app group
  const mine = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (+p !== process.pid && environOf(p).includes(`ORCHESTRA_HOME=${world.ohome}`)) mine.push(+p); } catch { /* */ } }
  for (const p of mine) { try { process.kill(p, 'SIGTERM'); } catch { /* */ } }
  await sleep(1500);
  for (const p of mine) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  const left = mine.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  console.log(`teardown: killed ${mine.length} rig process(es) by identity, ${left.length} left; fake API requests seen ${fakeApi.requests.length}`);
  try { await fakeApi.close?.(); } catch { /* */ }
  fs.writeFileSync(path.join(world.d, 'result.json'), JSON.stringify({ results, shots }, null, 2));
}
process.exit(exitCode);
