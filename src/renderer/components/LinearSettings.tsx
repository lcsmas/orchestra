import { useEffect, useState } from 'react';
import type { LinearKeyCheck, LinearKeySource } from '../../shared/types';

interface Props {
  onClose: () => void;
  /** Called after a save or clear, so the sidebar can refresh its setup notice. */
  onChanged?: () => void;
}

export function LinearSettings({ onClose, onChanged }: Props) {
  const [source, setSource] = useState<LinearKeySource | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  // Result of the last check/save probe — drives the inline status line.
  const [check, setCheck] = useState<LinearKeyCheck | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.orchestra.getLinearKeySource().then(setSource).catch(() => {});
  }, []);

  const test = async () => {
    setSaved(false);
    setBusy(true);
    try {
      setCheck(await window.orchestra.checkLinearKey(key));
    } catch {
      setCheck({ ok: false, error: 'Could not test the key.' });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      // Verify first so we never persist a key we know is bad — but still let
      // the user save if Linear was merely unreachable (network), since the key
      // itself may be fine.
      const result = await window.orchestra.checkLinearKey(key);
      setCheck(result);
      if (!result.ok && result.error === 'Invalid API key.') return;
      await window.orchestra.saveLinearKey(key);
      setKey('');
      setSaved(true);
      setSource(await window.orchestra.getLinearKeySource());
      onChanged?.();
    } catch {
      setCheck({ ok: false, error: 'Could not save the key.' });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await window.orchestra.clearLinearKey();
      setKey('');
      setCheck(null);
      setSaved(false);
      setSource(await window.orchestra.getLinearKeySource());
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const statusLabel =
    source === 'stored'
      ? 'A key is saved in Orchestra.'
      : source === 'env'
        ? 'Using the LINEAR_API_KEY environment variable.'
        : source === 'none'
          ? 'No key configured — Linear badges are off.'
          : '';

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal linear-settings">
        <h2>Linear API key</h2>
        <div className="sound-hint">
          Orchestra verifies branch issue keys against Linear and shows a badge
          only for issues that exist. Paste a Linear{' '}
          <button
            className="env-notice-link"
            onClick={() =>
              window.orchestra.openExternal('https://linear.app/settings/account/security')
            }
          >
            personal API key
          </button>{' '}
          (separate from the Linear MCP login). It’s stored encrypted on this
          machine.
        </div>

        {source && (
          <div className={`linear-key-source ${source}`}>{statusLabel}</div>
        )}

        <input
          className="linear-key-input"
          type="password"
          placeholder="lin_api_…"
          autoFocus
          value={key}
          disabled={busy}
          onChange={(e) => {
            setKey(e.target.value);
            setCheck(null);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim()) void save();
            else if (e.key === 'Escape') onClose();
          }}
        />

        {busy && <div className="linear-key-status muted">Checking with Linear…</div>}
        {!busy && check && (
          <div className={`linear-key-status ${check.ok ? 'ok' : 'err'}`}>
            {check.ok ? `✓ Connected as ${check.name}` : `✗ ${check.error}`}
          </div>
        )}
        {!busy && saved && !check?.error && (
          <div className="linear-key-status ok">✓ Saved.</div>
        )}

        <div className="modal-actions linear-key-actions">
          {source === 'stored' && (
            <button className="ghost danger" onClick={clear} disabled={busy}>
              Remove saved key
            </button>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={test} disabled={busy || !key.trim()}>
            Test
          </button>
          <button className="primary" onClick={save} disabled={busy || !key.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
