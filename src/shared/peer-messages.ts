// Inter-agent (peer) message presentation — issue #56.
//
// WHY THIS EXISTS. When a fleet is active a coordinator pane receives dozens of
// agent-to-agent messages per wave, and each one rendered as a FULL user-turn
// bubble — drowning the human's own conversation (owner-reported, screenshot
// confirmed). These are not the human talking; they are traffic. So they get a
// COMPACT collapsible row instead: sender + first line, click to expand.
//
// ── Which channel actually produces them (measured, 2026-08-25) ──────────────
//
// The issue proposed keying on the CLI's cross-session `origin` ({kind:'peer'}).
// That rule detects NOTHING today. Real CLI peer deliveries land as transcript
// lines carrying `isMeta: true`, which both the live fold (agent-events.ts, the
// `msg.isSynthetic !== true` gate) and the backfill (agent-transcript.ts, the
// `entry.isMeta === true` gate) DROP — verified by folding three real captured
// peer lines: 0 messages out, while the same lines with `isMeta` stripped (a
// positive control proving the rig discriminates) rendered 3/3. Orchestra also
// sets `crossSessionInbound: 'hold'`, suppressing those turns outright
// (docs/research/cross-session-inbound.md).
//
// The flood is Orchestra's OWN channel, which is a DIFFERENT channel:
// `dispatchMessageRequest` (src/main/workspaces.ts) formats the body and
// delivers it via `sdkDeliver` → `sdkSend` → `makeUserMessage` — the very same
// path a human composer prompt takes, carrying NO origin at all. That is why
// these were indistinguishable from human turns. Measured 1141 such messages
// across 39 fleet transcripts.
//
// ── The two detection paths, and why they differ ─────────────────────────────
//
// LIVE (structural, preferred): `dispatchMessageRequest` already knows the
// sender's branch and id, so it now tags the delivery with a structural
// {@link PeerOrigin}; that rides through `sdkSend` → `makeUserMessage` onto the
// event and into `RenderMessage.origin`. No text is ever inspected.
//
// BACKFILL (scoped textual recognizer): the ~1141 messages ALREADY on disk were
// written before the tagging existed and carry no origin — nothing structural
// survives for them to key on. To make a reopened coordinator pane show the fix
// on the very history the owner screenshotted, the backfill recognizes the
// exact envelope THIS repo's `formatPeerMessage` emits. Deliberately confined
// to the backfill: the live path must never regex message text. The recognizer
// is anchored (`^`) and requires the full bracketed header, so ordinary prose
// quoting the phrase mid-message cannot trip it.

/** Structural provenance for a message Orchestra delivered from another agent.
 *  Mirrors the CLI's own `origin` shape (`kind`/`from`/`name`) so the two
 *  channels present identically, even though only this one currently renders. */
export interface PeerOrigin {
  kind: 'peer';
  /** The sending workspace's id (stable) — `orchestra message <from> "…"`. */
  from: string;
  /** The sending workspace's branch — what a human recognizes it by. */
  name: string;
}

/** The badge string an origin renders as, e.g. `peer: fix-login-race`. Shared by
 *  the live path and the backfill so a reopened workspace matches what it showed
 *  live. Kept in sync with `originLabel`'s 'peer' arm in agent-events.ts. */
export function peerOriginLabel(origin: PeerOrigin): string {
  return `peer: ${origin.name || origin.from}`;
}

/** True when a rendered message is an inter-agent delivery rather than a turn
 *  the human typed. STRUCTURAL: reads the origin badge produced by
 *  {@link peerOriginLabel} (live) or by the backfill recognizer — never the
 *  message body. The human's own turns carry no origin and are unaffected, and
 *  so are other origins ('claude.ai' Remote Control, 'task notification'). */
export function isPeerMessage(m: { role?: string; origin?: string }): boolean {
  return m.role === 'user' && typeof m.origin === 'string' && m.origin.startsWith('peer: ');
}

/** The sender's display name for a collapsed row — the part after `peer: `.
 *  Falls back to 'agent' so a malformed badge still renders a sensible row
 *  rather than an empty one. */
export function peerSender(m: { origin?: string }): string {
  const o = m.origin ?? '';
  const name = o.startsWith('peer: ') ? o.slice('peer: '.length).trim() : '';
  return name || 'agent';
}

// The header `formatPeerMessage` (src/main/workspaces.ts) writes, and the reply
// footer it appends. Anchored at the start of the body; the id group is
// non-greedy and the line must END after the bracket, so only Orchestra's own
// envelope matches.
const PEER_HEADER = /^\[message from agent '(.+?)' \(([^)]+)\)\]\n/;
/** Trailing instruction the formatter appends. Stripped from the displayed body:
 *  it is boilerplate the human does not need in a preview or an expansion. */
const PEER_REPLY_FOOTER = /\n\nReply with: orchestra message \S+ "<reply>"\s*$/;

/** Recognize a message body Orchestra's OWN peer formatter produced, recovering
 *  its structural origin plus the body with the envelope removed.
 *
 *  BACKFILL ONLY (see the header note). Returns null for anything that is not an
 *  exact match — a human turn that merely mentions the phrase does not match,
 *  because the pattern is anchored and demands the full `[message from agent
 *  '<branch>' (<id>)]` header on its own first line. */
export function recognizeFormattedPeerMessage(
  text: string,
): { origin: PeerOrigin; body: string } | null {
  const m = PEER_HEADER.exec(text);
  if (!m) return null;
  const [, name, from] = m;
  const body = text.slice(m[0].length).replace(PEER_REPLY_FOOTER, '').trim();
  return { origin: { kind: 'peer', from, name }, body };
}

/** One-line preview for a collapsed row: the body's first NON-EMPTY line,
 *  trimmed and length-capped so a row can never wrap or blow out the layout.
 *  Returns '' for an empty body, which the row renders as a quiet placeholder
 *  rather than an empty click target. */
export function peerPreview(text: string | undefined, max = 120): string {
  const first = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '';
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** Summary label for a run of consecutive peer rows rendered as one group —
 *  "Message from alpha" / "3 messages from alpha" / "4 messages from 2 agents".
 *  Mirrors ToolGroup's verb-summary idiom (docs/codebase-map/agent-view-design.md). */
export function describePeerRun(messages: { origin?: string }[]): string {
  const n = messages.length;
  const senders: string[] = [];
  for (const m of messages) {
    const s = peerSender(m);
    if (!senders.includes(s)) senders.push(s);
  }
  const noun = n === 1 ? 'Message' : `${n} messages`;
  if (senders.length === 1) return `${noun} from ${senders[0]}`;
  return `${noun} from ${senders.length} agents`;
}
