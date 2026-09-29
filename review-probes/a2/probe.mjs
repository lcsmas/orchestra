// Track A2 (ledger #224) — keeper lifecycle: #201 delete stops session+keeper, #202 one keeper per
// workspace (single-flight, ownership), #203 duplicate-keeper reap. Drives the REAL workspaces.ts /
// keeper-client.ts / resource-monitor.ts against REAL keeper daemons (dist-electron/keeper.js) and a
// fake stream-json CLI — no `claude`. Every observable is a process/file/store fact read back.
//
// Usage: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//          scripts/e2e-keeper-lifecycle.mjs <arm>     → one JSON line with `ok`.
// SUBJECT_REPO=<tree> drives another tree's src/ (G1: origin/master must FAIL the mustFailOnMaster arms).
// Rig dir lives under $HOME (btrfs), never /tmp.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_HOME = os.homedir();
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? '';

const ARMS = { churn2:{}, churn3:{}, stopped_keeper:{}, prune_timing_fast:{}, prune_timing_sigterm_ignored:{}, delete_inflight_start:{}, unlink_fallback_pidless:{}, keeper_log_survives_stop:{}, hello_preempt:{}, kill_stopped:{}, stale_two_launch:{}, fresh_two_launch:{}, sync6:{}, bulk_window:{} };
if (!ARMS[ARM]) {
  console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

const base = path.join(process.env.A2_HOME ?? path.join(REAL_HOME, '.a2-rig', 'arms'), ARM);
if (!base.startsWith(REAL_HOME + path.sep)) throw new Error(`refusing rig dir outside $HOME: ${base}`);
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;

// The daemon bundle: rebuild when missing/stale, then install where installKeeper() puts it.
const KEEPER_JS = process.env.KEEPER_JS_OVERRIDE || path.join(REPO, 'dist-electron', 'keeper.js');
const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts'].map((s) => path.join(REPO, s));
if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
  execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
}
const KEEPER_BIN = path.join(home, 'bin', 'keeper.js');
fs.copyFileSync(KEEPER_JS, KEEPER_BIN);

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-keeper-lifecycle-a2',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`,
  getAppVersion: () => '0.0.0-keeper-lifecycle-a2', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const kc = await import(`${REPO}/src/main/keeper-client.ts`);

// ── fake CLI + process/file observation helpers ──────────────────────────────
const FAKE_CLI = `
const fs = require('node:fs');
const T0 = Date.now();
if (process.env.SPAWN_LOG) fs.appendFileSync(process.env.SPAWN_LOG, process.pid + ' ' + Date.now() + '\\n');
if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => {}); else process.on('SIGTERM', () => process.exit(0));
const INIT_MS = Number(process.env.INIT_MS || 0);
const pending = [];
function flush() { for (const m of pending.splice(0)) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo, pid: process.pid }) + '\\n'); }
setTimeout(flush, INIT_MS);
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) { pending.push(m); if (Date.now() - T0 >= INIT_MS) flush(); }
  }
});
setInterval(() => {}, 1000);
`;
const fakeCli = path.join(base, 'fake-cli.cjs');
fs.writeFileSync(fakeCli, FAKE_CLI);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A killed-but-unreaped process (zombie) is DEAD: kill(pid,0) still succeeds on it, so read /proc state.
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] !== 'Z'; } catch { return false; }
};
async function waitFor(pred, ms, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); }
  return !!(await pred());
}
function procs() {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try { out.push({ pid: Number(name), argv: fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean) }); } catch { /* gone */ }
  }
  return out;
}
const keeperWs = (argv) => {
  const i = argv.findIndex((a) => path.basename(a) === 'keeper.js');
  return i >= 0 && argv.length >= i + 5 ? argv[i + 1] : null;
};
// A keeper of THIS rig home only (the pid path arg lives under our home) — arms run in parallel.
const keepersOf = (ws) => procs().filter((p) => keeperWs(p.argv) === ws && p.argv.some((a) => a.startsWith(home + path.sep))).map((p) => p.pid);
const clisOf = (ws) => procs().filter((p) => p.argv[1] === fakeCli && p.argv[2] === ws).map((p) => p.pid);
const pidFilePath = (ws) => path.join(home, 'keepers', `${ws}.pid`);
const pidFilePid = (ws) => { try { return JSON.parse(fs.readFileSync(pidFilePath(ws), 'utf8')).pid; } catch { return null; } };
const sockExists = (ws) => fs.existsSync(kc.keeperSocketPath(ws));
const filesLeft = (ws) => [sockExists(ws) ? 'sock' : null, fs.existsSync(pidFilePath(ws)) ? 'pid' : null].filter(Boolean);
const spawnOpts = (ws, tag = '') => ({ command: process.execPath, args: [fakeCli, ws, tag].filter(Boolean), cwd: base, env: { PATH: process.env.PATH, ...(globalThis.__CLI_ENV || {}), SPAWN_LOG: path.join(base, 'spawns.log') }, signal: new AbortController().signal });

