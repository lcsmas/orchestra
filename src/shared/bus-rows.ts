// Bus wake orders & deliveries as first-class rows — issue #145 (detection layer).
//
// WHY THIS EXISTS. A bus WAKE currently arrives as a synthetic user-looking
// prompt (`WAKE_ORDER_HEADER` + `orchestra check --run <r>` lines, bus-wake.ts),
// indistinguishable at a glance from a human message; a bus DELIVERY is a raw
// `orchestra check` JSON blob in a Bash tool card, and its `ack` is another bash
// line. The user (2026-09-15, after the live canary) asked for dedicated
// rendering. This module is the PURE detection/fold layer both the live fold and
// the transcript backfill key on — no renderer, no main, no Electron imports, so
// it runs under the strip-types test runner (the #132 dir-import trap) and is
// shared by BOTH paths so live == backfill by construction (the #57 lesson).
//
// ── The two invariants (acceptance G3/G4) ────────────────────────────────────
//
// WAKE rows are keyed on the SYNTHETIC MARKER (`isWakeOrder`, bus-wake.ts) — the
// header followed by ≥1 `orchestra check --run <r>` line and NOTHING else — NOT
// on body-text heuristics. A plain human turn containing the words "lot pending"
// is not a wake order (it lacks the exact structured shape), so it never renders
// as a wake row. This is the must-FAIL control.
//
// DELIVERY rows are keyed on the `orchestra check` CLI INVOCATION (the Bash
// tool's `command`) plus a parseable `CheckOutput` result — never on body text.
// A non-bus Bash card whose OUTPUT merely looks JSON-ish is not folded, because
// the command must be an `orchestra check`. The ACK badge flips PENDING→ACKED
// when a later `orchestra ack <lot-id>` invocation names the SAME lot id.

import { isWakeOrder, wakeOrderRuns } from './bus-wake.ts';
import type { CheckOutput } from '../cli/bus-verbs.ts';

// ─── Wake detection ──────────────────────────────────────────────────────────

/** A minimal view of a rendered user message, enough to classify it as a wake
 *  order. Kept structural (no dependency on the full RenderMessage type) so this
 *  module stays importable everywhere. */
export interface BusWakeCandidate {
  role?: string;
  text?: string;
  /** A peer/RC/task origin means the turn came in from elsewhere; a wake order is
   *  a SYNTHETIC prompt Orchestra injected, which carries no such origin. We do
   *  NOT gate on this (a wake has no origin either) but expose it so a caller can
   *  keep peer-origin messages on their own peer path. */
  origin?: string;
}

/** True when a rendered message is a bus WAKE ORDER — a synthetic user prompt
 *  whose text is exactly `WAKE_ORDER_HEADER` + ≥1 `orchestra check --run <r>`
 *  line and nothing else. MARKER-KEYED (delegates to `isWakeOrder`), never a
 *  body-text heuristic: a human turn merely mentioning "lot pending" fails the
 *  structured shape and is not a wake. Peer-origin messages are excluded — they
 *  render on the peer path, and a wake carries no origin anyway. */
export function isBusWakeMessage(m: BusWakeCandidate): boolean {
  if (m.role !== 'user') return false;
  // A peer/RC/task delivery is not a wake, even in the impossible case its body
  // matched — keep the channels disjoint.
  if (typeof m.origin === 'string' && m.origin.length > 0) return false;
  return isWakeOrder(m.text ?? '');
}

/** The run ids a wake order names — the runs the reader is ordered to check.
 *  Empty for a non-wake message (never throws). */
export function busWakeRuns(m: BusWakeCandidate): string[] {
  if (!isBusWakeMessage(m)) return [];
  return wakeOrderRuns(m.text ?? '');
}

/** The exact ordered commands a wake row expands to — one `orchestra check
 *  --run <r>` per named run, in the order the wake wrote them. Reconstructed
 *  from the runs so a row renders the SAME commands live and on reload. */
