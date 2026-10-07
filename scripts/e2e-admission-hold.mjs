// #286 (wave G, ledger #295; epic #284 Testing "Seam 1") — Admission: AUTOMATIC starts of fleet members are HELD under low memory and released in order.
// Driven through the REAL modules (workspaces.ts spawn + restart, restart-workspace.ts, admission.ts, memory-guard.ts, hooks-server.ts + the BUILT CLI)
// + the REAL store + a REAL bus.sqlite. The ONLY fakes: the MemAvailable number (the guard's injectable source) and the SDK delivery seam, which RECORDS
// every start/stop instead of launching a CLI ("no session process starts" = no `start` recorded). One arm per process; no arg = run them all.
//
// SAFETY (D4): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR under ~/.cache (btrfs), refused anywhere near a live ~/.orchestra / ~/.claude*; every `claude`
// is absent/stubbed, no network, no live bus, no real run is paused/held/resumed.
//
// Fleet (seedFleet): ws-ops (OPS) ⊃ ws-m1, ws-m2 (members), ws-sub (a SUB-OPS = coordinator, member of ws-ops, owes its brief); ws-top (top-level, no coordinator).
//
//   open_passes      CONTROL  12 GB: an auto spawn of a member starts at once (the instrument can see a start)
//   spawn_held       ★ must-FAIL on master  4 GB: the spawn is ACCEPTED (ok + held{since}), the workspace exists with its brief owed, NO session starts
//   release_order    ★ recovery releases the COORDINATOR first, then arrival order, ONE at a time, a FRESH reading before each
//   dip_stops        ★ a recovery that dips again stops the release; the retry finishes it once memory is back
//   human_passes     ★ a human Restart / a top-level spawn passes while held
//   running_turn_passes ★ a message to an ALREADY-RUNNING member is delivered live while held
//   restart_waits    ★ an AUTO restart of a running member is held BEFORE any stop (nothing is stopped); it runs on recovery
//   pause_keeps_slot ★ a release refused because a fleet PAUSE landed while held keeps its slot (not lost), and goes out after the lift
//   release_selfsample ★ (review F1) recovery seen FIRST by the release pass's OWN fresh sample (NO explicit guard.sampleNow): still ONE at a time, a fresh reading each
//   pause_other_run  ★ (review F2) a Pause-refused entry of run A never blocks run B's held start; A's goes out after the lift
//   deleted_while_held ★ (review F4) deleting a held workspace drops it from the queue / peers
//   composer_drops_restart ★ (review F4) a person starting the stopped member meanwhile makes its held restart redundant: gone from the queue, never run
//   failed_release_reported ★ (review F4) a released start that FAILS tells the coordinator (bus escalation), not a log line only
//   toggle_off       ★ the global toggle OFF holds nothing
//   visible          ★ the OPS sees the held member (since-when) in `peers` + `bus-status` (real hooks-server + built CLI); gone after the release
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-admission-hold.mjs   (RIG_REPO=<tree> = the must-FAIL run on master)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['open_passes', 'spawn_held', 'release_order', 'dip_stops', 'human_passes', 'running_turn_passes', 'restart_waits', 'pause_keeps_slot', 'release_selfsample', 'pause_other_run', 'deleted_while_held', 'composer_drops_restart', 'failed_release_reported', 'toggle_off', 'visible'];
const GIB = 1024 ** 3;

if (!ARM) {
  const rows = [];
  const only = process.env.RIG_ARMS ? new Set(process.env.RIG_ARMS.split(',')) : null;   // the mutant harness runs only the arms a mutant names
  for (const arm of ARMS) {
    if (only && !only.has(arm)) continue;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm], { env: { ...process.env }, encoding: 'utf8', timeout: 150_000 });
    const lastJson = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = lastJson ? JSON.parse(lastJson) : null; } catch { /* below */ }
    rows.push({ arm, ok: v?.ok === true, detail: v ? (v.ok ? '' : v.why ?? v.abort ?? '') : `no verdict (exit ${r.status}) ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}` });
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.arm}${r.detail ? ` — ${r.detail}` : ''}`);
  const red = rows.filter((r) => !r.ok);
  console.log(`ADMISSION RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length}) tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.ADMISSION_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-admission-hold'));
