// D2 (S2) + D3-decision (S3) — the stop→restart seam, executed against the REAL
// agent-sdk.ts (consume() / sdkStop / the `sessions` map) with a queryOverride
// stub CLI and a real store. No built app, no real keeper — this rig owns the
// IN-MEMORY seam; the real-keeper KILL AUTHORITY that S3 depends on is proven
// separately by src/main/stop-semantics.test.ts (and by the /clear arm of
// scripts/verify-keeper-detach.mjs).
//
// ── Why this layer ───────────────────────────────────────────────────────────
// Both defects are compositional, not pure-function:
//   D2 lives in consume()'s `finally`, which deletes `sessions[wsId]` by KEY.
//       After sdkStop removes session A, a restart registers session B; A's
//       still-unwinding consume loop then evicts B — so B keeps running but
//       sdkHasSession reads false and every peer delivery returns 'none'.
//   D3 lives in sdkStop: a CLI that has produced no `result` cannot be stopped
//       gracefully (the SDK never ends stdin, interrupt() is unserviced), so
//       nothing reaches the keeper. The fix falls through to killKeeper.
// Only driving the real consume()/sdkStop over the real map exercises either.
//
// ── Arms ─────────────────────────────────────────────────────────────────────
//   s2_successor   ★ THE S2 DISCRIMINATOR. Start A, sdkStop(A), start B, then
//                    end A's iterator so A's finally runs LAST. FIXED: B
//                    survives (sdkHasSession true, delivery 'started'). UNFIXED:
//                    A's finally deletes B by key (sdkHasSession false,
//                    delivery 'none'). MEASURED: hasSession true/started fixed,
//                    false/none unfixed.
//   s2_sole_dies   — CONTROL that the rig can OBSERVE a deletion: a lone
//                    session whose loop ends MUST leave sdkHasSession false.
//                    Proves s2_successor's `true` is a real survival, not a rig
//                    that never tears anything down. Identical on fixed/unfixed.
//   s3_no_result   ★ THE S3 DISCRIMINATOR. A session that never emitted a
//                    `result`, then sdkStop. FIXED: the killKeeper fall-through
//                    fires (spy invoked exactly once). UNFIXED: never invoked —
//                    the CLI is left alive in a since-removed worktree.
//   s3_with_result — CONTROL: a session that DID emit a result must NOT trigger
//                    the fall-through kill (the graceful close alone flushes the
//                    transcript). Proves s3_no_result's kill is keyed on the
//                    first-result flag and not fired unconditionally. The kill
//                    spy must be invoked 0 times here on BOTH builds.
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/e2e-stop-semantics.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 's2_successor';

const ARMS = {
  s2_successor: {},
  s2_sole_dies: {},
  s3_no_result: {},
  s3_with_result: {},
};
if (!(ARM in ARMS)) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}

const tmpHome = path.join(process.env.E2E_HOME ?? '/tmp/e2e-stop-semantics', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-stop-semantics',
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
  getAppVersion: () => '0.0.0-e2e-stop',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
// sdkDeliverConfirmed lives in sdk-delivery.ts; agent-sdk.ts registers the impl
// at import (registerSdkDelivery), so it is wired by the time we call it.
const { sdkDeliverConfirmed } = await import(`${REPO}/src/main/sdk-delivery.ts`);

const WS_ID = 'ws-stop-semantics';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID,
  name: 'stop-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome,
  status: 'idle',
  createdAt: Date.now(),
  hasInput: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepalive = setInterval(() => {}, 250);

// ─────────────────────────────────────────────────────────────────────────────
// A queryOverride whose per-ensureSession iterator is controllable. Each call
// returns a fresh "CLI". `endSignals[n]` is resolved by the rig to make the
// n-th iterator RETURN (ending consume() and running its finally). Iterators
// emit a `result` per queued turn only when `emitResults` is set, so a delivered
// turn actually STARTS and drains.
// ─────────────────────────────────────────────────────────────────────────────
let callIndex = 0;
const iterState = [];

function makeQuery(emitResults, { prompt }) {
  const idx = callIndex++;
  let releaseEnd;
  const ended = new Promise((r) => (releaseEnd = r));
  const st = { idx, releaseEnd, turns: 0 };
  iterState[idx] = st;
  // DRAIN the prompt stream. The SDK pulls from `options.prompt`
  // (Orchestra's promptStream) at its own pace; a stub that ignores it strands
  // the generator at its first yield, so no queued delivery ever STARTS. This
  // background drain is what lets a peer delivery reach 'started'. (Learned from
  // scripts/e2e-spawn-prompt-duplication.mjs.)
  const seenTurns = [];
  void (async () => {
    try {
      for await (const m of prompt) {
        seenTurns.push(m);
        st.turns++;
      }
    } catch {
      /* torn down; expected */
    }
  })();
  st.seenTurns = seenTurns;
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: `sess-${idx}`, tools: [], slash_commands: [] };
      if (emitResults) {
        // A `result` per ~60 ms keeps the turn gate open so each queued turn
        // drains and its delivery watcher settles 'started'.
        for (;;) {
          const stop = await Promise.race([ended.then(() => 'end'), sleep(60).then(() => 'tick')]);
          if (stop === 'end') return;
          yield {
            type: 'result',
            subtype: 'success',
            session_id: `sess-${idx}`,
            is_error: false,
            num_turns: 1,
            duration_ms: 1,
            total_cost_usd: 0,
            result: `r${st.turns}`,
          };
        }
      } else {
        // Never emits a result: models a CLI still in its first turn / init.
        await ended;
        return;
      }
    },
    interrupt: async () => {
      // The real pre-first-result CLI ACCEPTS interrupt but does not act on it
      // (it is a control request unserviced before init completes). Model that:
      // resolve, but do NOT end the iterator. That is the whole reason D3 needs
      // the killKeeper fall-through.
    },
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    getContextUsage: async () => {
      await new Promise(() => {});
    },
  };
}

