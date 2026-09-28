// Issue #124 — keeper stop-semantics S2 (D2) + S3 (D3), driven through the REAL
// agent-sdk.ts consume()/sdkStop with a fake SDK Query (no real `claude`).
//
// S3 (D3): `sdkStop` on a CLI that has NEVER produced a `result` must kill the
//   keeper — the graceful close cannot reach a keeper that never got a stdinEnd.
//   Observed via `__setKillKeeperForTests`: the rig records whether the sdkStop
//   teardown kill fired. A real keeper harness (verifier G3) proves the pids
//   actually die; here we assert the DECISION S3 makes.
//   Arms:
//     s3_noresult_kills  — interrupt RESOLVES fast (not hung), NO result ever
//                          emitted → sdkStop must fall through to killKeeper
//                          because !sawResult. (interruptHung is false here, so
//                          this isolates the !sawResult clause specifically.)
//     s3_result_no_kill  — one `result` emitted, then interrupt resolves fast →
//                          graceful close suffices, killKeeper must NOT fire.
//                          The must-NOT arm: proves the kill is gated on sawResult,
//                          not fired unconditionally.
//
// S2 (D2): consume()'s finally removes a session ONLY when it still owns the
//   wsId slot. Model the stop→restart race: session A is torn down (sdkStop
//   deletes A) while its consume loop is still unwinding; a successor B registers
//   under the same wsId; A's finally must NOT evict B.
//   Arm:
//     s2_teardown_only_self — after the A→B swap, sdkHasSession(wsId) stays true
//                          (B survives) and a delivery to it is possible.
//                          The mutant (unconditional delete) reddens: B is gone.
//
// Rig hygiene: isolated ORCHESTRA_HOME + HOME under a tmp dir on the caller's fs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 's3_noresult_kills';
const ARMS = ['s3_noresult_kills', 's3_result_no_kill', 's2_teardown_only_self'];
if (!ARMS.includes(ARM)) {
  console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`);
  process.exit(2);
}

const tmpHome = path.join(process.env.STOPSEM_HOME ?? '/tmp/keeper-stop-semantics-124', ARM);
import fs from 'node:fs';
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-stop-semantics-124',
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
  getAppVersion: () => '0.0.0-stop-semantics-124',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-stop-semantics-124';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID,
  name: 'stop-semantics-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome,
  status: 'idle',
  createdAt: Date.now(),
  hasInput: true,
  sdkSessionId: 'rig-session',
});

const INIT = { type: 'system', subtype: 'init', session_id: 'rig', tools: [], slash_commands: [] };
const RESULT = {
  type: 'result', subtype: 'success', session_id: 'rig', is_error: false,
  num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'done',
};
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── S3 arms ──────────────────────────────────────────────────────────────────
if (ARM === 's3_noresult_kills' || ARM === 's3_result_no_kill') {
  const emitResult = ARM === 's3_result_no_kill';
  let killed = 0;
  sdk.__setKillKeeperForTests(async () => {
    killed++;
  });
  sdk.__setQueryFactoryForTests(() => ({
    async *[Symbol.asyncIterator]() {
      yield INIT;
      if (emitResult) {
        yield RESULT;
      }
      await never();
    },
    // interrupt RESOLVES fast in BOTH arms — so the ONLY thing that decides the
    // kill is `sawResult`. (If interrupt hung, interruptHung would fire the kill
    // and this rig could not isolate the S3 clause.)
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    getContextUsage: never,
  }));

  const keepalive = setInterval(() => {}, 250);
  await sdk.sdkSend(WS_ID, 'kickoff');
  await sleep(400); // let INIT (+ RESULT) stream in
  await sdk.sdkStop(WS_ID);
  await sleep(200);
  clearInterval(keepalive);

  const expectKill = ARM === 's3_noresult_kills';
  const ok = expectKill ? killed >= 1 : killed === 0;
  console.log(JSON.stringify({ arm: ARM, ok, killed, sessionGone: !sdk.sdkHasSession(WS_ID) }));
  sdk.__setKillKeeperForTests(null);
  process.exit(ok ? 0 : 1);
}

// ── S2 arm ───────────────────────────────────────────────────────────────────
if (ARM === 's2_teardown_only_self') {
  // Two queries. Query A hangs after INIT until we release it (so its consume
  // loop is still alive when we swap in B). Query B is a normal successor.
  let releaseA = () => {};
  const aReleased = new Promise((r) => { releaseA = r; });
  let queries = 0;
  sdk.__setKillKeeperForTests(async () => {}); // no real keeper in this rig

  sdk.__setQueryFactoryForTests(() => {
    const q = queries++;
    return {
      async *[Symbol.asyncIterator]() {
        yield INIT;
        if (q === 0) {
          // Session A: stay live until released, THEN end the stream so consume()
          // reaches its `finally` (the identity-guarded delete) — modeling the
          // predecessor's loop unwinding AFTER the successor took the slot.
          await aReleased;
          return;
        }
        // Session B (successor): stay live so sdkHasSession stays true.
        await never();
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      mcpServerStatus: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => [],
      getContextUsage: never,
    };
  });

  const keepalive = setInterval(() => {}, 250);
  // Start session A.
  await sdk.sdkSend(WS_ID, 'A-kickoff');
  await sleep(300);
  const aLive = sdk.sdkHasSession(WS_ID);

  // Register successor B under the SAME wsId WITHOUT going through A's teardown:
  // delete A from the map (as sdkStop would) then start B. We use the public
  // seam sdkStop to remove A from the map, but A's fake interrupt resolves and
  // its stream is still parked on `aReleased` — so A's consume loop has NOT yet
  // hit its finally. Immediately start B, which registers under the slot.
  await sdk.sdkStop(WS_ID); // removes A from the map; A's loop still parked pre-finally
  await sdk.sdkSend(WS_ID, 'B-kickoff'); // ensureSession registers B
  await sleep(300);
  const bLiveBeforeAFinally = sdk.sdkHasSession(WS_ID);

  // NOW let A's stream end → A's consume finally runs. With the identity guard it
  // must NOT evict B; without it, B is deleted.
  releaseA();
  await sleep(400);
  const bSurvives = sdk.sdkHasSession(WS_ID);

  clearInterval(keepalive);
  const ok = aLive && bLiveBeforeAFinally && bSurvives;
  console.log(JSON.stringify({ arm: ARM, ok, aLive, bLiveBeforeAFinally, bSurvives, queries }));
  sdk.__setKillKeeperForTests(null);
  process.exit(ok ? 0 : 1);
}
