// #401 — `orchestra spawn --profile` end to end on a BUILT Orchestra in the contained rig's own headless sway. The REAL claude CLI (structured
// session) runs against a LOCAL FAKE Anthropic API — zero tokens. The fixture site (#395: scripts/fixtures/browser-site) is the "website":
// /signin sets a random `sid` cookie, pages/spawn-profile.html shows it in the TITLE (`who:<sid>` | `who:anon`) and on screen.
//   a0  the parent (ws-ops, holds profile "Staging admin") signs in through ITS panel; the instrument can say "signed in" (same partition, 2nd read)
//   a1  `spawn --profile "Staging admin"` as ws-ops (+ its session key) → record carries the profile, the worker's panel shows the parent's sid
//   a2  `spawn --profile Prod` (a profile ws-ops does NOT hold) → worker still created, warning on stderr, NO profile on the record, panel anon
//   a3  `spawn` without --profile → ephemeral (anon)
//   a4  ws-bare (holds nothing) passes "Staging admin" → refused, anon; `--detached` (no parent) → refused, record without profile
//   a5  identity: ws-ops WITHOUT its key, and ws-ops claimed with ws-bare's key → refused (the host cannot vouch), anon; a body claiming a holding is ignored
//   a6  a HOSTILE /spawn body (asks for Prod, which ws-ops does not hold; names ws-bare's id and `holds`/`browserProfileId` fields) creates a NEW workspace WITHOUT the profile;
//       ws-bare's record is unchanged and nobody holds Prod. (That no CLI verb / route / IPC attaches a profile is pinned at source: spawn-profile-wiring.test.ts + #400's browser-profiles-wiring.test.ts;
//       the guessed-verb check below only proves those three names do not exist.)
//   a7  the REAL session key: ws-ops' own session is started (a fresh start registers its key, superseding the seeded one), the key is read from its claude CLI's environ,
//       `spawn --profile` with it is honoured; the seeded (now superseded) key is refused
// Usage: scripts/e2e-spawn-profile.sh <app-dir> [--arms a1,a2,…] [--out <dir>]   (build first: pnpm run build:bundles && pnpm run build:bus-abi)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { startFakeApi } from './session-budget/fake-anthropic-api.mjs';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : refuse('no <app-dir>');
const LIVE_HOME = flag('--live-home', null) ?? refuse('--live-home missing');
const ARMS = new Set(flag('--arms', 'a0,a1,a2,a3,a4,a5,a6,a7').split(','));
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('run via scripts/e2e-spawn-profile.sh (the contained rig)');
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
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const gitIn = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const environOf = (pid) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  close() { try { this.ws.close(); } catch {} }
}
const results = [], shots = [];
function clause(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function grim(name) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: RIG_WAYLAND, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } }); const b = fs.readFileSync(f); shots.push({ file: f, md5: md5(b) }); console.log(`  shot ${f} md5 ${md5(b)}`); return f; }

// ── live-config fingerprint (structure, not content — siblings rewrite contents all day) ──
function liveFingerprint() {
  const verdict = {};
  for (const d of LIVE.filter((l) => path.basename(l).startsWith('.claude'))) {
    const n = path.basename(d);
    for (const f of ['CLAUDE.md', 'settings.json', 'LESSONS.md']) { try { const st = fs.lstatSync(path.join(d, f)); verdict[`${n}/${f}`] = st.isSymbolicLink() ? `symlink -> ${fs.readlinkSync(path.join(d, f))}` : 'file'; } catch { verdict[`${n}/${f}`] = 'absent'; } }
    try { const sk = path.join(d, 'skills'); verdict[`${n}/skills`] = `${fs.lstatSync(sk).isSymbolicLink() ? 'symlink' : 'dir'}: ${fs.readdirSync(sk).sort().join(',')}`; } catch { verdict[`${n}/skills`] = 'absent'; }
  }
  return verdict;
}
const liveBefore = liveFingerprint();

