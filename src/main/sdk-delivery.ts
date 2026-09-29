// SDK-session delivery seam.
//
// The structured (SDK) agent path lives in agent-sdk.ts, which imports from
// workspaces.ts. So workspaces.ts / prompt-queue.ts CANNOT import agent-sdk.ts
// back without a circular import (the same reason sdkStopMany is wrapped in
// api-handlers.ts rather than called from workspaces.ts). But the lifecycle
// dispatchers — peer-message delivery (dispatchMessageRequest), the usage-limit
// prompt-queue flusher, and account migration — all live in workspaces.ts and
// must be able to route to a LIVE structured session instead of blindly spawning
// a raw `claude` PTY (which would run a stray second agent alongside the SDK
// session and never deliver the message/prompt).
//
// This tiny seam breaks the cycle: agent-sdk.ts registers its live-session
// hooks here at module load; the dispatchers consult the seam. When no SDK
// module has registered (or no session is live) the hooks report "no session";
// a START that fails is REPORTED (`sdkStartAndDeliverResult`), never masked by a PTY (#227).

import { log } from './logger';
import type { PeerOrigin } from '../shared/peer-messages.ts';

/** The subset of the SDK session manager the lifecycle dispatchers need. */
export interface SdkDelivery {
  /** True iff a live (non-stopping) structured session owns this workspace. */
  hasSession(wsId: string): boolean;
  /** True iff the live session still owns a RUNNING background task (hibernation must not kill it). */
  hasBackgroundTask(wsId: string): boolean;
  /** Enqueue a text turn to a live structured session (becomes its next turn,
   *  same "live" semantics as typing into a running TUI). Resolves when queued.
   *
   *  `peerOrigin` tags the turn as an INTER-AGENT delivery (issue #56). Peer
   *  messages reach a live session through this very seam, so without the tag
   *  they are byte-identical to a human prompt and render as full user bubbles.
   *  Only `dispatchMessageRequest` sets it. */
  send(wsId: string, text: string, peerOrigin?: PeerOrigin): Promise<void>;
  /** Enqueue a text turn AND wait to learn whether it actually BECAME the
   *  session's turn (issue #57 fault b).
   *
   *  `send` resolves on the QUEUE PUSH, which is not delivery: the target's
   *  user can hit Escape, the session can end, the prompt can be cancelled from
   *  the tray. Callers that report a delivery status to a human or a peer must
   *  use this instead, so 'live' means the message really started rather than
   *  merely being hoped for.
   *
   *  Resolves 'started' | 'dropped' | 'timeout'. A 'timeout' is NOT a licence to
   *  claim 'live' — the caller falls back to the durable inbox. */
  sendAwaitingStart(
    wsId: string,
    text: string,
    peerOrigin: PeerOrigin | undefined,
    timeoutMs: number,
  ): Promise<'started' | 'dropped' | 'timeout'>;
  /** START a structured session (or reuse a live one) and deliver `text` as its
   *  next turn — the spawn/wake entry point. Unlike `send` this does not require
   *  a live session: it lazy-starts one, resuming the workspace's prior
   *  conversation when there is one (agent-sdk's `sdkWake`).
   *  `opts.openingBrief`: this send is spawn / Restart's own delivery of `lastTask` (the only callers whose same-text in-flight send is deduped — #227 F5). */
  start(wsId: string, text: string, opts?: { openingBrief?: boolean }): Promise<void>;
  /** Resolve when the workspace's CURRENT session settles its first TURN (first non-error output, an errored turn, or death before
   *  either) or `timeoutMs` passes. Optional: a seam without it reports `unknown` (#227 D7). */
  awaitFirstTurn?(wsId: string, timeoutMs: number): Promise<SdkFirstTurnOutcome>;
  /** Did the workspace's LIVE session's first turn ERROR (a failed start still holding a process)? Optional (#227 r4 F2). */
  firstTurnFailed?(wsId: string): boolean;
  /** Tear down a live structured session (used by account migration, which must
   *  stop the session running under the OLD account/config dir). */
  stop(wsId: string, opts?: { hibernate?: boolean }): Promise<void>;
}

let impl: SdkDelivery | null = null;

/** Registered once by agent-sdk.ts at module load. */
export function registerSdkDelivery(delivery: SdkDelivery): void {
  impl = delivery;
}

/** Whether a live structured session owns this workspace. False when the SDK
 *  module hasn't registered yet (nothing structured has ever run). */
export function sdkSessionLive(wsId: string): boolean {
  return impl?.hasSession(wsId) ?? false;
}

/** True iff the workspace's live structured session still owns a running background task. */
export function sdkHasBackgroundTasks(wsId: string): boolean {
  return impl?.hasBackgroundTask(wsId) ?? false;
}

