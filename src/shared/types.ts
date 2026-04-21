export type WorkspaceStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

export interface Workspace {
  id: string;
  name: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  createdAt: number;
  status: WorkspaceStatus;
  agent: 'claude' | 'codex';
  lastTask?: string;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  oldContent: string;
  newContent: string;
}

export interface CreateWorkspaceInput {
  repoPath: string;
  branch: string;
  baseBranch: string;
  task?: string;
  agent: 'claude' | 'codex';
}

export interface RepoEntry {
  path: string;
  name: string;
  defaultBranch: string;
}
