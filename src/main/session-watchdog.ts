// Self-healing session watchdog (issue #90, extended for the boot wedge in #174).
//
// ── Issue #174: the BOOT wedge (spawn → first turn is a product guarantee) ───
//
// A burst-spawned child on a heavy repo (large CLAUDE.md, many MCP servers) can
// wedge in the CLI's session INIT — `getContextUsage` times out — BEFORE it ever
// consumes the spawn's opening prompt. Measured 2026-09-21 on the metarepo: 5 of
// 6 burst spawns died this way, and only an app relaunch + a #172 rollback ever
// revived one. This shape escapes BOTH layers below, because both key on work
// QUEUED BEHIND a started session and the boot wedge has none — it has an opening
// turn that was accepted and never processed (the opening prompt is shifted off
// `session.queue`, leaving it empty, and lives in `sdkPendingPrompts`, not the
// inbox #88 counts). So layer 2b adds a proof-of-life detector
// (`decideBootWedge`, src/shared/session-wedge.ts): a live session that never
// emitted a stream message and has been silent for the whole window is recycled,
// and `recycleSession` re-delivers the opening prompt via `recoverPendingPrompts`.
// The discriminator is PROOF OF LIFE (a stream message was seen), never "prompts
// are live" (the #174 field guard's false positive) and never "inbox empty".
//
// The BAR for this ticket is "never", not "visible". Issue #88 already ships a
// sidebar badge that TELLS a human a workspace has parked work and has not
// taken a turn; this module's job is to make that telling unnecessary — when
// the stall signature fires, the app recycles the session itself and re-drives
// the parked messages, with no human in the loop.
//
// ── Why there are two layers, and why layer 2 is not redundant ──────────────
//
// Layer 1 (`sdkReleaseStrandedGate`, driven from here) fixes the mechanism I
// could actually prove from source: consume() releases `session.turnGate` on
// exactly one message type, so a turn whose stream never yields a `result`
// strands the prompt generator forever. See src/shared/session-wedge.ts.
//
// Layer 2 (this module's recycle path) never asks WHY. Both 2026-08-25 field
// occurrences are recorded as UNEXPLAINED — neither capture can discriminate a
// lost `result` from a very long turn, because both recovered on a LATER
// delivery and a later delivery does not itself release the gate. A fix that
// depended on identifying the cause would therefore only cover the shapes
// already seen. Layer 2 is what makes "never" survive a mechanism layer 1 does
// not model.
//
// ── Why detection is DELEGATED to #88 rather than re-derived ────────────────
//
// `decideQueueStall` (src/shared/queue-stall.ts, shipped by #88) already
// encodes every false-positive guard this watchdog needs: something must be
// parked, the workspace must not be `running`, must not be hibernated, must not
// have an already-explained stop reason, and the age is floored at
// `observableSince` so the app's own downtime is never counted as stall time.
// A second, independently-drifting copy of that policy is precisely how a
// healthy agent eventually gets recycled — so there is exactly one detector,
// and this module consumes its verdict.
//
// BUT #88's VERDICT IS NECESSARY, NOT SUFFICIENT (review R1). An earlier
// version of this module argued that reusing #88's guards was enough because
// they "already encode every false-positive guard this watchdog needs". That is
// true for a badge and FALSE for a destructive act: `recycleSession` calls
// `sdkStop`, which calls `session.q.interrupt()`. Worse, the guard being leaned
// on — `status !== 'running'` — is documented as unreliable in queue-stall.ts
// itself (`store.load()` floors every `running`/`waiting` to `idle`; 3–5
// workspaces measured reading idle while healthy on 2026-08-25), and `waiting`
// is the DESIGNED status for a permission block, so a human about to click
// Allow would have lost the turn. The recycle path therefore carries its own
// progress evidence (`lastStreamAt`) and refuses any session that emitted
// inside the silence window, whatever its status says.
//
// The one thing #88 could NOT give us is where it runs: its badge is derived in
// the renderer (`QueueStallBadge.tsx` holds `OBSERVABLE_SINCE = Date.now()` as
// a module constant). That is right for a badge — a badge nobody is looking at
// need not exist — but wrong for a watchdog, which must act with no window open
// and must not act N times when N windows are open. So this runs main-side,
// single-writer, on one timer.

import { store } from './store';
import { log } from './logger';
import { platform } from './platform';
import type { Workspace } from '../shared/types.ts';
import { workspaceQueueStall, type QueueStallVerdict } from '../shared/queue-stall.ts';
import {
  decideBootWedge,
  decideBootHeal,
  decideSessionRecycle,
  pruneRecycles,
  BOOT_SILENCE_MS,
  GATE_SILENCE_RELEASE_MS,
  MAX_BOOT_RESTARTS,
  type RecycleDecision,
} from '../shared/session-wedge.ts';
import { bootWedgeEscalationBody } from '../shared/bus-liveness.ts';
import { sdkSessionLive } from './sdk-delivery';
import {
  recoverPendingPrompts,
  sdkGateProbe,
  sdkReleaseStrandedGate,
  sdkStop,
  sdkMarkAutoRestart,
  sdkTranscriptBytes,
  sdkWake,
} from './agent-sdk';
import { getBus, send } from './bus.ts';
import { busSwitch } from './bus-runs.ts';
import { pauseRefusal } from './pause-gate.ts';
import { killKeeper } from './keeper-client';
import { readInbox, releaseInboxBlock } from './inbox-tray';
import { normalizePendingPrompts } from '../shared/pending-prompts.ts';

