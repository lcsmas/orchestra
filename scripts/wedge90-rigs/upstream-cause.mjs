// Issue #90 — ROOT-CAUSE INVESTIGATION: what upstream event ate the `result`?
//
// The wedge mechanism is proven (scripts/e2e-session-wedge.mjs): consume()
// releases `session.turnGate` in exactly ONE place — `msg.type === 'result'`.
// The UNEXPLAINED half is the trigger: on a LIVE session (control channel still
// answering, per the 2026-08-25 field capture), what makes a turn that was
// yielded never receive its `result`?
//
// The SDK's own contract (sdk.d.ts, SDKResultMessage jsdoc @ line ~4632):
//     "The CLI emits EXACTLY ONE result message per turn, after that turn's
//      assistant, user and stream_event messages; treat it as the
//      turn-complete signal."
// So a wedge is a CONTRACT VIOLATION — a turn ends or is abandoned without the
// one `result`. This rig enumerates the SDK message types that terminate or
// abandon a turn WITHOUT being `type:'result'`, drives EACH through the REAL
// consume()/promptStream()/gate, and classifies the outcome into two disjoint
// classes:
//
//   SELF-RECOVER — the trigger ENDS the stream, so consume()'s `finally` runs
//                  and releases the gate (`hadOpenTurn` branch). The next turn
//                  starts on its own. NOT a wedge. (`worker_shutting_down`,
//                  whose own emit-layer comment says "the consume loop's own
//                  finally emits the terminal turn-end".)
//
//   WEDGE        — the trigger leaves the stream OPEN (session stays live, its
//                  control channel keeps answering) but no `result` follows, so
//                  the gate is held forever. This is the field signature. The
//                  progress watchdog (layer 2) is the ONLY thing that recovers
//                  it, because it is CAUSE-AGNOSTIC — which is the whole reason
//                  layer 2 exists and the cause is recorded UNEXPLAINED.
//
// The point this rig PROVES (the failing-test naming of the root cause): the
// wedge is not one lost message but a CLASS — any turn-abandoning event that is
// not `type:'result'` and does not end the stream strands the gate. `conversation_reset`
// (type:'conversation_reset', UNHANDLED anywhere in agent-sdk.ts / the
// agent-events `switch (msg.type)`) is a concrete, in-tree instance: the CLI's
// "loop detected" reset (#90 body: "the 20:52 'loop detected' interplay")
// begins a NEW conversation, and the OLD turn's `result` for the reset
// conversation never arrives — yet the SDK query object stays live.
//
// Prints ONE JSON line per arm. An empty line is a FAILED run, never a pass.
//
// Arms (one per process — agent-sdk module state is global). Each arm's
// expectation reflects the SHIPPED behaviour; reverting the fix reddens the
// arms that depend on it (mutation-proof, see the rigs README):
//   reset          — mid-turn `conversation_reset` on a HELD gate. The #90 fix
//                    releases the gate here, so the next turn STARTS. Revert the
//                    fix and this reddens (classifies WEDGE) — the arm that
//                    proves the fix is load-bearing.
//   refusal        — mid-turn `model_refusal_no_fallback`, stream stays open.
//                    The fix does NOT touch this path, so it still STRANDS —
//                    the standing demonstration that the wedge is a CLASS and
//                    the fix is deliberately scoped to the one message where a
//                    result provably can never come (a reset defuncts the turn;
//                    a refusal is normally still followed by a `result`). Layer-2
//                    is what covers this and any other shape.
//   worker_exit    — mid-turn `worker_shutting_down`, then the stream ENDS.
//                    SELF-RECOVER (consume()'s finally releases the gate).
//   reset_recovered— reset with the watchdog ALSO invoked. With the fix the gate
//                    is already open before the watchdog runs; either way the
//                    next turn starts.
//   control_result — the SAME shape, but the turn DOES get its `result`. Healthy.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARM = process.argv[2] ?? 'reset';

// classification: which trigger message, does the stream stay open, and do we
// run the watchdog release afterward.
const ARMS = {
  // reset: the #90 fix releases the gate on conversation_reset, so the next turn
  // starts on its own with NO watchdog (expectWedge:false). Reverting the fix
  // makes this arm classify WEDGE — the mutation-proof that the fix matters.
  reset: { trigger: 'conversation_reset', endsStream: false, release: false, expectWedge: false },
  // refusal: fix does NOT touch this path — it still strands (the wedge CLASS).
  refusal: { trigger: 'model_refusal_no_fallback', endsStream: false, release: false, expectWedge: true },
  worker_exit: { trigger: 'worker_shutting_down', endsStream: true, release: false, expectWedge: false },
  reset_recovered: { trigger: 'conversation_reset', endsStream: false, release: true, expectWedge: false },
  control_result: { trigger: 'result', endsStream: false, release: false, expectWedge: false },
};
const arm = ARMS[ARM];
if (!arm) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}