/** A facade (what the SDK's query() gets) — stdout text, errors, exit. */
function open(ws, label = 'F') {
  const st = { label, out: '', errors: [], attached: false, exited: false };
  const h = kc.makeKeeperSpawn(ws, () => { st.attached = true; })(spawnOpts(ws));
  h.stdout.on('data', (d) => { st.out += d.toString('utf8'); });
  h.on('error', (e) => st.errors.push(String(e?.message ?? e)));
  h.on('exit', () => { st.exited = true; });
  st.h = h;
  return st;
}
const echoPid = (st, tag) => {
  const m = st.out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.echo === tag);
  return m ? m.pid : null;
};
/** Facade + one echo round trip → {keeperPid, cliPid, st}. */
async function startKeeper(ws) {
  const st = open(ws);
  st.h.stdin.write(JSON.stringify({ echo: 'up' }) + '\n');
  if (!(await waitFor(() => echoPid(st, 'up') !== null, 20_000))) throw new Error(`setup: keeper for ${ws} never came up`);
  return { st, keeperPid: pidFilePid(ws), cliPid: echoPid(st, 'up') };
}
/** A keeper daemon launched by hand (same argv as launchKeeperDaemon), optionally with a live CLI. */
async function rawKeeper(ws, { cli = false, tag = 'k' } = {}) {
  const k = spawn(process.execPath, [KEEPER_BIN, ws, kc.keeperSocketPath(ws), pidFilePath(ws), path.join(home, 'keepers', `${ws}.log`)], {
    detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  k.unref();
  const out = { pid: k.pid, sock: null, cliPid: null };
  if (!(await waitFor(() => pidFilePid(ws) === k.pid, 25_000))) return out; // refused / never owned the paths
  if (cli) {
    const sock = net.connect(kc.keeperSocketPath(ws));
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.write(JSON.stringify({ t: 'hello', wsId: ws }) + '\n');
    await sleep(150);
    const so = spawnOpts(ws, tag);
    sock.write(JSON.stringify({ t: 'spawn', command: so.command, args: so.args, cwd: so.cwd, env: so.env }) + '\n');
    const mine = () => procs().find((q) => q.argv[1] === fakeCli && q.argv[2] === ws && q.argv[3] === tag)?.pid ?? null;
    await waitFor(() => mine() !== null, 25_000);
    out.sock = sock; // stays attached → the keeper's policy never lingers it out mid-arm
    out.cliPid = mine();
  }
  return out;
}
/** Lines of the app log (<home>/logs/orchestra.log) naming this workspace's keeper kill. */
const killLogLines = (ws) => {
  try { return fs.readFileSync(path.join(home, 'logs', 'orchestra.log'), 'utf8').split('\n').filter((l) => l.includes(`keeper[${ws}] killing keeper`)).filter((l, i, a) => a.indexOf(l) === i); } catch { return []; }
};
const rmKeeperFiles = (ws) => { for (const p of [kc.keeperSocketPath(ws), pidFilePath(ws)]) { try { fs.unlinkSync(p); } catch { /* gone */ } } };

const touched = new Set();
const result = { arm: ARM, subject: REPO, ok: false };
const finish = async () => {
  for (const ws of touched) {
    for (const pid of [...keepersOf(ws), ...clisOf(ws)]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  if (process.env.KEEP_RIG !== '1') fs.rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
};
const W = (name) => { const id = `ws-${ARM.slice(0, 18).replace(/_/g, '-')}-${process.pid}-${name}`; touched.add(id); return id; };

try {
  await runArm();
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ');
}
await finish();

// ═════════════════════════════════ reviewer probes ═════════════════════════════════
function readSpawns() { try { return fs.readFileSync(path.join(base, 'spawns.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }
function echoes(st) { return (st.out.match(/"echo"/g) || []).length; }

async function setupStore() {
  const { store } = await import(`${REPO}/src/main/store.ts`);
  const wsm = await import(`${REPO}/src/main/workspaces.ts`);
  await store.load?.();
  return { store, wsm };
}

async function runArm() {
  if (ARM === 'churn2' || ARM === 'churn3') return churn();
  if (ARM === 'stopped_keeper') return stoppedKeeper();
  if (ARM === 'kill_stopped') return killStopped();
  if (ARM === 'bulk_window') return bulkWindow();
  if (ARM === 'sync6') return sync6();
  if (ARM === 'stale_two_launch' || ARM === 'fresh_two_launch') return staleTwoLaunch();
  if (ARM.startsWith('prune_timing')) return pruneTiming();
  if (ARM === 'delete_inflight_start') return deleteInflight();
  if (ARM === 'unlink_fallback_pidless') return unlinkFallback();
  if (ARM === 'keeper_log_survives_stop') return logSurvives();
  if (ARM === 'hello_preempt') return helloPreempt();
}

async function churn() {
  const WS = W('c');
  const N = ARM === 'churn3' ? 3 : 2;
  globalThis.__CLI_ENV = { INIT_MS: '3000' };
  const seen = new Set();
  const poll = setInterval(() => { for (const p of keepersOf(WS)) seen.add(p); }, 40);
  const fac = [];
  for (let i = 0; i < N; i++) {
    const f = open(WS, `F${i}`); f.h.stdin.write(JSON.stringify({ echo: `e${i}` }) + '\n'); fac.push(f);
    if (i < N - 1) await sleep(1500);
  }
  await sleep(14_000);
  clearInterval(poll);
  Object.assign(result, {
    keepersEverSeen: seen.size, cliSpawnsTotal: readSpawns(), finalKeepers: keepersOf(WS).length, finalClis: clisOf(WS).length,
    facades: fac.map((f) => ({ label: f.label, echoes: echoes(f), exited: f.exited, errors: f.errors.slice(0, 2) })),
  });
  result.ok = result.finalKeepers === 1 && result.finalClis === 1; // the ticket AC (end state) — churn numbers are the finding
}

async function stoppedKeeper() {
  const WS = W('s');
  const k1 = await startKeeper(WS);
  const inoBefore = fs.statSync(kc.keeperSocketPath(WS)).ino;
  process.kill(k1.keeperPid, 'SIGSTOP');
  const d2 = spawn(process.execPath, [KEEPER_BIN, WS, kc.keeperSocketPath(WS), pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  d2.unref();
  const t0 = Date.now();
  const d2Exited = await waitFor(() => !alive(d2.pid), 12_000);
  const d2ExitMs = Date.now() - t0;
  const stole = fs.existsSync(kc.keeperSocketPath(WS)) && fs.statSync(kc.keeperSocketPath(WS)).ino !== inoBefore;
  const pidFileIsK1 = pidFilePid(WS) === k1.keeperPid;
  // phase 2: killKeeper on a STOPPED keeper — does the CLI survive?
  const tk = Date.now();
  await kc.killKeeper(WS, 'probe');
  const killMs = Date.now() - tk;
  const after = { keeperAlive: alive(k1.keeperPid), cliAlive: alive(k1.cliPid), filesImmediately: filesLeft(WS), killMs };
  await sleep(1500);
  after.filesAfter1500ms = filesLeft(WS);
  try { process.kill(k1.cliPid, 'SIGKILL'); } catch {}
  Object.assign(result, { d2Exited, d2ExitMs, stole, pidFileIsK1, after });
  result.ok = d2Exited && !stole && pidFileIsK1 && !after.keeperAlive && !after.cliAlive;
}

async function pruneTiming() {
  const { store, wsm } = await setupStore();
  const sigIgnored = ARM.endsWith('sigterm_ignored');
  globalThis.__CLI_ENV = sigIgnored ? { IGNORE_TERM: '1' } : {};
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const N = 4; const ids = [];
  for (let i = 0; i < N; i++) {
    const id = W(`o${i}`); ids.push(id);
    await store.upsertWorkspace({ id, name: id, kind: 'worktree', repoPath: repo, worktreePath: path.join(base, 'not-a-worktree', id), branch: id, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${id}` });
  }
  const ks = []; for (const id of ids) ks.push(await startKeeper(id));
  const t0 = Date.now();
  await wsm.pruneOrphanedWorkspaces();
  const ms = Date.now() - t0;
  const dead = ks.filter((k) => !alive(k.keeperPid) && !alive(k.cliPid)).length;
  Object.assign(result, { orphans: N, pruneMs: ms, perOrphanMs: Math.round(ms / N), dead, inStore: ids.filter((i) => store.getWorkspace(i)).length, sigIgnored });
  result.ok = dead === N;
}

async function deleteInflight() {
  const { store, wsm } = await setupStore();
  for (const delayMs of [0, 30, 200, 600]) {
    const A = W(`a${delayMs}`);
    const wt = path.join(base, 'wt', A); fs.mkdirSync(wt, { recursive: true });
    await store.upsertWorkspace({ id: A, name: A, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${A}` });
    const f = open(A); f.h.stdin.write(JSON.stringify({ echo: 'x' }) + '\n');
    if (delayMs) await sleep(delayMs);
    await wsm.deleteWorkspace(A);
    await sleep(2500);
    result[`d${delayMs}`] = { keepers: keepersOf(A).length, clis: clisOf(A).length, files: filesLeft(A), inStore: !!store.getWorkspace(A), exited: f.exited, err: f.errors.slice(0, 1) };
  }
  result.ok = ['d0', 'd30', 'd200', 'd600'].every((k) => result[k].keepers === 0 && result[k].clis === 0 && result[k].files.length === 0 && !result[k].inStore);
}

async function unlinkFallback() {
  // Case A: pid file gone, sock still ours → K1's exit should remove its own sock (ino identity).
  const A = W('a');
  const k1 = await startKeeper(A);
  fs.unlinkSync(pidFilePath(A));
  process.kill(k1.keeperPid, 'SIGTERM');
  await waitFor(() => !alive(k1.keeperPid), 8000);
  await sleep(200);
  const caseA = { sockLeft: sockExists(A) };
  // Case B: pid file gone AND sock replaced by a sibling's → K1's exit must NOT remove the sibling's sock.
  const B = W('b');
  const b1 = await startKeeper(B);
  rmKeeperFiles(B);
  const b2 = await rawKeeper(B);
  fs.unlinkSync(pidFilePath(B)); // K2's pid file removed too → K1 sees owner === null
  const ino2 = fs.statSync(kc.keeperSocketPath(B)).ino;
  process.kill(b1.keeperPid, 'SIGTERM');
  await waitFor(() => !alive(b1.keeperPid), 8000);
  await sleep(200);
  const caseB = { sockLeft: sockExists(B), sameIno: sockExists(B) && fs.statSync(kc.keeperSocketPath(B)).ino === ino2, k2Alive: alive(b2.pid) };
  Object.assign(result, { caseA, caseB });
  result.ok = caseA.sockLeft === false && caseB.sockLeft === true && caseB.sameIno;
}

async function logSurvives() {
  const WS = W('l');
  const k = await startKeeper(WS);
  const logP = path.join(home, 'keepers', `${WS}.log`);
  const before = fs.existsSync(logP) ? fs.statSync(logP).size : -1;
  await kc.killKeeper(WS, 'probe');
  await sleep(300);
  const after = fs.existsSync(logP) ? fs.statSync(logP).size : -1;
  Object.assign(result, { logBytesBefore: before, logBytesAfter: after });
  result.ok = before > 0 && after > 0;
}

async function helloPreempt() {
  const WS = W('p');
  globalThis.__CLI_ENV = { INIT_MS: '0' };
  const f0 = open(WS, 'F0'); f0.h.stdin.write(JSON.stringify({ echo: 'a' }) + '\n');
  await waitFor(() => echoes(f0) >= 1, 20_000);
  const f1 = open(WS, 'F1'); f1.h.stdin.write(JSON.stringify({ echo: 'b' }) + '\n');
  await sleep(4000);
  Object.assign(result, { f0: { echoes: echoes(f0), exited: f0.exited }, f1: { echoes: echoes(f1), exited: f1.exited, attached: f1.attached }, keepers: keepersOf(WS).length, clis: clisOf(WS).length, cliSpawns: readSpawns() });
  result.ok = !f0.exited;
}

async function killStopped() {
  const WS = W('k');
  const k1 = await startKeeper(WS);
  process.kill(k1.keeperPid, 'SIGSTOP');
  const t0 = Date.now();
  await kc.killKeeper(WS, 'probe');
  const killMs = Date.now() - t0;
  const imm = { keeperAlive: alive(k1.keeperPid), files: filesLeft(WS) };
  await sleep(2000);
  const late = { keeperAlive: alive(k1.keeperPid), files: filesLeft(WS) };
  if (kc.sweepStaleKeeperFiles) { await kc.sweepStaleKeeperFiles(WS); late.filesAfterSecondSweep = filesLeft(WS); }
  try { process.kill(k1.cliPid, 'SIGKILL'); } catch {}
  Object.assign(result, { killMs, imm, late });
  result.ok = imm.files.length === 0 && late.files.length === 0;
}

function makeStaleSock(sockPath) {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  try { fs.unlinkSync(sockPath); } catch {}
  execFileSync('python3', ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', sockPath]);
}
async function staleTwoLaunch() {
  const trials = Number(process.env.TRIALS || 12);
  const rows = [];
  for (let t = 0; t < trials; t++) {
    const WS = W(`t${t}`);
    const sp = kc.keeperSocketPath(WS);
    if (ARM === 'stale_two_launch') makeStaleSock(sp); else { fs.mkdirSync(path.dirname(sp), { recursive: true }); try { fs.unlinkSync(sp); } catch {} }
    const mk = () => spawn(process.execPath, [KEEPER_BIN, WS, sp, pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const a = mk(), b = mk(); a.unref(); b.unref();
    await sleep(3000);
    const alive2 = [a.pid, b.pid].filter(alive);
    const ownerEarly = pidFilePid(WS);
    // who HOLDS the socket path now: connect, hello, spawn a tagged fake CLI, read its ppid
    let holder = null;
    try {
      const so = spawnOpts(WS, 'holderprobe');
      const sock = net.connect(sp); await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
      sock.write(JSON.stringify({ t: 'hello', wsId: WS }) + '\n'); await sleep(150);
      sock.write(JSON.stringify({ t: 'spawn', command: so.command, args: so.args, cwd: so.cwd, env: so.env }) + '\n');
      await waitFor(() => procs().some((q) => q.argv[1] === fakeCli && q.argv[2] === WS && q.argv[3] === 'holderprobe'), 5000);
      const cli = procs().find((q) => q.argv[1] === fakeCli && q.argv[2] === WS && q.argv[3] === 'holderprobe');
      if (cli) holder = Number(fs.readFileSync(`/proc/${cli.pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]);
      sock.destroy();
    } catch { holder = null; }
    const owner = pidFilePid(WS);
    rows.push({ t, aliveKeepers: alive2.length, pidFileOwner: owner === a.pid ? 'a' : owner === b.pid ? 'b' : String(owner), holder: holder === a.pid ? 'a' : holder === b.pid ? 'b' : String(holder), mismatch: holder !== null && owner !== holder, ownerEarly: ownerEarly === a.pid ? 'a' : ownerEarly === b.pid ? 'b' : String(ownerEarly) });
    for (const p of alive2) { try { process.kill(p, 'SIGKILL'); } catch {} }
  }
  const dup = rows.filter((r) => r.aliveKeepers >= 2).length;
  Object.assign(result, { trials, trialsWithTwoAliveKeepers: dup, pidFileVsHolderMismatch: rows.filter((r) => r.mismatch).length, rows: rows.map((r) => `${r.aliveKeepers}:pidEarly=${r.ownerEarly}/pidLate=${r.pidFileOwner}/holder=${r.holder}`).join(' ') });
  result.ok = dup === 0;
}

async function sync6() {
  const WS = W('n');
  globalThis.__CLI_ENV = { INIT_MS: '0' };
  const seen = new Set();
  const poll = setInterval(() => { for (const p of keepersOf(WS)) seen.add(p); }, 30);
  const opens = Array.from({ length: 6 }, (_, i) => open(WS, `F${i}`));
  opens.forEach((o, i) => o.h.stdin.write(JSON.stringify({ echo: `e${i}` }) + '\n'));
  const t0 = Date.now(); await waitFor(() => opens.some((o) => echoes(o) > 0), 60000); result.firstEchoAfterMs = Date.now() - t0; await sleep(3000);
  clearInterval(poll);
  Object.assign(result, { keepersEverSeen: seen.size, cliSpawnsTotal: readSpawns(), finalKeepers: keepersOf(WS).length, finalClis: clisOf(WS).length,
    facades: opens.map((o) => ({ l: o.label, echoes: echoes(o), exited: o.exited, attached: o.attached, err: o.errors.slice(0,1) })) });
  result.ok = true;
}

async function bulkWindow() {
  const { store, wsm } = await setupStore();
  globalThis.__CLI_ENV = { INIT_MS: '0' };
  const mk = async (id) => { const wt = path.join(base, 'wt', id); fs.mkdirSync(wt, { recursive: true }); await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${id}` }); };
  const A = W('a'), B = W('b');
  await mk(A); await mk(B);
  const ka = await startKeeper(A);          // A: live keeper -> its stop costs >=3s, delaying B's turn in the bulk loop
  const p = wsm.deleteWorkspaces([A, B]);   // A first, B second
  await sleep(1200);                         // inside A's teardown; B not yet tombstoned
  const late = open(B); late.h.stdin.write(JSON.stringify({ echo: 'late' }) + '\n');
  const gotEcho = await waitFor(() => echoes(late) > 0, 4000);
  const during = { bKeepers: keepersOf(B).length, bClis: clisOf(B).length, bGotEcho: gotEcho };
  await p; await sleep(2500);
  const after = { bKeepers: keepersOf(B).length, bClis: clisOf(B).length, inStore: [A, B].filter((w) => store.getWorkspace(w)).length };
  Object.assign(result, { during, after });
  result.ok = !during.bGotEcho && after.bKeepers === 0 && after.bClis === 0;  // ok=false means: a session RAN for B inside the bulk-delete window
}
