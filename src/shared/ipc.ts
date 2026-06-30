import type {
  Account,
  AccountUsageStatus,
  CreateWorkspaceInput,
  DiffFile,
  DiffStats,
  EnvStatusItem,
  LinearIssue,
  LinearKeyCheck,
  LinearKeySource,
  PRsForBranch,
  RepoEntry,
  RepoScripts,
  RepoSyncState,
  UsageSnapshot,
  Workspace,
  WorkspaceAccount,
} from './types';

export interface OrchestraAPI {
  // Repos
  addRepo: (absPath: string) => Promise<RepoEntry>;
  /** Un-register a repo from Orchestra. Rejects if the repo still has any
   *  workspaces (active or archived) — those must be deleted first. */
  removeRepo: (absPath: string) => Promise<void>;
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
  /** The running app's version (from package.json). */
  getAppVersion: () => Promise<string>;

  /** Optional-setup status (e.g. is a Linear API key configured?). Drives the
   *  sidebar's "needs setup" notice. */
  getEnvStatus: () => Promise<EnvStatusItem[]>;

  /** Where the active Linear API key comes from ('stored' | 'env' | 'none'). */
  getLinearKeySource: () => Promise<LinearKeySource>;
  /** Test a candidate Linear API key against the API without saving it. */
  checkLinearKey: (key: string) => Promise<LinearKeyCheck>;
  /** Persist a Linear API key (encrypted at rest). Empty clears it. */
  saveLinearKey: (key: string) => Promise<void>;
  /** Remove the stored Linear API key. */
  clearLinearKey: () => Promise<void>;

  /** Last fetched snapshot of the signed-in Claude account's rolling 5h/7d
   *  usage windows, or null before the first successful poll (or if not signed
   *  in via OAuth). Live updates flow via `onUsageUpdate`. */
  getUsage: () => Promise<UsageSnapshot | null>;

  // ---- Accounts. Each account is a Claude Code config dir (CLAUDE_CONFIG_DIR)
  //      with its own login. store.json holds only {id, label, configDir} —
  //      never a token. The renderer receives labels, ids, config-dir paths,
  //      and usage numbers; never a token.
  /** The configured accounts (label + config-dir path). */
  listAccounts: () => Promise<Account[]>;
  /** Replace the whole accounts list (add/edit/remove in one save). Returns the
   *  cleaned, persisted list. Also clears any repo's accountId that pointed at a
   *  now-removed account. */
  setAccounts: (accounts: Account[]) => Promise<Account[]>;
  /** Assign (or clear, with null/'') the account a repo's workspaces log in as.
   *  Rejects an unknown account id. Returns the updated repo. */
  setRepoAccount: (repoPath: string, accountId: string | null) => Promise<RepoEntry>;
  /** Current usage status for one account by id (cached >=180s in main). */
  getAccountUsage: (accountId: string) => Promise<AccountUsageStatus | null>;
  /** Usage status for every configured account, keyed by account id. */
  getAllAccountUsage: () => Promise<Record<string, AccountUsageStatus>>;
  /** The account each non-archived workspace logs in as (identity only),
   *  derived from each workspace's repo `accountId`. Keyed by workspace id. */
  getWorkspaceAccounts: () => Promise<Record<string, WorkspaceAccount>>;
  /** Start an interactive `claude /login` in an account's config dir, under the
   *  pty id `account-login:<accountId>`. Drive it with ptyWrite/ptyResize and
   *  read it via onPtyData/onPtyExit (all keyed by that pty id). */
  accountLoginStart: (accountId: string, cols: number, rows: number) => Promise<void>;
  /** Stop an account's login PTY (e.g. the modal was closed). */
  accountLoginStop: (accountId: string) => Promise<void>;
  /** Recompute the workspace→account map and refetch usage now (called after a
   *  login PTY exits so the badge updates immediately). */
  refreshAccounts: () => Promise<void>;
  /** What the global `~/.claude` currently offers to inherit per account: skill
   *  dir names and MCP server keys. Drives the inheritance checkboxes in the UI. */
  listGlobalInheritables: () => Promise<{ skills: string[]; mcpServers: string[] }>;
  /** Fires when the login watcher detects a fresh OAuth token for the given
   *  account — the PTY is already dead at this point. */
  onAccountLoginDone: (cb: (accountId: string) => void) => () => void;

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
  /** Create a scratch session: a throwaway, non-git working directory under
   * `~/.orchestra/scratch` with Claude Code ready to run. No repo, branch,
   * diff, merge, or PR — for starting something without wiring up a repo. */
  createScratchWorkspace: () => Promise<Workspace>;
  /** Create an orchestrator session: like a scratch session (throwaway, non-git,
   * under `~/.orchestra/scratch`), but its agent launches with a brief to
   * delegate work by spawning child workspaces. Those children nest under it in
   * the sidebar's "Orchestrators" section. */
  createOrchestratorWorkspace: () => Promise<Workspace>;
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
  /** Spill clipboard image bytes (read in the renderer) to a temp file and
   * return its absolute path, for injection into the agent prompt — which
   * Claude Code auto-attaches. `mime` picks the file extension. Returns null
   * for empty input. */
  saveClipboardImage: (mime: string, bytes: Uint8Array) => Promise<string | null>;
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
  /** Verify the branch's candidate Linear key against Linear's GraphQL API.
   *  Resolves the real issue, or null if the branch encodes no issue, the issue
   *  doesn't exist, or there's no/invalid LINEAR_API_KEY. */
  verifyLinear: (id: string) => Promise<LinearIssue | null>;
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
  runScriptStatus: (id: string) => Promise<boolean>;

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
  /** Ephemeral context-window size, in tokens, of the agent's session. Fires
   *  after each tool and at turn end, derived from the session transcript's
   *  latest main-chain assistant usage (the `/context` "used" figure). Not
   *  persisted — purely a live UI label. */
  onAgentContext: (cb: (id: string, tokens: number) => void) => () => void;
  /** Fires whenever a repo's base-branch sync state changes (started a
   *  fetch, finished a fetch, ahead/behind count moved). One event per
   *  state transition, keyed by repoPath. */
  onRepoSyncState: (cb: (s: RepoSyncState) => void) => () => void;
  /** Fires whenever the main process fetches a fresh usage snapshot (~every
   *  60s). Carries the latest 5h/7d utilization and reset times. */
  onUsageUpdate: (cb: (snap: UsageSnapshot) => void) => () => void;
  /** Fires whenever the main process refreshes any account's usage (driven by
   *  the >=180s-cached poller). Carries the full per-account status map so the
   *  renderer can replace its account-usage state wholesale. */
  onAccountUsageUpdate: (cb: (byId: Record<string, AccountUsageStatus>) => void) => () => void;
  /** Fires when the workspace→account mapping changes (accounts edited, a repo
   *  env changed, or workspaces added/removed). Carries the full map. */
  onWorkspaceAccountsUpdate: (cb: (byId: Record<string, WorkspaceAccount>) => void) => () => void;
  /** Fires whenever the set of registered repos changes — e.g. a repo added
   *  over the unix socket by the CLI or a peer agent. Carries the full,
   *  refreshed repo list so the renderer can replace its state wholesale. */
  onReposUpdate: (cb: (repos: RepoEntry[]) => void) => () => void;
}

declare global {
  interface Window {
    orchestra: OrchestraAPI;
  }
}
