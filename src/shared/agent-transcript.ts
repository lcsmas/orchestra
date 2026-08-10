/**
 * Convert a Claude Code on-disk session transcript (the JSONL under
 * `<configDir>/projects/<mangled-cwd>/<sessionId>.jsonl`) into Orchestra's
 * {@link AgentEvent} stream, so a resumed workspace's structured view can
 * BACKFILL the conversation history instead of opening blank.
 *
 * The on-disk format is close to the live SDK stream but not identical
 * (verified against a real 1786-line transcript, 2026-07-21):
 *   • Lines carry a Claude-Code envelope (`uuid`, `timestamp`, `isSidechain`,
 *     `cwd`, …) around a `message` — the envelope is ignored here.
 *   • Assistant prose lives FINALIZED in `type:"assistant"` lines'
 *     `content[].text` blocks — there are NO `stream_event` deltas on disk, so
 *     we synthesize block-start/text-delta/block-stop triplets per text block.
 *   • Tool results arrive as `type:"user"` lines whose content array carries
 *     `tool_result` blocks (same as the live stream).
 *   • There are NO `result` lines — one synthetic terminal `turn-end` is
 *     appended so the folded session ends not-running.
 *   • `isSidechain: true` lines are Task-subagent transcripts interleaved into
 *     the same file — they must be skipped or the main transcript is flooded
 *     with subagent noise.
 *   • Bookkeeping line types (`mode`, `attachment`, `file-history-*`,
 *     `ai-title`, `pr-link`, …) are skipped by only matching user/assistant.
 *
 * Pure data-in/data-out (no node/electron imports) so `node --test` covers it.
 */

import type { AgentEvent, AgentImage } from './types';
// Explicit .ts extension: the `node --test` strip-types runner resolves this
// import at runtime (vite/esbuild don't care either way).
import {
  stamp,
  normalizeResultContent,
  classifyUserText,
  type NormalizeContext,
} from './agent-events.ts';

/** Block indexes for synthesized history blocks start here — far above any real
 *  SDK content-block index (single digits), so a live session's early blocks
 *  can never be matched into a history message by the fold's index lookup. */
const HISTORY_INDEX_BASE = 100_000;

/** `seq` for a history backfill starts here, for the same reason
 *  HISTORY_INDEX_BASE exists — but for message IDENTITY rather than block
 *  correlation.
 *
 *  Every RenderMessage id the fold mints is built from `event.seq`
 *  (`user:<seq>`, `error:<seq>`, `notice:<seq>`, `<sessionId>:<seq>:<index>`),
 *  and those ids are the React keys, the virtualizer's measured-height cache
 *  keys AND its scroll-anchor keys. A backfill used to run on a fresh
 *  `{seq: 0}` cursor, so history's FIRST message was `user:0` — colliding with
 *  the first user turn of the live session, which also starts at 0. The
 *  transcript then held two rows with the same id, one at the very top and one
 *  at the very bottom, and `StructuredView`'s anchor lookup (`indexOf`)
 *  resolved the bottom one to the top one: scrolling up a hair from the bottom
 *  teleported the viewport to the beginning of the transcript. Reproduced
 *  against a real 181-message transcript before this base existed.
 *
 *  A live cursor is per-workspace-monotonic (see agent-sdk.ts) and would need a
 *  billion events in one workspace to reach this floor, so history ids and live
 *  ids now occupy disjoint id spaces by construction. */
export const HISTORY_SEQ_BASE = 1_000_000_000;

interface TranscriptEnvelope {
  type?: string;
  isSidechain?: boolean;
  /** The Claude Code message UUID for this line — the **rewind target** for a
   *  user turn (see AgentUserMessageEvent.rewindId). Note the on-disk envelope
   *  is camelCase (`uuid`, `parentUuid`, `sessionId`) where the live wire shape
   *  is snake_case (`session_id`) — two different serializations. */
  uuid?: string;
  message?: { role?: string; content?: unknown };
}

interface TranscriptBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: unknown;
  /** Present on `image` blocks — the base64 vision source the user pasted, in
   *  the Messages API shape (`{type:'base64', media_type, data}`). */
  source?: { type?: string; media_type?: string; data?: string };
}

/** Convert raw transcript JSONL text into an ordered AgentEvent list. Unparsable
 *  or irrelevant lines are skipped, never thrown on. Returns `[]` for a
 *  transcript with no renderable content. */
