import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { Sidebar, OrchestratorIcon, ZapIcon } from './components/Sidebar';
import { TerminalView } from './components/Terminal';
import { BranchPicker } from './components/BranchPicker';
import { NvimView } from './components/NvimView';
import { BrowserPanel } from './components/BrowserPanel';
import { RunTerminal } from './components/RunTerminal';
import { StructuredView } from './components/StructuredView';
import { SetupBanner } from './components/SetupBanner';
import { PromptQueueBanner } from './components/PromptQueueBanner';
import { SandboxControlBar } from './components/SandboxControlBar';
import { InsightsView } from './components/Insights';
import { ResourcesView } from './components/ResourcesView';
import { HelpView, HelpIcon } from './components/Help';
import { DialogHost, dialog } from './components/Dialog';
import { playFinishedChime } from './chime';
import { dlog } from './debug';
import type { RepoEntry } from '../shared/types';
import { isScratchLike } from '../shared/types';
import { computeMountedIds } from '../shared/mounted-panes';
import { readDefaultAgentView, terminalTabLabel } from './default-agent-view';

// Max number of workspace panes (TerminalView + StructuredView) kept mounted at
// once. Each mounted TerminalView holds a WebGL context; Chromium force-loses
// WebGL contexts past ~16 per page and the shared GPU process buckles well
// before dozens are live, which is what turned the whole content area black
// (GL contexts lost, renderer still alive → nothing recovers it → manual
// restart). 12 stays comfortably under the WebGL cap with headroom for the
// occasional RunTerminal/login WebGL context, while keeping the dozen
// most-recent workspaces instantly switchable. Older panes unmount and cold-
// boot (~1-2s) on reopen — identical to opening a workspace for the first time.
const MAX_MOUNTED_PANES = 12;

const NVIM_WIDTH_KEY = 'orchestra.nvimPaneWidthPx';
const NVIM_WIDTH_DEFAULT = 520;
const NVIM_WIDTH_MIN = 280;