const tmpHome = path.join(process.env.WEDGE_HOME ?? '/tmp/wedge90-upstream', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(`${tmpHome}/.orchestra/inbox`, { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-wedge90-upstream',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-wedge90-upstream', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-wedge90-upstream';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'wedge90-upstream', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(), hasInput: true,
});

const SID = 'wedge90-upstream';
const INIT = { type: 'system', subtype: 'init', session_id: SID, tools: [], slash_commands: [] };
const CHATTER = { type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] } };
const RESULT = { type: 'result', subtype: 'success', session_id: SID, is_error: false, num_turns: 1, duration_ms: 5, total_cost_usd: 0, result: 'done', stop_reason: 'end_turn', uuid: 'r-1' };

// The trigger messages, in the exact shapes sdk.d.ts documents.
const TRIGGERS = {
  conversation_reset: { type: 'conversation_reset', new_conversation_id: 'new-conv-1', uuid: 'cr-1', session_id: SID },
  model_refusal_no_fallback: { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-opus-4-8', request_id: null, content: 'I can’t help with that.', uuid: 'mr-1', session_id: SID },
  worker_shutting_down: { type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit', uuid: 'ws-1', session_id: SID },
  result: RESULT,
};

let stop = false;
const yielded = [];
globalThis.__wedgeYielded = yielded;

// Barrier: the trigger message under test must land WHILE turn 1's gate is
// genuinely held — i.e. AFTER the prompt generator has yielded turn 1. A fake
// SDK iterator that emits its messages independently of the prompt stream races
// the gate arm and can deliver the trigger BEFORE the gate is armed, which
// reads as a wedge for the wrong reason (and makes a gate-release mutant a
// no-op — the exact vacuity this barrier removes). We resolve `firstTurnSeen`
// the instant the drain loop observes turn 1, and the iterator awaits it.
let resolveFirstTurn;
const firstTurnSeen = new Promise((r) => { resolveFirstTurn = r; });

sdk.__setQueryFactoryForTests(({ prompt }) => {
  void (async () => {
    try {
      if (prompt && typeof prompt === 'object' && Symbol.asyncIterator in prompt) {
        for await (const m of prompt) {
          yielded.push(m?.uuid ?? '(no-uuid)');
          if (yielded.length === 1) resolveFirstTurn();
        }
      }
    } catch { /* torn down under us; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield INIT;
      await new Promise((r) => setImmediate(r));
      if (arm.trigger === 'result') {
        // CONTROL: the turn DOES get its `result`, exactly as the SDK contract
        // guarantees — and so does EVERY following turn. Supplying only ONE
        // turn's worth then parking would leave a re-armed state that reads as a
        // wedge on a HEALTHY build (the "full turn for every yield" trap). So
        // serve chatter+result per turn for the rig's whole life; the second
        // delivery then starts and is consumed on its own, with no watchdog.
        for (let turn = 0; turn < 4; turn++) {
          yield { ...CHATTER, message: { role: 'assistant', content: [{ type: 'text', text: `working ${turn}` }] } };
          await new Promise((r) => setImmediate(r));
          yield { ...RESULT, uuid: `r-${turn}`, result: `done ${turn}` };
          await new Promise((r) => setTimeout(r, 80));
        }
        await new Promise(() => {});
        return;
      }
      // A turn's worth of real chatter, THEN the trigger message under test —
      // but only once turn 1's gate is provably armed (see the barrier above),
      // so the trigger lands on a HELD gate exactly as in the field.
      yield CHATTER;
      await firstTurnSeen;
      await new Promise((r) => setImmediate(r));
      yield TRIGGERS[arm.trigger];
      await new Promise((r) => setImmediate(r));
      if (arm.endsStream) {
        // worker_shutting_down: the subprocess is going away — the iterator
        // returns, dropping consume() into its finally. That is the SELF-RECOVER
        // path; the field wedge is the OPPOSITE (a live, open stream).
        return;
      }
      // WEDGE shape: the session stays LIVE (a real SDK query keeps its control
      // channel up — reload-skills answered in the field), but this turn's
      // `result` never comes. Park the stream open forever.
      await new Promise(() => {});
    },
    interrupt: async () => { stop = true; },
    setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
  };
});

const keepalive = setInterval(() => {}, 250);

// turn 1: occupy the gate, then let the trigger land.
await sdk.sdkSend(WS_ID, 'turn one — occupies the gate, then the trigger fires');
await new Promise((r) => setTimeout(r, 500));

const probeAfterTrigger = sdk.sdkGateProbe(WS_ID);
const { sdkSessionLive } = await import(`${REPO}/src/main/sdk-delivery.ts`);
const liveAfterTrigger = sdkSessionLive(WS_ID);
const yielded1 = yielded.length;

// The WEDGE observable: a second delivery through the SAME confirmed-start path
// dispatchMessageRequest uses. It is issued FIRST so that, on the wedge arms,
// the turn parks in `session.queue` (queuedCount>0) — exactly the state the
// real watchdog fires in (decideGateRelease refuses on queuedCount<=0). The
// delivery's own outcome ('started' vs 'timeout') is the observable.
const deliveryP = sdk.sdkSendAwaitingStart(WS_ID, 'turn two — the parked message', undefined, 1500);

let released = null;
if (arm.release) {
  await new Promise((r) => setTimeout(r, 250));
  // Simulate the silence the watchdog bounds on (progress-based, not wall-clock)
  // — but only for the reset/refusal wedge shape, where the stream really did go
  // silent. The stamp is aged, not the constant shortened, so the SAME
  // comparison that ships runs here.
  sdk.__backdateStreamForTests?.(WS_ID, 11 * 60 * 1000);
  released = sdk.sdkReleaseStrandedGate(WS_ID, probeAfterTrigger?.turnUuid ?? null);
}

const outcome = await deliveryP;
await new Promise((r) => setTimeout(r, 400));
const yielded2 = yielded.length;
const secondTurnStarted = outcome === 'started';
const consumedSecondTurn = yielded2 > yielded1;

// CLASSIFICATION, read off REAL state (never a spy):
//   WEDGE        — the session is still LIVE, its gate was still held right after
//                  the trigger, and the second turn NEVER started on its own.
//   SELF-RECOVER — the trigger ended the stream, so consume()'s finally released
//                  the gate; the session is no longer live and nothing is
//                  stranded. (worker_shutting_down.)
const isWedge = liveAfterTrigger && (probeAfterTrigger?.gateHeld ?? false) && !secondTurnStarted;
const selfRecovered = !liveAfterTrigger; // finally tore the session down

let ok;
if (arm.release) {
  // Recovery must happen — the second turn MUST start. With the #90 fix the
  // gate is released on the reset before the watchdog even runs (so
  // `released` is false: nothing left to force-release); without the fix the
  // watchdog's force-release is what recovers it (`released` true). Either way
  // the load-bearing observable is that the parked turn STARTED.
  ok = secondTurnStarted === true;
} else if (arm.trigger === 'worker_shutting_down') {
  // SELF-RECOVER: the stream ended, the session is gone, the gate is not
  // stranded on a live session. (A second turn cannot "start" — there is no
  // session to start it — so the pass is the finally having fired.)
  ok = selfRecovered === true;
} else if (arm.expectWedge) {
  // reset / refusal: the standing wedge must be reproduced.
  ok = isWedge === true;
} else {
  // control_result: the SDK contract is honoured; the second turn starts itself.
  ok = secondTurnStarted === true && isWedge === false;
}

stop = true;
clearInterval(keepalive);
console.log(
  JSON.stringify({
    arm: ARM,
    trigger: arm.trigger,
    liveAfterTrigger,
    gateHeldAfterTrigger: probeAfterTrigger?.gateHeld ?? null,
    gateTurnUuid: probeAfterTrigger?.turnUuid ?? null,
    secondTurnStarted,
    consumedSecondTurn,
    gateReleasedByWatchdog: released,
    selfRecovered,
    classified: selfRecovered ? 'SELF-RECOVER' : isWedge ? 'WEDGE' : 'RECOVERED-OR-HEALTHY',
    expectWedge: arm.expectWedge,
    ok,
    turnsYieldedBefore: yielded1,
    turnsYieldedAfter: yielded2,
  }),
);
process.exit(0);
