// Which workspace panes stay mounted in the renderer at once.
//
// Every mounted workspace keeps a StructuredView (the Agent view) alive so its
// scroll position survives tab switches. The cap dates from when every pane was a
// WebGL-backed xterm (only the Run terminal still holds a context): Chromium
// force-loses WebGL contexts past ~16 per page while the shared GPU process
// buckles well before dozens are live — the observed failure was the entire
// content area going black until the user restarted Orchestra.
//
// So we mount only the most-recently-used workspaces: the `max` most recent by
// activation order, plus the active one unconditionally (it may not be in the
// LRU list yet on the first render after selection). Everything else unmounts
// and reopening it rebuilds the pane.
//
// CAUTION for the STRUCTURED view: eviction destroys component-local state, and
// anything reconstructed from a per-mount ref must therefore be keyed on the
// STORE, not on the component. The `agent:event` subscription (store.ts) is
// global and ungated, so an unmounted workspace keeps folding events — a pane
// evicted here and later handed a background turn comes back holding only those
// few messages. StructuredView's history backfill hit exactly this and now gates
// on `AgentSession.historyBackfilled` (renderer/history-backfill.ts) instead of
// message count.
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
