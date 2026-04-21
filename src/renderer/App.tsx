import { useEffect, useState } from 'react';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { TerminalView } from './components/Terminal';
import { DiffView } from './components/DiffView';
import { NewWorkspaceModal } from './components/NewWorkspaceModal';
import { PRModal } from './components/PRModal';

export function App() {
  const { workspaces, activeId, view, setView, load, loaded, archive } = useStore();
  const [showNew, setShowNew] = useState(false);
  const [showPR, setShowPR] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  const active = workspaces.find((w) => w.id === activeId);

  return (
    <div className="app">
      <Sidebar onNew={() => setShowNew(true)} />
      <main className="main">
        {!loaded && <div className="empty">Loading…</div>}
        {loaded && !active && (
          <div className="empty">
            <h2>Welcome to Orchestra</h2>
            <div>Spawn a Claude Code or Codex agent in an isolated git worktree.</div>
            <button className="primary" onClick={() => setShowNew(true)}>+ New workspace</button>
          </div>
        )}
        {active && (
          <>
            <div className="toolbar">
              <div className="title">{active.name}</div>
              <div className="tabs">
                <button
                  className={`tab ${view === 'terminal' ? 'active' : ''}`}
                  onClick={() => setView('terminal')}
                >
                  Terminal
                </button>
                <button
                  className={`tab ${view === 'diff' ? 'active' : ''}`}
                  onClick={() => setView('diff')}
                >
                  Diff
                </button>
              </div>
              <button onClick={() => window.orchestra.openInEditor(active.id, 'code')}>
                Open in VS Code
              </button>
              <button className="primary" onClick={() => setShowPR(true)}>Open PR</button>
              <button
                className="danger"
                onClick={() => {
                  if (confirm(`Archive "${active.name}"? The worktree and branch will be removed.`))
                    archive(active.id);
                }}
              >
                Archive
              </button>
            </div>
            <div className="pane">
              {view === 'terminal' ? (
                <TerminalView workspaceId={active.id} />
              ) : (
                <DiffView workspaceId={active.id} />
              )}
            </div>
          </>
        )}
      </main>

      {showNew && <NewWorkspaceModal onClose={() => setShowNew(false)} />}
      {showPR && active && <PRModal ws={active} onClose={() => setShowPR(false)} />}
    </div>
  );
}