// ─── Boot-heal escalation seam (issue #197) ─────────────────────────────────
//
// The escalation must name the workspace's WAVE run (its `$ORCHESTRA_RUN_ID`
// anchor) so the row lands in the run the coordinator's `orchestra check` reads.
// `resolveWaveRunId` lives in `workspaces.ts`, which — like the liveness roster's
// store seam — reaches the platform directory-import the strip-types test runner
// cannot resolve, so importing it here would make this module untestable under
// `pnpm run test`. It is INJECTED at boot (index.ts) with the real resolver; the
// default falls back to the CLI's own `'default'` run, the coexistence-safe value
// (a `busSwitch` for an unknown run reads OFF → counted, never a wrong-run fire).
let resolveRunId: (ws: Workspace) => string = () => 'default';

/** Wire the wave-run resolver (index.ts) or a rig's. */
export function setBootWedgeRunResolver(fn: (ws: Workspace) => string): void {
  resolveRunId = fn;
}

/** Opening prompts still owed a turn for this workspace (`ws.sdkPendingPrompts`),
 *  read from the store through the shared normalizer so a legacy shape counts
 *  the same as the current one. Used by both the boot-wedge detector and the
 *  recycle heal — after `sdkStop` there is no live session to probe, so this
 *  reads the DURABLE store field, which sdkStop deliberately does not clear. */
function normalizePendingPromptCount(wsId: string): number {
  return normalizePendingPrompts(store.getWorkspace(wsId)?.sdkPendingPrompts).length;
}

/** How often the watchdog looks. Deliberately slow: the condition it treats is
 *  measured in tens of minutes (#88's threshold is 15), so a fast tick buys
 *  nothing and a slow one keeps the steady-state cost at a store scan. */
const TICK_MS = 60_000;

/** The main process's own "since when could I observe a turn start" stamp — the
 *  main-side counterpart of QueueStallBadge's `OBSERVABLE_SINCE`.
 *
 *  Load-bearing, not a refinement (this is #88's review-88 R1 finding, and it
 *  applies with MORE force here because this module ACTS rather than renders):
 *  `lastTurnStartAt` persists across a restart but the `status` it pairs with
 *  does not — `store.load()` floors every `running` to `idle`. Without this
 *  floor, the first tick after an overnight restart would see every workspace
 *  holding parked mail as "stalled 14h" and recycle the entire fleet at once. */
let observableSince = Date.now();

/** Per-workspace ledger of automatic recycles, for the anti-flap budget. In
 *  memory only and that is correct: the budget asks "is this workspace flapping
 *  RIGHT NOW", and a restart is itself the strongest possible break in the
 *  flap — the wedge cannot survive one (`promptStream`'s `turnInFlight` is a
 *  local that starts null in a fresh session). */
const recycleLedger = new Map<string, number[]>();

/** Gate observations from the PREVIOUS tick, so a release can prove the SAME
 *  turn was silent across two samples separated by TICK_MS. One sample cannot
 *  distinguish "wedged" from "between messages". */
const lastGateSeen = new Map<string, string | null>();

/** Workspaces currently in the flap-limit STOOD-DOWN state (issue #97, review
 *  F1). The flap-limit branch does not recycle, touch the ledger, or change
 *  `ws.status` — so without this a stood-down workspace re-enters the branch on
 *  EVERY 60s tick and re-fires the (non-focus-suppressed) OS toast + broadcast
 *  for the whole ~54-tick window: a toast STORM, where the pre-#97 code only
 *  repeated a benign `log.error`. The surface must fire ONCE on the transition
 *  into stand-down and stay quiet until the workspace recovers.
 *
 *  Cleared when `inWindow` drops back below the budget (a recycle aged out of
 *  the rolling window, so the watchdog may auto-heal again) — the NEXT time the
 *  budget is spent is a fresh transition and surfaces again. */
const stoodDown = new Set<string>();

/** Issue #197 — per-workspace count of CONSECUTIVE failed FRESH starts of the
 *  SAME session (each a boot-wedge recycle that produced no proof of life). The
 *  watchdog increments it on every boot-wedge recycle and RESETS it to zero the
 *  moment the session emits a first stream message (`firstMessageSeen === true`)
 *  — genuine proof of life, so a session that recovers on restart k<N is never
 *  escalated (its first message zeroes the count before it can reach the bound).
 *  In memory only, like `recycleLedger`: a fresh session starts the count at 0,
 *  and the count only means anything while the SAME never-started session is
 *  being retried. */
const bootRestartLedger = new Map<string, number>();

/** Issue #197 — workspaces already escalated for a boot-wedge give-up, so the
 *  escalation + the visible-wedged mark fire EXACTLY ONCE on the transition into
 *  the wedged state, not every 60 s tick (the same edge-trigger `stoodDown`
 *  gives the flap-limit toast). Cleared when the count resets on proof of life. */
const bootEscalated = new Set<string>();

let timer: NodeJS.Timeout | null = null;

/** Persist a workspace patch and broadcast it, mirroring agent-sdk's private
 *  `persistWorkspacePatch` (which is not exported). Used to set/clear the visible
 *  `bootWedgedSince` marker. Best-effort: a persist failure is logged, never
 *  thrown into the tick. */
async function patchWorkspace(wsId: string, patch: Partial<Workspace>): Promise<void> {
  const ws = store.getWorkspace(wsId);
  if (!ws) return;
  const updated = { ...ws, ...patch };
  await store
    .upsertWorkspace(updated)
    .catch((err) => log.warn(`session-watchdog: persist patch failed for ${wsId}`, err));
  platform.broadcast('workspace:update', updated);
}

/** Issue #197 — the boot-heal counter has been reset because the session showed
 *  proof of life (a first stream message) or was torn down for good: drop the
 *  count, clear the escalate-once guard, and unset the visible-wedged marker if
 *  it was set. Idempotent — safe to call on every tick where the count is 0. */
