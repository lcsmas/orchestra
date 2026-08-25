// Self-healing session watchdog (issue #90).
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
import { workspaceQueueStall } from '../shared/queue-stall.ts';
import {
  decideSessionRecycle,
  pruneRecycles,
  type RecycleDecision,
} from '../shared/session-wedge.ts';
import { sdkSessionLive } from './sdk-delivery';
import { sdkGateProbe, sdkReleaseStrandedGate, sdkStop, sdkWake } from './agent-sdk';
import { readInbox, releaseInboxBlock } from './inbox-tray';

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

let timer: NodeJS.Timeout | null = null;

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
const WAKE_PROMPT =
  'Your session was automatically restarted because it had stopped starting turns ' +
  'while messages were waiting (Orchestra issue #90). Any messages parked for you ' +
  'are being re-delivered now — continue from where you left off.';

/** Exported for the R2 rig (`scripts/e2e-session-wedge-redelivery.mjs`), which
 *  drives the REAL recycle against a REAL inbox file to prove each parked
 *  message is delivered EXACTLY ONCE. */
export async function recycleSession(wsId: string, reason: string): Promise<void> {
  log.warn(`session-watchdog: recycling wedged session ${wsId} — ${reason} (issue #90)`);

  // 1. Tear the wedged session down. This also releases the stranded gate
  //    (sdkStop calls `session.turnGate?.()`) and settles every queued turn as
  //    dropped, so no sender is left holding a receipt for a message that dies
  //    here — the senders' messages are already durable in the inbox, which is
  //    how they got parked in the first place.
  await sdkStop(wsId).catch((e) => log.warn(`session-watchdog: stop failed for ${wsId}`, e));

  // 2. Is there anything parked at all?
  const parked = readInbox(wsId);
  if (parked.length === 0) {
    log.info(`session-watchdog: ${wsId} had nothing parked after stop — no wake needed`);
    return;
  }

  // 3. Wake the session on the SAME conversation with a NEUTRAL prompt that
  //    carries NO parked content.
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
  try {
    await sdkWake(wsId, WAKE_PROMPT);
  } catch (e) {
    log.warn(`session-watchdog: wake failed for ${wsId} — messages remain parked`, e);
    return;
  }

  // 4. Release EVERY parked block — including the first — through the single
  //    confirmed-start path. `releaseInboxBlock` removes a block only on a
  //    confirmed `'started'` and re-reads the file before rewriting it, so a
  //    hook drain racing us cannot resurrect blocks it already handed over.
  //    Anything that does not actually start stays parked for the next tick
  //    rather than vanishing: the failure mode is "the message stays where it
  //    was", never "the message is gone".
  //
  //    Re-read rather than reusing the step-2 snapshot: the wake turn's own
  //    hook drain may legitimately have taken blocks already, and releasing
  //    from a stale snapshot would re-deliver what the agent has now seen.
  for (const block of readInbox(wsId)) {
    const out = await releaseInboxBlock(wsId, block.text).catch(() => null);
    if (!out?.ok) {
      log.info(
        `session-watchdog: ${wsId} re-delivery of a parked block did not start — left parked`,
      );
      break;
    }
  }
}

/** One pass over every workspace. Exported for the E2E rig, which drives ticks
 *  explicitly rather than waiting out real minutes. */
export async function watchdogTick(now: number = Date.now()): Promise<void> {
  for (const ws of store.workspaces) {
    if (ws.archived) continue;

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
    const decision: RecycleDecision = decideSessionRecycle({
      sessionLive: sdkSessionLive(ws.id),
      stalled,
      // The recycle path carries its OWN progress evidence (review R1): #88's
      // `status` guard is a display field on a best-effort hook chain, and is
      // documented in queue-stall.ts as not surviving a restart. A session that
      // emitted anything inside the silence window is refused regardless of
      // what its status says.
      lastStreamAt: progress?.lastStreamAt ?? null,
      recentRecycles: ledger,
      now,
    });

    if (decision.action === 'none') continue;

    if (decision.action === 'flap-limit') {
      // SURFACED, never silent. A watchdog that quietly gives up leaves the
      // human with neither a working agent nor a reason — the worst of both.
      // The #88 badge is still on the row saying the workspace is stalled; this
      // line is what explains that the automatic repair has stood down.
      log.error(
        `session-watchdog: ${ws.id} stalled ${Math.round(decision.stalledForMs / 60_000)}min but ` +
          `already recycled ${decision.recyclesInWindow}x this hour — STANDING DOWN, needs a human (issue #90)`,
      );
      continue;
    }

    recycleLedger.set(ws.id, [...ledger, now]);
    await recycleSession(
      ws.id,
      `${decision.parkedCount} parked, no turn start for ${Math.round(decision.stalledForMs / 60_000)}min`,
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
}

/** Test/rig seam: reset the in-memory state so a rig can drive ticks from a
 *  known baseline instead of inheriting whatever a previous test left. */
export function __resetSessionWatchdogForTests(since: number = Date.now()): void {
  observableSince = since;
  recycleLedger.clear();
  lastGateSeen.clear();
}