/** Deliver a prompt to a live structured session. Returns false (caller falls
 *  back to the PTY path) when there is no live session to deliver to.
 *
 *  Reports success on the QUEUE PUSH. Callers that surface a delivery status to
 *  a human or a peer must use {@link sdkDeliverConfirmed} instead — see issue
 *  #57 fault (b): a queued turn can still be discarded unrun, and this function
 *  cannot tell the caller that happened. */
export async function sdkDeliver(
  wsId: string,
  text: string,
  peerOrigin?: PeerOrigin,
): Promise<boolean> {
  if (!impl?.hasSession(wsId)) return false;
  await impl.send(wsId, text, peerOrigin);
  return true;
}

/** How long to wait for a queued turn to actually start before falling back to
 *  the durable inbox. A turn parked behind a long-running one is normal, so this
 *  is generous; it exists only so a sender's CLI cannot hang forever. */
export const DELIVERY_START_TIMEOUT_MS = 10_000;

/** Deliver to a live structured session and report what ACTUALLY happened.
 *
 *  - `'none'`     — no live structured session; the caller's other paths apply.
 *  - `'started'`  — the message really became the session's turn. Only this
 *                   result may be reported to a sender as 'live'.
 *  - `'dropped'`  — the turn was discarded before running (Escape, session end,
 *                   tray cancel, stop). The caller must NOT claim delivery.
 *  - `'timeout'`  — still queued when we stopped waiting. Also not 'live'.
 *
 *  This is the seam that makes issue #57's 'Delivered (live)' honest. */
export async function sdkDeliverConfirmed(
  wsId: string,
  text: string,
  peerOrigin?: PeerOrigin,
  timeoutMs: number = DELIVERY_START_TIMEOUT_MS,
): Promise<'none' | 'started' | 'dropped' | 'timeout'> {
  if (!impl?.hasSession(wsId)) return 'none';
  return impl.sendAwaitingStart(wsId, text, peerOrigin, timeoutMs);
}

/** `error` = the start failure's own message; `note` = an ok-with-a-caveat line for the caller to print (#227 D6). */
export type SdkStartResult = { ok: true; note?: string } | { ok: false; error: string };

/** How a started session's FIRST TURN went (#227 D7 — init alone proves nothing: a bad `--model` / no auth inits, then errors):
 *  `ok` = the first non-error output arrived; `failed` = the turn errored (`cause` 'turn-error', `reason` = the CLI's text) or the
 *  CLI exited before any output (`cause` 'exit'); `timeout` = still silent at the bound; `unknown` = no seam that can say. */
export type SdkFirstTurnOutcome =
  | { state: 'ok' }
  | { state: 'failed'; reason: string; cause: 'turn-error' | 'exit' }
  | { state: 'timeout' }
  | { state: 'unknown' };

/** Start a structured session and deliver `text` as its opening turn (resuming prior context). No PTY fallback (#227):
 *  a failure is REPORTED here, and is an error row in the Agent view (agent-sdk `sdkSend`). */
export async function sdkStartAndDeliverResult(wsId: string, text: string, opts?: { openingBrief?: boolean }): Promise<SdkStartResult> {
  if (!impl) return { ok: false, error: 'the structured agent module is not loaded' };
  try {
    await impl.start(wsId, text, opts);
    return { ok: true };
  } catch (err) {
    log.warn(`sdk-delivery: structured start failed for ${wsId}`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wait (bounded) for the session `sdkStartAndDeliver*` just started to settle its first turn. */
export async function sdkAwaitFirstTurn(wsId: string, timeoutMs: number): Promise<SdkFirstTurnOutcome> {
  return (await impl?.awaitFirstTurn?.(wsId, timeoutMs)) ?? { state: 'unknown' };
}

/** Did the workspace's LIVE session's first turn error? (`false` when no seam / no session.) */
export function sdkFirstTurnFailed(wsId: string): boolean {
  return impl?.firstTurnFailed?.(wsId) ?? false;
}

/** Boolean form of {@link sdkStartAndDeliverResult} for wake and the bus wake seam. */
export async function sdkStartAndDeliver(wsId: string, text: string): Promise<boolean> {
  return (await sdkStartAndDeliverResult(wsId, text)).ok;
}

/** Stop a live structured session if one exists (best-effort). Even with NO
 *  in-memory session this still calls stop: a detached KEEPER may be running
 *  this workspace's CLI from before an app restart (keeper-client.ts), and
 *  every caller here (hibernation, branch switch, account migration) means
 *  "make sure nothing structured is running" — sdkStop's no-session path kills
 *  any live keeper and is an instant no-op otherwise. */
export async function sdkStopIfLive(wsId: string, opts?: { hibernate?: boolean }): Promise<boolean> {
  if (!impl) return false;
  const had = impl.hasSession(wsId);
  await impl.stop(wsId, opts);
  return had;
}