function clearBootHealState(wsId: string): void {
  const hadCount = bootRestartLedger.has(wsId);
  bootRestartLedger.delete(wsId);
  bootEscalated.delete(wsId);
  const ws = store.getWorkspace(wsId);
  if (ws?.bootWedgedSince != null) {
    void patchWorkspace(wsId, { bootWedgedSince: null });
  } else if (hadCount) {
    log.info(`session-watchdog: ${wsId} showed proof of life — boot-heal count reset (issue #197)`);
  }
}

/** Issue #197 — the workspace reached the bound of consecutive failed fresh
 *  starts: STOP restarting, mark it visibly WEDGED, and emit ONE bus `escalation`
 *  row to its coordinator carrying the diagnostic D2 requires (restart count,
 *  last error, transcript size). Edge-triggered via {@link bootEscalated} so it
 *  fires once per wedge, not every tick.
 *
 *  The escalation reuses the EXISTING `escalation` kind + the `send` verb — the
 *  app's own escalation path (#120's `bus-liveness.ts writeEscalation`), never a
 *  hand-written insert into `~/.orchestra/bus.sqlite`. It is SWITCH-GATED on the
 *  run's frozen `liveness` flag (the escalation mechanism switch, #118): fired
 *  when ON, only logged when OFF — the coexistence-safe default, exactly like the
 *  liveness sweep. Tolerates `getBus() === null` (D1): logs and returns, never
 *  throws into the tick. */
async function escalateBootWedge(
  ws: Workspace,
  restartCount: number,
  lastError: string,
  now: number,
): Promise<void> {
  // Mark visibly wedged FIRST (a durable store surface the human sees even if the
  // bus is down), then escalate to the coordinator.
  await patchWorkspace(ws.id, { bootWedgedSince: now });

  const coordinator = ws.parentId ? store.getWorkspace(ws.parentId) : undefined;
  const coordinatorId = coordinator && !coordinator.archived ? coordinator.id : null;
  const transcriptBytes = sdkTranscriptBytes(ws.id);

  log.error(
    `session-watchdog: ${ws.id} WEDGED — ${restartCount} consecutive failed fresh starts, ` +
      `STOPPING auto-restart (issue #197). Last error: ${lastError}; transcript ${transcriptBytes} bytes`,
  );

  if (!coordinatorId) {
    // A standalone workspace (or one whose parent was deleted) has nobody to
    // escalate to. The visible-wedged mark above is still the human's surface;
    // there is no coordinator row to write.
    log.warn(`session-watchdog: ${ws.id} wedged but has no live coordinator to escalate to`);
    return;
  }

  const db = getBus();
  if (!db) {
    log.warn(`session-watchdog: no bus — ${ws.id} wedge not escalated to ${coordinatorId}`);
    return;
  }
  const runId = resolveRunId(ws);
  let switchOn = false;
  try {
    switchOn = busSwitch(db, runId, 'liveness');
  } catch (e) {
    log.warn(`session-watchdog: liveness switch read failed for ${ws.id} — treating as OFF`, e);
  }
  const body = bootWedgeEscalationBody(ws.id, restartCount, lastError, transcriptBytes);
  if (!switchOn) {
    // COUNTED, not FIRED: the coexistence-safe default while the escalation
    // mechanism is OFF for the run — the flap-limit toast (surfaceFlapLimit) and
    // the visible-wedged mark remain the human-facing surface.
    log.info(
      `session-watchdog: would have escalated ${ws.id} → ${coordinatorId} ` +
        `(wedged; liveness switch OFF — counted, not fired)`,
    );
    return;
  }
  try {
    send(db, {
      runId,
      sender: ws.id,
      recipient: coordinatorId,
      kind: 'escalation',
      body,
    });
    log.info(`session-watchdog: escalated wedged ${ws.id} → ${coordinatorId} (issue #197)`);
  } catch (e) {
    // D1: a bus write failure logs and returns. The escalate-once guard is set by
    // the CALLER only after this resolves, so a failed write re-arms next tick.
    log.warn(`session-watchdog: failed to escalate wedged ${ws.id} → ${coordinatorId}`, e);
    throw e;
  }
}

/** Recycle ONE wedged session: stop it, then wake it on the SAME conversation
 *  and re-drive whatever was parked.
 *
 *  ## Resume, never clear
 *
 *  `sdkWake` resumes `ws.sdkSessionId`, so the agent comes back with its
 *  context intact. A watchdog that silently started a FRESH conversation to
 *  clear a stall would destroy the very work the stall was blocking — strictly
 *  worse than the stall. That is the single most important property here.
 *
 *  ## Re-delivery goes through the existing confirmed-start path
 *
 *  Parked messages are released with `releaseInboxBlock`, which removes a block
 *  from the inbox ONLY on a confirmed `'started'` (issue #57's honesty bar).
 *  So a re-delivery that does not actually become a turn leaves the message
 *  parked and durable, and the next tick tries again. The failure mode of this
 *  function is "the message stays where it was", never "the message is gone". */
/** The wake prompt. Deliberately carries NO parked message content (review R2):
 *  anything sent through `sdkWake` bypasses the inbox entirely, so putting a
 *  parked message here would deliver it while leaving its block on disk for the
 *  woken turn's hook to drain a second time. Its only job is to bring the
 *  session up so `releaseInboxBlock` has somewhere to release into. */
