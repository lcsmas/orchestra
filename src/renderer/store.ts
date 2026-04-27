import { create } from 'zustand';
import type { CreateWorkspaceInput, DiffStats, PRsForBranch, RepoEntry, Workspace } from '../shared/types';
import { dialog } from './components/Dialog';

interface State {
  repos: RepoEntry[];
  workspaces: Workspace[];
  stats: Record<string, DiffStats>;
  prs: Record<string, PRsForBranch>;
  activeId: string | null;
  view: 'terminal' | 'diff' | 'run';
  loaded: boolean;

  setActive: (id: string | null) => void;
  setView: (v: 'terminal' | 'diff' | 'run') => void;
  load: () => Promise<void>;
  refreshRepos: () => Promise<void>;
  addRepo: () => Promise<RepoEntry | null>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  quickCreateWorkspace: () => Promise<void>;
  createWorkspaceInNewRepo: () => Promise<void>;
  archive: (id: string) => Promise<void>;
  unarchive: (id: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  refreshStats: (id: string) => Promise<void>;
  refreshAllStats: () => Promise<void>;
  refreshPR: (id: string) => Promise<void>;
  refreshAllPRs: () => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  repos: [],
  workspaces: [],
  stats: {},
  prs: {},
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
    const [repos, workspaces] = await Promise.all([
      window.orchestra.listRepos(),
      window.orchestra.listWorkspaces(),
    ]);
    set({ repos, workspaces, loaded: true, activeId: workspaces[0]?.id ?? null });
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
    set((s) => ({ workspaces: [...s.workspaces, ws], activeId: ws.id }));
  },

  quickCreateWorkspace: async () => {
    let repo = get().repos[0] ?? null;
    if (!repo) {
      repo = await get().addRepo();
      if (!repo) return;
    }
    try {
      await get().createWorkspace({ repoPath: repo.path });
    } catch (e) {
      void dialog.error('Could not create workspace', (e as Error).message);
    }
  },

  createWorkspaceInNewRepo: async () => {
    const repo = await get().addRepo();
    if (!repo) return;
    try {
      await get().createWorkspace({ repoPath: repo.path });
    } catch (e) {
      void dialog.error('Could not create workspace', (e as Error).message);
    }
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
  useStore.setState((s) => ({
    workspaces: s.workspaces.map((x) => (x.id === w.id ? { ...x, ...w } : x)),
  }));
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
    return { workspaces, activeId, prs, stats };
  });
});
window.orchestra.onWorkspaceFocus((id) => {
  const s = useStore.getState();
  if (s.workspaces.some((w) => w.id === id)) s.setActive(id);
});
