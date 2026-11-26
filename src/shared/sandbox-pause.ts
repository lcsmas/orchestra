// Sandbox agents are PAUSED (wave "Agent view only", #219/#226; ADR 0007 text in #219).
//
// A sandbox-hosted workspace's agent runs in a container as a PTY `claude`; the Agent view
// drives an SDK session that would run the CLI on THIS host with the container's working
// directory — which fails with a cryptic spawn error. Until #220 reconciles the two, every
// attempt to START an agent for such a workspace is refused with this one message.
//
// Pure (no Electron): the refusal lives at the SDK session-start funnel (agent-sdk.ts
// `ensureSessionInner`) and reads its decision from here, so the wording has ONE source.

/** The follow-up ticket the pause waits on — named in the message so the user knows where to look. */
export const SANDBOX_PAUSED_TICKET = '#220 — Reconcile sandbox agents with the Agent view';

/** What every refused start says. Names the pause and the follow-up ticket. */
export const SANDBOX_PAUSED_MESSAGE =
  `Sandbox agents are paused pending ${SANDBOX_PAUSED_TICKET}. ` +
  'This workspace is hosted on a sandbox, so its agent cannot be started until then.';

/** #612 — what every refused start of a `noAgent` workspace says: it has no agent session BY DESIGN (its command is the coordinator). */
export const NO_AGENT_MESSAGE =
  'This workspace has no agent session by design (#612): its run command is the coordinator, so an agent is never started, woken or restarted here.';

/** The refusal for `ws`, or null when its agent may start (local workspace, unknown workspace). A `noAgent` workspace (#612) never has one. */
export function sandboxPausedMessage(
  ws: { host?: { kind: string }; noAgent?: boolean } | null | undefined,
): string | null {
  if (ws?.noAgent === true) return NO_AGENT_MESSAGE;
  return ws?.host?.kind === 'sandbox' ? SANDBOX_PAUSED_MESSAGE : null;
}