/** How long to let the wake turn's `UserPromptSubmit` hook drain land before
 *  reading the inbox to decide what still needs releasing (review R2 residual).
 *
 *  This is a RACE-LOSER, not a correctness bound: the hook drain and this
 *  loop are two legitimate delivery paths for the same block, and the cheapest
 *  way to guarantee exactly-once is to let the already-in-flight one win.
 *  If the grace is too short the loop simply falls back to what it read, and
 *  `releaseInboxBlock`'s own 'gone' check still prevents removing a block the
 *  hook handled — the cost of being wrong here is a retry on the next tick,
 *  never a lost message. UNBASELINED; chosen as a short human-imperceptible
 *  pause on a path that only runs after a multi-minute stall. */
const INBOX_DRAIN_GRACE_MS = 250;

const WAKE_PROMPT =
  'Your session was automatically restarted because it had stopped starting turns ' +
  'while messages were waiting (Orchestra issue #90). Any messages parked for you ' +
  'are being re-delivered now — continue from where you left off.';

/** Exported for the R2 rig (`scripts/e2e-session-wedge-redelivery.mjs`), which
 *  drives the REAL recycle against a REAL inbox file to prove each parked
 *  message is delivered EXACTLY ONCE. */
export async function recycleSession(
  wsId: string,
  reason: string,
  trigger: 'watchdog-boot' | 'watchdog-stall' = 'watchdog-stall',
): Promise<void> {
  log.warn(`session-watchdog: recycling wedged session ${wsId} — ${reason} (issue #90)`);
  // Visible, not silent: the neutral auto-restart row names why (2026-09-23).
  await sdkMarkAutoRestart(wsId, trigger).catch((e) =>
    log.warn(`session-watchdog: could not mark auto-restart for ${wsId}`, e),
  );

  // 1. Tear the wedged session down. This also releases the stranded gate
  //    (sdkStop calls `session.turnGate?.()`) and settles every queued turn as
  //    dropped, so no sender is left holding a receipt for a message that dies
  //    here — the senders' messages are already durable in the inbox, which is
  //    how they got parked in the first place.
  //
  //    #172 rollback rides along here: sdkStop settles the wedged session's
  //    queued turns as dropped, and each unstarted-turn discard site calls
  //    `rollbackWakeForWithdrawnTurn` — so if the wedged turn was a bus WAKE
  //    ORDER, its ledger mark is rolled back and the next sweep re-fires,
  //    breaking the #159 `already-woken` latch the boot wedge otherwise leaves.
  await sdkStop(wsId).catch((e) => log.warn(`session-watchdog: stop failed for ${wsId}`, e));

  // 1b. Await the keeper PROCESS actually dying before the redelivery/wake below
  //     spawns a replacement (audit D1, modeled on sdkMcpRefresh). `sdkStop` on
  //     a session that HAD produced a result rides the graceful close (stdinEnd
  //     → keeper escalation) and RETURNS before the CLI has exited — the
  //     0.5–15s window in which the old recycle's `sdkWake` reattached to the
  //     dying CLI and the wake prompt was dropped (13/13 field recycles). (For a
  //     never-started wedge, sdkStop already awaits killKeeper via !sawResult;
  //     this covers the started-then-stalled case and is idempotent.) killKeeper
  //     resolves only once the keeper pid is gone, so ensureSession (inside the
  //     redelivery / sdkWake) then launches a genuinely fresh CLI.
  await killKeeper(wsId).catch((e) => log.warn(`session-watchdog: killKeeper failed for ${wsId}`, e));

  // 2. Re-deliver the OPENING PROMPT (issue #174), if one is still owed a turn.
  //
  //    ## Why this is separate from the inbox path
  //
  //    A BOOT-wedged spawn never got its opening prompt into the inbox: the
  //    spawn path (`sdkStartAndDeliver` → `sdkWake` → `sdkSend`) queues the
  //    prompt directly onto the session and records it in `ws.sdkPendingPrompts`
  //    as crash-recovery insurance — it is NOT a durable inbox block. sdkStop
  //    does not clear `sdkPendingPrompts`, so after the teardown the opening
  //    prompt still lives there, owed a turn nothing will start.
  //
  //    `recoverPendingPrompts` is the EXISTING, honest re-delivery for exactly
  //    this: it re-sends each pending prompt through `sdkSend` (which lazy-starts
  //    a FRESH session, resuming `ws.sdkSessionId`), tagged with its origin, and
  //    cancels any the transcript already consumed. With no live session after
  //    the stop, `livePromptIds` is empty, so a boot-wedge prompt (never
  //    consumed) is correctly re-sent. An EMPTY history is passed because the
  //    consumed-multiset only needs to cancel prompts the transcript shows ran —
  //    a boot wedge ran none, so nothing cancels and the opening prompt is
  //    redelivered. This brings the fresh session UP, which the inbox release
  //    below then reuses. */
  const hadPending = normalizePendingPromptCount(wsId) > 0;
  if (hadPending) {
    await recoverPendingPrompts(wsId, []).catch((e) =>
      log.warn(`session-watchdog: opening-prompt recovery failed for ${wsId}`, e),
    );
  }

  // 3. Is there anything parked in the durable inbox?
  const parked = readInbox(wsId);
  if (parked.length === 0) {
    // A boot wedge with only an opening prompt (no inbox mail) is now healed:
    // step 2 brought the fresh session up and redelivered it. Nothing to release.
    log.info(
      `session-watchdog: ${wsId} had nothing in the inbox after stop — ` +
        `${hadPending ? 'opening prompt re-delivered, ' : ''}no inbox wake needed`,
    );
    return;
  }

  // 4. Bring the session up (if step 2 didn't already) with a NEUTRAL prompt
  //    that carries NO parked content, so the inbox blocks have somewhere to
  //    release into.
  //
  //    ## Why the wake prompt must not be a parked message (review R2)
  //
  //    The first cut woke with `sdkWake(wsId, parked[0].text)`. That path is
  //    `sdkWake` -> `sdkSend`, which NEVER touches the inbox — every `inbox`
  //    match in agent-sdk.ts is a comment. Only `releaseInboxBlock` removes a
  //    block. So the first message was delivered as a turn while its block
  //    stayed on disk, and that very turn's `UserPromptSubmit` hook then
  //    `cat`s AND `rm -f`s the WHOLE file (INBOX_INSTRUCTION_SCRIPT in
  //    workspaces.ts): the first message arrived TWICE, and every remaining
  //    block was destroyed without any confirmed delivery.
  //
  //    Re-delivery and removal must therefore be ONE ordered operation, and
  //    `releaseInboxBlock` is the only thing that provides it. The wake prompt
  //    exists solely to bring the session up so blocks can be released into it.
  //    Skipped when step 2 already started the session by re-delivering the
  //    opening prompt: a second neutral turn would be redundant noise, and the
  //    inbox release below drives the now-live session directly.
  if (!sdkSessionLive(wsId)) {
    try {
      await sdkWake(wsId, WAKE_PROMPT);
    } catch (e) {
      log.warn(`session-watchdog: wake failed for ${wsId} — messages remain parked`, e);
      return;
    }
  }

  // 4. Release whatever the WAKE TURN'S OWN HOOK DRAIN did not already take.
  //
  //    ## The snapshot boundary (review R2 residual) — why this re-reads
  //    ## on EVERY iteration and yields between them
  //
  //    The wake turn runs `UserPromptSubmit`, whose INBOX_INSTRUCTION_SCRIPT
  //    `cat`s and `rm -f`s the WHOLE inbox file. That drain is a LEGITIMATE
  //    delivery — the agent really does see those blocks — and it is
  //    asynchronous with respect to this loop.
  //
  //    The previous cut called `readInbox(wsId)` ONCE, in the `for…of` head.
  //    A `for…of` evaluates its iterable a single time, so that snapshot was
  //    taken before the drain landed and the loop then released a block the
  //    hook was about to show too: MEASURED 3/3 deterministic, ALPHA delivered
  //    twice with `remaining:0` (`/tmp/residual-real.mjs`, 2026-08-26). The
  //    comment there claimed the re-read avoided exactly this and was wrong.
  //
  //    Neither this loop nor the hook is individually incorrect — they compose
  //    wrong at the snapshot boundary. So the loop now re-reads the file before
  //    EVERY release and yields first, letting the drain (which is the cheaper,
  //    already-in-flight delivery) win the race. `releaseInboxBlock` is still
  //    the only remover, so a block that survives the drain is delivered
  //    exactly once, and a block that does not start stays parked for the next
  //    tick. The failure mode remains "the message stays where it was", never
  //    "the message is gone".
  //
  //    Bounded by the block count so a pathological re-appearing block cannot
  //    spin: each pass either releases one block or stops.
  const maxReleases = parked.length;
  for (let i = 0; i < maxReleases; i++) {
    // Yield first: give the wake turn's hook drain a chance to land before we
    // read, so we observe the post-drain state rather than racing it.
    await new Promise((r) => setTimeout(r, INBOX_DRAIN_GRACE_MS));
    const remaining = readInbox(wsId);
    if (remaining.length === 0) break; // the hook drained everything — done.
    const out = await releaseInboxBlock(wsId, remaining[0].text).catch(() => null);
    if (!out?.ok) {
      // 'gone' means the hook took it while we were delivering — that is a
      // successful delivery by the other path, not a failure. Either way we
      // stop: the next watchdog tick re-evaluates from the real file.
      log.info(
        `session-watchdog: ${wsId} stopping re-delivery (${out?.ok === false ? out.reason : 'error'})`,
      );
      break;
    }
  }
}