const tmpHome = path.join(base, ARM);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const stubBin = path.join(tmpHome, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;
process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';

const T = (m) => { if (process.env.RIG_TRACE) console.error(`[trace ${Date.now() % 100000}] ${m}`); };
const out = { arm: ARM, tree: REPO };
const fails = [];
const verdict = (extra = {}) => { console.log(JSON.stringify({ ...out, ...extra, ok: fails.length === 0, ...(fails.length ? { why: fails.join(' | ') } : {}) })); process.exit(fails.length === 0 ? 0 : 1); };
setInterval(() => {}, 1000);   // keep the loop alive: a hung await must end as a RED verdict at the deadline, never a silent exit
setTimeout(() => { fails.push('deadline: the arm hung'); verdict(); }, 100_000).unref?.();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) { const ok = eq(got, want); out[name] = got; if (!ok) fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000, step = 20) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return false; };

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-admission', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-admission', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
T('store loaded');
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);          // registers the REAL delivery seam; useFakeSeam overrides it
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
T('modules imported');
busMod.initBus();
T('bus ready');
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
if (!String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }

// ── the memory source + the REAL guard on it + the REAL admission (absent on master → nothing is wired, the arms then read RED) ──
let mem = 12;                                   // GB the fake MemAvailable source reports; null = unreadable
let reads = 0;
const hasAdmission = fs.existsSync(path.join(REPO, 'src/main/admission.ts'));
const guardMod = await import(`${REPO}/src/main/memory-guard.ts`);
guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
const guard = guardMod.__rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {} }, () => { reads += 1; return mem === null ? null : mem * GIB; });
guard.start();
let admMod = null;
if (hasAdmission) {
  admMod = await import(`${REPO}/src/main/admission.ts`);
  admMod.__rebuildAdmissionForTests({ settleMs: 5, retryMs: 40 });
  admMod.startAdmission();
}
T('guard+admission wired');
out.hasAdmission = hasAdmission;

// ── fake delivery seam: RECORDS every start / stop; `start` takes a beat (so overlap would be visible) ──
const calls = { start: [], stop: [], send: [], awaiting: [] };
let inFlight = 0, maxInFlight = 0;
let onStart = null;
const failStart = new Set();
function useFakeSeam({ hasSession = () => false } = {}) {
  delivery.registerSdkDelivery({
    hasSession, hasBackgroundTask: () => false,
    send: async (wsId, text, peer, origin) => { calls.send.push({ wsId, text, origin }); },
    sendAwaitingStart: async (wsId, text, peer, ms, origin) => { calls.awaiting.push({ wsId, text, origin }); return 'started'; },
    start: async (wsId, text, opts) => {
      if (failStart.has(wsId)) throw new Error('worktree gone (rig: forced start failure)');
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      T(`seam.start ${wsId} inFlight=${inFlight}`);
      calls.start.push({ wsId, text, origin: opts?.origin, readsAt: reads });
      onStart?.(calls.start.length);
      await sleep(25);
      inFlight -= 1;
      T(`seam.start done ${wsId}`);
    },
    stop: async (wsId) => { calls.stop.push(wsId); },
  });
}
let factoryCalls = 0;
sdk.__setQueryFactoryForTests(({ prompt }) => {
  factoryCalls++;
  const pending = []; let wake = null;
  let firstSeen = () => {}; const first = new Promise((r) => { firstSeen = r; });
  void (async () => { try { for await (const m of prompt) { void m; firstSeen(); } } catch { /* torn down */ } })();
  return {
    async *[Symbol.asyncIterator]() {
      await first;
      yield { type: 'system', subtype: 'init', session_id: 'adm', tools: [], slash_commands: [] };
      for (;;) { while (pending.length) yield pending.shift(); await new Promise((r) => { wake = r; }); }
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

// ── fleet + a real repo for spawn ──
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: tmpHome, status: 'idle', createdAt: now0 - 40 * 60_000, ...extra });
const ON = { ...DEFAULT_BUS_SWITCHES, wake: true, liveness: true, pause: true };
async function seedFleet() {
  busRuns.startRun(db, { id: 'ws-ops', kind: 'vague', coordinator: 'ws-ops' }, ON);
  await store.upsertWorkspace(mk('ws-ops', { kind: 'orchestrator' }));
  await store.upsertWorkspace(mk('ws-m1', { parentId: 'ws-ops' }));
  await store.upsertWorkspace(mk('ws-m2', { parentId: 'ws-ops' }));
  await store.upsertWorkspace(mk('ws-sub', { kind: 'orchestrator', parentId: 'ws-ops', lastTask: 'SUB-BRIEF' }));   // a coordinator that still owes its brief
  await store.upsertWorkspace(mk('ws-xm'));
}
const repoDir = path.join(tmpHome, 'repo');
function gitInit() {
  const g = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } });
  fs.mkdirSync(repoDir, { recursive: true });
  g(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); g(['add', '.']); g(['commit', '-q', '-m', 'seed']);
}
const spawnMember = (task, over = {}) => workspaces.dispatchSpawnRequest({ from: 'ws-ops', task, repoPath: repoDir, agent: 'claude', defaultKind: 'spawned', ...over });
const wsRec = (id) => store.getWorkspace(id);
const { dispatchRestartRequest } = await import(`${REPO}/src/main/restart-workspace.ts`);