// ── world ──
const P = { id: 'bp-0123456789ab', name: 'Staging admin', createdAt: 1 }, Q = { id: 'bp-fedcba987654', name: 'Prod', createdAt: 2 };
const KEY_OPS = crypto.randomBytes(16).toString('hex'), KEY_BARE = crypto.randomBytes(16).toString('hex');
const fakeApi = await startFakeApi({ markers: {}, reply: () => ({ text: 'ok' }) });
const world = (() => {
  const d = path.join(RIG_DIR, 'world');
  const fakeHome = path.join(d, 'home'), ohome = path.join(d, 'oh'), cfg = path.join(d, 'cfg'), repo = path.join(d, 'repo-prof');
  for (const x of [fakeHome, ohome, cfg, repo]) { fs.mkdirSync(x, { recursive: true }); mustBeScratch('seed', x); }
  gitIn(repo, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo, 'README.md'), '#\n'); gitIn(repo, ['add', '.'], fakeHome); gitIn(repo, ['commit', '-q', '-m', 'seed'], fakeHome);
  const wtOps = path.join(d, 'wt-ops'), wtBare = path.join(d, 'wt-bare');
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'ops-rig-parent', wtOps], fakeHome);
  gitIn(repo, ['worktree', 'add', '-q', '-b', 'ops-rig-bare', wtBare], fakeHome);
  const fakeEnv = { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}', ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}' };
  const accounts = [{ id: 'acc-rig', label: 'rig', configDir: cfg, env: fakeEnv }];
  const base = { baseBranch: 'main', createdAt: Date.now(), agent: 'claude', status: 'idle', accountId: 'acc-rig', canOrchestrate: true, branchManuallySet: true, repoPath: repo };
  const workspaces = [
    { ...base, id: 'ws-ops', name: `${path.basename(repo)} · ops-rig-parent`, worktreePath: wtOps, branch: 'ops-rig-parent', browserProfileId: P.id },
    { ...base, id: 'ws-bare', name: `${path.basename(repo)} · ops-rig-bare`, worktreePath: wtBare, branch: 'ops-rig-bare' },
  ];
  return { d, fakeHome, ohome, cfg, repo, accounts, workspaces, repos: [{ path: repo, name: 'rig-repo', defaultBranch: 'main', accountId: 'acc-rig' }] };
})();
const storeDir = path.join(world.ohome, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
const readStore = () => JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8'));
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: world.repos, workspaces: world.workspaces, accounts: world.accounts, selfTuneRuns: [], browserProfiles: [P, Q] }, null, 2));
// the host's registry file (hashes only) — what a fresh session start would have registered for each seeded workspace
fs.writeFileSync(path.join(world.ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: { 'ws-ops': { hash: sha256(KEY_OPS), issuedAt: Date.now() }, 'ws-bare': { hash: sha256(KEY_BARE), issuedAt: Date.now() } } }), { mode: 0o600 });
const stubDir = path.join(world.d, 'bin'); fs.mkdirSync(stubDir, { recursive: true });
fs.symlinkSync(fs.realpathSync(path.join(LIVE_HOME, '.local/bin/claude')), path.join(stubDir, 'claude'));
const cdpPort = await freePort();
// incident Q2 (ledger #405): the app runs in the contained rig's PRIVATE runtime world — privateRuntimeDir() REFUSES anything but `<rig dir>/xdg` (never the human's runtime dir); the session bus is the rig's pinned, nonexistent one
const XDG = privateRuntimeDir();
if (!process.env.DBUS_SESSION_BUS_ADDRESS || !process.env.DBUS_SESSION_BUS_ADDRESS.startsWith(`unix:path=${RIG_DIR}/`)) refuse(`DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS} is not the rig's pinned nonexistent bus`);
const env = { PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(cdpPort), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
  ANTHROPIC_BASE_URL: fakeApi.url, ANTHROPIC_API_KEY: 'sk-ant-fake-rig-key', HTTPS_PROXY: fakeApi.proxyUrl, HTTP_PROXY: fakeApi.proxyUrl, NO_PROXY: '127.0.0.1,localhost' };
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);

