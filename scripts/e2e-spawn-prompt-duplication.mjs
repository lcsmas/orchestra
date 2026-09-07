// Issue #112 — a spawned agent's brief must reach it EXACTLY ONCE.
//
// Drives the REAL `sdkSend` + `recoverPendingPrompts` against a REAL store,
// with a stub CLI that reproduces the condition the field report turns on:
// SLOW SESSION INIT. The observable is a DELIVERY COUNT taken from the prompts
// the session actually received — not a log line, not a store field.
//
// ── The race being reproduced ───────────────────────────────────────────────
// `startWorkspaceAgentHeadless` sends the task; the renderer then mounts the
// new workspace's StructuredView, which calls `agentSdkHistory` ->
// `recoverPendingPrompts`. While the CLI is still in init the task is NOT in
// the on-disk transcript, which the old predicate read as "lost to a quit".
// Here the stub simply never starts a turn during the window in which the
// recovery pass runs, which is exactly what a 55 KB CLAUDE.md + MCP handshakes
// produce in the field. `history` is passed EMPTY, as the real backfill returns
// for a transcript the CLI has not written yet.
//
// ── Arms ────────────────────────────────────────────────────────────────────
//   slow_init      ★ THE DISCRIMINATING ARM. No turn ever completes, so the
//                    brief is still queued when the recovery pass runs — the
//                    field condition. MEASURED: 2 deliveries on the unfixed
//                    code, 1 on the fixed one. This is the duplicated brief
//                    from the ticket, reproduced.
//   exactly_once   — turns complete promptly. Reported for coverage but it does
//                    NOT discriminate: it passes on the unfixed code too,
//                    because the turn runs (and clears the insurance) before
//                    the recovery pass can misjudge it. Stated rather than
//                    quietly counted as a gate.
//   control_quit   — no live session at all: the same call MUST re-send. This
//                    is the must-FAIL-if-broken arm — it proves the rig can
//                    observe a recovery, so `deliveries === 1` in arm 1 is a
//                    real finding and not a rig that never recovers anything.
//   control_ran    — the prompt is in the transcript AND no session holds it
//                    (it ran, then the app quit): no resend, insurance cleared.
//                    Proves the pass still distinguishes "already done" from
//                    "lost", so control_quit's resend is a decision and not an
//                    unconditional replay of whatever is in the store.
//
// NOTE on a fourth combination deliberately NOT asserted as "must clear":
// live session + prompt already in the transcript. The guard keeps the entry
// there, because the live session is the authority on its own queue and clears
// it at its turn boundary (consume()'s `result` branch). Asserting a clear here
// would demand the recovery pass overrule a session about a prompt that session
// still holds — which is the exact confusion #112 is about.
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/e2e-spawn-prompt-duplication.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'exactly_once';

const ARMS = {
  // Turns COMPLETE, so a re-sent brief drains and shows up in `delivered`.
  // `expectPendingAfter: 0` because consume()'s `result` branch legitimately
  // clears the insurance once the turn has run.
  exactly_once: { liveSession: true, completeTurns: true, transcriptHasIt: false, expectDeliveries: 1, expectPendingAfter: 0 },
  control_quit: { liveSession: false, completeTurns: true, transcriptHasIt: false, expectDeliveries: 1, expectPendingAfter: 0 },
  control_ran:  { liveSession: false, completeTurns: true, transcriptHasIt: true,  expectDeliveries: 0, expectPendingAfter: 0 },
  // SLOW INIT: no turn ever completes, so the brief stays queued. Deliveries
  // cannot discriminate here (a parked duplicate is never yielded), so this arm
  // asserts on the INSURANCE instead: the entry must SURVIVE the recovery pass,
  // because the session has not run it and a quit now must still replay it.
  // The unfixed code cleared it — see the `slow_init` expectation below.
  slow_init:    { liveSession: true, completeTurns: false, transcriptHasIt: false, expectDeliveries: 1, expectPendingAfter: 1 },
};
const arm = ARMS[ARM];
if (!arm) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