useFakeSeam();
T('before seed');
await seedFleet();
T('seeded');
gitInit();
T('git ready');
await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
T('repo added');
const startedFor = (id) => calls.start.filter((c) => c.wsId === id).length;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (ARM === 'open_passes') {
  mem = 12; guard.sampleNow();
  T('spawning');
  const r = await spawnMember('OPEN-BRIEF');
  T('spawned');
  check('spawn_ok', r.ok === true && !r.held, true);
  check('started_at_once', startedFor(r.id), 1);
  verdict();
}

if (ARM === 'spawn_held') {
  mem = 4; guard.sampleNow();
  const r = await spawnMember('HELD-BRIEF');
  check('accepted', r.ok === true, true);                                                   // accepted, not refused
  check('held_reply', typeof r.held?.since === 'number' && /held for memory since/.test(r.note ?? ''), true);
  const w = r.id ? wsRec(r.id) : null;
  check('workspace_exists', !!w && w.parentId === 'ws-ops', true);
  check('brief_still_owed', w?.lastTask === 'HELD-BRIEF' && !w?.hasInput && !w?.openingTaskDelivered, true);
  await sleep(150);
  check('no_session_started', calls.start.length + factoryCalls, 0);                        // ← master starts a process immediately
  verdict();
}

if (ARM === 'release_order') {
  mem = 4; guard.sampleNow();
  const a = await spawnMember('BRIEF-A');
  const b = await spawnMember('BRIEF-B');
  const sub = await dispatchRestartRequest({ id: 'ws-sub', fresh: false, trigger: 'cli' });    // the COORDINATOR, queued LAST
  check('all_held', [a.held ? 'h' : '-', b.held ? 'h' : '-', sub.held ? 'h' : '-'], ['h', 'h', 'h']);
  check('nothing_started_while_held', calls.start.length, 0);
  if (admMod) check('queue_order_is_arrival', admMod.listHeldStarts().map((h) => h.wsId), [a.id, b.id, 'ws-sub']);
  mem = 9; guard.sampleNow();                                                                // recovery: the reopen edge triggers the release
  await until(() => calls.start.length >= 3);
  check('coordinator_first_then_arrival', calls.start.map((c) => c.wsId), ['ws-sub', a.id, b.id]);
  check('one_at_a_time', maxInFlight, 1);
  const rs = calls.start.map((c) => c.readsAt);
  check('fresh_reading_before_each_release', rs.every((x, i) => i === 0 || x > rs[i - 1]), true);
  check('queue_drained', admMod ? admMod.listHeldStarts().length : -1, hasAdmission ? 0 : -1);
  verdict();
}

if (ARM === 'dip_stops') {
  mem = 4; guard.sampleNow();
  const a = await spawnMember('DIP-A');
  const b = await spawnMember('DIP-B');
  const c = await spawnMember('DIP-C');
  onStart = (n) => { if (n === 1) mem = 6.8; };                                            // the first release eats the margin: memory dips again
  mem = 9; guard.sampleNow();
  await until(() => calls.start.length >= 1);
  await sleep(250);                                                                         // several retry ticks (40 ms) fire while memory is low
  check('release_stopped_after_one', calls.start.map((x) => x.wsId), [a.id]);
  check('rest_still_held', admMod ? admMod.listHeldStarts().map((h) => h.wsId) : [], hasAdmission ? [b.id, c.id] : []);
  onStart = null; mem = 9;                                                                  // memory is really back: the retry finishes the job on its own
  await until(() => calls.start.length >= 3);
  check('retry_finished_the_release', calls.start.map((x) => x.wsId), [a.id, b.id, c.id]);
  verdict();
}

