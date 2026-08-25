// Issue #90 — REPRODUCTION of the session wedge, and the recovery gate.
//
// Drives the REAL `promptStream` / `consume` / `sdkSendAwaitingStart` in
// `src/main/agent-sdk.ts` — not a model of them — through the repo's own
// `__setQueryFactoryForTests` seam (the same seam scripts/e2e-r2-repro.mjs
// uses). The wedge is provoked AT THE BOUNDARY:
//
//     turn 1 is yielded  ->  the fake SDK stream emits assistant chatter
//                        ->  and then NEVER emits a `result`
//
// `consume()` releases `session.turnGate` in exactly one place — the
// `msg.type === 'result'` branch — so the generator parks at
// `await turnInFlight` forever. Every later send is then silently no-op'd
// (`session.pump` is null because the generator is at the GATE, not the pump)
// and `sdkDeliverConfirmed` times out and withdraws the turn unstarted, which
// is the exact field signature from 2026-08-25.
//
// Arms (run ONE per process — module state is global):
//   wedged        — the defect. Second delivery must NOT start. (On the UNFIXED
//                   build this is the bug; on the fixed build it is still the
//                   pre-state, because the watchdog needs two observations.)
//   recovered     — wedged, then the watchdog's gate release runs. The parked
//                   turn must ACTUALLY START and be CONSUMED by a real turn.
//   control_healthy — the SAME rig, but turn 1 gets its `result`. The second
//                   delivery must start on its own. Proves the rig can observe
//                   a start at all, so a `started:false` elsewhere is a real
//                   finding rather than a dead instrument.
//   control_busy  — turn 1 keeps EMITTING (no result, but constant stream
//                   activity). The gate release must REFUSE — this is the
//                   slow-but-live turn that a duration bound would wrongly cut
//                   off, and the negative arm the ticket demands.
//
// Prints one JSON line. `started` is read from the delivery outcome that
// `dispatchMessageRequest` itself branches on, never from a spy.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'wedged';

const ARMS = {
  wedged: { emitResult: false, keepEmitting: false, release: false, expectStarted: false },
  recovered: { emitResult: false, keepEmitting: false, release: true, expectStarted: true },
  control_healthy: { emitResult: true, keepEmitting: false, release: false, expectStarted: true },
  control_busy: { emitResult: false, keepEmitting: true, release: true, expectStarted: false },
  // The arm that actually EXERCISES the per-message progress stamp. control_busy
  // alone cannot: it is never backdated, so it is refused on the wall-clock
  // bound whether or not the stamp is refreshed, and a mutant that deletes the
  // stamp SURVIVES it. Here the stamp is backdated FIRST and the turn then keeps
  // emitting; only a live progress stamp can push lastStreamAt back inside the
  // window, so this arm fails the instant the stamp stops being written.
  busy_backdated: { emitResult: false, keepEmitting: true, release: true, backdateFirst: true, expectStarted: false },
};
const arm = ARMS[ARM];
if (!arm) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}

// ── isolate all on-disk state before anything imports the store ─────────────
// HOME as well as ORCHESTRA_HOME: the inbox root keys off os.homedir(), NOT
// ORCHESTRA_HOME, so a rig that overrides only the latter reads the real
// user's inbox.
const tmpHome = path.join(process.env.WEDGE_HOME ?? '/tmp/wedge90-home', ARM);
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-wedge90',
  broadcast: () => {},
  broadcastPtyData: () => {},
  canBroadcast: () => true,
  isFocused: () => false,
  hasAttachedUi: () => false,
  notify: () => {},
  openExternal: () => {},
  showItemInFolder: () => {},
  openPath: () => {},
  openAccountLoginUrl: () => {},
  closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome,
  getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-wedge90',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-wedge90';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID,
  name: 'wedge90-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome,
  status: 'idle',
  createdAt: Date.now(),
  hasInput: true,
});

const INIT = { type: 'system', subtype: 'init', session_id: 'wedge90', tools: [], slash_commands: [] };
const CHATTER = {
  type: 'assistant',
  session_id: 'wedge90',
  message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] },
};
const RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 'wedge90',
  is_error: false,
  num_turns: 1,
  duration_ms: 5,
  total_cost_usd: 0,
  result: 'done',
};

let emitted = 0;
let stop = false;

