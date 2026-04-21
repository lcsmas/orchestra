import { useStore } from '../store';
import type { WorkspaceStatus } from '../../shared/types';

interface Props {
  onNew: () => void;
}

export function Sidebar({ onNew }: Props) {
  const { workspaces, activeId, setActive } = useStore();

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Orchestra</h1>
        <button className="primary" onClick={onNew}>+ New</button>
      </div>
      <div className="sidebar-section">
        <span>Workspaces</span>
        <span>{workspaces.length}</span>
      </div>
      <div className="ws-list">
        {workspaces.length === 0 && (
          <div style={{ padding: '20px', color: 'var(--text-dim)', fontSize: 12 }}>
            No agents running. Click <strong>+ New</strong> to spawn one.
          </div>
        )}
        {workspaces.map((w) => (
          <div
            key={w.id}
            className={`ws-item ${activeId === w.id ? 'active' : ''}`}
            onClick={() => setActive(w.id)}
          >
            <div className={`ws-dot ${w.status as WorkspaceStatus}`} />
            <div className="ws-meta">
              <div className="ws-name">{w.name}</div>
              <div className="ws-sub">{w.agent} · {w.branch}</div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
