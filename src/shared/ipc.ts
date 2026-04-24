import type {
  CreateWorkspaceInput,
  DiffFile,
  DiffStats,
  PRsForBranch,
  RepoEntry,
  Workspace,
} from './types';

export interface OrchestraAPI {
  // Repos
  addRepo: (absPath: string) => Promise<RepoEntry>;
  listRepos: () => Promise<RepoEntry[]>;
  removeRepo: (absPath: string) => Promise<void>;
  pickDirectory: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;

  // Workspaces
  listWorkspaces: () => Promise<Workspace[]>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
  archiveWorkspace: (id: string) => Promise<void>;
  unarchiveWorkspace: (id: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  openInEditor: (id: string, editor: 'code' | 'cursor') => Promise<void>;
  markSeen: (id: string) => Promise<void>;

  // Terminal (pty)
  ptyStart: (id: string, cols: number, rows: number) => Promise<void>;
  ptyWrite: (id: string, data: string) => Promise<void>;
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>;
  ptyStop: (id: string) => Promise<void>;
  ptyScrollback: (id: string) => Promise<string>;
  ptyClearScrollback: (id: string) => Promise<void>;
  nvimStart: (id: string, cols: number, rows: number) => Promise<void>;
  nvimStop: (id: string) => Promise<void>;
  onPtyData: (cb: (id: string, data: string) => void) => () => void;
  onPtyExit: (cb: (id: string, code: number) => void) => () => void;

  // Git / Diff
  getDiff: (id: string) => Promise<DiffFile[]>;
  getDiffStats: (id: string) => Promise<DiffStats>;
  commit: (id: string, message: string) => Promise<void>;
  push: (id: string) => Promise<void>;
  createPR: (id: string, title: string, body: string) => Promise<string>;
  findPR: (id: string) => Promise<PRsForBranch>;
  listBranches: (id: string) => Promise<string[]>;
  switchBranch: (id: string, branch: string) => Promise<Workspace>;
  mergeWorktree: (
    id: string,
  ) => Promise<
    | { status: 'merged'; pushed: boolean; pushError?: string }
    | { status: 'pending-commit'; message: string }
  >;

  // Events
  onWorkspaceUpdate: (cb: (w: Workspace) => void) => () => void;
  onWorkspaceRemoved: (cb: (id: string) => void) => () => void;
  onWorkspaceFocus: (cb: (id: string) => void) => () => void;
  onAgentFinished: (cb: (id: string, focused: boolean) => void) => () => void;
}

declare global {
  interface Window {
    orchestra: OrchestraAPI;
  }
}