// ─── S3: spy on the killKeeper fall-through ──────────────────────────────────
let killKeeperCalls = 0;
sdk.__setKillKeeperForTests(async (wsId) => {
  if (wsId === WS_ID) killKeeperCalls++;
});

let result = { arm: ARM, ok: false };

if (ARM === 's2_successor' || ARM === 's2_sole_dies') {
  // Sessions here DO emit results, so a delivery can start.
  sdk.__setQueryFactoryForTests((opts) => makeQuery(true, opts));

  // ── Session A ──
  await sdk.sdkWake(WS_ID, 'turn-A');
  await sleep(200);
  const hasA = sdk.sdkHasSession(WS_ID);

  if (ARM === 's2_sole_dies') {
    // CONTROL: a lone session whose loop ends leaves no session behind.
    await sdk.sdkStop(WS_ID); // removes A from the map, interrupts
    iterState[0].releaseEnd(); // end A's iterator -> consume() finally runs
    await sleep(300);
    const hasAfter = sdk.sdkHasSession(WS_ID);
    result = { arm: ARM, ok: hasA === true && hasAfter === false, hasA, hasAfter };
  } else {
    // s2_successor: stop A, start B, THEN let A's loop end last.
    await sdk.sdkStop(WS_ID); // A removed from map; A's consume loop still alive
    const hasAfterStop = sdk.sdkHasSession(WS_ID); // false: A gone, B not yet up
    await sdk.sdkWake(WS_ID, 'turn-B'); // registers session B (callIndex 1)
    await sleep(200);
    const hasB = sdk.sdkHasSession(WS_ID); // B is live
    // Now end A's iterator so consume(A)'s finally runs while B owns the slot.
    iterState[0].releaseEnd();
    await sleep(400);
    const hasAfterAEnds = sdk.sdkHasSession(WS_ID); // FIXED: true; UNFIXED: false
    // Peer delivery: FIXED 'started', UNFIXED 'none' (the sd-delivery.ts:111 path).
    const delivery = await sdkDeliverConfirmed(WS_ID, 'peer-msg', undefined, 4000);
    result = {
      arm: ARM,
      ok: hasB === true && hasAfterAEnds === true && delivery === 'started',
      hasA,
      hasAfterStop,
      hasB,
      hasAfterAEnds,
      delivery,
    };
  }
} else if (ARM === 's3_no_result') {
  // The CLI never emits a result.
  sdk.__setQueryFactoryForTests((opts) => makeQuery(false, opts));
  await sdk.sdkWake(WS_ID, 'turn-that-never-completes');
  await sleep(250);
  const sawResultReported = killKeeperCalls; // still 0
  await sdk.sdkStop(WS_ID); // FIXED: fall-through killKeeper fires
  await sleep(100);
  // Let the (now-orphan) iterator end so the process can exit cleanly.
  iterState[0]?.releaseEnd();
  await sleep(100);
  result = {
    arm: ARM,
    ok: killKeeperCalls === 1,
    killKeeperCallsBeforeStop: sawResultReported,
    killKeeperCallsAfterStop: killKeeperCalls,
    expected: 1,
  };
} else if (ARM === 's3_with_result') {
  // The CLI DID emit a result — the fall-through must NOT fire.
  sdk.__setQueryFactoryForTests((opts) => makeQuery(true, opts));
  await sdk.sdkWake(WS_ID, 'turn-A');
  await sleep(250); // long enough for at least one result to land
  await sdk.sdkStop(WS_ID); // FIXED and UNFIXED: no fall-through (result seen)
  await sleep(100);
  iterState[0]?.releaseEnd();
  await sleep(100);
  result = {
    arm: ARM,
    ok: killKeeperCalls === 0,
    killKeeperCalls,
    expected: 0,
  };
}

clearInterval(keepalive);
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
