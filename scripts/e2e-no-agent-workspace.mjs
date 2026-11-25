// #612 (spec #601, spike #602) — the NO-AGENT workspace end to end on a BUILT Orchestra inside the contained rig's own headless sway.
// The command of a no-agent workspace (scripts/no-agent-loop.mjs: stands in for `orchestra fanout run`) owns a run; the REAL claude CLI + a LOCAL FAKE Anthropic API
// are the instrument for "0 agent turns" (a `model` request = a turn) and a CONTROL agent proves the instrument can see one.
//   ctl/*      app identity (url + served bundle md5 + version), scratch env, account pin, no live contact
//   spawn/*    `spawn --no-agent` refusals create nothing; the accepted spawn: record, detached session leader, no agent process
//   c1/*       identity: the command is vouched by /identity as its run's coordinator; forged id / key / unknown id refused; CONTROL: a Run-script PTY has no identity
//   c2/*       no agent: mail never wakes one (0 turns over a window incl. the 60 s sweep), restart refused, the command reads the lot; CONTROL: a normal agent IS woken
//   c5/*       Pause: deliver / open / gate refuse `run-paused` (rc 2, the text of a refused spawn); before the pause and after the resume they do not
//   caller/*   state set --status merged / open / gate / check by a vouched non-owner refused; env-only owner id refused (fail closed); the owner passes
//   c3/*       app SIGTERM and SIGKILL: the command survives, vouched again ≤ 5 s after the host listens; mail sent while the app was down is read; CONTROL: the PTY child dies
//   display/*  a host with no display: clear refusal (CLI preflight) — and NOT a false refusal when the app answers
//   soak/*     (--soak <s>) one lot every 30 s for <s> seconds with an app quit + reopen in the middle: every lot read, none lost
// Usage: scripts/e2e-no-agent-workspace.sh <app-dir> [--soak <seconds>] [--out <dir>]
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
const SOAK_SEC = Number(flag('--soak', 0));
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('run via scripts/e2e-no-agent-workspace.sh (the contained rig)');
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
async function waitFor(fn, ms, what, step = 250) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const environOf = (pid) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
const ticksOf = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.slice(s.lastIndexOf(')') + 2).split(' '); return r[0] === 'Z' ? null : Number(r[19]); } catch { return null; } };
const alive = (pid) => ticksOf(pid) !== null;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch { /* */ } }
}

const results = [], shots = [];
function clause(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); console.log(`  shot ${f} md5 ${md5(buf)}`); return f; }

// ── world: a repo, three NORMAL workspaces (lead, sender, normal = the control agent), scratch account on the fake API ──
const fakeApi = await startFakeApi({ markers: {}, reply: () => ({ text: 'ok' }) });
const world = (() => {
  const d = path.join(RIG_DIR, 'world');
  const fakeHome = path.join(d, 'home'), ohome = path.join(d, 'oh'), cfg = path.join(d, 'cfg'), repo = path.join(d, 'repo');
  for (const x of [fakeHome, ohome, cfg, repo]) { fs.mkdirSync(x, { recursive: true }); mustBeScratch('seed', x); }
  gitIn(repo, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo, 'README.md'), '#\n'); gitIn(repo, ['add', '.'], fakeHome); gitIn(repo, ['commit', '-q', '-m', 'seed'], fakeHome);
  const fakeEnv = { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}', ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}' };
  const accounts = [{ id: 'acc-rig', label: 'rig', configDir: cfg, env: fakeEnv }];
  const base = { baseBranch: 'main', createdAt: Date.now(), agent: 'claude', status: 'idle', accountId: 'acc-rig', branchManuallySet: true };
  const mk = (tag, extra = {}) => { const wt = path.join(d, 'wt', tag); fs.mkdirSync(path.dirname(wt), { recursive: true }); gitIn(repo, ['worktree', 'add', '-q', '-b', tag, wt], fakeHome); return { ...base, id: `ws-${tag}`, name: `rig · ${tag}`, repoPath: repo, worktreePath: wt, branch: tag, ...extra }; };
  const workspaces = [mk('lead', { ownsRun: true }), mk('sender'), mk('normal', { parentId: 'ws-lead', lastTask: 'CONTROL-AGENT idle' })];
  const runScript = 'env > "$ORCHESTRA_HOME/runenv-$ORCHESTRA_BRANCH.txt"; echo $$ > "$ORCHESTRA_HOME/runpid-$ORCHESTRA_BRANCH.txt"; exec sleep 3000';
  return { d, fakeHome, ohome, cfg, repo, accounts, workspaces, repos: [{ path: repo, name: 'rig-repo', defaultBranch: 'main', accountId: 'acc-rig', scripts: { run: runScript } }] };
})();
const storeDir = path.join(world.ohome, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: world.repos, workspaces: world.workspaces, accounts: world.accounts, selfTuneRuns: [], busSwitches: { wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true, pause: true, dockerRelay: false, memoryCap: false } }, null, 2)); // the wake mechanism must be ON or the control agent is only "counted, not fired"
const stubDir = path.join(world.d, 'bin'); fs.mkdirSync(stubDir, { recursive: true });
fs.symlinkSync(fs.realpathSync(path.join(LIVE_HOME, '.local/bin/claude')), path.join(stubDir, 'claude'));
const CLI = path.join(APP_DIR, 'dist-electron', 'cli.js');
const LOOP = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'no-agent-loop.mjs');
const baseEnv = (port) => ({ PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
  ANTHROPIC_BASE_URL: fakeApi.url, ANTHROPIC_API_KEY: 'sk-ant-fake-rig-key', HTTPS_PROXY: fakeApi.proxyUrl, HTTP_PROXY: fakeApi.proxyUrl, NO_PROXY: '127.0.0.1,localhost' });
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, baseEnv(0)[k]);
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);

