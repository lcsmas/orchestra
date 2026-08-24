import React, { useMemo, useState } from 'react';
import type { RenderMessage } from '../../../shared/types';
import { MarkdownView } from './MarkdownView';
import { describePeerRun, peerPreview, peerSender } from '../../../shared/peer-messages';

interface Props {
  /** A run of consecutive peer-origin user messages (length ≥ 1). */
  messages: RenderMessage[];
  /** Start expanded. Default false — collapsed is the whole point (#56), and
   *  expansion is deliberately NOT persisted. Exists so the render-smoke can
   *  assert the EXPANDED markup deterministically under SSR: this repo keeps
   *  jsdom out of its dependencies on purpose (see diff-pane-render-smoke.mjs),
   *  so a click-driven arm belongs to the real-browser CDP gate, not here.
   *  Production never passes it. */
  defaultOpen?: boolean;
}

/**
 * A run of INTER-AGENT messages, rendered collapsed by default as compact quiet
 * rows (issue #56).
 *
 * When a fleet is active a coordinator receives dozens of agent-to-agent
 * messages per wave. Rendered as full user bubbles they drowned the human's own
 * conversation, so each becomes ONE dimmed line — sender + first line — that
 * expands on click:
 *
 *   › 3 messages from fix-login-race
 *
 * Deliberately built in ToolGroup's image (the view's existing "quiet run of
 * things that aren't the conversation" idiom, docs/codebase-map/agent-view-design.md):
 * a borderless clickable label row, collapsed by default, expanding to the full
 * bodies. Nothing here is persisted — expansion is per-mount view state, exactly
 * like a tool run's.
 *
 * The human's own turns never reach this component: StructuredView routes only
 * messages `isPeerMessage()` accepts, which keys on the STRUCTURAL origin tag.
 */
function PeerMessageGroupImpl({ messages, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const label = useMemo(() => describePeerRun(messages), [messages]);

  return (
    <div className={`av-peer-run ${open ? 'av-open' : 'av-closed'}`} data-peer-run="1">
      <button
        type="button"
        className="av-peer-run-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5.5 3 10.5 8 5.5 13" />
          </svg>
        </span>
        <span className="av-peer-run-label">{label}</span>
        {/* A single collapsed message also previews its first line, so the row
            carries real information rather than just a count. With several,
            the count above is the summary and the bodies are one click away. */}
        {messages.length === 1 ? (
          <span className="av-peer-run-preview">{peerPreview(messages[0].text)}</span>
        ) : null}
      </button>
      {open && (
        <div className="av-peer-run-body">
          {messages.map((m) => (
            <div key={m.id} className="av-peer-msg" data-peer-msg="1">
              <div className="av-peer-msg-from">{peerSender(m)}</div>
              <div className="av-peer-msg-text av-md">
                <MarkdownView text={m.text ?? ''} done />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function areEqual(a: Props, b: Props): boolean {
  if (a.messages.length !== b.messages.length) return false;
  for (let i = 0; i < a.messages.length; i++) {
    if (a.messages[i].id !== b.messages[i].id || a.messages[i].text !== b.messages[i].text) {
      return false;
    }
  }
  return true;
}

export const PeerMessageGroup = React.memo(PeerMessageGroupImpl, areEqual);
