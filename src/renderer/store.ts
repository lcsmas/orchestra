import { create } from 'zustand';
import type {
  Account,
  AccountUsageStatus,
  CreateWorkspaceInput,
  DiffStats,
  LinearIssue,
  PRsForBranch,
  RepoEntry,
  RepoSyncState,
  UsageSnapshot,
  Workspace,
  WorkspaceAccount,
} from '../shared/types';
import type { SelfTuneRun } from '../shared/self-tune';
import { dialog } from './components/Dialog';
import { dlog, debugEnabled } from './debug';

// How many workspace probes (each an IPC → git/gh subprocess in main) a poll
// fans out at once. The polls used to `Promise.all` over every workspace, so a
// user with many workspaces fired a burst of N concurrent subprocesses every
// 8s — a periodic main-process spike felt as a hitch (e.g. while typing).
// Bounding the fan-out flattens that spike; the poll just takes a couple extra
// ticks to walk the tail, which is invisible at these cadences.
const POLL_CONCURRENCY = 4;

/** Map `items` through `fn` with at most `POLL_CONCURRENCY` in flight, in the
 *  order the pool drains them (order-independent — callers key results by id). */
async function mapBounded<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, items.length) }, worker));
  return out;
}

interface State {
  repos: RepoEntry[];
  workspaces: Workspace[];
  stats: Record<string, DiffStats>;
  /** Worktree size in bytes, keyed by workspace id. Refreshed off the hot
   *  stats poll (on load / workspace-set change) since the scan is heavier. */
  sizes: Record<string, number>;
  /** True when `sizes` are btrfs exclusive (reclaimable) bytes; false when
   *  they're apparent `du` sizes (non-btrfs fallback). Drives tooltip copy. */
  sizesExclusive: boolean;
  prs: Record<string, PRsForBranch>;
  /** Linear issue confirmed to exist for a workspace's branch, keyed by
   *  workspace id. Absent until verified; explicit null means "checked, no real
   *  issue" — so the sidebar shows a badge only on a present, non-null value. */
  linear: Record<string, LinearIssue | null>;
  /** Ephemeral name of the tool each agent is currently running (Bash, Edit,
   *  …), keyed by workspace id. Driven by `agent:tool` events; absent when the
   *  agent is between tools or idle. Never persisted. */
  tools: Record<string, string>;
  /** Context-window size (tokens) of each agent's session, keyed by workspace
   *  id. Seeded on load from each workspace's persisted `contextTokens` (the
   *  last turn-end figure) so the sidebar badge shows immediately at startup,
   *  before any agent has run. Thereafter driven live by `agent:context` events,
   *  which overwrite the seed the moment the agent next takes a turn. Absent for
   *  a workspace that has never completed a turn. */
  contextTokens: Record<string, number>;
  /** Per-repo base-branch sync state (behind/ahead of origin/<base>),
   *  keyed by repoPath. Updated by `repo:syncState` events. */
  repoSync: Record<string, RepoSyncState>;
  /** Usage status per configured account, keyed by account id. Hydrated on
   *  load and updated via `accounts:usageUpdate` events. */
  accountUsage: Record<string, AccountUsageStatus>;
  /** Which account each workspace logs in as (identity only — no tokens),
   *  keyed by workspace id. */
  workspaceAccounts: Record<string, WorkspaceAccount>;
  /** Configured Claude accounts (id → label/configDir). Drives the repo
   *  header's account name. Refreshed whenever the account mapping changes. */
  accounts: Account[];
  /** Usage of Orchestra's default login (the global `~/.claude` poller), or
   *  null until the first fetch lands. Drives the "default login" badge/bars for
   *  workspaces and repos with no pinned account. Hydrated on load and updated
   *  via `usage:update` events. */
  globalUsage: UsageSnapshot | null;
  /** Self-tune run history, newest first (in-flight run included). Hydrated on
   *  load and patched live by `selfTune:update` events. */
  selfTuneRuns: SelfTuneRun[];
  /** Whether the Insights & Improvements pane is shown over the main pane.
   *  Selecting a workspace closes it. */
  insightsOpen: boolean;
  /** Whether the Help / feature-guide pane is shown over the main pane.
   *  Same overlay contract as Insights: selecting a workspace closes it, and
   *  the two panes are mutually exclusive. */
  helpOpen: boolean;
  activeId: string | null;
  view: 'terminal' | 'diff' | 'run';
  /** Which top-level surface fills the main pane: the normal workspace panes,
   *  or the full-page Resources view (opened from the sidebar footer). The
   *  workspace panes stay mounted underneath so xterm scrollback survives a
   *  visit to the Resources page. */
  page: 'workspaces' | 'resources';
  loaded: boolean;

