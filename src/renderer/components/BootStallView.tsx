import React from 'react';
import { bootStallCopy, formatStallElapsed } from '../../shared/boot-stall';

// Pure views (no store import) so the screenshot rig can render them standalone.

const WarnGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

/** Pure sidebar badge (no store) — exported for the screenshot rig. */
export function BootStallBadgeView({ since, now }: { since: number; now: number }): React.ReactElement {
  const label = formatStallElapsed(now - since);
  const title = `Démarrage bloqué : la CLI ne répond pas depuis ${label} (réseau probable).`;
  return (
    <span className="ws-stall-badge ws-boot-stall-badge" title={title} role="img" aria-label={title} data-boot-stall="1">
      <WarnGlyph />
      {label}
    </span>
  );
}

/** Pure composer row (no store) — exported for the screenshot rig. */
export function BootStallRowView(props: {
  since: number;
  now: number;
  busy: boolean;
  onRestart: () => void;
}): React.ReactElement {
  const { title, detail } = bootStallCopy(props.since, props.now);
  return (
    <div className="av-boot-stall" role="status" data-boot-stall="1">
      <span className="av-boot-stall-icon" aria-hidden>⚠</span>
      <div className="av-boot-stall-text">
        <div className="av-boot-stall-title">{title}</div>
        <div className="av-boot-stall-detail">{detail}</div>
      </div>
      <button type="button" className="av-boot-stall-restart" disabled={props.busy} onClick={props.onRestart}>
        {props.busy ? 'Relance…' : 'Relancer'}
      </button>
    </div>
  );
}