/** Surface a flap-limit stand-down to the human (issue #97).
 *
 *  Two channels, both human-visible and neither gated on a window being open:
 *   • `platform.broadcast('watchdog:flap-limit', …)` — a dedicated event any
 *     attached view can badge/toast from. Kept distinct from `workspace:update`
 *     so a view can react to the stand-down specifically rather than diffing an
 *     opaque workspace patch.
 *   • `platform.notify(…)` — an OS-level toast, the same surface `fireNeedsInput`
 *     uses. This is the one watchdog outcome that genuinely needs a human: the
 *     automatic repair has exhausted its budget and given up. Unlike
 *     `fireNeedsInput` this is NOT suppressed when the window is focused — a
 *     stand-down is rare and load-bearing enough that a focused human should
 *     still get the toast; the broadcast covers the in-app surface either way.
 *
 *  Exported for the flap-budget rig so the surface can be asserted directly
 *  (carry-forward 2: the marker must be as specific as the claim). */
export function surfaceFlapLimit(
  wsId: string,
  wsName: string,
  recyclesInWindow: number,
  stalledForMin: number,
): void {
  platform.broadcast('watchdog:flap-limit', {
    workspaceId: wsId,
    recyclesInWindow,
    stalledForMin,
  });
  platform.notify({
    wsId,
    // `needsInput`: the flap-limit stand-down is "this workspace needs a human"
    // (review F3 — a distinct kind would be inert; electron.ts renders all kinds
    // the same). The surface distinction is in the title/body.
    kind: 'needsInput',
    title: 'Auto-repair gave up — needs you',
    body:
      `${wsName} stalled ${stalledForMin}min and was auto-restarted ` +
      `${recyclesInWindow}x this hour without recovering. Orchestra has stopped ` +
      `retrying — it needs a human.`,
  });
}

/** One pass over every workspace. Exported for the E2E rig, which drives ticks
 *  explicitly rather than waiting out real minutes. */