const tmpHome = path.join(process.env.E2E_HOME ?? '/tmp/e2e-112', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
// THE OBSERVABLE. `sdkSend` emits one `user-message` AgentEvent per send, over
// `platform.broadcast('agent:event', …)` — that event IS the transcript bubble
// the user sees, so counting it answers "how many times was the brief
// delivered?" directly.
//
// ⚠️ Two earlier observables were VACUOUS and are recorded here so they are not
// re-tried: (1) counting prompts YIELDED to the SDK iterator misses a duplicate
// that parks at the turn gate during slow init — it is never yielded; and (2)
// counting `ws.sdkPendingPrompts` misses it too, because the resend re-appends
// a fresh entry, restoring the count to 1. Both made every arm pass on the
// UNFIXED code.
const userMessages = [];
initPlatform({
  kind: 'headless-e2e-112',
  broadcast: (channel, _wsId, event) => {
    if (channel === 'agent:event' && event?.type === 'user-message') userMessages.push(event);
  },
  broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e112', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-112-subject';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'spawned-agent', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(), hasInput: false,
});

// The spawn brief — the thing that must arrive exactly once.
const BRIEF = 'BRIEF-112: review PR 1566 and report the import-builder findings.';

// Every prompt the session actually receives.
const delivered = [];
sdk.__setQueryFactoryForTests(({ prompt }) => {
  void (async () => {
    try {
      for await (const m of prompt) {
        const txt = JSON.stringify(m?.message?.content ?? '');
        if (txt.includes('BRIEF-112')) delivered.push(txt);
      }
    } catch { /* torn down; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 's112', tools: [], slash_commands: [] };
      // A `result` per turn, so a queued prompt actually DRAINS and a duplicate
      // becomes observable in `delivered`.
      //
      // ⚠️ This is load-bearing rig design, learned the hard way: the first cut
      // never yielded a result, so `promptStream` parked at its turn gate and a
      // re-sent brief sat in `session.queue` forever, invisible to the counter.
      // Every arm then passed on the UNFIXED code — a vacuous rig. The field
      // behaviour it was failing to model is exactly what workspace c4a7c3e8
      // did: the duplicate DID eventually run (15 min later), producing a
      // second PR. `results_gated` below reproduces the slow-init variant
      // separately, and asserts on the QUEUE rather than on deliveries.
      if (arm.completeTurns) {
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 120));
          yield { type: 'result', subtype: 'success', session_id: 's112', is_error: false,
                  num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `done ${i}` };
        }
      }
      await new Promise(() => {});
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

const keepalive = setInterval(() => {}, 250);

// ── Step 1: the spawn sends the brief (startWorkspaceAgentHeadless's path) ──
if (arm.liveSession) {
  await sdk.sdkWake(WS_ID, BRIEF);
} else {
  // control_quit: simulate "sent in a PREVIOUS app run, then quit" — the store
  // carries the insurance but no session exists in THIS process.
  const { pendingPromptKey } = await import(`${REPO}/src/shared/pending-prompts.ts`);
  const ws = store.getWorkspace(WS_ID);
  await store.upsertWorkspace({
    ...ws,
    sdkPendingPrompts: [{ id: 'dead-session-uuid-0000', key: pendingPromptKey({ text: BRIEF }), text: BRIEF }],
  });
}
await new Promise((r) => setTimeout(r, 300));

const briefBubbles = () =>
  userMessages.filter((e) => JSON.stringify(e.text ?? e).includes('BRIEF-112')).length;
const deliveriesAfterSend = briefBubbles();
const pendingAfterSend = (store.getWorkspace(WS_ID)?.sdkPendingPrompts ?? []).length;

// ── Step 2: the pane mounts -> agentSdkHistory -> recoverPendingPrompts ────
// `history` is EMPTY: the CLI has not written the user line yet (slow init).
// In control_ran the transcript DOES carry it, as it would after the turn ran.
const history = arm.transcriptHasIt
  ? [{ type: 'user-message', seq: 1, at: Date.now(), text: BRIEF }]
  : [];
await sdk.recoverPendingPrompts(WS_ID, history);
await new Promise((r) => setTimeout(r, 400));

clearInterval(keepalive);

const deliveries = briefBubbles();
// Cross-check against the prompts the SDK iterator actually received. They can
// legitimately differ (a parked duplicate is echoed but not yet yielded), so
// this is reported, never asserted — it is what exposed observable (1) above.
const yieldedToSdk = delivered.length;
const pendingAfter = (store.getWorkspace(WS_ID)?.sdkPendingPrompts ?? []).length;

// The rig must have actually SENT something in the arms that send, or a
// `deliveries === 1` below would be measuring a dead channel.
const sendChannelProven = arm.liveSession ? deliveriesAfterSend === 1 : deliveriesAfterSend === 0;

const ok =
  sendChannelProven &&
  deliveries === arm.expectDeliveries &&
  pendingAfter === arm.expectPendingAfter;

console.log(JSON.stringify({
  arm: ARM, ok,
  deliveriesAfterSend, deliveriesAfterRecovery: deliveries,
  expectedDeliveries: arm.expectDeliveries,
  pendingAfterSend, pendingAfterRecovery: pendingAfter,
  expectedPendingAfter: arm.expectPendingAfter,
  sendChannelProven, yieldedToSdk,
}));
process.exit(ok ? 0 : 1);
