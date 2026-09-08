// Issue #117 — a bus insert must produce ONE real turn carrying the ORDER.
//
// Drives the REAL sweep against a REAL SQLite bus and a REAL structured session
// (`sdkStartAndDeliver` -> `sdkWake` -> `sdkSend`), with a stub CLI standing in
// for the Claude binary. Everything between the insert and the rendered turn is
// production code.
//
// ── THE OBSERVABLE, and why it is this one ─────────────────────────────────
//
// The count is `user-message` AgentEvents broadcast on `agent:event`. That event
// IS the transcript bubble the reader's human sees, so counting it answers "did
// a turn carrying the order actually appear?" directly.
//
// It is deliberately NOT the wake ledger, NOT the pending predicate, and NOT the
// delivery seam's own return value — all three are bookkeeping #117's code
// writes, so a bug in the dedup would move them together and every arm would
// stay green. #112 burned two observables exactly this way (prompts YIELDED to
// the SDK miss a parked duplicate; the store's pending list is restored by the
// resend's re-append), and both failures were in the PASSING direction.
//
// ── Arms ───────────────────────────────────────────────────────────────────
//   fires          ★ switch ON, one insert -> exactly 1 turn carrying the order
//                    and NOT the body. The headline claim.
//   switch_off     ★ THE MUST-FAIL ARM. Same insert, switch OFF -> 0 turns AND
//                    counted === 1. Asserting only "0 turns" would pass on a
//                    build with no wake code at all.
//   coalesce       ★ 3 inserts across 3 sweeps while the reader never acks ->
//                    exactly 1 turn. The literal 1, not "at least one".
//   ack_clears     — reader checks + acks, then 5 more sweeps -> still 1 turn.
//                    A bounded drive-until-or-fail, never sleep-then-read.
//   control_second — proves the RIG CAN see a second turn: after an ack, NEW
//                    mail must produce turn #2. Without this, `coalesce`'s
//                    "exactly 1" would also pass on a rig that renders nothing
//                    after the first, and every arm above would be vacuous.
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/e2e-bus-wake.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'fires';

const ARMS = {
  fires:          { switchOn: true,  inserts: 1, ack: false, newMailAfterAck: false, expectTurns: 1, expectCounted: 0 },
  switch_off:     { switchOn: false, inserts: 1, ack: false, newMailAfterAck: false, expectTurns: 0, expectCounted: 1 },
  coalesce:       { switchOn: true,  inserts: 3, ack: false, newMailAfterAck: false, expectTurns: 1, expectCounted: 0 },
  ack_clears:     { switchOn: true,  inserts: 1, ack: true,  newMailAfterAck: false, expectTurns: 1, expectCounted: 0 },
  control_second: { switchOn: true,  inserts: 1, ack: true,  newMailAfterAck: true,  expectTurns: 2, expectCounted: 0 },
  // ★ THE ARM THAT PROVES THE ACK IS THE READER'S. `check` WITHOUT `ack`, then
  // more sweeps: the lot is TAKEN but not READ, so pending must NOT clear and
  // the reader must be woken again. Added because a mutant reading the cursor
  // from `deliveries.to_seq` instead of `cursors.acked_seq` — i.e. the host
  // treating its own hand-off as the reader's confirmation, the exact lying
  // "Delivered" the bus exists to kill — SURVIVED every other arm in this file.
  // The dedup ledger masks it everywhere else: the reader is already marked, so
  // "no second wake" looks identical whether pending cleared correctly or not.
  // Here the ledger is cleared by an ack that never happened, so the two
  // behaviours finally differ.
  check_no_ack:   { switchOn: true,  inserts: 1, ack: false, checkOnly: true, newMailAfterAck: false, expectTurns: 2, expectCounted: 0 },
};
const arm = ARMS[ARM];
if (!arm) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

const tmpHome = path.join(process.env.E2E_HOME ?? '/tmp/e2e-117', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);

