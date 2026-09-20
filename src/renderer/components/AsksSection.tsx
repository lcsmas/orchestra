import { useEffect, useState } from 'react';
import type { HumanGateView } from '../../shared/human-gates';
import { byOpenedAtAsc, formatGateAge, isGateOld } from '../../shared/human-gates';

/** Surface B of #161 — the sidebar "Asks" section aggregating EVERY open human
 *  gate across the whole fleet (the human picked variant A + B).
 *
 *  A gate whose recipient is the human surfaces here regardless of which
 *  workspace's agent opened it, so the user sees every pending fleet question in
 *  one place — the value surface A alone can't give (A only shows in the asking
 *  workspace's own pane). Clicking a row DEEP-LINKS to the asking workspace
 *  (`onOpen(askedByWorkspaceId)`), where surface A's inline row lets the user
 *  answer; both read the SAME `store.humanGates` slice, so resolving in either
 *  place retracts the row from both live. The section vanishes when empty (like
 *  Tickets), amber `--av-warn` register, never a modal. */
export interface AsksSectionProps {
  /** OPEN human gates, fleet-wide (the whole `store.humanGates` slice). */
  gates: HumanGateView[];
  /** Deep-link to the asking workspace, or null if the row has no live one. */
  onOpen: (workspaceId: string | null) => void;
}

function AskSidebarRow({ gate, onOpen }: { gate: HumanGateView; onOpen: AsksSectionProps['onOpen'] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const ageMs = now - gate.openedAt;
  const old = isGateOld(ageMs);
  const linkable = !!gate.askedByWorkspaceId;
  return (
    <button
      type="button"
      className={`ask-card ${old ? 'ask-card-old' : ''}`}
      data-ask-gate={gate.id}
      onClick={() => onOpen(gate.askedByWorkspaceId)}
      disabled={!linkable}
      title={linkable ? `Open ${gate.askedByLabel} to answer` : 'The asking workspace is no longer open'}
    >
      <div className="ask-card-top">
        <span className="ask-card-from">{gate.askedByLabel}</span>
        <span className={`ask-card-age ${old ? 'ask-card-age-old' : ''}`}>
          <span aria-hidden>⌛</span> {formatGateAge(ageMs)}
        </span>
      </div>
      <div className="ask-card-q">{gate.question}</div>
    </button>
  );
}

export function AsksSection({ gates, onOpen }: AsksSectionProps) {
  if (gates.length === 0) return null;
  const sorted = [...gates].sort(byOpenedAtAsc);
  return (
    <div className="repo-section asks-section" role="region" aria-label="Fleet questions awaiting your ruling">
      <div className="repo-header">
        <div className="repo-collapse" style={{ cursor: 'default' }}>
          <span className="scratch-glyph asks-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
          </span>
          <span className="repo-name">Asks</span>
        </div>
        <span className="repo-header-actions">
          <span className="repo-count asks-count">{sorted.length}</span>
        </span>
      </div>
      {sorted.map((g) => (
        <AskSidebarRow key={g.id} gate={g} onOpen={onOpen} />
      ))}
    </div>
  );
}
