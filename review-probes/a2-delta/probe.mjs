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
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_HOME = os.homedir();
const HERE_REPO = '/home/lmas/.orchestra/worktrees/orchestra-silent-beetle-2c058ab8';
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? '';

const ARMS = { k4_bg_grandchild: {}, k4_scope: {}, l2_start_during_bg_stop: {}, k4_snapshot_race: {}, l5_bulk_throw: {}, l1_stale_claim: {}, l1_fresh_control: {} };
if (!ARMS[ARM]) {
  console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

// Short per-arm dir: a unix socket path must stay < ~100 bytes or keeperSocketPath hashes it into /tmp.
const base = path.join(process.env.A2_HOME ?? path.join(REAL_HOME, '.a2-rig', 'arms'), createHash('sha1').update(ARM).digest('hex').slice(0, 8));
if (!base.startsWith(REAL_HOME + path.sep)) throw new Error(`refusing rig dir outside $HOME: ${base}`);
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;

// The daemon bundle: rebuild when missing/stale, then install where installKeeper() puts it.
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
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
process.on('SIGTERM', () => { if (process.argv[3] === 'slowterm') setTimeout(() => process.exit(0), 1500); else process.exit(0); });
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo, pid: process.pid }) + '\\n');
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
const spawnOpts = (ws, tag = '') => ({ command: process.execPath, args: [fakeCli, ws, tag].filter(Boolean), cwd: base, env: { PATH: process.env.PATH }, signal: new AbortController().signal });

