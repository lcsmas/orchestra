// Parsing Orchestra's durable per-workspace inbox file — issue #64.
//
// ── What this parses, and what it deliberately does NOT ──────────────────────
//
// Orchestra parks a peer message on disk when it cannot hand it to a live
// session: `queueInbox` (src/main/workspaces.ts) APPENDS one delimited block
// per message to `~/.orchestra/inbox/<workspace-id>.txt`, so a file holds N
// blocks. Each block wraps the body `formatPeerMessage` produced:
//
//     \n========================================\n
//     [message from agent '<branch>' (<from-id>)]\n<text>\n\n
//     Reply with: orchestra message <from-id> "<reply>"\n
//     ========================================\n
//
// (Verified byte-exact with `cat -A` against a live inbox file, not inferred
// from the writer alone — the two agreeing is the control.)
//
// This is a DIFFERENT CHANNEL from the SDK's `crossSessionInbound: 'hold'`
// buffer (issue #42), which lives in the CLI process heap with no API handle
// and is unreachable from here. Nothing in this module has any bearing on #42.
//
// ── Why the envelope is not re-parsed here ───────────────────────────────────
//
// The `[message from agent …]` envelope inside a block is EXACTLY what
// `recognizeFormattedPeerMessage` (peer-messages.ts) already recognizes, for
// the #56 compact peer row. Re-implementing that regex here would give the
// tray a second, independently-rotting definition of the same envelope — so
// this module owns only the OUTER framing (splitting a file into blocks) and
// delegates the inner envelope to the one existing recognizer. A change to the
// envelope format then updates one place, not two.
//
// ── Why blocks are identified by their RAW TEXT ──────────────────────────────
//
// The inbox file is not ours alone. The `inbox-instruction.sh` hook is wired to
// SessionStart AND every UserPromptSubmit (workspaces.ts) and does
// `cat "$f"; rm -f "$f"` — so an ordinary user turn can drain and DELETE the
// whole file while the tray is showing it. An index ("release row 2") would
// therefore address a different block, or nothing, by the time it is acted on.
// Each parsed block instead carries the exact source text it came from, and
// removal is a content match (see {@link removeBlock}): a block that has
// already vanished removes NOTHING and is reported as such, which is the
// honest outcome — never a silent delivery of the wrong message.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { recognizeFormattedPeerMessage, peerPreview } from './peer-messages.ts';

/** The delimiter `queueInbox` writes around every block: exactly 40 '='. */
export const INBOX_DELIMITER = '='.repeat(40);

/** Per-inbox-file serialization chain (issue #93).
 *
 *  WHY. `queueInbox` used a bare `await appendFile(path, block)`. `appendFile`
 *  opens with `O_APPEND`, but O_APPEND atomicity is per `write(2)` syscall, NOT
 *  per `appendFile` call — Node splits a large buffer into kernel-sized chunks,
 *  so two `appendFile`s racing on the SAME path interleave their chunks and
 *  SPLICE one block inside another. No bytes are lost, but the delimiter grammar
 *  breaks and `parseInboxBlocks` OVER-COUNTS (measured on btrfs: 10 concurrent
 *  512 KB writers → 17-19 parsed blocks; latent today only because the sole
 *  caller truncates to MESSAGE_MAX_CHARS=8000, and 512 B-256 KB stay intact).
 *
 *  Every inbox writer is in ONE process (the main process; the shell hook only
 *  `cat`s + `rm`s, the tray writes synchronously with `writeFileSync`), so the
 *  fix is an in-process async mutex keyed by the resolved file path — no `flock`
 *  dependency, deterministic, and it makes one `appendFile` complete before the
 *  next on that path begins. Same defect class as the events-spool tear
 *  (#28/#37), same remedy: one writer at a time. */
const inboxAppendChains = new Map<string, Promise<unknown>>();

/** Append one already-framed block to `filePath`, serialized against every other
 *  append to the SAME path so concurrent large writes cannot splice (issue #93).
 *  `mkdir` of the parent runs inside the chain too, so the directory is present
 *  before the write without racing sibling appends. Rejects on write failure;
 *  the caller (`queueInbox`) maps that to `false`. */
export async function appendInboxBlock(filePath: string, block: string): Promise<void> {
  const key = path.resolve(filePath);
  const prior = inboxAppendChains.get(key) ?? Promise.resolve();
  // Chain even past a rejection so one failed append never wedges the path.
  const next = prior.catch(() => {}).then(async () => {
    await mkdir(path.dirname(key), { recursive: true });
    await appendFile(key, block, 'utf8');
  });
  inboxAppendChains.set(key, next);
  try {
    await next;
  } finally {
    // Drop the chain entry once we are its tail, so the map does not grow
    // unboundedly across a long-lived process.
    if (inboxAppendChains.get(key) === next) inboxAppendChains.delete(key);
  }
}