if (ARM === 'human_passes') {
  mem = 4; guard.sampleNow();
  const held = await spawnMember('HUMAN-HELD');
  const held2 = await spawnMember('HUMAN-HELD-2');
  check('control_auto_is_held', [!!held.held, !!held2.held], [true, true]);                  // the instrument can see a hold
  const before = calls.start.length;
  // AC3 — a human-initiated start of the SAME held member passes (the toolbar Restart of a kept child that still owes its brief)
  const tb = await dispatchRestartRequest({ id: held.id, fresh: false, trigger: 'toolbar' });
  check('toolbar_restart_of_the_held_member_passes', tb.ok === true && !tb.held && tb.openingTask === true, true);
  check('toolbar_start_ran', calls.start.slice(before).map((c) => [c.wsId, c.origin]), [[held.id, 'human']]);
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('no_stale_held_marker_on_it', [peers.peers.find((p) => p.id === held.id)?.heldForMemory ?? null, hasAdmission ? admMod.heldStartFor(held.id) : null], [null, null]);
  const top = await workspaces.dispatchSpawnRequest({ task: 'TOP-LEVEL', repoPath: repoDir, agent: 'claude', defaultKind: 'workspace' });   // a human click: no `from`, no coordinator
  check('top_level_spawn_passes', top.ok === true && !top.held && startedFor(top.id) === 1, true);
  check('the_other_auto_one_is_still_held', hasAdmission ? admMod.listHeldStarts().map((h) => h.wsId) : [held2.id], [held2.id]);
  verdict();
}

if (ARM === 'running_turn_passes') {
  useFakeSeam({ hasSession: (id) => id === 'ws-m1' });
  mem = 4; guard.sampleNow();
  const held = await spawnMember('RUN-HELD');
  check('control_auto_is_held', !!held.held, true);
  const msg = await workspaces.dispatchMessageRequest({ from: 'ws-xm', to: 'ws-m1', text: 'TURN-TO-RUNNING', emergency: true });
  check('delivered_live', msg.ok === true && msg.delivery === 'live', true);
  check('through_the_live_seam', calls.awaiting.map((c) => c.wsId), ['ws-m1']);
  check('no_start_for_the_running_member', startedFor('ws-m1'), 0);
  verdict();
}

if (ARM === 'restart_waits') {
  useFakeSeam({ hasSession: (id) => id === 'ws-m1' });
  await store.upsertWorkspace({ ...wsRec('ws-m1'), sdkSessionId: 'sess-m1', hasInput: true });
  mem = 4; guard.sampleNow();
  const spawnsBefore = factoryCalls;
  const r = await dispatchRestartRequest({ id: 'ws-m1', fresh: false, trigger: 'cli' });
  check('accepted_and_held', r.ok === true && typeof r.held?.since === 'number', true);
  check('nothing_was_stopped', [calls.stop.length, factoryCalls - spawnsBefore], [0, 0]);   // the held restart never touched the running session
  mem = 9; guard.sampleNow();
  check('runs_on_recovery', await until(() => (factoryCalls - spawnsBefore) >= 1 || calls.stop.length >= 1, 8000), true);
  verdict();
}

if (ARM === 'pause_keeps_slot') {
  const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
  useFakeSeam({ hasSession: (id) => id === 'ws-m1' });
  await store.upsertWorkspace({ ...wsRec('ws-m1'), sdkSessionId: 'sess-m1', hasInput: true });
  mem = 4; guard.sampleNow();
  const before = factoryCalls;
  const r = await dispatchRestartRequest({ id: 'ws-m1', fresh: false, trigger: 'cli' });
  check('control_held', !!r.held, true);
  check('pause_landed', busPause.setRunPause(db, 'ws-ops', true, 'ws-ops') !== 'switch-off', true);   // a manual hard Pause lands while the restart is held
  mem = 9; guard.sampleNow();                                                                      // recovery: the release is attempted and REFUSED by the Pause
  await sleep(300);                                                                                // several retry ticks (40 ms) — still refused
  check('still_queued_in_its_slot', hasAdmission ? admMod.listHeldStarts().map((h) => h.wsId) : ['ws-m1'], ['ws-m1']);
  check('nothing_restarted_while_paused', [factoryCalls - before, calls.stop.length], [0, 0]);
  busPause.setRunPause(db, 'ws-ops', false, 'ws-ops');                                             // lift
  check('goes_out_after_the_lift', await until(() => factoryCalls - before >= 1 || calls.stop.length >= 1, 8000), true);
  check('queue_drained', hasAdmission ? admMod.listHeldStarts().length : 0, 0);
  verdict();
}

