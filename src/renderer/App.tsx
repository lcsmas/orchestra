import { useEffect, useState } from 'react';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { TerminalView } from './components/Terminal';
import { DiffView } from './components/DiffView';
import { BranchPicker } from './components/BranchPicker';
import { NvimView } from './components/NvimView';
import { DialogHost } from './components/Dialog';
import { playFinishedChime } from './chime';

export function App() {
  const {
    workspaces,
    activeId,
    view,
    setView,
    load,
    loaded,
    createWorkspaceInNewRepo,
    stats,
    refreshAllStats,
    prs,
    refreshAllPRs,
  } = useStore();
  const [nvimOpen, setNvimOpen] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!loaded) return;
    refreshAllStats();
    const timer = setInterval(refreshAllStats, 8000);
    return () => clearInterval(timer);
  }, [loaded, workspaces.length, refreshAllStats]);

  useEffect(() => {
    if (!loaded) return;
    refreshAllPRs();
    const timer = setInterval(refreshAllPRs, 12000);
    const onFocus = () => refreshAllPRs();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loaded, workspaces.length, refreshAllPRs]);

  useEffect(() => {
    return window.orchestra.onAgentFinished((finishedId) => {
      // User is actively on this workspace: no chime, no yellow dot blip.
      if (document.hasFocus() && useStore.getState().activeId === finishedId) {
        void window.orchestra.markSeen(finishedId).catch(() => {});
        return;
      }
      playFinishedChime();
    });
  }, []);

  const liveWorkspaces = workspaces.filter((w) => !w.archived);
  const active = liveWorkspaces.find((w) => w.id === activeId);
  const openPR = active ? prs[active.id]?.open ?? null : null;

  return (
    <div className="app">
      <Sidebar onNewFromRepo={createWorkspaceInNewRepo} />
      <main className="main">
        {!loaded && <div className="empty">Loading…</div>}
        {loaded && !active && (
          <div className="empty">
            <h2>Welcome to Orchestra</h2>
            <div>Spawn a Claude Code or Codex agent in an isolated git worktree.</div>
            <button className="primary" onClick={createWorkspaceInNewRepo}>+ New workspace</button>
          </div>
        )}
        {loaded && active && (
          <>
            <div className="toolbar">
              <div className="title">
                <span className="branch-chip base" title={`base branch: ${active.baseBranch}`}>
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
                    />
                  </svg>
                  <span className="branch-chip-text">{active.baseBranch}</span>
                </span>
                <span className="branch-arrow" aria-hidden="true">→</span>
                <BranchPicker workspaceId={active.id} currentBranch={active.branch} />
              </div>
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
                  {stats[active.id] && (stats[active.id].additions > 0 || stats[active.id].deletions > 0) && (
                    <span className="diff-indicator">
                      {stats[active.id].additions > 0 && (
                        <span className="add">+{stats[active.id].additions}</span>
                      )}
                      {stats[active.id].deletions > 0 && (
                        <span className="del">−{stats[active.id].deletions}</span>
                      )}
                    </span>
                  )}
                </button>
              </div>
              {openPR ? (
                <button
                  className="primary pr-link"
                  onClick={() => window.orchestra.openExternal(openPR.url)}
                  title={`OPEN · ${openPR.title}`}
                >
                  PR #{openPR.number}
                </button>
              ) : (
                <button
                  className="primary"
                  onClick={() => {
                    const id = active.id;
                    const prompt =
                      'Please create a pull request for the current branch: commit any pending changes, push the branch, and open the PR with a concise title and summary.';
                    // Type the prompt first, then send Enter as a separate keystroke
                    // so Claude's TUI treats it as a submit, not a pasted newline.
                    window.orchestra.ptyWrite(id, prompt);
                    setTimeout(() => window.orchestra.ptyWrite(id, '\r'), 80);
                  }}
                  title="Ask the focused Claude Code agent to create a PR"
                >
                  Open PR
                </button>
              )}
              <button
                className={`pane-toggle ${nvimOpen ? 'active' : ''}`}
                onClick={() => setNvimOpen((v) => !v)}
                title={nvimOpen ? 'Hide file pane' : 'Show file pane'}
                aria-label={nvimOpen ? 'Hide file pane' : 'Show file pane'}
                aria-pressed={nvimOpen}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.5 3.25A1.25 1.25 0 0 1 3.75 2h8.5A1.25 1.25 0 0 1 13.5 3.25v9.5A1.25 1.25 0 0 1 12.25 14h-8.5A1.25 1.25 0 0 1 2.5 12.75v-9.5Z"
                  />
                  <path
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    d="M10 2.5v11"
                  />
                </svg>
              </button>
            </div>
            {/* Render a TerminalView for every workspace but only show the active one.
                This keeps each xterm.js instance alive (preserving its scrollback buffer)
                even when the user switches to a different workspace tab. */}
            <div className={`pane-row ${nvimOpen ? 'with-nvim' : ''}`}>
              <div className="pane">
                {liveWorkspaces.map((ws) => (
                  <TerminalView
                    key={ws.id}
                    workspaceId={ws.id}
                    isActive={ws.id === activeId && view === 'terminal'}
                  />
                ))}
                {view === 'diff' && <DiffView workspaceId={active.id} />}
              </div>
              {nvimOpen && (
                <div className="nvim-pane">
                  <NvimView workspaceId={active.id} isActive={nvimOpen} />
                </div>
              )}
            </div>
          </>
        )}
      </main>
      <DialogHost />
    </div>
  );
}