  setActive: (id: string | null) => void;
  setView: (v: 'terminal' | 'diff' | 'run') => void;
  setInsightsOpen: (open: boolean) => void;
  setPage: (p: 'workspaces' | 'resources') => void;
  setHelpOpen: (open: boolean) => void;
  load: () => Promise<void>;
  refreshRepos: () => Promise<void>;
  addRepo: () => Promise<RepoEntry | null>;
  removeRepo: (repoPath: string) => Promise<void>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  createScratchWorkspace: () => Promise<void>;
  createOrchestratorWorkspace: () => Promise<void>;
  addRepoOnly: () => Promise<void>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  /** Toggle the manual "unread" tag (come-back-later bookmark) on a workspace. */
  setUnread: (id: string, unread: boolean) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  deleteWorkspaces: (ids: string[]) => Promise<void>;
  importToSandbox: (id: string, endpoint: string) => Promise<void>;
  ejectFromSandbox: (id: string) => Promise<void>;
  reorderWorkspaces: (orderedIds: string[]) => Promise<void>;
  reorderRepos: (orderedPaths: string[]) => Promise<void>;
  refreshStats: (id: string) => Promise<void>;
  refreshAllStats: () => Promise<void>;
  refreshSizes: () => Promise<void>;
  refreshPR: (id: string) => Promise<void>;
  refreshAllPRs: () => Promise<void>;
  refreshLinear: (id: string) => Promise<void>;
  refreshAllLinear: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  repos: [],
  workspaces: [],
  stats: {},
  sizes: {},
  sizesExclusive: false,
  prs: {},
  linear: {},
  tools: {},
  contextTokens: {},
  repoSync: {},
  accountUsage: {},
  workspaceAccounts: {},
  accounts: [],
  globalUsage: null,
  selfTuneRuns: [],
  insightsOpen: false,
  helpOpen: false,
  activeId: null,
  view: 'terminal',
  page: 'workspaces',
  loaded: false,

  setActive: (id) => {
    // Picking a workspace dismisses the overlay panes (Insights, Help) — they
    // cover the main pane, so leaving one up would eclipse the terminal the
    // user just chose.
    set({ activeId: id, insightsOpen: false, helpOpen: false });
    if (id) {
      const ws = get().workspaces.find((w) => w.id === id);
      if (ws && ws.status === 'waiting') {
        void window.orchestra.markSeen(id).catch(() => {});
      }
      // Coming back to a manually-tagged workspace is the "read" moment —
      // clear the unread bookmark the user left for themselves.
      if (ws?.markedUnread) void get().setUnread(id, false);
    }
  },
  setView: (v) => set({ view: v }),
  // The Insights/Help panes and the Resources page are all full-pane surfaces —
  // opening any one dismisses the others so they can never stack.
  setInsightsOpen: (open) =>
    set(open ? { insightsOpen: true, helpOpen: false, page: 'workspaces' } : { insightsOpen: false }),
  setHelpOpen: (open) =>
    set(open ? { helpOpen: true, insightsOpen: false, page: 'workspaces' } : { helpOpen: false }),
  setPage: (p) =>
    set(p === 'resources' ? { page: p, insightsOpen: false, helpOpen: false } : { page: p }),

