import React from 'react';

/**
 * The "thinking…" indicator. Per the Phase 0 spike finding, thinking text is
 * REDACTED on Opus 4.8 — `thinking_delta` events fire but carry no text — so this
 * is intentionally a pure spinner/pulse, never a text stream. It renders while a
 * {@link RenderMessage.thinking} flag is true and is unmounted by the caller (the
 * bubble/view) the moment the next content block starts, which the CSS turns into
 * a fade-out.
 *
 * Structural only — A5 owns the actual animation via the `av-thinking*` classes;
 * we ship a minimal three-dot pulse so it's visibly a spinner even before the
 * design pass lands.
 */
function ThinkingIndicatorImpl() {
  return (
    <div className="av-thinking" role="status" aria-live="polite">
      <span className="av-thinking-dots" aria-hidden>
        <span className="av-thinking-dot" />
        <span className="av-thinking-dot" />
        <span className="av-thinking-dot" />
      </span>
      <span className="av-thinking-label">Thinking…</span>
    </div>
  );
}

export const ThinkingIndicator = React.memo(ThinkingIndicatorImpl);
