import type { SelfTuneReport, SelfTuneRun } from './self-tune';
import type { WorktreeSizes } from './worktree-sizes';
import type {
  Account,
  AccountUsageStatus,
  AgentEvent,
  AgentImage,
  AgentPermissionMode,
  AgentPermissionReply,
  AgentSkillInfo,
  BrowserBounds,
  BrowserPanelState,
  CreateWorkspaceInput,
  DiffStats,
  EnvStatusItem,
  LinearIssue,
  PinnedTicket,
  LinearKeyCheck,
  LinearKeySource,
  PRsForBranch,
  RepoEntry,
  RepoScripts,
  RepoSyncState,
  SandboxControlState,
  UsageSnapshot,
  Workspace,
  WorkspaceAccount,
} from './types';
import type { ResourceSnapshot } from './resources';

/** Outcome of {@link OrchestraAPI.migrateWorkspaceAccount}. */
export interface MigrateAccountResult {
  ok: boolean;
  id?: string;
  branch?: string;
  /** The account id the workspace is now pinned to, or null for default login. */
  accountId?: string | null;
  /** True when the agent was running and was auto-resumed after the move. */
  resumed?: boolean;
  error?: string;
}

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
  /** Local branches of a registered repo (sorted). Used to pick a base branch
   *  for a new workspace, or a repo's default base branch. */
  listRepoBranches: (repoPath: string) => Promise<string[]>;
  /** Set the branch new workspaces of this repo are cut from (and the branch
   *  the sidebar sync pill tracks). Rejects a branch that doesn't exist in the
   *  repo. Returns the updated repo. */
  setRepoDefaultBranch: (repoPath: string, branch: string) => Promise<RepoEntry>;
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
  /** Migrate an EXISTING workspace to a different account (or back to the default
   *  login with a null/'' accountId). Unlike {@link setRepoAccount} — which only
   *  affects NEW workspaces — this relocates the pinned workspace's conversation
   *  transcript into the target account's config dir and re-pins it, auto-stopping
   *  and (if it was running) resuming the agent so `claude --continue` still works.
   *  Rejects an unknown account id, an archived workspace, or a scratch/orchestrator
   *  session (no repo account). Resolves with the outcome. */
  migrateWorkspaceAccount: (
    id: string,
    accountId: string | null,
  ) => Promise<MigrateAccountResult>;
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
  /** Open a URL clicked in the login modal's terminal. Claude OAuth pages open
   *  in the account's isolated login browser window (own session partition, so
   *  it can't reuse the system browser's claude.ai login); other URLs open
   *  externally. */
  accountLoginOpenUrl: (accountId: string, url: string) => Promise<void>;
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
  /** Hard-delete many workspaces in one call: reaps each worktree/dir
   * sequentially, then drops all records in a single store write and emits a
   * single `onWorkspacesRemoved` batch. Progress streams via
   * `onWorkspacesDeleteProgress`. Used by the archived-section bulk delete. */
  deleteWorkspaces: (ids: string[]) => Promise<void>;
  /** One-way "import to sandbox": ship the workspace's checkout (bundle +
   * uncommitted overlay + hook dirs) to the always-on sandbox at `endpoint`,
   * retire the local worktree, and flip the record to sandbox-hosted. From
   * then on the terminal streams to the container. */
  importToSandbox: (id: string, endpoint: string) => Promise<Workspace>;
  /** Eject ("return to this machine"): restore a sandbox-hosted workspace to
   * a local worktree from a live container export — history, uncommitted
   * changes and hooks included — and flip the record back to local. */
  ejectFromSandbox: (id: string) => Promise<Workspace>;
  /** Snapshot a sandbox workspace's container state (bundle + dirty overlay)
   * into ~/.orchestra/backups/<id>/. Returns the snapshot path. Also runs
   * automatically right after import and on a periodic timer. */
  backupSandbox: (id: string) => Promise<string>;
  markSeen: (id: string) => Promise<void>;
  /** Manually tag a workspace as unread (or clear the tag). An unread
   *  workspace wears a persistent "come back to this later" indicator in the
   *  sidebar until the user selects it again or clears the tag by hand. */
  setUnread: (id: string, unread: boolean) => Promise<void>;
  /** Make a workspace a coordinator that children can nest under. A scratch
   *  session swaps `kind` to `'orchestrator'`; a git worktree keeps its kind and
   *  gains `canOrchestrate` instead, so it keeps diff/merge/PR/branch handling
   *  while also parenting children. Idempotent; rejects on an unknown id. */
  promoteWorkspace: (id: string) => Promise<Workspace>;
  /** The inverse of `promoteWorkspace`: clear the orchestrate capability and
   *  detach any children (a `parentId` pointing at a non-orchestrator renders
   *  nowhere). Only the capability is reversible — an `'orchestrator'`-KIND
   *  scratch session is repo-less by nature and rejects. Idempotent. */
  demoteWorkspace: (id: string) => Promise<Workspace>;
  /** Re-parent an existing workspace: pass an orchestrator id to nest it under
   *  that coordinator, or `null` to detach it back to its own repo section. The
   *  parent must exist and be able to orchestrate, and the edge must not create
   *  a cycle. Idempotent. */
  setWorkspaceParent: (id: string, parentId: string | null) => Promise<Workspace>;
  renameBranch: (id: string, newBranch: string) => Promise<Workspace>;
  /** Persist a new ordering of workspaces. Pass the full list of workspace
   *  ids in the desired order; any unknown id is ignored. */
  reorderWorkspaces: (orderedIds: string[]) => Promise<void>;

  // ---- Prompt queue (usage-limited accounts). Prompts parked while the
  //      workspace's account is over its usage limit; the main-process flusher
  //      auto-delivers them once the limit resets. Queue state lives on the
  //      Workspace record (`queuedPrompts`) and updates arrive via
  //      `onWorkspaceUpdate`.
  /** Park a prompt on the workspace's queue. Returns the updated workspace. */
  queuePrompt: (id: string, text: string) => Promise<Workspace>;
  /** Drop one queued prompt by its entry id. */
  removeQueuedPrompt: (id: string, promptId: string) => Promise<Workspace>;
  /** Deliver the whole queue to the agent NOW, skipping the limit check. */
  flushQueuedPrompts: (id: string) => Promise<{ ok: boolean; delivered: number; error?: string }>;

  // Terminal (pty)
  ptyStart: (id: string, cols: number, rows: number) => Promise<void>;
  ptyWrite: (id: string, data: string) => Promise<void>;
  ptyResize: (id: string, cols: number, rows: number) => Promise<void>;
  /** Force the child TUI to fully repaint via a SIGWINCH bounce (cols−1, then
   * back to the given dims). Heals a terminal whose xterm state diverged from
   * the child's diff-render model — the scattered-words garble that per-cell
   * diff painting can never repair on its own. No-op if the PTY isn't running
   * or another resize lands inside the bounce window. */
  ptyRepaint: (id: string, cols: number, rows: number) => Promise<void>;
  /** Spill clipboard image bytes (read in the renderer) to a temp file and
   * return its absolute path, for injection into the agent prompt — which
   * Claude Code auto-attaches. `mime` picks the file extension. Returns null
   * for empty input. */
  saveClipboardImage: (mime: string, bytes: Uint8Array) => Promise<string | null>;
  /** Restart the agent process while keeping the conversation: stops the
   * current PTY and triggers a fresh spawn that runs `claude --continue`,
   * picking up MCP server / settings.json changes without losing context. */
  restartAgent: (id: string) => Promise<void>;
  /** Stop the agent process WITHOUT respawning (the Resources page's per-agent
   * stop). The conversation isn't lost: the terminal relaunches the agent with
   * `claude --continue` on the next activation or keystroke. */
  stopAgent: (id: string) => Promise<void>;

  // ---------- Structured agent view (Claude Agent SDK) ----------
  // The reverse (user → agent) path for the structured view. The forward path
  // (agent → UI) is the `onAgentEvent` subscription in the events block below.
  // The SDK session is lazily started by the first `agentSdkSend`.

  /** Send a user turn to a workspace's structured SDK session, starting the
   *  session lazily on the first call. Uses the streaming-input pattern so the
   *  subprocess stays warm across turns (docs/spikes/phase0-sdk-findings.md h). */
  agentSdkSend: (wsId: string, text: string, images?: AgentImage[]) => Promise<void>;
  /** Run a `!command` bash-mode command (composer bash mode — parity with Claude
   *  Code). Runs the command LOCALLY in the workspace's worktree (never the
   *  model), renders command+output inline as a `local-command` event, and queues
   *  the pair as context for the agent's NEXT real turn. Resolves when the command
   *  exits. Starts the session lazily so the context/echo have somewhere to live. */
  agentSdkRunBash: (wsId: string, command: string) => Promise<void>;
  /** Interrupt the in-flight turn of a workspace's SDK session. Surfaces to the
   *  UI as a `turn-end`/`error` event (the SDK iterator throws, spike d). */
  agentSdkInterrupt: (wsId: string) => Promise<void>;
  /** Resolve a parked `canUseTool` permission request with the user's decision
   *  (allow, optionally with edited input, or deny with a message). */
  agentSdkPermissionReply: (
    wsId: string,
    requestId: string,
    reply: AgentPermissionReply,
  ) => Promise<void>;
  /** Switch the live SDK session's model (undefined → the session default). */
  agentSdkSetModel: (wsId: string, model: string | undefined) => Promise<void>;
  /** Switch the live SDK session's permission mode. */
  agentSdkSetPermissionMode: (wsId: string, mode: AgentPermissionMode) => Promise<void>;
  /** Enable/disable Remote Control for the workspace's structured session
   *  (parity with Claude Code's `/remote-control`). Starts the session lazily if
   *  needed. State surfaces back on `agent:event` as a `session/remote-control`
   *  event folded into `AgentSession.remoteControl` (URL to open on another
   *  device on enable, or an error). */
  agentSdkSetRemoteControl: (wsId: string, enabled: boolean) => Promise<void>;
  /** History backfill: the workspace's persisted on-disk session transcript
   *  converted to AgentEvents (empty when there is nothing to backfill). The
   *  renderer folds these through the same queue as live events. */
  agentSdkHistory: (wsId: string) => Promise<AgentEvent[]>;
  /** Open a finished background-task's transcript file (the SDK
   *  `task_notification.output_file`) with the OS handler. Resolves `true` when
   *  opened, `false` when the path is missing/not a file. Backs the "Background
   *  tasks" panel's "View transcript" link. */
  agentSdkOpenTaskTranscript: (filePath: string) => Promise<boolean>;
  /** Skills (slash commands) available to the workspace's agent, for the
   *  composer's `/` autocomplete. */
  agentSkills: (wsId: string) => Promise<AgentSkillInfo[]>;

  // --- Embedded browser panel ---
  // A per-workspace in-window browser (an Electron WebContentsView) the user
  // drives manually AND the agent drives via its browser tools. The renderer
  // owns opening/positioning; navigation state pushes back on `onBrowserEvent`.
  /** Show the panel for `wsId` (creating the native view on first call) and
   *  return its current state. Hides any other workspace's panel. */
  browserShow: (wsId: string) => Promise<BrowserPanelState>;
  /** Hide the panel (stops compositing) without destroying its page/history. */
  browserHide: (wsId: string) => Promise<void>;
  /** Navigate the panel to a URL / bare domain (opens it if needed). */
  browserNavigate: (wsId: string, url: string) => Promise<BrowserPanelState>;
  browserBack: (wsId: string) => Promise<void>;
  browserForward: (wsId: string) => Promise<void>;
  browserReload: (wsId: string) => Promise<void>;
  /** Position/size the native view over the renderer's `.browser-pane` rect. */
  browserSetBounds: (wsId: string, bounds: BrowserBounds) => Promise<void>;
  /** Current navigation state (a freshly-mounted panel re-requests this). */
  browserState: (wsId: string) => Promise<BrowserPanelState>;

  nvimStart: (id: string, cols: number, rows: number) => Promise<void>;
  onPtyData: (cb: (id: string, data: string) => void) => () => void;
  onPtyExit: (cb: (id: string, code: number) => void) => () => void;
  onPtyRestart: (cb: (id: string) => void) => () => void;
  /** Fires after `stopAgent` killed a workspace's agent PTY — no respawn
   * follows (unlike onPtyRestart). */
  onPtyStopped: (cb: (id: string) => void) => () => void;

  // Sandbox cross-machine ownership (one driver, other machines read-only).
  /** Latest ownership state for a sandbox-hosted workspace's endpoint, or null
   * for local workspaces / before the shim's first broadcast. */
  sandboxControlState: (id: string) => Promise<SandboxControlState | null>;
  /** Ask the sandbox to make THIS machine the driver for the workspace's
   * endpoint (explicit take-over; the previous driver drops to read-only). */
  takeSandboxControl: (id: string) => Promise<void>;
  /** Ownership broadcasts, pushed on attach and every change. Keyed by
   * endpoint — one sandbox's state covers every workspace it hosts. */
  onSandboxControl: (cb: (state: SandboxControlState) => void) => () => void;

  // Git / Diff
  getDiffStats: (id: string) => Promise<DiffStats>;
  /** On-disk size (bytes) of every workspace's worktree, keyed by workspace
   *  id; absent ids have no worktree. One `btrfs filesystem du` pass reporting
   *  exclusive (reclaimable) bytes where available, else one apparent-size
   *  `du` pass — `exclusive` says which the numbers are. */
  getWorktreeSizes: () => Promise<WorktreeSizes>;
  /** One live sample of Orchestra's local footprint: CPU/memory per PTY
   *  session's process tree, Electron's own processes, and a cached `du` pass
   *  over the data dirs. The Resources page polls this every ~2s while open;
   *  there is no push channel — sampling only happens on demand. */
  sampleResources: () => Promise<ResourceSnapshot>;
  findPR: (id: string) => Promise<PRsForBranch>;
  /** Verify the branch's candidate Linear key against Linear's GraphQL API.
   *  Resolves the real issue, or null if the branch encodes no issue, the issue
   *  doesn't exist, or there's no/invalid LINEAR_API_KEY. */
  verifyLinear: (id: string) => Promise<LinearIssue | null>;
  /** Pinned Linear tickets — the sidebar's Tickets section. */
  listTickets: () => Promise<PinnedTicket[]>;
  /** Re-fetch every pinned ticket from Linear in ONE batched request and
   *  return the refreshed list. Throws if Linear is unreachable / unauthorized,
   *  so the caller can distinguish that from "nothing pinned". */
  refreshTickets: () => Promise<PinnedTicket[]>;
  /** Un-pin a ticket by identifier. Never modifies the issue in Linear. */
  removeTicket: (identifier: string) => Promise<void>;
  /** Create a worktree + agent for a pinned ticket and graduate it out of the
   *  Tickets section. `repoPath` must be a registered repo. */
  spawnFromTicket: (identifier: string, repoPath: string) => Promise<{ workspaceId: string }>;
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

  // ---- Insights & Improvements (monthly self-tune). Pipeline runs in main
  //      (src/main/self-tune.ts); the renderer sees run records, streamed
  //      transcript chunks, and report paths — never spawns anything itself.
  /** Self-tune run history, newest first (the in-flight run included). */
  listSelfTuneRuns: () => Promise<SelfTuneRun[]>;
  /** Start a manual run NOW. Resolves with the new run record as soon as the
   *  pipeline starts; rejects if a run is already in flight. */
  startSelfTune: () => Promise<SelfTuneRun>;
  /** The buffered transcript of a run (live buffer, or the mirrored file for
   *  runs from a previous session). */
  getSelfTuneOutput: (runId: string) => Promise<string>;
  /** Newest insights report per login, for the "open report" buttons. */
  listSelfTuneReports: () => Promise<SelfTuneReport[]>;
  /** Open a login's newest report HTML in the default browser. Resolves false
   *  when that login has no report yet. */
  openSelfTuneReport: (loginId: string) => Promise<boolean>;
  /** Current ~/.claude/LESSONS.md content for the read-only view ('' if absent). */
  readSelfTuneLessons: () => Promise<string>;
  /** Fires on every run/step state transition with the full updated run. */
  onSelfTuneUpdate: (cb: (run: SelfTuneRun) => void) => () => void;
  /** Live transcript chunks of the in-flight run. */
  onSelfTuneOutput: (cb: (runId: string, chunk: string) => void) => () => void;

  // Events
  /** Pushed whenever the pinned-ticket list changes (pin/un-pin/refresh/graduate). */
  onTicketsUpdate: (cb: (tickets: PinnedTicket[]) => void) => () => void;

  onWorkspaceUpdate: (cb: (w: Workspace) => void) => () => void;
  onWorkspaceRemoved: (cb: (id: string) => void) => () => void;
  /** Batched removal: fires once with all ids from a `deleteWorkspaces` call so
   * the renderer prunes them in a single store update instead of one per id. */
  onWorkspacesRemoved: (cb: (ids: string[]) => void) => () => void;
  /** Progress ticks during a `deleteWorkspaces` run, so the UI can advance its
   * "Deleting N of M" bar as each worktree is reaped. */
  onWorkspacesDeleteProgress: (cb: (done: number, total: number) => void) => () => void;
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
  /** The structured-agent-view event stream: fires once per normalized
   *  {@link AgentEvent} the SDK session produces, keyed to the workspace. The
   *  renderer folds these into an AgentSession (src/shared/agent-events.ts).
   *  This is the hottest event channel (token deltas) — subscribers MUST batch
   *  (RAF-coalesce) rather than setState per event. */
  onAgentEvent: (cb: (wsId: string, event: AgentEvent) => void) => () => void;
  /** Fires whenever a workspace's embedded browser panel navigates (manually or
   *  agent-driven): URL, title, loading, and back/forward availability. Drives
   *  the panel's URL bar / tab / nav buttons. Keyed by workspace id. */
  onBrowserEvent: (cb: (wsId: string, state: BrowserPanelState) => void) => () => void;
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
