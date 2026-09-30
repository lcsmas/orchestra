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
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? '';

const ARMS = {
  // #201
  del_single_survivor: { mustFailOnMaster: true },
  del_session_and_keeper: { mustFailOnMaster: true },
  del_bulk: { mustFailOnMaster: true },
  del_prune_orphan: { mustFailOnMaster: true },
  del_session_with_result: { mustFailOnMaster: true },
  del_racing_start_refused: { mustFailOnMaster: true },
  del_bulk_window: { mustFailOnMaster: true },
  del_prune_fast: { mustFailOnMaster: true },
  k4_bg_delete_kills: { mustFailOnMaster: true },
  del_never_started: {},
  // #202
  race_n_starts: { mustFailOnMaster: true },
  daemon_refuses_second: { mustFailOnMaster: true },
  daemon_refuses_hung: { mustFailOnMaster: true },
  stale_two_launch: { mustFailOnMaster: true },
  l1_stale_claim_dead: { mustFailOnMaster: true },
  l1_stale_claim_old: { mustFailOnMaster: true },
  l1_claim_age: { mustFailOnMaster: true },
  exit_owns_only: { mustFailOnMaster: true },
  exit_pidless_fallback: { mustFailOnMaster: true },
  survivor_killable: { mustFailOnMaster: true },
  sweep_spares_successor: { mustFailOnMaster: true },
  kill_serialized_with_start: { mustFailOnMaster: true },
  kill_refuses_reused_pid: { mustFailOnMaster: true },
  kill_pid_fallback_reaches: {},
  kill_spares_successor_files: { mustFailOnMaster: true },
  kill_keeps_log: {},
  k4_bg_restart_spares: {},
  sweep_dead_claims: { mustFailOnMaster: true },
  kill_hung_keeper: { mustFailOnMaster: true },
  // #203
  reap_dup_live: { mustFailOnMaster: true },
  reap_boot_pass: { mustFailOnMaster: true },
  reap_sole_live: {},
  reap_wrapper_sole: {},
  reap_store_unreadable: {},
  reap_absent_all: { mustFailOnMaster: true },
  reap_failclosed: { mustFailOnMaster: true },
};
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
if (process.argv[3] === 'bg') {
  // the agent's BACKGROUND JOB: a non-detached child of the CLI that outlives it
  const cp = require('child_process'), path = require('path'), fs = require('fs');
  const job = cp.spawn(process.execPath, [path.join(__dirname, 'bg-job.cjs')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(__dirname, 'bg.pid'), String(job.pid));
}
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
fs.writeFileSync(path.join(base, 'bg-job.cjs'), 'setInterval(() => {}, 1000);');

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
const result = { arm: ARM, subject: REPO, ok: false, base };
// D4 — watchdog in its OWN session: if this rig dies by ANY route (group SIGTERM / Ctrl-C / execFile timeout) or hangs
// past WATCHDOG_MS, SIGKILL every process whose argv mentions the rig dir (SIGSTOPped keepers included), then exit.
const WATCHDOG = `/* A2_WATCHDOG */
const fs = require('fs');
const [parent, base, max] = process.argv.slice(1);
const t0 = Date.now();
const gone = (pid) => { try { process.kill(pid, 0); } catch { return true; } try { return /^\\d+ \\(.*\\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch { return true; } };
const sweep = () => { for (const n of fs.readdirSync('/proc')) { if (!/^\\d+$/.test(n) || Number(n) === process.pid) continue; try { if (fs.readFileSync('/proc/' + n + '/cmdline', 'utf8').split('\\0').some((a) => a.includes(base))) process.kill(Number(n), 'SIGKILL'); } catch {} } };
setInterval(() => {
  const dead = gone(Number(parent));
  if (!dead && Date.now() - t0 < Number(max)) return;
  sweep(); if (!dead) { try { process.kill(Number(parent), 'SIGKILL'); } catch {} }
  setTimeout(sweep, 300); setTimeout(() => process.exit(0), 700);
}, 200);`;
const wd = spawn(process.execPath, ['-e', WATCHDOG, String(process.pid), base, String(process.env.A2_WATCHDOG_MS ?? 210_000)], { detached: true, stdio: 'ignore' });
wd.unref();
const wdPid = wd.pid;

/** Every live process whose argv mentions this arm's rig dir (keepers, wrappers, fake CLIs — incl. SIGSTOPped / SIGTERM-ignoring). */
const rigPids = () => procs().filter((p) => p.pid !== process.pid && p.pid !== wdPid && p.argv.some((a) => a.includes(base))).map((p) => p.pid).filter(alive);
const finish = async () => {
  for (const ws of touched) {
    for (const pid of [...keepersOf(ws), ...clisOf(ws)]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  for (const pid of rigPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  // LEAK ASSERTION: after the reap, 0 fake keeper/CLI/wrapper pids may remain (SIGKILL wakes a SIGSTOPped process).
  await waitFor(() => rigPids().length === 0, 5_000);
  const leaked = rigPids();
  if (leaked.length) { result.leaked = leaked; result.ok = false; }
  if (process.env.KEEP_RIG !== '1') fs.rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
};
const W = (name) => { const id = `ws-${ARM.slice(0, 18).replace(/_/g, '-')}-${name}`; touched.add(id); return id; };

try {
  await runArm();
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ');
}
await finish();

// ═════════════════════════════════ arms ═════════════════════════════════════
async function runArm() {
  // ── #201: delete drives the REAL workspaces.ts against real keepers ─────────
  if (ARM.startsWith('del_') || ARM === 'k4_bg_delete_kills') return deleteArms();
  if (ARM === 'race_n_starts') return raceArm();
  if (ARM === 'daemon_refuses_second') return daemonRefusesSecond();
  if (ARM === 'daemon_refuses_hung') return daemonRefusesHung();
  if (ARM === 'stale_two_launch') return staleTwoLaunch();
  if (ARM === 'l1_stale_claim_dead' || ARM === 'l1_stale_claim_old') return l1StaleClaim();
  if (ARM === 'sweep_dead_claims') return sweepDeadClaims();
  if (ARM === 'l1_claim_age') return l1ClaimAge();
  if (ARM === 'k4_bg_restart_spares') return k4RestartSpares();
  if (ARM === 'exit_owns_only' || ARM === 'survivor_killable' || ARM === 'exit_pidless_fallback') return takeoverArms();
  if (ARM === 'sweep_spares_successor') return sweepArm();
  if (ARM === 'kill_refuses_reused_pid' || ARM === 'kill_pid_fallback_reaches') return killIdentityArms();
  if (ARM === 'kill_serialized_with_start') return killSerializedArm();
  if (ARM === 'kill_hung_keeper') return killHungArm();
  if (ARM === 'kill_spares_successor_files') return killSparesSuccessor();
  if (ARM === 'kill_keeps_log') return killKeepsLog();
  if (ARM.startsWith('reap_')) return reapArms();
}

async function deleteArms() {
  const { store } = await import(`${REPO}/src/main/store.ts`);
  const wsm = await import(`${REPO}/src/main/workspaces.ts`);
  const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
  await store.load?.();
  const seed = async (id, extra = {}) => {
    const wt = path.join(base, 'wt', id);
    fs.mkdirSync(wt, { recursive: true });
    await store.upsertWorkspace({
      id, name: id, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle',
      createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${id}`, ...extra,
    });
  };
  const gone = (k) => !alive(k.keeperPid) && !alive(k.cliPid);

  if (ARM === 'del_single_survivor') {
    // A keeper that outlived an app relaunch: NO in-memory session, the row is deleted.
    const A = W('a'); await seed(A);
    const k = await startKeeper(A);
    const control = { keepers: keepersOf(A).length, clis: clisOf(A).length, files: filesLeft(A).length, session: sdk.sdkHasSession(A) };
    if (control.keepers !== 1 || control.clis !== 1 || control.files !== 2 || control.session !== false) throw new Error(`control failed: ${JSON.stringify(control)}`);
    const t0 = Date.now();
    await wsm.deleteWorkspace(A);
    const deleteMs = Date.now() - t0; // single-delete latency of a LIVE keeper (was ~3.1 s: an idle close-wait)
    const after = { deleteMs, keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid), keepers: keepersOf(A).length, clis: clisOf(A).length, files: filesLeft(A), inStore: !!store.getWorkspace(A) };
    const facadeClosed = await waitFor(() => k.st.exited, 3_000);
    const lines = killLogLines(A); // every kill = ONE log line naming wsid + pid + reason
    Object.assign(result, { control, after, facadeClosed, lines });
    result.ok = !after.keeperAlive && !after.cliAlive && after.keepers === 0 && after.clis === 0 && after.files.length === 0 && !after.inStore && facadeClosed
      && lines.length === 1 && lines[0].includes(`pid=${k.keeperPid}`) && /reason=/.test(lines[0]) && after.deleteMs < 2_000;
    return;
  }

  if (ARM === 'del_session_and_keeper') {
    // The socket/CLI delete route (dispatchDeleteWorkspaceRequest — no api-handlers sdkStopMany) with BOTH
    // a live in-memory session AND a real keeper for the same workspace.
    const B = W('b'); await seed(B);
    const k = await startKeeper(B);
    const never = () => new Promise(() => {});
    const INIT = { type: 'system', subtype: 'init', session_id: 'rig', tools: [], slash_commands: [] };
    sdk.__setQueryFactoryForTests(() => ({
      async *[Symbol.asyncIterator]() { yield INIT; await never(); },
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
      mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [], getContextUsage: never,
    }));
    const keepalive = setInterval(() => {}, 250);
    await sdk.sdkSend(B, 'kickoff');
    await waitFor(() => sdk.sdkHasSession(B), 5_000);
    const control = { session: sdk.sdkHasSession(B), keeperAlive: alive(k.keeperPid) };
    if (!control.session || !control.keeperAlive) throw new Error(`control failed: ${JSON.stringify(control)}`);
    const r = await wsm.dispatchDeleteWorkspaceRequest({ id: B });
    const after = { ok: r.ok, session: sdk.sdkHasSession(B), keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid), files: filesLeft(B) };
    clearInterval(keepalive);
    sdk.__setQueryFactoryForTests(null);
    Object.assign(result, { control, after });
    result.ok = r.ok === true && after.session === false && !after.keeperAlive && !after.cliAlive && after.files.length === 0;
    return;
  }

  if (ARM === 'del_session_with_result') {
    // A session that HAS produced a result + answers interrupt closes GRACEFULLY (sdkStop kills nothing):
    // only the delete's own killKeeper takes the real keeper down now.
    const B = W('b'); await seed(B);
    const k = await startKeeper(B);
    const never = () => new Promise(() => {});
    const INIT = { type: 'system', subtype: 'init', session_id: 'rig', tools: [], slash_commands: [] };
    const RESULT = { type: 'result', subtype: 'success', session_id: 'rig', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'done' };
    sdk.__setQueryFactoryForTests(() => ({
      async *[Symbol.asyncIterator]() { yield INIT; yield RESULT; await never(); },
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
      mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [], getContextUsage: never,
    }));
    const keepalive = setInterval(() => {}, 250);
    await sdk.sdkSend(B, 'kickoff');
    await sleep(600); // INIT + RESULT consumed → sawResult
    const control = { session: sdk.sdkHasSession(B), keeperAlive: alive(k.keeperPid) };
    if (!control.session || !control.keeperAlive) throw new Error(`control failed: ${JSON.stringify(control)}`);
    await wsm.deleteWorkspace(B);
    const after = { session: sdk.sdkHasSession(B), keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid), files: filesLeft(B) };
    clearInterval(keepalive);
    sdk.__setQueryFactoryForTests(null);
    Object.assign(result, { control, after });
    result.ok = after.session === false && !after.keeperAlive && !after.cliAlive && after.files.length === 0;
    return;
  }

  if (ARM === 'del_racing_start_refused') {
    // A wake that starts a session AFTER the delete's stop+kill finished (a slow archive script keeps the
    // row alive for seconds) must not launch a keeper/CLI nobody will ever kill (A3 review F4).
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const marker = path.join(base, 'archive-started');
    await store.addRepo({ path: repo, name: 'rig-repo', defaultBranch: 'master' });
    await store.setRepoScripts(repo, { archive: `touch ${marker}; sleep 3` });
    const A = W('a');
    const wt = path.join(base, 'wt-a');
    fs.mkdirSync(wt, { recursive: true });
    await store.upsertWorkspace({ id: A, name: A, kind: 'worktree', repoPath: repo, worktreePath: wt, branch: A, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: 'rig-a' });
    const k = await startKeeper(A);
    const p = wsm.deleteWorkspace(A);
    const archiving = await waitFor(() => fs.existsSync(marker), 15_000); // stop+kill are done: the archive script is running
    const gone0 = !alive(k.keeperPid);
    const late = open(A); // the racing start
    late.h.stdin.write(JSON.stringify({ echo: 'late' }) + '\n');
    await p;
    await sleep(1_500);
    const after = { archiving, keeperGoneBeforeStart: gone0, keepers: keepersOf(A).length, clis: clisOf(A).length, lateErrors: late.errors.slice(0, 1), files: filesLeft(A) };
    Object.assign(result, { after });
    result.ok = archiving && gone0 && after.keepers === 0 && after.clis === 0 && after.lateErrors.some((e) => /deleted/.test(e));
    return;
  }

  if (ARM === 'del_prune_fast') {
    // Boot prune runs before first paint: 4 orphan keepers must not cost 4 serial kills (L2: was 12.4 s).
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const ids = ['a', 'b', 'c', 'd'].map((n) => W(n));
    const ks = [];
    for (const id of ids) {
      await store.upsertWorkspace({ id, name: id, kind: 'worktree', repoPath: repo, worktreePath: path.join(base, 'not-a-worktree', id), branch: id, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${id}` });
      ks.push(await startKeeper(id, 'slowterm')); // each CLI takes ~1.5 s to die: serial stops would cost ~6 s
    }
    const t0 = Date.now();
    await wsm.pruneOrphanedWorkspaces();
    const pruneMs = Date.now() - t0;
    const allGone = await waitFor(() => ks.every((k) => !alive(k.keeperPid) && !alive(k.cliPid)) && ids.every((id) => filesLeft(id).length === 0), 30_000);
    const after = { pruneMs, allGone, rows: ids.filter((id) => store.getWorkspace(id)).length };
    Object.assign(result, { after });
    result.ok = pruneMs < 3_000 && allGone && after.rows === 0;
    return;
  }

  if (ARM === 'k4_bg_delete_kills') {
    // A DELETE (unlike a restart) also takes down the agent's background job: snapshot BEFORE the stop, kill after.
    const B = W('b'); await seed(B);
    const k = await startKeeper(B, 'bg');
    const bgPidFile = path.join(base, 'bg.pid');
    if (!(await waitFor(() => fs.existsSync(bgPidFile) && fs.readFileSync(bgPidFile, 'utf8').trim(), 8_000))) throw new Error('setup: the CLI never spawned its background job');
    const gc = Number(fs.readFileSync(bgPidFile, 'utf8'));
    if (!alive(gc)) throw new Error('control failed: background job not alive');
    await wsm.deleteWorkspace(B);
    const after = { keeperDead: !alive(k.keeperPid), cliDead: !alive(k.cliPid), backgroundJobDead: !alive(gc), files: filesLeft(B) };
    Object.assign(result, { after });
    result.ok = after.keeperDead && after.cliDead && after.backgroundJobDead && after.files.length === 0;
    return;
  }

  if (ARM === 'del_bulk_window') {
    // deleteWorkspaces([A slow, B]): a wake on B during A's teardown must not run a turn (L5) — every id is tombstoned up front.
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const marker = path.join(base, 'archive-started');
    await store.addRepo({ path: repo, name: 'rig-repo', defaultBranch: 'master' });
    await store.setRepoScripts(repo, { archive: `touch ${marker}; sleep 3` });
    const A = W('a'), B = W('b');
    const wt = path.join(base, 'wt-a');
    fs.mkdirSync(wt, { recursive: true });
    await store.upsertWorkspace({ id: A, name: A, kind: 'worktree', repoPath: repo, worktreePath: wt, branch: A, status: 'idle', createdAt: Date.now(), hasInput: true, sdkSessionId: 'rig-a' });
    await seed(B);
    const p = wsm.deleteWorkspaces([A, B]);
    const archiving = await waitFor(() => fs.existsSync(marker), 15_000); // A's teardown is in its slow archive script
    const late = open(B); // a wake on B, whose own teardown has not begun
    late.h.stdin.write(JSON.stringify({ echo: 'late' }) + '\n');
    await sleep(1_500);
    const turnRan = echoPid(late, 'late') !== null;
    const midClis = clisOf(B).length;
    await p;
    await sleep(500);
    const after = { archiving, turnRan, midClis, lateErrors: late.errors.slice(0, 1), keepers: keepersOf(B).length, inStore: [A, B].filter((w) => store.getWorkspace(w)).length };
    Object.assign(result, { after });
    result.ok = archiving && !turnRan && midClis === 0 && after.keepers === 0 && after.lateErrors.some((e) => /deleted/.test(e)) && after.inStore === 0;
    return;
  }

  if (ARM === 'del_bulk') {
    const A = W('a'), B = W('b'), C = W('c');
    await seed(A); await seed(B); await seed(C, { hibernatedAt: Date.now() });
    const ka = await startKeeper(A), kb = await startKeeper(B);
    // C: hibernated, no live keeper — but stale files a crash left behind.
    fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
    fs.writeFileSync(pidFilePath(C), JSON.stringify({ pid: 2 ** 22 + 12345, wsId: C, startedAt: 1 })); // a pid that is not running
    fs.writeFileSync(kc.keeperSocketPath(C), '');
    let threw = null;
    try { await wsm.deleteWorkspaces([A, B, C]); } catch (e) { threw = String(e?.message ?? e); }
    const after = {
      aDead: gone(ka), bDead: gone(kb), keepers: [A, B, C].map((w) => keepersOf(w).length),
      filesLeft: [A, B, C].flatMap((w) => filesLeft(w).map((f) => `${w.slice(-1)}:${f}`)),
      inStore: [A, B, C].filter((w) => store.getWorkspace(w)).length, threw,
    };
    Object.assign(result, { after });
    result.ok = !threw && after.aDead && after.bDead && after.keepers.every((n) => n === 0) && after.filesLeft.length === 0 && after.inStore === 0;
    return;
  }

  if (ARM === 'del_prune_orphan') {
    // Boot prune: a worktree workspace git no longer tracks. Control: a tracked one keeps its keeper.
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const O = W('orphan'), T = W('tracked');
    const mk = async (id, wtPath) => store.upsertWorkspace({
      id, name: id, kind: 'worktree', repoPath: repo, worktreePath: wtPath, branch: id, status: 'idle',
      createdAt: Date.now(), hasInput: true, sdkSessionId: `rig-${id}`,
    });
    await mk(O, path.join(base, 'not-a-worktree', O));
    await mk(T, repo); // the repo's own main worktree IS tracked by `git worktree list`
    const ko = await startKeeper(O), kt = await startKeeper(T);
    await wsm.pruneOrphanedWorkspaces();
    await waitFor(() => gone(ko) && filesLeft(O).length === 0, 20_000); // the orphan's session stop runs in the background
    const after = { orphanInStore: !!store.getWorkspace(O), trackedInStore: !!store.getWorkspace(T), orphanGone: gone(ko), orphanFiles: filesLeft(O), trackedAlive: alive(kt.keeperPid) && alive(kt.cliPid) };
    Object.assign(result, { after });
    result.ok = !after.orphanInStore && after.trackedInStore && after.orphanGone && after.orphanFiles.length === 0 && after.trackedAlive;
    return;
  }

  if (ARM === 'del_never_started') {
    // Hibernated + never-started rows own no session/keeper: delete must not throw and must drop the row.
    const H = W('hib'), N = W('never');
    await seed(H, { hibernatedAt: Date.now() });
    await seed(N, { sdkSessionId: undefined, hasInput: false });
    const errs = [];
    for (const [id, fn] of [[H, () => wsm.deleteWorkspace(H)], [N, () => wsm.dispatchDeleteWorkspaceRequest({ id: N })]]) {
      try { const r = await fn(); if (r && r.ok === false) errs.push(`${id}: ${r.error}`); } catch (e) { errs.push(`${id}: ${e?.message ?? e}`); }
    }
    const after = { errs, inStore: [H, N].filter((w) => store.getWorkspace(w)).length, keepers: [H, N].map((w) => keepersOf(w).length) };
    Object.assign(result, { after });
    result.ok = errs.length === 0 && after.inStore === 0 && after.keepers.every((n) => n === 0);
    return;
  }
}

// ── #202 ────────────────────────────────────────────────────────────────────
async function raceArm() {
  const WS = W('r');
  const N = 6;
  // What the SDK does: N query() calls → N facades, all synchronously, before any socket exists.
  const opens = Array.from({ length: N }, (_, i) => open(WS, `F${i}`));
  opens.forEach((o, i) => o.h.stdin.write(JSON.stringify({ echo: `e${i}` }) + '\n'));
  await waitFor(() => opens.some((o) => o.out.includes('"echo"')), 25_000);
  await sleep(2_500); // stragglers
  const keepers = keepersOf(WS), clis = clisOf(WS);
  const probe = await kc.probeKeeper(WS);
  const after = {
    keepers: keepers.length, clis: clis.length, probeCli: probe?.pid ?? null, cliIsSurvivor: clis.includes(probe?.pid),
    pidFileIsKeeper: keepers.includes(pidFilePid(WS)), sock: sockExists(WS),
    facadesWithEcho: opens.filter((o) => o.out.includes('"echo"')).length,
  };
  await kc.killKeeper(WS);
  await sleep(300);
  const killed = { keepers: keepersOf(WS).length, clis: clisOf(WS).length, files: filesLeft(WS) };
  Object.assign(result, { after, killed });
  result.ok = after.keepers === 1 && after.clis === 1 && after.cliIsSurvivor && after.pidFileIsKeeper && after.sock && after.facadesWithEcho >= 1
    && killed.keepers === 0 && killed.clis === 0 && killed.files.length === 0;
}

async function daemonRefusesSecond() {
  const WS = W('d');
  const k1 = await startKeeper(WS);
  const control = { keepers: keepersOf(WS).length, clis: clisOf(WS).length };
  if (control.keepers !== 1 || control.clis !== 1) throw new Error(`control failed: ${JSON.stringify(control)}`);
  const k2 = await rawKeeper(WS); // a racing second launch on the same paths
  const k2Exited = await waitFor(() => !alive(k2.pid), 6_000);
  k1.st.h.stdin.write(JSON.stringify({ echo: 'still' }) + '\n');
  const stillServed = await waitFor(() => echoPid(k1.st, 'still') === k1.cliPid, 5_000);
  const probe = await kc.probeKeeper(WS);
  const after = {
    k2Exited, k1Alive: alive(k1.keeperPid), clis: clisOf(WS).length, pidFileIsK1: pidFilePid(WS) === k1.keeperPid,
    probeIsK1Cli: probe?.pid === k1.cliPid, stillServed, facadeStillAttached: !k1.st.exited && k1.st.errors.length === 0,
  };
  Object.assign(result, { after });
  result.ok = k2Exited && after.k1Alive && after.clis === 1 && after.pidFileIsK1 && after.probeIsK1Cli && stillServed && after.facadeStillAttached;
}

async function takeoverSetup(WS) {
  // K1 serves; something (an older build's race) removes its paths; K2 takes them over.
  const k1 = await startKeeper(WS);
  rmKeeperFiles(WS);
  const k2 = await rawKeeper(WS);
  if (pidFilePid(WS) !== k2.pid) throw new Error('setup: K2 did not take over the paths');
  process.kill(k1.keeperPid, 'SIGTERM'); // K1 exits → its cleanup must not touch K2's files
  const k1Dead = await waitFor(() => !alive(k1.keeperPid), 8_000);
  if (!k1Dead) throw new Error('setup: K1 did not exit on SIGTERM');
  await sleep(200);
  return { k1, k2 };
}
async function takeoverArms() {
  const WS = W('t');
  if (ARM === 'exit_pidless_fallback') {
    // K2 owns the sock but its pid file is absent: K1's exit must NOT take the pid-less "fallback" to unlink K2's sock.
    const k1 = await startKeeper(WS);
    rmKeeperFiles(WS);
    const k2 = await rawKeeper(WS);
    if (pidFilePid(WS) !== k2.pid) throw new Error('setup: K2 did not take over the paths');
    fs.unlinkSync(pidFilePath(WS)); // K2's pid file vanishes; its socket stays
    process.kill(k1.keeperPid, 'SIGTERM');
    if (!(await waitFor(() => !alive(k1.keeperPid), 8_000))) throw new Error('setup: K1 did not exit');
    await sleep(200);
    const probe = await kc.probeKeeper(WS);
    const after = { sock: sockExists(WS), probeReaches: probe !== null, k2Alive: alive(k2.pid) };
    Object.assign(result, { after });
    result.ok = after.sock && after.probeReaches && after.k2Alive;
    return;
  }
  const { k2 } = await takeoverSetup(WS);
  if (ARM === 'exit_owns_only') {
    const probe = await kc.probeKeeper(WS);
    const after = { sock: sockExists(WS), pidFileIsK2: pidFilePid(WS) === k2.pid, probeReaches: probe !== null, k2Alive: alive(k2.pid) };
    Object.assign(result, { after });
    result.ok = after.sock && after.pidFileIsK2 && after.probeReaches && after.k2Alive;
    return;
  }
  // survivor_killable: killKeeper must still reach K2 after K1's exit.
  await kc.killKeeper(WS);
  const after = { k2Dead: await waitFor(() => !alive(k2.pid), 3_000), files: filesLeft(WS) };
  Object.assign(result, { after });
  result.ok = after.k2Dead && after.files.length === 0;
}

async function sweepArm() {
  // sweepStaleKeeperFiles: only files with NO live owner go. (New export — absent on master → fail.)
  const WS = W('s');
  if (typeof kc.sweepStaleKeeperFiles !== 'function') throw new Error('keeper-client has no sweepStaleKeeperFiles');
  const live = await rawKeeper(WS); // successor: live socket + pid file naming a live keeper
  await kc.sweepStaleKeeperFiles(WS);
  const spared = { sock: sockExists(WS), pidFileIsLive: pidFilePid(WS) === live.pid, probe: (await kc.probeKeeper(WS)) !== null };
  process.kill(live.pid, 'SIGKILL');
  // Dead = nobody answers on the socket (a zombie thread-group leader can still hold the listener).
  const refused = () => new Promise((r) => { const c = net.connect(kc.keeperSocketPath(WS)); c.once('connect', () => { c.destroy(); r(false); }); c.once('error', () => r(true)); });
  if (!(await waitFor(refused, 5_000))) throw new Error('setup: the SIGKILLed keeper still answers');
  // Mirror: the owner is dead (SIGKILL left both files) → the sweep must clear them.
  const left = filesLeft(WS);
  await kc.sweepStaleKeeperFiles(WS);
  const swept = { before: left, after: filesLeft(WS) };
  Object.assign(result, { spared, swept });
  result.ok = spared.sock && spared.pidFileIsLive && spared.probe && left.length === 2 && swept.after.length === 0;
}

async function killIdentityArms() {
  const WS = W('k');
  fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
  if (ARM === 'kill_refuses_reused_pid') {
    // A stale pid file whose pid now belongs to an UNRELATED live process (post-reboot reuse).
    const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    bystander.unref();
    fs.writeFileSync(pidFilePath(WS), JSON.stringify({ pid: bystander.pid, wsId: WS, startedAt: 1 }));
    const t0 = Date.now();
    await kc.killKeeper(WS);
    const ms = Date.now() - t0;
    const survived = alive(bystander.pid);
    try { process.kill(bystander.pid, 'SIGKILL'); } catch { /* gone */ }
    Object.assign(result, { bystanderSurvived: survived, killKeeperMs: ms, pidFileLeft: fs.existsSync(pidFilePath(WS)) });
    result.ok = survived === true && ms < 2000; // never signalled, never waited on
    return;
  }
  // kill_pid_fallback_reaches: socket gone, pid file names a REAL keeper → fallback SIGTERM still reaches it.
  const k = await startKeeper(WS);
  fs.unlinkSync(kc.keeperSocketPath(WS)); // keep the pid file only
  await kc.killKeeper(WS);
  const after = { keeperDead: await waitFor(() => !alive(k.keeperPid), 3_000), cliDead: await waitFor(() => !alive(k.cliPid), 3_000) };
  Object.assign(result, { after });
  result.ok = after.keeperDead && after.cliDead;
}

async function l1StaleClaim() {
  // A crashed daemon's leftover takeover claim must never block a launch (D2): stale socket + a claim that is
  // (dead) — naming a dead pid, fresh mtime — or (old) — naming a LIVE pid but > 5 s old. N daemons at once →
  // exactly 1 keeper, and it must come up promptly (a claim only broken by AGE would take > 5 s).
  const WS = W('c');
  const N = 6, R = 3;
  fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
  const rounds = [];
  for (let r = 0; r < R; r++) {
    const old = await rawKeeper(WS);
    if (pidFilePid(WS) !== old.pid) throw new Error('setup: seed keeper did not own the paths');
    process.kill(old.pid, 'SIGKILL'); // stale sock + pid file
    if (!(await waitFor(() => new Promise((res) => { const c = net.connect(kc.keeperSocketPath(WS)); c.once('connect', () => { c.destroy(); res(false); }); c.once('error', () => res(true)); }), 8_000))) throw new Error('setup: seed keeper still answers');
    const claim = pidFilePath(WS) + '.claim';
    if (ARM === 'l1_stale_claim_dead') {
      const dead = spawn('true');
      await new Promise((res) => dead.once('exit', res));
      fs.writeFileSync(claim, String(dead.pid)); // holder dead, mtime fresh
    } else {
      fs.writeFileSync(claim, String(process.pid)); // holder ALIVE (this rig), but the claim is 10 s old
      const past = new Date(Date.now() - 10_000);
      fs.utimesSync(claim, past, past);
    }
    const pids = [];
    for (let i = 0; i < N; i++) {
      const c = spawn(process.execPath, [KEEPER_BIN, WS, kc.keeperSocketPath(WS), pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      c.unref();
      pids.push(c.pid);
    }
    const t0 = Date.now();
    const got = await waitFor(async () => (await kc.probeKeeper(WS)) !== null, 4_000); // a keeper is SERVING (a blocked daemon does not answer)
    const ms = Date.now() - t0;
    await sleep(1_000);
    rounds.push({ got, ms, live: keepersOf(WS).length });
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await waitFor(() => keepersOf(WS).length === 0, 5_000);
    rmKeeperFiles(WS);
    try { fs.unlinkSync(claim); } catch { /* gone */ }
  }
  Object.assign(result, { rounds });
  result.ok = rounds.every((x) => x.got && x.live === 1);
}

async function l1ClaimAge() {
  // D5: a claim's age counts from ACQUISITION. A daemon that waited 2.5 s for a (live, fresh) holder must own a claim
  // whose mtime is ~now — not the mtime of the tmp file it wrote before waiting (else a 3rd contender breaks it as "stale").
  const WS = W('e');
  fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
  const old = await rawKeeper(WS);
  if (pidFilePid(WS) !== old.pid) throw new Error('setup: seed keeper did not own the paths');
  process.kill(old.pid, 'SIGKILL'); // stale sock
  if (!(await waitFor(() => new Promise((res) => { const c = net.connect(kc.keeperSocketPath(WS)); c.once('connect', () => { c.destroy(); res(false); }); c.once('error', () => res(true)); }), 8_000))) throw new Error('setup: seed keeper still answers');
  const claim = pidFilePath(WS) + '.claim';
  fs.writeFileSync(claim, String(process.pid)); // a LIVE holder, fresh: the daemon must wait, not break it
  const a = spawn(process.execPath, [KEEPER_BIN, WS, kc.keeperSocketPath(WS), pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  a.unref();
  await sleep(2_500);
  const brokenEarly = !fs.existsSync(claim) || fs.readFileSync(claim, 'utf8') !== String(process.pid);
  fs.unlinkSync(claim); // the holder releases
  let ageMs = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 4_000 && ageMs === null) {
    try {
      if (fs.readFileSync(claim, 'utf8') === String(a.pid)) ageMs = Date.now() - fs.statSync(claim).mtimeMs;
    } catch { /* not yet / already released */ }
    await sleep(5);
  }
  Object.assign(result, { brokenEarly, ageMs });
  result.ok = !brokenEarly && ageMs !== null && ageMs < 1_200;
}

async function sweepDeadClaims() {
  // D7: a crashed daemon's `<ws>.pid.claim` / `.claim.<pid>.tmp` / `.claim.stale.<pid>` are swept — but only when the
  // pid they name is DEAD (a live daemon's claim/tmp is never touched).
  const WS = W('d');
  if (typeof kc.sweepStaleKeeperFiles !== 'function') throw new Error('keeper-client has no sweepStaleKeeperFiles');
  fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
  const dead = spawn('true');
  await new Promise((res) => dead.once('exit', res));
  const base_ = pidFilePath(WS) + '.claim';
  const deadFiles = [base_, `${base_}.${dead.pid}.tmp`, `${base_}.stale.${dead.pid}`];
  fs.writeFileSync(deadFiles[0], String(dead.pid));
  fs.writeFileSync(deadFiles[1], String(dead.pid));
  fs.writeFileSync(deadFiles[2], String(dead.pid));
  const liveTmp = `${base_}.${process.pid}.tmp`; // a LIVE contender's tmp
  fs.writeFileSync(liveTmp, String(process.pid));
  await kc.sweepStaleKeeperFiles(WS);
  const after = { deadLeft: deadFiles.filter((f) => fs.existsSync(f)).length, liveTmpKept: fs.existsSync(liveTmp) };
  fs.unlinkSync(liveTmp);
  Object.assign(result, { after });
  result.ok = after.deadLeft === 0 && after.liveTmpKept;
}

async function k4RestartSpares() {
  // A HEALTHY kill (restart / clear / MCP refresh) must NOT kill the agent's background jobs (review D1).
  const WS = W('b');
  const k = await startKeeper(WS, 'bg');
  const bgPidFile = path.join(base, 'bg.pid');
  if (!(await waitFor(() => fs.existsSync(bgPidFile) && fs.readFileSync(bgPidFile, 'utf8').trim(), 8_000))) throw new Error('setup: the CLI never spawned its background job');
  const gc = Number(fs.readFileSync(bgPidFile, 'utf8'));
  const ppidOf = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); } catch { return null; } };
  const control = { gcAlive: alive(gc), gcIsChildOfCli: ppidOf(gc) === k.cliPid };
  if (!control.gcAlive || !control.gcIsChildOfCli) throw new Error(`control failed: ${JSON.stringify(control)}`);
  await kc.killKeeper(WS, 'restart');
  await sleep(500);
  const after = { keeperDead: !alive(k.keeperPid), cliDead: !alive(k.cliPid), backgroundJobAlive: alive(gc) };
  Object.assign(result, { control, after });
  result.ok = after.keeperDead && after.cliDead && after.backgroundJobAlive; // finish() reaps the job
}

async function staleTwoLaunch() {
  // Two daemons started TOGETHER over a STALE socket file must end as ONE keeper (L1): both used to read the
  // socket as stale, both unlinked, both relistened. Several trials — master loses ~85% of them.
  const WS = W('s');
  const trials = [];
  for (let t = 0; t < 6; t++) {
    const old = await rawKeeper(WS);
    if (pidFilePid(WS) !== old.pid) throw new Error('setup: seed keeper did not own the paths');
    process.kill(old.pid, 'SIGKILL'); // leaves a stale sock + pid file
    if (!(await waitFor(() => new Promise((r) => { const c = net.connect(kc.keeperSocketPath(WS)); c.once('connect', () => { c.destroy(); r(false); }); c.once('error', () => r(true)); }), 8_000))) throw new Error('setup: seed keeper still answers');
    const go = () => { const c = spawn(process.execPath, [KEEPER_BIN, WS, kc.keeperSocketPath(WS), pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); c.unref(); return c.pid; };
    const a = go(), b = go();
    await sleep(3_000);
    const live = keepersOf(WS);
    trials.push({ live: live.length, pidFileIsLive: live.includes(pidFilePid(WS)) });
    for (const pid of [a, b]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await waitFor(() => keepersOf(WS).length === 0, 5_000);
    rmKeeperFiles(WS);
  }
  Object.assign(result, { trials });
  result.ok = trials.every((x) => x.live === 1 && x.pidFileIsLive);
}

async function killSparesSuccessor() {
  // K8: killKeeper's own post-kill file sweep must spare a live SUCCESSOR's files. K_A is hung (SIGSTOP), so
  // killKeeper lingers ~8 s; meanwhile K_A's paths are taken over by K_B. K_A's SIGKILL → sweep must leave K_B's.
  const WS = W('k');
  const a = await startKeeper(WS);
  process.kill(a.keeperPid, 'SIGSTOP');
  const killing = kc.killKeeper(WS, 'rig');
  await sleep(1_500);
  rmKeeperFiles(WS); // K_A's paths vanish (an older build's clobber)…
  const b = await rawKeeper(WS, { cli: true, tag: 'succ' }); // …and K_B takes them over
  if (pidFilePid(WS) !== b.pid) throw new Error('setup: K_B did not take over the paths');
  await killing;
  const probe = await kc.probeKeeper(WS);
  const after = { aDead: !alive(a.keeperPid), bAlive: alive(b.pid), sock: sockExists(WS), pidFileIsB: pidFilePid(WS) === b.pid, reachable: probe !== null };
  await kc.killKeeper(WS, 'rig-cleanup'); // and killKeeper still reaches the survivor
  after.bKilledAfter = await waitFor(() => !alive(b.pid), 5_000);
  Object.assign(result, { after });
  result.ok = after.aDead && after.bAlive && after.sock && after.pidFileIsB && after.reachable && after.bKilledAfter;
}

async function killKeepsLog() {
  // L7: stopping a keeper must not delete its <ws>.log (master keeps it; nothing else does).
  const WS = W('l');
  const k = await startKeeper(WS);
  const logPath = path.join(home, 'keepers', `${WS}.log`);
  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : -1;
  await kc.killKeeper(WS, 'rig');
  const after = { before, exists: fs.existsSync(logPath), size: fs.existsSync(logPath) ? fs.statSync(logPath).size : -1, dead: !alive(k.keeperPid) };
  Object.assign(result, { after });
  result.ok = before > 0 && after.exists && after.size >= before && after.dead;
}

async function daemonRefusesHung() {
  // K_old is alive but HUNG (SIGSTOP: the kernel accepts into the backlog, nobody answers). A 2nd daemon must
  // fail CLOSED — refuse, leave K_old's files — never read silence as "stale" and steal the socket (review K3).
  const WS = W('h');
  const old = await rawKeeper(WS);
  if (pidFilePid(WS) !== old.pid) throw new Error('setup: K_old did not own the paths');
  process.kill(old.pid, 'SIGSTOP');
  const k2 = spawn(process.execPath, [KEEPER_BIN, WS, kc.keeperSocketPath(WS), pidFilePath(WS), path.join(home, 'keepers', `${WS}.log`)], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  k2.unref();
  const k2Exited = await waitFor(() => !alive(k2.pid), 15_000);
  const after = { k2Exited, oldAlive: alive(old.pid), pidFileIsOld: pidFilePid(WS) === old.pid, keepers: keepersOf(WS).length };
  process.kill(old.pid, 'SIGCONT');
  after.oldStillServes = (await waitFor(async () => (await kc.probeKeeper(WS)) !== null, 5_000));
  Object.assign(result, { after });
  result.ok = k2Exited && after.oldAlive && after.pidFileIsOld && after.keepers === 1 && after.oldStillServes;
}

async function killHungArm() {
  // A WEDGED keeper (SIGSTOP) can't relay the kill frame: killKeeper falls back to SIGKILL on the keeper —
  // its CLI must die too (no orphan with ppid 1), and the socket/pid files must go (review K4).
  const WS = W('w');
  const k = await startKeeper(WS);
  process.kill(k.keeperPid, 'SIGSTOP');
  const t0 = Date.now();
  await kc.killKeeper(WS, 'rig');
  const ms = Date.now() - t0;
  const after = { ms, keeperAlive: alive(k.keeperPid), cliAlive: alive(k.cliPid), files: filesLeft(WS), lines: killLogLines(WS).length };
  Object.assign(result, { after });
  result.ok = !after.keeperAlive && !after.cliAlive && after.files.length === 0 && ms < 20_000;
}

async function killSerializedArm() {
  // A stop requested AFTER a start must win: killKeeper queues behind the in-flight launch, then kills it.
  const WS = W('q');
  const st = open(WS);
  st.h.stdin.write(JSON.stringify({ echo: 'up' }) + '\n');
  await kc.killKeeper(WS);
  await sleep(600);
  const after = { keepers: keepersOf(WS).length, clis: clisOf(WS).length, files: filesLeft(WS) };
  Object.assign(result, { after });
  result.ok = after.keepers === 0 && after.clis === 0 && after.files.length === 0;
}

// ── #203 ────────────────────────────────────────────────────────────────────
async function reapArms() {
  const M = await import(`${REPO}/src/main/resource-monitor.ts`);
  const R = await import(`${REPO}/src/shared/resources.ts`);
  const logs = [];
  const procTable = () => procs().map((p) => {
    try { return R.parseProcStatLine(fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8')); } catch { return null; }
  }).filter(Boolean);
  const hand = {
    now: () => Date.now(), procTable: async () => procTable(), keeperRoots: () => kc.listKeeperRoots(),
    electronProcs: () => [], cpuCores: () => 1, memTotalBytes: () => 1, memUsedBytes: () => 1, appendLine: () => {},
    readProcStat: (pid) => { try { return R.parseProcStatLine(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; } },
    readCmdline: (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; } },
    signal: (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
    warn: (m) => logs.push(m), info: (m) => logs.push(m),
  };
  // Prefer the module's REAL defaults (incl. the /proc keeper scan) when it exports them.
  const real = typeof M.realResourceMonitorDeps === 'function' ? M.realResourceMonitorDeps() : hand;
  const deps = (over) => ({ ...real, sleep: (ms) => sleep(Math.min(ms, 1500)), warn: (m) => logs.push(m), info: (m) => logs.push(m), appendLine: () => {}, electronProcs: () => [], ...over });
  const reapLogs = () => logs.filter((l) => /reaping/.test(l));

  // Two keepers for ONE workspace as an older build's launch race left them: K1's paths were taken over by K2.
  const dupPair = async (ws) => {
    const k1 = await rawKeeper(ws, { cli: true, tag: 'dupe' });
    rmKeeperFiles(ws);
    const k2 = await rawKeeper(ws, { cli: true, tag: 'tracked' });
    if (!(k1.cliPid && k2.cliPid && pidFilePid(ws) === k2.pid)) throw new Error(`setup: dup pair not formed ${JSON.stringify({ k1: k1.pid, k2: k2.pid, c1: k1.cliPid, c2: k2.cliPid, pf: pidFilePid(ws) })}`);
    return { k1, k2 };
  };
  const state = (k) => ({ keeperAlive: alive(k.pid), cliAlive: alive(k.cliPid) });
  const live = (...ids) => () => new Set(ids);

  if (ARM === 'reap_dup_live') {
    const WS = W('w');
    const { k1, k2 } = await dupPair(WS);
    await M.sampleTick(deps({ liveWorkspaceIds: live(WS), storeLoadedFromDisk: () => true, statusFor: () => 'idle' }));
    await sleep(300);
    const probe = await kc.probeKeeper(WS);
    const after = { dup: state(k1), tracked: state(k2), trackedReachable: probe?.pid === k2.cliPid, reapLines: reapLogs().length, line: reapLogs()[0] ?? null };
    Object.assign(result, { after });
    result.ok = !after.dup.keeperAlive && !after.dup.cliAlive && after.tracked.keeperAlive && after.tracked.cliAlive && after.trackedReachable
      && after.reapLines === 1 && String(after.line).includes(WS) && String(after.line).includes(`— keeper pid ${k1.pid},`) && /duplicate/.test(after.line) && !String(after.line).includes(`(${k2.pid})`) && !String(after.line).includes(`(${k2.cliPid})`);
    return;
  }
  if (ARM === 'reap_boot_pass') {
    // The BOOT pass (reapKeepersNow, what index.ts runs after the store loads) = the same guarded reap.
    if (typeof M.reapKeepersNow !== 'function') throw new Error('resource-monitor has no reapKeepersNow');
    const WS = W('w'), GONE = W('gone');
    const { k1, k2 } = await dupPair(WS);
    const orphan = await rawKeeper(GONE, { cli: true, tag: 'orphan' });
    // Store NOT loaded: the boot pass must kill nothing.
    await M.reapKeepersNow(deps({ liveWorkspaceIds: live(WS), storeLoadedFromDisk: () => false }));
    await sleep(300);
    const unloaded = { dup: state(k1), tracked: state(k2), orphan: state(orphan) };
    await M.reapKeepersNow(deps({ liveWorkspaceIds: live(WS), storeLoadedFromDisk: () => true }));
    await sleep(300);
    const after = { unloaded, dup: state(k1), tracked: state(k2), orphan: state(orphan), reapLines: reapLogs().length };
    Object.assign(result, { after });
    result.ok = Object.values(unloaded).every((x) => x.keeperAlive && x.cliAlive)
      && !after.dup.keeperAlive && !after.dup.cliAlive && after.tracked.keeperAlive && after.tracked.cliAlive
      && !after.orphan.keeperAlive && !after.orphan.cliAlive && after.reapLines === 2;
    return;
  }
  if (ARM === 'reap_wrapper_sole') {
    // A live ws's SOLE keeper launched through a fork-style wrapper (`timeout 300 node keeper.js …`): both the
    // wrapper and the daemon carry the keeper argv; the wrapper must NOT be reaped as a "duplicate" (review K1).
    const WS = W('w');
    const k = await rawKeeper(WS, { wrapper: ['timeout', '300'] });
    const tracked = pidFilePid(WS);
    if (!tracked || tracked === k.pid) throw new Error(`setup: wrapper not in front of the daemon ${JSON.stringify({ wrapper: k.pid, tracked })}`);
    await M.sampleTick(deps({ liveWorkspaceIds: live(WS), storeLoadedFromDisk: () => true, statusFor: () => 'idle' }));
    await sleep(300);
    const after = { wrapperAlive: alive(k.pid), trackedAlive: alive(tracked), reachable: (await kc.probeKeeper(WS)) !== null, reapLines: reapLogs().length, refused: logs.filter((l) => /victim-tree-contains-tracked-keeper/.test(l)).length };
    Object.assign(result, { after });
    result.ok = after.wrapperAlive && after.trackedAlive && after.reachable && after.reapLines === 0;
    return;
  }
  if (ARM === 'reap_sole_live') {
    const A = W('a'), B = W('b'), C = W('c');
    const ka = await rawKeeper(A, { cli: true, tag: 'a' });
    const kb = await rawKeeper(B, { cli: true, tag: 'b' }); // hibernated workspace with a lingering keeper
    const kc2 = await rawKeeper(C, { cli: true, tag: 'c' });
    rmKeeperFiles(C); // …and a live workspace whose sole keeper has no pid file (untracked)
    await M.sampleTick(deps({ liveWorkspaceIds: live(A, B, C), storeLoadedFromDisk: () => true, statusFor: () => 'idle' }));
    await sleep(300);
    const after = { a: state(ka), b: state(kb), c: state(kc2), reapLines: reapLogs().length };
    Object.assign(result, { after });
    result.ok = after.a.keeperAlive && after.a.cliAlive && after.b.keeperAlive && after.b.cliAlive && after.c.keeperAlive && after.c.cliAlive && after.reapLines === 0;
    return;
  }
  if (ARM === 'reap_store_unreadable') {
    const A = W('a'), B = W('b');
    const { k1, k2 } = await dupPair(A); // live workspace with a duplicate
    const kb = await rawKeeper(B, { cli: true, tag: 'orphan' }); // and an absent-from-store orphan
    await M.sampleTick(deps({ liveWorkspaceIds: () => new Set(), storeLoadedFromDisk: () => false, statusFor: () => null }));
    await sleep(300);
    const after = { k1: state(k1), k2: state(k2), orphan: state(kb), reapLines: reapLogs().length };
    Object.assign(result, { after });
    result.ok = after.k1.keeperAlive && after.k1.cliAlive && after.k2.keeperAlive && after.k2.cliAlive && after.orphan.keeperAlive && after.orphan.cliAlive && after.reapLines === 0;
    return;
  }
  if (ARM === 'reap_absent_all') {
    const WS = W('w');
    const { k1, k2 } = await dupPair(WS);
    await M.sampleTick(deps({ liveWorkspaceIds: () => new Set(), storeLoadedFromDisk: () => true, statusFor: () => null }));
    await sleep(300);
    const after = { untracked: state(k1), tracked: state(k2), reapLines: reapLogs().length };
    Object.assign(result, { after });
    result.ok = !after.untracked.keeperAlive && !after.untracked.cliAlive && !after.tracked.keeperAlive && !after.tracked.cliAlive && after.reapLines >= 2;
    return;
  }
  if (ARM === 'reap_failclosed') {
    // Fake /proc world (no real processes): identity must be proven AT SIGNAL TIME or nothing is signalled.
    const WS = 'ws-fake', T = 4001, D = 4002, C = 4003;
    const proc = (pid, ppid, comm, st) => ({ pid, ppid, comm, cpuTicks: 0, cpuPct: 0, memBytes: 1, startTicks: st });
    const table = [proc(T, 1, 'node', 100), proc(D, 1, 'node', 200), proc(C, D, 'claude', 210)];
    const argv = (pid) => ['/usr/bin/node', `${home}/bin/keeper.js`, WS, 's', path.join(home, 'keepers', `${WS}.pid`), 'l'].concat(pid ? [] : []);
    let sentLog = [];
    const run = async (over = {}) => {
      const sent = [];
      sentLog = sent;
      const world = {
        now: () => 0, procTable: async () => table, keeperRoots: () => [{ workspaceId: WS, keeperPid: T }],
        keeperProcs: () => [{ pid: T, workspaceId: WS }, { pid: D, workspaceId: WS }],
        trackedKeeperPid: () => T,
        liveWorkspaceIds: () => new Set([WS]), storeLoadedFromDisk: () => true, statusFor: () => 'idle',
        electronProcs: () => [], cpuCores: () => 1, memTotalBytes: () => 1, memUsedBytes: () => 1, appendLine: () => {},
        readProcStat: (pid) => table.find((p) => p.pid === pid) ?? null,
        readCmdline: (pid) => (pid === T || pid === D ? argv(pid) : ['/bin/sleep', '1']),
        signal: (pid, sig) => { sent.push(`${sig}:${pid}`); return true; },
        sleep: async () => {}, warn: (m) => logs.push(m), info: (m) => logs.push(m), ...over,
      };
      await M.sampleTick(world);
      return sent;
    };
    const control = await run(); // identity holds → the dup tree (D + its CLI C) is signalled, the tracked T never
    const cmdMismatch = await run({ readCmdline: (pid) => (pid === T ? argv(T) : ['/bin/sleep', '1']) });
    const reused = await run({ readProcStat: (pid) => { const p = table.find((q) => q.pid === pid); return p && pid === D ? { ...p, startTicks: 999 } : p ?? null; } });
    const trackedMoved = await run({ trackedKeeperPid: () => 5555 });
    const trackedGone = await run({ readProcStat: (pid) => (pid === T ? null : table.find((p) => p.pid === pid) ?? null) });
    // Kill-time store re-read: absent at classification, PRESENT by the time we would signal → nothing goes.
    const flip = (() => { let n = 0; return () => (n++ === 0 ? new Set() : new Set([WS])); })();
    const orphanFlip = await run({ liveWorkspaceIds: flip });
    const orphanControl = await run({ liveWorkspaceIds: () => new Set() });
    // Absent ws: the tracked keeper is reaped FIRST and may already be gone when the untracked one is checked.
    const trackedDiesFirst = await (async () => {
      let trackedDead = false;
      return run({
        liveWorkspaceIds: () => new Set(),
        trackedKeeperPid: () => (trackedDead ? null : T),
        signal: (pid, sig) => { if (pid === T) trackedDead = true; sentLog.push(`${sig}:${pid}`); return true; },
      });
    })();
    // Tracked pid RECYCLED by a non-keeper at kill time; D is the ONLY real keeper of a live ws → nothing signalled.
    const trackedRecycled = await run({ readCmdline: (pid) => (pid === D ? argv(D) : ['/bin/sleep', '1']) });
    // K1: a "duplicate" that WRAPS the tracked keeper (fork-style wrapper W above T) → refused, nothing signalled.
    const Wp = 5001;
    const wrapTable = [proc(Wp, 1, 'timeout', 90), proc(T, Wp, 'node', 100)];
    const wrapperSole = await run({
      procTable: async () => wrapTable, keeperProcs: () => [{ pid: Wp, workspaceId: WS }, { pid: T, workspaceId: WS }],
      readProcStat: (pid) => wrapTable.find((p) => p.pid === pid) ?? null,
      readCmdline: (pid) => (pid === T || pid === Wp ? argv(pid) : ['/bin/sleep', '1']),
    });
    const onlyDup = (sent) => sent.every((s) => /:(4002|4003)$/.test(s)) && !sent.some((s) => s.endsWith(`:${T}`));
    Object.assign(result, { control, cmdMismatch, reused, trackedMoved, trackedGone, orphanFlip, orphanControl, trackedDiesFirst, trackedRecycled, wrapperSole });
    result.ok = control.length > 0 && onlyDup(control) && control.some((s) => s === `SIGTERM:${D}`) && control.some((s) => s === `SIGTERM:${C}`)
      && cmdMismatch.length === 0 && reused.filter((s) => s.endsWith(`:${D}`)).length === 0
      && trackedMoved.length === 0 && trackedGone.length === 0
      && trackedDiesFirst.some((x) => x === `SIGTERM:${D}`) && trackedDiesFirst.some((x) => x === `SIGTERM:${C}`)
      && trackedRecycled.length === 0 && wrapperSole.length === 0
      && orphanFlip.length === 0 && orphanControl.some((x) => x === `SIGTERM:${T}`) && orphanControl.some((x) => x === `SIGTERM:${D}`);
    return;
  }
}