if (ARM === 'release_selfsample') {
  mem = 4; guard.sampleNow();
  const a = await spawnMember('SELF-A');
  const b = await spawnMember('SELF-B');
  const sub = await dispatchRestartRequest({ id: 'ws-sub', fresh: false, trigger: 'cli' });
  check('all_held', [a.held ? 'h' : '-', b.held ? 'h' : '-', sub.held ? 'h' : '-'], ['h', 'h', 'h']);
  mem = 9;                                                    // recovered — and NO guard.sampleNow(): the retry timer's pass is the first to read the new value
  await until(() => calls.start.length >= 3);
  check('coordinator_first_then_arrival', calls.start.map((c) => c.wsId), ['ws-sub', a.id, b.id]);
  check('one_at_a_time', maxInFlight, 1);                     // two concurrent passes started two at once
  const rs = calls.start.map((c) => c.readsAt);
  check('fresh_reading_before_each_release', rs.every((x, i) => i === 0 || x > rs[i - 1]), true);
  verdict();
}

if (ARM === 'pause_other_run') {
  const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
  busRuns.startRun(db, { id: 'ws-ops2', kind: 'vague', coordinator: 'ws-ops2' }, ON);
  await store.upsertWorkspace(mk('ws-ops2', { kind: 'orchestrator' }));
  await store.upsertWorkspace({ ...mk('ws-m4', { parentId: 'ws-ops2' }), sdkSessionId: 'sess-m4', hasInput: true });
  await store.upsertWorkspace({ ...wsRec('ws-m1'), sdkSessionId: 'sess-m1', hasInput: true });
  useFakeSeam({ hasSession: (id) => id === 'ws-m1' || id === 'ws-m4' });
  mem = 4; guard.sampleNow();
  const before = factoryCalls;
  const x = await dispatchRestartRequest({ id: 'ws-m1', fresh: false, trigger: 'cli' });     // run ws-ops — queued FIRST (head of the line)
  const y = await dispatchRestartRequest({ id: 'ws-m4', fresh: false, trigger: 'cli' });     // run ws-ops2 — queued behind it
  check('both_held', [!!x.held, !!y.held], [true, true]);
  check('pause_landed', busPause.setRunPause(db, 'ws-ops', true, 'ws-ops') !== 'switch-off', true);   // ONLY run ws-ops is paused
  mem = 9; guard.sampleNow();
  check('other_run_goes_out_despite_the_refused_head', await until(() => factoryCalls - before >= 1, 8000), true);
  await sleep(250);
  check('the_paused_one_kept_its_slot_not_restarted', [hasAdmission ? admMod.listHeldStarts().map((h) => h.wsId) : ['ws-m1'], factoryCalls - before], [['ws-m1'], 1]);
  busPause.setRunPause(db, 'ws-ops', false, 'ws-ops');
  check('goes_out_after_the_lift', await until(() => factoryCalls - before >= 2, 8000), true);
  verdict();
}

if (ARM === 'deleted_while_held') {
  mem = 4; guard.sampleNow();
  const r = await spawnMember('DELETE-ME');
  check('control_held', [!!r.held, hasAdmission ? admMod.listHeldStarts().map((h) => h.wsId) : [r.id]], [true, [r.id]]);
  await workspaces.deleteWorkspace(r.id);
  check('gone_from_the_queue', hasAdmission ? admMod.listHeldStarts().length : 0, 0);
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('gone_from_peers', peers.peers.some((p) => p.id === r.id), false);
  mem = 12; guard.sampleNow();
  await sleep(250);
  check('nothing_started_for_it', startedFor(r.id), 0);
  const fresh = await spawnMember('AFTER-DELETE');                                         // no phantom line: plentiful memory, nobody queued → passes
  check('no_phantom_line', !fresh.held && startedFor(fresh.id) === 1, true);
  verdict();
}

