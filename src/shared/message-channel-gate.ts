// P4 (#169) — retire the OLD inter-agent channel for FLEET COORDINATION.
//
// `orchestra message` (→ dispatchMessageRequest → sdkSend) is the pre-bus
// channel with its own known faults (#57-class duplicates, silent drops,
// inbox-never-redriven). Once a run adopts the bus for DELIVERY, coordination
// between its members must go through `orchestra send` (the bus), which is
// durable, ack'd and re-driven. This gate is the single pure predicate that
// decides whether a given `message` send is REFUSED as a coordination path or
// allowed through as a surviving escape.
//
// Two escapes MUST survive (ticket acceptance arm 2), because they are the
// look-alikes an over-broad refusal would wrongly cut off:
//   - delivery-OFF runs (a bloc2-style legacy mission never adopted the bus, or
//     a plain standalone workspace with no run row at all — `busSwitch` reads a
//     missing run as OFF, the coexistence-safe direction);
//   - an explicit `--emergency` send (the out-of-band liveness poke — canary
//     5/6 proved the coordinator needs a direct wake when a member's bus reader
//     is wedged; that path is in active use for #172 life-support this wave).
//
// PURE and platform-free on purpose: `workspaces.ts` (where the effect lives)
// drags in `./store`/`./platform` and cannot load under `node --test`, so the
// DECISION lives here and is driven directly by the unit test. The effect side
// resolves the two inputs (the target run's frozen `delivery` switch, the
// caller's `--emergency` flag) and calls this.

/** The inputs the effect resolves before deciding. */
export interface MessageChannelGateInput {
  /** Does the TARGET have an anchored run whose frozen `delivery` switch is ON?
   *  Resolved by the effect as `busSwitch(db, resolveWaveRunId(target), 'delivery')`
   *  — which reads a missing run row as OFF (the coexistence-safe direction), so
   *  a plain standalone / bloc2-legacy target is `false` here and never refused. */
  targetDeliveryOn: boolean;
  /** Did the caller pass `--emergency` (the surviving out-of-band escape)? */
  emergency: boolean;
}

export type MessageChannelGateDecision =
  | { allow: true }
  | { allow: false; error: string };

/** The error a refused fleet-coordination `message` prints — names the bus verb
 *  the sender must use instead, and the two escapes, so the refusal is
 *  actionable rather than a dead end. Exported so the test asserts the LITERAL
 *  the ticket promises ("names `orchestra send`") rather than a paraphrase. */
export const MESSAGE_CHANNEL_REFUSAL =
  "refusing 'orchestra message' for fleet coordination: this target's run has the " +
  'bus delivery switch ON, so coordination must go through the durable bus. ' +
  "Use 'orchestra send' instead (it is ack'd and re-driven; 'orchestra message' is " +
  'the pre-bus channel with #57-class duplicate/drop faults). If this is an ' +
  'out-of-band liveness poke because the bus reader is wedged, pass --emergency.';

/**
 * Decide whether an `orchestra message` single-target send is allowed.
 *
 * REFUSE iff the target's run has delivery ON AND this is not an emergency send.
 * Everything else is allowed: delivery-OFF targets (legacy/standalone) and every
 * `--emergency` send. Written as a single `&&` so the two escapes are visibly
 * OR'd — either one alone allows the send.
 */
export function decideMessageChannel(
  input: MessageChannelGateInput,
): MessageChannelGateDecision {
  if (input.targetDeliveryOn && !input.emergency) {
    return { allow: false, error: MESSAGE_CHANNEL_REFUSAL };
  }
  return { allow: true };
}
