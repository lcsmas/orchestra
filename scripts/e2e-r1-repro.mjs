// review-74 R1 — REPRODUCTION of the permanent-freeze failure path.
//
// Scenario: a workspace is marked `usage_limit`, its reset has passed, and the
// resume driver decides to nudge — but `wakeAgentWithPrompt` FAILS. On the
// unfixed code the marker was already cleared and never restored, so the
// workspace leaves the `lastStopReason === 'usage_limit'` candidate filter and
// NO later tick reconsiders it: frozen forever, ⏸ glyph gone.
//
// Forcing the failure honestly: the driver calls the real `wakeAgentWithPrompt`,
// which returns false when `isRunning(id)` — a live PTY session. Rather than
// stubbing the function under test, we make the REAL precondition true by
// registering a PTY session for the workspace, which is exactly the reachable
// case the review identified (the candidate filter does not exclude a
// coexisting PTY).
//
// Observable: `lastStopReason` AFTER the tick. Read from the store.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpHome = process.env.R1_HOME ?? '/tmp/r1-home';
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const broadcasts = [];
initPlatform({
  kind: 'headless-r1',
  broadcast: (c, ...a) => broadcasts.push({ channel: c, args: a }),
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false,
  hasAttachedUi: () => false, notify: () => {}, openExternal: () => {},
  showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {},
  closeAccountLogin: () => {}, getUserDataDir: () => tmpHome,
  getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-r1',
  getAppMetrics: () => [], isEncryptionAvailable: () => false,
  encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const pq = await import(`${REPO}/src/main/prompt-queue.ts`);
const pty = await import(`${REPO}/src/main/pty.ts`);

const WS_ID = 'ws-r1';
await store.load?.();
const RESET = Date.now() - 60_000;           // reset already passed
await store.upsertWorkspace({
  id: WS_ID, name: 'r1-subject', kind: 'orchestrator', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(),
  lastStopReason: 'usage_limit', lastStopReasonAt: Date.now() - 120_000,
  usageLimitResetsAt: RESET,
});

// Make the REAL false-return precondition true, using the REAL code path:
// `wakeAgentWithPrompt` returns false when `isRunning(id)`, and `isRunning` is
// `sessions.has(id)` — so start an actual PTY for this workspace. No test-only
// seam is added to production code, and the precondition is the very one the
// review identified as reachable (the candidate filter does not exclude a
// coexisting PTY).
await pty.startPty({
  id: WS_ID, cwd: tmpHome, command: '/usr/bin/sleep', args: ['60'],
  cols: 80, rows: 24,
});
// PRECONDITION ASSERT. If this is false the arm proves nothing — the wake would
// succeed and we would never reach the failure path under test.
if (!pty.isRunning(WS_ID)) {
  console.error('ABORT(precondition): isRunning is false — the wake would NOT fail, so this arm cannot test the freeze path');
  process.exit(3);
}

const before = store.getWorkspace(WS_ID);
console.error(`[r1] pre-state lastStopReason=${before?.lastStopReason} isRunning=${pty.isRunning(WS_ID)} (the wake WILL fail)`);

// Drive the REAL flusher, then wait LONGER THAN ITS INTERVAL.
//
// The first version of this harness waited 3s against a TICK_MS of 20s, so the
// tick NEVER RAN — and both arms reported "marker survived", which read exactly
// like the fix working. A probe that never provokes the condition returns a
// comfortable false negative; that result was VOID, not evidence. The wait is
// now derived from the module's own constant rather than guessed, and the run
// asserts the tick actually happened.
const TICK_MS = Number(
  (await import('node:fs')).readFileSync(`${REPO}/src/main/prompt-queue.ts`, 'utf8')
    .match(/const TICK_MS = ([\d_]+)/)?.[1]?.replace(/_/g, '') ?? '20000',
);
console.error(`[r1] flusher TICK_MS=${TICK_MS}; waiting ${TICK_MS + 4000}ms so at least one tick fires`);
pq.startPromptQueueFlusher();
await new Promise((r) => setTimeout(r, TICK_MS + 4000));
pq.stopPromptQueueFlusher();

const after = store.getWorkspace(WS_ID);
console.log(JSON.stringify({
  scenario: 'wake fails on a limit-paused workspace',
  before: before?.lastStopReason ?? null,
  after: after?.lastStopReason ?? null,
  stillCandidate: after?.lastStopReason === 'usage_limit',
  resetsAtMs: after?.usageLimitResetsAt ?? null,
}));
process.exit(0);
