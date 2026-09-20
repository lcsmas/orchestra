import { useEffect, useState } from 'react';
import type { HumanGateView } from '../../../shared/human-gates';
import { formatGateAge, isGateOld } from '../../../shared/human-gates';

/** Surface A of #161 — the inline "ask row" docked above the composer in the
 *  workspace whose agent opened the gate (the human picked variant A + B).
 *
 *  A gate whose recipient is the human is a fleet question routed to the app's
 *  user. It renders here as a QUIET AMBER row — the same `--av-warn` "needs your
 *  attention, nothing is broken" register as the #64 inbox tray and the #145 wake
 *  rows, deliberately NOT a modal steal (the ticket's word: "a gentle badge, NOT
 *  a modal steal"). The user answers with a free-text ruling; answering resolves
 *  the SAME `decision_gates` row surface B reads, so both flip live (one gate,
 *  two views), records `resolved_by=human`, and re-wakes the asker with the
 *  ruling — identical to an agent gate (#119/#158).
 *
 *  IDENTICAL live and backfilled: the gates come from `store.humanGates`, which
 *  is rebuilt from the bus DB on every push, so a row rendered live and one
 *  reconstructed after an app restart are byte-identical (#57). */
export interface AskRowProps {
  /** OPEN human gates for THIS workspace (surface A filters the fleet-wide store
   *  slice by `askedBy === workspaceId`). */
  gates: HumanGateView[];
  /** Record the human's ruling on a gate and re-wake its asker. */
  onResolve: (gateId: number, resolution: string) => void;
}

/** One open gate's answer row. Kept local — the age ticks per-row and the draft
 *  is per-gate, so state does not belong on the list. */
function AskGateRow({ gate, onResolve }: { gate: HumanGateView; onResolve: AskRowProps['onResolve'] }) {
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);

  // The badge ages visibly (ticket req 3). A 30s tick is coarse enough for a
  // minute-granularity label and cheap; cleared on unmount (= gate resolved).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const ageMs = now - gate.openedAt;
  const old = isGateOld(ageMs);

  const submit = () => {
    const ruling = draft.trim();
    if (!ruling || submitting) return;
    setSubmitting(true);
    onResolve(gate.id, ruling);
    // The row disappears when the resolve lands (the store slice drops it); no
    // need to reset draft. `submitting` guards a double-send in the meantime.
  };

  return (
    <div className={`av-ask ${old ? 'av-ask-old' : ''}`} data-ask-gate={gate.id} role="group" aria-label="Decision gate from a fleet agent">
      <div className="av-ask-head">
        <span className="av-ask-bell" aria-hidden>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5a1 1 0 0 1 1 1v.4a4 4 0 0 1 3 3.87v2.4l1 1.3v.53H3v-.53l1-1.3v-2.4a4 4 0 0 1 3-3.87v-.4a1 1 0 0 1 1-1Zm0 13a1.6 1.6 0 0 1-1.5-1h3A1.6 1.6 0 0 1 8 14.5Z" />
          </svg>
        </span>
        <span className="av-ask-eyebrow">Fleet asks you</span>
        <span className="av-ask-from" title={gate.askedBy}>
          from {gate.askedByLabel} · gate #{gate.id}
        </span>
        <span className="av-ask-spacer" />
        <span className="av-ask-age" title={new Date(gate.openedAt).toLocaleString()}>
          <span className="av-ask-clock" aria-hidden>
            ⌛
          </span>
          waited {formatGateAge(ageMs)}
        </span>
      </div>
      <div className="av-ask-q">{gate.question}</div>
      <div className="av-ask-reply">
        <input
          className="av-ask-reply-input"
          placeholder="Type your ruling (recorded on the gate, resolved_by=human)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={submitting}
          aria-label={`Your ruling for gate ${gate.id}`}
        />
        <button
          type="button"
          className="av-ask-send"
          onClick={submit}
          disabled={!draft.trim() || submitting}
        >
          Answer ↵
        </button>
      </div>
    </div>
  );
}

export function AskRow({ gates, onResolve }: AskRowProps) {
  // No open gate for this workspace, no row — the component costs zero space in
  // the common case (every composer paint mounts it, like the inbox tray).
  if (gates.length === 0) return null;
  return (
    <div className="av-ask-list">
      {gates.map((g) => (
        <AskGateRow key={g.id} gate={g} onResolve={onResolve} />
      ))}
    </div>
  );
}
