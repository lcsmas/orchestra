// #330 (wave H, ledger #329) — the app's directory watchers HEAL after a resource crunch. COMPOSITION rig: the REAL bus (scratch ORCHESTRA_HOME), the REAL subsystems that own the six boot watchers
// (events spool, inbox tray, human gates, Pause UI host, Réveil engine, host trap), the REAL hooks server + the BUILT CLI `bus-status`; only the platform (a recording `broadcast`), the member roster and the
// wake delivery seam are stand-ins. The instrument that injects the failure is `fs.watch` itself, patched in THIS process to throw EMFILE — so the SAME rig drives the fixed tree and master (RIG_REPO=<tree>),
// and the fixed tree's own fault-file / primitive seams are NOT the thing under test. NOT heavy: no browser / app / keeper / Docker; one node process per arm + the CLI.
//
//   control          the live paths WORK when nothing fails: pause write → Pause UI push, message → wake, gate → push, inbox file → push, hard Pause → trap stamp, all < 1 s  (rig can SEE a healthy watch)
//   degraded       ★ boot with EMFILE on every watch: `bus-status` (built CLI) lists the six watchers DEGRADED naming the system watch limit; ONE push per degradation reaches the renderer; meanwhile the writes are
//                    NOT picked up live (injection works) but ARE by the fallback (manual sweep / pull = what the 60 s timer does)
//   recovery       ★ EMFILE at boot, writes made WHILE degraded, EMFILE lifted → within the backoff every watcher is back, `bus-status` clean, the all-clear pushed, the writes made while degraded are caught up
//                    WITHOUT a new write (Pause UI push, wake, gate push, inbox push, trap stamp), then each live path works again < 1 s; log: one WARN per degradation, one INFO per recovery
//   midlife        ★ healthy boot, then the bus-directory watches DIE (closed + `error`): the next writes are not seen at first (control), then the watchers re-arm by themselves and everything is back
//   silent_detach  ★ the inbox directory is deleted and recreated under a live watch (no `error`, no event): the watch is re-armed by the health check and the inbox file written meanwhile is pushed
//   shutdown       ★ with watchers degraded, the production shutdown path leaves NO pending retry: no `fs.watch` call after it
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-resilient-watchers.mjs     (RIG_REPO=<tree> = the must-FAIL run on master; RIG_ARMS=a,b subset)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['control', 'degraded', 'recovery', 'midlife', 'silent_detach', 'shutdown'];
const REAL_HOME = os.homedir();
const RIG_BASE = path.resolve(process.env.WATCHERS_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-rw'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE_MS = 1000; // « < 1 s » — the acceptance bound for a live path
const QUIET_MS = 1200; // how long « not seen live » is observed (a healthy watch answers in ~150-300 ms)
const SIX = ['bus-wake', 'events-spool', 'human-gates', 'inbox-tray', 'pause-trap', 'pause-ui'];

// ═══ PARENT: one child process per arm ═══════════════════════════════════════════════════════════════════════════════
if (!ARM) {
  const only = process.env.RIG_ARMS ? new Set(process.env.RIG_ARMS.split(',')) : null;
  const runId = randomBytes(3).toString('hex');
  const rows = [];
  for (const arm of ARMS) {
    if (only && !only.has(arm)) continue;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm], {
      env: { ...process.env, RIG_RUN_ID: runId }, encoding: 'utf8', timeout: 120_000,
    });
    const lines = (r.stdout ?? '').split('\n');
    const json = lines.reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = json ? JSON.parse(json) : null; } catch { /* below */ }
    const bad = v ? v.checks.filter((c) => !c.ok) : [];
    const ok = !!v && v.pass && bad.length === 0 && r.status === 0;
    rows.push({ arm, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${arm}${v ? ` (${v.checks.length} checks, ${v.ms} ms)` : ' (no verdict)'}${bad.length ? ` — ${bad.map((c) => `${c.name}: ${c.note ?? ''}`).join(' | ').slice(0, 900)}` : ''}${v ? '' : ` — exit ${r.status} ${String(r.stderr ?? '').slice(-400)}`}`);
    if (process.env.RIG_VERBOSE && v) for (const c of v.checks) console.log(`   ${c.ok ? 'ok ' : 'RED'} ${c.name}${c.note ? ` — ${c.note}` : ''}`);
  }
  const red = rows.filter((r) => !r.ok).map((r) => r.arm);
  console.log(`RESILIENT WATCHERS: ${red.length === 0 && rows.length === (only ? only.size : ARMS.length) ? 'ALL PASS' : `RED ${red.join(',')}`} (${rows.length - red.length}/${rows.length} arms) tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}

// ═══ CHILD: one arm ══════════════════════════════════════════════════════════════════════════════════════════════════
const t0 = Date.now();
const SCRATCH = path.join(RIG_BASE, `${process.env.RIG_RUN_ID ?? 'solo'}-${ARM}`);
const liveDirs = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(SCRATCH + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || liveDirs.some((l) => (SCRATCH + path.sep).startsWith(l + path.sep))) { console.error(`SAFETY: refusing scratch path ${SCRATCH}`); process.exit(2); }
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(path.join(SCRATCH, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_HOME = path.join(SCRATCH, '.orchestra');
process.env.HOME = SCRATCH;
process.env.CLAUDE_CONFIG_DIR = path.join(SCRATCH, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
setInterval(() => {}, 1000); // a hung await must end as a RED verdict at the deadline, never a silent exit

const checks = [];
const check = (name, ok, note) => { checks.push({ name, ok: !!ok, note: ok ? undefined : note }); return !!ok; };
const finish = async (extra = {}) => {
  const bad = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ arm: ARM, pass: bad.length === 0, ms: Date.now() - t0, checks, ...extra }));
  process.exit(0);
};
setTimeout(() => { check('deadline', false, 'the arm hung (100 s)'); void finish(); }, 100_000).unref?.();

// ── THE INSTRUMENT: fs.watch patched in this process. While `fault` is on, any directory under the scratch fails EMFILE (the kernel's own error for the per-user inotify limit); otherwise it is the REAL fs.watch,
//    and the live handles are kept so a mid-life death can close one for real. Same patch on master and on the fixed tree.
let fault = false;
const realWatch = fs.watch.bind(fs);
const handles = [];
const watchCalls = [];
fs.watch = function patchedWatch(dir, ...rest) {
  const d = String(dir);
  if (fault && d.startsWith(SCRATCH)) {
    watchCalls.push({ dir: d, failed: true, at: Date.now() });
    throw Object.assign(new Error(`EMFILE: too many open files, watch '${d}'`), { code: 'EMFILE' });
  }
  const w = realWatch(dir, ...rest);
  watchCalls.push({ dir: d, failed: false, at: Date.now() });
  handles.push({ dir: d, w, closed: false });
  w.on('close', () => { const h = handles.find((x) => x.w === w); if (h) h.closed = true; });
  return w;
};
let uncaughtErrorEvents = 0; // an `error` event nobody listens for THROWS (in Electron main: an uncaught exception) — counted, not allowed to end the rig
const killWatch = (dir) => {
  let n = 0;
  for (const h of handles) {
    if (h.dir !== dir || h.closed) continue;
    h.w.close();
    try { h.w.emit('error', Object.assign(new Error(`EMFILE: too many open files (injected mid-life death of ${dir})`), { code: 'EMFILE' })); } catch { uncaughtErrorEvents++; }
    n++;
  }
  return n;
};

// ── recording platform ──
const events = [];
const mark = () => events.length;
const since = (i, channel) => events.slice(i).filter((e) => e.channel === channel);
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-watchers', broadcast: (channel, ...args) => { events.push({ channel, args, at: Date.now() }); }, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => true, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => SCRATCH, getLogsDir: () => `${SCRATCH}/logs`, getAppVersion: () => '0.0.0-e2e-watchers', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const loggerMod = await import(`${REPO}/src/main/logger.ts`);
loggerMod.initLogger();
fs.mkdirSync(path.join(SCRATCH, 'orchestra'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'orchestra', 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
const wake = await import(`${REPO}/src/main/bus-wake.ts`);
const trapMod = await import(`${REPO}/src/main/pause-trap.ts`);
const trapHost = await import(`${REPO}/src/main/pause-trap-host.ts`);
const spool = await import(`${REPO}/src/main/events-spool.ts`);
const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
const gates = await import(`${REPO}/src/main/human-gates.ts`);
const pauseUi = await import(`${REPO}/src/main/pause-ui-host.ts`);
const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
const { FakeDocker } = await import(`${HERE}/../src/main/fake-docker.ts`);
const docker = new FakeDocker([]);
const { serializeInboxBlocks } = await import(`${REPO}/src/shared/inbox-blocks.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
const { HUMAN_GATE_RECIPIENT } = await import(`${REPO}/src/shared/human-gates.ts`);
const W = await import(`${REPO}/src/main/watchers.ts`).catch(() => null); // absent on master: the arms then read RED on the clause, never on an import error
const WH = await import(`${REPO}/src/main/watchers-host.ts`).catch(() => null);

busMod.initBus();
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
for (const [what, p] of [['bus', busMod.busPath()], ['inbox', tray.inboxFilePath('x')], ['events', spool.getEventsDir()]]) if (!String(p).startsWith(SCRATCH)) { console.error(`SAFETY: ${what} resolved outside the scratch: ${p}`); process.exit(2); }
const BUS_DIR = path.dirname(busMod.busPath());
const INBOX_DIR = path.dirname(tray.inboxFilePath('x'));

// ── the fleet: one orchestrator (pause ON, wake ON, delivery ON) + one member ──
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, branch: id, kind: 'scratch', repoPath: '', worktreePath: SCRATCH, status: 'idle', createdAt: now0 - 40 * 60_000, hasInput: true, sdkSessionId: `sess-${id}`, ...extra });
const SW = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, pause: true, liveness: true };
busRuns.startRun(db, { id: 'ws-ops', kind: 'mission', coordinator: 'ws-ops' }, SW);
await store.upsertWorkspace(mk('ws-ops', { kind: 'orchestrator' }));
await store.upsertWorkspace(mk('ws-m1', { parentId: 'ws-ops' }));

// ── the Réveil engine: real sweep over the real bus, the delivery seam records ──
const wakes = [];
wake.__resetBusWakeForTests();
wake.__setBusReaderForTests(() => db);
wake.__setWatchPathForTests(() => busMod.busPath());
wake.setWakeRoster(() => [{ reader: 'ws-m1', wakeable: true, runId: 'ws-ops' }]);
wake.setWakeDeliver(async (reader, text) => { wakes.push({ reader, text, at: Date.now() }); return true; });
wake.__freezeSwitchForTests(true);

// ── the REAL hooks server + the BUILT CLI ──
await hooks.startHooksServer();
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
const newestInput = () => {
  let newest = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!/\.test\.ts$/.test(e.name)) newest = Math.max(newest, fs.statSync(f).mtimeMs); } };
  for (const dir of ['src/cli', 'src/shared']) walk(path.join(REPO, dir));
  return newest;
};
const cliFresh = fs.existsSync(CLI) && fs.statSync(CLI).mtimeMs >= newestInput();
const cliOut = () => new Promise((resolve) => {
  if (!fs.existsSync(CLI)) { resolve('NO CLI BUNDLE'); return; }
  const p = spawn(process.execPath, [CLI, 'bus-status'], { env: { PATH: process.env.PATH, HOME: SCRATCH, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_SOCK: hooks.getHookSocketPath(), ORCHESTRA_WS_ID: 'ws-ops' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = ''; p.stdout.on('data', (c) => (so += c)); p.stderr.on('data', (c) => (so += c)); p.on('close', () => resolve(so));
});
const watchersBlock = async () => {
  const ls = (await cliOut()).split('\n');
  const i = ls.findIndex((l) => l.startsWith('watchers:'));
  if (i < 0) return '';
  const out = [ls[i]];
  for (let k = i + 1; k < ls.length && ls[k].startsWith('  '); k++) out.push(ls[k]);
  return out.join('\n');
};

// ── start the subsystems in index.ts order (the push subscription FIRST, as index.ts does) ──
const cliDb = () => busMod.open ? busMod.open(busMod.busPath()) : null; // a SEPARATE connection: the CLI's shape
function startAll() {
  W?.pushWatchersToRenderer?.();
  spool.startEventsSpool();
  tray.startInboxWatcher();
  gates.startHumanGatesWatcher();
  pauseUi.startPauseUiWatcher();
  wake.startBusWake();
  const trapDeps = trapHost.buildPauseTrapDeps();
  trapDeps.containers = docker; trapDeps.containersFor = () => docker; // never the machine's real dockerd
  trapDeps.snapshot = async (i) => ({ ref: `refs/orchestra/pause/${i.runId}/${i.wsId}/1`, commit: 'c', tree: 't', head: 'h', branch: 'rig', dirty: false, changed: { modified: 0, added: 0, deleted: 0 }, skippedLarge: [], skippedLargeCount: 0, notes: [], warning: null });
  trapDeps.killTrees = async () => ({ cliPid: 0, cli: { pid: 0, startTicks: 0 }, killed: [], refused: [], spared: [], survivors: [], rounds: 0 });
  trapDeps.settleMs = 0; trapDeps.originWaitMs = 0;
  trapMod.startPauseTrap(trapDeps);
}
function stopAll() {
  W?.stopAllWatchers?.();
  spool.stopEventsSpool(); tray.stopInboxWatcher(); gates.stopHumanGatesWatcher(); pauseUi.stopPauseUiWatcher(); wake.stopBusWake(); trapMod.stopPauseTrap();
}

// ── the five live paths: a WRITE (as another process would) and the effect an operator / a member SEES ──
async function until(pred, ms) { const s = Date.now(); while (Date.now() - s < ms) { if (await pred()) return Date.now() - s; await sleep(15); } return (await pred()) ? Date.now() - s : null; }
/** The member READS and ACKS its mail (as `orchestra check` + `ack` would) — the Réveil engine does not re-wake a reader whose earlier mail is still unread. */
function memberAcks() { const c = cliDb(); try { const lot = busMod.check(c, 'ws-ops', 'ws-m1'); if (lot?.delivery) busMod.ack(c, 'ws-ops', 'ws-m1', lot.delivery.id ?? lot.delivery.lot_id); } finally { c.close(); } }
const paths = {
  pause_ui: {
    write: () => { const c = cliDb(); try { const cur = c.prepare('SELECT paused_at FROM runs WHERE id = ?').get('ws-ops')?.paused_at; busPause.setRunPause(c, 'ws-ops', cur == null, null, 'soft', { human: true }); } finally { c.close(); } }, // toggles: every write CHANGES the pause column
    seen: (i) => since(i, 'pause:update').length > 0,
  },
  wake: {
    write: () => { const c = cliDb(); try { busMod.send(c, { runId: 'ws-ops', sender: 'ws-ops', kind: 'dispatch', body: `wake ${Date.now()}`, recipient: 'ws-m1' }); } finally { c.close(); } },
    seen: () => wakes.length > paths.wake.base,
  },
  human_gates: {
    write: () => { const c = cliDb(); try { busMod.openGate(c, 'ws-ops', 'ws-m1', `question ${Date.now()}?`, HUMAN_GATE_RECIPIENT); } finally { c.close(); } },
    seen: (i) => since(i, 'human-gates:update').length > 0,
  },
  inbox: {
    write: () => { fs.mkdirSync(INBOX_DIR, { recursive: true }); fs.writeFileSync(tray.inboxFilePath('ws-m1'), serializeInboxBlocks([`parked ${Date.now()}`]), 'utf8'); },
    seen: (i) => since(i, 'inbox:update').some((e) => e.args[0]?.workspaceId === 'ws-m1' && e.args[0]?.count > 0),
  },
};
paths.wake.base = 0;
/** write, then wait up to `ms` for the effect; returns elapsed ms or null (never seen) */
async function live(name, ms) {
  const p = paths[name];
  const i = mark();
  if (name === 'wake') { memberAcks(); await sleep(50); p.base = wakes.length; }
  const tw = Date.now();
  p.write();
  const el = await until(() => p.seen(i), ms);
  return el === null ? null : Date.now() - tw;
}
const trapStamped = () => { const r = db.prepare('SELECT pause_trap_at FROM runs WHERE id = ?').get('ws-ops'); return r?.pause_trap_at != null; };

const fixed = !!W; // the tree under test has the resilient watchers
const logText = () => { try { return fs.readFileSync(loggerMod.getLogFile(), 'utf8'); } catch { return ''; } };
const countLog = (re) => (logText().match(re) ?? []).length;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (ARM === 'control') {
  startAll();
  await sleep(300);
  check('cli_bundle_fresh', cliFresh, `${CLI} is older than its inputs — pnpm run build:cli`);
  for (const name of ['pause_ui', 'wake', 'human_gates', 'inbox']) {
    const ms = await live(name, 3000);
    check(`${name}_live_under_1s`, ms !== null && ms < LIVE_MS, `seen after ${ms} ms (bound ${LIVE_MS})`);
  }
  {
    const i0 = Date.now();
    busPause.setRunPause(cliDb(), 'ws-ops', true, null, 'hard', { human: true });
    const ms = await until(trapStamped, 3000);
    check('trap_live_under_1s', ms !== null && ms < LIVE_MS, `hard Pause trapped after ${ms} ms (bound ${LIVE_MS}); since write ${Date.now() - i0} ms`);
  }
  const block = await watchersBlock();
  check('bus_status_all_ok', /^watchers: 6 ok$/m.test(block), `block: ${JSON.stringify(block)}`);
  check('no_watcher_push_when_healthy', since(0, 'watchers:update').length === 0, `${since(0, 'watchers:update').length} pushes`);
  stopAll();
  await finish();
}

if (ARM === 'degraded') {
  fault = true;
  startAll();
  await sleep(200);
  check('cli_bundle_fresh', cliFresh, `${CLI} is older than its inputs — pnpm run build:cli`);
  const failedDirs = new Set(watchCalls.filter((c) => c.failed).map((c) => c.dir));
  check('injection_took_effect', failedDirs.size >= 3, `only ${failedDirs.size} dirs failed: ${[...failedDirs].join(',')}`);
  const block = await watchersBlock();
  check('bus_status_lists_six_degraded', /^watchers: 0\/6 ok · 6 DEGRADED/m.test(block) && SIX.every((n) => new RegExp(`^  ${n} DEGRADED since `, 'm').test(block)), `block: ${JSON.stringify(block)}`);
  check('bus_status_names_the_system_limit', /system watch limit reached \(EMFILE\)/.test(block), `block: ${JSON.stringify(block)}`);
  const pushes = events.filter((e) => e.channel === 'watchers:update');
  check('renderer_told_once_per_degradation', pushes.length >= 1 && pushes.length <= 6 && (pushes[pushes.length - 1]?.args[0]?.watchers ?? []).filter((w) => w.state === 'degraded').length === 6, `${pushes.length} pushes; last degraded=${(pushes[pushes.length - 1]?.args[0]?.watchers ?? []).filter((w) => w.state === 'degraded').length}`);
  // the injection works: the live paths are NOT served (positive control for the fallback below)
  const dead = {};
  for (const name of ['pause_ui', 'wake', 'human_gates', 'inbox']) dead[name] = await live(name, QUIET_MS);
  check('live_paths_dead_while_degraded', Object.values(dead).every((v) => v === null), `seen live while every watch is down: ${JSON.stringify(dead)}`);
  // the fallback each subsystem keeps (what the 60 s sweep / the pull does) still serves the writes
  const iPull = mark();
  pauseUi.reconcilePauseUi();
  check('fallback_pull_serves_pause_ui', since(iPull, 'pause:update').length > 0, 'the pull pushed nothing');
  const wbase = wakes.length;
  await wake.sweepBusWakeNow();
  check('fallback_sweep_serves_wake', wakes.length > wbase, 'the sweep delivered no wake');
  stopAll();
  await finish();
}

if (ARM === 'recovery') {
  fault = true;
  startAll();
  await sleep(200);
  check('cli_bundle_fresh', cliFresh, `${CLI} is older than its inputs — pnpm run build:cli`);
  // writes made WHILE degraded (no live path serves them — proven by the degraded arm; here they are the catch-up payload)
  const tWrite = Date.now();
  busPause.setRunPause(db, 'ws-ops', true, null, 'hard', { human: true });
  const cdb = cliDb(); busMod.send(cdb, { runId: 'ws-ops', sender: 'ws-ops', kind: 'dispatch', body: 'while degraded', recipient: 'ws-m1' }); busMod.openGate(cdb, 'ws-ops', 'ws-m1', 'asked while degraded?', HUMAN_GATE_RECIPIENT); cdb.close();
  fs.mkdirSync(INBOX_DIR, { recursive: true }); fs.writeFileSync(tray.inboxFilePath('ws-m1'), serializeInboxBlocks(['parked while degraded']), 'utf8');
  const iDown = mark(); const wDown = wakes.length;
  await sleep(QUIET_MS);
  check('nothing_served_live_while_degraded', since(iDown, 'pause:update').length === 0 && since(iDown, 'human-gates:update').length === 0 && since(iDown, 'inbox:update').length === 0 && wakes.length === wDown, `pause=${since(iDown, 'pause:update').length} gates=${since(iDown, 'human-gates:update').length} inbox=${since(iDown, 'inbox:update').length} wakes=${wakes.length - wDown}`);
  const downBlock = await watchersBlock();
  check('bus_status_degraded_before_recovery', /DEGRADED/.test(downBlock), `block: ${JSON.stringify(downBlock)}`);
  // lift the resource crunch; the app must heal BY ITSELF (nobody restarts anything, nobody writes again)
  const iUp = mark(); fault = false; const tLift = Date.now();
  const healed = await until(async () => /^watchers: 6 ok$/m.test(await watchersBlock()), 6000);
  check('bus_status_clean_within_backoff', healed !== null, `still: ${JSON.stringify(await watchersBlock())} ${Math.round((Date.now() - tLift) / 100) / 10}s after the crunch lifted`);
  const pushes = events.slice(iUp).filter((e) => e.channel === 'watchers:update');
  check('renderer_told_all_clear', pushes.length >= 1 && (pushes[pushes.length - 1]?.args[0]?.watchers ?? []).every((w) => w.state === 'ok') && (pushes[pushes.length - 1]?.args[0]?.watchers ?? []).length === 6, `${pushes.length} pushes after the lift`);
  // the catch-up: the writes made while degraded surface WITHOUT any new write
  await sleep(600);
  check('catchup_pause_ui_push', since(iUp, 'pause:update').length > 0, 'no Pause UI push after recovery with no new write');
  check('catchup_wake_delivered', wakes.length > wDown, 'the message sent while degraded was not woken on recovery');
  check('catchup_gate_push', since(iUp, 'human-gates:update').length > 0, 'no gates push after recovery');
  check('catchup_inbox_push', since(iUp, 'inbox:update').some((e) => e.args[0]?.workspaceId === 'ws-m1' && e.args[0]?.count > 0), 'no inbox push after recovery');
  check('catchup_trap_stamped', trapStamped(), 'the hard Pause written while degraded was not trapped after recovery');
  // and the live paths are back, < 1 s
  busPause.setRunPause(db, 'ws-ops', false, null, 'soft', { human: true });
  for (const name of ['pause_ui', 'wake', 'human_gates', 'inbox']) {
    const ms = await live(name, 3000);
    check(`${name}_live_again_under_1s`, ms !== null && ms < LIVE_MS, `seen after ${ms} ms (bound ${LIVE_MS})`);
  }
  // edge-triggered log: one WARN per degradation, one INFO per recovery
  const warns = countLog(/\[WARN\][^\n]*watcher\[[a-z-]+\]: DEGRADED/g);
  const infos = countLog(/\[INFO\][^\n]*watcher\[[a-z-]+\]: RECOVERED/g);
  check('log_one_warn_one_info_per_watcher', warns === 6 && infos === 6, `WARN×${warns} INFO×${infos} (want 6/6)`);
  stopAll();
  await finish();
}

if (ARM === 'midlife') {
  startAll();
  await sleep(300);
  const base = await live('wake', 3000);
  check('healthy_before_death', base !== null && base < LIVE_MS, `wake ${base} ms`);
  memberAcks(); await sleep(500); // the member read its mail (the next message is a NEW wake); the debounces that ack armed settle BEFORE the death, or they would serve the next writes
  const killed = killWatch(BUS_DIR);
  check('injection_took_effect', killed >= 3, `${killed} bus-directory watches killed`);
  check('error_event_has_a_listener', uncaughtErrorEvents === 0, `${uncaughtErrorEvents} of ${killed} watches had NO error listener — the event threw (an uncaught exception in the Electron main process)`);
  // the next writes while the watches are dead and not yet re-armed: first observation window is shorter than the first backoff step
  const i = mark(); const wb = wakes.length;
  const c = cliDb(); busMod.send(c, { runId: 'ws-ops', sender: 'ws-ops', kind: 'dispatch', body: 'after the death', recipient: 'ws-m1' }); busPause.setRunPause(c, 'ws-ops', true, null, 'soft', { human: true }); c.close();
  await sleep(700); // < the first backoff step (1 s): the dead watches serve nothing yet (positive control — the same on master)
  check('dead_watches_serve_nothing_at_first', wakes.length === wb && since(i, 'pause:update').length === 0, `wakes=${wakes.length - wb} pause pushes=${since(i, 'pause:update').length} 0.7 s after the death`);
  // the fixed tree re-arms and catches up within its first backoff step (+ margin); master never does
  const back = await until(() => wakes.length > wb && since(i, 'pause:update').length > 0, 5000);
  check('rearmed_and_caught_up', back !== null, `after 5 s: wakes=${wakes.length - wb} pause pushes=${since(i, 'pause:update').length}`);
  const block = await watchersBlock();
  check('bus_status_clean_after_rearm', /^watchers: 6 ok$/m.test(block), `block: ${JSON.stringify(block)}`);
  const ms = await live('wake', 3000);
  check('live_again_under_1s', ms !== null && ms < LIVE_MS, `wake ${ms} ms`);
  const ms2 = await live('pause_ui', 3000);
  check('pause_ui_live_again_under_1s', ms2 !== null && ms2 < LIVE_MS, `pause_ui ${ms2} ms`);
  stopAll();
  await finish();
}

if (ARM === 'silent_detach') {
  W?.__setWatchHealthMsForTests?.(500);
  startAll();
  await sleep(300);
  const base = await live('inbox', 3000);
  check('healthy_before_detach', base !== null && base < LIVE_MS, `inbox ${base} ms`);
  // delete + recreate the watched directory: the inotify watch is gone and says nothing
  fs.rmSync(INBOX_DIR, { recursive: true, force: true }); fs.mkdirSync(INBOX_DIR, { recursive: true });
  await sleep(150);
  const i = mark();
  fs.writeFileSync(tray.inboxFilePath('ws-m1'), serializeInboxBlocks([`after the swap ${Date.now()}`]), 'utf8');
  await sleep(300);
  check('detach_is_real_nothing_seen_at_first', since(i, 'inbox:update').length === 0, `the swapped directory still delivered ${since(i, 'inbox:update').length} events — the arm would be vacuous`);
  const back = await until(() => since(i, 'inbox:update').some((e) => e.args[0]?.workspaceId === 'ws-m1' && e.args[0]?.count > 0), 6000);
  check('rearmed_and_pushed', back !== null, 'no inbox push within 6 s of the directory swap');
  const ms = await live('inbox', 3000);
  check('live_again_under_1s', ms !== null && ms < LIVE_MS, `inbox ${ms} ms`);
  stopAll();
  await finish();
}

if (ARM === 'shutdown') {
  fault = true;
  startAll();
  await sleep(200);
  check('degraded_at_start', watchCalls.filter((c) => c.failed).length >= 3, `${watchCalls.filter((c) => c.failed).length} failed arms`);
  check('registry_present', !!W && typeof W.stopAllWatchers === 'function', 'src/main/watchers.ts is absent');
  stopAll(); // the production shutdown path: stopAllWatchers + each subsystem's own stop
  const calls = watchCalls.length;
  await sleep(4500); // spans the 1 s and 3 s retries
  check('no_retry_after_shutdown', watchCalls.length === calls && !!W, `${watchCalls.length - calls} fs.watch calls after shutdown`);
  const st = W?.watchersStatus?.();
  check('registry_empty_after_shutdown', !!st && st.watchers.length === 0, `${st?.watchers?.length} watchers still registered`);
  await finish();
}

check('unknown_arm', false, ARM);
await finish();