export function busWakeCommands(m: BusWakeCandidate): string[] {
  return busWakeRuns(m).map((r) => `orchestra check --run ${r}`);
}

// ─── Delivery (`check`) + ack detection ──────────────────────────────────────

/** A minimal view of a rendered tool message, enough to classify a bus
 *  `check`/`ack` invocation. Mirrors RenderMessage's `toolUse`/`toolResult`
 *  without importing the whole type. */
export interface BusToolCandidate {
  role?: string;
  toolUse?: {
    name: string;
    input?: Record<string, unknown>;
    /** Streaming raw JSON, used only as a fallback when `input` has not
     *  finalized (the command may still be recoverable from the buffer). */
    inputJson?: string;
  };
  toolResult?: {
    content: string | unknown[];
    isError?: boolean;
  };
}

/** The Bash command a tool card ran, as a plain string. Prefers the finalized
 *  parsed `input.command`; falls back to scanning the raw streaming buffer for a
 *  `"command"` field so a still-streaming card can still be recognized. Returns
 *  '' when there is no command to read. */
export function toolCommand(m: BusToolCandidate): string {
  if (m.role !== 'tool') return '';
  if (m.toolUse?.name !== 'Bash') return '';
  const cmd = m.toolUse.input?.['command'];
  if (typeof cmd === 'string') return cmd;
  // Fallback: recover the command from the raw streaming JSON buffer. Best-effort
  // only — a partial buffer may not yet contain it, in which case we report ''.
  const raw = m.toolUse.inputJson;
  if (typeof raw === 'string') {
    const match = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** True when a Bash tool card is an `orchestra check` invocation. Anchored to the
 *  verb so `orchestra check-something-else` or a command merely mentioning the
 *  words does not match. Handles a leading path (`/x/orchestra check`) and
 *  interior flags (`--run`, `--ack-previous`, `--markdown`, `--limit`). */
export function isCheckInvocation(m: BusToolCandidate): boolean {
  return CHECK_RE.test(toolCommand(m));
}

/** True when a Bash tool card is an `orchestra ack <lot-id>` invocation. */
export function isAckInvocation(m: BusToolCandidate): boolean {
  return ACK_RE.test(toolCommand(m));
}

// `orchestra check …` — the binary may carry a path prefix; `check` is the verb.
// `(?:^|\s|/)` lets `/opt/orchestra check` match while `foo-orchestra check`
// (a different binary) does not — the char before `orchestra` must be a
// boundary. The verb must be followed by end/whitespace so `checkpoint` fails.
const CHECK_RE = /(?:^|\s|\/)orchestra\s+check(?:\s|$)/;
const ACK_RE = /(?:^|\s|\/)orchestra\s+ack(?:\s|$)/;

/** The lot id an `orchestra ack <lot-id>` invocation names, or null. The id is
 *  the first positional integer after `ack` (flags like `--request-id` are
 *  skipped). Matches `verbAck`'s contract: a lot id is a positive integer. */
export function ackLotId(m: BusToolCandidate): number | null {
  if (!isAckInvocation(m)) return null;
  const cmd = toolCommand(m);
  // Take the substring after the `ack` verb, then find the first bare positive
  // integer token that is not attached to a flag.
  const after = cmd.replace(/^.*?(?:^|\s|\/)orchestra\s+ack\s+/, '');
  for (const tok of after.split(/\s+/)) {
    if (tok.startsWith('-')) continue; // a flag, or its value handled below
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (Number.isInteger(n) && n > 0) return n;
    }
    // A non-numeric non-flag token is not a lot id; keep scanning in case a flag
    // value preceded it, but the CLI's own grammar puts the lot id first.
  }
  return null;
}

/** Parse the `check` result content into a `CheckOutput`, or null when the card
 *  is not a bus delivery (wrong command, error result, unparseable, or the JSON
 *  is not the published `check` shape). STRUCTURAL: requires the exact contract
 *  fields (#123), so a Bash card whose output merely looks JSON-ish is refused
 *  — this is the G4 must-FAIL guard against body-text keying. */
export function parseCheckOutput(m: BusToolCandidate): CheckOutput | null {
  if (!isCheckInvocation(m)) return null;
  const content = m.toolResult?.content;
  if (m.toolResult?.isError) return null;
  const text = toolResultText(content);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!isCheckOutputShape(parsed)) return null;
  return parsed;
}

