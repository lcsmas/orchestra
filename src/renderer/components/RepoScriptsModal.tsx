import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Account, RepoScripts } from '../../shared/types';
import { useStore } from '../store';

interface Props {
  repoPath: string;
  repoName: string;
  /** Whether the repo can be removed from Orchestra (no workspaces left). */
  canRemove: boolean;
  /** Confirms and removes the repo; closes the modal on success. */
  onRemove: () => Promise<void>;
  onClose: () => void;
}

const SETUP_PLACEHOLDER = `# Runs once after the worktree is created.
# Available env: $ORCHESTRA_PORT, $ORCHESTRA_ROOT_PATH, $ORCHESTRA_WORKSPACE_PATH, $ORCHESTRA_BRANCH

pnpm install
ln -sf "$ORCHESTRA_ROOT_PATH/.env" .env`;

const RUN_PLACEHOLDER = `# Long-running script bound to the workspace's "Run" tab.
# Use $ORCHESTRA_PORT so multiple workspaces don't collide.

pnpm dev --port "$ORCHESTRA_PORT"`;

const ARCHIVE_PLACEHOLDER = `# Best-effort cleanup before the worktree is deleted.
# Used to free per-workspace external resources (DB, caches, …).

# dropdb "myapp_$ORCHESTRA_BRANCH" 2>/dev/null || true`;

export function RepoScriptsModal({ repoPath, repoName, canRemove, onRemove, onClose }: Props) {
  const [setup, setSetup] = useState('');
  const [runScript, setRunScript] = useState('');
  const [archive, setArchive] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('');
  const [initialDefaultBranch, setInitialDefaultBranch] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRepos = useStore((s) => s.refreshRepos);
  const repos = useStore((s) => s.repos);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.orchestra.getRepoScripts(repoPath),
      window.orchestra.listAccounts(),
      // Branch listing is best-effort: an unreadable repo still lets the user
      // edit scripts; the branch select just falls back to the current value.
      window.orchestra.listRepoBranches(repoPath).catch(() => [] as string[]),
    ])
      .then(([scripts, accs, branchList]: [RepoScripts, Account[], string[]]) => {
        if (cancelled) return;
        setSetup(scripts.setup ?? '');
        setRunScript(scripts.run ?? '');
        setArchive(scripts.archive ?? '');
        setAccounts(accs);
        setBranches(branchList);
        // Current assignment from the already-loaded repo list (no extra IPC).
        const repo = repos.find((r) => r.path === repoPath);
        setAccountId(repo?.accountId ?? '');
        setDefaultBranch(repo?.defaultBranch ?? '');
        setInitialDefaultBranch(repo?.defaultBranch ?? '');
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
  }, [repoPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.orchestra.setRepoScripts(repoPath, {
        setup: setup.trim() || undefined,
        run: runScript.trim() || undefined,
        archive: archive.trim() || undefined,
      });
      await window.orchestra.setRepoAccount(repoPath, accountId || null);
      if (defaultBranch && defaultBranch !== initialDefaultBranch) {
        await window.orchestra.setRepoDefaultBranch(repoPath, defaultBranch);
      }
      // Refresh local repo cache so the Run tab's `hasRunScript` derivation
      // sees the change immediately, without waiting for a reload.
      await refreshRepos();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Portal to document.body. The sidebar (this modal's natural parent)
  // sets `backdrop-filter`, which per CSS spec promotes `.sidebar` to a
  // containing block for any `position: fixed` descendants — without the
  // portal, `.modal-backdrop` is trapped inside the 280px sidebar column
  // instead of covering the viewport.
  return createPortal(
    <div
      className="modal-backdrop"
      // Close only when the press *starts* on the backdrop. Using onClick would
      // also fire when a text-selection drag begins inside a field and the mouse
      // is released over the backdrop — the resulting click targets the backdrop
      // and would wrongly dismiss the dialog mid-edit.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal repo-scripts-modal"
        role="dialog"
        aria-label={`Scripts for ${repoName}`}
      >
        <div className="modal-header">
          <div>
            <h2>Workspace scripts</h2>
            <div className="modal-sub" title={repoPath}>
              {repoName}
            </div>
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
              Runs <code>bash -lc</code> in each new worktree of this repo. <code>$ORCHESTRA_PORT</code> is
              auto-allocated per workspace so dev servers don't collide.
            </p>
            <Field
              label="Setup"
              hint="Runs once after the worktree is created. Failure is non-blocking — workspace stays put, retry from the workspace toolbar."
              value={setup}
              onChange={setSetup}
              placeholder={SETUP_PLACEHOLDER}
            />
            <Field
              label="Run"
              hint="Spawned by the workspace's Run tab. Use $ORCHESTRA_PORT for the dev server port."
              value={runScript}
              onChange={setRunScript}
              placeholder={RUN_PLACEHOLDER}
            />
            <Field
              label="Archive"
              hint="Best-effort cleanup before the worktree is deleted."
              value={archive}
              onChange={setArchive}
              placeholder={ARCHIVE_PLACEHOLDER}
            />
            <label className="field">
              <div className="field-head">
                <span className="field-label">Default base branch</span>
                <span className="field-hint">
                  The branch new workspaces of this repo are cut from, and the branch the
                  sidebar sync pill tracks. Right-click a repo's + button to base a single
                  workspace on a different branch.
                </span>
              </div>
              <select
                className="field-select"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
              >
                {/* Keep the stored value selectable even if it no longer exists
                    locally (or the branch listing failed). */}
                {defaultBranch && !branches.includes(defaultBranch) && (
                  <option value={defaultBranch}>{defaultBranch} (missing locally)</option>
                )}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <div className="field-head">
                <span className="field-label">Claude account</span>
                <span className="field-hint">
                  Which Claude account this repo's agents log in as. Orchestra injects the account's
                  CLAUDE_CONFIG_DIR so the agent runs under that login, and the workspace badge shows
                  its usage. Manage accounts from the Accounts button in the sidebar header.
                </span>
              </div>
              <select
                className="field-select"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Default login</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field danger-zone">
              <div className="field-head">
                <span className="field-label">Remove repo</span>
                <span className="field-hint">
                  Un-maps {repoName} from Orchestra — your git repository on disk is left
                  untouched.{!canRemove && ' Archive and delete all of its workspaces first.'}
                </span>
              </div>
              <button
                className="danger danger-zone-btn"
                disabled={!canRemove}
                onClick={() => void onRemove()}
              >
                Remove from Orchestra
              </button>
            </div>
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

function Field(props: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="field">
      <div className="field-head">
        <span className="field-label">{props.label}</span>
        <span className="field-hint">{props.hint}</span>
      </div>
      <textarea
        className="field-textarea"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        rows={5}
      />
    </label>
  );
}
