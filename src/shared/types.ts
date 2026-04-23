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
  archived?: boolean;
  archivedAt?: number;
  hasInput?: boolean;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  oldContent: string;
  newContent: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  files: number;
}

export interface CreateWorkspaceInput {
  repoPath: string;
  branch?: string;
  baseBranch?: string;
  task?: string;
  agent?: 'claude' | 'codex';
}

export interface RepoEntry {
  path: string;
  name: string;
  defaultBranch: string;
}

export interface PRInfo {
  url: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
}

export interface PRsForBranch {
  /** All PRs ever opened from this branch, newest-first (capped). */
  all: PRInfo[];
  /** The currently-open PR for this branch, if any. */
  open: PRInfo | null;
  /** Most recent PR for this branch in any state (may equal `open`). */
  latest: PRInfo | null;
  /** Count of merged PRs ever opened from this branch. */
  mergedCount: number;
}
