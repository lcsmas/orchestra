import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BUS_MECHANISMS,
  BUS_MECHANISM_LABEL,
  DEFAULT_BUS_SWITCHES,
  type BusMechanism,
  type BusSwitches,
} from '../../shared/bus-switches';

interface Props {
  onClose: () => void;
}

/** What each mechanism means when its switch is ON, in the settings row. */
const MECHANISM_DESC: Record<BusMechanism, string> = {
  delivery:
    'Messages are handed out as lots from the bus and acked by the reader, instead of through the inbox files. While OFF the bus records what would have been delivered.',
  wake: 'An insert on the bus wakes an idle reader with a “run orchestra check” turn. While OFF no turn is started and the missed wake is counted.',
  askGate:
    'Asks and decision gates are parked on the bus and resolved there. While OFF the ledger stays the place a ruling is recorded.',
  liveness:
    'Members publish liveness + phase heartbeats onto the bus. While OFF the pane shows only what other traffic reveals.',
};

/**
 * Flip the per-mechanism bus switches (#118, #108 Q5a/Q17a).
 *
 * THE ONE THING TO UNDERSTAND HERE: a flip does NOT change any run already in
 * flight. Switches are read at WAVE START and frozen onto the run row, so this
 * modal edits what the NEXT run will obey. That is stated in the UI rather than
 * left to be discovered, because a settings toggle that silently declines to
 * take effect is otherwise indistinguishable from one that is broken.
 *
 * The WRITE lives here, on its own `bus:setSwitches` channel — deliberately NOT
 * one of the pane's channels. The pane is read-only in v1 (T118.4) and its
 * registrar refuses write handlers; routing a settings write through it would
 * defeat that check.
 */
export function BusSwitchSettings({ onClose }: Props) {
  const [switches, setSwitches] = useState<BusSwitches>({ ...DEFAULT_BUS_SWITCHES });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setSwitches(await window.orchestra.busSwitches());
      } catch {
        // A backend that cannot answer leaves the defaults (all OFF) shown —
        // the coexistence-safe direction. Never render a switch as ON because
        // the read failed.
      }
    })();
  }, []);

  const toggle = async (m: BusMechanism) => {
    if (busy) return;
    setBusy(true);
    const next = { ...switches, [m]: !switches[m] };
    setSwitches(next);
    try {
      // Trust the backend's echo over the optimistic local state: normalization
      // happens there, and a rejected/coerced value must be what the user sees.
      setSwitches(await window.orchestra.setBusSwitches({ [m]: next[m] }));
    } catch {
      setSwitches(switches); // revert
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
      <div className="modal sound-settings bus-switch-settings">
        <h2>Fleet bus mechanisms</h2>
        <div className="sound-hint">
          One switch per mechanism. <strong>Switches are read at wave start and
          frozen for the run</strong> — flipping one here never changes a run
          already in flight; the next run picks it up. While a switch is OFF the
          old channel stays authoritative and the bus only <em>counts</em> the
          mechanism.
        </div>
        <div className="sound-list">
          {BUS_MECHANISMS.map((m) => (
            <button
              key={m}
              className={`sound-row ${switches[m] ? 'selected' : ''}`}
              data-mechanism={m}
              data-live-state={switches[m] ? 'ON' : 'OFF'}
              aria-pressed={switches[m]}
              onClick={() => void toggle(m)}
            >
              <span className="sound-radio" aria-hidden="true">
                <span className="sound-radio-dot" />
              </span>
              <span className="sound-meta">
                <span className="sound-name">
                  {BUS_MECHANISM_LABEL[m]} — {switches[m] ? 'ON' : 'OFF'}
                </span>
                <span className="sound-desc">{MECHANISM_DESC[m]}</span>
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
    </div>,
    document.body,
  );
}
