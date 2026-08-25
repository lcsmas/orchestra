// review-74 R2 — REPRODUCTION of the subprocess-death detection gap.
//
// Drives the REAL `consume()` in `src/main/agent-sdk.ts` — not a model of it —
// through the repo's own `__setQueryFactoryForTests` seam, which exists to
// "inject a fake that yields canned SDK messages without spawning a real
// claude". The scenario is provoked AT THE BOUNDARY:
//
//     rate_limit_event{status:'rejected'}   ← the latch is set (via emitFrom)
//     …stream ENDS, no `result` ever arrives ← the subprocess died
//
// which drops `consume()` into its `finally`, where a SYNTHETIC turn-end is
// built and emitted DIRECTLY — bypassing `emitFrom`, the only place the #74
// latch was read before this fix.
//
// Run one arm per process (module state is global):
//   node --experimental-strip-types --import <register> e2e-r2-repro.mjs <arm>
// Arms: boundary_death | control_no_rejection | control_result_arrives
//
// Prints one JSON line: {"arm":…,"marked":…,"resetsAtMs":…,"reason":…}
// `marked` is read from the STORE — the real observable the resume driver
// filters on — never from a spy on the function under test.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'boundary_death';

const REJECTED = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 1787680800 },
};
const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'r2-session',
  tools: [],
  mcp_servers: [],
  model: 'claude-sonnet-4-6',
  slash_commands: [],
};
const RESULT_429 = {
  type: 'result',
  is_error: true,
  api_error_status: 429,
  subtype: 'error',
  result: 'usage limit reached',
  num_turns: 1,
  session_id: 'r2-session',
  duration_ms: 10,
};

// The three arms. The two controls are what stop arm `boundary_death` from
// being a vacuous "nothing ever gets marked" result.
const ARMS = {
  // THE SCENARIO. Latch set, then the stream ends with no result.
  boundary_death: { messages: [INIT, REJECTED], expectMarked: true },
  // CONTROL A: the stream dies the SAME way, but nothing was ever rejected.
  // Must NOT mark — proves "not marked" is reachable for a reason other than
  // the bug, so a broken harness cannot masquerade as a clean reproduction.
  control_no_rejection: { messages: [INIT], expectMarked: false },
  // CONTROL B: the rejection IS followed by a result (no death). Must mark via
  // emitFrom — proves this harness can observe a mark at all, so a `marked:false`
  // in the boundary arm is a real finding rather than a dead instrument.
  control_result_arrives: { messages: [INIT, REJECTED, RESULT_429], expectMarked: true },
};

const arm = ARMS[ARM];
if (!arm) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}

// ── isolate all on-disk state before anything imports the store ─────────────
const tmpHome = path.join(process.env.R2_HOME ?? '/tmp/r2-home', ARM);
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

// Install a headless platform implementation. This is the seam's DOCUMENTED
// contract ("called exactly once, at the top of the entry point"), not a
// workaround: the harness is standing in for the entry point. Broadcasts are
// recorded rather than discarded, so the run also shows whether the renderer
// would have been told.
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const broadcasts = [];
initPlatform({
  kind: 'headless-r2',
  broadcast: (channel, ...args) => { broadcasts.push({ channel, args }); },
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
  getAppVersion: () => '0.0.0-r2',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-r2';
await store.load?.();
// Seed a workspace with NO stop reason. The mark must be produced BY THE CODE
// UNDER TEST — seeding it would be the trap activity.ts documents.
await store.upsertWorkspace({
  id: WS_ID,
  name: 'r2-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome,
  status: 'running',
  createdAt: Date.now(),
  hasInput: true,
});

const before = store.getWorkspace(WS_ID);
if (before?.lastStopReason) {
  console.error(`ABORT: subject already carries lastStopReason=${before.lastStopReason} — pre-state is not clean`);
  process.exit(3);
}

// ── inject the canned stream through the repo's own test seam ───────────────
sdk.__setQueryFactoryForTests(({ prompt }) => {
  // Drain the prompt generator in the background: `consume()` iterates the
  // RESPONSE stream, while `promptStream` is what sdkSend feeds. Ignoring it is
  // fine — the response side is what this scenario is about.
  void (async () => {
    try {
      if (prompt && typeof prompt === 'object' && Symbol.asyncIterator in prompt) {
        for await (const _ of prompt) { /* discard */ }
      }
    } catch { /* the session is torn down under us; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of arm.messages) {
        yield m;
        // Let each message finish being handled before the next, so the latch
        // is genuinely set by the time the stream ends.
        await new Promise((r) => setImmediate(r));
      }
      // STREAM ENDS. No `result`. This is what a dead subprocess looks like to
      // the `for await` in consume() — and it is the boundary the whole finding
      // is about.
    },
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
  };
});

// Start a session and let the stream run to completion (and past the finally).
await sdk.sdkSend(WS_ID, 'provoke the R2 window');
await new Promise((r) => setTimeout(r, 2500));

const after = store.getWorkspace(WS_ID);
const marked = after?.lastStopReason === 'usage_limit';
console.log(
  JSON.stringify({
    arm: ARM,
    marked,
    expectMarked: arm.expectMarked,
    ok: marked === arm.expectMarked,
    reason: after?.lastStopReason ?? null,
    resetsAtMs: after?.usageLimitResetsAt ?? null,
    workspaceUpdates: broadcasts.filter((b) => b.channel === 'workspace:update').length,
  }),
);
process.exit(0);
