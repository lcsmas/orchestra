// #198 D14 (T10) — idle-hibernate at the 5-min DEFAULT, driven through the REAL
// sweeper (`sweepHibernation`) and the REAL bus wake (`sweepBusWake` →
// `sdkStartAndDeliver` → `ensureSession`), with a stub CLI standing in for
// `claude`. The pure rule (`shouldHibernate`) is unit-tested; this rig proves the
// COMPOSITION: the shipped default, the activity funnel, the guards, and that a
// coordinator woken by the bus after hibernation resumes and answers.
//
// The clock is faked by skewing `Date.now` (the sweeper reads it directly); the
// env override is DELETED so the arm measures the shipped default, not a knob.
// Status transitions the CLI's hooks would feed the spool tailer are applied via
// the same `applyAgentEvent` funnel (the stub has no hooks) — NOT VERIFIED here:
// the hook script → spool → tailer leg itself.
//
// Arms (ONE per process — module state is global):
//   window_4min      ★ must-PASS  idle 4 min  → NOT hibernated
//   window_6min      ★ must-FAIL on a 30-min default: idle 6 min → hibernated,
//                      stopped, `sdkSessionId` kept, `hibernatedAt` set
//   recent_activity  ★ must-PASS  a real submit/stop at +4 min, sweep at +6 →
//                      only 2 min idle → NOT hibernated (proves the funnel stamps)
//   control_6h       — no guard present, 6 h idle → hibernated (rig CAN hibernate)
//   guard_run_pty    ★ live `<ws>:run` PTY, 6 h idle → NOT hibernated
//   guard_turn       ★ a turn in flight (status running), 6 h idle → NOT hibernated
//   wake_after       ★ (a) hibernate, then a bus insert + real wake sweep → resumed
//                      by `sdkSessionId`, the ORDER turn appears and is ANSWERED,
//                      `hibernatedAt` cleared, mail lossless via the real verbs
//   teardown_chip    ★ (N1, sweeper-owned) a wake lands WHILE the hibernate teardown is
//                      in flight → the sweep must NOT stamp `hibernatedAt` on the woken row
//   wake_during_teardown ★ (N1, #124 seam) same drive → exactly one live successor,
//                      REACHABLE by the next send (needs agent-sdk's identity-guarded
//                      `sessions.delete` — #124, on master since af5c6a7e)
//
//   fresh_record     ★ (F2) a NON-wake writer lands a field mid-teardown → the sweep stamps the
//                      chip WITHOUT clobbering it (marks from a fresh record, not the pre-await one)
//   bg_task          ★ (F1) a live BACKGROUND task (task_started + background_tasks_changed, one
//                      heartbeat at +4 min) → NOT hibernated at +6 min; idle >=5 min asserted so
//                      recency cannot be what spares it (task events stamp no activity)
//   bg_task_done     — control: the task completes (task_notification) → hibernated (block not permanent)
//   level_only       ★ (R1) a keeper REATTACH learns of a live bg task ONLY via the `background_tasks_changed`
//                      level snapshot (no `started` edge; local_bash emits no task_progress) → NOT hibernated
//   level_only_healed— control: the seeded entry is healed by a later empty snapshot → hibernates
//   fleet_unread_wake ★ (2026-10-07) an auto-unread FLEET MEMBER (parentId) → hibernated, still in the
//                      inbox, then the bus wake resumes it and it answers (same asserts as wake_after)
//   toplevel_unread  ★ an auto-unread workspace WITHOUT a coordinator, 6 h idle → NOT hibernated
//   level_after_done — control: a STALE snapshot after the task finished never resurrects it → hibernates
//   bg_task_healed   — control: a lost bookend is healed by a `background_tasks_changed` replace → hibernated
//   hibernate_exit1 ★ a hibernate stop whose CLI exits 1 during the graceful close emits NO error row
//                      (session-scoped `hibernating` marker → classifyConsumeTermination 'suppress');
//                      a spontaneous crash of the SUCCESSOR session still does (positive control, and
//                      proof the marker does not leak). Field: 11/126 real hibernations had the row.
//   fresh_record     ★ (F2) a NON-wake writer lands a field mid-teardown → the sweep stamps the
//                      chip WITHOUT clobbering it (marks from a fresh record, not the pre-await one)
//   bg_task          ★ (F1) a live BACKGROUND task (task_started + background_tasks_changed, one
//                      heartbeat at +4 min) → NOT hibernated at +6 min; idle >=5 min asserted so
//                      recency cannot be what spares it (task events stamp no activity)
//   bg_task_done     — control: the task completes (task_notification) → hibernated (block not permanent)
//   level_only       ★ (R1) a keeper REATTACH learns of a live bg task ONLY via the `background_tasks_changed`
//                      level snapshot (no `started` edge; local_bash emits no task_progress) → NOT hibernated
//   level_only_healed— control: the seeded entry is healed by a later empty snapshot → hibernates
//   level_after_done — control: a STALE snapshot after the task finished never resurrects it → hibernates
//   bg_task_healed   — control: a lost bookend is healed by a `background_tasks_changed` replace → hibernated
//   hibernate_exit1 ★ MEASUREMENT (expected RED on this base): a hibernate stop whose CLI
//                      exits 1 during the graceful close must emit NO error row (it is an
//                      intentional stop); a spontaneous crash still must (positive control).
//                      Field rate: 11/126 real hibernations logged `exited with code 1`
//                      within 3 s (~9%). consume()'s catch only stays quiet for
//                      cleared/interrupted/restartRequested, and hibernate sets none.
//
//   reliquat_*       (#326 Veille and Reliquats) a REAL orphan listed in a FAKE scope: 10min ★ NOT hibernated (live Reliquat, short of the 30-min delay) · 31min ★ hibernated, the Reliquat STOPPED,
//                      the notice queued in the inbox and printed by the shipped inbox hook · none_5min — no Reliquat ⇒ the normal 5-min Veille · fast ★ fast Veille (Admission held) skips the delay,
//                      stops + lists · delay_hot ★ the Garde mémoire setting read hot · unknown — an unreadable scope ⇒ today's Veille, nothing killed
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/e2e-hibernate-wake.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'window_6min';
const ARMS = [
  'window_4min', 'window_6min', 'recent_activity', 'control_6h',
  'guard_run_pty', 'guard_turn', 'wake_after', 'teardown_chip', 'wake_during_teardown',
  'hibernate_exit1', 'fresh_record', 'bg_task', 'bg_task_done', 'bg_task_healed',
  'level_only', 'level_only_healed', 'level_after_done', 'fleet_unread_wake', 'toplevel_unread',
  'reliquat_10min', 'reliquat_31min', 'reliquat_none_5min', 'reliquat_fast', 'reliquat_delay_hot', 'reliquat_unknown',
  'reliquat_woken_during_stop', 'reliquat_woken_after_stop', 'reliquat_again_false', 'reliquat_overlap', 'reliquat_scopeless', 'reliquat_census_race',
  'reliquat_msg_at_stop', 'reliquat_msg_at_census', 'reliquat_clock_jump', 'reliquat_nonfleet',   // #326-fu m1, m1, m2, m4
];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// The shipped default, not a knob: an inherited env override would make every
// arm measure the override.
delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS;
delete process.env.ORCHESTRA_HIBERNATE_SWEEP_MS;

