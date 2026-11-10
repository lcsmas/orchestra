import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';

interface Props {
  onClose: () => void;
}

/**
 * The Bloc HTML switch (#418, ADR 0011): ONE boolean that both tells agents the surface exists and allows the rendering.
 * The write is `setBlocHtmlEnabled`; the store follows the host's echo, so every bloc already on screen flips to a code block (or back) at once.
 * A running turn is untouched: the instruction reaches sessions started or resumed afterwards.
 */
export function BlocHtmlSettings({ onClose }: Props) {
  const enabled = useStore((s) => s.blocHtmlEnabled);
  const [busy, setBusy] = useState(false);

  // Re-read the host on open: a failed boot read leaves the store at false, and the switch must show what the host holds.
  useEffect(() => {
    void window.orchestra.blocHtmlEnabled().then((v) => useStore.setState({ blocHtmlEnabled: v })).catch(() => {});
  }, []);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const stored = await window.orchestra.setBlocHtmlEnabled(!enabled);
      useStore.setState({ blocHtmlEnabled: stored });
    } catch {
      // Not saved: leave the store as it was — the switch must never show a state the host did not take.
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings bloc-html-settings">
        <h2>Bloc HTML</h2>
        <div className="sound-hint">
          Agents may write a chart, a comparison or a board as HTML inside a reply. It is shown in an isolated frame that may load https resources
          but never reaches the app. Turning it off stops telling new sessions about it and shows every bloc already in a conversation as a code block.
          A change applies to sessions started or resumed afterwards; a conversation already told keeps what it was told, and a running turn is not disturbed.
        </div>
        <div className="sound-list">
          <button
            className={`sound-row ${enabled ? 'selected' : ''}`}
            role="switch"
            aria-checked={enabled}
            data-bloc-html-switch
            data-live-state={enabled ? 'ON' : 'OFF'}
            disabled={busy}
            onClick={() => void toggle()}
          >
            <span className="sound-radio" aria-hidden="true">
              <span className="sound-radio-dot" />
            </span>
            <span className="sound-meta">
              <span className="sound-name">Render HTML in replies — {enabled ? 'ON' : 'OFF'}</span>
              <span className="sound-desc">On by default. Applies to every workspace session, spawned agents and fleet members included.</span>
            </span>
          </button>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
