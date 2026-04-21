import { useEffect, useState } from 'react';
import { useStore } from '../store';

interface Props {
  onClose: () => void;
}

export function NewWorkspaceModal({ onClose }: Props) {
  const { repos, addRepo, createWorkspace } = useStore();
  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? '');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState(repos[0]?.defaultBranch ?? 'main');
  const [task, setTask] = useState('');
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const repo = repos.find((r) => r.path === repoPath);
    if (repo) setBaseBranch(repo.defaultBranch);
  }, [repoPath, repos]);

  const submit = async () => {
    if (!repoPath || !branch) return;
    setBusy(true);
    try {
      await createWorkspace({ repoPath, branch, baseBranch, task: task || undefined, agent });
      onClose();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New workspace</h2>

        <div className="field">
          <label>Repo</label>
          {repos.length === 0 ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={addRepo}>Add a git repo…</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={repoPath} onChange={(e) => setRepoPath(e.target.value)} style={{ flex: 1 }}>
                {repos.map((r) => (
                  <option key={r.path} value={r.path}>{r.name} — {r.path}</option>
                ))}
              </select>
              <button onClick={addRepo}>+ Add</button>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="field">
            <label>New branch</label>
            <input
              placeholder="feat/my-feature"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label>Based on</label>
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Agent</label>
          <select value={agent} onChange={(e) => setAgent(e.target.value as 'claude' | 'codex')}>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </div>

        <div className="field">
          <label>First message (optional)</label>
          <textarea
            placeholder="What should the agent work on?"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy || !repoPath || !branch}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
