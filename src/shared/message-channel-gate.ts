// #441 — the OLD inter-agent channel is CLOSED (spec #431, ADR 0012).
//
// `orchestra message` (→ dispatchMessageRequest → sdkSend) is the pre-bus channel with its own known
// faults (#57-class duplicates, silent drops, inbox-never-redriven). Since every agent has a run (#433/#434)
// the bus is the only channel between agents, so a `message` WITHOUT `--emergency` is refused for EVERY
// target — a parent, a child, a sibling, an unrelated agent (there is no exemption left: not a plain target,
// not a dangling parent, not #221's plain own-anchor) — and the refusal prints the equivalent `orchestra send`.
// `--emergency` (the liveness poke at a reader that no longer reads its mail, #172) is the ONE survivor.
//
// PURE and platform-free: `workspaces.ts` (where the effect lives) drags in `./store`/`./platform` and cannot
// load under `node --test`, so the DECISION lives here and is driven directly by the unit test.

/** The inputs the effect resolves before deciding. */
export interface MessageChannelGateInput {
  /** Did the caller pass `--emergency` (the surviving out-of-band escape)? */
  emergency: boolean;
  /** The target workspace id the caller named. */
  to: string;
  /** The text the caller wanted to send (echoed back inside the equivalent command). */
  text: string;
}

export type MessageChannelGateDecision =
  | { allow: true }
  | { allow: false; error: string };

/** POSIX single-quote a value so the printed command can be pasted verbatim (a `'` becomes `'\''`). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `orchestra send` that says what the refused `message` meant — the one verb a sender is pointed at. */
export function equivalentSendCommand(to: string, text: string): string {
  return `orchestra send --type status --to ${to} ${shellQuote(text)}`;
}

/** The error a refused `message` prints: the channel is closed, the equivalent command, the one escape. */
export function messageChannelRefusal(to: string, text: string): string {
  return (
    "refusing 'orchestra message': the bus is the only channel between agents. " +
    `Use: ${equivalentSendCommand(to, text)}\n` +
    'Only if the reader no longer reads its mail, push text into its session with ' +
    "'orchestra message --emergency <id> <text...>' (--emergency must be the leading token)."
  );
}

/**
 * Decide whether an `orchestra message` single-target send is allowed: ONLY with `--emergency`.
 * MUTATION: let a non-emergency send through (any target) → every refusal arm goes red.
 */
export function decideMessageChannel(input: MessageChannelGateInput): MessageChannelGateDecision {
  if (input.emergency) return { allow: true };
  return { allow: false, error: messageChannelRefusal(input.to, input.text) };
}
