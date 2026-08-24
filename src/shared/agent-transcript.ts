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
  originLabel,
  type NormalizeContext,
} from './agent-events.ts';
import {
  contextUsageFromTranscript,
  transcriptContextTokens,
  type TranscriptUsage,
} from './context-usage.ts';

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
  /** ISO-8601 wall-clock time the line was written — the REAL historical time
   *  of the message. Recovered so backfilled bubbles/turn dividers show when
   *  the conversation actually happened, not when the workspace was reopened. */
  timestamp?: string;
  /** The on-disk spelling of the wire's `isSynthetic` (the CLI persists
   *  `isMeta: msg.isSynthetic`): a CLI-GENERATED user frame the human never
   *  typed — skill-body expansions ("Base directory for this skill: …" +
   *  the whole SKILL.md), "Continue from where you left off." continuation
   *  prompts, `[Image: …]` coordinate-mapping placeholders,
   *  `<local-command-caveat>` wrappers. The live normalize path drops their
   *  text (`msg.isSynthetic !== true`, agent-events.ts), so none of these
   *  ever render in a live session. */
  isMeta?: boolean;
  /** The compact/continuation summary frame ("This session is being continued
   *  from a previous conversation…") — CLI context plumbing, not a user turn.
   *  The SDK's own resume replay skips these lines wholesale. */
  isCompactSummary?: boolean;
  /** Same shape the live wire carries on `msg.origin` — recovered so a
   *  reopened workspace keeps the origin badge (claude.ai / peer / task
   *  notification) its externally-originated turns had live. */
  origin?: { kind?: string; from?: string; name?: string; body?: string };
  /** Assistant lines carry the API call's `usage`. Read for the context gauge:
   *  a history/detached session has no live `Query` to ask, so the last
   *  main-chain assistant turn's input components are the only context figure
   *  available (same formula as `activity.ts computeContextTokens`). */
  message?: {
    role?: string;
    content?: unknown;
    usage?: TranscriptUsage;
    /** Model id the line ran under (e.g. `claude-opus-4-8`, or an alias
     *  carrying `[1m]`). The transcript records NO window — verified absent on
     *  every real assistant line — so this is the only signal available to
     *  derive one for the gauge. */
    model?: string;
  };
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
  /** Context size of the newest main-chain assistant turn seen so far — the
   *  gauge's only available figure for a session with no live `Query`. Reset at
   *  a compaction boundary: everything before it is pre-compact and stale, the
   *  mirror of the on-disk recompute returning 0 when the newest entry IS a
   *  boundary (activity.ts computeContextTokens). We walk oldest-first, so
   *  "reset on pass" is equivalent to its "stop at the newest boundary". */
  let contextTokens = 0;
  /** Model id of the line `contextTokens` came from — the transcript's only
   *  window signal (it records no window itself). */
  let contextModel: string | null = null;

  // The current line's real wall-clock time (envelope `timestamp`), when
  // parsable. `stamp()` assigns `at` from the clock (= backfill-load time here);
  // this hook rewrites it to the historical instant so the structured view's
  // time indications are honest on reopened workspaces. Carried between lines
  // so blocks on a timestamp-less line inherit the previous line's time rather
  // than jumping to "now".
  let lineAt: number | undefined;
  const st: typeof stamp = (c, body) => {
    const e = stamp(c, body);
    return lineAt !== undefined ? { ...e, at: lineAt } : e;
  };

  /** Emit a user text as its PROPER event (see classifyUserText): slash-command
   *  invocations become the `/cmd args` the user typed, `<local-command-stdout>`
   *  acks a quiet command-output notice, interrupt markers an `interrupted`
   *  notice — instead of raw-XML user bubbles on backfill. Returns true when a
   *  user-message bubble was emitted (the image-attachment anchor). */
  const pushUserText = (
    text: string,
    extra: { rewindId?: string; images?: AgentImage[]; origin?: string },
  ): boolean => {
    const c = classifyUserText(text);
    if (c.kind === 'interrupted') {
      out.push(st(ctx, { type: 'notice', kind: 'interrupted', text: 'Interrupted by user' }));
      if (!c.rest) return false;
      out.push(st(ctx, { type: 'user-message', text: c.rest, ...extra }));
      return true;
    }
    if (c.kind === 'command-output') {
      if (c.text) out.push(st(ctx, { type: 'notice', kind: 'command-output', text: c.text }));
      return false;
    }
    if (!c.text) return false;
    out.push(st(ctx, { type: 'user-message', text: c.text, ...extra }));
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
    if (typeof entry.timestamp === 'string') {
      const t = Date.parse(entry.timestamp);
      if (!Number.isNaN(t)) lineAt = t;
    }

    if (entry.type === 'user') {
      const content = entry.message?.content;
      // A compact/continuation summary is not a user turn — without this gate
      // it backfilled as a wall-of-text user bubble no live session ever
      // showed. Surface it as the boundary marker it is (parity with the live
      // stream's compact_boundary notice).
      if (entry.isCompactSummary === true) {
        // Pre-compact usage is stale the moment the context is rewritten.
        contextTokens = 0;
        contextModel = null;
        out.push(st(ctx, { type: 'notice', kind: 'compact-boundary', text: 'Conversation compacted' }));
        continue;
      }
      // CLI-synthetic frames (see TranscriptEnvelope.isMeta): the live path
      // drops their TEXT but still consumes their tool_result blocks, so the
      // backfill must mirror exactly that — without this gate every skill
      // invocation rendered its entire SKILL.md body as a giant user message
      // after an app restart ("skills show as messages from the user").
      const synthetic = entry.isMeta === true;
      // The line's own uuid is this turn's rewind target — recovered so a
      // REOPENED workspace can rewind its history, not just turns sent live
      // this run. (Only user lines carry a usable target; tool_result lines
      // share the `user` type but are not turns the user can rewind to, so the
      // id rides only on the text/image bubbles below.)
      const rewindId = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : undefined;
      const origin = originLabel(entry.origin);
      if (typeof content === 'string') {
        if (!synthetic && content.trim()) {
          pushUserText(content, { ...(rewindId ? { rewindId } : {}), ...(origin ? { origin } : {}) });
        }
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
              st(ctx, {
                type: 'tool-result',
                toolUseId: b.tool_use_id,
                content: normalizeResultContent(b.content),
                // Observed serialized both as a boolean and (in at least one
                // real file) as the string "true"/"false".
                isError: b.is_error === true || b.is_error === 'true',
              }),
            );
          } else if (!synthetic && b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            const emitted = pushUserText(b.text, {
              ...(!imagesAttached && images.length > 0 ? { images } : {}),
              ...(rewindId ? { rewindId } : {}),
              ...(origin ? { origin } : {}),
            });
            if (emitted) imagesAttached = true;
          }
        }
        // An image-only turn (no caption) still renders a bubble with the images.
        if (!synthetic && !imagesAttached && images.length > 0) {
          out.push(
            st(ctx, {
              type: 'user-message',
              text: '',
              images,
              ...(rewindId ? { rewindId } : {}),
              ...(origin ? { origin } : {}),
            }),
          );
        }
      }
      continue;
    }

    if (entry.type === 'assistant') {
      // Track the newest main-chain assistant turn's context size. Sidechain
      // lines were already skipped above, so every line reaching here counts.
      // Captured BEFORE the content guard below: a line whose content is not an
      // array still carries a usable `usage`, and skipping it would silently
      // drop the newest (i.e. the correct) reading.
      const lineTokens = transcriptContextTokens(entry.message?.usage);
      if (lineTokens > 0) {
        contextTokens = lineTokens;
        // Track the model alongside the tokens so the window is derived from
        // the SAME line the figure came from. `<synthetic>` lines carry no real
        // model and no usage, so they never reach here.
        contextModel = typeof entry.message?.model === 'string' ? entry.message.model : null;
      }
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as TranscriptBlock[]) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const index = blockIndex++;
          out.push(st(ctx, { type: 'block-start', index, kind: 'text' }));
          out.push(st(ctx, { type: 'text-delta', index, text: b.text }));
          out.push(st(ctx, { type: 'block-stop', index }));
        } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
          const index = blockIndex++;
          // Carry the tool id/name like the live stream's content_block_start
          // does, so the fold mints the message with its final id up front
          // (stable React key — see agent-events.ts block-start).
          out.push(
            st(ctx, { type: 'block-start', index, kind: 'tool_use', toolUseId: b.id, name: b.name ?? '' }),
          );
          out.push(
            st(ctx, {
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
    // Seed the context gauge for a history/detached session. Without this the
    // gauge renders NOTHING at mount for these sessions: the synthetic
    // turn-end below carries `usage: null`, and there is no live `Query` to
    // ask. Tagged `transcript`, so if a live session later attaches, its
    // authoritative reading supersedes this one (isMoreAuthoritative) rather
    // than the two fighting.
    if (contextTokens > 0) {
      out.push(
        st(ctx, {
          type: 'session/context',
          usage: contextUsageFromTranscript(
            contextTokens,
            ctx.now ? ctx.now() : Date.now(),
            contextModel,
          ),
        }),
      );
    }
    // The on-disk transcript has no `result` lines; without a terminal
    // turn-end the fold would leave the session stuck `running` (the
    // user-message fold flips it on). One synthetic quiet turn-end settles it.
    out.push(
      st(ctx, {
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
