// Hung-CLI teardown gate (2026-09-23 bloc2 incident).
//
// A CLI that stops answering control requests (`interrupt`, `rewindFiles`) used
// to park every teardown forever: `sdkStop` awaited `q.interrupt()` unbounded,
// `sdkRewind` awaited `rewindFiles()` unbounded, and an explicit restart of a
// started-but-silent turn was refused ("interrupt it first") with no Stop
// button in the idle-looking pane. Drives the REAL agent-sdk.ts through
// `__setQueryFactoryForTests`; the fake Query models the hung CLI.
//
// Arms (ONE per process — module state is global):
//   stop_hung        — interrupt never answers → sdkStop must return (bounded).
//   stop_healthy     — control: interrupt answers → sdkStop returns fast.
//   rewind_hung      — rewindFiles + interrupt never answer → sdkRewind returns
//                      with a `timed out` filesError.
//   restart_stalled  — started turn, stream silent 3 min → sdkRestart succeeds,
//                      a NEW query starts and the owed prompt is yielded to it.
//   restart_busy     — control: same turn, recent stream activity → refused.
//   boot_hooks_probe — only SessionStart hook events, no init → NOT started
//                      (firstMessageSeen false), so the boot-wedge heal can fire.
//   boot_init_probe  — control: hooks then system/init → started.
//   boot_hooks_restart — hooks-only boot wedge → restart takes the 'fresh' path
//                      and redelivers instead of "interrupt it first".
//
// Prints one JSON line with `ok`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'stop_hung';
const ARMS = ['stop_hung', 'stop_healthy', 'rewind_hung', 'restart_stalled', 'restart_busy', 'boot_hooks_probe', 'boot_init_probe', 'boot_hooks_restart'];
if (!ARMS.includes(ARM)) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}
const hung = ARM !== 'stop_healthy';

const tmpHome = path.join(process.env.HUNG_HOME ?? '/tmp/hung-cli-home', ARM);
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-hung-cli',
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
  getAppVersion: () => '0.0.0-hung-cli',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-hung-cli';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID,
  name: 'hung-cli-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome,
  status: 'idle',
  createdAt: Date.now(),
  hasInput: true,
});

const INIT = { type: 'system', subtype: 'init', session_id: 'hung', tools: [], slash_commands: [] };
// Measured SDK shape: SessionStart hook events arrive ~1 s BEFORE system/init.
const HOOKS = [
  { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:resume', session_id: 'hung' },
  { type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:resume', session_id: 'hung' },
];
const bootArm = ARM.startsWith('boot_');
const never = () => new Promise(() => {});
let queries = 0;
const yieldedPerQuery = [];

sdk.__setQueryFactoryForTests(({ prompt }) => {
  const q = queries++;
  yieldedPerQuery[q] = [];
  void (async () => {
    try {
      for await (const m of prompt) yieldedPerQuery[q].push(m?.message?.content ?? '');
    } catch {
      /* torn down */
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      // The field shape: hooks, then (unless a boot wedge) system/init, then silence.
      // A successor query (after a restart) always boots normally.
      for (const h of HOOKS) yield h;
      if (!bootArm || ARM === 'boot_init_probe' || q > 0) yield INIT;
      await never();
    },
    interrupt: hung ? never : async () => {},
    rewindFiles: hung ? never : async () => ({ canRewind: false, error: 'none' }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    getContextUsage: never,
  };
});

const keepalive = setInterval(() => {}, 250);
const within = (p, ms) =>
  Promise.race([
    p.then(
      (v) => ({ settled: 'resolved', v }),
      (e) => ({ settled: 'rejected', err: String(e?.message ?? e) }),
    ),
    new Promise((r) => setTimeout(() => r({ settled: 'PENDING' }), ms)),
  ]);

// Occupy the gate with a started turn.
await sdk.sdkSend(WS_ID, 'owed prompt');
await new Promise((r) => setTimeout(r, 300));
const t0 = Date.now();
let out;

if (ARM === 'boot_hooks_probe' || ARM === 'boot_init_probe') {
  const probe = sdk.sdkGateProbe(WS_ID);
  const want = ARM === 'boot_init_probe';
  out = { firstMessageSeen: probe?.firstMessageSeen ?? null, gateHeld: probe?.gateHeld ?? null, ok: probe?.firstMessageSeen === want && probe?.gateHeld === true };
} else if (ARM === 'boot_hooks_restart') {
  const r = await within(sdk.sdkRestart(WS_ID, { fresh: false, trigger: 'toolbar' }), 30_000);
  await new Promise((res) => setTimeout(res, 500));
  const reDelivered = (yieldedPerQuery[1] ?? []).some((c) => String(c).includes('owed prompt'));
  out = { ...r, queries, reDelivered, ok: r.settled === 'resolved' && queries >= 2 && reDelivered };
} else if (ARM === 'stop_hung' || ARM === 'stop_healthy') {
  const r = await within(sdk.sdkStop(WS_ID), 15_000);
  out = { ...r, ms: Date.now() - t0, ok: r.settled === 'resolved' && !sdk.sdkHasSession(WS_ID) };
} else if (ARM === 'rewind_hung') {
  const r = await within(sdk.sdkRewind(WS_ID, 'rw-target', 'rw-prev'), 30_000);
  const filesError = r.v?.filesError ?? null;
  out = {
    ...r,
    filesError,
    ms: Date.now() - t0,
    ok: r.settled === 'resolved' && /timed out/.test(filesError ?? '') && !sdk.sdkHasSession(WS_ID),
  };
} else {
  if (ARM === 'restart_stalled') sdk.__backdateStreamForTests(WS_ID, 3 * 60 * 1000);
  const r = await within(sdk.sdkRestart(WS_ID, { fresh: false, trigger: 'toolbar' }), 30_000);
  await new Promise((res) => setTimeout(res, 500));
  const reDelivered = (yieldedPerQuery[1] ?? []).some((c) => String(c).includes('owed prompt'));
  out =
    ARM === 'restart_stalled'
      ? { ...r, queries, reDelivered, ok: r.settled === 'resolved' && queries >= 2 && reDelivered }
      : { ...r, queries, ok: r.settled === 'rejected' && /working/.test(r.err ?? '') && queries === 1 };
  out.ms = Date.now() - t0;
}

clearInterval(keepalive);
console.log(JSON.stringify({ arm: ARM, ...out, v: undefined }));
process.exit(0);
