/**
 * The `crossSessionInbound` policy Orchestra pins on every SDK session it runs.
 *
 * ## The defect this closes (measured, not theorised)
 *
 * Any local Claude session can address any OTHER local session by peer NAME
 * (`ListAgents` → `SendMessage`), over a per-process unix socket the CLI
 * advertises as `messaging_socket_path` on `system/init`. Research #13 measured
 * what that delivers to an Orchestra-managed session: with no policy set, an
 * unsolicited inbound peer message is delivered with NO hold and the CLI starts
 * a model turn ON ITS OWN — a full paid turn ($0.13 measured on haiku),
 * unprompted by the SDK consumer, whose only structured record is an `origin`
 * field on the trailing `result` message.
 *
 * Two properties make that worse than it first reads:
 *   - `ListAgents` enumerates EVERY live Claude session on the machine,
 *     including the user's real interactive ones — so the blast radius is
 *     "any same-user process", not "another Orchestra agent".
 *   - No `user`-type message for the inbound text ever enters the receiver's
 *     stream (the body rides only in `result.origin.body`), so a consumer that
 *     renders user messages shows the agent answering nobody.
 *
 * Orchestra runs its agents in `bypassPermissions` by design, which is exactly
 * the configuration that auto-runs: the CLI's UNSET default is *mode parity* —
 * a peer message auto-delivers when the sender's permission-mode class matches
 * the receiver's (bypass↔bypass). Orchestra agents are bypass, and so is any
 * other agent on this machine, so parity is satisfied and the turn runs.
 *
 * ## Why 'hold' and not 'refuse'
 *
 * Measured against CLI 2.1.241 (see docs/research/cross-session-inbound.md),
 * both 'hold' and 'refuse' fully suppress the auto-run — 0 assistant turns,
 * $0 cost, no re-emitted init. They are indistinguishable from the SENDER's
 * side (both still return `success:true`), so 'refuse' buys no extra safety
 * signal while permanently discarding the message. 'hold' is the
 * least-destructive policy that satisfies the requirement ("must NOT auto-run
 * a paid turn"): per the SDK's own words it "parks them for your review
 * without letting Claude act" — the message survives for a human to look at,
 * where 'refuse' opts the session out entirely.
 *
 * ## Why this does not break Orchestra's own inter-agent messaging
 *
 * It is a DIFFERENT CHANNEL. `orchestra message` never touches the CLI peer
 * socket: `dispatchMessageRequest` (workspaces.ts) delivers via one of three
 * Orchestra-owned paths — an enqueued turn on the live SDK session
 * (`sdkDeliver`), a PTY write for terminal-mode workspaces, or the durable
 * per-workspace inbox file drained by a SessionStart hook. In CODE, at
 * upstream `48bdbcb`, `SendMessage` / `crossSessionInbound` /
 * `messaging_socket` have zero hits under `src/` (positive control in the same
 * pass: `sdkDeliver`, 4 files). Scoped that way deliberately — on THIS branch
 * the string `SendMessage` does occur once, in the explanatory comment at
 * `agent-sdk.ts` beside the setting, so an unscoped "appears nowhere" claim is
 * false verbatim here and would read as fabricated to the first reviewer who
 * greps the working tree.
 * So this setting gates only the unsolicited outside channel, and Orchestra's
 * own comms are untouched — verified with the same two-session probe.
 *
 * ## Where it is applied
 *
 * Passed as an INLINE `settings` object on `query()`, which the SDK loads into
 * the "flag settings" layer — the highest-priority user-controlled layer. That
 * matters: it cannot be silently overridden by a stale `crossSessionInbound`
 * in the user's `~/.claude/settings.json`, and it leaves `settingSources`
 * (`['user','project','local']`, which carries every Orchestra hook) alone.
 */

/** The policies the CLI accepts for `crossSessionInbound` (SDK `Settings`). */
export type CrossSessionInboundPolicy = 'accept' | 'hold' | 'refuse';

/**
 * The policy Orchestra pins. 'hold' = parked for review, Claude does not act.
 * See the module comment for the measurement that chose it over 'refuse'.
 */
export const ORCHESTRA_CROSS_SESSION_INBOUND: CrossSessionInboundPolicy = 'hold';

/**
 * The inline `settings` object for a `query()` launch.
 *
 * Merges onto any settings Orchestra already wants to pass rather than
 * replacing them, so a future caller adding another flag-layer setting cannot
 * silently drop the policy (and vice versa). Explicitly does NOT accept an
 * override: the whole point is that an Orchestra-managed session is never
 * remotely promptable, so there is no per-workspace opt-out to get wrong.
 */
export function withCrossSessionInboundPolicy<T extends Record<string, unknown>>(
  base?: T,
): T & { crossSessionInbound: CrossSessionInboundPolicy } {
  return {
    ...((base ?? {}) as T),
    crossSessionInbound: ORCHESTRA_CROSS_SESSION_INBOUND,
  };
}