export async function watchdogTick(now: number = Date.now()): Promise<void> {
  for (const ws of store.workspaces) {
    if (ws.archived) continue;

    // ── #252 fleet PAUSE (ledger #261 rows 25/26/27) ─────────────────────────
    // A paused run's member is SKIPPED whole: no stranded-gate release (layer 1 lets the queue drain = a turn start), no recycle /
    // boot-wedge restart (layer 2 = stop-then-start; checked here so it can never stop a session and then be refused), and no
    // boot-wedge give-up escalation (SILENCE — the pause is the operator's own act). Nothing is mutated while paused (no ledger,
    // no marks), so the lift resumes from a clean slate.
    if (pauseRefusal(ws, 'auto')) continue;

    // ── Layer 1: a stranded gate, released non-destructively ────────────────
    //
    // Done FIRST and independently of the stall verdict: releasing a stranded
    // gate is cheap, loses nothing, and may fix the workspace before it is ever
    // old enough to qualify as stalled. Requires the SAME turn to have been
    // observed holding the gate on the previous tick.
    const probe = sdkGateProbe(ws.id);
    if (probe) {
      const seen = lastGateSeen.get(ws.id) ?? null;
      if (probe.gateHeld && seen !== null && seen === probe.turnUuid) {
        if (sdkReleaseStrandedGate(ws.id, seen)) {
          // The queue can drain now; give it this tick to do so before
          // considering the heavier recycle.
          lastGateSeen.set(ws.id, probe.gateHeld ? probe.turnUuid : null);
          continue;
        }
      }
      lastGateSeen.set(ws.id, probe.gateHeld ? probe.turnUuid : null);
    } else {
      lastGateSeen.delete(ws.id);
    }

    // ── Layer 2: cause-agnostic recycle ─────────────────────────────────────
    // Through #88's OWN adapter, not a hand-rolled field mapping: it is what
    // knows that `hibernated` means `hibernatedAt !== undefined` and that an
    // archived workspace's status is a frozen leftover. Re-deriving that here
    // would be the second drifting copy this module exists to avoid.
    const stalled = workspaceQueueStall(ws, now, observableSince);

    const ledger = pruneRecycles(recycleLedger.get(ws.id) ?? [], now);
    if (ledger.length > 0) recycleLedger.set(ws.id, ledger);
    else recycleLedger.delete(ws.id);

    // Re-probe rather than reusing `probe` from the layer-1 block above: that
    // read happened before a possible gate release, and stale progress evidence
    // on a DESTRUCTIVE path is exactly the class review R1 caught.
    const progress = sdkGateProbe(ws.id);

    // ── Issue #197: the boot-heal counter RESET, on genuine proof of life ─────
    //
    // A session that emitted a first stream message got past init — the fresh
    // start that produced it SUCCEEDED. So a session that recovers on restart
    // k<N zeroes its consecutive-failed-start count here, BEFORE any recycle
    // decision, and can never reach the escalation bound (the ticket's "recovers
    // on restart k<N is NOT escalated" arm). This ALSO clears the visible-wedged
    // marker if a wedged session later came back to life on a manual Relancer.
    // Keyed on `firstMessageSeen` (proof of life) — never "prompts are live",
    // never "inbox empty" — the same discriminator decideBootWedge turns on.
    if (progress?.firstMessageSeen) clearBootHealState(ws.id);
    // A workspace with no live session at all is not mid-boot-heal; drop any
    // stale count so a future spawn starts clean (a torn-down session cannot be
    // the "same session" the count tracks).
    else if (!sdkSessionLive(ws.id)) clearBootHealState(ws.id);

    // ── Layer 2b: the BOOT wedge (issue #174) ───────────────────────────────
    //
    // A session that accepted its opening turn but never emitted a single
    // stream message (proof of life) and has been silent for the whole window
    // is wedged in CLI init — the shape #88's queue-stall detector cannot see,
    // because the opening prompt is in `session.queue`/`sdkPendingPrompts`, not
    // in the banner queue or the inbox it counts. The verdict is
    // QueueStallVerdict-shaped so it feeds the SAME `decideSessionRecycle`
    // below, inheriting its anti-flap budget, backoff, and progress refusal.
    //
    // `??` picks the boot-wedge verdict only when #88's stall verdict is null,
    // so `stalledForMs` telemetry follows the stall when both fire — ONE recycle
    // decision either way.
    //
    // NOT mutually exclusive (reviewer-restart/verifier F4 — the old comment here
    // wrongly claimed they were): a never-started session (firstMessageSeen false)
    // with parked INBOX mail trips BOTH — decideBootWedge on the session clock
    // (3 min) AND decideQueueStall on the workspace-creation clock (its
    // `lastTurnStartAt` is undefined → falls back to `createdAt`, so a >15-min-old
    // workspace with a parked peer message stalls immediately). That co-fire is
    // exactly why the recycle WINDOW below keys on `bootWedge` PRESENCE, not on
    // which reason won `recycleReason` — see the `silenceMs` choice.
    const bootWedge: QueueStallVerdict | null = progress
      ? decideBootWedge({
          sessionLive: sdkSessionLive(ws.id),
          firstMessageSeen: progress.firstMessageSeen,
          turnInFlight: progress.gateHeld,
          pendingPromptCount: progress.pendingPromptCount,
          // REAL-STREAM clock, not `lastStreamAt` (issue #174 clock-pollution):
          // a boot-wedged session that keeps receiving bus-wake DELIVERIES has a
          // turn armed on each → `lastStreamAt` reset → the silence window never
          // elapses and the wedge never self-heals (field: ws 1a9ffb75 +
          // ba1040aa, repeated wake, zero heal). `lastStreamMessageAt` is bumped
          // ONLY by a genuine stream message, so turn-arming can't pollute it.
          lastStreamAt: progress.lastStreamMessageAt,
          // `stopping` is not exposed on the probe; a stopping session has no
          // gate held (sdkStop releases it), so `turnInFlight` already excludes
          // it. Pass false explicitly rather than guess.
          stopping: false,
          now,
          // BOOT case gets its OWN, shorter window (issue #180): a never-started
          // session heals at ~3 min, not the 10-min gate/stall constant. Layers
          // 1/2 keep their default. Dropping this override silently reverts the
          // heal to 10 min.
          silenceMs: BOOT_SILENCE_MS,
        })
      : null;
    // Issue #197 — the give-up, the counter, and the recycle telemetry all key on
    // the PRESENCE of a boot wedge, NOT on which detector "won" (reviewer-1bfa79ee
    // F1). A never-started session (firstMessageSeen===false) with parked INBOX
    // mail on a >15-min workspace trips BOTH detectors — decideBootWedge AND #88's
    // workspaceQueueStall — so `stalled` is truthy. Keying the give-up on a
    // stall-loses discriminator (`bootWedge && !stalled`) let that co-fire fall
    // through to the GENERIC #90/#97 flap-limit (an OS toast only), NEVER firing
    // the bus escalation D2 requires — the exact fleet-invisible surface #197
    // exists to kill (a wave member pinged by peers while its fresh CLI wedges is
    // the plausible field shape). A boot wedge is a boot wedge regardless of a
    // co-firing stall — the SAME precedence the `silenceMs: bootWedge ? ...`
    // window below already uses. Telemetry `stalledForMs` still follows the stall
    // via `stalled ?? bootWedge` in `decideSessionRecycle`; only the REASON label
    // follows the boot wedge.
    const isBootWedge = bootWedge !== null;

    const decision: RecycleDecision = decideSessionRecycle({
      sessionLive: sdkSessionLive(ws.id),
      stalled: stalled ?? bootWedge,
      // The recycle path carries its OWN progress evidence (review R1): #88's
      // `status` guard is a display field on a best-effort hook chain, and is
      // documented in queue-stall.ts as not surviving a restart. A session that
      // emitted anything inside the silence window is refused regardless of
      // what its status says.
      //
      // REAL-STREAM clock (issue #174 clock-pollution): the destructive-recycle
      // progress refusal must key on genuine stream output, NEVER a turn-arm —
      // otherwise a boot-wedge verdict (correctly fired on the un-polluted
      // decideBootWedge clock above) would be refused HERE because a wake-delivery
      // arm just reset `lastStreamAt`. Both the stall and boot-wedge paths feed
      // this one refusal, and "did real output happen in the window" is the right
      // question for both — a turn-arm is not progress.
      lastStreamAt: progress?.lastStreamMessageAt ?? null,
      // BOOT-WEDGE window whenever a boot wedge is PRESENT (issue #180 + #174 + F4):
      // decideBootWedge fires the verdict at BOOT_SILENCE_MS (3 min), but
      // decideSessionRecycle's OWN progress refusal (session-wedge.ts) would default
      // to the 10-min GATE_SILENCE_RELEASE_MS and REFUSE the recycle until 10 min —
      // masking #180's 3-min heal (Gate #4).
      //
      // KEY ON `bootWedge` PRESENCE, not on which reason "won" (reviewer-restart F4):
      // a never-started session (firstMessageSeen===false) CAN also qualify as a #88
      // stall — e.g. a boot-wedged coordinator with peer messages parked in its inbox.
      // Then `stalled` is truthy and `recycleReason` is 'stall', but the session STILL
      // never started, so the 3-min boot window is correct. Using `recycleReason ===
      // 'boot-wedge'` (≡ `bootWedge && !stalled`) re-masked exactly that co-fire back
      // to 10 min. A boot wedge is a boot wedge regardless of a co-firing stall.
      // The #88-ONLY stall path (`bootWedge` null) keeps the 10-min window — shrinking
      // it would recycle a slow-but-live parked agent at 3 min (regression). Telemetry
      // `stalledForMs` still follows the stall verdict via `stalled ?? bootWedge`
      // above; only the WINDOW follows bootWedge.
      silenceMs: bootWedge ? BOOT_SILENCE_MS : GATE_SILENCE_RELEASE_MS,
      recentRecycles: ledger,
      now,
    });

    // Any decision OTHER than flap-limit means the workspace is no longer stood
    // down (it recovered → `none`, or a recycle aged out of the window →
    // `recycle`/`backoff`). Clear the once-guard here so the NEXT time the budget
    // is spent counts as a fresh transition and surfaces again (review F1).
    if (decision.action !== 'flap-limit') stoodDown.delete(ws.id);

    // ── Issue #197: BOUND the boot-wedge recycle, then ESCALATE ──────────────
    //
    // A BOOT-WEDGE recycle is a FRESH start of the same never-started session.
    // After MAX_BOOT_RESTARTS consecutive ones with no proof of life, STOP
    // restarting, mark the workspace visibly wedged, and escalate ONCE to the
    // coordinator — instead of looping forever (the ~75 s × ∞ field loop).
    //
    // Placed BEFORE the #90/#97 anti-flap dispatch DELIBERATELY: the generic
    // flap-limit (`MAX_RECYCLES_PER_HOUR`) and this boot bound both = 3 and both
    // count the same recycles, so on the tick after the bound the generic path
    // would return `flap-limit` first — a human toast, but NO bus escalation and
    // NO visible-wedged mark. The boot wedge is a distinct, more actionable
    // failure (a fresh CLI that deterministically re-wedges), and D2 (ledger
    // #198) requires the fleet-visible `escalation` row the flap-limit lacks. So
    // for a boot wedge the #197 give-up takes precedence. Keyed on `isBootWedge`
    // (PRESENCE), never `recycleReason` — a co-firing #88 stall must not mask the
    // escalation (F1). A pure #88 stall (no boot wedge) keeps the flap-limit
    // surface below.
    if (isBootWedge) {
      const priorStarts = bootRestartLedger.get(ws.id) ?? 0;
      const heal = decideBootHeal({ consecutiveFreshStarts: priorStarts });
      if (heal.action === 'escalate') {
        // The bound is reached. Do NOT restart (a further fresh start would only
        // re-wedge). Escalate exactly once (edge-triggered via `bootEscalated`).
        if (!bootEscalated.has(ws.id)) {
          const stalledForMs = decision.action === 'recycle' || decision.action === 'flap-limit'
            ? decision.stalledForMs
            : now - (progress?.lastStreamMessageAt ?? now);
          const lastError =
            `boot wedge: opening turn never started (no stream in ` +
            `${Math.round(stalledForMs / 60_000)}min after ${heal.restartCount} fresh restarts, ` +
            `${progress?.pendingPromptCount ?? 0} prompt(s) owed a turn) — issue #197`;
          try {
            await escalateBootWedge(ws, heal.restartCount, lastError, now);
            // Mark escalated only on a completed escalation attempt (a bus-write
            // failure throws so the guard is NOT set and the next tick retries).
            bootEscalated.add(ws.id);
          } catch {
            // escalateBootWedge already logged; leave the guard clear to retry.
          }
        }
        continue;
      }
    }

    if (decision.action === 'none') continue;

    if (decision.action === 'backoff') {
      // UNDER budget, but the widening backoff interval since the last recycle
      // (issue #97) has not elapsed. NOT a stand-down and NOT surfaced: no
      // budget is spent and no human is needed — the next tick re-evaluates and
      // eventually crosses the interval. Logged at info for the field trail
      // only, so a flapping session's slowing cadence is legible in the log.
      log.info(
        `session-watchdog: ${ws.id} under budget (${decision.recyclesInWindow} this hour) but ` +
          `backing off ${Math.round(decision.waitMs / 1000)}s more before the next recycle (issue #97)`,
      );
      continue;
    }

    if (decision.action === 'flap-limit') {
      const minutes = Math.round(decision.stalledForMs / 60_000);
      // A stall log line every tick is benign; a NON-focus-suppressed OS toast
      // every tick is a storm (review F1). So the LOG is level-triggered (the
      // condition still holds, useful in the field trail) but the SURFACE is
      // EDGE-triggered — fired once on the transition into stand-down and quiet
      // until the workspace recovers (`stoodDown` cleared above on any other
      // decision). Without this the branch re-fires ~54 toasts/hr per stuck ws.
      log.error(
        `session-watchdog: ${ws.id} stalled ${minutes}min but ` +
          `already recycled ${decision.recyclesInWindow}x this hour — STANDING DOWN, needs a human (issue #90/#97)`,
      );
      if (!stoodDown.has(ws.id)) {
        stoodDown.add(ws.id);
        // A log line is not a surface (issue #97): the human is not watching the
        // main log, and #88's stall badge may be suppressed for this very ws.
        // Emit a dedicated broadcast (so a view can badge/toast it) AND an
        // OS-level notification — the ONE watchdog outcome that genuinely needs
        // a human, so it earns the same surface as `agent:needs-input`.
        surfaceFlapLimit(ws.id, ws.name, decision.recyclesInWindow, minutes);
      }
      continue;
    }

    // Issue #197 — this is a BOOT-WEDGE recycle under the bound (the give-up
    // short-circuit above already `continue`d at the bound), so it is one more
    // fresh start: count it. Keyed on `isBootWedge` PRESENCE (F1): a never-started
    // session with co-firing parked mail is still a boot wedge and its fresh
    // restart must be counted, or the bound never advances and the escalation
    // never fires. A pure #88 stall recycle does not go through a fresh start and
    // is not counted.
    if (isBootWedge) {
      bootRestartLedger.set(ws.id, (bootRestartLedger.get(ws.id) ?? 0) + 1);
    }

    recycleLedger.set(ws.id, [...ledger, now]);
    await recycleSession(
      ws.id,
      isBootWedge
        ? `boot wedge: opening turn never started (no stream in ${Math.round(decision.stalledForMs / 60_000)}min, ` +
            `${decision.parkedCount} prompt(s) owed a turn) — issue #174`
        : `${decision.parkedCount} parked, no turn start for ${Math.round(decision.stalledForMs / 60_000)}min`,
      isBootWedge ? 'watchdog-boot' : 'watchdog-stall',
    );
  }
}

/** Start the watchdog (idempotent). */
export function startSessionWatchdog(): void {
  if (timer) return;
  observableSince = Date.now();
  timer = setInterval(() => {
    void watchdogTick().catch((e) => log.warn('session-watchdog tick failed', e));
  }, TICK_MS);
  log.info('session-watchdog: started (issue #90)');
}

export function stopSessionWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  recycleLedger.clear();
  lastGateSeen.clear();
  stoodDown.clear();
  bootRestartLedger.clear();
  bootEscalated.clear();
}

/** Test/rig seam: reset the in-memory state so a rig can drive ticks from a
 *  known baseline instead of inheriting whatever a previous test left. */
export function __resetSessionWatchdogForTests(since: number = Date.now()): void {
  observableSince = since;
  recycleLedger.clear();
  lastGateSeen.clear();
  stoodDown.clear();
  bootRestartLedger.clear();
  bootEscalated.clear();
  resolveRunId = () => 'default';
}
