// Gate for #176: no getContextUsage() at session boot.
//
// A boot-time getContextUsage() makes the real CLI open a burst of API connections
// (~90 on the metarepo) and the first turn sent into it wedged 5/7 times. Drives the
// REAL agent-sdk.ts path (`sdkSend` → `ensureSession` → `query()`) through
// `__setQueryFactoryForTests`, with a fake CLI that COUNTS getContextUsage calls.
//
// Arms (one per process — module state is global):
//   boot      — the fake CLI emits init and then nothing for 1.5 s: zero calls allowed.
//               must-FAIL on the unfixed build (it calls at boot).
//   turn-end  — init, then a `result` after the opening prompt: zero calls after it either
//               (#317: the turn-end read held the next prompt). The positive control — a
//               re-added call IS seen — is `pnpm run test:turn-boundary` (mutant arm).
//
// Prints one JSON line with `ok`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'boot';
if (!['boot', 'turn-end'].includes(ARM)) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}

const tmpHome = path.join(process.env.CS_HOME ?? '/tmp/context-seed-176-home', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-cs',
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
  getAppVersion: () => '0.0.0-cs',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);

const WS_ID = 'ws-cs-subject';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID,
  name: 'cs-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome,
  status: 'idle',
  createdAt: Date.now(),
  hasInput: true,
});

const never = () => new Promise(() => {});
let resultYielded = false;
const calls = { beforeResult: 0, afterResult: 0 };
let factoryCalls = 0;
let promptSeen;
const promptArrived = new Promise((r) => (promptSeen = r));

sdk.__setQueryFactoryForTests(({ prompt }) => {
  factoryCalls++;
  // Drain the prompt stream like the real CLI, so the opening turn is accepted.
  void (async () => {
    try {
      for await (const _ of prompt) promptSeen();
    } catch {
      /* torn down */
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'cs', tools: [], slash_commands: [] };
      if (ARM === 'turn-end') {
        await promptArrived;
        resultYielded = true;
        yield { type: 'result', subtype: 'success', session_id: 'cs', is_error: false,
                num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'ok' };
      }
      await never();
    },
    interrupt: async () => {},
    rewindFiles: async () => ({ canRewind: false, error: 'none' }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => [],
    supportedCommands: async () => [],
    supportedModels: async () => [],
    getContextUsage: async () => {
      if (resultYielded) calls.afterResult++;
      else calls.beforeResult++;
      return {};
    },
  };
});

const keepalive = setInterval(() => {}, 250);
let out;
try {
  await sdk.sdkSend(WS_ID, 'drive one turn');
  await new Promise((r) => setTimeout(r, 1500));
  const ok =
    factoryCalls >= 1 &&
    calls.beforeResult === 0 &&
    (ARM === 'boot' ? true : resultYielded && calls.afterResult === 0);
  out = { arm: ARM, factoryCalls, resultYielded, calls, ok };
} catch (e) {
  out = { arm: ARM, ok: false, error: String(e?.stack ?? e) };
} finally {
  clearInterval(keepalive);
  try {
    await sdk.sdkStop?.(WS_ID);
  } catch {
    /* ignore */
  }
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