let app = null, cdp = null, cdpPort = 0, exitCode = 1, launches = 0;
async function launchApp() {
  cdpPort = await freePort();
  const fd = fs.openSync(path.join(world.d, `app-${++launches}.log`), 'w');
  const t0 = Date.now();
  app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env: baseEnv(cdpPort), stdio: ['ignore', fd, fd], detached: true });
  console.log(`app #${launches} pid ${app.pid}, cdp ${cdpPort}`);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'app page target');
  cdp?.close(); cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
  return { target, t0 };
}
let SOCK_CACHED = '';
const sockPath = () => { try { SOCK_CACHED = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim() || SOCK_CACHED; } catch { /* the pointer is removed when the app quits: the socket name is STABLE per home, as in a command's frozen env */ } return SOCK_CACHED; };
/** Run the BUILT cli.js. `ws` = ORCHESTRA_WS_ID (env-asserted only: a rig CLI holds no key). `noDisplay` is the default: the rig env has neither DISPLAY nor WAYLAND_DISPLAY. */
function orch(args, { ws = null, run = null, env = {} } = {}) {
  let sock = ''; try { sock = sockPath(); } catch { /* app never started */ }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 90000, env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ...(sock ? { ORCHESTRA_SOCK: sock } : {}), ...(ws ? { ORCHESTRA_WS_ID: ws } : {}), ...(run ? { ORCHESTRA_RUN_ID: run } : {}), ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function post(route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ socketPath: sockPath(), path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 5000 }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end(payload);
  });
}
const wsList = () => cdp.eval(`window.orchestra.listWorkspaces().then((l) => l.map((w) => ({ id: w.id, branch: w.branch, parentId: w.parentId ?? null, noAgent: w.noAgent ?? null, runCommand: w.runCommand ?? null, lastTask: w.lastTask ?? null, archived: !!w.archived })))`);
const modelReqs = () => fakeApi.requests.filter((r) => r.type === 'model').length;
const appLog = () => { try { return fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
const busDb = async () => { const { DatabaseSync } = await import('node:sqlite'); return new DatabaseSync(path.join(world.ohome, 'bus.sqlite'), { readOnly: true }); };

// ── a no-agent command = its own NA_OUT dir; jobs run INSIDE it (with its identity) ──
const na = {};
function naDirs(tag) { const out = path.join(world.d, `na-${tag}`); fs.mkdirSync(path.join(out, 'jobs'), { recursive: true }); return out; }
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let jobN = 0;
async function job(tag, args, env = {}, ms = 120000) {
  const n = String(++jobN).padStart(4, '0'); const dir = path.join(na[tag].out, 'jobs');
  fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ argv: args, env }));
  return JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(dir, `${n}.out.json`), 'utf8'); } catch { return null; } }, ms, `job ${n} ${args.join(' ')}`, 200));
}
async function spawnNoAgent(tag, { poll = 1000, checkMs = 2000 } = {}) {
  const out = naDirs(tag);
  const cmd = `NA_OUT=${out} NA_CLI=${CLI} NA_POLL_MS=${poll} NA_CHECK_MS=${checkMs} exec ${process.execPath} ${LOOP}`;
  const r = orch(['spawn', '--detached', '--no-agent', '--name', `ops-${tag}`, '--run-command', cmd, '--repo', world.repo]);
  const m = /^Spawned (\S+) on branch (\S+)$/m.exec(r.stdout);
  if (m) na[tag] = { id: m[1], branch: m[2], out };
  return { r, m, out };
}
const rec = (tag) => JSON.parse(fs.readFileSync(path.join(world.ohome, 'noagent', `${na[tag].id}.json`), 'utf8'));
const cmdAlive = (tag) => { try { const r = rec(tag); return ticksOf(r.pid) === r.startTicks; } catch { return false; } };
const lastIdent = (tag) => jsonl(path.join(na[tag].out, 'ident.jsonl')).at(-1);
const identAfter = (tag, t) => jsonl(path.join(na[tag].out, 'ident.jsonl')).find((e) => e.t > t && e.ok);
const readSeqs = (tag) => jsonl(path.join(na[tag].out, 'reads.jsonl')).flatMap((e) => e.seqs ?? []);
const sendMail = (to, body, { from = 'ws-sender', run = 'ws-sender' } = {}) => orch(['send', '--type', 'status', '--to', to, body], { ws: from, run });
function rigPids() { const out = []; for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (+p !== process.pid && environOf(p).includes(`ORCHESTRA_HOME=${world.ohome}`)) out.push(+p); } catch { /* */ } } return out; }
/** `group` = signal the app's WHOLE process group (the rig spawned it detached = its own group): what a launcher / systemd stop / a closed terminal does, and what a command that is not setsid'd would not survive. */
async function quitApp(sig, group = false) {
  const pid = app.pid; const t = Date.now();
  process.kill(group ? -pid : pid, sig);
  await waitFor(() => !alive(pid), 30000, `app exit after ${sig}`, 200);
  return Date.now() - t;
}

