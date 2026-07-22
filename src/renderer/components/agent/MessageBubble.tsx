import React from 'react';
import type { RenderMessage } from '../../../shared/types';
import { MarkdownView } from './MarkdownView';
import { ThinkingIndicator } from './ThinkingIndicator';

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

  const hasImages = !!images && images.length > 0;
  // A message with nothing to show — e.g. a thinking-only block after the
  // spinner settles, or a text block whose first delta hasn't landed — must
  // not paint an empty bubble/rail stub in the transcript. (Images alone are
  // enough to render, though.)
  if (!text && !thinking && !hasImages) return null;

  return (
    <div className={`av-message av-message-${role}`} data-role={role}>
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
        {text ? (
          <div className="av-md">
            <MarkdownView text={text} done={!!message.done} />
          </div>
        ) : null}
        {/* Streaming cursor: shown while the block is still open (not done) and
            there is already some text. A5 styles the blink. */}
        {!message.done && text ? <span className="av-cursor" aria-hidden /> : null}
      </div>
      {thinking ? <ThinkingIndicator /> : null}
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
    (x.images?.length ?? 0) === (y.images?.length ?? 0)
  );
}

export const MessageBubble = React.memo(MessageBubbleImpl, areEqual);
