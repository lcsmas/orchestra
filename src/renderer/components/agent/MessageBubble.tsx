import React from 'react';
import type { RenderMessage } from '../../../shared/types';
import { MarkdownView } from './MarkdownView';
import { NoticeRow } from './NoticeRow';
import { ThinkingIndicator } from './ThinkingIndicator';
import { useTypewriter } from './useTypewriter';
import { RewindControl } from './RewindControl';
import { ForkControl } from './ForkControl';
import { useRewind } from './rewind-context';
import { formatClock, formatFullStamp } from '../../../shared/message-time';

interface Props {
  message: RenderMessage;
}

/**
 * Renders a single assistant/user/system/error `RenderMessage`'s `text` as
 * streaming markdown. Fenced code blocks become syntax-highlighted
 * {@link CodeBlock}s; everything else is rendered by the lightweight markdown
 * parser. A thinking spinner shows while the message's `thinking` flag is true
 * (there is no thinking text — redacted on Opus 4.8).
 *
 * Memoized on the fields that actually affect this bubble's output (`text`,
 * `thinking`, `role`, `done`) so an unrelated token delta elsewhere in the
 * transcript — which produces a new session object every RAF flush — does NOT
 * re-render or re-parse this bubble. This is the anti-jank guarantee the plan
 * calls for.
 */