sdk.__setQueryFactoryForTests(({ prompt }) => {
  // Drain the PROMPT generator — this is the side the wedge lives on. Every
  // turn the generator yields is counted; that count IS the observable "did a
  // turn actually start".
  const yielded = [];
  globalThis.__wedgeYielded = yielded;
  void (async () => {
    try {
      if (prompt && typeof prompt === 'object' && Symbol.asyncIterator in prompt) {
        for await (const m of prompt) {
          yielded.push(m?.uuid ?? '(no-uuid)');
        }
      }
    } catch { /* torn down under us; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield INIT;
      await new Promise((r) => setImmediate(r));
      if (arm.emitResult) {
        // HEALTHY: supply a full turn's worth of messages for EVERY turn the
        // generator yields, exactly as a real SDK does. Supplying only ONE
        // turn's worth and then parking (an earlier version of this rig) left
        // the session in a re-armed state that READ as `gateHeld:true` and
        // made this control fail while the product was fine — the rig was the
        // defect, not the code. Recorded so it is not re-derived.
        for (let turn = 0; turn < 4; turn++) {
          yield { ...CHATTER, message: { role: 'assistant', content: [{ type: 'text', text: `working ${turn}` }] } };
          await new Promise((r) => setImmediate(r));
          yield { ...RESULT, result: `done ${turn}` };
          await new Promise((r) => setTimeout(r, 80));
        }
      } else {
        yield CHATTER;
        await new Promise((r) => setImmediate(r));
      }
      if (arm.keepEmitting) {
        // The slow-but-live turn: never a `result`, but constant progress.
        while (!stop) {
          yield { ...CHATTER, message: { role: 'assistant', content: [{ type: 'text', text: `tick ${++emitted}` }] } };
          await new Promise((r) => setTimeout(r, 40));
        }
      }
      // Park forever so the stream does NOT end — a stream that ENDS drops
      // consume() into its finally, which releases the gate and would recover
      // the session for the wrong reason. The wedge is a LIVE session that
      // stops starting turns, so the stream must stay open.
      await new Promise(() => {});
    },
    interrupt: async () => { stop = true; },
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
  };
});

// Keepalive: `sdkSendAwaitingStart`'s timeout is `unref`'d (agent-sdk.ts), so
// in a bare rig with no other handles the process would EXIT before the
// timeout fires and the arm would print nothing — a silent null that reads
// like a crash. This ref'd timer holds the loop open for the rig's lifetime.
const keepalive = setInterval(() => {}, 250);

// ── turn 1: starts the session and occupies the gate ────────────────────────
await sdk.sdkSend(WS_ID, 'turn one — occupies the gate');
await new Promise((r) => setTimeout(r, 400));

const probeBefore = sdk.sdkGateProbe(WS_ID);
const yielded1 = (globalThis.__wedgeYielded ?? []).length;

// ── the WEDGE observable: a second delivery, through the SAME confirmed-start
//    path dispatchMessageRequest uses. A short timeout keeps the rig fast; the
//    semantics are identical to DELIVERY_START_TIMEOUT_MS.
const deliveryP = sdk.sdkSendAwaitingStart(WS_ID, 'turn two — the parked message', undefined, 1500);

// ── the watchdog's gate release, if this arm asks for it ────────────────────
let released = null;
if (arm.release) {
  await new Promise((r) => setTimeout(r, 300));
  // Two observations of the SAME turn, exactly as watchdogTick does. The
  // silence window is passed as 0 via a direct decideGateRelease check in the
  // unit tests; here we exercise the REAL sdkReleaseStrandedGate, so we back
  // date the stream stamp to simulate the elapsed silence rather than waiting
  // out ten real minutes.
  // Backdate ONLY when the arm is modelling silence. `control_busy` is the
  // slow-but-live turn, and backdating it would overwrite the very progress
  // stamp that arm exists to test — the rig would then be asserting against a
  // subject it had itself destroyed. (Caught by control_busy releasing the
  // gate when it must refuse; see the ledger's instrument-audit note.)
  if (arm.backdateFirst) {
    // Backdate, then let the still-emitting turn refresh the stamp on its own.
    sdk.__backdateStreamForTests?.(WS_ID, 11 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 200));
  } else if (!arm.keepEmitting) {
    sdk.__backdateStreamForTests?.(WS_ID, 11 * 60 * 1000);
  }
  released = sdk.sdkReleaseStrandedGate(WS_ID, probeBefore?.turnUuid ?? null);
}

const outcome = await deliveryP;
await new Promise((r) => setTimeout(r, 400));

const yielded2 = (globalThis.__wedgeYielded ?? []).length;
const started = outcome === 'started';
// CONSUMED, not merely sent: the generator must have YIELDED a second turn to
// the SDK. `started` alone is the delivery receipt; this is the turn itself.
const consumedSecondTurn = yielded2 > yielded1;

stop = true;
clearInterval(keepalive);
console.log(
  JSON.stringify({
    arm: ARM,
    outcome,
    started,
    expectStarted: arm.expectStarted,
    ok: started === arm.expectStarted,
    gateReleased: released,
    turnsYieldedBefore: yielded1,
    turnsYieldedAfter: yielded2,
    consumedSecondTurn,
    gateHeldBefore: probeBefore?.gateHeld ?? null,
    queuedAtProbe: probeBefore?.queuedCount ?? null,
  }),
);
process.exit(0);
