import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { TerminalView } from './components/Terminal';
import { DiffView } from './components/DiffView';
import { BranchPicker } from './components/BranchPicker';
import { NvimView } from './components/NvimView';
import { DialogHost } from './components/Dialog';
import { playFinishedChime } from './chime';

const NVIM_WIDTH_KEY = 'orchestra.nvimPaneWidthPx';
const NVIM_WIDTH_DEFAULT = 520;
const NVIM_WIDTH_MIN = 280;
function loadNvimWidth(): number {
  const raw = Number(localStorage.getItem(NVIM_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= NVIM_WIDTH_MIN ? raw : NVIM_WIDTH_DEFAULT;
}

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
  const [nvimWidth, setNvimWidth] = useState<number>(() => loadNvimWidth());
  const paneRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load();
  }, [load]);

  // Drag to resize the nvim pane. Width is clamped so the terminal pane keeps
  // at least NVIM_WIDTH_MIN too, and persisted on drag end.
  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const row = paneRowRef.current;
    if (!row) return;
    const startX = e.clientX;
    const startWidth = nvimWidth;
    const rowRect = row.getBoundingClientRect();
    const maxWidth = Math.max(NVIM_WIDTH_MIN, rowRect.width - NVIM_WIDTH_MIN);
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const next = Math.max(NVIM_WIDTH_MIN, Math.min(maxWidth, startWidth + delta));
      setNvimWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setNvimWidth((w) => {
        localStorage.setItem(NVIM_WIDTH_KEY, String(w));
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

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
    return window.orchestra.onAgentFinished((finishedId, focused) => {
      // User is actively on this workspace: no chime, no yellow dot blip.
      // Trust the main-process focus flag — `document.hasFocus()` is unreliable
      // on Wayland/CDP and returns stale `true` when the window is hidden.
      if (focused && useStore.getState().activeId === finishedId) {
        void window.orchestra.markSeen(finishedId).catch(() => {});
        return;
      }
      playFinishedChime();
    });
  }, []);

  const liveWorkspaces = workspaces.filter((w) => !w.archived);
  const active = liveWorkspaces.find((w) => w.id === activeId);
  const openPR = active ? prs[active.id]?.open ?? null : null;
  const [merging, setMerging] = useState(false);
  const onMerge = async () => {
    if (!active || merging) return;
    setMerging(true);
    try {
      // The merge button now just hands a structured prompt to the agent —
      // the agent has full work context and writes a better commit message
      // than we could synthesise. No success/failure UI here; the agent
      // reports back in its own terminal output.
      await window.orchestra.mergeWorktree(active.id);
    } catch (e) {
      alert(`Could not request merge: ${(e as Error).message}`);
    } finally {
      setMerging(false);
    }
  };

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
              {(() => {
                // "In sync" = at least one merge has landed AND the branch
                // hasn't diverged since. The button stays clickable in
                // either state — agents handle re-merges fine, and the user
                // may want to ship a follow-up commit on a previously
                // merged branch. Disable only while a merge request is
                // in flight to prevent double-fire.
                const inSync = !!active.mergedAt && !active.divergedFromBase;
                const tip = inSync
                  ? `Already merged into ${active.baseBranch} — click to re-merge follow-up work`
                  : `Merge ${active.branch} into ${active.baseBranch} and push`;
                return (
                  <button
                    className={`merge-btn ${inSync ? 'done' : ''}`}
                    onClick={onMerge}
                    disabled={merging}
                    title={tip}
                  >
                <svg
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  shapeRendering="geometricPrecision"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle cx="18" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <path d="M6 21V9a9 9 0 0 0 9 9" />
                </svg>
                    {merging ? 'Merging…' : inSync ? 'Merged' : 'Merge'}
                  </button>
                );
              })()}
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
                  className="pr-link pr-link-create"
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
            <div
              ref={paneRowRef}
              className={`pane-row ${nvimOpen ? 'with-nvim' : ''}`}
            >
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
                <>
                  <div
                    className="pane-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize file pane"
                    onMouseDown={onResizerMouseDown}
                  />
                  <div
                    className="nvim-pane"
                    style={{ flex: `0 0 ${nvimWidth}px` }}
                  >
                    <NvimView workspaceId={active.id} isActive={nvimOpen} />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </main>
      <DialogHost />
    </div>
  );
}
