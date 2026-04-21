import { create } from 'zustand';
import type { RepoEntry, Workspace } from '../shared/types';

interface State {
  repos: RepoEntry[];
  workspaces: Workspace[];
  activeId: string | null;
  view: 'terminal' | 'diff';
  loaded: boolean;

  setActive: (id: string | null) => void;
  setView: (v: 'terminal' | 'diff') => void;
  load: () => Promise<void>;
  addRepo: () => Promise<void>;
  createWorkspace: (input: {
    repoPath: string;
    branch: string;
    baseBranch: string;
    task?: string;
    agent: 'claude' | 'codex';
  }) => Promise<void>;
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
    if (!dir) return;
    try {
      await window.orchestra.addRepo(dir);
      const repos = await window.orchestra.listRepos();
      set({ repos });
    } catch (e) {
      alert(`Could not add repo: ${(e as Error).message}`);
    }
  },

  createWorkspace: async (input) => {
    const ws = await window.orchestra.createWorkspace(input);
    set((s) => ({ workspaces: [...s.workspaces, ws], activeId: ws.id }));
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