// the fixture site, from THE TREE UNDER TEST
const fx = spawn(process.execPath, [path.join(APP_DIR, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
const FX = await new Promise((res, rej) => { let buf = ''; fx.stdout.on('data', (c) => { buf += c; const m = /LISTENING (\d+)/.exec(buf); if (m) res(`http://127.0.0.1:${m[1]}`); }); setTimeout(() => rej(new Error('fixture site did not start')), 10000); });

const logFile = path.join(world.d, 'app.log'); const fd = fs.openSync(logFile, 'w');
const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
console.log(`app pid ${app.pid}, cdp ${cdpPort}, fixture ${FX}, log ${logFile}`);

const CLI = path.join(APP_DIR, 'dist-electron', 'cli.js');
let cdp, exitCode = 1;
/** Run the BUILT cli.js as `wsId` (+ its session key) against the rig's app socket. */
function orch(args, wsId, key) {
  const sock = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 90000, env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ORCHESTRA_SOCK: sock, ...(wsId ? { ORCHESTRA_WS_ID: wsId } : {}), ...(key ? { ORCHESTRA_SESSION_KEY: key } : {}) } });
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
const wsRec = async (id) => cdp.eval(`window.orchestra.listWorkspaces().then((l) => { const w = l.find((x) => x.id === ${JSON.stringify(id)}); return w ? { id: w.id, branch: w.branch, parentId: w.parentId ?? null, browserProfileId: w.browserProfileId ?? null } : null; })`);
const spawnedId = (r) => /^Spawned (\S+) on branch (\S+)$/m.exec(r.stdout)?.[1];

/** Select the workspace's row, make sure its browser pane is open, navigate its panel through the app's own IPC, return the page TITLE (who:<sid>|who:anon). */
async function panelWho(wsId, branch, tag) {
  const rowPos = await waitFor(() => cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-name')].find((x) => x.textContent.includes(${JSON.stringify(branch)})); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`), 30000, `the sidebar row ${branch}`);
  await cdp.click(rowPos.x, rowPos.y);
  await waitFor(() => cdp.eval(`!!document.querySelector('[aria-label="Show browser pane"], [aria-label="Hide browser pane"]')`), 30000, 'the browser pane toggle');
  if (!(await cdp.eval(`!!document.querySelector('.browser-url-input')`))) {
    const tb = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Show browser pane"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(tb.x, tb.y);
    await waitFor(() => cdp.eval(`!!document.querySelector('.browser-url-input')`), 20000, 'the browser pane');
  }
  await sleep(500);
  const url = `${FX}/spawn-profile.html?w=${tag}`;
  await cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(wsId)}, ${JSON.stringify(url)})`);
  const st = await waitFor(async () => { const s = await cdp.eval(`window.orchestra.browserState(${JSON.stringify(wsId)})`); return s.url === url && !s.loading && /^who:/.test(s.title) ? s : null; }, 30000, `${branch}'s panel at ${url}`);
  await sleep(700);
  return { who: st.title.slice(4), state: st };
}

