// Issue #124 D4 (S4) — parked inbox mail is RE-DRIVEN at the turn boundary.
//
// The defect (audit D4): a peer delivery that timed out waiting for a running
// turn to START is withdrawn and parked in the durable inbox
// (`~/.orchestra/inbox/<ws>.txt`). Nothing starts a new turn when the current
// one ends, so the mail sits unseen until the watchdog "recycles" a healthy
// idle session (into D1/D2 — the user-visible "not responding").
//
// The fix (S4): in `consume()`'s `result` branch, when `session.queue` is empty
// and `readInbox(wsId)` is non-empty, release the FIRST block through
// `releaseInboxBlock` (the exactly-once path) — one block per boundary; the
// turn IT starts produces its own `result`, which re-drives the next.
//
// ── What this rig drives ─────────────────────────────────────────────────────
// The REAL agent-sdk `consume()` loop against a REAL inbox file on disk with the
// REAL `releaseInboxBlock`. A fake SDK query (via `__setQueryFactoryForTests`)
// yields canned `result` messages so no real `claude` spawns. The OBSERVABLE is
// the `user-message` broadcast — the transcript's only record that a block
// really became the session's turn (emitted by sdkSend at agent-sdk.ts:2338) —
// counted per parked body, plus what survives in the inbox file afterwards.
//
// ── Arms ─────────────────────────────────────────────────────────────────────
//   redrive          — the FIX. Park ONE block, drive one turn to `result`. On
//                      that boundary exactly ONE `user-message` broadcast for
//                      the block fires and the file shrinks by one block (0 left).
//   redrive_two      — park TWO blocks. One block re-drives PER boundary: after
//                      the kickoff turn's result, block A is released; A's own
//                      result re-drives block B. Both delivered exactly once,
//                      inbox empty — proves the "one per boundary, next result
//                      re-drives the next" contract, not a blanket drain.
//   control_noresult — the session NEVER emits a `result` for the kickoff turn,
//                      so the re-drive site is never reached: the block must
//                      survive and receive ZERO broadcasts. Proves the rig can
//                      observe a NON-re-drive, so a "file shrank" elsewhere is a
//                      real finding rather than a rig that deletes files itself.
//                      This is ALSO the UNFIXED-build shape: on master (no
//                      re-drive at the boundary) the `redrive` arm reproduces
//                      exactly this — block parked, 0 broadcast — see the
//                      cross-build note in the ledger comment.
//
// ── Rig hygiene ──────────────────────────────────────────────────────────────
// INBOX_ROOT keys off os.homedir(), NOT ORCHESTRA_HOME (inbox-tray.ts). So the
// rig overrides BOTH HOME and ORCHESTRA_HOME to an isolated tmp dir — otherwise
// it would read and mutate the real user's inbox.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'redrive';
const ARMS = {
  redrive: { bodies: ['REDRIVE-ALPHA'], emitKickoffResult: true },
  redrive_two: { bodies: ['REDRIVE-ALPHA', 'REDRIVE-BRAVO'], emitKickoffResult: true },
  control_noresult: { bodies: ['REDRIVE-ALPHA'], emitKickoffResult: false },
  // F2 (reviewer fc47cadb): `holdDelivery` (latched sendAwaitingStart) is what opens the window — result #2
  // dispatches the re-drive and it stays in flight; #3 (80 ms later, inFlight=1) must NOT re-dispatch (sendCalls 1 fixed / 2 mutant).
  // `burstFirst`'s 0 ms pair is #0/#1, fired while the kickoff is still queued (queueLen 1): it dispatches nothing (traced).
  in_window_double: { bodies: ['REDRIVE-ALPHA'], emitKickoffResult: true, burstFirst: true, holdDelivery: true },
};
const arm = ARMS[ARM];
if (!arm) {
  console.error(`unknown arm: ${ARM} (expected: ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

const tmpHome = path.join(process.env.REDRIVE_HOME ?? '/tmp/inbox-redrive-124', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra', 'inbox'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

// Observe every broadcast — we care about `agent:event` user-message events.
const userMessages = []; // { wsId, text }
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-inbox-redrive-124',
  broadcast: (channel, ...args) => {
    if (channel === 'agent:event') {
      const [wsId, event] = args;
      if (event && event.type === 'user-message') {
        userMessages.push({ wsId, text: String(event.text ?? '') });
      }
    }
  },
  broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-inbox-redrive-124', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);

const WS_ID = 'ws-inbox-redrive-124';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'redrive-subject', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(), hasInput: true,
});

// Park the block(s) in the REAL inbox file BEFORE any turn runs — this is the
// state D4 leaves behind: mail withdrawn from a busy turn and durably parked.
const BODIES = arm.bodies;
const inboxPath = tray.inboxFilePath(WS_ID);
fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
fs.writeFileSync(inboxPath, BODIES.map((b) => `${'='.repeat(60)}\n${b}\n`).join(''), 'utf8');
const parkedBefore = tray.readInbox(WS_ID).length;
if (parkedBefore !== BODIES.length) {
  console.error(`ABORT: seeded ${BODIES.length} block(s), readInbox saw ${parkedBefore}`);
  process.exit(3);
}

// The kickoff prompt text — NOT one of the parked bodies, so a user-message
// broadcast for a parked body can only come from the re-drive, never the kickoff.
const KICKOFF = 'KICKOFF-TURN-NOT-A-PARKED-BODY';

// Fake SDK query: yields an init, then (for the fix arms) one `result` per turn
// requested. Each `result` is a turn boundary where consume()'s re-drive fires.
sdk.__setQueryFactoryForTests(({ prompt }) => {
  // Drain the prompt stream so promptStream keeps yielding turns; we do not need
  // the content here — the observable is the user-message broadcast, captured
  // via the platform broadcast above.
  void (async () => {
    try {
      for await (const _ of prompt) { /* consume; each drives one turn */ }
    } catch { /* torn down; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'redrive', tools: [], slash_commands: [] };
      await new Promise((r) => setImmediate(r));
      if (arm.emitKickoffResult) {
        // One result per turn (kickoff + up to N re-driven blocks + slack).
        for (let i = 0; i < BODIES.length + 3; i++) {
          yield {
            type: 'result', subtype: 'success', session_id: 'redrive', is_error: false,
            num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `done ${i}`,
          };
          // burstFirst: #0/#1 fire 0 ms apart with the kickoff still queued (queueLen 1) → nothing dispatched;
          // it is NOT what opens the F2 window (holdDelivery does).
          const gap = arm.burstFirst && i === 0 ? 0 : 80;
          await new Promise((r) => setTimeout(r, gap));
        }
      }
      // Keep the query open so the session stays live for the observation window.
      await new Promise(() => {});
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
  };
});

// Start the session and deliver the kickoff turn. On its `result`, consume()'s
// re-drive should release the first parked block; that block's own result then
// re-drives the next (redrive_two arm).
// F2 hold: wrap the delivery seam so the FIRST re-drive's sendAwaitingStart parks on a
// latch. Counts every call; delegates to the REAL sdkSendAwaitingStart once released.
let sendCalls = 0;
let releaseHold = () => {};
const holdGate = new Promise((r) => { releaseHold = r; });
if (arm.holdDelivery) {
  delivery.registerSdkDelivery({
    hasSession: sdk.sdkHasSession,
    send: async (wsId, text, peerOrigin) => { await sdk.sdkSend(wsId, text, undefined, peerOrigin); },
    sendAwaitingStart: async (wsId, text, peerOrigin, timeoutMs) => {
      sendCalls++;
      await holdGate;
      return sdk.sdkSendAwaitingStart(wsId, text, peerOrigin, timeoutMs);
    },
    start: (wsId, text) => sdk.sdkWake(wsId, text),
    stop: sdk.sdkStop,
  });
}

const keepalive = setInterval(() => {}, 250);
// sdkSend lazily starts the session (ensureSession) and delivers the kickoff as
// its opening turn. Its `result` is the first turn boundary the re-drive fires on.
await sdk.sdkSend(WS_ID, KICKOFF);
if (arm.holdDelivery) {
  // #0/#1 dispatch nothing; #2 dispatches the re-drive (held); #3, 80 ms on, must be blocked by the guard.
  // Give #3 ample time, THEN open the latch.
  await new Promise((r) => setTimeout(r, 600));
  releaseHold();
}
// Give the boundary re-drives time to fire and land as broadcasts.
await new Promise((r) => setTimeout(r, 1500));
clearInterval(keepalive);
await sdk.sdkStop?.(WS_ID)?.catch?.(() => {});

// Count user-message broadcasts per parked body (the kickoff body is excluded
// by construction — it is not a parked body).
const counts = Object.fromEntries(
  BODIES.map((b) => [b, userMessages.filter((m) => m.text.includes(b)).length]),
);
const remaining = tray.readInbox(WS_ID).map((b) => b.text.trim());
const dupes = BODIES.filter((b) => counts[b] > 1);
const kickoffBroadcasts = userMessages.filter((m) => m.text.includes(KICKOFF)).length;

// F2 arm: the guard must have held the 2nd dispatch → EXACTLY one delivery call.
const heldOk = !arm.holdDelivery || sendCalls === 1;
const ok = heldOk && (arm.emitKickoffResult
  // FIX: every parked body broadcast EXACTLY ONCE, and the inbox is empty.
  ? BODIES.every((b) => counts[b] === 1) && remaining.length === 0
  // CONTROL (== unfixed shape): the boundary is never reached, so NOTHING is
  // re-driven — zero broadcasts, every block still parked.
  : BODIES.every((b) => counts[b] === 0) && remaining.length === BODIES.length);

console.log(JSON.stringify({
  arm: ARM, ok, counts, duplicates: dupes,
  parkedBefore, remainingAfter: remaining.length,
  kickoffBroadcasts, totalUserMessages: userMessages.length,
  ...(arm.holdDelivery ? { sendCalls } : {}),
}));
process.exit(ok ? 0 : 1);