// Default under the real home (btrfs), NOT /tmp (tmpfs): the fs is part of the instrument.
const tmpHome = path.join(process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-hibwake'), ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;

// ── fake clock: the sweeper reads Date.now() directly ───────────────────────
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;
// the MONOTONIC idle clock (#326-fu m2) follows the same skew — unless an arm sets `monoSkewOverride` (a wall-clock JUMP: Date.now moves, CLOCK_MONOTONIC does not)
const realPerf = performance.now.bind(performance);
let monoSkewOverride = null;
const hnActMono = await import(`${REPO}/src/main/hibernation-activity.ts`);
if (hnActMono.__setMonotonicClockForTests) hnActMono.__setMonotonicClockForTests(() => realPerf() + (monoSkewOverride ?? skewMs));
const MIN = 60_000;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const events = [];
initPlatform({
  kind: 'headless-e2e-hibwake',
  broadcast: (channel, wsId, event) => {
    if (channel === 'agent:event' && event) events.push({ wsId, ev: event });
  },
  broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-hibwake', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const hib = await import(`${REPO}/src/main/hibernation.ts`);
const act = await import(`${REPO}/src/main/activity.ts`);
const pty = await import(`${REPO}/src/main/pty.ts`);
const busMod = await import(`${REPO}/src/main/bus.ts`);
const wake = await import(`${REPO}/src/main/bus-wake.ts`);
const { isWakeOrder } = await import(`${REPO}/src/shared/bus-wake.ts`);
const { resolveHibernateAfterMs, shouldHibernate } = await import(`${REPO}/src/shared/hibernation.ts`);

const WS = 'ws-hibwake';
const RUN = 'run-hibwake';
const SESSION_ID = 'sess-hibwake-1';
const BODY = 'SECRET-BODY-hibwake-7c1d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The on-disk conversation the real CLI writes and `resume` is validated against
// (#178: a session id with no transcript resolves to a FRESH start, not a resume).
const TRANSCRIPT_DIR = path.join(tmpHome, '.claude', 'projects', tmpHome.replace(/[^A-Za-z0-9]/g, '-'));
const TRANSCRIPT = path.join(TRANSCRIPT_DIR, `${SESSION_ID}.jsonl`);
const appendTranscript = (obj) => {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  fs.appendFileSync(TRANSCRIPT, JSON.stringify(obj) + '\n');
};
const transcriptState = () => {
  try {
    const b = fs.readFileSync(TRANSCRIPT);
    return { bytes: b.length, lines: b.toString().split('\n').filter(Boolean).length,
             sha: crypto.createHash('sha256').update(b).digest('hex').slice(0, 16) };
  } catch { return { bytes: 0, lines: 0, sha: null }; }
};
async function waitUntil(pred, ms, step = 25) {
  const t0 = realNow();
  for (;;) {
    if (await pred()) return true;
    if (realNow() - t0 > ms) return false;
    await sleep(step);
  }
}

await store.load?.();
await store.upsertWorkspace({
  id: WS, name: 'coordinator', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: realNow(), hasInput: false,
});

// ── stub CLI: one `result` per consumed prompt; a hung turn never results ────
const calls = [];
sdk.__setQueryFactoryForTests(({ prompt, options }) => {
  const call = {
    n: calls.length + 1, resume: options?.resume, prompts: [], hold: false,
    interruptDelay: 0, interruptStartedAt: 0, ended: false,
    exitOnEnd: '', crash: '', poke: () => {}, inject: [],
  };
  calls.push(call);
  const queue = [];
  let poke = () => {};
  call.poke = () => poke();
  void (async () => {
    try {
      for await (const m of prompt) {
        call.prompts.push(JSON.stringify(m?.message?.content ?? ''));
        appendTranscript({ type: 'user', session: SESSION_ID, call: call.n, content: m?.message?.content ?? '' });
        queue.push(m); poke();
      }
    } catch { /* torn down; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: SESSION_ID, tools: [], slash_commands: [] };
      while (!call.ended) {
        if (call.crash) throw new Error(call.crash);     // a spontaneous CLI death
        if (call.inject.length) { yield call.inject.shift(); continue; } // a raw SDK message (task_*)
        if (!queue.length) { await new Promise((r) => { poke = r; }); continue; }
        queue.shift();
        if (call.hold) await new Promise(() => {}); // a turn that never ends
        appendTranscript({ type: 'assistant', session: SESSION_ID, call: call.n, content: `answer ${call.n}` });
        yield { type: 'result', subtype: 'success', session_id: SESSION_ID, is_error: false,
                num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `answer ${call.n}` };
      }
      if (call.exitOnEnd) throw new Error(call.exitOnEnd); // the CLI exits non-zero on graceful close
    },
    interrupt: async () => {
      call.interruptStartedAt = realNow();
      await sleep(call.interruptDelay);
      call.ended = true; poke();
    },
    setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

// What the CLI's hooks would feed the spool tailer, through the same funnel.
const hook = (name) => act.applyAgentEvent(WS, name, undefined);
let seenEvents = 0;
const tap = setInterval(() => {
  for (; seenEvents < events.length; seenEvents++) {
    const { ev } = events[seenEvents];
    if (ev.type === 'user-message' && !ev.queued) hook('submit');
    if (ev.type === 'turn-end') hook('stop');
  }
}, 10);
const keepalive = setInterval(() => {}, 250);

const wsNow = () => store.getWorkspace(WS);
// Would the workspace be eligible if it had been idle forever? True means NOTHING but recency
// (or the guard under test) stands between it and hibernation — else a 'not hibernated' is vacuous.
const eligibleIfOld = (over = {}) => shouldHibernate(wsNow(), {
  now: Date.now(), lastActivityAt: 0, isActive: false, hasLivePty: false, hasLiveSdk: true,
  hasLiveRunPty: false, hasLiveBackgroundTask: false, thresholdMs: resolveHibernateAfterMs(undefined), monotonicIdleMs: Number.MAX_SAFE_INTEGER, admissionHeld: false, liveReliquats: 0, reliquatDelayMs: 30 * MIN, ...over,
});
const live = () => delivery.sdkSessionLive(WS);
const turnEnds = () => events.filter((e) => e.ev.type === 'turn-end').length;
const orderTurns = () =>
  events.filter((e) => e.ev.type === 'user-message' && isWakeOrder(String(e.ev.text ?? ''))).length;

// ── setup: a real session, one answered turn, then "the user has seen it" ────
const started = await delivery.sdkStartAndDeliver(WS, 'first turn');
const firstAnswered = await waitUntil(() => turnEnds() >= 1 && wsNow().status === 'idle', 5000);
// `stop` marks autoUnread ("finished, never opened") — the sweeper never touches
// those. Clearing it is what the user opening the pane does (setActive).
await store.upsertWorkspace({ ...wsNow(), autoUnread: undefined });
const pre = {
  started, firstAnswered, live: live(), status: wsNow().status,
  autoUnread: !!wsNow().autoUnread, sdkSessionId: wsNow().sdkSessionId,
  hibernatedAt: wsNow().hibernatedAt ?? null,
  defaultThresholdMs: resolveHibernateAfterMs(undefined),
  transcript: transcriptState(),
};
// A vacuous arm is worse than a failed one: refuse to run on a bad pre-state.
if (!(pre.started && pre.firstAnswered && pre.live && pre.status === 'idle' &&
      !pre.autoUnread && pre.sdkSessionId === SESSION_ID && pre.hibernatedAt === null &&
      pre.transcript.lines >= 2)) {
  console.log(JSON.stringify({ arm: ARM, ok: false, rigFault: 'bad pre-state', pre }));
  process.exit(2);
}

// ── bus wiring, exactly as index.ts does ────────────────────────────────────
const db = busMod.openBus(path.join(tmpHome, '.orchestra', 'bus.sqlite'));
wake.__resetBusWakeForTests();
wake.__setBusReaderForTests(() => db);
wake.setWakeRoster(() => [{ reader: WS, wakeable: true, runId: RUN }]);
wake.setWakeDeliver((wsId, text) => delivery.sdkStartAndDeliver(wsId, text));
wake.__freezeSwitchForTests((runId) => runId === RUN);
const insert = (body) =>
  busMod.send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body, recipient: WS });

let fstype = 'unknown';
try { fstype = execSync(`findmnt -no FSTYPE -T ${JSON.stringify(tmpHome)}`).toString().trim(); } catch { /* best-effort */ }
const out = { arm: ARM, fstype, pre };
let ok = false;

if (ARM === 'window_4min' || ARM === 'window_6min') {
  skewMs = (ARM === 'window_4min' ? 4 : 6) * MIN;
  const controlEligible = eligibleIfOld();            // only recency can block window_4min
  const hibernated = await hib.sweepHibernation();
  const w = wsNow();
  const expectHib = ARM === 'window_6min';
  Object.assign(out, {
    hibernated, live: live(), hibernatedAt: w.hibernatedAt ?? null, sdkSessionId: w.sdkSessionId,
    interruptCalled: calls[0].interruptStartedAt > 0, transcriptAfter: transcriptState(), controlEligible,
  });
  ok = expectHib
    ? hibernated.length === 1 && hibernated[0] === WS && !live() && !!w.hibernatedAt &&
      w.sdkSessionId === SESSION_ID && calls[0].interruptStartedAt > 0 &&
      transcriptState().sha === pre.transcript.sha
    : controlEligible && hibernated.length === 0 && live() && !w.hibernatedAt && calls[0].interruptStartedAt === 0;
} else if (ARM === 'recent_activity') {
  skewMs = 4 * MIN;
  hook('submit'); hook('stop');                       // REAL funnel stamps activity at +4 min
  // `stop` marks autoUnread ASYNCHRONOUSLY: wait for it to land, THEN clear it, or it blocks the
  // sweep and this arm passes without ever testing recency (measured: mutant M4 survived).
  await waitUntil(() => wsNow().status === 'idle' && wsNow().autoUnread === true, 3000);
  await store.upsertWorkspace({ ...wsNow(), autoUnread: undefined });
  skewMs = 6 * MIN;                                   // only 2 min since the stamp
  const controlEligible = eligibleIfOld();            // positive control: only recency can block
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { hibernated, live: live(), status: wsNow().status, controlEligible });
  ok = controlEligible && hibernated.length === 0 && live() && wsNow().status === 'idle';
} else if (ARM === 'control_6h') {
  skewMs = 6 * 60 * MIN;
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { hibernated, live: live() });
  ok = hibernated.length === 1 && !live();
} else if (ARM === 'guard_run_pty') {
  await pty.startPty({ id: `${WS}:run`, cwd: tmpHome, command: 'sleep', args: ['3600'], cols: 80, rows: 24 });
  const runPtyLive = pty.isRunning(`${WS}:run`);
  skewMs = 6 * 60 * MIN;
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { runPtyLive, hibernated, live: live() });
  ok = runPtyLive && hibernated.length === 0 && live() && calls[0].interruptStartedAt === 0;
  pty.stopPty(`${WS}:run`);
} else if (ARM === 'guard_turn') {
  calls[0].hold = true;                               // the next turn never ends
  await delivery.sdkStartAndDeliver(WS, 'long turn');
  const running = await waitUntil(() => wsNow().status === 'running', 3000);
  skewMs = 6 * 60 * MIN;
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { statusRunning: running, hibernated, live: live(), status: wsNow().status });
  ok = running && hibernated.length === 0 && live() && calls[0].interruptStartedAt === 0;
} else if (ARM === 'toplevel_unread') {
  await store.upsertWorkspace({ ...wsNow(), autoUnread: true, parentId: undefined });
  skewMs = 6 * 60 * MIN;
  // positive control: only the missing coordinator stands between it and hibernation
  const controlEligible = shouldHibernate({ ...wsNow(), parentId: 'coord-1' }, {
    now: Date.now(), lastActivityAt: 0, isActive: false, hasLivePty: false, hasLiveSdk: true,
    hasLiveRunPty: false, hasLiveBackgroundTask: false, thresholdMs: resolveHibernateAfterMs(undefined), monotonicIdleMs: Number.MAX_SAFE_INTEGER, admissionHeld: false, liveReliquats: 0, reliquatDelayMs: 30 * MIN });
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { controlEligible, hibernated, live: live(), autoUnread: !!wsNow().autoUnread });
  ok = controlEligible && hibernated.length === 0 && live() && wsNow().autoUnread === true;
} else if (ARM === 'wake_after' || ARM === 'fleet_unread_wake') {
  const fleet = ARM === 'fleet_unread_wake';
  if (fleet) await store.upsertWorkspace({ ...wsNow(), autoUnread: true, parentId: 'coord-1' });
  skewMs = 6 * MIN;
  const hibernated = await hib.sweepHibernation();
  const hibernatedOk = hibernated.length === 1 && !live() && !!wsNow().hibernatedAt;
  // the bell must survive hibernation: the row stays in the inbox's needs-you group
  const { computeAttention } = await import(`${REPO}/src/shared/attention.ts`);
  const stillInInbox = computeAttention([wsNow()]).needsYou.some((w) => w.id === WS);
  if (fleet) out.stillInInbox = stillInInbox;
  const transcriptAtHibernate = transcriptState();
  const endsBefore = turnEnds();
  insert(`${BODY} for the coordinator`);
  await wake.sweepBusWake();                          // REAL wake → sdkStartAndDeliver → ensureSession
  const orderSeen = await waitUntil(() => orderTurns() >= 1, 5000);
  const answered = await waitUntil(() => turnEnds() > endsBefore && wsNow().status === 'idle', 5000);
  const w = wsNow();
  // Mail is durable: obey the order with the REAL verbs, exactly as the woken agent would.
  const verbs = await import(`${REPO}/src/cli/bus-verbs.ts`);
  const id = verbs.resolveBusIdentity({}, { ORCHESTRA_RUN_ID: RUN, ORCHESTRA_WS_ID: WS });
  // The verb slice composed exactly as src/cli/index.ts does (bus + bus-runs +
  // bus-receipts) — passing bare `busMod` is rig rot (getRelatedRunIds moved).
  const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
  const receipts = await import(`${REPO}/src/main/bus-receipts.ts`);
  const slice = {
    send: busMod.send, check: busMod.check, ack: busMod.ack, openGate: busMod.openGate,
    resolveGate: busMod.resolveGate, getGate: busMod.getGate,
    sendGateResolutionRewake: busMod.sendGateResolutionRewake,
    openGatesForRecipient: busMod.openGatesForRecipient,
    openGatesForRecipientInRuns: busMod.openGatesForRecipientInRuns,
    getRelatedRunIds: busRuns.getRelatedRunIds, getRun: busRuns.getRun,
    fencedWrite: busMod.fencedWrite, mintCapability: busMod.mintCapability,
    verifyCapability: busMod.verifyCapability,
    rotateCapabilityForRecipient: busMod.rotateCapabilityForRecipient,
    withReceipt: receipts.withReceipt, busSwitch: busRuns.busSwitch,
  };
  let stdout = '';
  const ctx = {
    db, id, bus: slice, generation: null, fencingOn: false,
    out: (t) => { stdout += t; }, fail: (m) => { throw new Error(m); },
  };
  verbs.verbCheck(ctx, { limit: 100 });
  const lot = JSON.parse(stdout);
  stdout = '';
  verbs.verbAck(ctx, String(lot.lot));
  const pending = wake.readPendingReaders(db, [{ reader: WS, runId: RUN }])[0].pending;
  Object.assign(out, {
    hibernatedOk, factoryCalls: calls.length, resumeId: calls[1]?.resume ?? null, orderSeen, answered,
    live: live(), hibernatedAtAfterWake: w.hibernatedAt ?? null, status: w.status,
    lotCount: lot.count, lotCarriedBody: String(lot.messages?.[0]?.body ?? '').includes(BODY),
    pendingAfterAck: pending,
    transcriptAtHibernate, transcriptAfterWake: transcriptState(),
  });
  // Lossless = the on-disk conversation is byte-identical through the hibernate and
  // the resume only APPENDS to it (prefix intact), and `resume` named the persisted id.
  const prefixIntact =
    crypto.createHash('sha256').update(fs.readFileSync(TRANSCRIPT).subarray(0, pre.transcript.bytes))
      .digest('hex').slice(0, 16) === pre.transcript.sha;
  out.prefixIntact = prefixIntact;
  ok = hibernatedOk && transcriptAtHibernate.sha === pre.transcript.sha &&
       calls.length === 2 && calls[1].resume === SESSION_ID && orderSeen && answered &&
       transcriptState().lines > pre.transcript.lines && prefixIntact &&
       live() && !w.hibernatedAt && lot.count === 1 && out.lotCarriedBody && pending === false &&
       (!fleet || stillInInbox);
} else if (ARM === 'wake_during_teardown' || ARM === 'teardown_chip') {
  calls[0].interruptDelay = 600;                      // a slow graceful close widens the window
  skewMs = 6 * MIN;
  const sweepP = hib.sweepHibernation();              // NOT awaited: teardown in flight
  const stopping = await waitUntil(() => calls[0].interruptStartedAt > 0, 3000);
  insert(`${BODY} mid-teardown`);
  await wake.sweepBusWake();                          // wake lands while `stopping`
  const hibernated = await sweepP;
  const orderSeen = await waitUntil(() => orderTurns() >= 1, 5000);
  await sleep(1500);                                  // let the old consume() finally + successor settle
  const liveAfter = live();
  const callsAfterWake = calls.length;
  // Read the chip BEFORE the follow-up: its ensureSession calls clearHibernated and would wipe a
  // stale chip, masking the sweeper defect (measured: mutant M5 survived until this moved).
  const chipBeforeFollowUp = wsNow().hibernatedAt ?? null;
  await delivery.sdkStartAndDeliver(WS, 'follow-up after wake');
  await sleep(600);
  const w = wsNow();
  const followUpOnSuccessor = !!calls[1]?.prompts.some((p) => p.includes('follow-up after wake'));
  Object.assign(out, {
    stopping, hibernated, orderSeen, liveAfter, callsAfterWake, callsAfterFollowUp: calls.length,
    followUpOnSuccessor, chipBeforeFollowUp, hibernatedAtAfter: w.hibernatedAt ?? null,
  });
  const chipStale = chipBeforeFollowUp !== null;      // sweeper-owned defect
  const successorReachable = liveAfter && callsAfterWake === 2 && calls.length === 2 && followUpOnSuccessor;
  Object.assign(out, { chipStale, successorReachable });
  ok = ARM === 'teardown_chip'
    ? stopping && orderSeen && !chipStale             // only the piece hibernation.ts owns
    : stopping && orderSeen && successorReachable && !chipStale;
}

if (ARM === 'fresh_record') {
  // A NON-wake writer lands a field mid-teardown; the sweep must stamp the chip WITHOUT clobbering it.
  calls[0].interruptDelay = 600;
  skewMs = 6 * MIN;
  const sweepP = hib.sweepHibernation();
  const stopping = await waitUntil(() => calls[0].interruptStartedAt > 0, 3000);
  await store.upsertWorkspace({ ...wsNow(), statusText: 'written-mid-teardown' });
  const hibernated = await sweepP;
  const w = wsNow();
  Object.assign(out, { stopping, hibernated, chip: w.hibernatedAt ?? null, statusText: w.statusText ?? null });
  ok = stopping && hibernated.length === 1 && !!w.hibernatedAt && w.statusText === 'written-mid-teardown';
}

if (ARM === 'bg_task' || ARM === 'bg_task_done' || ARM === 'bg_task_healed') {
  // The agent ended its turn and left a BACKGROUND task running. Task events stamp NO activity
  // (mapped to null in sdkEventToStatusEvent), so only the live-task guard can spare the session.
  const hn = await import(`${REPO}/src/main/hibernation-activity.ts`);
  const taskEvents = () => events.filter((e) => e.ev.type === 'task').length;
  const c = calls[0];
  const sys = (o) => ({ type: 'system', session_id: SESSION_ID, uuid: `u-${Math.random()}`, ...o });
  c.inject.push(sys({ subtype: 'task_started', task_id: 'bg1', tool_use_id: 'tu-bg1', task_type: 'local_bash', description: 'pnpm test (background)' }));
  c.inject.push(sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg1' }] }));
  c.poke();
  const startedSeen = await waitUntil(() => taskEvents() >= 2, 3000);
  skewMs = 4 * MIN;
  c.inject.push(sys({ subtype: 'task_progress', task_id: 'bg1', tool_use_id: 'tu-bg1', description: 'pnpm test (background)',
    usage: { total_tokens: 0, tool_uses: 1, duration_ms: 240000 }, last_tool_name: 'Bash' }));
  c.poke();
  const progressSeen = await waitUntil(() => taskEvents() >= 3, 3000);
  let closeSeen = true;
  if (ARM === 'bg_task_done') {
    c.inject.push(sys({ subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'tu-bg1', status: 'completed', summary: 'done' }));
    c.poke(); closeSeen = await waitUntil(() => taskEvents() >= 4, 3000);
  }
  if (ARM === 'bg_task_healed') {
    c.inject.push(sys({ subtype: 'background_tasks_changed', tasks: [] })); // a missed bookend, healed by replace
    c.poke(); closeSeen = await waitUntil(() => taskEvents() >= 4, 3000);
  }
  await sleep(100);
  skewMs = 6 * MIN;
  const idleMinutes = (Date.now() - (hn.getLastActivity(WS) ?? 0)) / MIN;
  const controlEligible = eligibleIfOld();           // only the live task can block
  const hasTask = delivery.sdkHasBackgroundTasks?.(WS) ?? false;   // absent on a pre-F1 tree → false, not a crash
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { startedSeen, progressSeen, closeSeen, taskEvents: taskEvents(), idleMinutes: Math.round(idleMinutes * 10) / 10,
    controlEligible, hasTask, hibernated, live: live(), interruptCalled: c.interruptStartedAt > 0 });
  const proven = startedSeen && progressSeen && closeSeen && controlEligible && idleMinutes >= 5;
  ok = ARM === 'bg_task'
    ? proven && hasTask && hibernated.length === 0 && live()
    : proven && !hasTask && hibernated.length === 1 && !live();
}

if (ARM === 'level_only' || ARM === 'level_only_healed' || ARM === 'level_after_done') {
  const hn = await import(`${REPO}/src/main/hibernation-activity.ts`);
  const taskEvents = () => events.filter((e) => e.ev.type === 'task').length;
  const c = calls[0];
  const sys = (o) => ({ type: 'system', session_id: SESSION_ID, uuid: `u-${Math.random()}`, ...o });
  const live1 = { task_id: 'bg1', task_type: 'local_bash', description: 'pnpm test (background)' };
  let expected = 1;
  if (ARM === 'level_after_done') {
    c.inject.push(sys({ subtype: 'task_started', ...live1, tool_use_id: 'tu-bg1' }));
    c.inject.push(sys({ subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'tu-bg1', status: 'completed', summary: 'done' }));
    c.inject.push(sys({ subtype: 'background_tasks_changed', tasks: [live1] }));  // a STALE snapshot after the finish
    expected = 3;
  } else {
    c.inject.push(sys({ subtype: 'background_tasks_changed', tasks: [live1] }));  // the ONLY signal a reattach gets
    if (ARM === 'level_only_healed') { c.inject.push(sys({ subtype: 'background_tasks_changed', tasks: [] })); expected = 2; }
  }
  c.poke();
  const seen = await waitUntil(() => taskEvents() >= expected, 3000);
  await sleep(100);
  skewMs = 6 * MIN;
  const idleMinutes = (Date.now() - (hn.getLastActivity(WS) ?? 0)) / MIN;
  const controlEligible = eligibleIfOld();
  const hasTask = delivery.sdkHasBackgroundTasks?.(WS) ?? false;
  const hibernated = await hib.sweepHibernation();
  Object.assign(out, { seen, taskEvents: taskEvents(), idleMinutes: Math.round(idleMinutes * 10) / 10, controlEligible, hasTask, hibernated, live: live() });
  const proven = seen && controlEligible && idleMinutes >= 5;
  ok = ARM === 'level_only'
    ? proven && hasTask && hibernated.length === 0 && live()
    : proven && !hasTask && hibernated.length === 1 && !live();
}

if (ARM === 'hibernate_exit1') {
  const EXIT1 = 'Claude Code process exited with code 1';
  const errorRows = () => events.filter((e) => e.ev.type === 'error').length;
  calls[0].exitOnEnd = EXIT1;
  skewMs = 6 * MIN;
  const hibernated = await hib.sweepHibernation();
  await sleep(600);
  const rowsAfterHibernate = errorRows();
  // Positive control: the instrument CAN see a genuine crash (resume, then die on its own).
  await delivery.sdkStartAndDeliver(WS, 'resume for control');
  await waitUntil(() => calls.length === 2 && live(), 3000);
  calls[1].crash = EXIT1; calls[1].poke();
  await waitUntil(() => errorRows() > rowsAfterHibernate, 3000);
  const rowsForCrash = errorRows() - rowsAfterHibernate;
  Object.assign(out, { hibernated, rowsAfterHibernate, rowsForCrash });
  ok = hibernated.length === 1 && rowsForCrash === 1 && rowsAfterHibernate === 0;
}

// ── #326 Veille and Reliquats ───────────────────────────────────────────────────────────────────────────────────────
// A REAL orphan (`setsid sleep` started by a shell that exits at once) listed in a FAKE scope's cgroup.procs (a scratch cgroup tree: no systemd scope is created, so this rig is not heavy); the port is
// the production one (productionVeilleReliquatPort: memberScopeDeps / judgeReliquat / killReliquats, identity re-read at signal time, the notice queued in the member's inbox under the scratch HOME).
// The clock is skewed like every arm here. NOT VERIFIED here: the CLI firing its SessionStart hook on the wake — the hook script itself is run (extracted from the shipped source) over the real inbox file.
if (ARM.startsWith('reliquat_')) {
  const vm = await import('node:vm');
  const { execFileSync } = await import('node:child_process');
  const { realScopeEnv } = await import(`${REPO}/src/main/memory-scope.ts`);
  const { parseInboxBlocks } = await import(`${REPO}/src/shared/inbox-blocks.ts`);
  const UID = 4244;
  const PREFIX = 'orchestra-rig-wh-v-';
  const cg = path.join(tmpHome, 'cg');
  const slice = path.join(cg, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`, 'app.slice');
  fs.mkdirSync(slice, { recursive: true });
  const scopeDir = path.join(slice, `${PREFIX}${WS}-aaaaaa.scope`);
  fs.mkdirSync(scopeDir, { recursive: true });
  const scopeEnv = { ...realScopeEnv(), platform: 'linux', uid: UID, cgroupRoot: cg, procRoot: '/proc', env: { ORCHESTRA_MEMORY_SCOPE_PREFIX: PREFIX }, keeperPidFile: (ws) => path.join(tmpHome, `${ws}.pid`) };
  const startTicks = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]); } catch { return null; } };
  const orphans = [];
  const orphan = (tag) => {
    const pid = Number(execFileSync('sh', ['-c', `setsid sleep ${tag} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim());
    const o = { pid, start: startTicks(pid), tag };
    orphans.push(o);
    return o;
  };
  const alive = (o) => { const st = startTicks(o.pid); if (st !== o.start) return false; try { return !/^Z/.test(fs.readFileSync(`/proc/${o.pid}/stat`, 'utf8').split(') ')[1]); } catch { return false; } };
  const members = (os_) => fs.writeFileSync(path.join(scopeDir, 'cgroup.procs'), os_.map((o) => o.pid).join('\n') + '\n');
  // On a tree WITHOUT #326 (the must-FAIL run against origin/master) there is no port to register: the arms then observe master's own Veille — the instrument is the same, the subject is not.
  let port = null;
  try {
    const { productionVeilleReliquatPort } = await import(`${REPO}/src/main/veille-reliquats-host.ts`);
    port = productionVeilleReliquatPort({ scopeEnv, cliOf: async () => null, countBrowsers: async () => 0, stopBrowsers: async () => null });
    hib.setVeilleReliquatPort(port);
  } catch (e) {
    out.noPort = String(e?.message ?? e).slice(0, 120);
  }
  /** The production port with some steps replaced (a rig-only seam: it lets an arm land a wake / a prompt / a second pass at an exact point of the verdict). */
  const wrapPort = (over) => {
    if (!port) return null;
    const p2 = { census: (w) => port.census(w), stop: (w, c) => port.stop(w, c), tell: (w, t) => port.tell(w, t), ...over };
    hib.setVeilleReliquatPort(p2);
    return p2;
  };
  const inboxFile = path.join(tmpHome, '.orchestra', 'inbox', `${WS}.txt`);
  const inboxBlocks = () => { try { return parseInboxBlocks(fs.readFileSync(inboxFile, 'utf8')).map((b) => b.text); } catch { return []; } };
  const hookOutput = () => {
    const src = fs.readFileSync(`${REPO}/src/main/workspaces.ts`, 'utf8');
    const m = /const INBOX_INSTRUCTION_SCRIPT = `([^]*?)`;/.exec(src);
    const script = vm.runInNewContext('`' + m[1] + '`');
    return execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_WS_ID: WS }, encoding: 'utf8' });
  };
  // R11 (#326-fu m4): the Reliquat machinery is for FLEET members — every arm but `reliquat_nonfleet` runs a member with a coordinator
  if (ARM !== 'reliquat_nonfleet') await store.upsertWorkspace({ ...wsNow(), parentId: 'coord-1' });
  const hnActR = await import(`${REPO}/src/main/hibernation-activity.ts`);
  const bystander = orphan('3601'); // OUTSIDE the scope: must survive everything
  const mine = ARM === 'reliquat_none_5min' || ARM === 'reliquat_census_race' ? [] : [orphan('3600')];
  members(mine);
  const readyPremise = mine.every(alive) && alive(bystander);
  const censusNow = port ? await port.census(WS) : 'no-port';
  const base = { readyPremise, census: censusNow, controlEligible: eligibleIfOld() };

  if (ARM === 'reliquat_10min') {
    skewMs = 10 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, live: live(), reliquatAlive: mine.every(alive), inbox: inboxBlocks().length, interruptCalled: calls[0].interruptStartedAt > 0 });
    ok = readyPremise && (port === null || censusNow === 1) && base.controlEligible && hibernated.length === 0 && live() && mine.every(alive) && inboxBlocks().length === 0 && calls[0].interruptStartedAt === 0;
  } else if (ARM === 'reliquat_31min') {
    skewMs = 31 * MIN;
    const hibernated = await hib.sweepHibernation();
    const blocks = inboxBlocks();
    const printed = hookOutput();
    Object.assign(out, base, { hibernated, live: live(), reliquatAlive: mine.every(alive), bystanderAlive: alive(bystander), blocks, hookOutput: printed, inboxAfterHook: fs.existsSync(inboxFile) });
    ok = readyPremise && censusNow === 1 && hibernated.length === 1 && hibernated[0] === WS && !live() && !!wsNow().hibernatedAt && wsNow().sdkSessionId === SESSION_ID &&
      !mine.some(alive) && alive(bystander) && blocks.length === 1 && /Orchestra stopped 1 leftover process\(es\) of yours \(Reliquats\) because you had been idle for 31m/.test(blocks[0]) && /sleep 3600/.test(blocks[0]) &&
      /You have message\(s\) from other agents/.test(printed) && /sleep 3600/.test(printed) && !fs.existsSync(inboxFile);
  } else if (ARM === 'reliquat_none_5min') {
    skewMs = 6 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, live: live(), inbox: inboxBlocks().length });
    ok = (port === null || censusNow === 0) && hibernated.length === 1 && !live() && inboxBlocks().length === 0 && alive(bystander);
  } else if (ARM === 'reliquat_fast') {
    // fast Veille (#288): Admission held ⇒ a fleet member is past its threshold at once — the Reliquat delay does NOT apply; its Reliquats are stopped + listed, worded as memory pressure
    await store.upsertWorkspace({ ...wsNow(), parentId: 'coord-1' });
    const g = await import(`${REPO}/src/main/memory-guard.ts`);
    let mem = 1 * 1024 ** 3;
    g.__rebuildMemoryGuardForTests({}, () => mem);
    const snap = g.sampleMemoryGuardNow();
    skewMs = 1 * MIN;
    const hnAct = await import(`${REPO}/src/main/hibernation-activity.ts`);
    const idleMin = (Date.now() - (hnAct.getLastActivity(WS) ?? 0)) / MIN;
    const hibernated = await hib.sweepHibernation();
    const blocks = inboxBlocks();
    g.stopMemoryGuard();
    Object.assign(out, base, { admission: snap.admission, idleMin: Math.round(idleMin * 10) / 10, hibernated, live: live(), reliquatAlive: mine.every(alive), blocks });
    ok = readyPremise && snap.admission === 'held' && idleMin < 5 && hibernated.length === 1 && !live() && !mine.some(alive) && alive(bystander) &&
      blocks.length === 1 && /Reliquats\) early, to free memory \(Admission is held\)/.test(blocks[0]) && /sleep 3600/.test(blocks[0]);
  } else if (ARM === 'reliquat_delay_hot') {
    // the delay is a Garde mémoire setting read at EVERY pass: 8 min ⇒ idle 7 min waits; the same process, the setting changed to 6 min ⇒ the next pass puts it in Veille
    await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), reliquatWaitMin: 8 });
    skewMs = 7 * MIN;
    const first = await hib.sweepHibernation();
    const aliveAfterFirst = mine.every(alive);
    await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), reliquatWaitMin: 6 });
    const second = await hib.sweepHibernation();
    Object.assign(out, base, { first, aliveAfterFirst, second, live: live(), reliquatAlive: mine.every(alive), delayNow: store.getMemoryGuardSettings().reliquatWaitMin });
    ok = readyPremise && censusNow === 1 && first.length === 0 && aliveAfterFirst && live() === false && second.length === 1 && !mine.some(alive);
  } else if (ARM === 'reliquat_unknown') {
    // the scope cannot be READ (cgroup.procs is a directory ⇒ EISDIR): UNKNOWN is not NONE (R11, #326-fu m3) — NO Veille this pass, the Reliquat untouched; the deferral is ONE sweep, not a ban (the scope readable again, no Reliquat ⇒ the next pass puts it in Veille)
    fs.rmSync(path.join(scopeDir, 'cgroup.procs'));
    fs.mkdirSync(path.join(scopeDir, 'cgroup.procs'));
    const census2 = port ? await port.census(WS) : 'no-port';
    skewMs = 6 * MIN;
    const hibernated = await hib.sweepHibernation();
    const aliveAfterFirst = mine.every(alive);
    fs.rmSync(path.join(scopeDir, 'cgroup.procs'), { recursive: true });
    members([]);
    const second = await hib.sweepHibernation();
    Object.assign(out, base, { census2, hibernated, aliveAfterFirst, second, live: live(), reliquatAlive: mine.every(alive), inbox: inboxBlocks().length });
    ok = (port === null || census2 === 'unknown') && hibernated.length === 0 && aliveAfterFirst && second.length === 1 && !live() && mine.every(alive) && inboxBlocks().length === 0;
  } else if (ARM === 'reliquat_msg_at_stop') {
    // #326-fu m1: a message is delivered to the (LIVE) session at the START of the stop — it stamps activity but bumps NO wake epoch. The fresh judgement ends the signal rounds BEFORE any signal: the Reliquat lives, the member is not hibernated, nothing to tell
    wrapPort({ stop: async (w, c) => { hnActR.noteActivity(WS); return port.stop(w, c); } });
    skewMs = 40 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, live: live(), reliquatAlive: mine.every(alive), inbox: inboxBlocks().length });
    ok = readyPremise && port !== null && hibernated.length === 0 && live() && mine.every(alive) && inboxBlocks().length === 0 && !wsNow().hibernatedAt;
  } else if (ARM === 'reliquat_msg_at_census') {
    // #326-fu m1: the same message lands while the CENSUS awaits: the member is judged AGAIN before the first signal round — the stop is never even asked
    let stops = 0;
    wrapPort({ census: async (w) => { const c = await port.census(w); hnActR.noteActivity(WS); return c; }, stop: async (w, c) => { stops++; return port.stop(w, c); } });
    skewMs = 40 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, stops, live: live(), reliquatAlive: mine.every(alive), inbox: inboxBlocks().length });
    ok = readyPremise && port !== null && stops === 0 && hibernated.length === 0 && live() && mine.every(alive) && inboxBlocks().length === 0;
  } else if (ARM === 'reliquat_clock_jump') {
    // #326-fu m2: the WALL clock jumps +3 h (NTP step / resume) over a member that was active a moment ago: the monotonic clock says so — the Reliquat wait is NOT over, nothing is stopped.
    // Control, same process: once the monotonic clock has seen the same 3 h, the very next pass stops and tells.
    monoSkewOverride = 0;
    skewMs = 3 * 60 * MIN;
    const jumped = await hib.sweepHibernation();
    const aliveAfterJump = mine.every(alive);
    const inboxAfterJump = inboxBlocks().length;
    monoSkewOverride = null;   // the monotonic clock now agrees (skew follows `skewMs`)
    const agreed = await hib.sweepHibernation();
    const blocks = inboxBlocks();
    Object.assign(out, base, { jumped, aliveAfterJump, inboxAfterJump, agreed, live: live(), reliquatAlive: mine.every(alive), blocks: blocks.length });
    ok = readyPremise && censusNow === 1 && base.controlEligible && jumped.length === 0 && aliveAfterJump && inboxAfterJump === 0 && agreed.length === 1 && !live() && !mine.some(alive) && blocks.length === 1 && alive(bystander);
  } else if (ARM === 'reliquat_nonfleet') {
    // R11 (#326-fu m4): a member WITHOUT a coordinator is never counted, waited for or stopped — idle 10 min with a live Reliquat ⇒ today's Veille, the Reliquat left alone, the port not even consulted
    let censuses = 0;
    wrapPort({ census: async (w) => { censuses++; return port.census(w); } });
    skewMs = 10 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, censuses, live: live(), reliquatAlive: mine.every(alive), inbox: inboxBlocks().length, parentId: wsNow().parentId ?? null });
    ok = readyPremise && port !== null && !wsNow().parentId && hibernated.length === 1 && censuses === 0 && !live() && mine.every(alive) && inboxBlocks().length === 0;
  } else if (ARM === 'reliquat_woken_during_stop') {
    // a wake lands at the START of the stop: the « still wanted » check ends the signal rounds BEFORE any signal — the Reliquat lives, the member is not hibernated, nothing to tell
    wrapPort({ stop: async (w, c) => { hib.clearHibernated(WS); return port.stop(w, c); } });
    skewMs = 40 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, live: live(), reliquatAlive: mine.every(alive), inbox: inboxBlocks().length });
    ok = readyPremise && port !== null && hibernated.length === 0 && live() && mine.every(alive) && inboxBlocks().length === 0;
  } else if (ARM === 'reliquat_woken_after_stop') {
    // a wake lands AFTER the stop completed: the Reliquat is gone and the member IS told (the wording stays true), but it is not hibernated — it is awake
    wrapPort({ stop: async (w, c) => { const r = await port.stop(w, c); hib.clearHibernated(WS); return r; } });
    skewMs = 40 * MIN;
    const hibernated = await hib.sweepHibernation();
    const blocks = inboxBlocks();
    Object.assign(out, base, { hibernated, live: live(), reliquatAlive: mine.every(alive), blocks: blocks.length });
    ok = readyPremise && port !== null && hibernated.length === 0 && live() && !mine.some(alive) && blocks.length === 1 && !/put you in Veille/.test(blocks[0]) && !wsNow().hibernatedAt;
  } else if (ARM === 'reliquat_again_false') {
    // a prompt starts a turn while the Reliquats are being stopped: the Veille is re-judged on FRESH state and dropped; the stop stays done and told
    wrapPort({ stop: async (w, c) => { const r = await port.stop(w, c); await store.upsertWorkspace({ ...wsNow(), status: 'running' }); return r; } });
    skewMs = 40 * MIN;
    const hibernated = await hib.sweepHibernation();
    const blocks = inboxBlocks();
    Object.assign(out, base, { hibernated, live: live(), status: wsNow().status, reliquatAlive: mine.every(alive), blocks: blocks.length });
    ok = readyPremise && port !== null && hibernated.length === 0 && live() && wsNow().status === 'running' && !mine.some(alive) && blocks.length === 1 && !calls[0].interruptStartedAt;
  } else if (ARM === 'reliquat_census_race') {
    // NOTHING is stopped (no Reliquat), but the CENSUS awaits (it probes the keeper): a prompt lands meanwhile — a turn starts. The verdict said « Veille »; the fresh re-check (whatever the verdict awaited) drops it
    wrapPort({ census: async (w) => { const c = await port.census(w); await store.upsertWorkspace({ ...wsNow(), status: 'running' }); return c; } });
    skewMs = 6 * MIN;
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, base, { hibernated, live: live(), status: wsNow().status, interruptCalled: calls[0].interruptStartedAt > 0 });
    ok = port !== null && censusNow === 0 && hibernated.length === 0 && live() && wsNow().status === 'running' && !calls[0].interruptStartedAt;
  } else if (ARM === 'reliquat_overlap') {
    // two passes overlap (the guard-sample trigger + the tick) while a slow stop is in flight: ONE stop, ONE notice, ONE Veille
    let stops = 0;
    wrapPort({ stop: async (w, c) => { stops++; await sleep(500); return port.stop(w, c); } });
    skewMs = 40 * MIN;
    const [a, b] = await Promise.all([hib.sweepHibernation(), hib.sweepHibernation()]);
    const blocks = inboxBlocks();
    Object.assign(out, base, { a, b, stops, live: live(), reliquatAlive: mine.every(alive), blocks: blocks.length });
    ok = readyPremise && port !== null && stops === 1 && a.length + b.length === 1 && !live() && !mine.some(alive) && blocks.length === 1;
  } else if (ARM === 'reliquat_scopeless') {
    // memory_cap OFF (no tracked scope): #331's browsers answer; the keeper is UNRESPONSIVE (cliOf errors) yet the member is still put in Veille after the wait and its browser stopped
    fs.rmSync(scopeDir, { recursive: true, force: true });
    const seenCalls = [];
    const killedBrowser = { scopes: ['browser:port'], killed: [{ pid: 4242, startTicks: 1, comm: 'chrome', cmd: 'chrome --headless --remote-debugging-port=9222', cwd: '/x/agent-tmp/ws/p', startedAt: Date.now(), scope: 'browser:port', evidence: 'e', signal: 'SIGTERM', outcome: 'exited' }], refused: [], spared: [], survivors: [], rounds: 1 };
    let sp = null;
    try {
      const { productionVeilleReliquatPort } = await import(`${REPO}/src/main/veille-reliquats-host.ts`);
      sp = productionVeilleReliquatPort({ scopeEnv, cliOf: async () => { seenCalls.push('cliOf'); return { error: 'keeper 1 is alive but did not answer the probe' }; }, countBrowsers: async () => { seenCalls.push('count'); return 1; }, stopBrowsers: async () => { seenCalls.push('stop'); return killedBrowser; } });
      hib.setVeilleReliquatPort(sp);
    } catch { /* a tree without #326 */ }
    skewMs = 10 * MIN;
    const early = await hib.sweepHibernation();
    skewMs = 31 * MIN;
    const hibernated = await hib.sweepHibernation();
    const blocks = inboxBlocks();
    Object.assign(out, base, { seenCalls, early, hibernated, live: live(), blocks: blocks.length });
    ok = sp !== null && early.length === 0 && hibernated.length === 1 && !live() && !seenCalls.includes('cliOf') && seenCalls.includes('stop') && blocks.length === 1 && /chrome --headless/.test(blocks[0]);
  }
  // teardown BY IDENTITY: only what this arm launched, only while it is still the same process
  for (const o of orphans) if (alive(o)) { try { process.kill(o.pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(100);
  out.survivors = orphans.filter(alive).length;
  ok = ok && out.survivors === 0;
}

clearInterval(tap); clearInterval(keepalive);
out.ok = ok;
console.log(JSON.stringify(out));
process.exit(ok ? 0 : 1);
