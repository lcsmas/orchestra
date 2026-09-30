// #252 (wave D, ledger #261) — every GATE / SILENCE row of the fleet-Pause entry-point table, driven through the REAL
// modules (workspaces.ts, restart-workspace.ts, prompt-queue.ts, agent-sdk.ts, session-watchdog.ts, bus-wake.ts,
// wake-roster.ts) + the REAL store + a REAL bus.sqlite, one arm per process. Nothing here copies a predicate.
//
// SAFETY (D8): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR under ~/.cache (btrfs), refused anywhere near a live
// ~/.orchestra / ~/.claude*; every `claude` is a stub on a stripped PATH and the SDK query is a fake — no real CLI, no
// network, no live bus. No arm calls `orchestra run pause|hold|resume` — it writes a scratch DB through bus-pause.ts.
//
// Fleet under test (seedFleet): run `ws-ops` (OPS, pause switch ON) ⊃ members m1 m2; run `ws-sub` (orchestrator under
// the OPS, parent_run_id = ws-ops) ⊃ m3; an UNRELATED run `ws-xops` ⊃ xm. The pause is on `ws-ops`.
//
// Every arm: ok:true = the shipped behaviour. Each gate arm carries its own CONTROLS in the same process (the lift,
// the unrelated run, the HUMAN origin) so a dead instrument reads red, never green.
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-pause-gates.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? '';
const ARMS = [
  'spawn', 'message', 'wake', 'restart', 'flush', 'usage_resume', 'migrate',
  'send_funnel', 'drain', 'recover', 'redrive',
  'roster', 'watchdog_boot', 'watchdog_escalate', 'watchdog_gate',
  'off_identity',
];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY: refuse any scratch path that is not under ~/.cache of the REAL home, or that touches a live Claude/Orchestra dir.
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.PAUSE_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-pause-gates'));
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
const ranLog = path.join(tmpHome, 'claude-ran.log');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ranLog)}\nsleep 30\n`, { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const userMessages = [];   // agent:event user-message broadcasts = the turns a human would SEE
const errorEvents = [];    // agent:event error broadcasts
initPlatform({
  kind: 'headless-e2e-pause-gates',
  broadcast: (channel, wsId, event) => {
    if (channel === 'agent:event' && event?.type === 'user-message') userMessages.push({ wsId, text: String(event.text ?? '') });
    if (channel === 'agent:event' && event?.type === 'error') errorEvents.push({ wsId, message: String(event.message ?? '') });
  },
  broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-pause-gates', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);        // registers the REAL delivery seam (arms may override it)
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);

busMod.initBus();
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
if (!String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilOrFail = async (pred, ms = 4000, step = 25) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return false; };
const PAUSED_MSG = 'run en pause — orchestra run resume --run ws-ops';
const ON = { ...DEFAULT_BUS_SWITCHES, pause: true, wake: true, liveness: true };
const OFFSW = { ...DEFAULT_BUS_SWITCHES, wake: true };

// ── fake SDK query (no real CLI ever): counts spawns, records every turn the prompt stream yields, result on demand ──
let factoryCalls = 0;
const yielded = [];                    // text of every turn the SDK prompt stream received (= a turn START)
let emitResult = () => {};             // push one `result` into the newest fake session
sdk.__setQueryFactoryForTests(({ prompt }) => {
  factoryCalls++;
  let push = () => {};
  const pending = [];
  let wake = null;
  emitResult = () => { pending.push({ type: 'result', subtype: 'success', session_id: 'pg', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'done' }); wake?.(); };
  void (async () => {
    try { for await (const m of prompt) yielded.push(JSON.stringify(m?.message?.content ?? '')); } catch { /* torn down */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'pg', tools: [], slash_commands: [] };
      for (;;) {
        while (pending.length) yield pending.shift();
        await new Promise((r) => { wake = r; });
      }
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

// ── fleet ───────────────────────────────────────────────────────────────────
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: tmpHome, status: 'idle', createdAt: now0 - 40 * 60_000, ...extra });
async function seedFleet({ pauseSwitch = true } = {}) {
  const sw = pauseSwitch ? ON : OFFSW;
  busRuns.startRun(db, { id: 'ws-ops', kind: 'vague', coordinator: 'ws-ops' }, sw);
  busRuns.startRun(db, { id: 'ws-sub', kind: 'vague', coordinator: 'ws-sub', parentRunId: 'ws-ops' }, sw);
  busRuns.startRun(db, { id: 'ws-xops', kind: 'vague', coordinator: 'ws-xops' }, ON);
  await store.upsertWorkspace(mk('ws-ops', { kind: 'orchestrator' }));
  await store.upsertWorkspace(mk('ws-m1', { parentId: 'ws-ops' }));
  await store.upsertWorkspace(mk('ws-m2', { parentId: 'ws-ops' }));
  await store.upsertWorkspace(mk('ws-sub', { kind: 'orchestrator', parentId: 'ws-ops' }));
  await store.upsertWorkspace(mk('ws-m3', { parentId: 'ws-sub' }));
  await store.upsertWorkspace(mk('ws-xops', { kind: 'orchestrator' }));
  await store.upsertWorkspace(mk('ws-xm', { parentId: 'ws-xops' }));
}
const pause = () => busPause.setRunPause(db, 'ws-ops', true, 'ws-ops');
const lift = () => busPause.setRunPause(db, 'ws-ops', false, 'ws-ops');
const pauseOn = () => busPause.activePauseFor(db, 'ws-ops') !== null;
const ws = (id) => store.getWorkspace(id);

// ── fake delivery seam for the workspaces.ts-level arms (records; the REAL seam is used by the agent-sdk arms) ──
const calls = { start: [], send: [], awaiting: [], stop: [] };
function useFakeSeam({ hasSession = () => false } = {}) {
  delivery.registerSdkDelivery({
    hasSession, hasBackgroundTask: () => false,
    send: async (wsId, text, peer, origin) => { calls.send.push({ wsId, text, origin }); },
    sendAwaitingStart: async (wsId, text, peer, ms, origin) => { calls.awaiting.push({ wsId, text, origin }); return 'started'; },
    start: async (wsId, text, opts) => { calls.start.push({ wsId, text, origin: opts?.origin, openingBrief: opts?.openingBrief === true }); },
    stop: async (wsId) => { calls.stop.push(wsId); },
  });
}
const noStarts = () => calls.start.length === 0 && calls.send.length === 0 && calls.awaiting.length === 0;

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } });
const worktreeCount = () => { const d = path.join(tmpHome, '.orchestra', 'worktrees'); return fs.existsSync(d) ? fs.readdirSync(d).length : 0; };

const out = { arm: ARM };
let ok = false;
const rec = (k, v) => { out[k] = v; return v; };

// ═════════════════════════════════════════════════════════════════════════════
if (ARM === 'spawn') {
  // rows 20/21 — `orchestra spawn` from inside a paused run (or under a paused ancestor run) is refused BEFORE the worktree exists.
  useFakeSeam();
  await seedFleet();
  const repoDir = path.join(tmpHome, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n');
  git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
  await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
  const spawn = (from) => workspaces.dispatchSpawnRequest({ from, task: 'brief', repoPath: repoDir, agent: 'claude', defaultKind: 'spawned', detached: true });
  rec('pauseResult', pause());
  const wsBefore = store.workspaces.length, wtBefore = worktreeCount();
  const r1 = rec('memberRes', await spawn('ws-m1'));
  const r3 = rec('descendantRes', await spawn('ws-m3'));
  const r0 = rec('opsRes', await spawn('ws-ops'));
  rec('countsUnchanged', store.workspaces.length === wsBefore && worktreeCount() === wtBefore);
  rec('startsWhilePaused', calls.start.length);
  // controls: a human click (no `from`) and an unrelated run are NOT gated; the pause is still on after them (un-pauses nothing)
  const human = rec('humanClickRes', await spawn(undefined));
  const other = rec('otherRunRes', await spawn('ws-xm'));
  rec('stillPaused', pauseOn());
  // lift → the same spawn works (positive control: the instrument can see a spawn)
  lift();
  const lifted = rec('afterLiftRes', await spawn('ws-m1'));
  ok = [r1, r3, r0].every((r) => r.ok === false && r.error === PAUSED_MSG) && out.countsUnchanged && out.startsWhilePaused === 0
    && human.ok === true && other.ok === true && out.stillPaused === true && lifted.ok === true && calls.start.length === 3;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'message') {
  // row 18 (+ broadcast / --emergency) — a message to a paused member is PARKED in the inbox, never delivered live, never wakes it.
  useFakeSeam();
  await seedFleet();
  const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
  pause();
  const send = (to, text, from = 'ws-xm') => workspaces.dispatchMessageRequest({ from, to, text, emergency: true });
  const a = rec('toMember', await send('ws-m1', 'MSG-ALPHA'));
  const b = rec('toDescendant', await send('ws-m3', 'MSG-BRAVO'));
  rec('inboxM1', tray.readInbox('ws-m1').map((x) => x.text).join('|').includes('MSG-ALPHA'));
  rec('inboxM3', tray.readInbox('ws-m3').map((x) => x.text).join('|').includes('MSG-BRAVO'));
  rec('deliveredWhilePaused', calls.start.length + calls.awaiting.length + calls.send.length);
  const bc = rec('broadcast', await workspaces.dispatchBroadcastMessageRequest({ from: 'ws-ops', to: ['ws-m2'], text: 'MSG-BC', emergency: true }).catch((e) => ({ error: String(e) })));
  // control: an unrelated run's member IS delivered (start seam called), and lifting restores delivery to the paused one
  const c = rec('toOtherRun', await send('ws-xm', 'MSG-CHARLIE', 'ws-m1'));
  lift();
  const d = rec('afterLift', await send('ws-m1', 'MSG-DELTA'));
  ok = a.ok === true && a.delivery === 'inbox' && b.ok === true && b.delivery === 'inbox' && out.inboxM1 && out.inboxM3
    && out.deliveredWhilePaused === 0 && bc.results?.[0]?.delivery === 'inbox' && c.ok === true && c.delivery === 'started' && d.ok === true && d.delivery === 'started'
    && calls.start.length === 2;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'wake') {
  // WAWP (rows 13/16/17/18 share it): AUTO refused, HUMAN ("Send now" / Fix checks) allowed and its origin reaches the seam.
  useFakeSeam();
  await seedFleet();
  pause();
  const a = rec('autoPaused', await workspaces.wakeAgentWithPrompt('ws-m1', 'AUTO-WAKE'));
  rec('startsAfterAuto', calls.start.length);
  const h = rec('humanPaused', await workspaces.wakeAgentWithPrompt('ws-m1', 'HUMAN-WAKE', { origin: 'human' }));
  rec('humanStart', calls.start.map((c) => ({ text: c.text, origin: c.origin })));
  rec('stillPaused', pauseOn());
  const x = rec('otherRun', await workspaces.wakeAgentWithPrompt('ws-xm', 'OTHER-WAKE'));
  lift();
  const l = rec('afterLift', await workspaces.wakeAgentWithPrompt('ws-m1', 'LIFTED-WAKE'));
  ok = a === false && out.startsAfterAuto === 0 && h === true && out.humanStart.length === 1 && out.humanStart[0].text === 'HUMAN-WAKE'
    && out.humanStart[0].origin === 'human' && out.stillPaused === true && x === true && l === true && calls.start.length === 3;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'restart') {
  // rows 5/6/7 — `orchestra restart` and the re-parent restart are refused BEFORE any stop; the toolbar Restart (HUMAN) is not.
  useFakeSeam({ hasSession: (id) => id === 'ws-m1' });
  await seedFleet();
  await store.upsertWorkspace({ ...ws('ws-m1'), sdkSessionId: 'sess-m1', hasInput: true });
  const { dispatchRestartRequest } = await import(`${REPO}/src/main/restart-workspace.ts`);
  pause();
  const spawnsBefore = factoryCalls;
  const cli = rec('cli', await dispatchRestartRequest({ id: 'ws-m1', fresh: false, trigger: 'cli' }));
  const rep = rec('reparent', await dispatchRestartRequest({ id: 'ws-m1', fresh: true, trigger: 'reparent' }));
  rec('spawnedByRefused', factoryCalls - spawnsBefore);
  rec('stopsByRefused', calls.stop.length);
  rec('stillPaused', pauseOn());
  // HUMAN: the toolbar Restart proceeds (it reaches sdkRestart → a fresh fake session)
  const tb = rec('toolbar', await dispatchRestartRequest({ id: 'ws-m1', fresh: false, trigger: 'toolbar' }));
  rec('spawnedByToolbar', factoryCalls - spawnsBefore);
  // control: an unrelated run's CLI restart is not refused
  await store.upsertWorkspace({ ...ws('ws-xm'), sdkSessionId: 'sess-xm', hasInput: true });
  const x = rec('otherRun', await dispatchRestartRequest({ id: 'ws-xm', fresh: false, trigger: 'cli' }));
  ok = cli.ok === false && cli.error === PAUSED_MSG && rep.ok === false && rep.error === PAUSED_MSG
    && out.spawnedByRefused === 0 && out.stopsByRefused === 0 && out.stillPaused === true
    && tb.ok === true && out.spawnedByToolbar >= 1 && x.ok === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'flush') {
  // row 17 — the TIMER flush of parked prompts is refused BEFORE the queue is cleared; "Send now" (force = HUMAN) is allowed.
  useFakeSeam();
  await seedFleet();
  const pq = await import(`${REPO}/src/main/prompt-queue.ts`);
  const q = (id) => ({ id: `q-${id}`, text: `PARKED-${id}`, queuedAt: Date.now() - 60_000 });
  await store.upsertWorkspace({ ...ws('ws-m1'), queuedPrompts: [q('m1')] });
  await store.upsertWorkspace({ ...ws('ws-xm'), queuedPrompts: [q('xm')] });
  pause();
  const auto = rec('autoFlush', await pq.flushQueuedPrompts('ws-m1'));
  rec('queueRetained', (ws('ws-m1').queuedPrompts ?? []).length === 1);
  rec('startsAfterAuto', calls.start.length);
  // control: the SAME auto flush on an unrelated run's member delivers (the instrument can see a flush); the timer tick reaches flush too
  const xm = rec('autoFlushOtherRun', await pq.flushQueuedPrompts('ws-xm'));
  await pq.__tickForTests();
  const tick = rec('afterTick', { xmQueue: (ws('ws-xm').queuedPrompts ?? []).length, m1Queue: (ws('ws-m1').queuedPrompts ?? []).length });
  const force = rec('sendNow', await pq.flushQueuedPrompts('ws-m1', { force: true }));
  rec('sendNowStart', calls.start.filter((c) => c.wsId === 'ws-m1').map((c) => c.origin));
  rec('stillPaused', pauseOn());
  ok = auto.ok === false && auto.delivered === 0 && auto.error === PAUSED_MSG && out.queueRetained && out.startsAfterAuto === 0
    && xm.ok === true && xm.delivered === 1 && tick.xmQueue === 0 && tick.m1Queue === 1
    && force.ok === true && force.delivered === 1 && out.sendNowStart.length === 1 && out.sendNowStart[0] === 'human' && out.stillPaused === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'usage_resume') {
  // row 16 — a usage-limit-killed member of a paused run is NOT auto-resumed, and its stop marker is left in place (no retry-every-tick).
  useFakeSeam();
  await seedFleet();
  const pq = await import(`${REPO}/src/main/prompt-queue.ts`);
  const limited = (extra = {}) => ({ lastStopReason: 'usage_limit', lastStopReasonAt: Date.now() - 10_000, usageLimitResetsAt: Date.now() - 5_000, ...extra });
  await store.upsertWorkspace({ ...ws('ws-ops'), ...limited() });          // coordinator of the paused run
  await store.upsertWorkspace({ ...ws('ws-xops'), ...limited() });         // coordinator of an UNRELATED run (control)
  pause();
  await pq.__tickForTests();
  rec('opsMarker', ws('ws-ops').lastStopReason);
  rec('startsByWs', calls.start.map((c) => c.wsId));
  rec('xopsMarkerCleared', ws('ws-xops').lastStopReason === undefined);
  lift();
  await pq.__tickForTests();
  rec('opsMarkerAfterLift', ws('ws-ops').lastStopReason ?? null);
  rec('startsAfterLift', calls.start.map((c) => c.wsId));
  ok = out.opsMarker === 'usage_limit' && !out.startsByWs.includes('ws-ops') && out.startsByWs.includes('ws-xops') && out.xopsMarkerCleared
    && out.opsMarkerAfterLift === null && out.startsAfterLift.includes('ws-ops');


// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'send_funnel') {
  // rows 1/2 + the COMMIT-POINT gate: every AUTO start reaching sdkSend is refused with NO side effect (no session, no turn, no red
  // error row, no pending prompt); the HUMAN composer send is allowed and un-pauses nothing. REAL agent-sdk + fake query.
  await seedFleet();
  pause();
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
  const a1 = rec('autoSend', await refusal(() => sdk.sdkSend('ws-m1', 'AUTO-TEXT')));
  const a2 = rec('autoWake', await refusal(() => sdk.sdkWake('ws-m1', 'AUTO-WAKE')));
  const a3 = rec('peerDelivery', await sdk.sdkSendAwaitingStart('ws-m1', 'PEER-TEXT', undefined, 400));
  rec('noSideEffects', { factoryCalls, sessionLive: sdk.sdkHasSession('ws-m1'), turns: userMessages.length, errorRows: errorEvents.length, pending: (ws('ws-m1').sdkPendingPrompts ?? []).length });
  // HUMAN: the composer send goes through and starts the session + a turn; the pause is untouched
  const h = rec('humanSend', await sdk.sdkSend('ws-m1', 'HUMAN-TEXT', undefined, undefined, undefined, false, false, 'human').then((id) => typeof id === 'string', (e) => String(e)));
  await untilOrFail(() => userMessages.some((m) => m.text.includes('HUMAN-TEXT')));
  rec('humanTurns', userMessages.filter((m) => m.text.includes('HUMAN-TEXT')).length);
  rec('stillPaused', pauseOn());
  // a LIVE session does not exempt an AUTO send (the gate is at the commit point, not the session start)
  const a4 = rec('autoSendLive', await refusal(() => sdk.sdkSend('ws-m1', 'AUTO-LIVE')));
  // controls: an unrelated run is not gated; lifting restores AUTO sends on the paused one
  const x = rec('otherRun', await refusal(() => sdk.sdkSend('ws-xm', 'OTHER-TEXT')));
  lift();
  const l = rec('afterLift', await refusal(() => sdk.sdkSend('ws-m1', 'LIFTED-TEXT')));
  ok = a1 === PAUSED_MSG && a2 === PAUSED_MSG && a3 === 'dropped' && out.noSideEffects.factoryCalls === 0 && out.noSideEffects.sessionLive === false
    && out.noSideEffects.turns === 0 && out.noSideEffects.errorRows === 0 && out.noSideEffects.pending === 0
    && h === true && out.humanTurns === 1 && out.stillPaused === true && a4 === PAUSED_MSG && x === null && l === null;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'drain') {
  // row 24 — a turn queued BEFORE the pause must not drain; a HUMAN-typed turn goes first; the lift drains the rest.
  await seedFleet();
  await sdk.sdkSend('ws-m1', 'KICKOFF');                       // turn 1 starts (no result yet) on a live session
  await untilOrFail(() => yielded.some((y) => y.includes('KICKOFF')));
  await sdk.sdkSend('ws-m1', 'QUEUED-AUTO');                   // parked behind turn 1, BEFORE the pause
  rec('queuedBeforePause', sdk.sdkGateProbe('ws-m1')?.queuedCount);
  pause();
  emitResult();                                                // turn 1 ends → promptStream wants to drain QUEUED-AUTO
  await sleep(700);
  rec('autoDrainedWhilePaused', yielded.some((y) => y.includes('QUEUED-AUTO')));
  rec('queueHeld', sdk.sdkGateProbe('ws-m1')?.queuedCount);
  // the HUMAN prompt jumps the held AUTO turn (allowed, un-pauses nothing)
  await sdk.sdkSend('ws-m1', 'HUMAN-LATE', undefined, undefined, undefined, false, false, 'human');
  const humanRan = rec('humanYielded', await untilOrFail(() => yielded.some((y) => y.includes('HUMAN-LATE')), 3000));
  rec('autoStillHeldAfterHuman', !yielded.some((y) => y.includes('QUEUED-AUTO')));
  rec('stillPaused', pauseOn());
  emitResult();                                                // the human turn ends; the AUTO one must STILL wait
  await sleep(700);
  rec('autoHeldAfterHumanTurn', !yielded.some((y) => y.includes('QUEUED-AUTO')));
  // control: lifting drains it (within the poll interval) — the instrument can see a drain
  lift();
  const drained = rec('drainedAfterLift', await untilOrFail(() => yielded.some((y) => y.includes('QUEUED-AUTO')), 6000));
  ok = out.queuedBeforePause === 1 && out.autoDrainedWhilePaused === false && out.queueHeld === 1 && humanRan
    && out.autoStillHeldAfterHuman && out.stillPaused === true && out.autoHeldAfterHumanTurn && drained;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'recover') {
  // row 4 — pending-prompt recovery is HELD (the entries stay durable) while paused; the lift recovers them.
  await seedFleet();
  const { pendingPromptKey } = await import(`${REPO}/src/shared/pending-prompts.ts`);
  await store.upsertWorkspace({ ...ws('ws-m1'), sdkPendingPrompts: [{ id: 'p1', key: pendingPromptKey({ text: 'PENDING-ONE' }), text: 'PENDING-ONE' }] });
  pause();
  await sdk.recoverPendingPrompts('ws-m1', []);
  rec('pendingAfterPausedRecover', (ws('ws-m1').sdkPendingPrompts ?? []).length);
  rec('spawns', factoryCalls);
  rec('turns', userMessages.length);
  lift();
  await sdk.recoverPendingPrompts('ws-m1', []);
  const re = rec('recoveredAfterLift', await untilOrFail(() => userMessages.some((m) => m.text.includes('PENDING-ONE'))));
  ok = out.pendingAfterPausedRecover === 1 && out.spawns === 0 && out.turns === 0 && re && factoryCalls === 1;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'redrive') {
  // row 23 — parked inbox mail is NOT re-driven at a turn boundary while paused (it stays parked); the lift re-drives it.
  await seedFleet();
  const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
  const inboxPath = tray.inboxFilePath('ws-m1');
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.writeFileSync(inboxPath, `${'='.repeat(60)}\nREDRIVE-BLOCK\n`, 'utf8');
  if (tray.readInbox('ws-m1').length !== 1) { console.log(JSON.stringify({ arm: ARM, ok: false, abort: 'seed: inbox block not parsed' })); process.exit(3); }
  await sdk.sdkSend('ws-m1', 'KICKOFF');
  await untilOrFail(() => yielded.some((y) => y.includes('KICKOFF')));
  pause();
  emitResult();                                                // the turn boundary
  await sleep(700);
  rec('parkedWhilePaused', tray.readInbox('ws-m1').length);
  rec('blockTurnsWhilePaused', userMessages.filter((m) => m.text.includes('REDRIVE-BLOCK')).length);
  lift();
  emitResult();                                                // control: the next boundary re-drives it (proves the instrument sees a re-drive)
  const re = rec('redrivenAfterLift', await untilOrFail(() => userMessages.filter((m) => m.text.includes('REDRIVE-BLOCK')).length === 1, 4000));
  rec('parkedAfterLift', tray.readInbox('ws-m1').length);
  ok = out.parkedWhilePaused === 1 && out.blockTurnsWhilePaused === 0 && re && out.parkedAfterLift === 0;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'roster') {
  // row 14 — the REAL wake sweep over the REAL roster entry: a paused run's reader is NOT delivered to (and descendants' neither).
  await seedFleet();
  const wakeMod = await import(`${REPO}/src/main/bus-wake.ts`);
  const { wakeRosterEntry } = await import(`${REPO}/src/main/wake-roster.ts`);
  const delivered = [];
  wakeMod.__resetBusWakeForTests();
  wakeMod.__setBusReaderForTests(() => db);
  wakeMod.setWakeRoster(() => store.workspaces.map(wakeRosterEntry));
  wakeMod.setWakeSwitchReader((runId) => busRuns.busSwitch(db, runId, 'wake'));
  wakeMod.setWakeDeliver(async (wsId) => { delivered.push(wsId); return true; });
  wakeMod.__armStartedForTests();                                   // arm the sweep WITHOUT overwriting the real switch reader wired above
  const mail = (runId, to) => busMod.send(db, { runId, sender: 'lead', kind: 'dispatch', body: `MAIL-${to}`, recipient: to });
  mail('ws-ops', 'ws-m1'); mail('ws-sub', 'ws-m3'); mail('ws-xops', 'ws-xm');
  pause();
  await wakeMod.sweepBusWake();
  rec('deliveredWhilePaused', [...delivered].sort());
  rec('rosterWakeable', Object.fromEntries(['ws-m1', 'ws-m3', 'ws-xm'].map((id) => [id, wakeRosterEntry(ws(id)).wakeable])));
  lift();
  await wakeMod.sweepBusWake();
  rec('deliveredAfterLift', [...delivered].sort());
  ok = JSON.stringify(out.deliveredWhilePaused) === JSON.stringify(['ws-xm']) && out.rosterWakeable['ws-m1'] === false && out.rosterWakeable['ws-m3'] === false
    && out.rosterWakeable['ws-xm'] === true && JSON.stringify(out.deliveredAfterLift) === JSON.stringify(['ws-m1', 'ws-m3', 'ws-xm']);

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'watchdog_boot' || ARM === 'watchdog_escalate') {
  // rows 26/27 — the REAL watchdogTick over a REAL boot-wedged session. A paused member is never recycled (no stop-then-refuse) and
  // never escalated (SILENCE); the lift lets the same ticks act (controls). watchdog_escalate pauses AFTER the bound is reached.
  await seedFleet();
  const watchdog = await import(`${REPO}/src/main/session-watchdog.ts`);
  const wedge = await import(`${REPO}/src/shared/session-wedge.ts`);
  const BOUND = wedge.MAX_BOOT_RESTARTS;
  watchdog.__resetSessionWatchdogForTests(Date.now() - 30 * 60_000);
  watchdog.setBootWedgeRunResolver(workspaces.resolveWaveRunId);       // the production wiring (index.ts)
  await store.upsertWorkspace({ ...ws('ws-m1'), lastTask: 'do the thing' });
  let spawns = 0;
  sdk.__setQueryFactoryForTests(({ prompt }) => {                         // a CLI wedged in init: accepts the turn, emits NOTHING
    spawns++;
    void (async () => { try { for await (const _ of prompt) { /* swallow */ } } catch { /* torn down */ } })();
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [] };
  });
  await sdk.sdkSend('ws-m1', 'OPENING PROMPT');
  await sleep(100);
  const p0 = sdk.sdkGateProbe('ws-m1');
  if (!p0 || p0.firstMessageSeen || !p0.gateHeld || p0.pendingPromptCount < 1) { console.log(JSON.stringify({ arm: ARM, ok: false, abort: 'subject is not a boot wedge', p0 })); process.exit(3); }
  const escalations = () => db.prepare(`SELECT COUNT(*) n FROM messages WHERE run_id='ws-ops' AND kind='escalation' AND sender='ws-m1'`).get().n;
  let t = Date.now();
  const tick = async (k = 1) => { for (let i = 0; i < k; i++) { t += Math.max(wedge.BOOT_SILENCE_MS + 60_000, 6 * 60_000); await watchdog.watchdogTick(t); await sleep(40); } };
  if (ARM === 'watchdog_boot') {
    pause();
    await tick(BOUND + 3);
    rec('restartsWhilePaused', spawns - 1);
    rec('escalationsWhilePaused', escalations());
    rec('wedgedMarkWhilePaused', ws('ws-m1').bootWedgedSince ?? null);
    rec('sessionStillLive', sdk.sdkHasSession('ws-m1'));
    lift();
    await tick(2);
    rec('restartsAfterLift', spawns - 1);
    ok = out.restartsWhilePaused === 0 && out.escalationsWhilePaused === 0 && out.wedgedMarkWhilePaused === null && out.sessionStillLive === true && out.restartsAfterLift >= 1;
  } else {
    await tick(BOUND);                                            // BOUND fresh restarts, NOT yet escalated (the escalation is the next tick)
    rec('restartsBeforePause', spawns - 1);
    rec('escalationsBeforePause', escalations());
    pause();
    await tick(3);
    rec('escalationsWhilePaused', escalations());
    rec('wedgedMarkWhilePaused', ws('ws-m1').bootWedgedSince ?? null);
    lift();
    await tick(2);
    rec('escalationsAfterLift', escalations());
    ok = out.restartsBeforePause === BOUND && out.escalationsBeforePause === 0 && out.escalationsWhilePaused === 0 && out.wedgedMarkWhilePaused === null && out.escalationsAfterLift === 1;
  }

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'watchdog_gate') {
  // row 25 — layer-1 stranded-gate release (which lets the queue drain = a turn start) is skipped for a paused member; the lift releases it.
  await seedFleet();
  const watchdog = await import(`${REPO}/src/main/session-watchdog.ts`);
  watchdog.__resetSessionWatchdogForTests(Date.now() - 30 * 60_000);
  watchdog.setBootWedgeRunResolver(workspaces.resolveWaveRunId);
  await sdk.sdkSend('ws-m1', 'TURN-ONE');                          // turn 1 occupies the gate and never gets a result
  await untilOrFail(() => yielded.some((y) => y.includes('TURN-ONE')));
  await sdk.sdkSend('ws-m1', 'QUEUED-BEHIND');                    // a parked turn (makes the release eligible)
  sdk.__backdateStreamForTests('ws-m1', 11 * 60_000);             // 11 min of silence
  const p0 = sdk.sdkGateProbe('ws-m1');
  if (!p0 || !p0.gateHeld || p0.queuedCount !== 1) { console.log(JSON.stringify({ arm: ARM, ok: false, abort: 'subject is not a stranded gate', p0 })); process.exit(3); }
  const turn0 = p0.turnUuid;
  pause();
  let t = Date.now();
  for (let i = 0; i < 3; i++) { t += 60_000; await watchdog.watchdogTick(t); }
  await sleep(150);
  rec('gateHeldWhilePaused', sdk.sdkGateProbe('ws-m1')?.gateHeld);
  rec('sameTurnWhilePaused', sdk.sdkGateProbe('ws-m1')?.turnUuid === turn0);
  rec('queuedStarted', yielded.some((y) => y.includes('QUEUED-BEHIND')));
  lift();
  for (let i = 0; i < 3; i++) { t += 60_000; await watchdog.watchdogTick(t); }
  // control: the release DID happen on the lift — the parked turn starts (the new turn re-arms the gate, so `gateHeld` alone cannot say)
  rec('queuedStartedAfterLift', await untilOrFail(() => yielded.some((y) => y.includes('QUEUED-BEHIND')), 3000));
  ok = out.gateHeldWhilePaused === true && out.sameTurnWhilePaused === true && out.queuedStarted === false && out.queuedStartedAfterLift === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'migrate') {
  // row 13 — account-migrate's auto-RESUME of a running terminal agent is skipped while paused (the stop/move/re-pin still happen).
  useFakeSeam();
  await seedFleet();
  const pty = await import(`${REPO}/src/main/pty.ts`);
  const acct = path.join(tmpHome, 'acct-b');
  fs.mkdirSync(acct, { recursive: true });
  await store.setAccounts([{ id: 'acct-b', label: 'B', configDir: acct }]);
  const launches = () => (fs.existsSync(ranLog) ? fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).length : 0);
  for (const id of ['ws-m1', 'ws-xm']) await workspaces.startAgentPty(ws(id), 80, 24);
  const running0 = { m1: pty.isRunning('ws-m1'), xm: pty.isRunning('ws-xm') };
  await sleep(400);
  const l0 = launches();
  pause();
  const a = rec('pausedMember', await workspaces.dispatchMigrateAccountRequest({ id: 'ws-m1', accountId: 'acct-b' }));
  const b = rec('otherRun', await workspaces.dispatchMigrateAccountRequest({ id: 'ws-xm', accountId: 'acct-b' }));
  await sleep(500);
  rec('launchesAdded', launches() - l0);
  rec('running', { m1: pty.isRunning('ws-m1'), xm: pty.isRunning('ws-xm') });
  rec('repinned', ws('ws-m1').accountId);
  for (const id of ['ws-m1', 'ws-xm']) { try { pty.stopPty(id); } catch { /* */ } }
  ok = running0.m1 && running0.xm && a.ok === true && a.resumed === false && b.ok === true && b.resumed === true
    && out.launchesAdded === 1 && out.running.m1 === false && out.running.xm === true && out.repinned === 'acct-b';

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'off_identity') {
  // switch OFF ⇒ byte-identical to today: a run whose FROZEN pause switch is OFF is never gated, even if a pause column is forced on it
  // (setRunPause refuses: 'switch-off'), for every gate the other arms exercise.
  useFakeSeam();
  await seedFleet({ pauseSwitch: false });
  const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
  const refused = rec('pauseResult', pause());
  db.prepare("UPDATE runs SET paused_at = 1, paused_by = 'ws-ops', pause_mode = 'hard' WHERE id = 'ws-ops'").run();   // a stale column must be inert
  const spawnRepo = path.join(tmpHome, 'repo');
  fs.mkdirSync(spawnRepo, { recursive: true });
  git(spawnRepo, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(spawnRepo, 'R.md'), 'x\n'); git(spawnRepo, ['add', '.']); git(spawnRepo, ['commit', '-q', '-m', 's']);
  await store.addRepo({ path: spawnRepo, name: 'repo', defaultBranch: 'main' });
  const sp = await workspaces.dispatchSpawnRequest({ from: 'ws-m1', task: 'brief', repoPath: spawnRepo, agent: 'claude', defaultKind: 'spawned', detached: true });
  const msg = await workspaces.dispatchMessageRequest({ from: 'ws-xm', to: 'ws-m1', text: 'OFF-MSG', emergency: true });
  const wk = await workspaces.wakeAgentWithPrompt('ws-m1', 'OFF-WAKE');
  const { dispatchRestartRequest } = await import(`${REPO}/src/main/restart-workspace.ts`);
  await store.upsertWorkspace({ ...ws('ws-m1'), sdkSessionId: 's', hasInput: true });
  const rs = await dispatchRestartRequest({ id: 'ws-m1', fresh: false, trigger: 'cli' });
  const { wakeRosterEntry } = await import(`${REPO}/src/main/wake-roster.ts`);
  const effective = busPause.effectivePausedRunIds(db);
  rec('results', { spawn: sp.ok, msg: msg.delivery, wake: wk, restartRefusal: rs.error === PAUSED_MSG, wakeable: wakeRosterEntry(ws('ws-m1')).wakeable, effectivePaused: [...effective] });
  ok = refused === 'switch-off' && sp.ok === true && msg.delivery === 'started' && wk === true && out.results.restartRefusal === false && out.results.wakeable === true && effective.size === 0;

} else {
  out.error = `arm not implemented yet: ${ARM}`;
}

out.ok = ok;
console.log(JSON.stringify(out));
process.exit(ok ? 0 : 1);
