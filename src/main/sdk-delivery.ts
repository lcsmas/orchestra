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
// module has registered (or no session is live) the hooks report "no session"
// and callers fall back to their existing PTY path unchanged.

/** The subset of the SDK session manager the lifecycle dispatchers need. */
export interface SdkDelivery {
  /** True iff a live (non-stopping) structured session owns this workspace. */
  hasSession(wsId: string): boolean;
  /** Enqueue a text turn to a live structured session (becomes its next turn,
   *  same "live" semantics as typing into a running TUI). Resolves when queued. */
  send(wsId: string, text: string): Promise<void>;
  /** Tear down a live structured session (used by account migration, which must
   *  stop the session running under the OLD account/config dir). */
  stop(wsId: string): Promise<void>;
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

/** Deliver a prompt to a live structured session. Returns false (caller falls
 *  back to the PTY path) when there is no live session to deliver to. */
export async function sdkDeliver(wsId: string, text: string): Promise<boolean> {
  if (!impl?.hasSession(wsId)) return false;
  await impl.send(wsId, text);
  return true;
}

/** Stop a live structured session if one exists (best-effort). No-op otherwise. */
export async function sdkStopIfLive(wsId: string): Promise<boolean> {
  if (!impl?.hasSession(wsId)) return false;
  await impl.stop(wsId);
  return true;
}
