import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '../../shared/types';
import { AccountLoginModal } from './AccountLoginModal';

interface Props {
  onClose: () => void;
}

interface Row {
  id: string;
  label: string;
  configDir: string;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `acc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

// Turn a label into a sensible default config dir, e.g. "work" → ~/.claude-work.
// Keeps it filesystem-safe; blank label → just ~/.claude- (user edits it).
function defaultDirFor(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `~/.claude-${slug}`;
}

export function AccountsSettings({ onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The account currently being logged in (drives the login terminal modal).
  const [loginFor, setLoginFor] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.orchestra
      .listAccounts()
      .then((accounts: Account[]) => {
        if (cancelled) return;
        setRows(accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir })));
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
      // Don't close the settings modal on Escape while the login terminal is up
      // — Escape there belongs to the terminal.
      if (e.key === 'Escape' && !loginFor) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, loginFor]);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch };
        // If the dir is still the auto-suggested one (or empty) and the label
        // changed, keep the suggestion in sync so it doesn't go stale.
        if (patch.label !== undefined && (!r.configDir || r.configDir === defaultDirFor(r.label))) {
          next.configDir = defaultDirFor(next.label);
        }
        return next;
      }),
    );
  const remove = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));
  const add = () => setRows((rs) => [...rs, { id: newId(), label: '', configDir: '' }]);

  const pickDir = async (id: string) => {
    const dir = await window.orchestra.pickDirectory();
    if (dir) update(id, { configDir: dir });
  };

  // Persist current edits, returning the saved list (so a Login click can save
  // first — main needs the account to exist before it can spawn its login).
  const persist = async (): Promise<Account[] | null> => {
    const accounts: Account[] = rows
      .map((r) => ({ id: r.id, label: r.label.trim(), configDir: r.configDir.trim() }))
      .filter((r) => r.label);
    try {
      const saved = await window.orchestra.setAccounts(accounts);
      setRows(saved.map((a) => ({ id: a.id, label: a.label, configDir: a.configDir })));
      return saved;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    const saved = await persist();
    setSaving(false);
    if (saved) onClose();
  };

  const onLogin = async (row: Row) => {
    if (!row.label.trim()) {
      setError('Give the account a label before logging in.');
      return;
    }
    setError(null);
    setSaving(true);
    const saved = await persist();
    setSaving(false);
    if (!saved) return;
    // Use the persisted row (its id is stable) so the login PTY targets it.
    const acc = saved.find((a) => a.id === row.id);
    if (acc) setLoginFor({ id: acc.id, label: acc.label });
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loginFor) onClose();
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
              Each account is a separate Claude Code config directory
              (<code>CLAUDE_CONFIG_DIR</code>) with its own login. Assign an account to a repo in its
              Workspace scripts settings; that repo's agents then run as that account, and the
              workspace badge shows its rolling 5h / 7d usage. Claude Code manages and refreshes the
              token in the dir — Orchestra only reads it to show usage and never copies it anywhere.
            </p>
            <p className="modal-hint">
              Use <strong>Login</strong> to authenticate an account's dir (runs <code>claude /login</code>{' '}
              there). The usage endpoint needs a login with the <code>user:profile</code> scope.
            </p>

            {rows.length === 0 && <div className="accounts-empty">No accounts yet. Add one below.</div>}

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
                    className="accounts-input dir"
                    placeholder="~/.claude-work"
                    value={r.configDir}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    onChange={(e) => update(r.id, { configDir: e.target.value })}
                  />
                  <button
                    className="accounts-pick"
                    title="Choose directory…"
                    aria-label="Choose config directory"
                    onClick={() => pickDir(r.id)}
                  >
                    …
                  </button>
                  <button
                    className="accounts-login"
                    title="Run `claude /login` in this account's config dir"
                    onClick={() => onLogin(r)}
                    disabled={saving}
                  >
                    Login
                  </button>
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
      {loginFor && (
        <AccountLoginModal
          accountId={loginFor.id}
          label={loginFor.label}
          onClose={() => setLoginFor(null)}
        />
      )}
    </div>,
    document.body,
  );
}