  load: async () => {
    const [repos, workspaces, syncStates, accountUsage, workspaceAccounts, accounts, globalUsage, selfTuneRuns] =
      await Promise.all([
        window.orchestra.listRepos(),
        window.orchestra.listWorkspaces(),
        window.orchestra.listRepoSyncStates().catch(() => []),
        window.orchestra.getAllAccountUsage().catch(() => ({})),
        window.orchestra.getWorkspaceAccounts().catch(() => ({})),
        window.orchestra.listAccounts().catch(() => []),
        window.orchestra.getUsage().catch(() => null),
        window.orchestra.listSelfTuneRuns().catch(() => []),
      ]);
    const repoSync: Record<string, RepoSyncState> = {};
    for (const s of syncStates) repoSync[s.repoPath] = s;
    // Seed the context badge from each workspace's persisted turn-end figure so
    // it paints at startup, before any live `agent:context` event has fired.
    const contextTokens: Record<string, number> = {};
    for (const w of workspaces) {
      if (typeof w.contextTokens === 'number') contextTokens[w.id] = w.contextTokens;
    }
    set({
      repos,
      workspaces,
      repoSync,
      contextTokens,
      accountUsage,
      workspaceAccounts,
      accounts,
      globalUsage: globalUsage ?? null,
      selfTuneRuns,
      loaded: true,
      activeId: workspaces[0]?.id ?? null,
    });
  },

  refreshRepos: async () => {
    const repos = await window.orchestra.listRepos();
    set({ repos });
  },

  addRepo: async () => {
    const dir = await window.orchestra.pickDirectory();
    if (!dir) return null;
    try {
      const added = await window.orchestra.addRepo(dir);
      const repos = await window.orchestra.listRepos();
      set({ repos });
      return added ?? repos.find((r) => r.path === dir) ?? null;
    } catch (e) {
      void dialog.error('Could not add repo', (e as Error).message);
      return null;
    }
  },

  removeRepo: async (repoPath) => {
    // Main rejects if any workspace still belongs to the repo; let that error
    // surface to the caller so the UI can explain why. On success main also
    // broadcasts `repos:update`, but update locally too so it feels instant.
    await window.orchestra.removeRepo(repoPath);
    set((s) => ({ repos: s.repos.filter((r) => r.path !== repoPath) }));
  },

  createWorkspace: async (input) => {
    const ws = await window.orchestra.createWorkspace(input);
    // Upsert: main also emits a `workspace:update` for the new ws during the
    // create call, which now appends it too (so agent-spawned workspaces show
    // up). Guard against adding it twice when this renderer-initiated path and
    // that event race.
    set((s) => ({
      workspaces: s.workspaces.some((x) => x.id === ws.id)
        ? s.workspaces.map((x) => (x.id === ws.id ? { ...x, ...ws } : x))
        : [...s.workspaces, ws],
      activeId: ws.id,
    }));
  },

  createScratchWorkspace: async () => {
    try {
      const ws = await window.orchestra.createScratchWorkspace();
      set((s) => ({
        workspaces: s.workspaces.some((x) => x.id === ws.id)
          ? s.workspaces.map((x) => (x.id === ws.id ? { ...x, ...ws } : x))
          : [...s.workspaces, ws],
        activeId: ws.id,
      }));
    } catch (e) {
      void dialog.error('Could not create scratch session', (e as Error).message);
    }
  },

  createOrchestratorWorkspace: async () => {
    try {
      const ws = await window.orchestra.createOrchestratorWorkspace();
      set((s) => ({
        workspaces: s.workspaces.some((x) => x.id === ws.id)
          ? s.workspaces.map((x) => (x.id === ws.id ? { ...x, ...ws } : x))
          : [...s.workspaces, ws],
        activeId: ws.id,
      }));
    } catch (e) {
      void dialog.error('Could not create orchestrator session', (e as Error).message);
    }
  },

  addRepoOnly: async () => {
    // Mapping a repo only registers it — the user creates workspaces explicitly
    // via the per-repo "+" button. No workspace is spawned here.
    await get().addRepo();
  },

