// #407 — what does Electron's EnableCookieEncryption fuse do to an UPGRADED install? Measured on the PACKAGED app (argv: <off-dir> <on-dir>: two COPIES of
// release/linux-arm64-unpacked that differ in the fuse byte and nothing else — scripts/e2e-cookie-fuse.sh builds and proves that), inside the contained
// rig's own headless sway and the keyring rig's HIDDEN WORLD (the human's runtime dir is an empty tmpfs: his keyring and bus cannot be reached).
// Every boot gets its OWN private world: XDG_RUNTIME_DIR under the rig's private one, a `dbus-run-session` with an empty service dir and, per keyring
// state, a private gnome-keyring-daemon over a PERSISTENT scratch keyring dir (so cookies sealed under "unlocked" meet the same keyring "locked" later).
//
// A RUN = fresh scratch world, then:  W1 (fuse OFF = the stock install that wrote the old cookies: a persist:orchestra-profile-* partition driven through the real
// UI + a persist:claude-login-* partition driven through the openLoginWindow shape) → snapshot → arms, each restored from that snapshot:
//   A1 (a)(b)  fuse ON + unlocked keyring: pre-existing cookies still readable? logins kept? new cookies written encrypted?   → D1 (d) fuse back OFF → D2 re-ON
//   CL CN CB (c)  fuse ON + keyring LOCKED / ABSENT / basic_text: startup time vs the fuse-OFF baseline, crash/hang, pre-existing cookies kept?
//   C2 (cost)  from A1's state: boot ON with the keyring LOCKED (cookies sealed under the unlocked keyring) then UNLOCKED again
//   S*   fuse-OFF baselines (timing only) interleaved with the ON boots in alternating order; two same-arm boots per run are the NULL control
//   GL   (opt-in arm `gnome`) the same on a RECOGNISED desktop (Chromium picks libsecret itself — the shape that stalls on a locked keyring)
// Oracles: the Cookies DB (`value` / length(`encrypted_value`) / v10-v11 prefix, read from a COPY after a graceful quit), the jar as the main process
// reads it (session.cookies.get), and /whoami from a page of each partition. W1's DB rows are the POSITIVE CONTROL: the fuse-OFF build writes the inverse
// of (a) and the oracle's own predicate must read RED on it. Raw records: one JSON per line (--jsonl); the verdict is src/shared/cookie-fuse-verdict.ts.
//
// Usage (via scripts/e2e-cookie-fuse.sh): <off-dir> <on-dir> --live-home <real $HOME> [--runs 3] [--arms w,a,d,c,c2,gnome] [--jsonl file] [--meta file] [--label name] | --preflight-only
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';
import { descendantsOf, isAlive, procStat, signalIfSame } from './lib/rig-procs.mjs';
import { absolutePieces, physicalForms, physicalPath } from './lib/rig-paths.mjs';
import {
  armWorldChecks, busConfigChecks, driverWorldChecks, envHumanRuntimeRefs, failed, humanRuntimeDir, buildSocketScan, parseUnixSockets, physicalWorldChecks, referencesHumanRuntime,
  rootCensusChecks, secretsOwnerChecks, socketInode, socketPaths, unparsedAbout,
} from '../src/shared/keyring-rig-world.ts';
import { computeVerdict, statsOf } from '../src/shared/cookie-fuse-verdict.ts';
import { PROFILE_AT_REST_WARNING } from '../src/shared/browser-profile.ts';
import { profileAtRestWarning } from '../src/shared/cookie-fuse-policy.ts';
import { createRequire } from 'node:module';
const { readFuseWireFile } = createRequire(import.meta.url)('./lib/fuse-wire.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };

// ── the driver's OWN world, proved before anything is created or started (same entry as e2e-keyring.mjs; its --preflight-only is the must-FAIL arm) ──
const PREFLIGHT_ONLY = argv.includes('--preflight-only');
const RIG_DIR = process.env.RIG_DIR;
const readNul = (f) => { try { return fs.readFileSync(f, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const hiddenWorldProof = () => process.env.RIG_HIDDEN_WORLD === '1' || readNul(`/proc/${process.ppid}/environ`).includes('RIG_HIDDEN_WORLD=1');
let RIG_XDG;
try { RIG_XDG = privateRuntimeDir(); } catch (e) { refuse(e.message); }
{
  let noBusExists = true;
  try { fs.lstatSync(path.join(RIG_DIR, 'no-session-bus')); } catch { noBusExists = false; }
  const miFlag = flag('--mountinfo-file', null);
  if (miFlag && !PREFLIGHT_ONLY) refuse('--mountinfo-file is a --preflight-only test flag: a real run reads its own /proc/self/mountinfo');
  let mountinfo = null;
  try { mountinfo = fs.readFileSync(miFlag ?? '/proc/self/mountinfo', 'utf8'); } catch {}
  const cs = driverWorldChecks({ rigDir: RIG_DIR, env: process.env, noBusExists, hiddenWorld: hiddenWorldProof(), mountinfo, uid: process.getuid() });
  const bad = failed(cs);
  if (bad.length) refuse(`cookie-fuse rig world preflight failed — ${bad.map((c) => `${c.id} (${c.detail})`).join('; ')}`);
  console.log(`[preflight] rig world: ${cs.length}/${cs.length} clauses ok (${cs.map((c) => c.id).join(', ')})`);
  const rigReal = physicalPath(RIG_DIR);
  const envPhysical = {};
  for (const [k, v] of Object.entries(process.env)) { const forms = absolutePieces(v ?? '').flatMap(physicalForms); if (forms.length) envPhysical[k] = forms; }
  const pbad = failed(physicalWorldChecks({ rigDir: RIG_DIR, rigReal, xdgReal: physicalPath(RIG_XDG), envPhysical }));
  if (pbad.length) refuse(`cookie-fuse rig physical preflight failed — ${pbad.map((c) => `${c.id} (${c.detail})`).join('; ')}`);
  console.log('[preflight] physical: ok');
  if (PREFLIGHT_ONLY) { console.log('PREFLIGHT-OK'); process.exit(0); }
}

const OFF_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const ON_DIR = argv[1] && !argv[1].startsWith('--') ? fs.realpathSync(argv[1]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', 'run');
const RUNS = Number(flag('--runs', '3'));
const RUN_OFFSET = Number(flag('--run-offset', '0')); // run ids start after this (scripts/e2e-cookie-fuse.sh runs ONE planned run per invocation and concatenates the parts)
const ARMS = new Set(flag('--arms', 'w,a,d,c,c2').split(',').filter(Boolean));
const JSONL = flag('--jsonl', path.join(RIG_DIR, 'cookie-fuse.jsonl'));
const META_FILE = flag('--meta', null);
const SHOTS_DIR = flag('--shots', path.join(RIG_DIR, 'shots'));
const WORKTREE_DIST = flag('--worktree-dist', null); // arm `warn`: the renderer bundle the app serves must be byte-equal to this dist/ (the build under test)
const BOOT_DEADLINE_MS = Number(flag('--boot-deadline-ms', '150000'));
if (!OFF_DIR || !ON_DIR) refuse('need <off-dir> <on-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_WAYLAND) refuse('RIG_WAYLAND unset — run via scripts/e2e-cookie-fuse.sh (the contained rig)');
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != the rig's marker-verified alias ${RIG_WAYLAND}`);
const UID = process.getuid();
for (const [k, d] of [['off', OFF_DIR], ['on', ON_DIR]]) if (!fs.existsSync(path.join(d, 'orchestra')) || !fs.existsSync(path.join(d, 'resources/app.asar'))) refuse(`${k}-dir ${d} is not a packaged app (orchestra + resources/app.asar)`);

// ── scratch containment: nothing the app is handed may be a live dir or outside the rig ──
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(physicalPath);
function checkScratch(p) {
  if (referencesHumanRuntime(p)) return { ok: false, clause: 'human-runtime' };
  const r = physicalPath(p);
  if (referencesHumanRuntime(r)) return { ok: false, clause: 'human-runtime' };
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.config/orchestra')), b = checkScratch(path.join(humanRuntimeDir(UID), 'bus')), c = checkScratch(path.join(path.dirname(RIG_BASE), 'not-in-the-rig')), d = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'human-runtime' || c.clause !== 'outside-rig-base' || !d.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c, d })}`);
  console.log(`[guard] self-test: human app config -> ${a.clause} · human runtime bus -> ${b.clause} · outside path -> ${c.clause} · rig path -> ${d.clause}`);
}

// ── helpers ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function waitFor(fn, ms, what, step = 120) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const memAvailGB = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr, ms = 20000) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  close() { try { this.ws.close(); } catch {} }
}

// ── records: one JSON per line, flushed as they are made (a killed run keeps what it measured) ──
fs.mkdirSync(path.dirname(JSONL), { recursive: true });
fs.writeFileSync(JSONL, '');
const records = [];
function rec(r) { const full = { ts: new Date().toISOString(), ...r }; records.push(full); fs.appendFileSync(JSONL, JSON.stringify(full) + '\n'); return full; }
const clauses = [];
function control(name, ok, detail, run) { clauses.push({ name, ok: !!ok }); rec({ kind: 'control', name, ok: !!ok, detail, ...(run !== undefined ? { run } : {}) }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }

// ── the fixture site: /signin sets cookies, /whoami echoes `sid`, /home is a static page ──
const NAMES = { old: (i) => `o${String(i).padStart(2, '0')}`, new: (i) => `n${String(i).padStart(2, '0')}` };
const N_COOKIES = 24;
let SITE_PORT = 0;
function startSite() {
  const cookieOf = (req, name) => { for (const part of String(req.headers.cookie ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); } return null; };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://fixture');
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
    if (u.pathname === '/signin') {
      const tag = u.searchParams.get('tag') ?? 'o', nonce = u.searchParams.get('r') ?? 'x', sidName = u.searchParams.get('sidName') ?? 'sid', n = Number(u.searchParams.get('n') ?? N_COOKIES), sess = u.searchParams.get('session') === '1';
      const jar = [`${sidName}=${sidName}-${nonce}; Max-Age=2592000; Path=/; SameSite=Lax`];
      for (let i = 0; i < n; i++) jar.push(`${NAMES[tag === 'o' ? 'old' : 'new'](i)}=v-${tag}${i}-${nonce}; Max-Age=2592000; Path=/; SameSite=Lax${i % 5 === 0 ? '; HttpOnly' : ''}`);
      if (sess) jar.push(`ssid=ssid-${nonce}; Path=/; SameSite=Lax`);
      return send(200, 'text/plain; charset=utf-8', `signed-in ${tag} ${nonce}`, { 'set-cookie': jar });
    }
    if (u.pathname === '/whoami') return send(200, 'text/plain; charset=utf-8', cookieOf(req, 'sid') ?? 'anon');
    if (u.pathname === '/home') return send(200, 'text/html; charset=utf-8', '<!doctype html><title>cookie-fuse home</title><body>home</body>');
    send(404, 'text/plain', 'not found');
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => { SITE_PORT = srv.address().port; res(srv); }));
}
const BASE = () => `http://127.0.0.1:${SITE_PORT}`;

// ── a run's persistent scratch world ──
const PROFILE_PART = (id) => `persist:orchestra-profile-${id}`;
const LOGIN_ID = 'rig-fuse407';
const LOGIN_PART = `persist:claude-login-${LOGIN_ID}`;
const partDirName = (partition) => partition.replace(/^persist:/, '');
function seedWorld(run) {
  const armDir = path.join(RIG_DIR, `run${run}`);
  const w = { run, armDir, nonce: crypto.randomBytes(4).toString('hex'), profileId: null, tracked: new Map() };
  for (const k of ['home', 'oh', 'claude-config', 'data', 'config', 'cache', 'stub-bin', 'svc', 'repo', 'wt', 'snap']) w[k] = path.join(armDir, k);
  for (const k of ['home', 'oh', 'claude-config', 'data', 'config', 'cache', 'stub-bin', 'svc', 'repo', 'wt', 'snap']) mustBeScratch(`world.${k}`, w[k]);
  for (const k of ['home', 'oh', 'claude-config', 'data', 'config', 'cache', 'stub-bin', 'svc', 'repo', 'wt', 'snap']) fs.mkdirSync(w[k], { recursive: true });
  git(w.repo, ['init', '-q', '-b', 'main'], w.home);
  fs.writeFileSync(path.join(w.repo, 'README.md'), '# cookie-fuse 407 seed repo\n');
  git(w.repo, ['add', '.'], w.home); git(w.repo, ['commit', '-q', '-m', 'seed'], w.home);
  const wt = path.join(w.wt, 'fuse-1'); mustBeScratch('wt', wt);
  git(w.repo, ['worktree', 'add', '-q', '-b', 'e2e/fuse-1', wt], w.home);
  const account = { id: 'rig-fuse407-acct', label: 'rig (scratch config dir)', configDir: w['claude-config'] };
  const ws = { id: 'ws-fuse-1', name: 'fuse-1', repoPath: w.repo, worktreePath: wt, branch: 'e2e/fuse-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(w.oh, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: w.repo, name: 'fuse-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  // `claude --version` (the app probes it at start) must EXIT: a stub that sleeps outlives the app, keeps its inherited chromium shm fds alive and filled the member's 6 GB memory scope (measured: 187 leaked stubs = 5.3 GB shmem, the kernel killed the driver)
  fs.writeFileSync(path.join(w['stub-bin'], 'claude'), '#!/bin/sh\ncase "$1" in --version) echo "0.0.0 (cookie-fuse stub)"; exit 0;; esac\nexec sleep 3600\n', { mode: 0o755 });
  w.ws = ws; w.partitions = path.join(w.oh, 'userData', 'Partitions'); w.logFile = path.join(w.oh, 'logs', 'orchestra.log');
  return w;
}
/** snapshot / restore of the STATE the app and the keyring keep between boots (cp --reflink: a few ms on btrfs) */
const SNAP_DIRS = ['oh', 'data', 'config'];
function snapshot(w, name) { const to = path.join(w.snap, name); fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true }); for (const d of SNAP_DIRS) sh('cp', ['-a', '--reflink=auto', w[d], path.join(to, d)]); }
function restore(w, name) { const from = path.join(w.snap, name); for (const d of SNAP_DIRS) { fs.rmSync(w[d], { recursive: true, force: true }); sh('cp', ['-a', '--reflink=auto', path.join(from, d), w[d]]); } }

// ── the private world of ONE boot: bus + (per state) keyring daemon ──
const DESKTOPS = { sway: { desktop: 'sway', scope: 'host' }, gnome: { desktop: 'GNOME', scope: 'recognised-desktop' } };
const busEnv = (b) => ({ PATH: '/usr/bin:/bin', HOME: b.w.home, XDG_RUNTIME_DIR: b.runDir, XDG_DATA_HOME: b.w.data, XDG_CONFIG_HOME: b.w.config, XDG_CACHE_HOME: b.w.cache, LANG: 'C.UTF-8' });
const toolEnv = (b) => ({ ...busEnv(b), DBUS_SESSION_BUS_ADDRESS: b.address });
const gdbus = (b, args, ms = 45000) => spawnSync('gdbus', ['call', '--address', b.address, '--timeout', '30', ...args], { encoding: 'utf8', env: toolEnv(b), timeout: ms, killSignal: 'SIGKILL' });
const secretsGet = (b, prop) => gdbus(b, ['--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets/aliases/default', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', prop]);
const busCall = (b, method, ...a) => gdbus(b, ['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', `org.freedesktop.DBus.${method}`, ...a]);
const lockedOf = (b) => { const r = secretsGet(b, 'Locked'); return r.status === 0 ? (/<true>/.test(r.stdout) ? 'locked' : /<false>/.test(r.stdout) ? 'unlocked' : `odd:${r.stdout.trim()}`) : 'no-service'; };
const itemCount = (b) => { const r = secretsGet(b, 'Items'); return r.status === 0 ? (r.stdout.match(/\/org\/freedesktop\/secrets\/collection\//g) || []).length : -1; };
const exeBaseOf = (pid) => { try { return path.basename(fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')); } catch { return ''; } };
const fdTargetsOf = (pid) => { try { return fs.readdirSync(`/proc/${pid}/fd`).map((f) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${f}`); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const inodesOf = (fds) => fds.map(socketInode).filter((i) => i !== null);
function ssRows(interest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
    if (r.status !== 0 || !r.stdout) throw new Error(`ss -xnaeH failed (rc ${r.status})`);
    const built = buildSocketScan(fs.readFileSync('/proc/net/unix', 'utf8'), r.stdout);
    if (!unparsedAbout(built.unparsed, interest).length) { if (built.scan.peerOf.size === 0) throw new Error('ss produced no (inode, peer) pairs'); return built.scan; }
    spawnSync('sleep', ['0.05']);
  }
  throw new Error('ss -xnaeH: rows mentioning this boot\'s sockets could not be placed after 3 snapshots');
}
function track(w, pid) { if (!pid || pid <= 1 || pid === process.pid || pid === process.ppid) return; const s = procStat(pid); if (s && s.state !== 'Z' && !w.tracked.has(pid)) w.tracked.set(pid, s.start); }
function busPeerPids(b) {
  const names = ((busCall(b, 'ListNames').stdout || '').match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).filter((n) => n !== 'org.freedesktop.DBus');
  const pids = new Set();
  for (const n of names) { const m = /uint32 (\d+)/.exec(busCall(b, 'GetConnectionUnixProcessID', n).stdout || ''); if (m) pids.add(+m[1]); }
  return [...pids];
}
function secretsOwnerPid(b) {
  const name = /'(:[^']+)'/.exec(busCall(b, 'GetNameOwner', 'org.freedesktop.secrets').stdout || '')?.[1];
  if (!name) return null;
  const m = /uint32 (\d+)/.exec(busCall(b, 'GetConnectionUnixProcessID', name).stdout || '');
  return m ? +m[1] : null;
}
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
function killGroup(g, sig) { if (g && isAlive(g.pid, g.start)) { try { process.kill(-g.pid, sig); } catch {} } }
async function reapBoot(b) {
  try { if (b.hasBus) for (const p of busPeerPids(b)) track(b.w, p); } catch {}
  if (b.busProc) for (const p of descendantsOf(b.busProc.pid)) track(b.w, p);
  if (b.appProc) for (const p of descendantsOf(b.appProc.pid)) track(b.w, p);
  for (const sig of ['SIGTERM', 'SIGKILL']) { killGroup(b.appProc, sig); killGroup(b.busProc, sig); for (const [pid, st] of b.w.tracked) signalIfSame(pid, st, sig); await sleep(sig === 'SIGTERM' ? 1500 : 300); }
  // Electron helpers re-exec with a clean environ and outlive a killed app: select by THIS boot's unique --user-data-dir on the command line (identity, not a name grep)
  const mark = `--user-data-dir=${path.join(b.w.oh, 'userData')}`;
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(mark)) { const s = procStat(+p); if (s) signalIfSame(+p, s.start, 'SIGKILL'); } } catch {} }
}
// ── the member's memory scope (memory_cap): a leaked process that holds Chromium's shm keeps the scope full until the kernel kills the driver ──
const MY_CG = (() => { try { return `/sys/fs/cgroup${fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split(':').pop()}`; } catch { return null; } })();
const cgNum = (f) => { try { const v = fs.readFileSync(`${MY_CG}/${f}`, 'utf8').trim(); return v === 'max' ? Infinity : Number(v); } catch { return null; } };
const scopeMem = () => { if (!MY_CG) return null; const st = fs.readFileSync(`${MY_CG}/memory.stat`, 'utf8'); const g = (k) => Number((new RegExp(`^${k} (\\d+)`, 'm').exec(st) ?? [])[1] ?? 0); return { current: cgNum('memory.current'), max: cgNum('memory.max'), shmem: g('shmem'), anon: g('anon'), anonShmem: g('anon') + g('shmem') }; };
/** processes of MY scope that carry this rig's marks (identity = scope membership + the rig dir in cmdline) — any of them after a boot is a survivor */
function scopeSurvivors(marks) {
  if (!MY_CG) return [];
  const out = [];
  let pids = []; try { pids = fs.readFileSync(`${MY_CG}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
  for (const p of pids) { if (p === process.pid) continue; const st = procStat(p); if (!st || st.state === 'Z') continue; let c = ''; try { c = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; } if (marks.some((m) => c.includes(m))) out.push({ pid: p, start: st.start, cmd: c.slice(0, 90) }); }
  return out;
}
let activeBoot = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { const b = activeBoot; if (b) { killGroup(b.appProc, 'SIGKILL'); killGroup(b.busProc, 'SIGKILL'); for (const [pid, st] of b.w.tracked) signalIfSame(pid, st, 'SIGKILL'); } process.exit(130); });

let BOOT_SEQ = 0;
async function startPrivateWorld(w, keyring, desktopKey) {
  const b = { w, keyring, desktopKey, seq: ++BOOT_SEQ };
  b.runDir = path.join(RIG_XDG, `k-${w.run}-${b.seq}`); b.bus = path.join(b.runDir, 'bus'); b.address = `unix:path=${b.bus}`;
  const dirs = { arm: w.armDir, home: w.home, oh: w.oh, claude: w['claude-config'], data: w.data, config: w.config, cache: w.cache };
  for (const [k, v] of Object.entries({ ...dirs, run: b.runDir })) mustBeScratch(`world.${k}`, v);
  fs.mkdirSync(b.runDir, { mode: 0o700 }); fs.chmodSync(b.runDir, 0o700);
  fs.symlinkSync(path.join(RIG_XDG, RIG_WAYLAND), path.join(b.runDir, RIG_WAYLAND));
  b.hasBus = keyring !== 'basic';
  if (!b.hasBus) return b;
  const conf = path.join(w.armDir, `session-${b.seq}.conf`);
  fs.writeFileSync(conf, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>${b.address}</listen>
  <auth>EXTERNAL</auth>
  <servicedir>${w.svc}</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`);
  const cs = [
    ...armWorldChecks({ rigDir: RIG_DIR, run: b.runDir, dirs, address: b.address, envs: { bus: busEnv(b), tool: toolEnv(b), app: appEnv(b, { port: 0 }) } }),
    ...busConfigChecks(fs.readFileSync(conf, 'utf8'), { svc: w.svc, address: b.address }),
    { id: 'bus-service-dir-is-empty', ok: fs.readdirSync(w.svc).length === 0, detail: `${w.svc} holds ${fs.readdirSync(w.svc).length} entries` },
  ];
  for (const c of cs) if (!c.ok) throw new Error(`the boot world is not private: ${c.id} (${c.detail})`);
  const child = spawn('dbus-run-session', [`--config-file=${conf}`, '--', 'sleep', '7200'], { env: busEnv(b), stdio: 'ignore', detached: true });
  child.unref();
  b.busProc = { pid: child.pid, start: procStat(child.pid)?.start };
  track(w, child.pid);
  await waitFor(() => { try { return fs.statSync(b.bus).isSocket(); } catch { return false; } }, 10000, 'the private session bus socket');
  for (const p of descendantsOf(child.pid)) track(w, p);
  const names0 = busCall(b, 'ListNames').stdout || '';
  control(`world/${w.run}.${b.seq}/private-bus-has-no-secret-service-yet`, !/org\.freedesktop\.secrets/.test(names0) && lockedOf(b) === 'no-service', `private bus names before any daemon: ${names0.trim()}`, w.run);
  const env = toolEnv(b);
  if (keyring === 'unlocked' || keyring === 'locked') {
    const first = !fs.existsSync(path.join(w.data, 'keyrings', 'login.keyring'));
    // the keyring file is created (and unlocked) by --login on first use; a LOCKED boot starts the daemon WITHOUT the password over the existing file
    if (keyring === 'unlocked' || first) {
      const r = spawnSync('gnome-keyring-daemon', ['--login', '--components=secrets'], { env, input: 'rigpw', encoding: 'utf8', timeout: 15000 });
      if (r.status !== 0) throw new Error(`gnome-keyring-daemon --login rc=${r.status} ${r.stderr}`);
    }
    if (keyring === 'locked' && first) { // first-ever use in a locked state: create the file, then stop the daemon and restart it locked
      const r2 = spawnSync('gnome-keyring-daemon', ['--start', '--components=secrets'], { env, encoding: 'utf8', timeout: 15000 });
      if (r2.status !== 0) throw new Error(`gnome-keyring-daemon --start rc=${r2.status} ${r2.stderr}`);
      for (const p of busPeerPids(b).filter((x) => exeBaseOf(x) === 'gnome-keyring-daemon')) { track(w, p); signalIfSame(p, w.tracked.get(p), 'SIGTERM'); }
      await waitFor(() => !busPeerPids(b).some((x) => exeBaseOf(x) === 'gnome-keyring-daemon'), 8000, 'the first keyring daemon to exit');
      await sleep(300);
    }
    const r3 = spawnSync('gnome-keyring-daemon', ['--start', '--components=secrets'], { env, encoding: 'utf8', timeout: 15000 });
    if (r3.status !== 0) throw new Error(`gnome-keyring-daemon --start rc=${r3.status} ${r3.stderr}`);
    for (const p of busPeerPids(b)) track(w, p);
  }
  b.keyringState = keyring === 'none' ? (secretsOwnerPid(b) === null ? 'none' : 'service!') : lockedOf(b);
  b.keyringOk = b.keyringState === keyring;
  control(`world/${w.run}.${b.seq}/private-keyring-state-is-${keyring}`, b.keyringOk, `independent oracle (gdbus Properties.Get Locked on the PRIVATE default collection, explicit --address) = ${b.keyringState}, wanted ${keyring}`, w.run);
  if (keyring !== 'none') {
    const pid = secretsOwnerPid(b);
    const ev = { ownerPid: pid, driverPid: process.pid, exeBase: '', cmdline: [], fdTargets: [], socketPaths: [], envEntries: [], sockets: parseUnixSockets(fs.readFileSync('/proc/net/unix', 'utf8')), run: b.runDir };
    if (pid) { track(w, pid); ev.exeBase = exeBaseOf(pid); ev.cmdline = readNul(`/proc/${pid}/cmdline`); ev.fdTargets = fdTargetsOf(pid); ev.socketPaths = socketPaths(inodesOf(ev.fdTargets), ssRows(new Set(inodesOf(ev.fdTargets)))); ev.envEntries = readNul(`/proc/${pid}/environ`); }
    const bad = failed(secretsOwnerChecks(ev));
    control(`world/${w.run}.${b.seq}/secrets-owner-is-our-private-daemon`, bad.length === 0, bad.length ? bad.map((c) => `${c.id}: ${c.detail}`).join('; ') : 'the owner of org.freedesktop.secrets on the private bus is our gnome-keyring-daemon, holding sockets under the boot\'s runtime dir, naming nothing of the human\'s', w.run);
    if (bad.length) b.keyringOk = false;
  }
  return b;
}

// ── the app ──
const VIEWPORT = { w: 1500, h: 950 };
function appEnv(b, { port, inspect }) {
  const w = b.w;
  const sway = DESKTOPS[b.desktopKey ?? 'sway'];
  const env = { PATH: `${w['stub-bin']}:/usr/local/bin:/usr/bin:/bin`, HOME: w.home, XDG_RUNTIME_DIR: b.runDir, XDG_CONFIG_HOME: w.config, XDG_CACHE_HOME: w.cache, XDG_DATA_HOME: w.data,
    XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: w.oh, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: w['claude-config'], LANG: 'C.UTF-8', XDG_CURRENT_DESKTOP: sway.desktop };
  if (b.keyring !== 'basic') { env.ORCHESTRA_KEYRING = 'probe'; env.DBUS_SESSION_BUS_ADDRESS = b.address; }
  else env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(RIG_DIR, 'no-session-bus')}`; // the contained rig's nonexistent address: the isolated instance forces --password-store=basic
  return env;
}
async function bootApp(b, build, { deadline = BOOT_DEADLINE_MS } = {}) {
  const dir = build === 'on' ? ON_DIR : OFF_DIR;
  const port = await freePort(), inspectPort = await freePort();
  const env = appEnv(b, { port, inspect: inspectPort });
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_RUNTIME_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND || env.WAYLAND_DISPLAY.includes('/')) throw new Error('child env would not use the rig\'s bare display alias');
  if (envHumanRuntimeRefs(env).length) throw new Error(`child env names the human's runtime dir: ${envHumanRuntimeRefs(env).join(', ')}`);
  const logFile = path.join(b.w.armDir, `app-${b.seq}.out`); const fd = fs.openSync(logFile, 'w');
  const t0 = Date.now();
  const app = spawn(path.join(dir, 'orchestra'), [`--inspect=127.0.0.1:${inspectPort}`, '--ozone-platform=wayland', '--enable-logging=stderr'], { cwd: dir, env, stdio: ['ignore', fd, fd], detached: true });
  b.appProc = { pid: app.pid, start: procStat(app.pid)?.start }; b.app = app; b.port = port; b.inspectPort = inspectPort; b.build = build; b.t0 = t0; b.exited = null; b.deadline = deadline;
  app.on('exit', (code, sig) => { b.exited = { code, sig, at: Date.now() - t0 }; });
  track(b.w, app.pid);
  console.log(`  [boot ${b.w.run}.${b.seq}] ${build} ${b.keyring}/${b.desktopKey ?? 'sway'} pid ${app.pid} out ${logFile}`);
  return b;
}
/** Run `expression` in the MAIN process through the Node inspector (`--inspect`). */
async function inMain(b, expression, ms = 60000) {
  const list = await (await fetch(`http://127.0.0.1:${b.inspectPort}/json/list`)).json();
  const c = await Cdp.connect(list[0].webSocketDebuggerUrl);
  try {
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }, ms);
    if (r.exceptionDetails) throw new Error(`main eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  } finally { c.close(); }
}
const withDeadline = (b, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what}: no answer within ${b.deadline} ms`), { hung: true })), Math.max(1000, b.t0 + b.deadline - Date.now())))]);

/** JS for the main process: the jars of both partitions (+ a probe write that is FLUSHED to the DB — the first thing that needs the encryption key). */
const jarJs = (profileId, { probe, backend }) => `(async () => {
  const { app, session, safeStorage } = require('electron');
  globalThis.__gone = globalThis.__gone || [];
  if (!globalThis.__goneHooked) { globalThis.__goneHooked = true;
    app.on('child-process-gone', (_e, d) => globalThis.__gone.push('child:' + d.type + ':' + d.reason));
    app.on('render-process-gone', (_e, _w, d) => globalThis.__gone.push('render:' + d.reason)); }
  await app.whenReady();
  const parts = ${JSON.stringify([profileId ? PROFILE_PART(profileId) : null, LOGIN_PART].filter(Boolean))};
  const out = { jars: {}, tReadMs: 0, tProbeMs: 0, backend: null };
  const t1 = Date.now();
  for (const p of parts) { const ses = session.fromPartition(p); out.jars[p] = (await ses.cookies.get({})).map((c) => [c.name, c.value, c.session ? 1 : 0]); }
  out.tReadMs = Date.now() - t1;
  const t2 = Date.now();
  ${probe ? `for (const p of parts) { const ses = session.fromPartition(p); await ses.cookies.set({ url: 'http://127.0.0.1/', name: 'zz_probe', value: 'p' + Date.now(), expirationDate: Date.now() / 1000 + 86400 }); await ses.cookies.flushStore(); }` : ''}
  out.tProbeMs = Date.now() - t2;
  ${backend ? `try { out.backend = safeStorage.getSelectedStorageBackend(); } catch (e) { out.backend = 'error:' + e.message; }` : ''}
  out.gone = globalThis.__gone;
  return JSON.stringify(out);
})()`;
const wantedNames = (kind, partition) => (kind === 'old' ? [...Array.from({ length: N_COOKIES }, (_, i) => NAMES.old(i)), 'sid', ...(partition === 'profile' ? ['ssid'] : [])] : [...Array.from({ length: N_COOKIES }, (_, i) => NAMES.new(i)), 'sidN']);
const expectedValue = (w, name) => (name === 'sid' ? `sid-${w.nonce}` : name === 'sidN' ? `sidN-${w.nonce}` : name === 'ssid' ? `ssid-${w.nonce}` : `v-${name[0]}${Number(name.slice(1))}-${w.nonce}`);
function jarCounts(w, jar, partition) {
  const have = new Map(jar.map(([n, v]) => [n, v]));
  const cnt = (kind) => { const names = wantedNames(kind, partition); return { expected: names.length, readable: names.filter((n) => have.get(n) === expectedValue(w, n)).length }; };
  return { old: cnt('old'), new: cnt('new') };
}
/** Boot's first measured step: wait for the inspector, read both jars, write+flush a probe. readyMs = spawn → this answered. */
async function firstRead(b, { wantNew, probe = true, backend = true }) {
  const w = b.w;
  const profileId = w.profileId;
  let out = null, hung = false, err = null;
  // `--inspect` listens from the first instant of the process: an eval that lands before the app's main script runs hits Node's bootstrap context
  // (`require is not defined`) or is torn down when the context is replaced (`Promise was collected`) — measured on this rig. Retry THOSE, nothing else.
  const BOOTSTRAP_RACE = /require is not defined|Promise was collected|Execution context was destroyed|Cannot find context|ws error|closed|before bootstrapping is done|is not a function|Cannot read properties of undefined/i;
  try {
    await withDeadline(b, waitFor(async () => (await fetch(`http://127.0.0.1:${b.inspectPort}/json/list`)).ok, b.deadline, 'the main-process inspector', 100), 'inspector');
    // gate: the main script has run and electron's `session` is usable (polled with a tiny eval, so it does not count as the work being timed)
    const READY = `(() => { try { const e = require('electron'); return !!(e && e.app && e.app.isReady() && e.session && typeof e.session.fromPartition === 'function'); } catch { return false; } })()`;
    await withDeadline(b, waitFor(async () => inMain(b, READY, 5000).catch(() => false), b.deadline, 'electron ready in the main process', 50), 'electron ready');
    for (;;) {
      try { out = JSON.parse(await withDeadline(b, inMain(b, jarJs(profileId, { probe, backend }), b.deadline), 'first jar read + probe flush')); break; }
      catch (e) { if (e.hung || !BOOTSTRAP_RACE.test(String(e.message))) throw e; b.raceRetries = (b.raceRetries ?? 0) + 1; await sleep(100); }
    }
  } catch (e) { if (e.hung) hung = true; err = e; }
  const readyMs = Date.now() - b.t0;
  b.readyMs = readyMs; b.hung = hung;
  return { out, hung, err, readyMs };
}
async function targetMs(b) {
  try { await waitFor(async () => (await (await fetch(`http://127.0.0.1:${b.port}/json`)).json()).some((x) => x.type === 'page' && x.url.includes('dist/index.html')), 60000, 'the app page target'); return Date.now() - b.t0; } catch { return null; }
}

// ── UI (W1 and the real panel tab) ──
async function connectUi(b) {
  const tA = Date.now();
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${b.port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
  b.cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await b.cdp.send('Page.enable', {}, 90000);
  console.log(`  [ui] target +${tA - b.t0} ms after spawn, Page.enable answered +${Date.now() - b.t0} ms`);
  await waitFor(() => b.cdp.eval('!!document.querySelector(".toolbar")', 60000), 90000, 'the toolbar (an ACTIVE workspace)');
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${VIEWPORT.w}x${VIEWPORT.h}`]); sh('swaymsg', ['default_border', 'none']);
}
const rectOf = (b, sel, nth = 0) => b.cdp.eval(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }; })()`);
async function clickSel(b, sel, nth = 0) { const r = await rectOf(b, sel, nth); if (!r) throw new Error(`no element for ${sel}[${nth}]`); await b.cdp.click(r.x, r.y); return r; }
async function viewTargets(b) { const list = await (await fetch(`http://127.0.0.1:${b.port}/json`)).json(); return list.filter((x) => x.type === 'page' && !x.url.includes('dist/index.html')); }
async function selectWorkspace(b, branch) {
  const idx = await b.cdp.eval(`[...document.querySelectorAll('.ws-item')].findIndex((e) => e.textContent.includes(${JSON.stringify(branch)}))`);
  if (idx < 0) throw new Error(`no sidebar row for ${branch}`);
  await clickSel(b, '.ws-item', idx);
  await waitFor(() => b.cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some((e) => e.textContent.includes(${JSON.stringify(branch)}))`), 15000, `${branch} to be the active workspace`);
  await sleep(500);
}
async function openBrowserPane(b) {
  const sel = 'button.pane-toggle[aria-label="Show browser pane"]';
  if (!(await b.cdp.eval(`!!document.querySelector('.browser-tabs')`))) {
    await waitFor(() => b.cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`), 30000, 'the browser pane toggle');
    await clickSel(b, sel);
  }
  await waitFor(() => b.cdp.eval(`!!document.querySelector('.browser-tabs') && document.querySelectorAll('.browser-tab').length > 0`), 30000, 'the tab strip');
  await waitFor(() => b.cdp.eval(`(() => { const h = document.querySelector('.browser-holder'); if (!h) return false; const r = h.getBoundingClientRect(); return r.width > 100 && r.height > 100; })()`), 15000, 'the browser holder to be laid out');
  await sleep(500);
}
const chip = (b) => b.cdp.eval(`(() => { const e = document.querySelector('[data-browser-profile-chip]'); return e ? { id: e.dataset.profileId, label: e.textContent.trim() } : null; })()`);
async function chooseProfile(b, id) {
  if (!(await b.cdp.eval(`!!document.querySelector('[data-browser-profile-bar]')`))) await clickSel(b, '[data-browser-profile-chip]');
  await waitFor(() => b.cdp.eval(`!!document.querySelector('[data-browser-profile-bar]')`), 10000, 'the profile bar');
  await clickSel(b, `[data-profile-choice="${id}"]`);
  await waitFor(async () => (await chip(b))?.id === id, 20000, `the chip to show profile '${id}'`);
  await sleep(1200);
}
/** run `expr` inside the page of the (single) panel tab of the workspace — the real profile partition's tab */
async function inTab(b, expr, urlPart = '') {
  const t = (await viewTargets(b)).find((x) => x.url.includes(urlPart));
  if (!t) throw new Error(`no tab target containing '${urlPart}' (targets: ${(await viewTargets(b)).map((x) => x.url).join(', ')})`);
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  try { return await c.eval(expr); } finally { c.close(); }
}
async function tabNavigate(b, url, expectText) {
  const t = (await viewTargets(b))[0];
  if (!t) throw new Error('no panel tab target');
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  try {
    await c.send('Page.navigate', { url }, 60000);
    if (expectText) await waitFor(async () => (await c.eval(`document.body ? document.body.innerText : ''`)).includes(expectText), 20000, `the page text '${expectText}'`);
  } finally { c.close(); }
}
/** open the real panel on the profile and wait for the restored tab (a U boot) */
async function openProfileTab(b) {
  await connectUi(b);
  await selectWorkspace(b, 'e2e/fuse-1');
  await openBrowserPane(b);
  await waitFor(async () => (await viewTargets(b)).some((t) => t.url.includes('/home')), 30000, 'the restored /home tab');
}
/** main-process hidden window on a partition (the openLoginWindow webPreferences shape) → run a URL, return the page text */
const windowText = (b, partition, url) => inMain(b, `(async () => {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 560, height: 760, webPreferences: { partition: ${JSON.stringify(partition)}, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  try { await win.loadURL(${JSON.stringify(url)}); return await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""'); } finally { win.destroy(); }
})()`, 60000);
const flushBoth = (b) => inMain(b, `(async () => { const { session } = require('electron'); for (const p of ${JSON.stringify([b.w.profileId ? PROFILE_PART(b.w.profileId) : null, LOGIN_PART].filter(Boolean))}) await session.fromPartition(p).cookies.flushStore(); return true; })()`);

async function quitApp(b, graceful = true) {
  b.cdp?.close();
  // the whole tree is recorded BEFORE the main process dies: its children (the `claude` probe, helpers, keepers) are re-parented the instant it exits
  if (b.appProc) for (const p of descendantsOf(b.appProc.pid)) track(b.w, p);
  if (b.appProc && isAlive(b.appProc.pid, b.appProc.start)) {
    if (graceful) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${b.port}/json/version`)).json();
        const bc = await Cdp.connect(v.webSocketDebuggerUrl);
        bc.send('Browser.close').catch(() => {});
        await waitFor(() => !isAlive(b.appProc.pid, b.appProc.start), 30000, 'graceful exit of the app main process');
        bc.close();
      } catch (e) { console.log(`  graceful quit did not complete: ${e.message}`); }
    }
  }
  if (b.appProc) for (const p of descendantsOf(b.appProc.pid)) track(b.w, p);
}
async function endBoot(b) {
  await quitApp(b, !b.hung); await reapBoot(b);
  // scope-level census: anything of MY scope still carrying this world's paths is a leak (and is killed, by identity, so it cannot fill the scope)
  const marks = [b.w.armDir, `--user-data-dir=${path.join(b.w.oh, 'userData')}`];
  let surv = scopeSurvivors(marks);
  if (surv.length) { for (const x of surv) signalIfSame(x.pid, x.start, 'SIGKILL'); await sleep(500); }
  const still = scopeSurvivors(marks);
  rec({ kind: 'census', run: b.w.run, boot: b.seq, survivorsFound: surv.length, survivorsAfterKill: still.length, sample: surv.slice(0, 3).map((x) => x.cmd), scope: scopeMem() });
  control(`boot/${b.w.run}.${b.seq}/no-process-outlives-the-app`, surv.length === 0 && still.length === 0, `${surv.length} process(es) of this world still alive in the member's scope after the app was reaped (${still.length} after a kill)${surv.length ? ': ' + surv.slice(0, 2).map((x) => x.cmd).join(' | ') : ''}; scope ${((scopeMem()?.current ?? 0) / 2 ** 20).toFixed(0)} MiB, shmem ${((scopeMem()?.shmem ?? 0) / 2 ** 20).toFixed(0)} MiB`, b.w.run);
  const left = [...b.w.tracked].filter(([pid, st]) => isAlive(pid, st)).map(([pid]) => pid); const live = parseUnixSockets(fs.readFileSync('/proc/net/unix', 'utf8')).filter((s) => s.path === b.runDir || s.path.startsWith(b.runDir + path.sep) || s.path.startsWith(b.w.oh + path.sep)); if (left.length || live.length) console.log(`  [warn] boot ${b.seq}: survivors ${left.join(',') || 'none'}; listeners ${live.map((s) => s.path).join(',') || 'none'}`); activeBoot = null; return { survivors: left.length + still.length, listeners: live.length }; }

// ── the Cookies DB oracle: a COPY of the DB after a graceful quit, read with python3 -I (read-only) ──
function readCookieFile(cand, scratchParent) {
  const tmp = fs.mkdtempSync(path.join(scratchParent, 'dbcopy-'));
  for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.copyFileSync(cand + suffix, path.join(tmp, 'Cookies' + suffix)); } catch {} }
  const py = 'import sqlite3,sys,json\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True,timeout=3)\nprint(json.dumps(c.execute("select name,value,length(encrypted_value),hex(substr(encrypted_value,1,3)) from cookies where host_key=\'127.0.0.1\'").fetchall()))\n';
  try { return JSON.parse(sh('python3', ['-I', '-c', py, path.join(tmp, 'Cookies')]).trim()).map(([name, value, encLen, prefix]) => ({ name, value: value ?? '', encLen, prefix: prefix ?? '' })); }
  catch (e) { return { error: String(e.message ?? e).slice(0, 200) }; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function dbRows(w, partition) {
  const base = path.join(w.partitions, partDirName(partition));
  const cand = ['Network/Cookies', 'Cookies'].map((p) => path.join(base, p)).find((p) => fs.existsSync(p));
  return cand ? readCookieFile(cand, w.armDir) : null;
}
/** the Cookies DB FILE of a partition: inode / size / row count / meta table — "rows deleted" and "file replaced" are different findings */
function dbFileFacts(w, partition) {
  const base = path.join(w.partitions, partDirName(partition));
  const f = ['Network/Cookies', 'Cookies'].map((p) => path.join(base, p)).find((p) => fs.existsSync(p));
  if (!f) return null;
  const st = fs.statSync(f);
  const tmp = fs.mkdtempSync(path.join(w.armDir, 'dbfacts-'));
  for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.copyFileSync(f + suffix, path.join(tmp, 'Cookies' + suffix)); } catch {} }
  const py = 'import sqlite3,sys,json\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True,timeout=3)\nprint(json.dumps({"total":c.execute("select count(*) from cookies").fetchone()[0],"meta":c.execute("select key,value from meta").fetchall()}))\n';
  try { return { ino: st.ino, size: st.size, ...JSON.parse(sh('python3', ['-I', '-c', py, path.join(tmp, 'Cookies')]).trim()) }; } catch (e) { return { ino: st.ino, size: st.size, error: String(e.message ?? e).slice(0, 120) }; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const isOldName = (n) => /^(o\d\d|sid|ssid)$/.test(n);
const isNewName = (n) => /^(n\d\d|sidN)$/.test(n);
function recordDb(w, step, branch, before) {
  const got = {};
  for (const [partition, pname] of [['profile', w.profileId ? PROFILE_PART(w.profileId) : null], ['login', LOGIN_PART]]) {
    if (!pname) continue;
    const rows = dbRows(w, pname);
    if (!rows || rows.error) { rec({ kind: 'dbError', run: w.run, step, partition, error: rows?.error ?? 'no Cookies DB on disk' }); continue; }
    got[partition] = rec({ kind: 'db', run: w.run, branch, step, partition, file: dbFileFacts(w, pname), fileBefore: before?.[partition] ?? null, old: statsOf(rows.filter((r) => isOldName(r.name))), new: statsOf(rows.filter((r) => isNewName(r.name))),
      sample: rows.filter((r) => ['sid', 'sidN', 'o00', 'o01', 'n00', 'n01', 'ssid'].includes(r.name)).map((r) => [r.name, r.value === '' ? '' : r.value.slice(0, 24), r.encLen, r.prefix]) });
  }
  return got;
}

/** diagnostic only: delete every encrypted row of both partitions except those named in `keep` (the app is not running) */
function dropEncryptedRows(w, keep) {
  for (const pname of [w.profileId ? PROFILE_PART(w.profileId) : null, LOGIN_PART].filter(Boolean)) {
    const f = ['Network/Cookies', 'Cookies'].map((p) => path.join(w.partitions, partDirName(pname), p)).find((p) => fs.existsSync(p));
    if (!f) throw new Error(`no Cookies DB for ${pname}`);
    const py = 'import sqlite3,sys,json\nkeep=json.loads(sys.argv[2])\nc=sqlite3.connect(sys.argv[1],timeout=3)\nq="delete from cookies where length(encrypted_value)>0"+(" and name not in (%s)"%",".join("?"*len(keep)) if keep else "")\nc.execute(q,keep)\nc.commit()\nprint(c.execute("select count(*) from cookies").fetchone()[0])\n';
    console.log(`  [x] ${partDirName(pname)}: ${sh('python3', ['-I', '-c', py, f, JSON.stringify(keep)]).trim()} rows left after dropping the encrypted rows except ${JSON.stringify(keep)}`);
  }
}

// ── one measured boot ──
// spec: { branch, step, build, keyring, desktop('sway'|'gnome'), timing, ui(bool: real panel tab), writeNew(bool), snapshot? }
async function measuredBoot(w, spec) {
  const desktop = spec.desktop ?? 'sway';
  const mem = memAvailGB();
  if (mem < 6.5) throw new Error(`MemAvailable ${mem.toFixed(1)} GB < 6.5 GB — aborting before the boot (wave memory rule)`);
  // Judge the scope by what the kernel cannot reclaim (anon + shmem): its page cache (400 MB binaries, snapshots) legitimately fills most of the 6 GiB and is dropped under pressure.
  // The guard only ever signals ORPHANS of this rig (ppid 1, never an ancestor of this driver) — an earlier version matched on the rig path alone and SIGKILLed its own gui-slot / contained-rig parents.
  const sm = scopeMem();
  if (sm && sm.max !== Infinity && sm.anonShmem > 0.5 * sm.max) {
    const mine = new Set([process.pid, process.ppid, ...descendantsOf(process.pid)]);
    for (const x of scopeSurvivors([`${path.dirname(RIG_DIR)}/`])) { const st = procStat(x.pid); if (!mine.has(x.pid) && st && Number(fs.readFileSync(`/proc/${x.pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]) === 1) signalIfSame(x.pid, x.start, 'SIGKILL'); }
    await sleep(1500);
    const sm2 = scopeMem();
    if (sm2.anonShmem > 0.65 * sm2.max) throw new Error(`the member's memory scope holds ${(sm2.anonShmem / 2 ** 30).toFixed(1)} of ${(sm2.max / 2 ** 30).toFixed(1)} GiB of anon+shmem (shmem ${(sm2.shmem / 2 ** 30).toFixed(1)}) — refusing to start a boot the kernel would kill`);
  }
  const dbBefore = Object.fromEntries([['profile', w.profileId ? PROFILE_PART(w.profileId) : null], ['login', LOGIN_PART]].filter(([, n]) => n).map(([k, n]) => [k, dbFileFacts(w, n)]));
  const b = await startPrivateWorld(w, spec.keyring, desktop);
  b.desktopKey = desktop;
  activeBoot = b;
  const D = DESKTOPS[desktop];
  // what Chromium's backend should be: unlocked service on the host desktop → libsecret (the app asks for it); locked / absent / basic → basic_text; a recognised desktop picks libsecret by itself
  const backendExpected = desktop === 'gnome' ? (spec.keyring === 'locked' ? null : spec.keyring === 'unlocked' ? 'gnome_libsecret' : spec.keyring === 'none' ? 'basic_text' : 'basic_text') : spec.keyring === 'unlocked' ? 'gnome_libsecret' : 'basic_text';
  const queryBackend = !(desktop === 'gnome' && spec.keyring === 'locked'); // asking safeStorage on a locked libsecret would itself block the main process
  try {
    await bootApp(b, spec.build);
    const fr = await firstRead(b, { wantNew: spec.wantNew, backend: queryBackend, probe: spec.probe !== false });
    const exe = (() => { try { return fs.readlinkSync(`/proc/${b.appProc.pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { return null; } })();
    const wantExe = path.join(spec.build === 'on' ? ON_DIR : OFF_DIR, 'orchestra');
    control(`boot/${w.run}.${b.seq}/${spec.step}/runs-the-${spec.build}-copy`, exe === null ? b.exited !== null : exe === wantExe, `/proc/${b.appProc.pid}/exe → ${exe} (want ${wantExe})`, w.run);
    const crashedEarly = b.exited !== null && !b.hung;
    const gone = fr.out?.gone ?? [];
    const crashed = crashedEarly || gone.some((g) => !/clean-exit/.test(g));
    const tgt = fr.hung ? null : await targetMs(b);
    const decision = (() => { try { return (fs.readFileSync(w.logFile, 'utf8').split('\n').filter((l) => l.includes('[secrets] password-store:')).pop() ?? '').trim(); } catch { return ''; } })();
    rec({ kind: 'boot', run: w.run, branch: spec.branch, step: spec.step, build: spec.build, keyring: spec.keyring, desktop: D.desktop, scope: D.scope, timing: !!spec.timing, readyMs: fr.readyMs, targetMs: tgt, scopeMemMB: Math.round((scopeMem()?.current ?? 0) / 2 ** 20), load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]),
      tReadMs: fr.out?.tReadMs ?? null, tProbeMs: fr.out?.tProbeMs ?? null, crashed, hung: fr.hung, exit: b.exited, gone, keyringOk: b.keyringOk !== false, backend: queryBackend ? (fr.out?.backend ?? null) : null, backendExpected: queryBackend ? backendExpected : null, decision,
      itemsInKeyring: b.hasBus && spec.keyring !== 'none' ? itemCount(b) : null, err: fr.err ? String(fr.err.message).slice(0, 200) : null, raceRetries: b.raceRetries ?? 0 });
    console.log(`  [boot ${w.run}.${b.seq}] ${spec.step} ${spec.build}/${spec.keyring}/${desktop}: ready ${fr.readyMs} ms (target ${tgt} ms; read ${fr.out?.tReadMs} ms, probe flush ${fr.out?.tProbeMs} ms) backend=${fr.out?.backend} ${fr.hung ? 'HUNG' : ''}${crashed ? 'CRASHED' : ''}`);
    if (fr.hung || !fr.out) { await endBoot(b); return { b, fr, crashed, hung: fr.hung, jars: null }; }
    // the jar the app read at startup = the 'pre' record
    const jars = {};
    for (const [partition, pname] of [['profile', w.profileId ? PROFILE_PART(w.profileId) : null], ['login', LOGIN_PART]]) { if (pname) jars[partition] = jarCounts(w, fr.out.jars[pname] ?? [], partition); }
    // login kept = /whoami returns the OLD sid, asked from a page of each partition (the profile's also from the real panel tab when the UI is up)
    const who = {};
    for (const [partition, pname] of [['profile', w.profileId ? PROFILE_PART(w.profileId) : null], ['login', LOGIN_PART]]) { if (pname) who[partition] = await windowText(b, pname, `${BASE()}/whoami`).catch((e) => `error:${e.message.slice(0, 60)}`); }
    let whoTab = null;
    if (spec.ui && w.profileId) {
      try { await openProfileTab(b); whoTab = await inTab(b, `fetch('/whoami', { cache: 'no-store' }).then((r) => r.text())`, '/home'); } catch (e) { whoTab = `error:${String(e.message).slice(0, 80)}`; }
    }
    const oldSid = `sid-${w.nonce}`;
    for (const partition of Object.keys(jars)) {
      rec({ kind: 'jar', run: w.run, branch: spec.branch, step: spec.step, phase: 'pre', partition, oldExpected: jars[partition].old.expected, oldReadable: jars[partition].old.readable, newExpected: spec.wantNew ? jars[partition].new.expected : 0, newReadable: spec.wantNew ? jars[partition].new.readable : 0,
        loginKept: who[partition] === oldSid && (partition !== 'profile' || whoTab === null || whoTab === oldSid), whoami: who[partition], whoamiTab: partition === 'profile' ? whoTab : undefined });
    }
    // new cookies written in THIS boot (arms that test the writing side)
    if (spec.writeNew) {
      const url = `${BASE()}/signin?tag=n&n=${N_COOKIES}&sidName=sidN&r=${w.nonce}`;
      if (spec.ui && w.profileId) { await tabNavigate(b, url, 'signed-in n'); await tabNavigate(b, `${BASE()}/home?after=${spec.step}`, 'home'); }
      else if (w.profileId) await windowText(b, PROFILE_PART(w.profileId), url);
      await windowText(b, LOGIN_PART, url);
      await sleep(2500); await flushBoth(b);
      const post = JSON.parse(await inMain(b, jarJs(w.profileId, { probe: false, backend: false })));
      for (const [partition, pname] of [['profile', w.profileId ? PROFILE_PART(w.profileId) : null], ['login', LOGIN_PART]]) {
        if (!pname) continue;
        const c = jarCounts(w, post.jars[pname] ?? [], partition);
        rec({ kind: 'jar', run: w.run, branch: spec.branch, step: spec.step, phase: 'post', partition, oldExpected: c.old.expected, oldReadable: c.old.readable, newExpected: c.new.expected, newReadable: c.new.readable, loginKept: true });
      }
    }
    const tail = await endBoot(b);
    recordDb(w, spec.step, spec.branch, dbBefore);
    return { b, fr, crashed, hung: false, jars, tail };
  } catch (e) {
    rec({ kind: 'bootError', run: w.run, step: spec.step, error: String(e.stack ?? e).slice(0, 600) });
    console.log(`  [boot ${w.run}.${b.seq}] ${spec.step} ABORTED: ${e.message}`);
    await endBoot(b).catch(() => {});
    throw e;
  }
}

// ── W1: the stock install that wrote the old cookies (fuse OFF), driven through the real UI ──
async function stageW1(w) {
  console.log(`\n── run ${w.run} · W1 (fuse OFF writes the pre-existing cookies) ──`);
  const b = await startPrivateWorld(w, 'unlocked', 'sway'); b.desktopKey = 'sway'; activeBoot = b;
  try {
    await bootApp(b, 'off');
    const early = await firstRead(b, { probe: false, backend: true }); // fuse OFF + unlocked boot time, BEFORE the UI work (informational: timing=false)
    await connectUi(b);
    const id = await b.cdp.eval(`window.orchestra.browserProfileCreate('Fuse407').then((r) => r.profile?.id ?? null)`);
    if (!id) throw new Error('browserProfileCreate returned no profile id');
    w.profileId = id;
    await selectWorkspace(b, 'e2e/fuse-1');
    await openBrowserPane(b);
    await chooseProfile(b, id);
    // NULL controls of the login oracle: before any sign-in /whoami must read `anon` from BOTH partitions (an oracle that always says "signed in" proves nothing)
    const anonP = await windowText(b, PROFILE_PART(id), `${BASE()}/whoami`), anonL = await windowText(b, LOGIN_PART, `${BASE()}/whoami`);
    control(`W1/${w.run}/whoami-reads-anon-before-any-sign-in`, anonP === 'anon' && anonL === 'anon', `/whoami before the sign-in: profile=${anonP} login=${anonL}`, w.run);
    await tabNavigate(b, `${BASE()}/signin?tag=o&n=${N_COOKIES}&sidName=sid&r=${w.nonce}&session=1`, 'signed-in o');
    await sleep(2500); // #400 promotes the session cookie (debounced 250 ms) and flushes 1.5 s later
    await tabNavigate(b, `${BASE()}/home?ws=1`, 'home');
    await windowText(b, LOGIN_PART, `${BASE()}/signin?tag=o&n=${N_COOKIES}&sidName=sid&r=${w.nonce}`);
    await sleep(2000); await flushBoth(b);
    const fr = { out: JSON.parse(await inMain(b, jarJs(id, { probe: false, backend: false }))) };
    for (const [partition, pname] of [['profile', PROFILE_PART(id)], ['login', LOGIN_PART]]) {
      const c = jarCounts(w, fr.out.jars[pname] ?? [], partition);
      rec({ kind: 'jar', run: w.run, branch: 'W', step: 'W1', phase: 'post', partition, oldExpected: c.old.expected, oldReadable: c.old.readable, newExpected: 0, newReadable: 0, loginKept: true });
      control(`W1/${w.run}/${partition}-signed-in-by-the-stock-build`, c.old.readable === c.old.expected, `${c.old.readable}/${c.old.expected} cookies in the ${partition} jar after the sign-in`, w.run);
      control(`W1/${w.run}/${partition}-jar-oracle-reads-never-written-cookies-as-absent`, c.new.readable === 0, `the ${c.new.expected} "new" cookies were never written: the jar oracle reads ${c.new.readable} of them (must be 0 — else "readable" means nothing)`, w.run);
    }
    rec({ kind: 'boot', run: w.run, branch: 'W', step: 'W1', build: 'off', keyring: 'unlocked', desktop: 'sway', scope: 'host', timing: false, readyMs: early.readyMs, targetMs: null, crashed: false, hung: false, keyringOk: b.keyringOk !== false, backend: early.out?.backend ?? null, backendExpected: 'gnome_libsecret', decision: '', load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) });
    await endBoot(b);
    const w1 = recordDb(w, 'W1', 'W');
    control(`W1/${w.run}/profile-session-cookie-was-promoted-to-disk`, w1.profile?.old.total === N_COOKIES + 2, `profile DB holds ${w1.profile?.old.total} old rows (want ${N_COOKIES + 2}: ${N_COOKIES} + sid + the promoted session cookie ssid — else a later "lost" ssid would be #400's, not the fuse's)`, w.run);
    control(`W1/${w.run}/login-DB-holds-the-old-cookies`, w1.login?.old.total === N_COOKIES + 1, `login DB holds ${w1.login?.old.total} old rows (want ${N_COOKIES + 1})`, w.run);
    snapshot(w, 'W');
    console.log(`  [W1] profile ${id}; snapshot W taken`);
  } catch (e) { await endBoot(b).catch(() => {}); throw e; }
}

// ── arm `warn` (#407 phase 2): the Settings > Browser at-rest warning must follow the REAL state — the fuse of the binary that runs × the keyring backend ──
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const WARN_CASES = [
  { id: 'off-unlocked', build: 'off', keyring: 'unlocked' },
  { id: 'off-basic', build: 'off', keyring: 'basic' },
  { id: 'on-unlocked', build: 'on', keyring: 'unlocked' },
  { id: 'on-basic', build: 'on', keyring: 'basic' },
  { id: 'on-locked', build: 'on', keyring: 'locked' },
];
const warnShots = [];
async function stageWarn(w) {
  console.log(`\n── run ${w.run} · warn (Settings > Browser at-rest warning vs the real state; packaged app, scratch world) ──`);
  const { extractFile } = createRequire(import.meta.url)(createRequire(import.meta.url).resolve('@electron/asar', { paths: [path.dirname(createRequire(import.meta.url).resolve('app-builder-lib/package.json', { paths: [path.dirname(createRequire(import.meta.url).resolve('electron-builder/package.json', { paths: [repoRoot] }))] }))] }));
  const store = JSON.parse(fs.readFileSync(path.join(w.oh, 'userData/orchestra/store.json'), 'utf8'));
  control(`warn/${w.run}/account-pinned-to-a-scratch-config-dir`, store.workspaces[0].accountId === store.accounts[0].id && checkScratch(store.accounts[0].configDir).ok, `workspace.accountId=${store.workspaces[0].accountId} account.id=${store.accounts[0].id} configDir=${store.accounts[0].configDir} (scratch under the rig, never a live ~/.claude*)`, w.run);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  for (const c of WARN_CASES) {
    const b = await startPrivateWorld(w, c.keyring, 'sway'); b.desktopKey = 'sway'; activeBoot = b;
    try {
      await bootApp(b, c.build);
      await connectUi(b);
      const dir = c.build === 'on' ? ON_DIR : OFF_DIR;
      // ARTIFACT IDENTITY: the running thing says what it is — version, the exe, and the renderer bundle it SERVED, byte-equal to the one inside the copy's own app.asar (and to the worktree dist under test)
      const ver = await b.cdp.eval('window.orchestra.getAppVersion()'), built = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
      const target = (await (await fetch(`http://127.0.0.1:${b.port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html'));
      const srcs = await b.cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`), bundle = srcs.find((x) => /assets\/index-.*\.js/.test(x));
      const frameId = (await b.cdp.send('Page.getResourceTree')).frameTree.frame.id, rc = await b.cdp.send('Page.getResourceContent', { frameId, url: bundle });
      const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8'), inAsar = extractFile(path.join(dir, 'resources/app.asar'), `dist/assets/${bundle.split('/assets/')[1]}`);
      const exe = fs.readlinkSync(`/proc/${b.appProc.pid}/exe`);
      const distFile = WORKTREE_DIST ? path.join(WORKTREE_DIST, 'assets', bundle.split('/assets/')[1]) : null;
      control(`warn/${w.run}/${c.id}/identity`, ver === built && exe === path.join(dir, 'orchestra') && target.url.includes(dir) && md5(served) === md5(inAsar) && (!distFile || (fs.existsSync(distFile) && md5(fs.readFileSync(distFile)) === md5(served))),
        `running version ${ver} vs built ${built}; /proc exe ${exe}; target url ${target.url}; served bundle md5 ${md5(served)} == the copy's app.asar (${md5(inAsar)})${distFile ? ` == worktree dist (${fs.existsSync(distFile) ? md5(fs.readFileSync(distFile)) : 'MISSING'})` : ''}`, w.run);
      // the surface: Settings > Browser with one profile on record (so the per-row tag has a row to sit on)
      const pre = await b.cdp.eval(`({ dialog: !!document.querySelector('[data-bp-settings]'), warn: document.querySelector('[data-profile-warning="create"]')?.textContent ?? null })`);
      await b.cdp.eval(`window.orchestra.browserProfileCreate('Warn probe').then((r) => r.ok)`);
      await clickSel(b, '[data-bp-open]');
      await waitFor(() => b.cdp.eval(`!!document.querySelector('[data-bp-settings]')`), 10000, 'Settings > Browser');
      await waitFor(() => b.cdp.eval(`!!document.querySelector('.bp-row')`), 10000, 'the profile row');
      const first = await b.cdp.eval(`({ warn: document.querySelector('[data-profile-warning="create"]')?.textContent ?? null, tag: !!document.querySelector('[data-profile-unencrypted]') })`); // right after opening: the state may still be loading
      const state = { fuse: c.build === 'on' ? 'enabled' : 'disabled', backendEncrypted: c.keyring === 'unlocked' };
      const want = profileAtRestWarning(state);
      const real = await b.cdp.eval(`Promise.all([window.orchestra.browserProfileAtRest ? window.orchestra.browserProfileAtRest() : { fuse: 'no-such-api' }, window.orchestra.getSecretsState()]).then(([r, s]) => ({ fuse: r.fuse, encrypted: s.encrypted, backend: s.backend }))`); // a build without the channel (the #400 baseline = the must-FAIL arm) reports 'no-such-api'
      await sleep(1200); // let the dialog's own effect settle
      const post = await b.cdp.eval(`(() => { const w = document.querySelector('[data-profile-warning="create"]'); const m = document.querySelector('[data-bp-settings]'); const r = (e) => { if (!e) return null; const x = e.getBoundingClientRect(); return { left: x.left, top: x.top, right: x.right, bottom: x.bottom, inside: x.left >= 0 && x.top >= 0 && x.right <= innerWidth && x.bottom <= innerHeight }; }; return { warn: w?.textContent ?? null, tag: !!document.querySelector('[data-profile-unencrypted]'), tagTitle: document.querySelector('[data-profile-unencrypted]')?.title ?? null, warnRect: r(w), dialogRect: r(m) }; })()`);
      const shot = Buffer.from((await b.cdp.send('Page.captureScreenshot', { format: 'png' }, 25000)).data, 'base64');
      const shotFile = path.join(SHOTS_DIR, `407-warning-${c.id}.png`); fs.writeFileSync(shotFile, shot); warnShots.push({ id: c.id, file: shotFile, md5: md5(shot), bytes: shot.length });
      const shown = post.warn === null ? null : post.warn.replace(/^⚠\s*/, ''); // textContent also carries the icon span
      const exactlyWant = want === null ? shown === null && !post.tag : shown === want && post.tag && post.tagTitle === want;
      const literal = c.build === 'off' ? /UNENCRYPTED on disk/.test(shown ?? '') : c.keyring === 'unlocked' ? shown === null : /scrambled on disk/.test(shown ?? '');
      rec({ kind: 'warn', run: w.run, case: c.id, build: c.build, keyring: c.keyring, real, pre, first, post, want, shot: shotFile, shotMd5: md5(shot) });
      control(`warn/${w.run}/${c.id}/real-state-reaches-the-dialog`, real.fuse === state.fuse && real.encrypted === state.backendEncrypted && exactlyWant && literal && (post.warnRect?.inside ?? true) && post.dialogRect?.inside === true,
        `real state fuse=${real.fuse} encrypted=${real.encrypted} (${real.backend}) → pre-open warning ${JSON.stringify(pre.warn)} / just-opened ${JSON.stringify(first.warn?.slice(0, 40) ?? null)} → settled ${JSON.stringify(post.warn?.slice(0, 70) ?? null)}; row tag ${first.tag} → ${post.tag}; warning rect inside viewport ${post.warnRect?.inside ?? 'n/a (none shown)'}; dialog inside ${post.dialogRect?.inside}; screenshot ${shotFile}`, w.run);
      console.log(`  [warn ${c.id}] ${shotFile} (${shot.length} bytes, md5 ${md5(shot)})`);
    } finally { await endBoot(b).catch(() => {}); }
  }
  // three different UIs (fuse OFF → always-on warning · ON + keyring → none · ON + basic_text → "scrambled"): their captures must differ; ON+locked IS the same UI as ON+basic (both basic_text) and must be byte-equal to it
  const m = Object.fromEntries(warnShots.map((x) => [x.id, x.md5]));
  const classes = [m['off-unlocked'], m['on-unlocked'], m['on-basic']];
  control(`warn/${w.run}/screenshots-distinct-per-ui-and-equal-where-the-ui-is-the-same`, new Set(classes).size === 3 && m['on-locked'] === m['on-basic'] && warnShots.every((x) => x.bytes > 5000), `off/unlocked ${m['off-unlocked']} · on/unlocked ${m['on-unlocked']} · on/basic ${m['on-basic']} (3 distinct: ${new Set(classes).size === 3}) · on/locked ${m['on-locked']} (== on/basic: ${m['on-locked'] === m['on-basic']})`, w.run);
}

// ── the arms of one run ──
async function runOnce(run) {
  const w = seedWorld(run);
  const t0 = Date.now();
  if (ARMS.has('warn')) await stageWarn(w);
  if ([...ARMS].every((a) => a === 'warn')) { console.log(`  [run ${run}] done in ${Math.round((Date.now() - t0) / 1000)} s`); return; }
  await stageW1(w);
  const B = (branch, step, build, keyring, extra = {}) => ({ branch, step, build, keyring, ...extra });
  // A1 (fuse ON, unlocked) → snapshot A1; every later arm restores A1 so each starts from the SAME bytes
  if (['a', 'd', 'c2', 'x'].some((a) => ARMS.has(a))) {
    console.log(`\n── run ${run} · A1 (fuse ON, unlocked keyring: pre-existing cookies kept? new ones encrypted?) ──`);
    restore(w, 'W');
    await measuredBoot(w, B('A', 'A1', 'on', 'unlocked', { ui: true, writeNew: true, wantNew: false }));
    snapshot(w, 'A1');
    console.log(`\n── run ${run} · A2 (restore CONTROL: A1's bytes, restored, same state) ──`);
    restore(w, 'A1');
    await measuredBoot(w, B('A', 'A2', 'on', 'unlocked', { ui: true, wantNew: true }));
    if (ARMS.has('d')) {
      console.log(`\n── run ${run} · D1/D2 (the fuse back OFF over A1's bytes, then ON again) ──`);
      restore(w, 'A1');
      await measuredBoot(w, B('A', 'D1', 'off', 'unlocked', { ui: true, wantNew: true }));
      await measuredBoot(w, B('A', 'D2', 'on', 'unlocked', { ui: true, wantNew: true }));
    }
  }
  if (ARMS.has('c2')) {
    console.log(`\n── run ${run} · C2 (cookies sealed under the unlocked keyring meet it locked / absent / basic_text; then unlocked) ──`);
    restore(w, 'A1');
    await measuredBoot(w, B('C2', 'C2L', 'on', 'locked', { ui: true, wantNew: true }));
    await measuredBoot(w, B('C2', 'C2U', 'on', 'unlocked', { ui: true, wantNew: true }));
    restore(w, 'A1');
    await measuredBoot(w, B('C2', 'C2N', 'on', 'none', { ui: false, wantNew: true }));
    await measuredBoot(w, B('C2', 'C2NU', 'on', 'unlocked', { ui: false, wantNew: true }));
    restore(w, 'A1');
    await measuredBoot(w, B('C2', 'C2B', 'on', 'basic', { ui: false, wantNew: true }));
    await measuredBoot(w, B('C2', 'C2BU', 'on', 'unlocked', { ui: false, wantNew: true }));
  }
  if (ARMS.has('x')) {
    console.log(`\n── run ${run} · X (diagnostic decomposition on A1's bytes: how many undecryptable rows does it take?) ──`);
    restore(w, 'A1'); dropEncryptedRows(w, ['n00']);
    await measuredBoot(w, B('X', 'X1', 'on', 'locked', { ui: false, wantNew: true }));   // plaintext + ONE keyring-sealed row, keyring locked
    restore(w, 'A1'); dropEncryptedRows(w, ['n00']);
    await measuredBoot(w, B('X', 'X2', 'on', 'unlocked', { ui: false, wantNew: true }));  // the same manipulated DB, keyring unlocked (control: it is a valid DB)
    restore(w, 'A1'); dropEncryptedRows(w, []);
    await measuredBoot(w, B('X', 'X3', 'on', 'locked', { ui: false, wantNew: true }));   // plaintext only, keyring locked (control)
    // is it the failed LOAD or the first WRITE after it that deletes the rows? a locked start that writes nothing, then an unlocked one
    restore(w, 'A1');
    await measuredBoot(w, B('X', 'X4', 'on', 'locked', { ui: false, wantNew: true, probe: false }));
    await measuredBoot(w, B('X', 'X5', 'on', 'unlocked', { ui: false, wantNew: true, probe: false }));
  }
  if (ARMS.has('y')) {
    console.log(`\n── run ${run} · Y (diagnostic: the fuse ON but the key pinned to basic_text from the first start — v10 rows only) ──`);
    restore(w, 'W');
    await measuredBoot(w, B('Y', 'Y1', 'on', 'basic', { ui: false, writeNew: true, wantNew: false }));
    await measuredBoot(w, B('Y', 'Y1b', 'on', 'basic', { ui: false, wantNew: true }));            // the key pinned to basic_text at EVERY start: restart + write, still whole?
    // no probe write from here on: under the unlocked keyring the probe cookie itself would be sealed with the keyring key (v11) and poison the chain
    await measuredBoot(w, B('Y', 'Y2', 'on', 'unlocked', { ui: false, wantNew: true, probe: false }));
    await measuredBoot(w, B('Y', 'Y3', 'on', 'locked', { ui: false, wantNew: true, probe: false }));
    await measuredBoot(w, B('Y', 'Y4', 'on', 'none', { ui: false, wantNew: true, probe: false }));
  }
  if (ARMS.has('c')) {
    console.log(`\n── run ${run} · (c) fuse ON with the keyring locked / absent / basic_text, interleaved with fuse-OFF baselines (alternating order) ──`);
    const odd = run % 2 === 1;
    // each entry: a boot restored from snapshot W; ON boots also write new cookies, OFF baselines are timing only
    const plan = [];
    const onBoot = (branch, step, keyring) => ({ ...B(branch, step, 'on', keyring, { timing: true, ui: false, writeNew: true, wantNew: false }) });
    const offBoot = (step, keyring) => ({ ...B('S', step, 'off', keyring, { timing: true, ui: false }) });
    // locked: odd runs OFF · ON · OFF, even runs ON · OFF · ON  (the same-arm pair of every run is the NULL control)
    plan.push(...(odd ? [offBoot('S-locked-1', 'locked'), onBoot('CL', 'CL1', 'locked'), offBoot('S-locked-2', 'locked')] : [onBoot('CL', 'CL1', 'locked'), offBoot('S-locked-1', 'locked'), { ...onBoot('S', 'S-locked-2', 'locked'), writeNew: false }]));
    plan.push(...(odd ? [offBoot('S-none-1', 'none'), onBoot('CN', 'CN1', 'none')] : [onBoot('CN', 'CN1', 'none'), offBoot('S-none-1', 'none')]));
    plan.push(...(odd ? [offBoot('S-basic-1', 'basic'), onBoot('CB', 'CB1', 'basic')] : [onBoot('CB', 'CB1', 'basic'), offBoot('S-basic-1', 'basic')]));
    for (const s of plan) { restore(w, 'W'); await measuredBoot(w, s); }
  }
  if (ARMS.has('gnome')) {
    console.log(`\n── run ${run} · (extra) recognised desktop (GNOME): Chromium picks libsecret itself; keyring locked ──`);
    const odd = run % 2 === 1;
    const seq = odd ? [['S', 'S-gnome-locked-1', 'off'], ['GL', 'GL1', 'on']] : [['GL', 'GL1', 'on'], ['S', 'S-gnome-locked-1', 'off']];
    for (const [branch, step, build] of seq) { restore(w, 'W'); await measuredBoot(w, B(branch, step, build, 'locked', { desktop: 'gnome', timing: true, ui: false, writeNew: build === 'on', wantNew: false })); }
    // can the GNOME arm reach libsecret AT ALL here? unlocked keyring on the recognised desktop: Chromium's own choice must be gnome_libsecret and the new rows v11
    restore(w, 'W');
    await measuredBoot(w, B('GU', 'GU1', 'on', 'unlocked', { desktop: 'gnome', timing: false, ui: false, writeNew: true, wantNew: false }));
  }
  console.log(`  [run ${run}] done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

// ── the must-FAIL preflight arm: the driver's own entry, run with a HOSTILE env, must be REFUSED before anything starts ──
function runForged() {
  console.log('\n── forged (must-FAIL preflight: a forced real XDG_RUNTIME_DIR / DBUS address / env value must be REFUSED) ──');
  const human = humanRuntimeDir(UID);
  const rootBefore = fs.readdirSync(RIG_XDG).sort().join(',');
  const hidden = hiddenWorldProof();
  const child = (mut, extra = []) => {
    const env = { ...process.env, ...(hidden ? { RIG_HIDDEN_WORLD: '1' } : {}) }; mut(env);
    const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', fs.realpathSync(process.argv[1]), '--preflight-only', ...extra], { env, encoding: 'utf8', timeout: 20000 });
    return { rc: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ctl = child(() => {});
  control('forged/the-true-rig-env-passes-the-same-entry', ctl.rc === 0 && /PREFLIGHT-OK/.test(ctl.out), `--preflight-only under THIS driver's own env → rc ${ctl.rc}: ${ctl.out.trim().split('\n').pop()}`);
  const forged = {
    'real-xdg': [(e) => { e.XDG_RUNTIME_DIR = human; }, /human's runtime dir/],
    'real-dbus': [(e) => { e.DBUS_SESSION_BUS_ADDRESS = `unix:path=${human}/bus`; }, /dbus-is-the-rigs-nonexistent-address/],
    'unset-dbus': [(e) => { delete e.DBUS_SESSION_BUS_ADDRESS; }, /dbus-is-the-rigs-nonexistent-address/],
    'stray-keyring-control': [(e) => { e.GNOME_KEYRING_CONTROL = `${human}/keyring`; }, /no-env-value-reaches-the-human-runtime/],
    'x11': [(e) => { e.DISPLAY = ':0'; }, /display-is-a-bare-private-name/],
    'not-hidden': [(e) => { delete e.RIG_HIDDEN_WORLD; }, /hidden-world/],
  };
  for (const [name, [mut, why]] of Object.entries(forged)) {
    const r = child(mut);
    control(`forged/${name}-is-refused`, r.rc === 3 && /^REFUSED: /m.test(r.out) && why.test(r.out) && !/PREFLIGHT-OK/.test(r.out), `rc ${r.rc} (3 = REFUSED), wanted ${why}: ${r.out.trim().split('\n').pop().slice(0, 200)}`);
  }
  const rootAfter = fs.readdirSync(RIG_XDG).sort().join(',');
  control('forged/nothing-was-started', rootAfter === rootBefore, `rig runtime root before [${rootBefore}] / after [${rootAfter}]`);
}

// ── host files that must stay byte-equal (G10): config / secrets of the human's Orchestra and Claude, never a keyring file, bus or runtime dir ──
function liveFiles() {
  const out = []; const add = (p) => { try { if (fs.statSync(p).isFile()) out.push(p); } catch {} };
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) for (const f of ['settings.json', 'settings.local.json']) add(path.join(d, f));
  for (const base of [path.join(LIVE_HOME, '.config/orchestra'), path.join(LIVE_HOME, '.orchestra')]) { try { for (const f of sh('find', [base, '-maxdepth', '4', '-name', 'secrets.json', '-type', 'f'], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)) add(f); } catch {} }
  return out.sort();
}
const liveHash = () => Object.fromEntries(liveFiles().map((f) => [f, sha(fs.readFileSync(f))]));

/** CONTROL: the DB reader + census say "sealed" on a row known to be sealed (a stuck-RED oracle would turn every (a) into a finding) */
function syntheticOracleControl() {
  const dir = path.join(RIG_DIR, 'synthetic'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Cookies');
  const py = 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute("create table cookies(host_key text,name text,value text,encrypted_value blob)")\nrows=[("127.0.0.1","o00","plainval",b""),("127.0.0.1","n00","",b"v11"+bytes(40)),("127.0.0.1","n01","",b"v10"+bytes(40)),("127.0.0.1","n02","both",b"v11"+bytes(40)),("127.0.0.1","n03","",b"")]\nc.executemany("insert into cookies values (?,?,?,?)",rows)\nc.commit()\n';
  sh('python3', ['-I', '-c', py, file]);
  const rows = readCookieFile(file, dir);
  const st = Array.isArray(rows) ? statsOf(rows) : null;
  const want = { total: 5, plain: 1, encrypted: 2, both: 1, empty: 1, v10: 1, v11: 2, other: 0 };
  control('oracle/reads-a-synthetic-sealed-row-as-sealed', !!st && JSON.stringify(st) === JSON.stringify(want), `census of a hand-built Cookies DB (1 plain, 1 v11, 1 v10, 1 value+blob, 1 empty) = ${JSON.stringify(st ?? rows)}`);
}

/** CONTROL: the timer reads a KNOWN stall in the very path the arms judge — the network service (which loads / flushes the cookie store) is SIGSTOPped for 3 s around the first jar read */
async function stallControl() {
  const STALL_MS = 3000;
  const w = seedWorld(0);
  w.profileId = null;
  const run1 = async (stop) => {
    const b = await startPrivateWorld(w, 'basic', 'sway'); b.desktopKey = 'sway'; activeBoot = b;
    try {
      await bootApp(b, 'off');
      let stopped = null;
      if (stop) {
        await waitFor(async () => (await (await fetch(`http://127.0.0.1:${b.port}/json`)).json()).some((x) => x.type === 'page' && x.url.includes('dist/index.html')), 60000, 'the renderer (so the network service exists)');
        const ns = await waitFor(() => descendantsOf(b.appProc.pid).map((p) => ({ p, c: readNul(`/proc/${p}/cmdline`).join(' ') })).find((x) => x.c.includes('network.mojom.NetworkService')), 20000, 'the network service process');
        const st = procStat(ns.p);
        process.kill(ns.p, 'SIGSTOP'); stopped = { pid: ns.p, start: st.start };
        setTimeout(() => signalIfSame(stopped.pid, stopped.start, 'SIGCONT'), STALL_MS);
      }
      const t0 = Date.now();
      const fr = await firstRead(b, { probe: true, backend: false });
      return { ms: Date.now() - t0, readyMs: fr.readyMs, ok: !!fr.out };
    } finally { if (b.appProc) for (const p of descendantsOf(b.appProc.pid)) track(w, p); await endBoot(b).catch(() => {}); }
  };
  await run1(false); // warm-up: the first start after the wrapper reads a cold 400 MB binary
  const base = await run1(false);
  const stalled = await run1(true);
  const delta = stalled.ms - base.ms;
  // the stalled read cannot finish before the resume, so it must read ≥ 95 % of the injected stall; the normal read (a few hundred ms, load-dependent) only has to be clearly shorter
  control('instrument/reads-a-known-stall', base.ok && stalled.ok && stalled.ms >= 0.95 * STALL_MS && stalled.ms <= 3 * STALL_MS && delta >= 0.5 * STALL_MS, `first jar read + probe flush: ${base.ms} ms normally vs ${stalled.ms} ms with the network service SIGSTOPped for ${STALL_MS} ms → reads ${stalled.ms} ms (want ${0.95 * STALL_MS}–${3 * STALL_MS}), Δ ${delta} ms (want ≥ ${0.5 * STALL_MS})`);
}

async function main() {
  const before = liveHash();
  console.log(`[host] ${Object.keys(before).length} live config/secrets files hashed; MemAvailable ${memAvailGB().toFixed(1)} GB; arms ${[...ARMS].join(',')}; runs ${RUNS}`);
  if (memAvailGB() < 8) { console.log('REFUSED: MemAvailable < 8 GB — a rig that raises memory sizes itself first'); process.exit(3); }
  runForged();
  const wireNow = () => Object.fromEntries([['off', OFF_DIR], ['on', ON_DIR]].map(([k, d]) => { const r = readFuseWireFile(path.join(d, 'orchestra')); return [k, r.ok ? r.fuses.EnableCookieEncryption : `unreadable: ${r.reason}`]; }));
  const wire0 = wireNow();
  control('wire/driver-reads-off-disabled-on-enabled', wire0.off === 'disabled' && wire0.on === 'enabled', `fuse wires read by the DRIVER from the two copies before the run: off=${wire0.off} on=${wire0.on} (independent of the wrapper's meta)`);
  const meta = META_FILE && fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf8')) : null;
  if (meta) rec({ kind: 'meta', ...meta });
  else control('meta/present', false, `--meta ${META_FILE} not found (scripts/e2e-cookie-fuse.sh writes it: fuse wires + byte diff of the two copies)`);
  rec({ kind: 'host', node: process.version, kernel: sh('uname', ['-r']).trim(), cpus: sh('nproc').trim(), memAvailGB: Number(memAvailGB().toFixed(1)), load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]), runs: RUNS, arms: [...ARMS], label: LABEL,
    git: (() => { try { return sh('git', ['-C', repoRoot, 'rev-parse', 'HEAD']).trim(); } catch { return null; } })() });
  const site = await startSite();
  console.log(`[rig] fixture on ${BASE()}`);
  syntheticOracleControl();
  try { await stallControl(); } catch (e) { control('instrument/reads-a-known-stall', false, `ABORTED: ${String(e.message ?? e).slice(0, 200)}`); }
  // A run that dies on INFRASTRUCTURE (the renderer never answered, a CDP timeout — the box runs ~20 other agents) is retried from a fresh world under a new run id; the aborted attempt stays in the
  // file as `runAborted` (reason + last step) and is excluded from the verdict, which reports the count. Three attempts per planned run, then a red control.
  let runId = RUN_OFFSET;
  for (let planned = 1; planned <= RUNS; planned++) {
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const run = ++runId;
      try { await runOnce(run); done = true; }
      catch (e) {
        rec({ kind: 'runAborted', run, planned, attempt, reason: String(e.message ?? e).slice(0, 300) });
        console.log(`  [run ${run}] ABORTED (planned run ${planned}, attempt ${attempt}/3): ${String(e.message ?? e).slice(0, 200)}`);
        await sleep(3000);
      }
    }
    if (!done) control(`run/${planned}/completed`, false, 'all 3 attempts aborted on infrastructure');
  }
  site.close();
  const wire1 = wireNow();
  control('wire/copies-unchanged-by-the-run', JSON.stringify(wire0) === JSON.stringify(wire1), `fuse wires after the run: off=${wire1.off} on=${wire1.on}`);
  const after = liveHash();
  control('host-files-byte-equal-whole-run', JSON.stringify(before) === JSON.stringify(after), `${Object.keys(before).length} host files before/after the whole run: ${JSON.stringify(before) === JSON.stringify(after) ? 'identical' : 'CHANGED'}`);
  const hiddenEntries = fs.readdirSync(humanRuntimeDir(UID));
  control('hidden-runtime-dir-stayed-empty', hiddenEntries.length === 0, `entries created in the hidden stand-in of the human's runtime dir: [${hiddenEntries.join(' ')}]`);
  const census = rootCensusChecks(fs.readdirSync(RIG_XDG).map((n) => (/^k-\d+-\d+$/.test(n) ? 'k' : n)), ['k']);
  for (const c of census) control(`world/${c.id}`, c.ok, c.detail);
}

await main();
rec({ kind: 'end', clauses: clauses.length, red: clauses.filter((c) => !c.ok).length }); // its absence = this invocation was killed before it finished
const result = computeVerdict(records);
console.log(`\n== ${records.length} records → ${JSONL}`);
console.log(`VERDICT (mechanical, src/shared/cookie-fuse-verdict.ts): ${result.verdict}  [all scopes: ${result.scopes.all} · host scope only: ${result.scopes.host}]`);
for (const r of result.reasons) console.log(`  - ${r}`);
console.log(JSON.stringify(result.numbers));
const red = clauses.filter((c) => !c.ok);
console.log(`\n${red.length === 0 ? `ALL ${clauses.length} CONTROL CLAUSES GREEN` : `RED CONTROLS: ${red.map((c) => c.name).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