try {
  const { target } = await launchApp();
  clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
  await waitFor(() => cdp.eval(`document.querySelectorAll('.ws-name').length > 0`), 60000, 'sidebar rows');
  const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
  const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
  const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
  const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  clause('ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]))), `served ${path.basename(bundle)} md5 ${md5(served)}; package.json ${ver}`);
  clause('ctl/cli-has-no-agent', fs.readFileSync(CLI, 'utf8').includes('--no-agent') && fs.readdirSync(path.join(APP_DIR, 'dist-electron')).filter((n) => n.endsWith('.js')).some((n) => fs.readFileSync(path.join(APP_DIR, 'dist-electron', n), 'utf8').includes('/noagent/start')), `${CLI} and main.js carry #612`);
  const appEnv = environOf(app.pid);
  clause('ctl/scratch-env', appEnv.includes(`ORCHESTRA_HOME=${world.ohome}`) && !appEnv.some((e) => e.startsWith('DISPLAY=')), `ORCHESTRA_HOME=${world.ohome}, no DISPLAY`);
  const st = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8'));
  clause('ctl/account-pin', st.workspaces.every((w) => w.accountId === st.accounts[0].id) && real(st.accounts[0].configDir).startsWith(real(world.ohome).replace(/oh$/, '')) && !LIVE.some((l) => real(st.accounts[0].configDir).startsWith(l)), `accountId ${st.workspaces[0].accountId} == account.id ${st.accounts[0].id}; configDir ${st.accounts[0].configDir} (scratch)`);

  // ── spawn: refusals create nothing ──
  const before = (await wsList()).length;
  const bad = [
    ['--no-agent without --run-command', ['spawn', '--detached', '--no-agent', '--name', 'ops-x', '--repo', world.repo], /\[noagent-no-command\]/],
    ['--no-agent with --task', ['spawn', '--detached', '--no-agent', '--name', 'ops-x', '--task', 'hi', '--run-command', 'true', '--repo', world.repo], /--task.*mean nothing with --no-agent/],
    ['--run-command without --no-agent', ['spawn', '--detached', '--name', 'ops-x', '--task', 'hi', '--run-command', 'true', '--repo', world.repo], /--run-command belongs to --no-agent/],
  ];
  for (const [label, args, re] of bad) { const r = orch(args); clause(`spawn/refuse/${label}`, r.code === 1 && re.test(r.stderr) && /Nothing was created/.test(r.stderr), `rc ${r.code} «${r.stderr.trim().slice(0, 140)}»`); }
  const viaRoute = await post('/spawn', { noAgent: true, runCommand: '', name: 'ops-x', repoPath: world.repo, detached: true });
  clause('spawn/refuse/route-empty-command', viaRoute.ok === false && /\[noagent-no-command\]/.test(viaRoute.error ?? '') && !viaRoute.id, JSON.stringify(viaRoute).slice(0, 160));
  clause('spawn/refuse/nothing-created', (await wsList()).length === before, `workspaces ${before} -> ${(await wsList()).length}`);

  // ── spawn: accepted ──
  const sp = await spawnNoAgent('owner');
  clause('spawn/accepted', sp.r.code === 0 && !!sp.m && /no agent session by design/.test(sp.r.stdout), `rc ${sp.r.code}, stdout «${sp.r.stdout.trim().slice(0, 200)}», stderr «${sp.r.stderr.trim().slice(0, 100)}»`);
  const O = na.owner;
  await waitFor(() => fs.existsSync(path.join(O.out, 'started.json')), 20000, 'the command started');
  const w = (await wsList()).find((x) => x.id === O.id);
  clause('spawn/record', w?.noAgent === true && w.runCommand?.includes('no-agent-loop.mjs') && !w.lastTask && w.parentId === null, JSON.stringify(w)?.slice(0, 260));
  const r0 = rec('owner'); const stat0 = fs.readFileSync(`/proc/${r0.pid}/stat`, 'utf8');
  const sid = Number(stat0.slice(stat0.lastIndexOf(')') + 2).split(' ')[3]);
  clause('spawn/detached-session-leader', sid === r0.pid && alive(r0.pid) && r0.pid !== app.pid, `command pid ${r0.pid} is its own session (sid ${sid}); app pid ${app.pid} is a different process`);
  const started = JSON.parse(fs.readFileSync(path.join(O.out, 'started.json'), 'utf8'));
  clause('spawn/command-env', started.ws === O.id && started.hasKey && started.sock === sockPath(), `ws ${started.ws}, key present ${started.hasKey}, sock ${started.sock}, run ${started.run}`);
  clause('spawn/no-agent-process', !rigPids().some((p) => { try { return environOf(p).includes(`ORCHESTRA_WS_ID=${O.id}`) && /claude|keeper/.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')); } catch { return false; } }), `no claude / keeper process carries ORCHESTRA_WS_ID=${O.id}`);
  const row = await cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-name')].find((x) => x.textContent.includes('ops-owner')); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })()`);
  await sleep(500);
  saveShot('01-sidebar-with-no-agent-workspace.png', await cdp.shot());
  clause('spawn/sidebar-row-visible', !!row && row.w > 0 && row.h > 0 && row.inside, JSON.stringify(row));
  if (row) { for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: row.l + row.w / 2, y: row.t + row.h / 2, button: 'left', clickCount: 1 }); await sleep(2500); saveShot('02-no-agent-workspace-selected.png', await cdp.shot()); }

  // ── C1: identity ──
  const run1 = await waitFor(() => lastIdent('owner')?.ok ? lastIdent('owner') : null, 15000, 'the command vouched');
  clause('c1/command-vouched-by-identity', run1.ok === true && typeof run1.runId === 'string', `ident ${JSON.stringify(run1)}`);
  const key = environOf(r0.pid).find((e) => e.startsWith('ORCHESTRA_SESSION_KEY='))?.split('=')[1];
  const forged = [['wrong key', { id: O.id, key: 'a'.repeat(64) }, 'superseded'], ['lead id + the command\'s key', { id: 'ws-lead', key }, null], ['unknown id', { id: 'ws-nobody', key }, 'unregistered']];
  for (const [label, body, want] of forged) { const r = await post('/identity', body); clause(`c1/forged/${label}`, r.ok === false && (want === null || r.code === want), JSON.stringify(r).slice(0, 140)); }
  const who = await job('owner', ['whoami']);
  clause('c1/whoami-as-the-command', who.code === 0 && who.stdout.includes(O.id) && /role\s+\S+/.test(who.stdout), who.stdout.split('\n').filter((l) => /^(id|role|run)\b/.test(l)).join(' | '));
  // CONTROL (the unfixed arm): the Run-script PTY of a NORMAL workspace has no identity — what a command had before #612
  await cdp.eval(`window.orchestra.runScriptStart('ws-lead', 80, 24)`);
  const penv = await waitFor(() => { try { return fs.readFileSync(path.join(world.ohome, 'runenv-lead.txt'), 'utf8'); } catch { return null; } }, 20000, 'Run-script env dump');
  clause('c1/control/run-script-pty-has-no-identity', !/^ORCHESTRA_(SOCK|WS_ID|SESSION_KEY)=/m.test(penv) && /^ORCHESTRA_BRANCH=lead$/m.test(penv), 'PTY env: ORCHESTRA_BRANCH present; no SOCK / WS_ID / SESSION_KEY');

  // ── C2: no agent ──
  if (!SOAK_SEC) {
    const reqs0 = modelReqs();
    const ml = sendMail(O.id, 'LOT-1 from sender');
    clause('c2/mail-accepted', ml.code === 0, `send rc ${ml.code} «${(ml.stdout + ml.stderr).trim().slice(0, 140)}»`);
    await waitFor(() => appLog().split('\n').some((l) => l.includes(O.id) && /not being woken[^\n]*not-wakeable/.test(l)), 30000, 'the wake sweep skipping the workspace').then(() => clause('c2/not-wakeable', true, appLog().split('\n').find((l) => l.includes(O.id) && /not-wakeable/.test(l))?.slice(0, 220))).catch((e) => clause('c2/not-wakeable', false, e.message));
    await waitFor(() => readSeqs('owner').length >= 1, 30000, 'the command reading the lot').catch(() => null);
    clause('c2/command-read-the-lot', readSeqs('owner').length === 1, `sequences read by the command: ${JSON.stringify(readSeqs('owner'))}`);
    const rr = orch(['restart', O.id]);
    clause('c2/restart-refused', rr.code !== 0 && /no agent session by design/.test(rr.stdout + rr.stderr), `rc ${rr.code} «${(rr.stdout + rr.stderr).trim().slice(0, 160)}»`);
    console.log('  … waiting 75 s (past the 60 s wake sweep) with 0 agents alive');
    await sleep(75000);
    clause('c2/zero-agent-turns', modelReqs() === reqs0 && !rigPids().some((p) => { try { return environOf(p).includes(`ORCHESTRA_WS_ID=${O.id}`) && /claude|keeper/.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')); } catch { return false; } }), `fake-API model requests ${reqs0} -> ${modelReqs()} over the window; no claude/keeper process of the workspace`);
    // CONTROL: the same mail to a NORMAL agent wakes it — the instrument can say "yes"
    const mc = orch(['send', '--type', 'status', '--to', 'ws-normal', 'CONTROL mail'], { ws: 'ws-lead', run: 'ws-lead' });
    await waitFor(() => modelReqs() > reqs0, 90000, 'the control agent to take a turn').then(() => clause('c2/control/normal-agent-IS-woken', true, `send rc ${mc.code}; model requests ${reqs0} -> ${modelReqs()}`)).catch((e) => clause('c2/control/normal-agent-IS-woken', false, e.message));

    // ── C5: Pause ──
    const verbs = { open: ['fanout', 'open', '--branch', 'impl-a', '--into', 'main', '--ticket', 'A'], gate: ['fanout', 'gate', '--branch', 'impl-a', '--into', 'main', '--head', 'a'.repeat(40)], deliver: ['fanout', 'deliver', '--branch', 'impl-a', '--into', 'main', '--ticket', 'A', '--no-review-gate'] };
    const paused = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').at(-1)).reason === 'run-paused'; } catch { return false; } };
    for (const [v, a] of Object.entries(verbs)) { const r = await job('owner', a); clause(`c5/before-pause/${v}-not-run-paused`, !paused(r) && !/run en pause/.test(r.stdout + r.stderr), `rc ${r.code} «${(r.stdout + r.stderr).trim().slice(0, 100)}»`); }
    const pz = orch(['run', 'pause', '--hard', '--run', O.id, '--as', O.id]);
    const db1 = await busDb(); const pausedAt = db1.prepare('SELECT paused_at FROM runs WHERE id = ?').get(O.id)?.paused_at; db1.close();
    clause('c5/pause-recorded', pz.code === 0 && !!pausedAt, `rc ${pz.code}, runs.paused_at=${pausedAt} «${pz.stdout.trim().split('\n')[0]}»`);
    const cmdBefore = alive(rec('owner').pid);
    for (const [v, a] of Object.entries(verbs)) {
      const r = await job('owner', a); let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* */ }
      clause(`c5/paused/${v}-refused`, r.code === 2 && j?.reason === 'run-paused' && j?.detail === `run en pause — orchestra run resume --run ${O.id}` && r.stderr.includes(`run en pause — orchestra run resume --run ${O.id}`), `rc ${r.code} stdout «${r.stdout.trim().slice(0, 170)}»`);
    }
    const sp2 = await job('owner', ['spawn', '--name', 'impl-z', '--task', 'x']);
    clause('c5/paused/spawn-refused-same-text', sp2.code !== 0 && /run en pause — orchestra run resume/.test(sp2.stdout + sp2.stderr), `rc ${sp2.code} «${(sp2.stdout + sp2.stderr).trim().slice(0, 120)}»`);
    const rst = await job('owner', ['run', 'status']);
    clause('c5/paused/the-command-sees-it-and-lives', cmdBefore && alive(rec('owner').pid) && /paus/i.test(rst.stdout), `command alive ${alive(rec('owner').pid)}; its own \`run status\` says «${rst.stdout.split('\n').find((l) => /paus/i.test(l))?.trim().slice(0, 100)}»`);
    const rs = orch(['run', 'resume', '--run', O.id, '--as', O.id]);
    await sleep(1500);
    for (const [v, a] of Object.entries(verbs)) { const r = await job('owner', a); clause(`c5/after-resume/${v}-not-run-paused`, !paused(r) && !/run en pause/.test(r.stdout + r.stderr), `resume rc ${rs.code}; rc ${r.code} «${(r.stdout + r.stderr).trim().slice(0, 100)}»`); }

    // ── caller checks (seatRecords=on) ──
    const sp3 = orch(['spawn', '--detached', '--no-agent', '--name', 'ops-stranger', '--run-command', `NA_OUT=${naDirs('stranger')} NA_CLI=${CLI} NA_POLL_MS=1000 NA_CHECK_MS=2000 exec ${process.execPath} ${LOOP}`, '--repo', world.repo]);
    const m3 = /^Spawned (\S+) on branch (\S+)$/m.exec(sp3.stdout);
    if (m3) na.stranger = { id: m3[1], branch: m3[2], out: path.join(world.d, 'na-stranger') };
    clause('caller/stranger-spawned-with-no-display-in-the-cli-env', sp3.code === 0 && !!m3, `rc ${sp3.code} — the CLI env has no DISPLAY/WAYLAND_DISPLAY yet the app answers: NOT a false [noagent-no-display] refusal`);
    await waitFor(() => lastIdent('stranger')?.ok, 20000, 'stranger vouched');
    const init = await job('owner', ['fanout', 'state', 'init', '--switch', 'seatRecords=on']);
    clause('caller/owner-state-init', init.code === 0, `rc ${init.code} «${(init.stdout + init.stderr).trim().slice(0, 100)}»`);
    const stateFile = path.join(world.ohome, 'fanout', O.id, 'state.json');
    const okMerge = await job('owner', ['fanout', 'state', 'set', 'A', '--status', 'merged']);
    clause('caller/owner-may-mark-merged', okMerge.code === 0 && JSON.parse(fs.readFileSync(stateFile, 'utf8')).tickets.A?.status === 'merged', `rc ${okMerge.code} «${(okMerge.stdout + okMerge.stderr).trim().slice(0, 100)}»; state A.status=${JSON.parse(fs.readFileSync(stateFile, 'utf8')).tickets.A?.status}`);
    const bm = await job('stranger', ['fanout', 'state', 'set', '--run', O.id, 'B', '--status', 'merged']);
    clause('caller/stranger-merged-refused-state-unchanged', bm.code === 2 && /\[state-caller\]/.test(bm.stderr) && !JSON.parse(fs.readFileSync(stateFile, 'utf8')).tickets.B, `rc ${bm.code} «${bm.stderr.trim().slice(0, 140)}»; B in state: ${!!JSON.parse(fs.readFileSync(stateFile, 'utf8')).tickets.B}`);
    const bj = await job('stranger', ['fanout', 'state', 'set', '--run', O.id, 'B', '--json', '{"status":"merged"}']);
    clause('caller/stranger-merged-via-json-refused', bj.code === 2 && /\[state-caller\]/.test(bj.stderr), `rc ${bj.code} «${bj.stderr.trim().slice(0, 100)}»`);
    const bo = await job('stranger', ['fanout', 'open', '--branch', 'impl-a', '--into', 'main', '--ticket', 'A'], { ORCHESTRA_RUN_ID: O.id });
    clause('caller/stranger-open-refused', bo.code === 2 && /\[open-caller\]/.test(bo.stderr), `rc ${bo.code} «${bo.stderr.trim().slice(0, 120)}»`);
    const bg = await job('stranger', ['fanout', 'gate', '--branch', 'impl-a', '--into', 'main', '--head', 'a'.repeat(40), '--ticket', 'A', '--run', O.id]);
    clause('caller/stranger-gate-refused', bg.code === 2 && /\[gate-caller\]/.test(bg.stderr), `rc ${bg.code} «${bg.stderr.trim().slice(0, 120)}»`);
    const bc = await job('stranger', ['fanout', 'check', 'A', '--run', O.id]);
    clause('caller/stranger-check-refused', bc.code === 2 && /\[check-caller\]/.test(bc.stderr), `rc ${bc.code} «${bc.stderr.trim().slice(0, 120)}»`);
    const oo = await job('owner', verbs.open);
    clause('caller/owner-open-passes-the-caller-gate', !/\[open-caller\]/.test(oo.stderr) && !paused(oo), `rc ${oo.code} (gh is not reachable in the rig: the verb fails AFTER the gate) «${(oo.stdout + oo.stderr).trim().slice(0, 100)}»`);
    const envOnly = orch(['fanout', 'state', 'set', 'C', '--status', 'merged'], { ws: O.id });
    clause('caller/env-asserted-owner-id-refused-fail-closed', envOnly.code === 2 && /\[state-caller\]/.test(envOnly.stderr) && /did not vouch/.test(envOnly.stderr) && !JSON.parse(fs.readFileSync(stateFile, 'utf8')).tickets.C, `rc ${envOnly.code} «${envOnly.stderr.trim().slice(0, 140)}»`);
    await job('owner', ['fanout', 'state', 'set', 'C', '--status', 'todo']).catch(() => null);
  }

  // ── C3: quit / kill the app; the command lives on and is vouched again ──
  const cmdPid = rec('owner').pid;
  const ptyPid = Number(fs.readFileSync(path.join(world.ohome, 'runpid-lead.txt'), 'utf8').trim());
  clause('c3/pre/pty-and-command-alive', alive(ptyPid) && alive(cmdPid), `Run-script PTY child ${ptyPid} alive, command ${cmdPid} alive`);
  const lotsBefore = SOAK_SEC ? [] : readSeqs('owner').length;
  const downTs = [];
  async function bounce(sig, downMailBodies, group = false) {
    const t0 = Date.now();
    const took = await quitApp(sig, group);
    downTs.push(Date.now());
    const lastBefore = lastIdent('owner');
    const mails = downMailBodies.map((b) => sendMail(na.owner.id, b));
    return { took, mails, lastBefore, quitAt: t0 };
  }
  const sig = SOAK_SEC ? 'SIGTERM' : 'SIGTERM';
  const bn = await bounce(sig, ['DOWN-1 while the app is closed', 'DOWN-2 while the app is closed']);
  clause('c3/term/app-exited', !alive(app.pid), `${sig}: app gone after ${bn.took} ms`);
  clause('c3/term/command-survives', alive(cmdPid) && cmdAlive('owner'), `command pid ${cmdPid} (same start time ${rec('owner').startTicks}) alive after the app quit`);
  clause('c3/term/control-pty-child-dies', !alive(ptyPid), `Run-script PTY child ${ptyPid}: ${alive(ptyPid) ? 'ALIVE (control failed)' : 'dead — the old Run-script copy does not survive the app'}`);
  clause('c3/term/mail-while-down-accepted', bn.mails.every((m) => m.code === 0), `store-less send while the app is down: rc ${bn.mails.map((m) => m.code)}`);
  await sleep(4000);
  const downIdent = jsonl(path.join(na.owner.out, 'ident.jsonl')).filter((e) => e.t > bn.quitAt + 1500).slice(-3);
  clause('c3/term/command-not-vouched-while-the-host-is-down', downIdent.length > 0 && downIdent.every((e) => !e.ok && e.code === 'unreachable'), `ident while down: ${downIdent.map((e) => e.code).join(',')}`);
  // display arms (app down): the clear refusal, and its control
  const nd = orch(['spawn', '--detached', '--no-agent', '--name', 'ops-nodisplay', '--run-command', 'true', '--repo', world.repo]);
  clause('display/app-down-no-display-clear-refusal', nd.code === 1 && /\[noagent-no-display\]/.test(nd.stderr) && /Nothing was created/.test(nd.stderr), `rc ${nd.code} «${nd.stderr.trim().slice(0, 200)}»`);
  const nd2 = orch(['spawn', '--detached', '--no-agent', '--name', 'ops-nodisplay', '--run-command', 'true', '--repo', world.repo], { env: { WAYLAND_DISPLAY: 'wayland-99' } });
  clause('display/control/app-down-with-display-is-the-plain-socket-error', nd2.code === 1 && !/noagent-no-display/.test(nd2.stderr) && /could not reach|not running|socket/i.test(nd2.stderr), `rc ${nd2.code} «${nd2.stderr.trim().slice(0, 160)}»`);
  // relaunch → measure the re-vouch
  const rl = await launchApp();
  const hostUp = await waitFor(async () => { try { const r = await post('/identity', { id: 'ws-nobody', key: 'x' }); return r && r.code ? Date.now() : null; } catch { return null; } }, 30000, 'the host answering', 100);
  const vouched = await waitFor(() => identAfter('owner', rl.t0), 30000, 'the command vouched again', 100);
  clause('c3/term/vouched-again-within-5s-of-the-host-listening', vouched.t - hostUp <= 5000, `app launched +0 ms; host answering +${hostUp - rl.t0} ms; command vouched +${vouched.t - rl.t0} ms (${vouched.t - hostUp} ms after the host listened; bound 5000)`);
  const keyAfter = environOf(cmdPid).find((e) => e.startsWith('ORCHESTRA_SESSION_KEY='))?.split('=')[1];
  clause('c3/term/same-process-same-key-not-re-keyed', alive(cmdPid) && keyAfter === key && rec('owner').pid === cmdPid, `pid ${cmdPid}, key unchanged ${keyAfter === key}`);
  const again = await post('/noagent/start', { id: O.id });
  await sleep(2500);
  clause('c3/term/start-again-is-idempotent-never-re-keys-a-live-command', again.ok === true && again.reused === true && again.pid === cmdPid && environOf(cmdPid).find((e) => e.startsWith('ORCHESTRA_SESSION_KEY='))?.split('=')[1] === key && lastIdent('owner')?.ok === true, `POST /noagent/start → ${JSON.stringify(again)}; the command is still vouched with its own key: ${lastIdent('owner')?.ok}`);
  await waitFor(() => bn.mails.length === 0 || readSeqs('owner').length >= lotsBefore + bn.mails.length, 40000, 'the mail sent while down to be read').catch(() => null);
  const seqs = readSeqs('owner');
  clause('c3/term/mail-sent-while-down-is-read', seqs.length >= lotsBefore + bn.mails.length && new Set(seqs).size === seqs.length, `sequences read ${JSON.stringify(seqs)} (unique ${new Set(seqs).size}/${seqs.length})`);
  saveShot('03-after-relaunch.png', await cdp.shot());

  if (!SOAK_SEC) {
    // kill -9
    const kb = await bounce('SIGKILL', ['DOWN-3 after kill -9'], true);
    clause('c3/kill9/command-survives', cmdAlive('owner'), `the app's whole process group SIGKILLed after ${kb.took} ms; command alive (its own session: not in that group)`);
    const rl2 = await launchApp();
    const hostUp2 = await waitFor(async () => { try { const r = await post('/identity', { id: 'ws-nobody', key: 'x' }); return r && r.code ? Date.now() : null; } catch { return null; } }, 30000, 'the host answering', 100);
    const v2 = await waitFor(() => identAfter('owner', rl2.t0), 30000, 'vouched after kill -9', 100);
    clause('c3/kill9/vouched-again-within-5s-of-the-host-listening', v2.t - hostUp2 <= 5000, `host answering +${hostUp2 - rl2.t0} ms; command vouched +${v2.t - rl2.t0} ms (${v2.t - hostUp2} ms after the host listened)`);
    await waitFor(() => readSeqs('owner').length >= lotsBefore + 3, 40000, 'DOWN-3 read').catch(() => null);
    clause('c3/kill9/mail-sent-while-down-is-read', readSeqs('owner').length >= lotsBefore + 3, `sequences read ${JSON.stringify(readSeqs('owner'))}`);
  } else {
    // ── soak: one lot every 30 s, app quit + reopen at the midpoint (the quit above already ran at T≈0: do the SECOND one mid-run) ──
    const T0 = Date.now(); const sent = [];
    let bounced = false; let n = 0;
    console.log(`  … soak ${SOAK_SEC} s: one lot every 30 s, app quit + reopen at the midpoint`);
    while (Date.now() - T0 < SOAK_SEC * 1000) {
      const m = sendMail(na.owner.id, `SOAK-LOT-${++n}`);
      sent.push({ n, code: m.code, t: Date.now(), seq: /sequence[ #:]*(\d+)/i.exec(m.stdout + m.stderr)?.[1] ?? null });
      if (!bounced && Date.now() - T0 > (SOAK_SEC * 1000) / 2) {
        bounced = true;
        const b = await bounce('SIGTERM', ['SOAK-LOT-while-quit-1', 'SOAK-LOT-while-quit-2']);
        sent.push(...b.mails.map((x, i) => ({ n: `q${i + 1}`, code: x.code, t: Date.now(), seq: null })));
        const alive1 = cmdAlive('owner');
        await sleep(20000);
        const rl3 = await launchApp();
        const v3 = await waitFor(() => identAfter('owner', rl3.t0), 30000, 'vouched after the mid-soak reopen', 100);
        clause('soak/mid-run-quit-reopen', alive1 && cmdAlive('owner') && v3.t - rl3.t0 < 30000, `command survived the quit (alive ${alive1}) and was vouched ${v3.t - rl3.t0} ms after the relaunch`);
      }
      if ((n % 20) === 0) console.log(`    t+${Math.round((Date.now() - T0) / 1000)} s: ${sent.length} lots sent, ${new Set(readSeqs('owner')).size} read, model requests ${modelReqs()}`);
      await sleep(30000);
    }
    await waitFor(() => new Set(readSeqs('owner')).size >= sent.filter((s) => s.code === 0).length + 2, 90000, 'the last lots read').catch(() => null);
    const seqsAll = readSeqs('owner'); const uniq = new Set(seqsAll);
    const idents = jsonl(path.join(na.owner.out, 'ident.jsonl'));
    const okRatio = idents.filter((e) => e.ok).length / idents.length;
    let maxGap = 0, gapStart = 0; for (const e of idents) { if (!e.ok) { gapStart ||= e.t; maxGap = Math.max(maxGap, e.t - gapStart); } else gapStart = 0; }
    const okSends = sent.filter((s) => s.code === 0).length;
    clause('soak/every-lot-read', uniq.size === okSends + 2, `${okSends} lots sent (+2 while the app was quit, +the earlier DOWN-1/2 and the start ones); ${uniq.size} distinct sequences read; max seq ${Math.max(...uniq)}`);
    clause('soak/no-lot-read-twice', seqsAll.length === uniq.size, `${seqsAll.length} reads, ${uniq.size} distinct`);
    clause('soak/command-lived-the-whole-run', cmdAlive('owner') && Date.now() - T0 >= SOAK_SEC * 1000, `command pid ${rec('owner').pid} alive after ${Math.round((Date.now() - T0) / 1000)} s`);
    clause('soak/vouched-except-while-the-host-was-down', okRatio > 0.95 && maxGap < 120000, `${idents.length} identity polls, ${(okRatio * 100).toFixed(2)}% ok; longest unvouched gap ${Math.round(maxGap / 1000)} s (the quit + reopen)`);
    clause('soak/zero-agent-turns', modelReqs() === 0, `fake-API model requests over ${Math.round((Date.now() - T0) / 1000)} s: ${modelReqs()} (no normal agent was woken in this mode)`);
  }

  // ── no live contact ──
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
  const mine = rigPids();
  for (const p of mine) { try { process.kill(p, 'SIGTERM'); } catch { /* */ } }
  await sleep(1500);
  for (const p of mine) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
  const left = mine.filter((p) => alive(p));
  console.log(`teardown: killed ${mine.length} rig process(es) by identity (ORCHESTRA_HOME), ${left.length} left; fake API requests seen ${fakeApi.requests.length}`);
  try { await fakeApi.close?.(); } catch { /* */ }
  fs.writeFileSync(path.join(world.d, 'result.json'), JSON.stringify({ results, shots }, null, 2));
}
process.exit(exitCode);
