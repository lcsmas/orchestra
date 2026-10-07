// #287 (wave G, ledger #295; epic #284 Testing "Seam 1") — Admission for WAKES: a réveil (and every other automatic start of a SLEEPING fleet member) under low
// memory WAITS instead of starting a process, and is released in order. Driven through the REAL modules — the bus (real SQLite) + `sweepBusWake` + the real wake
// roster, `flushQueuedPrompts` / the usage-limit resume tick, `dispatchMessageRequest`, the Admission queue, the memory guard — + the REAL store. The ONLY fakes: the
// MemAvailable number (the guard's injectable source) and the SDK delivery seam, which RECORDS every start / turn instead of launching a CLI (a "start" = a recorded
// `seam.start` on a member that had no live session; the fake marks it live afterwards, as a real start does). One arm per process; no arg = run them all.
//
// SAFETY (D4): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR under ~/.cache (btrfs), refused anywhere near a live ~/.orchestra / ~/.claude*; no real `claude`,
// no network, never the live bus; no real run is paused/held/resumed.
//
// Fleet: ws-ops (OPS) ⊃ ws-m1, ws-m2 (workers), ws-sub (a sub-OPS = coordinator, parent ws-ops, run ws-sub ⊂ ws-ops); ws-top (top-level, no coordinator).
//
//   wake_open_passes   CONTROL  12 GB: a bus message to a sleeping member starts it at once (the instrument can see a start + a fired wake)
//   wake_held          ★ must-FAIL on master  4 GB: no start; the sweep logs the held reason ONCE across 5 sweeps; failed/fired counters unchanged; the lot is still pending
//   wake_release       ★ recovery: the réveil is delivered once (the order), the member "answers" (real verbCheck/verbAck) — the lot carries the message intact, the ack clears it
//   wake_order         ★ three held réveils: coordinator first, then arrival, one at a time, a fresh reading before each
//   wake_live_passes   ★ a réveil to a RUNNING member is a plain turn: delivered while held, never queued
//   wake_human_drops   ★ a person starts the held member: it leaves the queue / peers, the next sweep delivers the order as a turn to the running member
//   wake_spawn_child   ★ a held-SPAWN child that receives a bus message: no start from the wake, the spawn's OWN start (brief) goes out first, the order after
//   flush_held         ★ the timer flush of parked prompts for a sleeping fleet member waits BEFORE the queue is cleared; delivered once on release; Send now passes
//   resume_held        ★ the usage-limit auto-resume nudge waits (marker untouched); nudged once on release
//   message_held       ★ a peer message to a stopped fleet member is parked in the inbox (honest `inbox`), the member is woken on release and the block delivered once
//   permit_one_shot    ★ after a released wake, a LATER réveil under low memory is held again (the permit is one-shot)
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-admission-wake.mjs   (RIG_REPO=<tree> = the must-FAIL run on master;
//          RIG_ARMS=a,b runs only those arms)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['wake_open_passes', 'wake_held', 'wake_release', 'wake_order', 'wake_live_passes', 'wake_human_drops', 'wake_spawn_child', 'flush_held', 'resume_held', 'message_held', 'permit_one_shot'];
const GIB = 1024 ** 3;

if (!ARM) {
  const rows = [];
  const only = process.env.RIG_ARMS ? new Set(process.env.RIG_ARMS.split(',')) : null;
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
  console.log(`ADMISSION-WAKE RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length}) tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.ADMISSION_WAKE_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-admission-wake'));
const tmpHome = path.join(base, ARM);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
const rigLogLevel = process.env.RIG_LOG_LEVEL;
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
if (rigLogLevel) process.env.ORCHESTRA_LOG_LEVEL = rigLogLevel;
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const stubBin = path.join(tmpHome, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;
process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';

const out = { arm: ARM, tree: REPO };
const fails = [];
const verdict = (extra = {}) => { console.log(JSON.stringify({ ...out, ...extra, ok: fails.length === 0, ...(fails.length ? { why: fails.join(' | ') } : {}) })); process.exit(fails.length === 0 ? 0 : 1); };
setInterval(() => {}, 1000);
setTimeout(() => { fails.push('deadline: the arm hung'); verdict(); }, 100_000).unref?.();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) { const ok = eq(got, want); out[name] = got; if (!ok) fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000, step = 20) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return false; };

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-admission-wake', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-admission-wake', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
await import(`${REPO}/src/main/agent-sdk.ts`);                      // registers the REAL delivery seam; the fake below replaces it
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const wake = await import(`${REPO}/src/main/bus-wake.ts`);
const rosterMod = await import(`${REPO}/src/main/wake-roster.ts`);
const pq = await import(`${REPO}/src/main/prompt-queue.ts`);
const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
const { isWakeOrder } = await import(`${REPO}/src/shared/bus-wake.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
busMod.initBus();
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
if (!String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }

// ── the memory source + the REAL guard on it + the REAL admission (absent on master → nothing is wired, the arms then read RED) ──
let mem = 12;
let reads = 0;
const hasWakeHold = fs.existsSync(path.join(REPO, 'src/main/admission-wake.ts'));
const guardMod = await import(`${REPO}/src/main/memory-guard.ts`);
guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
const guard = guardMod.__rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {} }, () => { reads += 1; return mem === null ? null : mem * GIB; });
guard.start();
let admMod = null;
if (fs.existsSync(path.join(REPO, 'src/main/admission.ts'))) {
  admMod = await import(`${REPO}/src/main/admission.ts`);
  admMod.__rebuildAdmissionForTests({ settleMs: 5, retryMs: 40 });
  admMod.startAdmission();
}
out.hasWakeHold = hasWakeHold;

// ── fake delivery seam: RECORDS starts and turns; a start marks the member live (as a real one does) ──
const liveSet = new Set();
const calls = { start: [], turns: [], awaiting: [] };
let inFlight = 0, maxInFlight = 0;
delivery.registerSdkDelivery({
  hasSession: (id) => liveSet.has(id), hasBackgroundTask: () => false,
  send: async (wsId, text) => { calls.turns.push({ wsId, text, how: 'send' }); },
  sendAwaitingStart: async (wsId, text) => { calls.awaiting.push({ wsId, text }); return 'started'; },
  start: async (wsId, text, opts) => {
    if (liveSet.has(wsId)) { calls.turns.push({ wsId, text, how: 'start-on-live' }); return; }   // a wake of a LIVE session is a turn, not a start
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    calls.start.push({ wsId, text, origin: opts?.origin, readsAt: reads });
    await sleep(25);
    liveSet.add(wsId);
    inFlight -= 1;
  },
  stop: async (wsId) => { liveSet.delete(wsId); },
});
const startsFor = (id) => calls.start.filter((c) => c.wsId === id);
const orderStarts = () => calls.start.filter((c) => isWakeOrder(String(c.text ?? '')));

// ── fleet ──
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: tmpHome, status: 'idle', createdAt: now0 - 40 * 60_000, hasInput: true, sdkSessionId: `sess-${id}`, ...extra });
const ON = { ...DEFAULT_BUS_SWITCHES, wake: true, liveness: true };
busRuns.startRun(db, { id: 'ws-ops', kind: 'vague', coordinator: 'ws-ops' }, ON);
await store.upsertWorkspace(mk('ws-ops', { kind: 'orchestrator' }));
busRuns.startRun(db, { id: 'ws-sub', kind: 'vague', coordinator: 'ws-sub', parentRunId: 'ws-ops' }, ON);
await store.upsertWorkspace(mk('ws-sub', { kind: 'orchestrator', parentId: 'ws-ops' }));
for (const id of ['ws-m1', 'ws-m2', 'ws-m3']) await store.upsertWorkspace(mk(id, { parentId: 'ws-ops', hibernatedAt: now0 - 60_000 }));   // asleep: in Veille, no session
await store.upsertWorkspace(mk('ws-xm'));
const wsRec = (id) => store.getWorkspace(id);

