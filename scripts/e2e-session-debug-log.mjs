// G3 gate for the per-session debug-log black box (#177).
//
// Drives the REAL agent-sdk.ts session path (`sdkSend` → `ensureSession` →
// `query()`) through `__setQueryFactoryForTests`. The fake `query` stands in
// for the SDK+CLI honoring the `--debug-file <path>` flag: it reads the
// `options.debugFile` agent-sdk set and WRITES to that path, exactly as the
// real CLI does (the SDK maps `debugFile` → `--debug-file`, verified by
// grepping the SDK bundle in the wiring test). This proves the code SETS the
// option on the real launch AND that the resulting capture lands under
// `<ORCHESTRA_HOME>/logs/sessions/` — not the worktree, not keepers/ — so it
// outlives workspace deletion.
//
// Arms (ONE per process — module state is global):
//   appears   — a driven session produces a capture file under logs/sessions/,
//               the option was set to a path in that dir, and the fake CLI's
//               bytes are in it.  (must-FAIL on master: no debugFile is set.)
//   rotates   — pre-seed the dir OVER every retention cap; a fresh spawn sweeps
//               the old captures but never the file it is about to write.
//
// Prints one JSON line with `ok`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'appears';
const ARMS = ['appears', 'rotates'];
if (!ARMS.includes(ARM)) {
  console.error(`unknown arm: ${ARM}`);
  process.exit(2);
}

const tmpHome = path.join(process.env.SDL_HOME ?? '/tmp/session-debug-log-home', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-sdl',
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
  getAppVersion: () => '0.0.0-sdl',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const { sessionDebugLogDir } = await import(`${REPO}/src/main/session-debug-log-fs.ts`);

const WS_ID = 'ws-sdl-subject';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID,
  name: 'sdl-subject',
  kind: 'scratch',
  repoPath: '',
  worktreePath: tmpHome, // a real dir the worktree-validate check passes
  status: 'idle',
  createdAt: Date.now(),
  hasInput: true,
});

const dir = sessionDebugLogDir();
const CLI_BYTES = 'DEBUG: fake cli wrote here\n';
let capturedDebugFile = null;

// rotates arm: pre-seed the dir with files OLDER than the real default age cap
// (7 days), so a fresh spawn's sweep evicts them by the AGE rule — exercising
// the PRODUCTION defaults, no test-only knob. The fresh file (written now) is
// young and must survive.
if (ARM === 'rotates') {
  fs.mkdirSync(dir, { recursive: true });
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days old → past the 7-day cap
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, `stale-${i}.log`);
    fs.writeFileSync(p, `stale ${i}\n`);
    fs.utimesSync(p, new Date(old), new Date(old));
  }
}

const INIT = { type: 'system', subtype: 'init', session_id: 'sdl', tools: [], slash_commands: [] };
const never = () => new Promise(() => {});

sdk.__setQueryFactoryForTests(({ prompt, options }) => {
  // Record the option agent-sdk chose, and — like the real CLI under
  // --debug-file — write the debug capture to it.
  capturedDebugFile = options?.debugFile ?? null;
  if (capturedDebugFile) {
    try {
      fs.appendFileSync(capturedDebugFile, CLI_BYTES);
    } catch (e) {
      console.error('fake cli could not write debugFile', e);
    }
  }
  void (async () => {
    try {
      for await (const _ of prompt) {
        /* drain */
      }
    } catch {
      /* torn down */
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield INIT;
      await never();
    },
    interrupt: async () => {},
    rewindFiles: async () => ({ canRewind: false, error: 'none' }),
    setModel: async () => {},
    setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    getContextUsage: never,
  };
});

const keepalive = setInterval(() => {}, 250);
let out;

try {
  await sdk.sdkSend(WS_ID, 'drive one turn');
  // Give ensureSession/query() a beat to run the factory + write.
  await new Promise((r) => setTimeout(r, 500));

  const listing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
  const sessionFiles = listing.filter((f) => f.startsWith(WS_ID + '__'));

  if (ARM === 'appears') {
    const optionInDir =
      typeof capturedDebugFile === 'string' && path.dirname(capturedDebugFile) === dir;
    const one = sessionFiles.length === 1 ? path.join(dir, sessionFiles[0]) : null;
    const body = one ? fs.readFileSync(one, 'utf8') : '';
    const contentOk = body.includes(CLI_BYTES.trim());
    // The capture must live under logs/sessions, NOT the worktree or keepers.
    const notInWorktree = !fs.existsSync(path.join(tmpHome, sessionFiles[0] ?? 'none.log'));
    out = {
      arm: ARM,
      debugFile: capturedDebugFile,
      sessionFiles,
      dir,
      ok: !!optionInDir && sessionFiles.length === 1 && contentOk && notInWorktree,
    };
  } else {
    // rotates: the 6 stale files must be gone; the fresh file must remain.
    const staleLeft = listing.filter((f) => f.startsWith('stale-'));
    out = {
      arm: ARM,
      staleLeft,
      sessionFiles,
      ok: staleLeft.length === 0 && sessionFiles.length === 1,
    };
  }
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
