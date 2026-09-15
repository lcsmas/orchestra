import React, { useMemo, useState } from 'react';
import type { RenderMessage } from '../../../shared/types';
import { busWakeCommands, busWakeRuns } from '../../../shared/bus-rows';

interface Props {
  /** A bus WAKE ORDER user message (`isBusWakeMessage` true). */
  message: RenderMessage;
  /** Start expanded. Default false — collapsed is the point (Variant A). Exists
   *  so the render-smoke can assert the EXPANDED markup deterministically under
   *  SSR (same pattern as PeerMessageGroup). Production never passes it. */
  defaultOpen?: boolean;
}

/**
 * A bus WAKE ORDER rendered as a compact dedicated row (issue #145, Variant A —
 * "quiet rows"). Instead of the raw synthetic prompt text (`WAKE_ORDER_HEADER` +
 * `orchestra check --run <r>` lines) — which was indistinguishable at a glance
 * from a human message — the wake shows as an amber bell chip line:
 *
 *   🔔 › Wake order   [check 2 runs]
 *
 * collapsed by default, expanding to the exact ordered `orchestra check --run`
 * commands. MARKER-KEYED upstream (`isBusWakeMessage`, src/shared/bus-rows.ts):
 * a human turn merely containing "lot pending" never reaches this component.
 *
 * Same family as the #56/#64 compact peer/inbox rows — a wake is fleet traffic,
 * not the human's conversation, so it reads quietly. IDENTICAL in live and
 * backfill: both paths detect the wake through the same shared marker and render
 * this same component (the #57 live==backfill lesson).
 */
function WakeRowImpl({ message, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const runs = useMemo(() => busWakeRuns(message), [message]);
  const commands = useMemo(() => busWakeCommands(message), [message]);
  const chip = runs.length === 1 ? 'check 1 run' : `check ${runs.length} runs`;

  return (
    <div className={`av-wake ${open ? 'av-open' : 'av-closed'}`} data-wake="1">
      <button
        type="button"
        className="av-wake-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="av-wake-bell" aria-hidden>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5a1 1 0 0 1 1 1v.4a4 4 0 0 1 3 3.87v2.4l1 1.3v.53H3v-.53l1-1.3v-2.4a4 4 0 0 1 3-3.87v-.4a1 1 0 0 1 1-1Zm0 13a1.6 1.6 0 0 1-1.5-1h3A1.6 1.6 0 0 1 8 14.5Z" />
          </svg>
        </span>
        <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
          <svg
            width="9"
            height="9"
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
        <span className="av-wake-label">Wake order</span>
        <span className="av-wake-chip">{chip}</span>
      </button>
      {open && (
        <div className="av-wake-body" data-wake-body="1">
          {commands.map((cmd, i) => (
            <div className="av-wake-cmd" key={cmd}>
              <span className="av-wake-cmd-n" aria-hidden>
                {i + 1}
              </span>
              <span className="av-wake-cmd-text">{cmd}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function areEqual(a: Props, b: Props): boolean {
  return a.message.id === b.message.id && a.message.text === b.message.text;
}

export const WakeRow = React.memo(WakeRowImpl, areEqual);