export function transcriptToEvents(jsonl: string, ctx: NormalizeContext): AgentEvent[] {
  const out: AgentEvent[] = [];
  let blockIndex = HISTORY_INDEX_BASE;

  /** Emit a user text as its PROPER event (see classifyUserText): slash-command
   *  invocations become the `/cmd args` the user typed, `<local-command-stdout>`
   *  acks a quiet command-output notice, interrupt markers an `interrupted`
   *  notice — instead of raw-XML user bubbles on backfill. Returns true when a
   *  user-message bubble was emitted (the image-attachment anchor). */
  const pushUserText = (text: string, extra: { rewindId?: string; images?: AgentImage[] }): boolean => {
    const c = classifyUserText(text);
    if (c.kind === 'interrupted') {
      out.push(stamp(ctx, { type: 'notice', kind: 'interrupted', text: 'Interrupted by user' }));
      if (!c.rest) return false;
      out.push(stamp(ctx, { type: 'user-message', text: c.rest, ...extra }));
      return true;
    }
    if (c.kind === 'command-output') {
      if (c.text) out.push(stamp(ctx, { type: 'notice', kind: 'command-output', text: c.text }));
      return false;
    }
    if (!c.text) return false;
    out.push(stamp(ctx, { type: 'user-message', text: c.text, ...extra }));
    return true;
  };

  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let entry: TranscriptEnvelope;
    try {
      entry = JSON.parse(line) as TranscriptEnvelope;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    // Task-subagent lines share the file; only the main chain is our transcript.
    if (entry.isSidechain === true) continue;

    if (entry.type === 'user') {
      const content = entry.message?.content;
      // The line's own uuid is this turn's rewind target — recovered so a
      // REOPENED workspace can rewind its history, not just turns sent live
      // this run. (Only user lines carry a usable target; tool_result lines
      // share the `user` type but are not turns the user can rewind to, so the
      // id rides only on the text/image bubbles below.)
      const rewindId = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : undefined;
      if (typeof content === 'string') {
        if (content.trim()) pushUserText(content, rewindId ? { rewindId } : {});
      } else if (Array.isArray(content)) {
        const blocks = content as TranscriptBlock[];
        // Reconstruct pasted images so a reopened workspace shows them instead of
        // silently dropping them (the live echo carried them via makeUserMessage,
        // but the on-disk backfill used to skip `image` blocks entirely). The SDK
        // serializes a user turn as `[...image blocks, text block]`; we gather the
        // images and attach them to the turn's user-message.
        const images: AgentImage[] = [];
        for (const b of blocks) {
          if (
            b?.type === 'image' &&
            b.source?.type === 'base64' &&
            typeof b.source.media_type === 'string' &&
            typeof b.source.data === 'string'
          ) {
            images.push({ mediaType: b.source.media_type, dataBase64: b.source.data });
          }
        }
        let imagesAttached = false;
        // Attach the images to the FIRST text block so they render on the same
        // bubble; emit any remaining text blocks plain.
        for (const b of blocks) {
          if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            out.push(
              stamp(ctx, {
                type: 'tool-result',
                toolUseId: b.tool_use_id,
                content: normalizeResultContent(b.content),
                // Observed serialized both as a boolean and (in at least one
                // real file) as the string "true"/"false".
                isError: b.is_error === true || b.is_error === 'true',
              }),
            );
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            const emitted = pushUserText(b.text, {
              ...(!imagesAttached && images.length > 0 ? { images } : {}),
              ...(rewindId ? { rewindId } : {}),
            });
            if (emitted) imagesAttached = true;
          }
        }
        // An image-only turn (no caption) still renders a bubble with the images.
        if (!imagesAttached && images.length > 0) {
          out.push(
            stamp(ctx, {
              type: 'user-message',
              text: '',
              images,
              ...(rewindId ? { rewindId } : {}),
            }),
          );
        }
      }
      continue;
    }

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as TranscriptBlock[]) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const index = blockIndex++;
          out.push(stamp(ctx, { type: 'block-start', index, kind: 'text' }));
          out.push(stamp(ctx, { type: 'text-delta', index, text: b.text }));
          out.push(stamp(ctx, { type: 'block-stop', index }));
        } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
          const index = blockIndex++;
          // Carry the tool id/name like the live stream's content_block_start
          // does, so the fold mints the message with its final id up front
          // (stable React key — see agent-events.ts block-start).
          out.push(
            stamp(ctx, { type: 'block-start', index, kind: 'tool_use', toolUseId: b.id, name: b.name ?? '' }),
          );
          out.push(
            stamp(ctx, {
              type: 'tool-use',
              toolUseId: b.id,
              name: b.name ?? '',
              input: (b.input && typeof b.input === 'object'
                ? b.input
                : {}) as Record<string, unknown>,
            }),
          );
        }
        // thinking blocks are redacted on disk too — nothing to show.
      }
    }
  }

  if (out.length > 0) {
    // The on-disk transcript has no `result` lines; without a terminal
    // turn-end the fold would leave the session stuck `running` (the
    // user-message fold flips it on). One synthetic quiet turn-end settles it.
    out.push(
      stamp(ctx, {
        type: 'turn-end',
        isError: false,
        stopReason: 'end_turn',
        numTurns: 0,
        costUsd: null,
        usage: null,
        resultText: null,
        sessionId: '',
        durationMs: null,
      }),
    );
  }
  return out;
}
