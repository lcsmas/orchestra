import type {
  CreateWorkspaceInput,
  DiffFile,
  DiffStats,
  PRsForBranch,
  RepoEntry,
  RepoScripts,
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
  renameBranch: (id: string, newBranch: string) => Promise<Workspace>;

  // Terminal (pty)
  ptyStart: (id: string, cols: number, rows: number) => Promise<void>;
  ptyWrite: (id: string, data: string) => Promise<void>;
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>;
  ptyStop: (id: string) => Promise<void>;
  /** Restart the agent process while keeping the conversation: stops the
   * current PTY and triggers a fresh spawn that runs `claude --continue`,
   * picking up MCP server / settings.json changes without losing context. */
  restartAgent: (id: string) => Promise<void>;
  ptyScrollback: (id: string) => Promise<string>;
  ptyClearScrollback: (id: string) => Promise<void>;
  nvimStart: (id: string, cols: number, rows: number) => Promise<void>;
  nvimStop: (id: string) => Promise<void>;
  onPtyData: (cb: (id: string, data: string) => void) => () => void;
  onPtyExit: (cb: (id: string, code: number) => void) => () => void;
  onPtyRestart: (cb: (id: string) => void) => () => void;

  // Git / Diff
  getDiff: (id: string) => Promise<DiffFile[]>;
  getDiffStats: (id: string) => Promise<DiffStats>;
  commit: (id: string, message: string) => Promise<void>;
  push: (id: string) => Promise<void>;
  createPR: (id: string, title: string, body: string) => Promise<string>;
  findPR: (id: string) => Promise<PRsForBranch>;
  listBranches: (id: string) => Promise<string[]>;
  switchBranch: (id: string, branch: string) => Promise<Workspace>;
  mergeWorktree: (id: string) => Promise<{ status: 'requested' }>;

  // Repo scripts (setup / run / archive)
  getRepoScripts: (repoPath: string) => Promise<RepoScripts>;
  setRepoScripts: (repoPath: string, scripts: RepoScripts) => Promise<RepoEntry>;
  retrySetup: (id: string) => Promise<void>;
  /** Returns the captured stdout+stderr of the most recent setup-script run
   * for this workspace, or `''` if none has run. */
  readSetupLog: (id: string) => Promise<string>;
  /** Spawn the run-script PTY (`<id>:run`). Idempotent: if already running,
   * just nudges a resize. Throws when no run script is configured. */
  runScriptStart: (id: string, cols: number, rows: number) => Promise<void>;
  runScriptStop: (id: string) => Promise<void>;
  runScriptScrollback: (id: string) => Promise<string>;

  // Events
  onWorkspaceUpdate: (cb: (w: Workspace) => void) => () => void;
  onWorkspaceRemoved: (cb: (id: string) => void) => () => void;
  onWorkspaceFocus: (cb: (id: string) => void) => () => void;
  onAgentFinished: (cb: (id: string, focused: boolean) => void) => () => void;
  /** Fires when Claude's Notification hook fires — typically the 60s idle
   * "waiting for your input" reminder. `focused` reflects the main-process
   * window focus state at hook-time. */
  onAgentNeedsInput: (cb: (id: string, focused: boolean) => void) => () => void;
}

declare global {
  interface Window {
    orchestra: OrchestraAPI;
  }
}