const BROWSER_WIDTH_KEY = 'orchestra.browserPaneWidthPx';
const BROWSER_WIDTH_DEFAULT = 640;
const BROWSER_WIDTH_MIN = 360;
function loadBrowserWidth(): number {
  const raw = Number(localStorage.getItem(BROWSER_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= BROWSER_WIDTH_MIN ? raw : BROWSER_WIDTH_DEFAULT;
}
function loadNvimWidth(): number {
  const raw = Number(localStorage.getItem(NVIM_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= NVIM_WIDTH_MIN ? raw : NVIM_WIDTH_DEFAULT;
}

const SIDEBAR_WIDTH_KEY = 'orchestra.sidebarWidthPx';
const SIDEBAR_WIDTH_DEFAULT = 340;
const SIDEBAR_WIDTH_MIN = 240;
const SIDEBAR_WIDTH_MAX = 560;
function loadSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= SIDEBAR_WIDTH_MIN && raw <= SIDEBAR_WIDTH_MAX
    ? raw
    : SIDEBAR_WIDTH_DEFAULT;
}

/** Run `fn` immediately and then every `ms` — but ONLY while the document is
 *  visible. When the window is hidden (minimized, other workspace, screen
 *  locked) the timer is torn down so Orchestra stops spawning N git/gh/du
 *  subprocesses per tick in the background; on becoming visible again it fires
 *  `fn` once to catch up and restarts the interval. Returns a cleanup that
 *  removes both the timer and the visibility listener. */
function startVisiblePoll(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const start = () => {
    if (timer) return;
    fn();
    timer = setInterval(fn, ms);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };
  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export function App() {
  // Atomic selectors, not a whole-store `useStore()` destructure: the latter
  // re-renders App (and with it every mounted TerminalView) on ANY state change
  // — including the high-frequency `agent:tool` ticks and per-repo sync events
  // App never reads. Each selector below subscribes to exactly one slice with
  // Object.is equality, so App only re-renders when a slice it uses changes.
  // `tools` and `repoSync` are deliberately not subscribed here — they're read
  // by the Sidebar rows that need them.
  const workspaces = useStore((s) => s.workspaces);
  const repos = useStore((s) => s.repos);
  const activeId = useStore((s) => s.activeId);
  const insightsOpen = useStore((s) => s.insightsOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  const setHelpOpen = useStore((s) => s.setHelpOpen);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const page = useStore((s) => s.page);
  const load = useStore((s) => s.load);
  const loaded = useStore((s) => s.loaded);
  const addRepoOnly = useStore((s) => s.addRepoOnly);
  const createScratchWorkspace = useStore((s) => s.createScratchWorkspace);
  const createOrchestratorWorkspace = useStore((s) => s.createOrchestratorWorkspace);
  const refreshAllStats = useStore((s) => s.refreshAllStats);
  const refreshSizes = useStore((s) => s.refreshSizes);
  const prs = useStore((s) => s.prs);
  const refreshAllPRs = useStore((s) => s.refreshAllPRs);
  const refreshAllLinear = useStore((s) => s.refreshAllLinear);
  const refreshTickets = useStore((s) => s.refreshTickets);
  const findRepo = (path: string): RepoEntry | undefined => repos.find((r) => r.path === path);
  // Whether the active workspace's `run` script PTY is live. Drives the
  // toolbar Play/Stop button so the app can be launched without opening the
  // Run panel. Kept in sync via `scripts:runStatus` (on workspace switch) and
  // the global pty exit event.
  const [runLive, setRunLive] = useState(false);
  // Debounced signal that the *set* of workspaces changed (add/remove), used to
  // re-seed the stats/size/PR/Linear polls so a freshly-added workspace gets its
  // first fetch promptly instead of waiting a whole interval. Debounced because a
  // bulk mutation (e.g. deleting dozens of archived workspaces one-by-one) would
  // otherwise restart every poll on every single delete — and each restart fires
  // its `fn()` immediately, including the cold full-tree `du` — turning one bulk
  // action into dozens of overlapping cold scans that jam the app. Coalescing to
  // one restart after the churn settles keeps prompt-on-add without the storm.
  const wsSetKey = workspaces.length;
  const [wsSetRev, setWsSetRev] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWsSetRev((r) => r + 1), 400);
    return () => clearTimeout(t);
  }, [wsSetKey]);
  // LRU of workspace ids by most-recent activation, newest first. Drives which
  // panes stay mounted (see MAX_MOUNTED_PANES below): keeping every open
  // workspace's TerminalView mounted means one WebGL context + 10k-line xterm
  // per workspace, and with dozens of workspaces that overruns Chromium's
  // ~16-context-per-page WebGL limit and stresses the shared GPU process until
  // it crashes — the renderer survives but its GL contexts are lost and the
  // content composites BLACK (the reported "app turns black, must restart"). We
  // therefore mount only the most-recently-used panes; the rest unmount and
  // rebuild instantly on reopen (a fresh xterm repaints from `claude
  // --continue`, no agent state lost — that is already how first-open works).
  const [lruOrder, setLruOrder] = useState<string[]>([]);
  useEffect(() => {
    if (!activeId) return;
    setLruOrder((prev) =>
      prev[0] === activeId ? prev : [activeId, ...prev.filter((id) => id !== activeId)],
    );
  }, [activeId]);
  const [nvimOpen, setNvimOpen] = useState(false);
  const [nvimWidth, setNvimWidth] = useState<number>(() => loadNvimWidth());
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserWidth, setBrowserWidth] = useState<number>(() => loadBrowserWidth());
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth());
  const paneRowRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const sidebarResizerRef = useRef<HTMLDivElement>(null);

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

  // Drag to resize the browser pane (mirrors the nvim resizer). Width is clamped
  // so the primary pane keeps at least BROWSER_WIDTH_MIN too, persisted on end.
  const onBrowserResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const row = paneRowRef.current;
    if (!row) return;
    const startX = e.clientX;
    const startWidth = browserWidth;
    const rowRect = row.getBoundingClientRect();
    const maxWidth = Math.max(BROWSER_WIDTH_MIN, rowRect.width - BROWSER_WIDTH_MIN);
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const next = Math.max(BROWSER_WIDTH_MIN, Math.min(maxWidth, startWidth + delta));
      setBrowserWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setBrowserWidth((w) => {
        localStorage.setItem(BROWSER_WIDTH_KEY, String(w));
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Drag to resize the sidebar. During the drag we write the new width straight
  // to the DOM (the grid track + the handle's `left`) on each rAF tick — calling
  // setSidebarWidth on every mousemove would re-render the whole sidebar +
  // terminal per pixel, which janks badly. React state is committed once on
  // mouseup, where it also persists. Double-click the handle to reset.
  const onSidebarResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let latest = startWidth;
    let raf = 0;
    const paint = () => {
      raf = 0;
      if (appRef.current) appRef.current.style.gridTemplateColumns = `${latest}px 1fr`;
      if (sidebarResizerRef.current) sidebarResizerRef.current.style.left = `${latest}px`;
    };
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      latest = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, startWidth + delta));
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Commit the final width to React state + storage exactly once.
      setSidebarWidth(latest);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(latest));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_WIDTH_DEFAULT));
  };

  useEffect(() => {
    if (!loaded) return;
    return startVisiblePoll(refreshAllStats, 8000);
  }, [loaded, wsSetRev, refreshAllStats]);

  // Worktree sizes are far heavier to compute than diff stats (a full
  // `btrfs fi du` / `du` pass), so they ride their own effect on a slower
  // cadence than the 8s stats poll. The 30s interval keeps the number live as
  // a worktree's contents grow/shrink (builds, installs) without freezing it
  // between workspace add/remove like a load-only refresh would; the btrfs
  // scanner gets no page-cache discount, so the main process additionally
  // TTL-caches its result and most of these polls are served from that cache.
  useEffect(() => {
    if (!loaded) return;
    return startVisiblePoll(refreshSizes, 30000);
  }, [loaded, wsSetRev, refreshSizes]);

  useEffect(() => {
    if (!loaded) return;
    // startVisiblePoll already refreshes on the visible→hidden→visible
    // transition (which covers refocus), so no separate focus listener.
    return startVisiblePoll(refreshAllPRs, 12000);
  }, [loaded, wsSetRev, refreshAllPRs]);

  // Linear verification rides its own slow poll. The main process caches each
  // key's existence for the session (it can't change), so steady-state ticks
  // are nearly free — this cadence exists only to pick up workspaces added or
  // renamed since the last pass. Re-runs when the workspace set changes.
  useEffect(() => {
    if (!loaded) return;
    return startVisiblePoll(refreshAllLinear, 60000);
  }, [loaded, wsSetRev, refreshAllLinear]);

  // Pinned tickets change slowly (a human moves a Linear issue), so poll well
  // below the badge cadence. Visibility-gated like every other poll. This does
  // NOT reuse the badge path: that caches by key for the whole session, which
  // would freeze a ticket's mutable workflow state — the very thing the row
  // exists to show.
  useEffect(() => {
    if (!loaded) return;
    return startVisiblePoll(refreshTickets, 120000);
  }, [loaded, refreshTickets]);

  useEffect(() => {
    return window.orchestra.onAgentFinished((finishedId, focused) => {
      dlog('finished', `${finishedId.slice(0, 8)} focused=${focused} active=${useStore.getState().activeId === finishedId}`);
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

  useEffect(() => {
    return window.orchestra.onAgentNeedsInput((id, focused) => {
      dlog('needs-input', `${id.slice(0, 8)} focused=${focused} active=${useStore.getState().activeId === id}`);
      // Same focus heuristic as agent:finished — don't chime if the user is
      // already looking at the workspace. The dot itself is cleared by the
      // state-watcher effect below, which also covers the cases where main
      // never sends an event (notify dropped because status was already
      // `waiting`) or where `window.isFocused()` was momentarily wrong.
      if (focused && useStore.getState().activeId === id) return;
      playFinishedChime();
    });
  }, []);

  // Auto-clear the yellow "unread" dot whenever the active workspace is in
  // `waiting` and the orchestra window is currently focused. This is the
  // single source of truth for "user has seen this" — it doesn't depend on a
  // specific event firing or on main's focus snapshot at event time.
  useEffect(() => {
    if (!activeId) return;
    const active = workspaces.find((w) => w.id === activeId);
    if (!active || active.status !== 'waiting') return;
    const clearIfFocused = () => {
      if (document.hasFocus()) {
        void window.orchestra.markSeen(activeId).catch(() => {});
      }
    };
    clearIfFocused();
    window.addEventListener('focus', clearIfFocused);
    return () => window.removeEventListener('focus', clearIfFocused);
  }, [activeId, workspaces]);

  const liveWorkspaces = workspaces.filter((w) => !w.archived);
  const active = liveWorkspaces.find((w) => w.id === activeId);

  // Which panes stay mounted: the MAX_MOUNTED_PANES most-recently-active
  // workspaces (LRU order), plus the active one unconditionally. Anything else
  // unmounts to release its WebGL context. See computeMountedIds for the full
  // rationale and its unit tests.
  const mountedIds = computeMountedIds({
    liveIds: liveWorkspaces.map((w) => w.id),
    lruOrder,
    activeId,
    max: MAX_MOUNTED_PANES,
  });
  const mountedWorkspaces = liveWorkspaces.filter((w) => mountedIds.has(w.id));
  // Both scratch and orchestrator sessions are non-git and repo-less, so they
  // get the same treatment for the GIT-ONLY surfaces (no Diff/Run/Merge/PR).
  // `isScratch` here means "scratch-like", covering both kinds. NOTE: the
  // structured (SDK) agent view is NOT git-gated — the main-process SDK path is
  // kind-agnostic (agent-sdk.ts even appends the ORCHESTRATOR_BRIEF for
  // orchestrators), so scratch and orchestrator sessions get the Terminal AND
  // Structured tabs, only lacking Run.
  const isScratch = !!active && isScratchLike(active);
  const isOrchestrator = active?.kind === 'orchestrator';
  const openPR = active ? prs[active.id]?.open ?? null : null;

  // A scratch-like session is non-git and has no repo, so the git-only `run`
  // view is unavailable. If the user had it selected and then switches to such a
  // session, fall back to the terminal so the pane isn't left blank. The
  // `structured` view stays valid for every kind, so it is NOT forced away.
  useEffect(() => {
    if (isScratch && view === 'run') setView('terminal');
  }, [isScratch, view, setView]);
  const onRestart = async () => {
    if (!active) return;
    if (active.status === 'running') {
      const ok = await dialog.confirm({
        title: 'Restart agent?',
        message: `${active.branch} is mid-turn. Restarting will kill the current response.`,
        detail: 'The conversation resumes via `claude --continue`, but in-flight output is lost.',
        tone: 'danger',
      });
      if (!ok) return;
    }
    try {
      await window.orchestra.restartAgent(active.id);
    } catch (e) {
      void dialog.error(`Could not restart agent: ${(e as Error).message}`);
    }
  };
  // Keep the toolbar Play/Stop button in sync with the actual run-script PTY.
  // Re-query on workspace switch (the pty may have been started elsewhere —
  // e.g. from the Run panel) and clear when it exits.
  useEffect(() => {
    if (!activeId) {
      setRunLive(false);
      return;
    }
    let cancelled = false;
    void window.orchestra
      .runScriptStatus(activeId)
      .then((live) => {
        if (!cancelled) setRunLive(live);
      })
      .catch(() => {});
    const offExit = window.orchestra.onPtyExit((id) => {
      if (id === `${activeId}:run`) setRunLive(false);
    });
    return () => {
      cancelled = true;
      offExit();
    };
  }, [activeId]);

  const onToggleRun = async () => {
    if (!active) return;
    try {
      if (runLive) {
        await window.orchestra.runScriptStop(active.id);
        setRunLive(false);
      } else {
        // The Run panel may not be mounted, so there's no xterm to measure.
        // Start with sane default dims; the panel resizes the pty (idempotently)
        // when the user later opens it.
        await window.orchestra.runScriptStart(active.id, 80, 24);
        setRunLive(true);
      }
    } catch (e) {
      void dialog.error(`Could not ${runLive ? 'stop' : 'start'} run script: ${(e as Error).message}`);
    }
  };

  return (
    <div
      ref={appRef}
      className="app"
      style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}
    >
      <Sidebar
        onNewFromRepo={addRepoOnly}
        onNewScratch={createScratchWorkspace}
        onNewOrchestrator={createOrchestratorWorkspace}
      />
      <div
        ref={sidebarResizerRef}
        className="sidebar-resizer"
        style={{ left: `${sidebarWidth}px` }}
        onMouseDown={onSidebarResizerMouseDown}
        onDoubleClick={resetSidebarWidth}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (double-click to reset)"
        title="Drag to resize · double-click to reset"
      />
      <main className="main">
        {!loaded && <div className="empty">Loading…</div>}
        {loaded && !active && (
          <div className="empty">
            <h2>Welcome to Orchestra</h2>
            <div>Run parallel Claude Code agents in isolated git worktrees — each on its own branch, all in one dashboard.</div>
            <div className="empty-actions">
              <button className="primary" onClick={addRepoOnly}>+ New workspace</button>
              <button className="secondary" onClick={createScratchWorkspace}><ZapIcon /> Scratch session</button>
              <button className="secondary" onClick={createOrchestratorWorkspace}><OrchestratorIcon /> Orchestrator</button>
            </div>
            <div className="welcome-features">
              <div className="welcome-feature">
                <span className="welcome-feature-name">Isolated worktrees</span>
                <span className="welcome-feature-desc">Each agent gets its own branch and directory — no clobbering</span>
              </div>
              <div className="welcome-feature">
                <span className="welcome-feature-name">Agents spawn agents</span>
                <span className="welcome-feature-desc">Ask one agent to parallelize; the sidebar fills up</span>
              </div>
              <div className="welcome-feature">
                <span className="welcome-feature-name">Diff-first review</span>
                <span className="welcome-feature-desc">Live side-by-side diff, then a one-click PR</span>
              </div>
              <div className="welcome-feature">
                <span className="welcome-feature-name">Accounts &amp; usage</span>
                <span className="welcome-feature-desc">Multiple Claude logins with live usage bars</span>
              </div>
              <div className="welcome-feature">
                <span className="welcome-feature-name">Remote sandbox</span>
                <span className="welcome-feature-desc">Agents keep working in Docker with the laptop closed</span>
              </div>
              <div className="welcome-feature">
                <span className="welcome-feature-name">Improves itself</span>
                <span className="welcome-feature-desc">Point agents at Orchestra&rsquo;s own repo and ship the change</span>
              </div>
            </div>
            <button className="welcome-help-btn" onClick={() => setHelpOpen(true)}>
              <HelpIcon size={14} /> Everything Orchestra can do
            </button>
          </div>
        )}
        {loaded && active && (
          <>
            <div className="toolbar">
              <div className="title">
                {isOrchestrator ? (
                  <span className="branch-chip orchestrator" title="Orchestrator session — coordinates spawned agents">
                    <OrchestratorIcon />
                    <span className="branch-chip-text">{active.branch}</span>
                  </span>
                ) : isScratch ? (
                  <span className="branch-chip scratch" title="Scratch session — not tracked by git">
                    <ZapIcon />
                    <span className="branch-chip-text">{active.branch}</span>
                  </span>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              {/* View controls — what fills the pane. The nvim pane-toggle is
                  a view control too, so it lives beside the tabs rather than
                  stranded at the far edge of the toolbar. */}
              <div className="toolbar-views">
              <div className="tabs">
                <button
                  className={`tab ${view === 'terminal' ? 'active' : ''}`}
                  onClick={() => setView('terminal')}
                  title={
                    readDefaultAgentView() === 'structured'
                      ? 'Raw embedded terminal (Claude Code TUI) — the structured view is your default'
                      : 'Embedded terminal (Claude Code TUI)'
                  }
                >
                  {terminalTabLabel(readDefaultAgentView())}
                </button>
                {!isScratch && (() => {
                  const repo = findRepo(active.repoPath);
                  const hasRun = !!repo?.scripts?.run;
                  // Tab stays visible without a run script so users notice the
                  // affordance and discover the gear-icon entry point.
                  return (
                    <button
                      className={`tab ${view === 'run' ? 'active' : ''}`}
                      onClick={() => setView('run')}
                      title={
                        hasRun
                          ? 'Spawn the configured run script (dev server, etc.)'
                          : 'No run script configured for this repo — click to learn more'
                      }
                    >
                      Run
                      {!hasRun && <span className="tab-dim"> · setup</span>}
                    </button>
                  );
                })()}
                <button
                  className={`tab ${view === 'structured' ? 'active' : ''}`}
                  onClick={() => setView('structured')}
                  title="Structured agent view (Claude Agent SDK) — streaming messages, tool cards, diffs"
                >
                  Structured
                </button>
              </div>
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
              <button
                className={`pane-toggle ${browserOpen ? 'active' : ''}`}
                onClick={() => setBrowserOpen((v) => !v)}
                title={browserOpen ? 'Hide browser pane' : 'Show browser pane'}
                aria-label={browserOpen ? 'Hide browser pane' : 'Show browser pane'}
                aria-pressed={browserOpen}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    d="M2.4 8h11.2M8 2.25c1.6 1.5 2.5 3.6 2.5 5.75S9.6 12.25 8 13.75C6.4 12.25 5.5 10.15 5.5 8S6.4 3.75 8 2.25Z"
                  />
                </svg>
              </button>
              </div>
              <div className="toolbar-sep" aria-hidden="true" />
              {/* Actions — things that DO something to the workspace: restart
                  the agent, start/stop the run script, and the PR call-to-
                  action pinned at the far right. */}
              <div className="toolbar-actions">
              <button
                className="restart-btn"
                onClick={onRestart}
                title="Restart agent (resumes via --continue, picks up MCP / settings changes)"
                aria-label="Restart agent"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M21 12a9 9 0 1 1-3.18-6.86" />
                  <polyline points="21 4 21 9 16 9" />
                </svg>
              </button>
              {!isScratch && !!findRepo(active.repoPath)?.scripts?.run && (
                <button
                  className={`run-toggle-btn ${runLive ? 'running' : ''}`}
                  onClick={() => void onToggleRun()}
                  title={runLive ? 'Stop the run script' : 'Run the app (run script)'}
                  aria-label={runLive ? 'Stop the run script' : 'Run the app'}
                  aria-pressed={runLive}
                >
                  {runLive ? (
                    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
                      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
                      <path fill="currentColor" d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
              )}
              {!isScratch && (openPR ? (
                <button
                  className="primary pr-link"
                  onClick={() => window.orchestra.openExternal(openPR.url)}
                  title={`OPEN · ${openPR.title}`}
                >
                  PR #{openPR.number}
                </button>
              ) : (() => {
                // Prime the button when there are local commits not on origin —
                // the user is one push away from being able to actually open
                // a PR, so make the affordance visually obvious.
                const unpushed = active.unpushedAhead ?? 0;
                const primed = unpushed > 0;
                const tip = primed
                  ? `${unpushed} commit${unpushed === 1 ? '' : 's'} ready to push — ask the agent to push and open a PR`
                  : 'Ask the focused Claude Code agent to create a PR';
                return (
                  <button
                    className={`pr-link pr-link-create${primed ? ' primed' : ''}`}
                    onClick={() => {
                      const id = active.id;
                      const prompt =
                        'Please create a pull request for the current branch: commit any pending changes, push the branch, and open the PR with a concise title and summary.';
                      // Type the prompt first, then send Enter as a separate keystroke
                      // so Claude's TUI treats it as a submit, not a pasted newline.
                      window.orchestra.ptyWrite(id, prompt);
                      setTimeout(() => window.orchestra.ptyWrite(id, '\r'), 80);
                    }}
                    title={tip}
                  >
                    {primed ? `Open PR · ↑${unpushed}` : 'Open PR'}
                  </button>
                );
              })())}
              </div>
            </div>
            {/* SetupBanner sits ABOVE .pane-row, not inside .pane. Inside,
                the active TerminalView uses `position: absolute; inset: 0`
                and would eclipse the banner on the Terminal tab. Above the
                row, it's a normal flex child taking its natural height when
                visible, zero when null. The `setup-` key prefix avoids
                colliding with sibling keys (RunTerminal also keys by
                `active.id`). */}
            <SetupBanner key={`setup-${active.id}`} workspace={active} />
            {/* Same above-the-row placement as SetupBanner, same reason: the
                read-only ownership bar must not be eclipsed by the absolutely-
                positioned TerminalView. Renders null for local workspaces. */}
            <SandboxControlBar key={`sandbox-${active.id}`} workspace={active} />
            {/* Usage-limit prompt queue — same above-the-row placement as the
                banners above. Shows only while the active workspace's account
                is over its usage limit or prompts are still queued. */}
            <PromptQueueBanner key={`queue-${active.id}`} workspace={active} />
            {/* Render a TerminalView for the recently-used workspaces (see
                mountedWorkspaces / MAX_MOUNTED_PANES) but only show the active
                one. Keeping each xterm.js instance mounted preserves its
                scrollback buffer across tab switches; capping the set at the LRU
                bounds the number of live WebGL contexts so the GPU process
                doesn't crash the whole content area to black. */}
            <div
              ref={paneRowRef}
              className={`pane-row ${nvimOpen ? 'with-nvim' : ''}`}
            >
              <div className="pane">
                {mountedWorkspaces.map((ws) => (
                  <TerminalView
                    key={ws.id}
                    workspaceId={ws.id}
                    isActive={ws.id === activeId && view === 'terminal'}
                  />
                ))}
                {/* Structured view is kept mounted for the same recently-used
                    workspaces as the terminals above (mountedWorkspaces) so the
                    folded session and scroll position survive tab switches — its
                    store state persists regardless, but keeping the component
                    mounted preserves the virtualized list's scroll offset.
                    Every workspace kind (worktree, scratch, orchestrator) has an
                    SDK session — the main-process path is kind-agnostic — so none
                    are excluded here. */}
                {mountedWorkspaces.map((ws) => (
                  <StructuredView
                    key={`structured-${ws.id}`}
                    workspaceId={ws.id}
                    isActive={ws.id === activeId && view === 'structured'}
                  />
                ))}
                {view === 'run' && (
                  <RunTerminal
                    // Prefix avoids colliding with the sibling TerminalView's
                    // key (it uses the same workspace id). Without the prefix,
                    // when the active workspace's TerminalView and the
                    // RunTerminal coexist as `.pane` children, React warns and
                    // can reuse fibers across component types.
                    key={`run-${active.id}`}
                    workspaceId={active.id}
                    isActive={true}
                    hasRunScript={!!findRepo(active.repoPath)?.scripts?.run}
                  />
                )}
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
              {browserOpen && (
                <>
                  <div
                    className="pane-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize browser pane"
                    onMouseDown={onBrowserResizerMouseDown}
                  />
                  <div
                    className="browser-pane"
                    style={{ flex: `0 0 ${browserWidth}px` }}
                  >
                    {/* Hide the native view (isActive=false) whenever a full-page
                        overlay covers the pane row — the WebContentsView
                        composits ABOVE the DOM and would otherwise show through
                        Insights/Resources/Help. */}
                    <BrowserPanel
                      workspaceId={active.id}
                      isActive={
                        browserOpen && !insightsOpen && !helpOpen && page !== 'resources'
                      }
                    />
                  </div>
                </>
              )}
            </div>
          </>
        )}
        {/* Insights & Improvements pane and the full-page Resources view are
            both overlays (absolute, above the pane row) rather than route
            swaps: unmounting the workspace tree would kill every kept-alive
            TerminalView's xterm scrollback. The store keeps them mutually
            exclusive, so at most one renders. */}
        {loaded && insightsOpen && <InsightsView />}
        {loaded && page === 'resources' && <ResourcesView />}
        {/* Help / feature guide pane — same overlay contract as Insights. */}
        {loaded && helpOpen && <HelpView />}
      </main>
      <DialogHost />
    </div>
  );
}