const userMessages = [];
initPlatform({
  kind: 'headless-e2e-117',
  broadcast: (channel, _wsId, event) => {
    if (channel === 'agent:event' && event?.type === 'user-message') userMessages.push(event);
  },
  broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e117', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const busMod = await import(`${REPO}/src/main/bus.ts`);
const wake = await import(`${REPO}/src/main/bus-wake.ts`);
const { WAKE_ORDER, isWakeOrder } = await import(`${REPO}/src/shared/bus-wake.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);

const WS_ID = 'ws-117-reader';
const RUN = 'run-117';
// A body that could not appear by accident — T117.5 greps for it.
const BODY = 'SECRET-BODY-117-9f3ac2';

await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'bus-reader', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(), hasInput: false,
});

// The stub CLI. Yields a `result` per turn so a queued prompt actually drains
// and a duplicate would become visible as a second bubble — the rig-design
// lesson from #112, where a never-resulting stub parked every duplicate at the
// turn gate and made every arm pass on unfixed code.
const yielded = [];
sdk.__setQueryFactoryForTests(({ prompt }) => {
  void (async () => {
    try {
      for await (const m of prompt) yielded.push(JSON.stringify(m?.message?.content ?? ''));
    } catch { /* torn down; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 's117', tools: [], slash_commands: [] };
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 100));
        yield { type: 'result', subtype: 'success', session_id: 's117', is_error: false,
                num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `done ${i}` };
      }
      await new Promise(() => {});
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

const keepalive = setInterval(() => {}, 250);

// ── Wire the wake exactly as index.ts does — production seams, not stubs ────
const db = busMod.openBus(path.join(tmpHome, '.orchestra', 'bus.sqlite'));
wake.__resetBusWakeForTests();
wake.__setBusReaderForTests(() => db);
wake.setWakeRoster(() => [{ reader: WS_ID, wakeable: true, runId: RUN }]);
// THE PRODUCTION DELIVERY PATH: the same call index.ts:423 makes.
wake.setWakeDeliver((wsId, text) => delivery.sdkStartAndDeliver(wsId, text));
// The switch is read PER RUN (ledger #123 Q1), so the rig supplies an accessor
// keyed on the run — the same shape #118's storage will provide.
wake.__freezeSwitchForTests((runId) => runId === RUN && arm.switchOn);

const orderTurns = () =>
  userMessages.filter((e) => isWakeOrder(String(e.text ?? ''))).length;
const bodyLeaks = () =>
  userMessages.filter((e) => String(e.text ?? '').includes(BODY)).length;

const insert = (body) =>
  busMod.send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body, recipient: WS_ID });

// ── Drive ──────────────────────────────────────────────────────────────────
for (let i = 0; i < arm.inserts; i++) {
  insert(`${BODY} #${i}`);
  await wake.sweepBusWake();
  await new Promise((r) => setTimeout(r, 250));
}

const turnsAfterInserts = orderTurns();

if (arm.checkOnly) {
  // The reader TAKES its lot and then dies before acking (SIGKILL between check
  // and ack — spike #109 arm 2's case). Nothing acked it, so the host must wake
  // it again rather than treating the hand-off as a read.
  const lot = busMod.check(db, RUN, WS_ID);
  if (!lot.delivery) { console.error('rig fault: no lot to take'); process.exit(2); }
  // Clear the in-memory dedup mark, as an app restart would: this is what makes
  // the DURABLE pending state — not the ledger — the thing under test.
  wake.__resetBusWakeForTests();
  wake.__setBusReaderForTests(() => db);
  wake.setWakeRoster(() => [{ reader: WS_ID, wakeable: true, runId: RUN }]);
  wake.setWakeDeliver((wsId, text) => delivery.sdkStartAndDeliver(wsId, text));
  wake.__freezeSwitchForTests((runId) => runId === RUN && arm.switchOn);
  await wake.sweepBusWake();
  await new Promise((r) => setTimeout(r, 400));
}

if (arm.ack) {
  // The reader obeys its order, as the CLI's `orchestra check` + `orchestra ack`
  // would. The ack is the READER's — nothing here acks on its behalf.
  const lot = busMod.check(db, RUN, WS_ID);
  if (!lot.delivery) { console.error('rig fault: no lot to ack'); process.exit(2); }
  busMod.ack(db, RUN, WS_ID, lot.delivery.id);
  // Bounded drive-until-or-fail: sweep repeatedly and require the count to hold.
  for (let i = 0; i < 5; i++) {
    await wake.sweepBusWake();
    await new Promise((r) => setTimeout(r, 120));
  }
}

if (arm.newMailAfterAck) {
  insert(`${BODY} POST-ACK`);
  await wake.sweepBusWake();
  await new Promise((r) => setTimeout(r, 400));
}

clearInterval(keepalive);

const turns = orderTurns();
const counters = wake.busWakeCounters();
const leaks = bodyLeaks();

// The rig must be capable of rendering a turn at all, or `turns === 0` in the
// switch_off arm would be measuring a dead channel rather than the switch.
// Proven by control_second (2 turns) and fires (1 turn) in the same matrix.
const ok =
  turns === arm.expectTurns &&
  counters.counted === arm.expectCounted &&
  leaks === 0 &&
  // In check_no_ack the counters were deliberately reset mid-arm (simulating a
  // restart), so only the TURN count is meaningful there — and the turn count is
  // the observable this rig exists to trust.
  (arm.expectTurns === 0 || arm.checkOnly || counters.fired === arm.expectTurns);

console.log(JSON.stringify({
  arm: ARM, ok,
  turnsCarryingOrder: turns, expectedTurns: arm.expectTurns,
  turnsAfterInserts,
  bodyLeaks: leaks,
  counters,
  expectedCounted: arm.expectCounted,
  order: WAKE_ORDER,
  yieldedToSdk: yielded.length,
  totalUserMessages: userMessages.length,
}));
process.exit(ok ? 0 : 1);
