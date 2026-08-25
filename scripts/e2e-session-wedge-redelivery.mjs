// Issue #90 review R2 — parked messages must be delivered EXACTLY ONCE.
//
// Drives the REAL `recycleSession` against a REAL inbox file on disk, with the
// REAL `releaseInboxBlock`. The observable is a per-message DELIVERY COUNT
// taken from the prompts the session actually received, plus what survives in
// the inbox file afterwards.
//
// The defect this exists to catch (review R2): waking via
// `sdkWake(wsId, parked[0].text)` delivers the first message as a turn WITHOUT
// removing its block — `sdkWake` -> `sdkSend` never touches the inbox — so the
// woken turn's UserPromptSubmit hook then `cat`s AND `rm -f`s the WHOLE file.
// Result: message 1 delivered TWICE, messages 2..N destroyed unconfirmed.
//
// Arms:
//   exactly_once — the fix. Each parked message delivered exactly once, inbox empty.
//   control_nodeliver — the session refuses to start turns, so NOTHING may be
//                   removed: every block must survive. Proves the rig can
//                   observe a NON-removal, so an "inbox empty" elsewhere is a
//                   real finding rather than a rig that deletes files.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'exactly_once';
//   hook_drain_race — the R2 RESIDUAL arm. The wake turn's UserPromptSubmit
//                   hook drains the inbox ASYNCHRONOUSLY (cat + rm -f the whole
//                   file) while the release loop is running. Before the fix,
//                   step 4's `for…of readInbox()` took ONE snapshot before that
//                   drain landed and released a block the hook was about to show
//                   too: MEASURED 3/3 deterministic, ALPHA delivered twice with
//                   remaining=0. Both paths are individually correct; they
//                   composed wrong at the snapshot boundary.
const ARMS = {
  exactly_once: { startTurns: true },
  control_nodeliver: { startTurns: false },
  hook_drain_race: { startTurns: true, hookDrain: true },
};
const arm = ARMS[ARM];
if (!arm) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// INBOX_ROOT keys off os.homedir(), NOT ORCHESTRA_HOME — override HOME or the
// rig reads the real user's inbox.
const tmpHome = path.join(process.env.WEDGE_HOME ?? '/tmp/wedge90-r2', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-wedge90-r2',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-wedge90r2', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
const watchdog = await import(`${REPO}/src/main/session-watchdog.ts`);

const WS_ID = 'ws-wedge90-r2';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'r2-subject', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(), hasInput: true,
});

// Three DISTINCT parked messages, written to the REAL inbox file.
const BODIES = ['PARKED-ALPHA', 'PARKED-BRAVO', 'PARKED-CHARLIE'];
const inboxPath = tray.inboxFilePath(WS_ID);
fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
fs.writeFileSync(inboxPath, BODIES.map((b) => `${'='.repeat(60)}\n${b}\n`).join(''), 'utf8');
const parkedBefore = tray.readInbox(WS_ID).length;
if (parkedBefore !== 3) {
  console.error(`ABORT: seeded 3 blocks, readInbox saw ${parkedBefore} — rig cannot proceed`);
  process.exit(3);
}

// Count how many times each body reaches the session as a real turn.
const delivered = [];
let hookFired = false;
sdk.__setQueryFactoryForTests(({ prompt }) => {
  void (async () => {
    try {
      for await (const m of prompt) {
        const txt = JSON.stringify(m?.message?.content ?? '');
        for (const b of BODIES) if (txt.includes(b)) delivered.push(b);
        // The wake turn's UserPromptSubmit hook: cat the whole inbox to the
        // agent (a REAL delivery — it is how a parked message normally lands)
        // then rm -f the file. Async, exactly as the shell hook is.
        if (arm.hookDrain && !hookFired && !BODIES.some((b) => txt.includes(b))) {
          hookFired = true;
          setTimeout(() => {
            try {
              for (const blk of tray.readInbox(WS_ID)) {
                for (const b of BODIES) if (blk.text.includes(b)) delivered.push(b);
              }
              fs.rmSync(inboxPath, { force: true });
            } catch { /* the file may already be gone; that is the race */ }
          }, 40);
        }
      }
    } catch { /* torn down; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'r2', tools: [], slash_commands: [] };
      await new Promise((r) => setImmediate(r));
      if (arm.startTurns) {
        // Supply a result per turn so each release can CONFIRM a start.
        for (let i = 0; i < 12; i++) {
          yield { type: 'result', subtype: 'success', session_id: 'r2', is_error: false,
                  num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `done ${i}` };
          await new Promise((r) => setTimeout(r, 60));
        }
      }
      await new Promise(() => {});
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
  };
});

const keepalive = setInterval(() => {}, 250);
await watchdog.recycleSession(WS_ID, 'rig-driven R2 check');
await new Promise((r) => setTimeout(r, 1200));
clearInterval(keepalive);

const counts = Object.fromEntries(BODIES.map((b) => [b, delivered.filter((d) => d === b).length]));
const remaining = tray.readInbox(WS_ID).map((b) => b.text.trim());
const dupes = BODIES.filter((b) => counts[b] > 1);

const ok = arm.startTurns
  // FIX: every message delivered exactly once, nothing left parked.
  ? BODIES.every((b) => counts[b] === 1) && remaining.length === 0
  // CONTROL: nothing started, so nothing may have been removed.
  : remaining.length === 3 && BODIES.every((b) => counts[b] === 0);

console.log(JSON.stringify({
  arm: ARM, ok, counts, duplicates: dupes,
  parkedBefore, remainingAfter: remaining.length,
}));
process.exit(0);
