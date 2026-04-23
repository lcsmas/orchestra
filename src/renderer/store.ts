import { create } from 'zustand';
import type { CreateWorkspaceInput, RepoEntry, Workspace } from '../shared/types';

interface State {
  repos: RepoEntry[];
  workspaces: Workspace[];
  activeId: string | null;
  view: 'terminal' | 'diff';
  loaded: boolean;

  setActive: (id: string | null) => void;
  setView: (v: 'terminal' | 'diff') => void;
  load: () => Promise<void>;
  addRepo: () => Promise<RepoEntry | null>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  quickCreateWorkspace: () => Promise<void>;
  archive: (id: string) => Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  repos: [],
  workspaces: [],
  activeId: null,
  view: 'terminal',
  loaded: false,

  setActive: (id) => set({ activeId: id }),
  setView: (v) => set({ view: v }),

  load: async () => {
    const [repos, workspaces] = await Promise.all([
      window.orchestra.listRepos(),
      window.orchestra.listWorkspaces(),
    ]);
    set({ repos, workspaces, loaded: true, activeId: workspaces[0]?.id ?? null });
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
      alert(`Could not add repo: ${(e as Error).message}`);
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
      alert(`Could not create workspace: ${(e as Error).message}`);
    }
  },

  archive: async (id) => {
    await window.orchestra.archiveWorkspace(id);
    const s = get();
    const remaining = s.workspaces.filter((w) => w.id !== id);
    set({ workspaces: remaining, activeId: remaining[0]?.id ?? null });
  },
}));

// Live updates from main process.
window.orchestra.onWorkspaceUpdate((w) => {
  useStore.setState((s) => ({
    workspaces: s.workspaces.map((x) => (x.id === w.id ? { ...x, ...w } : x)),
  }));
});