/** Flatten a tool result's `content` (string, or an array of `{type:'text',
 *  text}` blocks the SDK emits) into a single string. */
export function toolResultText(content: string | unknown[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object' && 'text' in block) {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

/** Structural validation of the published `check` contract (#123). We require the
 *  discriminating fields — `run`/`reader`/`messages`/`lot` — with their types, so
 *  an arbitrary JSON blob does not pass. `lot` may be null (an empty lot). */
function isCheckOutputShape(v: unknown): v is CheckOutput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['run'] !== 'string') return false;
  if (typeof o['reader'] !== 'string') return false;
  if (!(o['lot'] === null || typeof o['lot'] === 'number')) return false;
  if (typeof o['count'] !== 'number') return false;
  if (!Array.isArray(o['messages'])) return false;
  // gates is always present in a real check (possibly empty).
  if (!Array.isArray(o['gates'])) return false;
  // Validate message shape minimally — a delivery row reads sender/recipient/
  // kind/body/sequence.
  for (const msg of o['messages'] as unknown[]) {
    if (!msg || typeof msg !== 'object') return false;
    const mo = msg as Record<string, unknown>;
    if (typeof mo['sequence'] !== 'number') return false;
    if (typeof mo['kind'] !== 'string') return false;
    if (typeof mo['sender'] !== 'string') return false;
    if (!(mo['recipient'] === null || typeof mo['recipient'] === 'string')) return false;
    if (typeof mo['body'] !== 'string') return false;
  }
  return true;
}

// ─── Fold: a delivery row + its ack state ─────────────────────────────────────

/** One message line in a delivery row — the fields a row renders. */
export interface BusDeliveryMessage {
  sequence: number;
  kind: string;
  sender: string;
  recipient: string | null;
  /** First non-empty line of the body, length-capped for a compact row. */
  preview: string;
  /** Full body, for an expanded row. */
  body: string;
}

/** A folded bus delivery — everything a delivery row renders, plus its ack state.
 *  `acked` is resolved against the transcript's later `ack` invocations. */
export interface BusDelivery {
  run: string;
  reader: string;
  lot: number | null;
  count: number;
  messages: BusDeliveryMessage[];
  /** True when a matching `orchestra ack <lot>` appears LATER in the transcript.
   *  Always false for an empty lot (`lot === null`) — nothing to ack. */
  acked: boolean;
}

/** First non-empty line of a body, trimmed and capped — the delivery-row preview.
 *  Mirrors `peerPreview` so the two families read consistently. */
export function deliveryPreview(body: string | undefined, max = 120): string {
  const first = (body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** Fold a parsed `check` output into a delivery row model. `ackedLots` is the set
 *  of lot ids that a LATER `ack` invocation closed — the caller collects these by
 *  scanning `ackLotId` over the transcript AFTER this card. An empty lot is never
 *  acked. */
export function foldDelivery(o: CheckOutput, ackedLots: ReadonlySet<number>): BusDelivery {
  return {
    run: o.run,
    reader: o.reader,
    lot: o.lot,
    count: o.count,
    messages: o.messages.map((m) => ({
      sequence: m.sequence,
      kind: m.kind,
      sender: m.sender,
      recipient: m.recipient,
      preview: deliveryPreview(m.body),
      body: m.body,
    })),
    acked: o.lot !== null && ackedLots.has(o.lot),
  };
}