/** Make `body` safe to append as ONE block.
 *
 *  WHY THIS EXISTS (measured, adversarial review of #64). The framing delimiter
 *  is a line of 40 `=`. A message BODY may legitimately contain such a line — a
 *  markdown horizontal rule or a setext underline of 40+ chars is routine in the
 *  agent-authored reports that are this channel's entire traffic — and
 *  `dispatchMessageRequest` only trims and length-caps, so nothing stopped it
 *  reaching the file. The body then framed as SEVERAL blocks, and because
 *  removal re-serializes the whole file FROM THE PARSE, acting on one of those
 *  phantom rows rewrote the file around a mis-parse and **destroyed a
 *  neighbouring real message**. Sharpest measured form: a body
 *  `"APPROVED: merge it\n<40 =>\nNOT APPROVED: hold"` rendered as two
 *  independently-actionable rows, so Release delivered `"APPROVED: merge it"`
 *  alone — peer-tagged and attributed to the sender, with the qualifier
 *  stripped into a row the human could refuse. That is a message inverted in
 *  meaning, which is worse than losing it.
 *
 *  FIXED AT WRITE TIME, ON PURPOSE. The parser cannot distinguish a real
 *  delimiter from an injected one after the fact — by then the information is
 *  gone. Sanitizing on the way in keeps the invariant "one appended block is
 *  one message" true by construction, and leaves the on-disk grammar (which the
 *  `inbox-instruction.sh` shell hook also `cat`s) completely unchanged.
 *
 *  The transformation is deliberately MINIMAL and lossless-to-the-reader: a
 *  run-of-40-or-more `=` alone on its line gets a leading space, so it still
 *  reads as a rule to both the human and the agent but can no longer match the
 *  `^={40,}$` framing pattern. Nothing else is touched — no escaping scheme the
 *  hook would have to learn, no metadata, no truncation. */
export function sanitizeInboxBody(body: string): string {
  // Only a delimiter-shaped LINE is dangerous; a run inside prose never matched
  // the anchored pattern, so it must not be rewritten.
  return body.replace(/^(={40,})$/gm, ' $1');
}

/** One parked message, as the tray renders it. */
export interface InboxBlock {
  /** Stable-per-content identity: index within the file plus a hash-free slice
   *  of the raw text. Used as a React key only — never to address a block for
   *  removal (the file mutates underneath us; see {@link removeBlock}). */
  id: string;
  /** Sending workspace's branch name when the envelope named one, else ''. */
  from: string;
  /** Sending workspace's id when the envelope named one, else ''. */
  fromId: string;
  /** Message body with the envelope header and reply footer stripped. Falls
   *  back to the block's whole inner text when the envelope is unrecognized,
   *  so a hand-written or future-format block still shows its content rather
   *  than rendering as an empty row. */
  body: string;
  /** First non-empty line of {@link body}, length-capped for a one-line row. */
  preview: string;
  /** The block's exact inner text (between the delimiters, trimmed of the
   *  single framing newlines). This is what gets DELIVERED on Release — the
   *  full envelope, so the receiving session sees the same text the inbox hook
   *  would have shown it. */
  text: string;
}

/** Split an inbox file's contents into its parked blocks, in file order.
 *
 *  Tolerant by construction: the file is a plain append log that a shell hook
 *  may have half-written, and dropping every block because one is malformed
 *  would hide real messages. Anything between two delimiter lines is a block;
 *  trailing content after an unterminated delimiter is taken as a final block
 *  so an in-flight append is still surfaced rather than silently swallowed.
 *  Empty/whitespace-only segments are skipped (a file always starts with a
 *  leading '\n' before the first delimiter). */
export function parseInboxBlocks(contents: string): InboxBlock[] {
  if (!contents.trim()) return [];
  const blocks: InboxBlock[] = [];
  // Split on delimiter LINES only — a '=' run inside a message body (an ASCII
  // rule in a report, say) must not be mistaken for framing, so the delimiter
  // is required to occupy its own line.
  const segments = contents.split(new RegExp(`^${INBOX_DELIMITER}=*$`, 'm'));
  for (const segment of segments) {
    const text = segment.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!text.trim()) continue;
    blocks.push(toBlock(text, blocks.length));
  }
  return blocks;
}

