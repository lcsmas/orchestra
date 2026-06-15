import type {
  CreateWorkspaceInput,
  DiffFile,
  DiffStats,
  PRsForBranch,
  RepoEntry,
  RepoScripts,
  RepoSyncState,
  Workspace,
} from './types';

export interface OrchestraAPI {
  // Repos
  addRepo: (absPath: string) => Promise<RepoEntry>;
  listRepos: () => Promise<RepoEntry[]>;
  /** Snapshot of every known repo's base-branch sync state. Empty before
   *  the first sync completes; afterwards live updates flow via
   *  `onRepoSyncState`. */
  listRepoSyncStates: () => Promise<RepoSyncState[]>;
  /** Manually trigger a fetch + ff for one repo's base branch. */
  syncRepoBase: (repoPath: string) => Promise<void>;
  /** Persist a new ordering of registered repos. Pass the full list of repo
   *  paths in the desired order; any unknown path is ignored. */
  reorderRepos: (orderedPaths: string[]) => Promise<void>;
  pickDirectory: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;

  // Diagnostic logs
  /** Reveal the main diagnostic log file in the OS file manager. */
  revealLogs: () => Promise<void>;
  /** Absolute path to the active diagnostic log file. */
  logPath: () => Promise<string>;
  /** Forward a renderer-side log line into the shared diagnostic log file. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown) => Promise<void>;

  // Workspaces
  listWorkspaces: () => Promise<Workspace[]>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
  archiveWorkspace: (id: string) => Promise<void>;
  unarchiveWorkspace: (id: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  markSeen: (id: string) => Promise<void>;
  renameBranch: (id: string, newBranch: string) => Promise<Workspace>;
  /** Persist a new ordering of workspaces. Pass the full list of workspace
   *  ids in the desired order; any unknown id is ignored. */
  reorderWorkspaces: (orderedIds: string[]) => Promise<void>;

  // Terminal (pty)
  ptyStart: (id: string, cols: number, rows: number) => Promise<void>;
  ptyWrite: (id: string, data: string) => Promise<void>;
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>;
  /** Restart the agent process while keeping the conversation: stops the
   * current PTY and triggers a fresh spawn that runs `claude --continue`,
   * picking up MCP server / settings.json changes without losing context. */
  restartAgent: (id: string) => Promise<void>;
  nvimStart: (id: string, cols: number, rows: number) => Promise<void>;
  onPtyData: (cb: (id: string, data: string) => void) => () => void;
  onPtyExit: (cb: (id: string, code: number) => void) => () => void;
  onPtyRestart: (cb: (id: string) => void) => () => void;

  // Git / Diff
  getDiff: (id: string) => Promise<DiffFile[]>;
  getDiffStats: (id: string) => Promise<DiffStats>;
  /** Apparent on-disk size (bytes) of every workspace's worktree, keyed by
   *  workspace id. Computed in one `du` pass; absent ids have no worktree. */
  getWorktreeSizes: () => Promise<Record<string, number>>;
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
  /** Ephemeral per-tool activity. Fires with the tool name on Claude's
   *  PreToolUse hook (the agent is about to run Bash/Edit/…) and with `null`
   *  on PostToolUse / turn end. Not persisted — purely a live UI label. */
  onAgentTool: (cb: (id: string, tool: string | null) => void) => () => void;
  /** Fires whenever a repo's base-branch sync state changes (started a
   *  fetch, finished a fetch, ahead/behind count moved). One event per
   *  state transition, keyed by repoPath. */
  onRepoSyncState: (cb: (s: RepoSyncState) => void) => () => void;
}

declare global {
  interface Window {
    orchestra: OrchestraAPI;
  }
}
