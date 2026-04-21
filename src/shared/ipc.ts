import type { CreateWorkspaceInput, DiffFile, RepoEntry, Workspace } from './types';

export interface OrchestraAPI {
  // Repos
  addRepo: (absPath: string) => Promise<RepoEntry>;
  listRepos: () => Promise<RepoEntry[]>;
  removeRepo: (absPath: string) => Promise<void>;
  pickDirectory: () => Promise<string | null>;

  // Workspaces
  listWorkspaces: () => Promise<Workspace[]>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
  archiveWorkspace: (id: string) => Promise<void>;
  openInEditor: (id: string, editor: 'code' | 'cursor') => Promise<void>;

  // Terminal (pty)
  ptyStart: (id: string, cols: number, rows: number) => Promise<void>;
  ptyWrite: (id: string, data: string) => Promise<void>;
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>;
  ptyStop: (id: string) => Promise<void>;
  onPtyData: (cb: (id: string, data: string) => void) => () => void;
  onPtyExit: (cb: (id: string, code: number) => void) => () => void;

  // Git / Diff
  getDiff: (id: string) => Promise<DiffFile[]>;
  commit: (id: string, message: string) => Promise<void>;
  push: (id: string) => Promise<void>;
  createPR: (id: string, title: string, body: string) => Promise<string>;

  // Events
  onWorkspaceUpdate: (cb: (w: Workspace) => void) => () => void;
}

declare global {
  interface Window {
    orchestra: OrchestraAPI;
  }
}
