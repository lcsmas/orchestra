import { useState } from 'react';
import {
  readDefaultAgentView,
  writeDefaultAgentView,
  type DefaultAgentView,
} from '../default-agent-view';

interface Props {
  onClose: () => void;
}

const OPTIONS: { id: DefaultAgentView; name: string; description: string }[] = [
  {
    id: 'terminal',
    name: 'Terminal (classic)',
    description:
      'The embedded Claude Code terminal. What Orchestra has always shown.',
  },
  {
    id: 'structured',
    name: 'Structured (SDK)',
    description:
      'The native agent pane: streaming messages, collapsible tool cards, real diffs, and a permission dialog — rendered from the Claude Agent SDK instead of a terminal. The terminal stays available as a “Raw” tab.',
  },
];

/** Choose which agent view a workspace opens on by default (Phase 6). Mirrors
 *  SoundSettings: a small radio-row modal opened from the sidebar. The choice is
 *  a localStorage preference; changing it takes effect for workspaces opened
 *  after the change (open ones keep their current tab until reselected). */
export function AgentViewSettings({ onClose }: Props) {
  const [selected, setSelected] = useState<DefaultAgentView>(readDefaultAgentView());

  const pick = (id: DefaultAgentView) => {
    setSelected(id);
    writeDefaultAgentView(id);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings">
        <h2>Default agent view</h2>
        <div className="sound-hint">
          Which pane a workspace opens on. You can always switch per-workspace
          with the tabs.
        </div>
        <div className="sound-list">
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              className={`sound-row ${selected === o.id ? 'selected' : ''}`}
              onClick={() => pick(o.id)}
            >
              <span className="sound-radio" aria-hidden="true">
                <span className="sound-radio-dot" />
              </span>
              <span className="sound-meta">
                <span className="sound-name">{o.name}</span>
                <span className="sound-desc">{o.description}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
