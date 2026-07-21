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

import type { AgentEvent } from './types';
// Explicit .ts extension: the `node --test` strip-types runner resolves this
// import at runtime (vite/esbuild don't care either way).
import {
  stamp,
  normalizeResultContent,
  type NormalizeContext,
} from './agent-events.ts';

/** Block indexes for synthesized history blocks start here — far above any real
 *  SDK content-block index (single digits), so a live session's early blocks
 *  can never be matched into a history message by the fold's index lookup. */
const HISTORY_INDEX_BASE = 100_000;

interface TranscriptEnvelope {
  type?: string;
  isSidechain?: boolean;
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
}

/** Convert raw transcript JSONL text into an ordered AgentEvent list. Unparsable
 *  or irrelevant lines are skipped, never thrown on. Returns `[]` for a
 *  transcript with no renderable content. */
export function transcriptToEvents(jsonl: string, ctx: NormalizeContext): AgentEvent[] {
  const out: AgentEvent[] = [];
  let blockIndex = HISTORY_INDEX_BASE;

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
      if (typeof content === 'string') {
        if (content.trim()) out.push(stamp(ctx, { type: 'user-message', text: content }));
      } else if (Array.isArray(content)) {
        for (const b of content as TranscriptBlock[]) {
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
            out.push(stamp(ctx, { type: 'user-message', text: b.text }));
          }
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
          out.push(stamp(ctx, { type: 'block-start', index, kind: 'tool_use' }));
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