wake.__resetBusWakeForTests();
wake.__setBusReaderForTests(() => db);
wake.setWakeRoster(() => store.workspaces.map((w) => rosterMod.wakeRosterEntry(w)));
wake.setWakeDeliver((wsId, text) => delivery.sdkStartAndDeliver(wsId, text));
wake.__freezeSwitchForTests(() => true);
const send = (to, body, runId = 'ws-ops') => busMod.send(db, { runId, sender: 'ws-ops', kind: 'dispatch', body, recipient: to });
const pending = (id) => wake.readPendingReaders(db, [{ reader: id, runId: 'ws-ops' }])[0]?.pending === true;
const logText = () => { try { return fs.readFileSync(path.join(process.env.ORCHESTRA_HOME, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
const heldLines = (id) => logText().split('\n').filter((l) => l.includes(`bus-wake: ${id} is PENDING and its réveil is HELD for memory`)).length;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (ARM === 'wake_open_passes') {
  mem = 12; guard.sampleNow();
  send('ws-m1', 'OPEN-MSG');
  await wake.sweepBusWake();
  check('started_at_once_with_the_order', orderStarts().map((c) => c.wsId), ['ws-m1']);
  check('counters', [wake.busWakeCounters().fired, wake.busWakeCounters().failed], [1, 0]);
  verdict();
}

if (ARM === 'wake_held') {
  mem = 4; guard.sampleNow();
  const body = 'HELD-MSG-9f3a';
  send('ws-m1', body);
  for (let i = 0; i < 5; i++) { await wake.sweepBusWake(); await sleep(15); }
  check('no_process_started', calls.start.length, 0);                                          // ← master starts one at once
  check('counters_unchanged', [wake.busWakeCounters().fired, wake.busWakeCounters().failed, wake.busWakeCounters().withdrawn], [0, 0, 0]);
  check('held_reason_logged_once_per_transition', heldLines('ws-m1'), 1);
  check('the_lot_is_still_pending', pending('ws-m1'), true);
  check('queued_as_a_wake', admMod ? admMod.listHeldStarts().map((h) => [h.wsId, h.kind]) : [], [['ws-m1', 'wake']]);
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('peers_marks_it', [peers.peers.find((p) => p.id === 'ws-m1')?.heldForMemory?.kind ?? null], ['wake']);
  verdict();
}

if (ARM === 'wake_release' || ARM === 'permit_one_shot') {
  mem = 4; guard.sampleNow();
  const body = 'RELEASE-MSG-77c1';
  send('ws-m1', body);
  for (let i = 0; i < 3; i++) { await wake.sweepBusWake(); await sleep(15); }
  check('held_first', calls.start.length, 0);
  mem = 9; guard.sampleNow();                                                                    // recovery: the reopen edge → the queue grants the permit and re-runs the sweep
  check('delivered_once_after_release', await until(() => orderStarts().length >= 1), true);
  await sleep(150);
  check('exactly_one_start_with_the_order', orderStarts().map((c) => c.wsId), ['ws-m1']);
  check('counters_after', [wake.busWakeCounters().fired, wake.busWakeCounters().failed], [1, 0]);
  check('queue_drained', admMod ? admMod.listHeldStarts().length : -1, admMod ? 0 : -1);
  // the member ANSWERS with the real verbs: the lot carries the message intact, the ack clears the pending state
  const verbs = await import(`${REPO}/src/cli/bus-verbs.ts`);
  const receipts = await import(`${REPO}/src/main/bus-receipts.ts`);
  const { composeBusVerbSlice } = await import(`${REPO}/src/cli/bus-verb-slice.ts`);
  const id = verbs.resolveBusIdentity({}, { ORCHESTRA_RUN_ID: 'ws-ops', ORCHESTRA_WS_ID: 'ws-m1' });
  let stdout = '';
  const ctx = { db, id, bus: composeBusVerbSlice(busMod, busRuns, receipts), out: (t) => { stdout += t; }, fail: (m) => { throw new Error(m); } };
  verbs.verbCheck(ctx, { limit: 100 });
  const lot = JSON.parse(stdout);
  check('lot_carries_the_message_intact', JSON.stringify(lot).includes(body), true);
  stdout = '';
  verbs.verbAck(ctx, String(lot.lot));
  check('ack_clears_pending', pending('ws-m1'), false);
  if (ARM === 'permit_one_shot') {
    // a LATER réveil: the member is asleep again (Veille) and memory is low again → held again (the permit was one-shot)
    liveSet.delete('ws-m1');
    mem = 4; guard.sampleNow();
    send('ws-m1', 'SECOND-MSG');
    const before = orderStarts().length;
    for (let i = 0; i < 3; i++) { await wake.sweepBusWake(); await sleep(15); }
    check('second_wake_is_held_again', [orderStarts().length - before, admMod ? admMod.listHeldStarts().map((h) => h.wsId) : []], [0, ['ws-m1']]);
  }
  verdict();
}

if (ARM === 'wake_order') {
  mem = 4; guard.sampleNow();
  send('ws-m1', 'ORDER-A'); send('ws-m2', 'ORDER-B'); send('ws-sub', 'ORDER-SUB');
  for (let i = 0; i < 3; i++) { await wake.sweepBusWake(); await sleep(15); }
  check('all_held', calls.start.length, 0);
  mem = 9; guard.sampleNow();
  await until(() => orderStarts().length >= 3);
  check('coordinator_first_then_arrival', orderStarts().map((c) => c.wsId), ['ws-sub', 'ws-m1', 'ws-m2']);
  check('one_at_a_time', maxInFlight, 1);
  const rs = orderStarts().map((c) => c.readsAt);
  check('fresh_reading_before_each_release', rs.every((x, i) => i === 0 || x > rs[i - 1]), true);
  verdict();
}

if (ARM === 'wake_live_passes') {
  liveSet.add('ws-m1');                                                                           // RUNNING: a réveil is a plain turn
  mem = 4; guard.sampleNow();
  send('ws-m1', 'LIVE-MSG');
  await wake.sweepBusWake();
  check('delivered_as_a_turn_while_held', [calls.turns.filter((t) => t.wsId === 'ws-m1').length, calls.start.length], [1, 0]);
  check('never_queued', admMod ? admMod.listHeldStarts().length : 0, 0);
  check('counted_fired', wake.busWakeCounters().fired, 1);
  verdict();
}

if (ARM === 'wake_human_drops') {
  mem = 4; guard.sampleNow();
  send('ws-m1', 'HUMAN-MSG');
  await wake.sweepBusWake();
  check('control_held', admMod ? admMod.listHeldStarts().map((h) => h.wsId) : ['ws-m1'], ['ws-m1']);
  liveSet.add('ws-m1');                                                                           // a person typed into the member: a session is live now
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('peers_no_longer_says_held', peers.peers.find((p) => p.id === 'ws-m1')?.heldForMemory ?? null, null);
  check('queue_no_longer_has_it', admMod ? admMod.listHeldStarts().length : 0, 0);
  await wake.sweepBusWake();
  check('next_sweep_delivers_a_turn_to_the_running_member', [calls.turns.filter((t) => t.wsId === 'ws-m1' && isWakeOrder(String(t.text))).length, calls.start.length], [1, 0]);
  verdict();
}

if (ARM === 'wake_spawn_child') {
  // a held-SPAWN child: created at 4 GB (its brief owed, no session), then a bus message arrives for it
  const repoDir = path.join(tmpHome, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const g = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } });
  g(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); g(['add', '.']); g(['commit', '-q', '-m', 'seed']);
  await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
  mem = 4; guard.sampleNow();
  const r = await workspaces.dispatchSpawnRequest({ from: 'ws-ops', task: 'CHILD-BRIEF', repoPath: repoDir, agent: 'claude', defaultKind: 'spawned' });
  check('control_spawn_held', [!!r.held, admMod ? admMod.listHeldStarts().map((h) => h.kind) : ['spawn']], [true, ['spawn']]);
  send(r.id, 'MSG-TO-THE-CHILD');
  for (let i = 0; i < 3; i++) { await wake.sweepBusWake(); await sleep(15); }
  check('the_wake_did_not_start_it', calls.start.length, 0);
  check('still_one_entry_and_it_is_the_spawn', admMod ? admMod.listHeldStarts().map((h) => [h.wsId, h.kind]) : [[r.id, 'spawn']], [[r.id, 'spawn']]);
  mem = 9; guard.sampleNow();
  check('the_spawns_own_start_goes_out_first_with_the_brief', await until(() => startsFor(r.id).length >= 1), true);
  check('opening_text_is_the_brief_not_the_order', startsFor(r.id).map((c) => c.text), ['CHILD-BRIEF']);
  // The spawn's start is IN FLIGHT until the member is live: a sweep in that window is answered "held" (the start covers it — never a 2nd start). The order
  // then goes out on the next sweep (timer / bus write) as a plain turn to the running child.
  check('spawn_settled_child_is_live', await until(() => liveSet.has(r.id)), true);
  await sleep(30);
  await wake.sweepBusWake();
  await sleep(50);
  check('then_the_order_reaches_the_running_child_as_a_turn', [calls.turns.filter((t) => t.wsId === r.id && isWakeOrder(String(t.text))).length, startsFor(r.id).length], [1, 1]);
  verdict();
}

if (ARM === 'flush_held') {
  const q = (id) => ({ id: `q-${id}`, text: `PARKED-${id}`, queuedAt: Date.now() - 60_000 });
  await store.upsertWorkspace({ ...wsRec('ws-m2'), queuedPrompts: [q('m2')] });
  mem = 4; guard.sampleNow();
  const r = await pq.flushQueuedPrompts('ws-m2');
  check('flush_reports_held_not_started', [r.ok, r.delivered, /held for memory/.test(r.error ?? '')], [false, 0, true]);
  check('queue_untouched_and_durable', (wsRec('ws-m2').queuedPrompts ?? []).map((p) => p.text), ['PARKED-m2']);
  check('no_process_started', calls.start.length, 0);
  // "Send now" (force) is a human click: it passes while held
  const forced = await pq.flushQueuedPrompts('ws-m2', { force: true });
  check('send_now_passes', [forced.ok, forced.delivered, startsFor('ws-m2').length], [true, 1, 1]);
  // reset, hold again, release → delivered ONCE
  liveSet.delete('ws-m2');
  await store.upsertWorkspace({ ...wsRec('ws-m2'), queuedPrompts: [q('m2b')] });
  mem = 4; guard.sampleNow();
  const again = await pq.flushQueuedPrompts('ws-m2');
  check('held_again', again.ok, false);
  mem = 9; guard.sampleNow();
  check('delivered_on_release', await until(() => startsFor('ws-m2').length >= 2), true);
  await sleep(150);
  check('once_and_cleared', [startsFor('ws-m2').filter((c) => /PARKED-m2b/.test(String(c.text))).length, (wsRec('ws-m2').queuedPrompts ?? []).length], [1, 0]);
  verdict();
}

if (ARM === 'resume_held') {
  const T0 = Date.now() - 10_000;
  await store.upsertWorkspace({ ...wsRec('ws-sub'), lastStopReason: 'usage_limit', lastStopReasonAt: T0, usageLimitResetsAt: Date.now() - 5_000 });   // a coordinator, due for its nudge
  mem = 4; guard.sampleNow();
  await pq.__tickForTests();
  check('no_process_started', calls.start.length, 0);
  check('marker_untouched', [wsRec('ws-sub').lastStopReason, wsRec('ws-sub').lastStopReasonAt === T0], ['usage_limit', true]);
  check('queued_as_a_wake', admMod ? admMod.listHeldStarts().map((h) => [h.wsId, h.kind]) : [], [['ws-sub', 'wake']]);
  mem = 9; guard.sampleNow();
  check('nudged_on_release', await until(() => startsFor('ws-sub').length >= 1), true);
  await sleep(150);
  check('once_and_marker_cleared', [startsFor('ws-sub').length, wsRec('ws-sub').lastStopReason ?? null], [1, null]);
  verdict();
}

if (ARM === 'message_held') {
  mem = 4; guard.sampleNow();
  const body = 'PEER-MSG-4d2e';
  const r = await workspaces.dispatchMessageRequest({ from: 'ws-xm', to: 'ws-m1', text: body, emergency: true });
  check('reported_honestly_as_inbox', [r.ok, r.delivery], [true, 'inbox']);
  check('parked_durably', tray.readInbox('ws-m1').some((b) => b.text.includes(body)), true);
  await sleep(100);
  check('no_process_started', calls.start.length, 0);                                            // ← master starts the member at once (delivery 'started')
  mem = 9; guard.sampleNow();
  check('woken_on_release', await until(() => startsFor('ws-m1').length >= 1), true);
  await sleep(700);                                                                               // the drain grace + the confirmed re-release
  check('bring_up_prompt_not_the_message', /memory is back/.test(String(startsFor('ws-m1')[0]?.text ?? '')), true);
  check('delivered_once_and_block_left_the_inbox', [calls.awaiting.filter((c) => c.text.includes(body)).length, tray.readInbox('ws-m1').length], [1, 0]);
  verdict();
}