if (ARM === 'composer_drops_restart') {
  await store.upsertWorkspace({ ...wsRec('ws-m2'), sdkSessionId: 'sess-m2', hasInput: true });   // STOPPED when the restart is held
  let m2Live = false;
  useFakeSeam({ hasSession: (id) => id === 'ws-m2' && m2Live });
  mem = 4; guard.sampleNow();
  const before = factoryCalls;
  const r = await dispatchRestartRequest({ id: 'ws-m2', fresh: false, trigger: 'cli' });
  check('control_held', [!!r.held, hasAdmission ? admMod.listHeldStarts().map((h) => h.wsId) : ['ws-m2']], [true, ['ws-m2']]);
  m2Live = true;                                              // a person typed into the stopped member (the composer reaches sdkSend without passing the two gates)
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('peers_no_longer_says_held', peers.peers.find((p) => p.id === 'ws-m2')?.heldForMemory ?? null, null);
  check('queue_no_longer_has_it', hasAdmission ? admMod.listHeldStarts().length : 0, 0);
  mem = 9; guard.sampleNow();
  await sleep(300);
  check('no_redundant_restart_at_recovery', [factoryCalls - before, calls.stop.length], [0, 0]);
  verdict();
}

if (ARM === 'failed_release_reported') {
  mem = 4; guard.sampleNow();
  const r = await spawnMember('WILL-FAIL');
  check('control_held', !!r.held, true);
  failStart.add(r.id);                                        // the start will throw when released (e.g. the worktree vanished)
  mem = 9; guard.sampleNow();
  const rows = () => db.prepare("SELECT sender, recipient, kind, body FROM messages WHERE kind = 'escalation' AND sender = ?").all(r.id);
  check('coordinator_was_told', await until(() => rows().length >= 1, 8000), true);
  const m = rows()[0] ?? {};
  check('to_the_coordinator_from_the_member', [m.recipient, m.sender === r.id], ['ws-ops', true]);
  check('says_what_and_how_to_retry', [/HELD for memory since/.test(m.body ?? ''), /did NOT start/.test(m.body ?? ''), /orchestra restart /.test(m.body ?? '')], [true, true, true]);
  check('not_queued_any_more', hasAdmission ? admMod.listHeldStarts().length : 0, 0);
  verdict();
}

if (ARM === 'toggle_off') {
  await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), admissionEnabled: false });
  mem = 4; guard.sampleNow();
  const r = await spawnMember('TOGGLE-OFF');
  check('spawn_not_held', r.ok === true && !r.held, true);
  check('started_at_once', startedFor(r.id), 1);
  verdict();
}

if (ARM === 'visible') {
  mem = 4; guard.sampleNow();
  const r = await spawnMember('VISIBLE-BRIEF');
  check('control_held', !!r.held, true);
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  const row = peers.peers.find((p) => p.id === r.id);
  check('peers_row_says_held_with_since', row?.heldForMemory?.since === r.held?.since && row?.heldForMemory?.kind === 'spawn', true);
  // the REAL hooks-server + the BUILT CLI
  const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
  await hooks.startHooksServer();
  const sock = hooks.getHookSocketPath();
  const CLI = path.join(REPO, 'dist-electron', 'cli.js');
  if (!fs.existsSync(CLI)) { fails.push(`${CLI} not built (pnpm run build:cli)`); verdict(); }
  check('cli_bundle_is_fresh', fs.readFileSync(CLI, 'utf8').includes('held starts:') || !hasAdmission, true);   // a stale dist-electron/cli.js would read RED for the wrong reason
  const cli = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: 'ws-ops' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = ''; p.stdout.on('data', (c) => (so += c)); p.stderr.on('data', (c) => (so += c)); p.on('close', () => resolve(so));
  });
  const peersOut = await cli(['peers']);
  check('cli_peers_marks_it', new RegExp(`${r.id}[^\\n]*spawn HELD for memory since \\d\\d:\\d\\d:\\d\\dZ`).test(peersOut), true);
  const bs = await cli(['bus-status']);
  check('cli_bus_status_lists_it', /held starts: 1 held for memory, release order — .*\(spawn, since \d{4}-/.test(bs), true);
  mem = 9; guard.sampleNow();
  await until(() => calls.start.length >= 1);
  await sleep(100);
  const bs2 = await cli(['bus-status']);
  const peers2 = await cli(['peers']);
  check('gone_after_release', [/held starts:/.test(bs2), /HELD for memory/.test(peers2)], [false, false]);
  verdict();
}