  archive: async (id) => {
    await window.orchestra.archiveWorkspace(id);
    const s = get();
    const workspaces = s.workspaces.map((w) =>
      w.id === id ? { ...w, archived: true, archivedAt: Date.now(), status: 'stopped' as const } : w,
    );
    const activeId =
      s.activeId === id
        ? workspaces.find((w) => !w.archived)?.id ?? null
        : s.activeId;
    set({ workspaces, activeId });
  },

  unarchive: async (id) => {
    await window.orchestra.unarchiveWorkspace(id);
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, archived: false, archivedAt: undefined, status: 'idle' as const } : w,
      ),
      activeId: s.activeId ?? id,
    }));
  },

  setUnread: async (id, unread) => {
    // Optimistic flip so the dot paints instantly; main persists and
    // re-broadcasts the record via workspace:update.
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, markedUnread: unread || undefined } : w,
      ),
    }));
    await window.orchestra.setUnread(id, unread).catch(() => {});
  },

  importToSandbox: async (id, endpoint) => {
    // Main does the heavy lifting (bundle + POST + local retire) and returns
    // the updated record; it also broadcasts workspace:update, but upsert
    // locally too so the row regroups under its node immediately.
    const ws = await window.orchestra.importToSandbox(id, endpoint);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...ws } : w)),
    }));
  },

  ejectFromSandbox: async (id) => {
    const ws = await window.orchestra.ejectFromSandbox(id);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...ws, host: ws.host } : w)),
    }));
  },

  deleteWorkspace: async (id) => {
    await window.orchestra.deleteWorkspace(id);
    const s = get();
    const workspaces = s.workspaces.filter((w) => w.id !== id);
    const activeId =
      s.activeId === id
        ? workspaces.find((w) => !w.archived)?.id ?? null
        : s.activeId;
    const { [id]: _gone, ...rest } = s.stats;
    set({ workspaces, activeId, stats: rest });
  },

  // Bulk delete: main reaps every worktree then emits ONE `workspaces:removed`
  // batch, so the store prune happens in the `onWorkspacesRemoved` handler
  // (below) as a single set() — not one per id. Nothing to do here but wait.
  deleteWorkspaces: async (ids) => {
    await window.orchestra.deleteWorkspaces(ids);
  },

  reorderWorkspaces: async (orderedIds) => {
    set((s) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
      const workspaces = [...s.workspaces].sort(
        (a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
      return { workspaces };
    });
    try {
      await window.orchestra.reorderWorkspaces(orderedIds);
    } catch (e) {
      void dialog.error('Could not reorder workspaces', (e as Error).message);
    }
  },

  reorderRepos: async (orderedPaths) => {
    set((s) => {
      const rank = new Map(orderedPaths.map((p, i) => [p, i] as const));
      const repos = [...s.repos].sort(
        (a, b) =>
          (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER),
      );
      return { repos };
    });
    try {
      await window.orchestra.reorderRepos(orderedPaths);
    } catch (e) {
      void dialog.error('Could not reorder repos', (e as Error).message);
    }
  },

  refreshStats: async (id) => {
    try {
      const stats = await window.orchestra.getDiffStats(id);
      set((s) => ({ stats: { ...s.stats, [id]: stats } }));
    } catch {
      /* worktree may be stale or git busy — ignore */
    }
  },

  refreshAllStats: async () => {
    // Fetch every workspace's stats in parallel, then commit ONE store update.
    // The per-id refreshStats does its own set(), so fanning out over it fired N
    // separate notifications per poll (every 8s) — an N× re-render burst for
    // whole-store subscribers. Gather first, set once.
    const ids = get().workspaces.filter((w) => !w.archived).map((w) => w.id);
    const entries = await mapBounded(ids, async (id) => {
      try {
        return [id, await window.orchestra.getDiffStats(id)] as const;
      } catch {
        return null; // worktree may be stale or git busy — drop this one
      }
    });
    const next = Object.fromEntries(entries.filter((e) => e !== null));
    if (Object.keys(next).length) set((s) => ({ stats: { ...s.stats, ...next } }));
  },

  refreshSizes: async () => {
    try {
      const { sizes, exclusive } = await window.orchestra.getWorktreeSizes();
      set({ sizes, sizesExclusive: exclusive });
    } catch {
      /* du unavailable (e.g. non-unix) or root missing — leave sizes as-is */
    }
  },

  refreshPR: async (id) => {
    try {
      const pr = await window.orchestra.findPR(id);
      set((s) => ({ prs: { ...s.prs, [id]: pr } }));
    } catch {
      /* gh missing, no remote, etc. — ignore */
    }
  },

  refreshAllPRs: async () => {
    // Gather all PR lookups, then commit once — see refreshAllStats.
    const ids = get().workspaces.filter((w) => !w.archived).map((w) => w.id);
    const entries = await mapBounded(ids, async (id) => {
      try {
        return [id, await window.orchestra.findPR(id)] as const;
      } catch {
        return null; // gh missing, no remote, etc. — ignore
      }
    });
    const next = Object.fromEntries(entries.filter((e) => e !== null));
    if (Object.keys(next).length) set((s) => ({ prs: { ...s.prs, ...next } }));
  },

  refreshLinear: async (id) => {
    try {
      const issue = await window.orchestra.verifyLinear(id);
      set((s) => ({ linear: { ...s.linear, [id]: issue } }));
    } catch {
      /* no API key / unauthenticated / offline — leave as-is */
    }
  },

  refreshAllLinear: async () => {
    // Gather all Linear lookups, then commit once — see refreshAllStats.
    const ids = get().workspaces.filter((w) => !w.archived).map((w) => w.id);
    const entries = await mapBounded(ids, async (id) => {
      try {
        return [id, await window.orchestra.verifyLinear(id)] as const;
      } catch {
        return null; // no API key / unauthenticated / offline — leave as-is
      }
    });
    const next = Object.fromEntries(entries.filter((e) => e !== null));
    if (Object.keys(next).length) set((s) => ({ linear: { ...s.linear, ...next } }));
  },
}));

