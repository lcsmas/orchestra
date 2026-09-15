// #144 G6 — THE CANARY REPLAY, at the wake layer.
//
// The first canary (ledger #143 §Canary, rows 444–448) sent member mail by the
// 8-char handle (`orchestra send --to 0a5c25bb …`). The bus stored
// `recipient='0a5c25bb'`; the wake predicate compares against the reader's FULL
// uuid, so the row never matched and the OPS was NEVER woken. Full-uuid probes
// (443, 450) woke it in ~40 s.
//
// This rig drives the REAL sweep (`sweepBusWake` → the production
// `sdkStartAndDeliver` delivery seam → a real structured session) against a real
// SQLite bus, and counts the `user-message` AgentEvents the reader's transcript
// would render — the SAME observable #117's e2e uses, deliberately not the
// ledger/predicate/return-value (all bookkeeping the wake code itself writes;
// #112 burned two such observables, both failing in the passing direction).
//
// TWO ARMS, both required:
//   short  ★ THE MUST-FAIL / CANARY arm. The recipient is stored as the 8-char
//            SHORT handle while the reader is identified by its FULL uuid → the
//            reader is NEVER woken (expectTurns 0). This is the exact rows
//            444–448 symptom. On an UNFIXED build a `send --to 0a5c25bb` stores
//            this short handle, so this is the state the fix prevents upstream.
//   full   ★ THE HEADLINE. The recipient is the canonicalized FULL id (what
//            #144's `send` now writes) → the reader IS woken within ONE sweep
//            (expectTurns 1). Same command shape as `short`, so the rig is proven
//            able to say YES here — without which "0 turns" for `short` would
//            pass on a rig that renders nothing at all.
//
// The discriminator between the arms is ONLY the recipient value (short vs full);
// everything else is identical. So a build whose wake predicate ignored the
// recipient would wake on BOTH (short fails) and a build that never wakes would
// wake on NEITHER (full fails). Only the correct full-id comparison passes both.
//
// Runs on system-node ABI for the fast suite; VERIFY-G runs the packaged variant
// (the packaged CLI's `send` doing the canonicalization end-to-end on the
// Electron ABI) — see scripts/verify-canary-replay-144.sh.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2];

// The reader is a FULL uuid (what an OPS actually is on the wake predicate).
const READER_FULL = 'b3f55639-1d61-4d21-b6bf-0d701445dc12';
const READER_SHORT = 'b3f55639'; // the 8-char handle the fleet types
const RUN = 'run-144-canary';
const BODY = 'MEMBER-REPORT-144-4c9a1f';

const ARMS = {
  // recipient stored = the SHORT handle; reader = FULL uuid → never woken.
  short: { storedRecipient: READER_SHORT, expectTurns: 0 },
  // recipient stored = the canonicalized FULL id → woken within one sweep.
  full: { storedRecipient: READER_FULL, expectTurns: 1 },
};
const arm = ARMS[ARM];
if (!arm) {
  console.error(`unknown arm: ${ARM} (one of: ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

const tmpHome = path.join(process.env.E2E_HOME ?? '/tmp/canary-144', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);

const userMessages = [];
initPlatform({
  kind: 'headless-canary-144',
  broadcast: (channel, _wsId, event) => {
    if (channel === 'agent:event' && event?.type === 'user-message') userMessages.push(event);
  },
  broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-canary144', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const busMod = await import(`${REPO}/src/main/bus.ts`);
const wake = await import(`${REPO}/src/main/bus-wake.ts`);
const { isWakeOrder } = await import(`${REPO}/src/shared/bus-wake.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);

await store.load?.();
await store.upsertWorkspace({
  id: READER_FULL, name: 'ops-reader', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(), hasInput: false,
});

// A stub CLI that yields a `result` per turn so a queued prompt drains and any
// duplicate would surface as a second bubble (#112's rig-design lesson).
sdk.__setQueryFactoryForTests(() => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'system', subtype: 'init', session_id: 's144', tools: [], slash_commands: [] };
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 100));
      yield { type: 'result', subtype: 'success', session_id: 's144', is_error: false,
              num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `done ${i}` };
    }
    await new Promise(() => {});
  },
  interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
  mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
  getContextUsage: async () => { await new Promise(() => {}); },
}));

const keepalive = setInterval(() => {}, 250);

// Wire the wake exactly as index.ts does — production seams, not stubs.
const db = busMod.openBus(path.join(tmpHome, '.orchestra', 'bus.sqlite'));
wake.__resetBusWakeForTests();
wake.__setBusReaderForTests(() => db);
// The roster carries the reader by its FULL id — the identity the production
// path uses. The wake predicate then compares this against `messages.recipient`.
wake.setWakeRoster(() => [{ reader: READER_FULL, wakeable: true, runId: RUN }]);
wake.setWakeDeliver((wsId, text) => delivery.sdkStartAndDeliver(wsId, text));
// The `wake` switch is ON for this run — we are testing the RECIPIENT match, not
// the switch (that is #117's e2e). If the switch were the variable, both arms
// would move together and neither would isolate the canary.
wake.__freezeSwitchForTests((runId) => runId === RUN);

const orderTurns = () =>
  userMessages.filter((e) => isWakeOrder(String(e.text ?? ''))).length;

// THE ONE VARIABLE: what recipient the row carries. `short` = the canary's
// pre-fix stored handle; `full` = the canonicalized id #144 now writes.
busMod.send(db, { runId: RUN, sender: 'member', kind: 'dispatch', body: BODY, recipient: arm.storedRecipient });

// One sweep — the canary requirement is "wakes within ONE sweep".
await wake.sweepBusWake();
await new Promise((r) => setTimeout(r, 300));

const turns = orderTurns();
clearInterval(keepalive);

const ok = turns === arm.expectTurns;
const payload = JSON.stringify({
  arm: ARM,
  storedRecipient: arm.storedRecipient,
  reader: READER_FULL,
  turns,
  expectTurns: arm.expectTurns,
  ok,
});
console.log(payload);
try { db.close(); } catch { /* ignore */ }
process.exit(ok ? 0 : 1);
