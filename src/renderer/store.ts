import { create } from 'zustand';
import type {
  CreateWorkspaceInput,
  DiffStats,
  PRsForBranch,
  RepoEntry,
  RepoSyncState,
  Workspace,
} from '../shared/types';
import { dialog } from './components/Dialog';

interface State {
  repos: RepoEntry[];
  workspaces: Workspace[];
  stats: Record<string, DiffStats>;
  /** Apparent worktree size in bytes, keyed by workspace id. Refreshed off the
   *  hot stats poll (on load / workspace-set change) since `du` is heavier. */
  sizes: Record<string, number>;
  prs: Record<string, PRsForBranch>;
  /** Ephemeral name of the tool each agent is currently running (Bash, Edit,
   *  …), keyed by workspace id. Driven by `agent:tool` events; absent when the
   *  agent is between tools or idle. Never persisted. */
  tools: Record<string, string>;
  /** Per-repo base-branch sync state (behind/ahead of origin/<base>),
   *  keyed by repoPath. Updated by `repo:syncState` events. */
  repoSync: Record<string, RepoSyncState>;
  activeId: string | null;
  view: 'terminal' | 'diff' | 'run';
  loaded: boolean;

  setActive: (id: string | null) => void;
  setView: (v: 'terminal' | 'diff' | 'run') => void;
  load: () => Promise<void>;
  refreshRepos: () => Promise<void>;
  addRepo: () => Promise<RepoEntry | null>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  createScratchWorkspace: () => Promise<void>;
  addRepoOnly: () => Promise<void>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  reorderWorkspaces: (orderedIds: string[]) => Promise<void>;
  reorderRepos: (orderedPaths: string[]) => Promise<void>;
  refreshStats: (id: string) => Promise<void>;
  refreshAllStats: () => Promise<void>;
  refreshSizes: () => Promise<void>;
  refreshPR: (id: string) => Promise<void>;
  refreshAllPRs: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  repos: [],
  workspaces: [],
  stats: {},
  sizes: {},
  prs: {},
  tools: {},
  repoSync: {},
  activeId: null,
  view: 'terminal',
  loaded: false,

  setActive: (id) => {
    set({ activeId: id });
    if (id) {
      const ws = get().workspaces.find((w) => w.id === id);
      if (ws && ws.status === 'waiting') {
        void window.orchestra.markSeen(id).catch(() => {});
      }
    }
  },
  setView: (v) => set({ view: v }),

  load: async () => {
    const [repos, workspaces, syncStates] = await Promise.all([
      window.orchestra.listRepos(),
      window.orchestra.listWorkspaces(),
      window.orchestra.listRepoSyncStates().catch(() => []),
    ]);
    const repoSync: Record<string, RepoSyncState> = {};
    for (const s of syncStates) repoSync[s.repoPath] = s;
    set({
      repos,
      workspaces,
      repoSync,
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
    const ids = get().workspaces.filter((w) => !w.archived).map((w) => w.id);
    await Promise.all(ids.map((id) => get().refreshStats(id)));
  },

  refreshSizes: async () => {
    try {
      const sizes = await window.orchestra.getWorktreeSizes();
      set({ sizes });
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
    const ids = get().workspaces.filter((w) => !w.archived).map((w) => w.id);
    await Promise.all(ids.map((id) => get().refreshPR(id)));
  },
}));

// Live updates from main process.
window.orchestra.onWorkspaceUpdate((w) => {
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
    const { [id]: _goneStat, ...stats } = s.stats;
    const { [id]: _goneTool, ...tools } = s.tools;
    return { workspaces, activeId, prs, stats, tools };
  });
});
window.orchestra.onAgentTool((id, tool) => {
  useStore.setState((s) => {
    if (tool) return { tools: { ...s.tools, [id]: tool } };
    if (!(id in s.tools)) return {};
    const { [id]: _gone, ...tools } = s.tools;
    return { tools };
  });
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