// Live updates from main process.
window.orchestra.onWorkspaceUpdate((w) => {
  // Debug: trace what status the renderer actually receives. A dot stuck on the
  // wrong colour is either a transition that never arrived (main-side) or one
  // that arrived and was overwritten (renderer-side) — this line shows which.
  if (debugEnabled()) {
    const prev = useStore.getState().workspaces.find((x) => x.id === w.id);
    if (!prev) dlog('ws+', `${w.id.slice(0, 8)} status=${w.status} (${w.name})`);
    else if (prev.status !== w.status)
      dlog('status', `${w.id.slice(0, 8)} ${prev.status} → ${w.status} (${w.name})`);
  }
  useStore.setState((s) => {
    // Upsert, not just patch: a workspace created by the main process — the
    // agent-driven /spawn flow — is unknown to this renderer, so a pure map()
    // would drop it on the floor until a full reload. Append when new (without
    // touching activeId, so a background spawn never steals the user's focus);
    // patch in place when already present.
    const exists = s.workspaces.some((x) => x.id === w.id);
    return {
      workspaces: exists
        ? s.workspaces.map((x) => (x.id === w.id ? { ...x, ...w } : x))
        : [...s.workspaces, w],
    };
  });
});
window.orchestra.onWorkspaceRemoved((id) => {
  useStore.setState((s) => {
    const workspaces = s.workspaces.filter((w) => w.id !== id);
    const activeId =
      s.activeId === id
        ? workspaces.find((w) => !w.archived)?.id ?? null
        : s.activeId;
    const { [id]: _gonePr, ...prs } = s.prs;
    const { [id]: _goneLinear, ...linear } = s.linear;
    const { [id]: _goneStat, ...stats } = s.stats;
    const { [id]: _goneTool, ...tools } = s.tools;
    const { [id]: _goneCtx, ...contextTokens } = s.contextTokens;
    return { workspaces, activeId, prs, linear, stats, tools, contextTokens };
  });
});
window.orchestra.onWorkspacesRemoved((ids) => {
  const drop = new Set(ids);
  useStore.setState((s) => {
    const workspaces = s.workspaces.filter((w) => !drop.has(w.id));
    const activeId =
      s.activeId && drop.has(s.activeId)
        ? workspaces.find((w) => !w.archived)?.id ?? null
        : s.activeId;
    const prune = <T,>(m: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(m).filter(([k]) => !drop.has(k)));
    return {
      workspaces,
      activeId,
      prs: prune(s.prs),
      linear: prune(s.linear),
      stats: prune(s.stats),
      tools: prune(s.tools),
      contextTokens: prune(s.contextTokens),
    };
  });
});
window.orchestra.onAgentTool((id, tool) => {
  dlog('tool', `${id.slice(0, 8)} ${tool ?? '(cleared)'}`);
  // This is the highest-frequency event in the app — it fires on every
  // PreToolUse/PostToolUse hook of every running agent. zustand notifies all
  // subscribers on ANY setState, even one that merges an empty/unchanged
  // object, so guard BEFORE calling setState: skip identical-tool repeats and
  // clears of an already-absent id so no-op ticks don't trigger re-renders.
  const s = useStore.getState();
  if (tool) {
    if (s.tools[id] === tool) return;
    useStore.setState({ tools: { ...s.tools, [id]: tool } });
    return;
  }
  if (!(id in s.tools)) return;
  const { [id]: _gone, ...tools } = s.tools;
  useStore.setState({ tools });
});
window.orchestra.onAgentContext((id, tokens) => {
  // Fires after each tool and at turn end. Guard before setState so an
  // unchanged figure (a posttool that didn't move the model) doesn't churn
  // subscribers — same discipline as onAgentTool above.
  const s = useStore.getState();
  // 0 is main's "context reset" sentinel (session cleared or compacted): the
  // real size is unknown until the next turn, so drop the badge rather than
  // keeping the stale pre-reset figure (or showing a literal "0").
  if (tokens === 0) {
    if (!(id in s.contextTokens)) return;
    const { [id]: _gone, ...contextTokens } = s.contextTokens;
    useStore.setState({ contextTokens });
    return;
  }
  if (s.contextTokens[id] === tokens) return;
  useStore.setState({ contextTokens: { ...s.contextTokens, [id]: tokens } });
});
window.orchestra.onWorkspaceFocus((id) => {
  const s = useStore.getState();
  if (s.workspaces.some((w) => w.id === id)) s.setActive(id);
});
window.orchestra.onRepoSyncState((s) => {
  useStore.setState((state) => ({
    repoSync: { ...state.repoSync, [s.repoPath]: s },
  }));
});
// A repo was added out-of-band (CLI or peer agent over the unix socket). Main
// pushes the full refreshed list, so replace ours wholesale — the renderer's
// own add flow already calls listRepos(), so this just covers the cases it
// didn't initiate.
window.orchestra.onReposUpdate((repos) => {
  useStore.setState({ repos });
});
// A self-tune run advanced (step started/finished, run completed). Upsert by
// id, keeping newest-first order — a brand-new run is always the newest.
window.orchestra.onSelfTuneUpdate((run) => {
  useStore.setState((s) => ({
    selfTuneRuns: s.selfTuneRuns.some((r) => r.id === run.id)
      ? s.selfTuneRuns.map((r) => (r.id === run.id ? run : r))
      : [run, ...s.selfTuneRuns],
  }));
});
// Per-account usage refreshed (>=180s-cached poll in main). Replace wholesale.
window.orchestra.onAccountUsageUpdate((byId) => {
  useStore.setState({ accountUsage: byId });
});
// Default-login usage refreshed (global `~/.claude` poller in main).
window.orchestra.onUsageUpdate((u) => {
  useStore.setState({ globalUsage: u });
});
// The workspace→account mapping changed (accounts edited / repo account changed /
// workspaces added/removed). Replace wholesale, and re-pull the accounts list
// since an account's label may have been edited alongside it (drives the repo
// header's account name).
window.orchestra.onWorkspaceAccountsUpdate((byId) => {
  useStore.setState({ workspaceAccounts: byId });
  void window.orchestra
    .listAccounts()
    .then((accounts) => useStore.setState({ accounts }))
    .catch(() => {});
});
