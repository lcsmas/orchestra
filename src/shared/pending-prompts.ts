// Pending-prompt identity — issue #57 fault (a).
//
// ── The bug this replaces ────────────────────────────────────────────────────
//
// `ws.sdkPendingPrompts` used to be a `string[]` of RAW prompt bodies, and
// `recoverPendingPrompts` decided what had already been consumed by TEXT
// MATCHING them against the on-disk transcript:
//
//     const missing = pending.filter((p) => !userTexts.some((t) => t.includes(p)));
//
// That predicate is unsound for INTER-AGENT (peer) messages, and measurably so.
// `sdkSend` persists the full envelope `formatPeerMessage` produced:
//
//     [message from agent 'X' (id)]\n<body>\n\nReply with: orchestra message …
//
// but the backfill that produces `userTexts` (agent-transcript.ts `pushUserText`)
// runs `recognizeFormattedPeerMessage` and stores only `<body>` — the header and
// the reply footer are stripped so the message renders as a compact peer row
// (issue #56). A stripped body is strictly SHORTER than the envelope it came
// from, so `body.includes(envelope)` is false BY CONSTRUCTION — not by accident
// of whitespace or truncation. The entry therefore reads as "never ran" on
// EVERY structured-view reopen, and is re-sent every time. Measured on a real
// captured envelope: 421 chars persisted, 255 chars rendered back, predicate
// says "missing" (scripts/verify-peer-redelivery.mjs, which reproduces this on
// the unfixed predicate and gates it on the fixed one).
//
// That is the user-reported "same message queued 3 times": not one duplicated
// send, but one consumed message resurrected once per restart.
//
// ── Why identity, not better text matching ───────────────────────────────────
//
// Any text predicate is a guess about what a renderer did to the body, and the
// renderer is free to change (it already did, for peer rows). So the entry
// carries a STABLE KEY minted at send time and written to the transcript's
// user-message event, and consumption is decided by key membership. Text is
// retained only to resend the prompt, never to identify it.
//
// The key is derived from the prompt text rather than random so that it is
// STABLE ACROSS PROCESSES: the transcript line was written by the CLI in a
// previous app run, and the store entry by this one. A random id minted in
// `sdkSend` would not appear on the disk line the backfill reads, so it could
// never match — the same failure wearing a different hat.

/** A prompt handed to a structured session whose turn has not completed.
 *  Persisted on `ws.sdkPendingPrompts` as insurance against the
 *  quit-right-after-send window (see types.ts). */
export interface PendingPrompt {
  /** Stable identity — see {@link pendingPromptKey}. Decides consumption. */
  key: string;
  /** The raw text to re-send if this prompt really was lost. Never used to
   *  decide whether it was consumed. */
  text: string;
  /** Set when this prompt was an inter-agent delivery, so a resend re-enters
   *  tagged as a peer message instead of impersonating a human turn. */
  peer?: { from: string; name: string };
}

/** FNV-1a over the code points of `s`. Small, dependency-free, and stable
 *  across processes and app versions — the three properties that matter here.
 *  Not cryptographic: this is a dedupe key, not a security boundary. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Normalize a prompt body to the form its identity is computed over.
 *
 *  Strips the peer envelope when present, because the ENVELOPE is exactly what
 *  the two sides disagree about: the store holds it, the transcript does not.
 *  Normalizing both sides to the inner body makes the key agree across that
 *  boundary. Whitespace is collapsed for the same reason — the fold trims, and
 *  a trailing newline must not mint a different identity.
 *
 *  Deliberately duplicated here rather than importing the recognizer from
 *  peer-messages.ts: this must key on the envelope SHAPE without depending on
 *  the display-layer footer rules, which are free to change independently. */
function identityBody(text: string): string {
  let body = text;
  const header = /^\[message from agent '.+?' \([^)]+\)\]\n/.exec(body);
  if (header) body = body.slice(header[0].length);
  // Both the legacy socket-curl footer and the current CLI one.
  body = body
    .replace(/\n\nReply with: orchestra message \S+ "<reply>"\s*$/, '')
    .replace(/\n\nReply via the orchestra socket:[\s\S]*$/, '');
  return body.trim().replace(/\s+/g, ' ');
}

/** The stable identity of a prompt, computed from its normalized body.
 *
 *  Accepts either a store entry or a rendered transcript message, so BOTH sides
 *  of the comparison are keyed by the same function — the property that makes
 *  the match sound. Length is mixed in to make accidental collisions between
 *  short bodies vanishingly unlikely without needing a real digest. */
export function pendingPromptKey(m: { text?: string | null }): string {
  const body = identityBody(m.text ?? '');
  return `${hash(body)}-${body.length.toString(36)}`;
}

/** The entries that were NOT consumed — i.e. whose key does not appear among the
 *  keys the transcript actually contains. This is the whole dedupe decision, and
 *  it is pure so it can be unit-tested and mutation-tested directly.
 *
 *  Note the asymmetry the issue demands: a FALSE "consumed" silently loses a
 *  message, a false "missing" merely duplicates one. Keys are derived from the
 *  body, so a body genuinely absent from the transcript stays recoverable. */
export function filterUnconsumedPrompts<T extends { key: string }>(
  pending: readonly T[],
  consumedKeys: ReadonlySet<string>,
): T[] {
  return pending.filter((p) => !consumedKeys.has(p.key));
}

/** Migrate a persisted value that may predate the typed shape.
 *
 *  `ws.sdkPendingPrompts` shipped as `string[]`; a store written by an older
 *  build is still on disk after an upgrade, and dropping those entries would
 *  lose exactly the prompts this feature exists to protect. Bare strings are
 *  re-keyed with the same function, so a legacy entry participates in the new
 *  identity match rather than being trusted or discarded wholesale. */
export function normalizePendingPrompts(raw: unknown): PendingPrompt[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPrompt[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ key: pendingPromptKey({ text: item }), text: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Partial<PendingPrompt>;
      if (typeof rec.text === 'string' && rec.text.trim()) {
        out.push({
          key: typeof rec.key === 'string' && rec.key ? rec.key : pendingPromptKey({ text: rec.text }),
          text: rec.text,
          ...(rec.peer && typeof rec.peer.from === 'string' && typeof rec.peer.name === 'string'
            ? { peer: { from: rec.peer.from, name: rec.peer.name } }
            : {}),
        });
      }
    }
  }
  return out;
}
