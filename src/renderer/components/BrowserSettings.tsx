import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserProfile, BrowserProfileResult } from '../../shared/types';
import { BROWSER_PROFILE_NAME_MAX, profileCreateWarning } from '../../shared/browser-profile';
import { useStore } from '../store';
import { dialog } from './Dialog';
import { useSecretsState } from './SecretsNotice';

interface Props {
  onClose: () => void;
}

/** Settings > Browser (#400, ADR 0010): create, rename and delete profils navigateur — named, persistent sign-ins a
 *  workspace's browser panel can carry (attached from the panel's URL bar). Navigation éphémère stays the default:
 *  nothing here changes a workspace. Every change goes through the human-only IPC and is applied at once. */
export function BrowserSettings({ onClose }: Props) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secrets = useSecretsState();
  const warning = profileCreateWarning(secrets);
  const workspaces = useStore((s) => s.workspaces);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.orchestra
      .browserProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  /** Fold a result in: the profile list on record is always shown fresh; a refusal is shown as-is. */
  const apply = (r: BrowserProfileResult): boolean => {
    setProfiles(r.profiles);
    setError(r.ok ? null : r.message);
    return r.ok;
  };

  const attachedTo = (id: string): number => workspaces.filter((w) => w.browserProfileId === id).length;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (apply(await window.orchestra.browserProfileCreate(newName))) setNewName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      nameRef.current?.focus();
    }
  };

  const commitRename = async () => {
    if (!editing) return;
    const { id, name } = editing;
    setBusy(true);
    try {
      if (apply(await window.orchestra.browserProfileRename(id, name))) setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: BrowserProfile) => {
    const n = attachedTo(p.id);
    const ok = await dialog.confirm({
      title: `Delete “${p.name}”?`,
      message: 'Its stored cookies and sign-ins are erased and cannot be recovered.',
      detail:
        n === 0
          ? 'No workspace uses it.'
          : `${n} workspace${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} it: ${n === 1 ? 'it returns' : 'they return'} to ephemeral browsing and the open tabs reload signed out.`,
      tone: 'danger',
      confirmLabel: 'Delete profile',
    });
    if (!ok) return;
    setBusy(true);
    try {
      apply(await window.orchestra.browserProfileDelete(p.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Portal to <body>: the sidebar carries `backdrop-filter`, which makes it the containing block of position:fixed.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sound-settings browser-settings" data-bp-settings role="dialog" aria-label="Browser profiles">
        <h2>Browser profiles</h2>
        <div className="sound-hint">
          A profile is a named sign-in the browser panel keeps across restarts. Attach one to a workspace from the
          panel’s URL bar; every tab of that workspace then uses it, and several workspaces can share one. Without a
          profile a workspace browses ephemerally: nothing is kept. Cookies a site marks as session-only (no expiry) are not
          kept across restarts. Only you can attach a profile — agents cannot.
        </div>
        <div className="bp-body">
          {!loaded ? (
            <div className="bp-empty">Loading…</div>
          ) : profiles.length === 0 ? (
            <div className="bp-empty" data-bp-empty>
              No profile yet — every workspace browses ephemerally.
            </div>
          ) : (
            <ul className="bp-list" aria-label="Browser profiles">
              {profiles.map((p) => {
                const n = attachedTo(p.id);
                const isEditing = editing?.id === p.id;
                return (
                  <li key={p.id} className="bp-row" data-profile-id={p.id} data-profile-name={p.name}>
                    {isEditing ? (
                      <input
                        className="accounts-input bp-name-input"
                        value={editing.name}
                        maxLength={BROWSER_PROFILE_NAME_MAX * 2}
                        autoFocus
                        aria-label={`New name for ${p.name}`}
                        onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename();
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setEditing(null);
                            setError(null);
                          }
                        }}
                      />
                    ) : (
                      <span className="bp-name">{p.name}</span>
                    )}
                    <span className="bp-meta">
                      {n === 0 ? 'unused' : `${n} workspace${n === 1 ? '' : 's'}`}
                      {warning && (
                        <span className="bp-unencrypted" title={warning} data-profile-unencrypted>
                          {' '}
                          ⚠ not encrypted
                        </span>
                      )}
                    </span>
                    {isEditing ? (
                      <>
                        <button className="btn" disabled={busy} onClick={() => void commitRename()}>
                          Save
                        </button>
                        <button
                          className="btn"
                          onClick={() => {
                            setEditing(null);
                            setError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn"
                          disabled={busy}
                          aria-label={`Rename ${p.name}`}
                          data-bp-rename
                          onClick={() => {
                            setError(null);
                            setEditing({ id: p.id, name: p.name });
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="btn"
                          disabled={busy}
                          aria-label={`Delete ${p.name}`}
                          data-bp-delete
                          onClick={() => void remove(p)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <form className="bp-create" onSubmit={create}>
            {warning && (
              <div className="secrets-notice bp-warning" role="status" data-profile-warning="create">
                <span className="secrets-notice-icon" aria-hidden="true">
                  ⚠
                </span>
                <span>{warning}</span>
              </div>
            )}
            <div className="bp-create-row">
              <input
                ref={nameRef}
                className="accounts-input"
                value={newName}
                placeholder="New profile name (e.g. Staging admin)"
                maxLength={BROWSER_PROFILE_NAME_MAX * 2}
                aria-label="New profile name"
                onChange={(e) => {
                  setNewName(e.target.value);
                  setError(null);
                }}
              />
              <button className="primary" type="submit" disabled={busy || !newName.trim()} data-bp-create>
                Create profile
              </button>
            </div>
          </form>
        </div>
        {error && (
          <div className="modal-error" role="alert" data-bp-error>
            {error}
          </div>
        )}
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