function MessageBubbleImpl({ message }: Props) {
  const { text, thinking, role, images } = message;
  // Context, not a prop: this bubble sits below several memo boundaries kept
  // deliberately render-free on the streaming hot path (see rewind-context.ts).
  const rewind = useRewind();
  const fullText = text ?? '';

  // Typewriter reveal for STREAMING ASSISTANT text: the SDK delivers tokens in
  // bursts, so revealing each burst instantly (however cheaply) reads as chunky
  // "block by block" output. Instead we reveal a growing prefix at a steady
  // frame-paced cadence (renderer/typewriter.ts) so text flows in fluidly.
  // NOTE `animate` deliberately does NOT include `!done`: when the block
  // closes (the model moves on to a tool call / the turn ends) the hook keeps
  // animating to DRAIN the unrevealed tail smoothly — gating on `!done` here
  // would flip the hook inactive and dump the tail in one frame, the exact
  // "sudden output right as a tool card appears" jump this fixes. Messages
  // that mount already-done (history) still render in full instantly — the
  // hook checks done-at-mount itself.
  const animate = role === 'assistant' && fullText.length > 0;
  const shown = useTypewriter(fullText, !!message.done, animate);

  const hasImages = !!images && images.length > 0;
  // System NOTICES (rate limit, compaction, refusal, command output, …) get
  // their own quiet row treatment instead of a prose bubble.
  if (message.noticeKind) return <NoticeRow message={message} />;
  // A message with nothing to show — e.g. a thinking-only block after the
  // spinner settles, or a text block whose first delta hasn't landed — must
  // not paint an empty bubble/rail stub in the transcript. (Images alone are
  // enough to render, though.)
  if (!text && !thinking && !hasImages) return null;

  return (
    <div
      className={`av-message av-message-${role}`}
      data-role={role}
      // Parked behind the in-flight turn — styled as pending, not sent. The
      // queue tray is the place to act on it; the bubble just stops lying about
      // having been delivered.
      data-queued={message.queued ? '1' : undefined}
    >
      {/* Hover-revealed ghost timestamp — invisible until the bubble is
          hovered (same quiet-affordance treatment as the rewind row), so the
          transcript stays chrome-free while per-message precision is one
          hover away. Positioned by CSS: left of the user bubble, top-right of
          assistant/error prose. */}
      {message.at !== undefined ? (
        <span className="av-message-ts" title={formatFullStamp(message.at)} aria-hidden="true">
          {formatClock(message.at)}
        </span>
      ) : null}
      {/* Externally-originated turn (Remote Control from claude.ai/mobile, a
          peer delivery): badge WHERE it came from so a remotely-driven session
          reads coherently. */}
      {role === 'user' && message.origin ? (
        <div className="av-message-origin">via {message.origin}</div>
      ) : null}
      {/* No "You" label — user turns are told apart from the agent by their
          distinct bubble treatment (Claude-Code-app style: a tinted, contained
          bubble for the user; plain prose for the agent). Only errors keep an
          eyebrow, where the word carries real information. */}
      {role === 'error' ? <div className="av-message-eyebrow">Error</div> : null}
      {hasImages ? (
        <div className="av-message-images">
          {images!.map((img, i) => (
            <img
              key={i}
              className="av-message-image"
              src={`data:${img.mediaType};base64,${img.dataBase64}`}
              alt="Attached"
            />
          ))}
        </div>
      ) : null}
      <div className="av-message-text">
        {shown ? (
          <div className="av-md">
            {/* Render the typewriter-revealed PREFIX (== full text once done or
                for non-assistant roles). MarkdownView handles partial markdown
                and keeps the per-frame render cheap (block-split memoization).
                `done` here means "the SHOWN text is final": while the drain is
                still revealing a finished block's tail, the prefix is partial
                markdown and must keep the streaming treatment (remend on the
                tail block) or half-open `**bold`/`[link` flashes raw. */}
            <MarkdownView text={shown} done={!!message.done && shown.length >= fullText.length} />
          </div>
        ) : null}
        {/* Streaming cursor: shown while the block is still open OR the
            typewriter is still draining a finished block's tail (the text is
            visibly typing either way). A5 styles the blink. */}
        {shown && (!message.done || shown.length < fullText.length) ? (
          <span className="av-cursor" aria-hidden />
        ) : null}
      </div>
      {thinking ? <ThinkingIndicator /> : null}
      {/* Rewind: only a USER turn carrying a rewind target can be undone. A
          ghost action row hangs BELOW the bubble (chat-app style), revealed on
          hover (CSS) so it never competes with the prose. Placed last so tab
          order runs text → action. */}
      {role === 'user' && message.rewindId && rewind ? (
        <div className="av-message-actions">
          <RewindControl
            rewindId={message.rewindId}
            onPreview={rewind.onPreview}
            onConfirm={rewind.onConfirm}
            disabled={rewind.busy}
          />
          {/* "Resume from here" (#18) — the NON-destructive sibling. Hidden on
              the first turn, where the fork would be empty and the SDK rejects
              it. Not gated on `rewind.busy`: forking mutates nothing here. */}
          {rewind.canFork(message.rewindId) ? (
            <ForkControl rewindId={message.rewindId} onFork={rewind.onFork} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function areEqual(a: Props, b: Props): boolean {
  const x = a.message;
  const y = b.message;
  return (
    x.text === y.text &&
    x.thinking === y.thinking &&
    x.role === y.role &&
    x.done === y.done &&
    x.id === y.id &&
    // Images are set once at message creation and never mutate, so an identity
    // (length) check is sufficient and cheap.
    (x.images?.length ?? 0) === (y.images?.length ?? 0) &&
    // The rewind target is minted with the message and never changes, but it
    // gates whether the affordance renders at all, so it belongs in the compare.
    // (`busy` rides the CONTEXT, which re-renders consumers on its own — that is
    // exactly why it isn't a prop.)
    x.rewindId === y.rewindId &&
    // MUTATES mid-life, unlike everything else here: a prompt parked behind an
    // in-flight turn clears this the moment the queue drains. Omitting it left
    // the store correct and the DOM stale — drained bubbles kept rendering as
    // pending forever, invisible to the fold's own unit tests (caught only by
    // driving the real DOM). This comparator is an ALLOWLIST: a new field that
    // affects rendering must be added here or it will not re-render.
    x.queued === y.queued &&
    // Minted once, immutable — compared anyway (costless) so the hover
    // timestamp can never go stale if that ever changes.
    x.at === y.at
  );
}

export const MessageBubble = React.memo(MessageBubbleImpl, areEqual);
