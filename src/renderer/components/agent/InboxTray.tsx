import { useState } from 'react';
import type { InboxBlock } from '../../../shared/inbox-blocks';

/** The inbox tray — messages other agents sent to this workspace while it was
 *  not reachable, parked in `~/.orchestra/inbox/<id>.txt` (issue #64).
 *
 *  WHY IT EXISTS. Orchestra parks a peer message on disk whenever it cannot
 *  hand it to a live session. Until now that file was invisible: the
 *  `inbox-instruction.sh` hook printed and deleted it at the workspace's next
 *  session start or prompt submit, so a parked message sat unseen for as long
 *  as the workspace stayed idle — and then arrived as an unattributed wall of
 *  text the human never got to decline. The tray makes the park VISIBLE and
 *  gives it the two actions it always needed: deliver it now, or refuse it.
 *
 *  NOT the SDK's held-message buffer. The Claude CLI's `crossSessionInbound:
 *  'hold'` queue lives in the CLI process heap with no API handle (issue #42,
 *  blocked upstream). This tray is backed by Orchestra's own durable file and
 *  has no bearing on that channel.
 *
 *  Docked inside the composer frame above the input, for the same reason
 *  {@link QueueTray} is: the transcript scrolls, and a parked message must not
 *  be off-screen at the moment the human wants to act on it. Collapsed to a
 *  single chip by default — mail that has waited hours is not urgent enough to
 *  spend the vertical space a full list costs, and the count is the only thing
 *  needed to decide whether to look.
 *
 *  AMBER, deliberately: this is the same "needs your attention, nothing is
 *  broken" register as the usage-limit and MCP-pending chips (`--av-warn`), not
 *  the error red of a failure. */
export interface InboxTrayProps {
  blocks: InboxBlock[];
  /** Deliver one block as the session's next turn. */
  onRelease: (text: string) => void;
  /** Discard one block (logged in main, never a silent drop). */
  onRefuse: (text: string) => void;
  /** Deliver every block, oldest first. */
  onReleaseAll: () => void;
  /** Expanded on mount. Exists ONLY so the SSR render-smoke can assert the
   *  expanded markup deterministically without click-driving; the real
   *  expand/collapse interaction is covered by the browser E2E gate. Mirrors
   *  `PeerMessageGroup`'s `defaultOpen` for the same reason. */
  defaultOpen?: boolean;
}

/** The chip's label. Exported pure so it can be asserted without a DOM — the
 *  renderer has no jsdom, so any logic worth testing lives in a function like
 *  this one (same discipline as `QueueTray`'s `turnCount`). */
export function inboxChipLabel(count: number): string {
  return `${count} message${count === 1 ? '' : 's'} held`;
}

export function InboxTray({
  blocks,
  onRelease,
  onRefuse,
  onReleaseAll,
  defaultOpen = false,
}: InboxTrayProps) {
  const [open, setOpen] = useState(defaultOpen);
  // No mail, no chip. The tray must occupy ZERO space in the common case —
  // every workspace renders this component on every composer paint.
  if (blocks.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="av-inbox-chip"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Messages from other agents, parked while this workspace was unreachable"
      >
        <span className="av-inbox-glyph" aria-hidden>
          ✉
        </span>
        {inboxChipLabel(blocks.length)}
      </button>
    );
  }

  return (
    <div className="av-inbox" role="region" aria-label="Held messages from other agents">
      <div className="av-inbox-head">
        <button
          type="button"
          className="av-inbox-collapse"
          onClick={() => setOpen(false)}
          aria-expanded
          title="Collapse"
        >
          <span className="av-inbox-glyph" aria-hidden>
            ✉
          </span>
          {inboxChipLabel(blocks.length)}
        </button>
        <span className="av-inbox-spacer" />
        {blocks.length > 1 && (
          <button type="button" className="av-inbox-btn av-inbox-release" onClick={onReleaseAll}>
            Release all
          </button>
        )}
      </div>
      <div className="av-inbox-list">
        {blocks.map((b) => (
          <div className="av-inbox-row" key={b.id}>
            {/* The sender is the first thing scanned — it decides whether the
                message matters — so it leads the row and never wraps. */}
            <span className="av-inbox-from" title={b.fromId || undefined}>
              {b.from || 'unknown agent'}
            </span>
            {/* One line, ellipsised. `title` carries the full body so the whole
                message is reachable on hover without expanding the row and
                shifting every control below it. */}
            <span className="av-inbox-preview" title={b.body}>
              {b.preview || '(empty message)'}
            </span>
            <span className="av-inbox-actions">
              <button
                type="button"
                className="av-inbox-btn av-inbox-release"
                onClick={() => onRelease(b.text)}
                title="Deliver this message as the session's next turn"
              >
                Release ▶
              </button>
              <button
                type="button"
                className="av-inbox-btn av-inbox-refuse"
                onClick={() => onRefuse(b.text)}
                title="Discard this message (recorded in the app log)"
              >
                Refuse ✕
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