/** A facade (what the SDK's query() gets) — stdout text, errors, exit. */
function open(ws, label = 'F', tag = '') {
  const st = { label, out: '', errors: [], attached: false, exited: false };
  const h = kc.makeKeeperSpawn(ws, () => { st.attached = true; })(spawnOpts(ws, tag));
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
async function startKeeper(ws, tag = '') {
  const st = open(ws, 'F', tag);
  st.h.stdin.write(JSON.stringify({ echo: 'up' }) + '\n');
  if (!(await waitFor(() => echoPid(st, 'up') !== null, 20_000))) throw new Error(`setup: keeper for ${ws} never came up`);
  return { st, keeperPid: pidFilePid(ws), cliPid: echoPid(st, 'up') };
}
/** A keeper daemon launched by hand (same argv as launchKeeperDaemon), optionally with a live CLI. */
async function rawKeeper(ws, { cli = false, tag = 'k', wrapper = [] } = {}) {
  if (!kc.keeperSocketPath(ws).startsWith(home + path.sep)) throw new Error('VOID: socket path fell back to a hashed tmp name (rig dir too long)');
  const [cmd, ...pre] = wrapper.length ? [...wrapper, process.execPath] : [process.execPath];
  const k = spawn(cmd, [...pre, KEEPER_BIN, ws, kc.keeperSocketPath(ws), pidFilePath(ws), path.join(home, 'keepers', `${ws}.log`)], {
    detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  k.unref();
  const out = { pid: k.pid, sock: null, cliPid: null };
  if (!(await waitFor(() => (wrapper.length ? pidFilePid(ws) !== null : pidFilePid(ws) === k.pid), 25_000))) return out; // refused / never owned the paths
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
const extraPids = [];
const result = { arm: ARM, subject: REPO, ok: false, base };
const finish = async () => {
  for (const ws of touched) {
    for (const pid of [...keepersOf(ws), ...clisOf(ws)]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  for (const p of extraPids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  if (process.env.KEEP_RIG !== '1') fs.rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
};
const W = (name) => { const id = `ws-${ARM.slice(0, 18).replace(/_/g, '-')}-${name}`; touched.add(id); return id; };


const MYCLI = `
const fs = require('fs'); const cp = require('child_process'); const path = require('path');
const tag = process.argv[3];
const dir = path.dirname(process.argv[1]);
process.on('SIGTERM', () => { if (tag === 'spawner') setTimeout(() => process.exit(0), 600); else process.exit(0); });
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo, pid: process.pid }) + '\\n');
  }
});
if (tag === 'scope') {
  const a = cp.spawn('sleep', ['602'], { stdio: 'ignore' }); fs.writeFileSync(path.join(dir, 'a.pid'), String(a.pid));
  cp.spawn('sh', ['-c', 'sleep 603 & echo $! > ' + dir + '/b.pid'], { stdio: 'ignore' });
  const c = cp.spawn('setsid', ['sleep', '604'], { stdio: 'ignore' }); fs.writeFileSync(path.join(dir, 'c.pid'), String(c.pid));
}
if (tag === 'gc') { const c = cp.spawn('sleep', ['600'], { stdio: 'ignore' }); fs.writeFileSync(path.join(dir, 'gc.pid'), String(c.pid)); }
if (tag === 'spawner') setInterval(() => { const c = cp.spawn('sleep', ['600'], { stdio: 'ignore' }); fs.appendFileSync(path.join(dir, 'spawned.txt'), c.pid + '\\n'); }, 20);
setInterval(() => {}, 1000);
`;
const ppidOf = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); } catch { return null; } };

async function runArm() {
  if (ARM === 'l2_start_during_bg_stop') {
    const { store } = await import(`${REPO}/src/main/store.ts`);
    const wsm = await import(`${REPO}/src/main/workspaces.ts`);
    await store.load?.();
    const repo = path.join(base, 'repo'); fs.mkdirSync(repo, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: repo });
    const A = W('a');
    await store.upsertWorkspace({ id: A, name: A, kind: 'worktree', repoPath: repo, worktreePath: path.join(base, 'not-a-worktree', A), branch: A, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${A}` });
    const k = await startKeeper(A, 'slowterm');
    const t0 = Date.now(); await wsm.pruneOrphanedWorkspaces(); const pruneMs = Date.now() - t0;
    const stopStillRunning = alive(k.keeperPid) || alive(k.cliPid);   // control: the background stop is genuinely still in flight
    const st = open(A, 'F2'); st.h.stdin.write(JSON.stringify({ echo: 'late' }) + '\n');   // a start issued while it runs
    await waitFor(() => st.errors.length > 0 || echoPid(st, 'late') !== null, 6000);
    await waitFor(() => !alive(k.keeperPid) && !alive(k.cliPid), 15000);
    await sleep(1500);
    Object.assign(result, { pruneMs, stopStillRunning, lateStartErrors: st.errors, lateStartEcho: echoPid(st, 'late'), keepersAfter: keepersOf(A).length, clisAfter: clisOf(A).length, filesAfter: filesLeft(A) });
    result.ok = true;
    return;
  }

  if (ARM === 'k4_scope') {
    fs.writeFileSync(fakeCli, MYCLI);
    const WS = W('a');
    const k = await startKeeper(WS, 'scope');
    await waitFor(() => ['a', 'b', 'c'].every((x) => fs.existsSync(path.join(base, x + '.pid')) && fs.readFileSync(path.join(base, x + '.pid'), 'utf8').trim()), 5000);
    const pidOf = (x) => Number(fs.readFileSync(path.join(base, x + '.pid'), 'utf8'));
    const a = pidOf('a'), b = pidOf('b'), c = pidOf('c');
    const u = spawn('sleep', ['601'], { stdio: 'ignore', cwd: base, detached: false }); // a "user shell" in the worktree, parent = the probe (Orchestra main)
    extraPids.push(a, b, c, u.pid);
    const before = { inTree_a: alive(a), ppid_a: ppidOf(a) === k.cliPid, reparented_b: alive(b) && ppidOf(b) !== k.cliPid, ppid_b: ppidOf(b), setsid_c: alive(c), ppid_c: ppidOf(c) === k.cliPid, user_u: alive(u.pid) };
    await kc.killKeeper(WS, 'probe'); await sleep(500);
    const after = { a_direct_child_alive: alive(a), b_reparented_alive: alive(b), c_setsid_child_alive: alive(c), u_user_process_alive: alive(u.pid), keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid) };
    Object.assign(result, { before, after });
    result.ok = true;
    return;
  }
  if (ARM === 'k4_bg_grandchild') {
    // Healthy keeper, CLI exits on SIGTERM leaving a non-detached child (the agent's background job). Does killKeeper kill it?
    fs.writeFileSync(fakeCli, MYCLI);
    const WS = W('a');
    const k = await startKeeper(WS, 'gc');
    await waitFor(() => fs.existsSync(path.join(base, 'gc.pid')), 5000);
    const gc = Number(fs.readFileSync(path.join(base, 'gc.pid'), 'utf8')); extraPids.push(gc);
    const control = { gcAlive: alive(gc), gcPpidIsCli: ppidOf(gc) === k.cliPid, keeperAlive: alive(k.keeperPid) };
    const t0 = Date.now(); await kc.killKeeper(WS, 'probe'); const killMs = Date.now() - t0;
    await sleep(500);
    const after = { killMs, keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid), grandchildAlive: alive(gc), grandchildPpid: ppidOf(gc) };
    Object.assign(result, { control, after });
    result.ok = control.gcAlive && control.gcPpidIsCli; // informational: the verdict is in `after`
    return;
  }
  if (ARM === 'k4_snapshot_race') {
    // CLI keeps forking children every 20 ms and lingers 600 ms after SIGTERM: children born AFTER killKeeper's snapshot.
    fs.writeFileSync(fakeCli, MYCLI);
    const WS = W('a');
    const k = await startKeeper(WS, 'spawner');
    await sleep(400);
    await kc.killKeeper(WS, 'probe');
    await sleep(800);
    const spawned = fs.readFileSync(path.join(base, 'spawned.txt'), 'utf8').split('\n').filter(Boolean).map(Number); extraPids.push(...spawned);
    const alives = spawned.filter(alive);
    Object.assign(result, { spawned: spawned.length, orphansAlive: alives.length, keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid) });
    result.ok = true;
    return;
  }
  if (ARM === 'l5_bulk_throw') {
    const { store } = await import(`${REPO}/src/main/store.ts`);
    const wsm = await import(`${REPO}/src/main/workspaces.ts`);
    await store.load?.();
    const seed = async (id) => {
      const wt = path.join(base, 'wt', id); fs.mkdirSync(wt, { recursive: true });
      await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${id}` });
    };
    const A = W('a'), B = W('b'); await seed(A); await seed(B);
    // control: B can start a keeper BEFORE the failed bulk delete
    const pre = await startKeeper(B); await kc.killKeeper(B, 'probe-pre');
    const orig = store.removeWorkspaces.bind(store);
    store.removeWorkspaces = async () => { throw new Error('disk full (probe)'); };
    let threw = null; try { await wsm.deleteWorkspaces([A, B]); } catch (e) { threw = String(e?.message ?? e); }
    store.removeWorkspaces = orig;
    const inStore = { A: !!store.getWorkspace(A), B: !!store.getWorkspace(B) };
    // can the STILL-PRESENT workspace B start a session now?
    const st = open(B, 'F'); st.h.stdin.write(JSON.stringify({ echo: 'again' }) + '\n');
    const started = await waitFor(() => echoPid(st, 'again') !== null, 8000);
    Object.assign(result, { preStartWorked: pre.cliPid !== null, threw, inStore, bStartedAfterFailedDelete: started, bErrors: st.errors });
    result.ok = true;
    return;
  }
  if (ARM === 'l1_stale_claim' || ARM === 'l1_fresh_control') {
    // Stale socket file (+ for l1_stale_claim: a claim file naming a DEAD pid), then N daemons launched together.
    const N = Number(process.env.N ?? 6), R = Number(process.env.R ?? 12);
    const WS = W('a');
    const dist = [];
    fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
    for (let r = 0; r < R; r++) {
      for (const p of keepersOf(WS)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
      for (const p of [kc.keeperSocketPath(WS), pidFilePath(WS), pidFilePath(WS) + '.claim']) { try { fs.unlinkSync(p); } catch { /* gone */ } }
      // a STALE socket: bind here, hard-link the inode aside, close (node unlinks the path), rename the link back
      const stale = await new Promise((res) => { const s = net.createServer(); s.listen(kc.keeperSocketPath(WS), () => res(s)); });
      const keep = kc.keeperSocketPath(WS) + '.keep';
      fs.linkSync(kc.keeperSocketPath(WS), keep);
      await new Promise((r2) => stale.close(r2));
      fs.renameSync(keep, kc.keeperSocketPath(WS));
      if (ARM === 'l1_stale_claim') {
        const dead = spawn('true'); await new Promise((r2) => dead.once('exit', r2));
        fs.writeFileSync(pidFilePath(WS) + '.claim', String(dead.pid));
      }
      for (let i = 0; i < N; i++) {
        const k = spawn(process.execPath, [KEEPER_BIN, WS, kc.keeperSocketPath(WS), pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        k.unref();
      }
      await sleep(Number(process.env.W ?? 7500)); // > the 6 s claim wait, so every contender has decided
      const live = keepersOf(WS);
      dist.push(live.length);
      for (const p of live) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
    const hist = {}; for (const d of dist) hist[d] = (hist[d] ?? 0) + 1;
    Object.assign(result, { N, R, hist, trialsWithMoreThanOne: dist.filter((d) => d > 1).length, trialsWithZero: dist.filter((d) => d === 0).length });
    result.ok = true;
    return;
  }
}
try {
  await runArm();
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ');
}
await finish();