try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'app page target');
  clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-name').length >= 2`), 60000, 'the sidebar rows');
  const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
  const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
  const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
  const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
  const onDisk = path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
  clause('ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(onDisk)), `served ${path.basename(bundle)} md5 ${md5(served)} == ${onDisk}`);
  clause('ctl/cli-bundle-has-the-flag', /["']--profile["']/.test(fs.readFileSync(CLI, 'utf8')), `${CLI} parses --profile`);
  // What the DRIVER handed the app — Chromium rewrites the main process's environ once DBUS_SESSION_BUS_ADDRESS is set, so /proc/<pid>/environ goes blind (#400 measured the same).
  clause('ctl/scratch-env', env.ORCHESTRA_HOME === world.ohome && env.CLAUDE_CONFIG_DIR === world.cfg && env.HOME === world.fakeHome && !('DISPLAY' in env) && env.WAYLAND_DISPLAY === RIG_WAYLAND, `handed env: ORCHESTRA_HOME=${env.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} DISPLAY=${'DISPLAY' in env ? env.DISPLAY : '<unset>'}`);
  clause('ctl/private-runtime-world', env.XDG_RUNTIME_DIR === XDG && XDG === `${RIG_DIR}/xdg` && env.DBUS_SESSION_BUS_ADDRESS.startsWith(`unix:path=${RIG_DIR}/`) && !fs.existsSync(env.DBUS_SESSION_BUS_ADDRESS.replace('unix:path=', '')), `handed env: XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR} DBUS_SESSION_BUS_ADDRESS=${env.DBUS_SESSION_BUS_ADDRESS} (the socket path does not exist)`);
  clause('ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} present in my sway's get_tree`);
  const st0 = readStore();
  clause('ctl/account-pin', st0.accounts[0].id === st0.workspaces[0].accountId && !LIVE.some((l) => real(st0.accounts[0].configDir).startsWith(l)), `accountId ${st0.workspaces[0].accountId} == account.id ${st0.accounts[0].id}; configDir ${st0.accounts[0].configDir} (scratch)`);
  const opsRec0 = await wsRec('ws-ops');
  clause('ctl/seed', opsRec0.browserProfileId === P.id, `ws-ops record ${JSON.stringify(opsRec0)}; profiles [${P.name}, ${Q.name}]; keys registered by hash only`);
  const bareBefore = JSON.stringify(await wsRec('ws-bare'));

  // ── a0: the parent signs in through its own panel ──
  let sidOps = null;
  {
    const parent0 = await panelWho('ws-ops', 'ops-rig-parent', 'ops-before');
    clause('a0/parent-starts-signed-out', parent0.who === 'anon', `ws-ops panel title who:${parent0.who} (profile attached, nothing signed in yet)`);
    const signin = `${FX}/signin`;
    await cdp.eval(`window.orchestra.browserNavigate('ws-ops', ${JSON.stringify(signin)})`);
    await waitFor(async () => { const s = await cdp.eval(`window.orchestra.browserState('ws-ops')`); return s.url === signin && !s.loading ? s : null; }, 20000, '/signin loaded');
    const parent1 = await panelWho('ws-ops', 'ops-rig-parent', 'ops-after');
    sidOps = parent1.who;
    const parent2 = await panelWho('ws-ops', 'ops-rig-parent', 'ops-again');
    clause('a0/parent-signed-in-instrument-says-yes', /^[0-9a-f]{16}$/.test(sidOps) && parent2.who === sidOps, `ws-ops panel who:${sidOps}; a second read in the same panel who:${parent2.who} (the profile partition holds the cookie)`);
    grim('01-parent-signed-in.png');
  }

  const kids = {};
  // ── a1: honoured ──
  if (ARMS.has('a1')) {
    const r = orch(['spawn', '--name', 'impl-prof-honoured', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-ops', KEY_OPS);
    const id = spawnedId(r); kids.honoured = id;
    clause('a1/cli-says-passed', r.code === 0 && !!id && r.stdout.includes(`Profile “${P.name}” passed`) && r.stderr === '', `rc ${r.code}; stdout «${r.stdout.trim()}»; stderr «${r.stderr.trim()}»`);
    const rec = await wsRec(id);
    const onDiskRec = readStore().workspaces.find((w) => w.id === id);
    clause('a1/record-carries-the-profile', rec?.browserProfileId === P.id && onDiskRec?.browserProfileId === P.id && rec.parentId === 'ws-ops', `live ${JSON.stringify(rec)}; store.json browserProfileId ${onDiskRec?.browserProfileId}`);
    const w = await panelWho(id, 'impl-prof-honoured', 'honoured');
    clause('a1/worker-panel-is-signed-in-as-the-parent', w.who === sidOps, `worker panel who:${w.who} == parent sid ${sidOps}; panel profileId ${w.state.profileId ?? '(none)'}`);
    grim('02-worker-honoured.png');
  }
  // ── a2: a profile the parent does not hold ──
  if (ARMS.has('a2')) {
    const r = orch(['spawn', '--name', 'impl-prof-refused', '--task', 'reply ok and stop.', '--profile', Q.name], 'ws-ops', KEY_OPS);
    const id = spawnedId(r); kids.refused = id;
    clause('a2/refused-worker-still-created-with-a-warning', r.code === 0 && !!id && /^warning: --profile not applied: you hold “Staging admin”/.test(r.stderr) && r.stderr.includes('navigation éphémère'), `rc ${r.code}; stdout «${r.stdout.trim()}»; stderr «${r.stderr.trim()}»`);
    clause('a2/message-does-not-name-the-unheld-profile', !r.stderr.includes(Q.id) && !r.stdout.includes(Q.id), `stderr «${r.stderr.trim()}» (the requested NAME is echoed; the unheld profile's id never is)`);
    const rec = await wsRec(id);
    clause('a2/record-has-no-profile', rec && rec.browserProfileId === null && !('browserProfileId' in (readStore().workspaces.find((w) => w.id === id) ?? {})), `live ${JSON.stringify(rec)}`);
    const w = await panelWho(id, 'impl-prof-refused', 'refused');
    clause('a2/refused-worker-panel-is-ephemeral', w.who === 'anon', `worker panel who:${w.who} (parent sid ${sidOps})`);
    grim('03-worker-refused.png');
  }
  // ── a3: no flag ──
  if (ARMS.has('a3')) {
    const r = orch(['spawn', '--name', 'impl-prof-plain', '--task', 'reply ok and stop.'], 'ws-ops', KEY_OPS);
    const id = spawnedId(r); kids.plain = id;
    const rec = await wsRec(id);
    const w = await panelWho(id, 'impl-prof-plain', 'plain');
    clause('a3/no-flag-is-ephemeral', r.code === 0 && rec?.browserProfileId === null && w.who === 'anon' && r.stderr === '', `rc ${r.code}; record ${JSON.stringify(rec)}; panel who:${w.who}; stderr «${r.stderr.trim()}»`);
  }
  // ── a4: a caller that holds nothing ──
  if (ARMS.has('a4')) {
    const r = orch(['spawn', '--name', 'impl-prof-bare', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-bare', KEY_BARE);
    const id = spawnedId(r); kids.bare = id;
    const rec = await wsRec(id);
    const w = await panelWho(id, 'impl-prof-bare', 'bare');
    clause('a4/caller-holding-nothing-is-refused', r.code === 0 && /you hold no profil navigateur/.test(r.stderr) && rec?.browserProfileId === null && w.who === 'anon', `rc ${r.code}; stderr «${r.stderr.trim()}»; record ${JSON.stringify(rec)}; panel who:${w.who}`);
    const det = orch(['spawn', '--detached', '--name', 'impl-prof-detached', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-ops', KEY_OPS);
    kids.detached = spawnedId(det);
    const detRec = await wsRec(kids.detached);
    clause('a4/detached-worker-gets-no-profile', det.code === 0 && /a --detached worker has no parent/.test(det.stderr) && detRec?.browserProfileId === null && detRec?.parentId === null, `rc ${det.code}; stderr «${det.stderr.trim()}»; record ${JSON.stringify(detRec)}`);
  }
  // ── a5: identity ──
  if (ARMS.has('a5')) {
    const noKey = orch(['spawn', '--name', 'impl-prof-nokey', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-ops', null);
    kids.nokey = spawnedId(noKey);
    const wrongKey = orch(['spawn', '--name', 'impl-prof-forged', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-ops', KEY_BARE);
    kids.forged = spawnedId(wrongKey);
    const recs = [await wsRec(kids.nokey), await wsRec(kids.forged)];
    const wA = await panelWho(kids.nokey, 'impl-prof-nokey', 'nokey');
    const wB = await panelWho(kids.forged, 'impl-prof-forged', 'forged');
    const cond = (r, rec, w) => r.code === 0 && /could not vouch/.test(r.stderr) && rec?.browserProfileId === null && w.who === 'anon';
    clause('a5/no-session-key-is-refused', cond(noKey, recs[0], wA), `rc ${noKey.code}; stderr «${noKey.stderr.trim()}»; record ${JSON.stringify(recs[0])}; panel who:${wA.who}`);
    clause('a5/another-sessions-key-is-refused', cond(wrongKey, recs[1], wB), `rc ${wrongKey.code}; stderr «${wrongKey.stderr.trim()}»; record ${JSON.stringify(recs[1])}; panel who:${wB.who}`);
    // raw socket, an old/hostile client: the route takes only a REQUEST — a body that names a holding is ignored
    const raw = await postHooks('/spawn', { task: 'reply ok and stop.', name: 'impl-prof-raw', from: 'ws-bare', profile: P.id, key: KEY_BARE, holds: P.id, browserProfileId: P.id });
    kids.raw = raw.id;
    const rawRec = raw.id ? await wsRec(raw.id) : null;
    clause('a5/a-body-claiming-a-holding-is-ignored', raw.ok === true && raw.profile?.applied === false && rawRec?.browserProfileId === null, `reply ${JSON.stringify(raw).slice(0, 260)}; record ${JSON.stringify(rawRec)}`);
  }
  // ── a6: a hostile body cannot pick another workspace or another profile ──
  if (ARMS.has('a6')) {
    // ws-ops holds Staging; the body asks for PROD (not held) and, beside it, names ws-bare and a profile in other fields
    const hostile = await postHooks('/spawn', { task: 'reply ok and stop.', name: 'impl-prof-hostile', from: 'ws-ops', key: KEY_OPS, profile: Q.id, id: 'ws-bare', workspaceId: 'ws-bare', target: 'ws-bare', holds: Q.id, browserProfileId: Q.id });
    kids.hostile = hostile.id;
    const hRec = hostile.id ? await wsRec(hostile.id) : null;
    const onDisk = readStore().workspaces;
    clause('a6/hostile-body-creates-a-new-workspace-without-the-unheld-profile', hostile.ok === true && hostile.id !== 'ws-bare' && hostile.profile?.applied === false && hRec?.browserProfileId === null && onDisk.filter((w) => w.browserProfileId === Q.id).length === 0, `reply ${JSON.stringify(hostile).slice(0, 220)}; new record ${JSON.stringify(hRec)}; workspaces holding Prod on disk: ${onDisk.filter((w) => w.browserProfileId === Q.id).length}`);
    const bareAfter = JSON.stringify(await wsRec('ws-bare'));
    clause('a6/existing-workspace-record-unchanged', bareAfter === bareBefore && onDisk.find((w) => w.id === 'ws-bare').browserProfileId === undefined, `ws-bare before ${bareBefore} / after ${bareAfter}`);
    const verbs = ['attach-profile', 'profile', 'browser-profile'].map((v) => orch([v, 'ws-bare', P.id], 'ws-ops', KEY_OPS));
    clause('a6/guessed-cli-verbs-do-not-exist', verbs.every((v) => v.code !== 0 && /unknown command/.test(v.stderr)), verbs.map((v) => `rc ${v.code} «${v.stderr.trim().split('\n')[0].slice(0, 70)}»`).join(' | '));
    const holders = onDisk.filter((w) => w.browserProfileId).map((w) => w.id).sort();
    const expected = ['ws-ops', ...[kids.honoured].filter(Boolean)].sort();
    clause('a6/only-ws-ops-and-its-honoured-worker-hold-the-profile', JSON.stringify(holders) === JSON.stringify(expected), `workspaces with a profile on disk: [${holders.join(', ')}] expected [${expected.join(', ')}]`);
  }
  // ── a7: the REAL session key (registered by a fresh session start), and a superseded one ──
  if (ARMS.has('a7')) {
    const keyPid = () => {
      for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
        try {
          if (fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1][0] === 'Z') continue;
          const e = environOf(p);
          if (e.includes('ORCHESTRA_WS_ID=ws-ops') && e.includes(`ORCHESTRA_HOME=${world.ohome}`) && e.some((x) => x.startsWith('ORCHESTRA_SESSION_KEY=')) && fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('claude')) return +p;
        } catch { /* gone */ }
      }
      return null;
    };
    await cdp.eval(`window.orchestra.agentSdkSend('ws-ops', 'reply ok and stop.')`);
    const pid = await waitFor(() => keyPid(), 90000, "ws-ops' real claude CLI carrying ORCHESTRA_SESSION_KEY");
    const realKey = environOf(pid).find((x) => x.startsWith('ORCHESTRA_SESSION_KEY=')).split('=')[1];
    const reg = JSON.parse(fs.readFileSync(path.join(world.ohome, 'session-keys.json'), 'utf8')).sessions['ws-ops'];
    clause('a7/a-fresh-session-registers-its-own-key', !!realKey && realKey !== KEY_OPS && reg.hash === sha256(realKey) && reg.hash !== sha256(KEY_OPS), `claude pid ${pid} carries a key (not the seeded one); session-keys.json ws-ops hash == sha256(that key): ${reg.hash === sha256(realKey)}; the file holds hashes only`);
    const good = orch(['spawn', '--name', 'impl-prof-realkey', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-ops', realKey);
    kids.real = spawnedId(good);
    const gRec = await wsRec(kids.real);
    clause('a7/real-session-key-passes-the-profile', good.code === 0 && gRec?.browserProfileId === P.id && good.stdout.includes('passed') && good.stderr === '', `rc ${good.code}; stdout «${good.stdout.trim().split('\n').pop()}»; stderr «${good.stderr.trim()}»; record ${JSON.stringify(gRec)}`);
    const stale = orch(['spawn', '--name', 'impl-prof-superseded', '--task', 'reply ok and stop.', '--profile', P.name], 'ws-ops', KEY_OPS);
    kids.stale = spawnedId(stale);
    const sRec = await wsRec(kids.stale);
    clause('a7/superseded-session-key-is-refused', stale.code === 0 && /could not vouch/.test(stale.stderr) && sRec?.browserProfileId === null, `rc ${stale.code}; stderr «${stale.stderr.trim()}»; record ${JSON.stringify(sRec)}`);
  }

  // ── no live contact ──
  const liveAfter = liveFingerprint();
  const diffKeys = Object.keys({ ...liveBefore, ...liveAfter }).filter((k) => liveBefore[k] !== liveAfter[k]);
  clause('ctl/live-config-untouched', diffKeys.length === 0, `${Object.keys(liveBefore).length} structural entries of each ~/.claude* ${diffKeys.length ? `CHANGED: ${diffKeys.join(', ')}` : 'identical before/after'}`);
  const dupes = shots.map((s) => s.md5).filter((m, i, a) => a.indexOf(m) !== i);
  clause('ctl/screenshots-distinct', dupes.length === 0, shots.map((s) => `${path.basename(s.file)}=${s.md5}`).join('  '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} clauses PASS${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(`DRIVE ERROR: ${e.stack ?? e}`);
  try { if (cdp) grim('99-error-state.png'); } catch { /* */ }
} finally {
  try { cdp?.close(); } catch { /* */ }
  try { fx.kill('SIGTERM'); } catch { /* */ }
  // kill by resolved identity: every process whose environ names THIS rig's ORCHESTRA_HOME (app, keepers, claude CLIs)
  const mine = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    if (+p === process.pid) continue;
    try { if (environOf(p).includes(`ORCHESTRA_HOME=${world.ohome}`)) { mine.push(+p); continue; } } catch { /* */ }
    // Electron helpers re-exec with a clean environ: identify them by this world's --user-data-dir instead
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(`--user-data-dir=${path.join(world.ohome, 'userData')}`)) mine.push(+p); } catch { /* */ }
  }
  for (const p of mine) { try { process.kill(p, 'SIGTERM'); } catch { /* */ } }
  await sleep(1500);
  for (const p of mine) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  const left = mine.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  console.log(`teardown: killed ${mine.length} rig process(es) by identity, ${left.length} left; fake API requests seen ${fakeApi.requests.length}`);
  try { await fakeApi.close?.(); } catch { /* */ }
  fs.writeFileSync(path.join(world.d, 'result.json'), JSON.stringify({ results, shots }, null, 2));
}
process.exit(exitCode);
