import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RepoScripts } from '../../shared/types';
import { useStore } from '../store';

interface Props {
  repoPath: string;
  repoName: string;
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

const ENV_PLACEHOLDER = `# KEY=value per line, injected into this repo's agents.
# Values may reference Orchestra's own env with \${VAR} — the secret stays
# out of store.json. An entry whose \${VAR} is unset is dropped (agent keeps
# its default login).

CLAUDE_CODE_OAUTH_TOKEN=\${CLAUDE_TOKEN_A}`;

/** Parse a KEY=value textarea (one per line, # comments, blank lines ignored)
 * into an env record. The first `=` splits; later `=` stay in the value. */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key) out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function RepoScriptsModal({ repoPath, repoName, onClose }: Props) {
  const [setup, setSetup] = useState('');
  const [runScript, setRunScript] = useState('');
  const [archive, setArchive] = useState('');
  const [envText, setEnvText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRepos = useStore((s) => s.refreshRepos);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.orchestra.getRepoScripts(repoPath),
      window.orchestra.getRepoEnv(repoPath),
    ])
      .then(([scripts, env]: [RepoScripts, Record<string, string>]) => {
        if (cancelled) return;
        setSetup(scripts.setup ?? '');
        setRunScript(scripts.run ?? '');
        setArchive(scripts.archive ?? '');
        setEnvText(envToText(env));
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
      await window.orchestra.setRepoEnv(repoPath, parseEnvText(envText));
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
            <Field
              label="Agent env"
              hint="KEY=value per line, injected into this repo's agents. Use ${VAR} to pull a value from Orchestra's own env (keeps secrets out of disk). E.g. select which Claude account this repo's agents log in as."
              value={envText}
              onChange={setEnvText}
              placeholder={ENV_PLACEHOLDER}
            />
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