function toBlock(text: string, index: number): InboxBlock {
  const recognized = recognizeFormattedPeerMessage(text);
  const body = recognized ? recognized.body : text;
  return {
    id: `${index}:${text.slice(0, 32)}`,
    from: recognized?.origin.name ?? '',
    fromId: recognized?.origin.from ?? '',
    body,
    preview: peerPreview(body),
    text,
  };
}

/** What a Release/Refuse actually did, as reported to the renderer.
 *
 *  `'gone'` is a NORMAL outcome rather than an error: the `inbox-instruction.sh`
 *  hook drains the file on every SessionStart and UserPromptSubmit, so a block
 *  can legitimately vanish between the tray rendering it and the human clicking
 *  it. The renderer treats it as "the list moved on", not as a failure.
 *
 *  `'not-delivered'` means the session never took the turn (no live structured
 *  session, or it was dropped/timed out). The block stays PARKED in that case —
 *  losing a message is strictly worse than showing it twice. */
export type InboxActionFailure = {
  ok: false;
  reason: 'gone' | 'not-delivered' | 'write-failed';
  remaining: number;
};
export type InboxActionOutcome = { ok: true; remaining: number } | InboxActionFailure;

/** Result of removing one block from an inbox file's contents. */
export interface RemoveResult {
  /** The file contents with the block gone, ready to write back. */
  contents: string;
  /** False when the block was not present — it was already drained by the
   *  inbox hook, or released by another window. The caller MUST treat this as
   *  "nothing was delivered/discarded" rather than retrying blindly. */
  removed: boolean;
}

/** Remove the block whose inner text matches `text`, returning the rewritten
 *  file contents. Content-addressed on purpose (see the header note): the only
 *  safe way to act on a file a shell hook may rewrite between render and click.
 *
 *  Re-serializes from the surviving parsed blocks rather than splicing the
 *  original string, so the output is always canonically framed even when the
 *  input was not. Only the FIRST match is removed — two byte-identical parked
 *  messages are two messages, and releasing one must leave the other. */
export function removeBlock(contents: string, text: string): RemoveResult {
  const blocks = parseInboxBlocks(contents);
  const target = text.trim();
  const idx = blocks.findIndex((b) => b.text.trim() === target);
  if (idx === -1) return { contents, removed: false };
  blocks.splice(idx, 1);
  return { contents: serializeInboxBlocks(blocks.map((b) => b.text)), removed: true };
}

/** Re-emit block texts in `queueInbox`'s exact on-disk framing, so a file this
 *  module rewrites is byte-identical to one the appender would have produced
 *  and the inbox hook keeps working unchanged. Empty input yields '' — the
 *  caller deletes the file rather than leaving an empty one behind. */
export function serializeInboxBlocks(texts: string[]): string {
  return texts.map((t) => `\n${INBOX_DELIMITER}\n${t}\n${INBOX_DELIMITER}\n`).join('');
}

/** The write decision for the composer's file re-derive (issue #91), extracted
 *  pure so the renderer and its test drive the SAME logic (the renderer can't be
 *  imported under the node test runner).
 *
 *  The tray re-reads the inbox FILE on focus / mount / turn-start to retract a
 *  stale chip even when the directory watcher misses the drain. But the read is
 *  async, and the turn-start edge fires the instant the prompt is QUEUED —
 *  strictly BEFORE the CLI hook `rm`s the file — so the read can observe a block
 *  that is about to be deleted. If, while that read is in flight, the watcher
 *  fires `inbox:update` and the store retracts, writing the stale read back would
 *  RESURRECT the exact #91 stale chip (REVIEW-91 F1). A per-workspace
 *  drain-generation, bumped on every `inbox:update`, is the staleness token:
 *
 *  - `genNow !== genAtRead` → a fresher watcher event landed during the read;
 *    DISCARD (`{ write: false }`), the watcher's value stands.
 *  - otherwise the read is authoritative: write it, unless it is byte-identical
 *    to `prev` (a no-op we skip so an unchanged cache doesn't notify
 *    subscribers on every turn start). */
export function resolveInboxReDerive(args: {
  genAtRead: number;
  genNow: number;
  prev: InboxBlock[];
  read: InboxBlock[];
}): { write: false } | { write: true; blocks: InboxBlock[] } {
  const { genAtRead, genNow, prev, read } = args;
  if (genNow !== genAtRead) return { write: false };
  if (prev.length === read.length && prev.every((b, i) => b.text === read[i].text)) {
    return { write: false };
  }
  return { write: true, blocks: read };
}
