// Which workspace panes stay mounted in the renderer at once.
//
// Every mounted workspace keeps a TerminalView (a WebGL-backed xterm) and a
// StructuredView alive so their scrollback / scroll position survive tab
// switches. But each live TerminalView holds a WebGL context, and Chromium
// force-loses WebGL contexts past ~16 per page while the shared GPU process
// buckles well before dozens are live — the observed failure was the entire
// content area going black (GL contexts lost, renderer still alive, nothing
// recovers it) until the user restarts Orchestra.
//
// So we mount only the most-recently-used workspaces: the `max` most recent by
// activation order, plus the active one unconditionally (it may not be in the
// LRU list yet on the first render after selection). Everything else unmounts
// and releases its WebGL context; reopening it rebuilds the pane instantly (a
// fresh xterm repaints via `claude --continue`, no agent state lost — that is
// already how opening a workspace for the first time works).
//
// Pure and dependency-free so it is unit-testable without React/Electron.
export function computeMountedIds(opts: {
  /** Ids eligible to be mounted (e.g. live, non-archived workspaces). */
  liveIds: readonly string[];
  /** Workspace ids by most-recent activation, newest first. */
  lruOrder: readonly string[];
  /** Currently active workspace id, or null. Always mounted when live. */
  activeId: string | null;
  /** Cap on the number of mounted panes. */
  max: number;
}): Set<string> {
  const { liveIds, lruOrder, activeId, max } = opts;
  const live = new Set(liveIds);
  const mounted = new Set<string>();
  if (max <= 0) return mounted;
  // The active pane is always mounted, even if the cap is otherwise full and
  // even before it lands in lruOrder — otherwise selecting an evicted workspace
  // would render nothing.
  if (activeId && live.has(activeId)) mounted.add(activeId);
  for (const id of lruOrder) {
    if (mounted.size >= max) break;
    if (live.has(id)) mounted.add(id);
  }
  return mounted;
}
