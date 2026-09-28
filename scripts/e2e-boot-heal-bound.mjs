// Issue #197 — BOUND the boot-wedge self-heal, then ESCALATE.
//
// Drives the REAL `watchdogTick` (src/main/session-watchdog.ts) against a REAL
// faked-CLI boot-wedged session through the REAL agent-sdk, over a REAL bus on a
// temp ORCHESTRA_HOME (G3: not a pure helper). The subject is a session whose
// query iterator NEVER emits a stream message — so `firstMessageSeen` stays
// false and `lastStreamMessageAt` stays at spawn: exactly a CLI wedged in init.
//
// The observables, taken from durable/real state, not from the new code's own
// counters:
//   • recycles  = how many times a FRESH session was spawned (the query factory
//                 is invoked on each `ensureSession` after a teardown). A recycle
//                 tears the wedged session down and re-delivers the opening
//                 prompt → a fresh spawn. So this counts boot-heal restarts.
//   • escalations = `kind='escalation'` rows the coordinator can read off the bus
//                 (`check`), the fleet-visible surface D2 requires.
//   • wedgedMark = the workspace's durable `bootWedgedSince` (the visible-wedged
//                 surface), read back from the store.
//
// Arms:
//   bounded — the FIX. Ticked well past the bound: exactly MAX_BOOT_RESTARTS
//             fresh restarts, then STOP; exactly ONE escalation; wedged mark set.
//   recovers — a session that recovers on restart k<N (its fresh CLI emits a
//             stream message on the k-th start): NEVER escalated, wedged mark
//             never set, counter reset. (The ticket's k<N arm.)
//   reset   — after escalation, the session finally comes to life (proof of
//             life): the counter resets, the wedged mark clears, and a LATER
//             wedge escalates AGAIN (a fresh episode), proving the reset is real.
//
// MUST-FAIL on master (same rig): master has no bound and no escalation path, so
// `bounded` sees recycles GROW with ticks (unbounded) and escalations === 0 —
// `ok:false`. The rig therefore reddens on the unfixed build.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'bounded';
const ARMS = {
  bounded: {},
  recovers: { reviveOnStart: 2 },
  reset: { reviveAfterEscalation: true },
  // F1 (reviewer-1bfa79ee): a never-started session that ALSO trips #88's stall
  // (parked INBOX mail on a >15-min workspace). Pre-fix, `stalled` wins →
  // recycleReason='stall' → the give-up (gated on recycleReason==='boot-wedge')
  // never fires → NO escalation, only the generic flap-limit toast. Post-fix the
  // give-up keys on `isBootWedge` PRESENCE, so the escalation fires anyway.
  co_fire: { parkedInboxCount: 2 },
};
const arm = ARMS[ARM];
if (!arm) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// Guarded temp home (same discipline as the R2 rig): env-overridable, so refuse
// any path outside the prefix before rm -rf.
const PREFIX = '/tmp/boot-heal-197-';
const tmpHomeRaw = path.join(process.env.WEDGE_HOME ?? '/tmp/boot-heal-197', ARM);
const tmpHome = path.resolve(tmpHomeRaw);
if (!tmpHome.startsWith(PREFIX) && tmpHome !== path.resolve('/tmp/boot-heal-197', ARM)) {
  console.error(`[boot-heal] refusing to remove unexpected path: ${tmpHomeRaw}`);
  process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const broadcasts = [];
initPlatform({
  kind: 'headless-boot-heal-197',
  broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
  broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-boot-heal', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const watchdog = await import(`${REPO}/src/main/session-watchdog.ts`);
const bus = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const wedge = await import(`${REPO}/src/shared/session-wedge.ts`);
// Degrade gracefully on an UNFIXED build (master): MAX_BOOT_RESTARTS does not
// exist there, so default the bound to 3 (D2). This lets the SAME rig run on
// master and go RED (unbounded restarts, 0 escalations) instead of crashing on a
// missing export — the honest must-FAIL shape (G1).
const BOUND = wedge.MAX_BOOT_RESTARTS ?? 3;
const BOOT_SILENCE_MS = wedge.BOOT_SILENCE_MS;

// ── Bus: open it, start the member's run with liveness ON so the escalation
//    FIRES (rather than being counted). Coordinator = OPS-of-run. ──────────────
bus.initBus(); // opens the boot bus at $ORCHESTRA_HOME/bus.sqlite
const db = bus.getBus();
if (!db) { console.error('[boot-heal] bus failed to open'); process.exit(3); }
const RUN_ID = 'RUN-197';
const COORD_ID = 'ws-coord-197';
const WS_ID = 'ws-wedged-197';
busRuns.startRun(
  db,
  { id: RUN_ID, kind: 'wave', coordinator: COORD_ID },
  { delivery: false, wake: false, askGate: false, liveness: true, fencing: false, capability: false, receipts: false },
);

await store.load?.();
// The coordinator (parent) the escalation is addressed to.
await store.upsertWorkspace({
  id: COORD_ID, name: 'coordinator', kind: 'orchestrator', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now(),
});
// The wedged member: parent = coordinator, so the roster resolves a coordinator.
// `lastTask` present (a dispatched member). createdAt 30min ago: for most arms
// #88's stall stays null (no parked mail), so the boot-wedge path fires alone.
// The `co_fire` arm ALSO seeds `parkedInboxCount` → #88's workspaceQueueStall
// ALSO fires (30min > 15min threshold) → `stalled` truthy: the F1 co-fire where
// a stall-loses discriminator would mask the escalation.
await store.upsertWorkspace({
  id: WS_ID, name: 'wedged-member', kind: 'scratch', repoPath: '',
  worktreePath: tmpHome, status: 'idle', createdAt: Date.now() - 30 * 60_000,
  parentId: COORD_ID, lastTask: 'do the thing',
  ...(arm.parkedInboxCount ? { parkedInboxCount: arm.parkedInboxCount } : {}),
});

// Wire the run resolver to always name our run (index.ts uses resolveWaveRunId).
// Optional-chained so the SAME rig runs on master (no such export) → escalation
// simply never fires there, the must-FAIL shape.
watchdog.__resetSessionWatchdogForTests?.(Date.now() - 30 * 60_000);
watchdog.setBootWedgeRunResolver?.(() => RUN_ID); // after reset (it clears the resolver)

// ── The faked CLI. A boot wedge: the iterator NEVER emits a stream message, so
//    consume() never sets firstMessageSeen / bumps lastStreamMessageAt. One
//    exception per arm (revive) emits a real message to model a fresh start that
//    finally gets past init. ──────────────────────────────────────────────────
let factoryCalls = 0; // = fresh spawns = boot-heal restarts + the initial start
let escalatedAlready = false;
sdk.__setQueryFactoryForTests(({ prompt }) => {
  const thisCall = ++factoryCalls;
  // DRAIN the prompt generator — this is what makes `promptStream` shift the
  // opening prompt off the queue and ARM the turn gate. A factory that ignores
  // `prompt` leaves the gate un-armed and the "boot wedge" never forms (the
  // exact vacuity that a first run of this rig hit). We consume it but emit
  // NOTHING back on the stream: a CLI that accepted the turn and wedged in init.
  void (async () => {
    try {
      for await (const _ of prompt) { /* accept the turn, then wedge (emit nothing) */ }
    } catch { /* torn down; expected */ }
  })();
  // `recovers`: the reviveOnStart-th fresh CLI comes to life (emits init).
  const reviveNow =
    (arm.reviveOnStart && thisCall === arm.reviveOnStart) ||
    (arm.reviveAfterEscalation && escalatedAlready);
  return {
    async *[Symbol.asyncIterator]() {
      if (reviveNow) {
        // Proof of life: a real stream message. Sets firstMessageSeen=true.
        yield { type: 'system', subtype: 'init', session_id: `s${thisCall}`, tools: [], slash_commands: [] };
        yield { type: 'result', subtype: 'success', session_id: `s${thisCall}`, is_error: false,
                num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'alive' };
      }
      // Then block forever (a wedged CLI never advances, or a revived one idles).
      await new Promise(() => {});
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
  };
});

function countEscalations() {
  // What the coordinator's `orchestra check` would surface: escalation rows in
  // the run addressed to the coordinator, about our member.
  const rows = db
    .prepare(`SELECT body FROM messages WHERE run_id=? AND kind='escalation' AND recipient=? AND sender=?`)
    .all(RUN_ID, COORD_ID, WS_ID);
  return rows;
}

// Arm the wedged session: send an opening prompt. The iterator blocks, so the
// turn gate stays armed and firstMessageSeen stays false — a boot wedge.
await sdk.sdkSend(WS_ID, 'OPENING PROMPT — do the thing');
// Let promptStream shift the opening prompt off the queue and ARM the turn gate
// (the yield is async), so gateHeld flips true while firstMessageSeen stays false.
await new Promise((r) => setTimeout(r, 100));

// Sanity: the session must be live, never-started, with a pending prompt — or
// the boot-wedge path can't fire and this rig would pass vacuously.
const probe0 = sdk.sdkGateProbe(WS_ID);
if (!probe0 || probe0.firstMessageSeen || !probe0.gateHeld || probe0.pendingPromptCount < 1) {
  console.log(JSON.stringify({ arm: ARM, ok: false, abort: 'subject is not a boot wedge', probe0 }));
  process.exit(3);
}

// Drive ticks. Advance the clock past BOOT_SILENCE_MS each tick so the wedge
// verdict fires; the boot-heal backoff (recycle backoff) is spaced too, so step
// the clock generously (an hour of headroom is fine — the wedge window is 3min).
const START = Date.now();
const escalationCounts = [];
const recyclesSeen = [];
const TICKS = BOUND + 4; // enough ticks that master (unbounded) keeps recycling
let now = START;
for (let i = 0; i < TICKS; i++) {
  now += Math.max(BOOT_SILENCE_MS + 60_000, 6 * 60_000); // past silence + backoff gap
  await watchdog.watchdogTick(now);
  // Let recoverPendingPrompts' fresh spawn settle so the next tick sees a live,
  // never-started session again.
  await new Promise((r) => setTimeout(r, 40));
  escalationCounts.push(countEscalations().length);
  recyclesSeen.push(factoryCalls);
  if (countEscalations().length > 0) escalatedAlready = true;
}

// For the `reset` arm: after the first escalation the revived flag is set, so the
// NEXT fresh start (a manual-ish revive) shows proof of life → counter resets →
// wedged mark clears. Then re-wedge (revive off) and drive more ticks to prove a
// second episode escalates again.
let secondEpisodeEscalated = null;
if (arm.reviveAfterEscalation) {
  // Revive: the session's next spawn emits proof of life. Trigger one recycle by
  // hand is unnecessary — the revive flag is already set, so drive a tick: the
  // reset branch fires on firstMessageSeen. But the CURRENT session is still the
  // wedged one (blocking). Recycle it once so a fresh (revived) session spawns.
  await watchdog.recycleSession(WS_ID, 'rig revive', 'watchdog-boot');
  await new Promise((r) => setTimeout(r, 60));
  now += 60_000;
  await watchdog.watchdogTick(now); // sees firstMessageSeen=true → clearBootHealState
  const afterRevive = store.getWorkspace(WS_ID)?.bootWedgedSince ?? null;
  // Now start a SECOND wedge episode: turn revive off, re-arm a wedged session.
  // Jump the clock past the #90 anti-flap window (1h) so the GENERIC recycle
  // budget (recycleLedger, MAX_RECYCLES_PER_HOUR) frees — otherwise episode 2's
  // fresh starts are flap-limited by the #90 budget spent in episode 1 and never
  // reach the boot bound. The #197 boot counter reset is independent (proof of
  // life cleared it), which `revivedClearedMark` already proves; this advance
  // isolates the SECOND-EPISODE escalation from the orthogonal #90 budget.
  now += 61 * 60_000;
  escalatedAlready = false;
  arm.reviveAfterEscalation = false; // subsequent spawns wedge again
  // Tear the revived (alive) session down so the next send spawns a FRESH one —
  // which, with revive off, wedges: a genuine second boot-wedge episode.
  await sdk.sdkStop(WS_ID);
  await new Promise((r) => setTimeout(r, 60));
  await sdk.sdkSend(WS_ID, 'SECOND EPISODE — wedge again');
  await new Promise((r) => setTimeout(r, 100));
  const before = countEscalations().length;
  for (let i = 0; i < BOUND + 2; i++) {
    now += 6 * 60_000;
    await watchdog.watchdogTick(now);
    await new Promise((r) => setTimeout(r, 40));
  }
  secondEpisodeEscalated = countEscalations().length > before;
  var revivedClearedMark = afterRevive === null;
}

const finalEscalations = countEscalations();
const wedgedMark = store.getWorkspace(WS_ID)?.bootWedgedSince ?? null;
// Recycles = fresh spawns beyond the initial start. factoryCalls counts the
// initial sdkSend spawn + each recycle's re-delivery spawn.
const totalRestarts = factoryCalls - 1;

let ok;
if (ARM === 'bounded' || ARM === 'co_fire') {
  // FIX: exactly BOUND restarts, then STOP; exactly ONE escalation; mark set.
  // The escalation-count series must PLATEAU at 1 (not grow), and restarts must
  // not exceed the bound (master would exceed it and escalate 0 times).
  //
  // `co_fire` is the SAME assertion with parked INBOX mail seeded, so #88's stall
  // ALSO fires: pre-fix the escalation was masked (recycleReason='stall'), so on
  // master this arm reads finalEscalations:0 / wedgedMark:false → ok:false (the
  // F1 must-FAIL). Post-fix the give-up keys on `isBootWedge` PRESENCE, so it
  // fires exactly as `bounded` does.
  ok =
    totalRestarts === BOUND &&
    finalEscalations.length === 1 &&
    wedgedMark !== null &&
    finalEscalations[0].body.includes(String(BOUND));
} else if (ARM === 'recovers') {
  // k<N recovery: proof of life on the reviveOnStart-th start → NEVER escalated,
  // mark never set. Restarts capped below the bound (recovered before reaching it).
  ok = finalEscalations.length === 0 && wedgedMark === null && totalRestarts < BOUND;
} else {
  // reset: an escalation happened in episode 1, the revive cleared the mark, and
  // a SECOND wedge episode escalated AGAIN (the counter genuinely reset).
  ok = revivedClearedMark === true && secondEpisodeEscalated === true;
}

console.log(JSON.stringify({
  arm: ARM,
  ok,
  bound: BOUND,
  totalRestarts,
  escalationSeries: escalationCounts,
  finalEscalations: finalEscalations.length,
  escalationBody: finalEscalations[0]?.body ?? null,
  wedgedMarkSet: wedgedMark !== null,
  ...(ARM === 'reset' ? { secondEpisodeEscalated, revivedClearedMark } : {}),
}));
process.exit(0);
