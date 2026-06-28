import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '../../shared/types';

interface Props {
  onClose: () => void;
}

// Editable row state mirrors an Account but always has a stable id (generated
// client-side for brand-new rows so React keys are stable while editing).
interface Row {
  id: string;
  label: string;
  token: string;
}

function newId(): string {
  // crypto.randomUUID is available in the Electron renderer; fall back just in
  // case (e.g. an unusual sandbox) so adding a row never throws.
  try {
    return crypto.randomUUID();
  } catch {
    return `acc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

export function AccountsSettings({ onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.orchestra
      .listAccounts()
      .then((accounts: Account[]) => {
        if (cancelled) return;
        setRows(accounts.map((a) => ({ id: a.id, label: a.label, token: a.token })));
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));
  const add = () => setRows((rs) => [...rs, { id: newId(), label: '', token: '' }]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Drop rows with no label; trim. Main re-validates and persists.
      const accounts: Account[] = rows
        .map((r) => ({ id: r.id, label: r.label.trim(), token: r.token.trim() }))
        .filter((r) => r.label);
      const saved = await window.orchestra.setAccounts(accounts);
      setRows(saved.map((a) => ({ id: a.id, label: a.label, token: a.token })));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal accounts-settings" role="dialog" aria-label="Claude accounts">
        <div className="modal-header">
          <div>
            <h2>Claude accounts</h2>
            <div className="modal-sub">Usage badges per workspace</div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!loaded ? (
          <div className="modal-body">Loading…</div>
        ) : (
          <div className="modal-body">
            <p className="modal-hint">
              List the Claude accounts you spawn agents with. A workspace's badge shows the account it
              logs in as (matched by its <code>CLAUDE_CODE_OAUTH_TOKEN</code> agent env) and that
              account's rolling 5-hour / 7-day usage. Put the token as a{' '}
              <code>${'{VAR}'}</code> reference to Orchestra's environment so the secret stays out of{' '}
              <code>store.json</code> — exactly like a repo's Agent env.
            </p>
            <p className="modal-hint">
              The usage endpoint needs a token with the <code>user:profile</code> scope; a token
              without it shows “no usage scope” on the badge.
            </p>

            {rows.length === 0 && (
              <div className="accounts-empty">No accounts yet. Add one below.</div>
            )}

            <div className="accounts-rows">
              {rows.map((r) => (
                <div className="accounts-row" key={r.id}>
                  <input
                    className="accounts-input label"
                    placeholder="Label (e.g. work)"
                    value={r.label}
                    spellCheck={false}
                    onChange={(e) => update(r.id, { label: e.target.value })}
                  />
                  <input
                    className="accounts-input token"
                    placeholder="${CLAUDE_TOKEN_A}"
                    value={r.token}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    onChange={(e) => update(r.id, { token: e.target.value })}
                  />
                  <button
                    className="accounts-remove"
                    title="Remove account"
                    aria-label={`Remove account ${r.label || 'unnamed'}`}
                    onClick={() => remove(r.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <button className="accounts-add" onClick={add}>
              + Add account
            </button>

            {error && <div className="modal-error">{error}</div>}
          </div>
        )}
        <div className="modal-footer">
          <button onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary" onClick={onSave} disabled={saving || !loaded}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
