import { useState } from 'react';
import { SOUNDS, getSelectedSoundId, playSoundById, setSelectedSoundId } from '../chime';

interface Props {
  onClose: () => void;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function SoundSettings({ onClose }: Props) {
  const [selected, setSelected] = useState<string>(getSelectedSoundId());

  const pick = (id: string) => {
    setSelected(id);
    setSelectedSoundId(id);
    playSoundById(id);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sound-settings" onClick={(e) => e.stopPropagation()}>
        <h2>Notification sound</h2>
        <div className="sound-hint">
          Plays when an agent finishes working. Click a row to preview and select.
        </div>
        <div className="sound-list">
          {SOUNDS.map((s) => (
            <button
              key={s.id}
              className={`sound-row ${selected === s.id ? 'selected' : ''}`}
              onClick={() => pick(s.id)}
            >
              <span className="sound-radio" aria-hidden="true">
                <span className="sound-radio-dot" />
              </span>
              <span className="sound-meta">
                <span className="sound-name">{s.name}</span>
                <span className="sound-desc">{s.description}</span>
              </span>
              {s.id !== 'none' && (
                <span
                  className="sound-play"
                  aria-label={`Preview ${s.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    playSoundById(s.id);
                  }}
                >
                  <PlayIcon />
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
