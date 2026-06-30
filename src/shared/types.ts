export type WorkspaceStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

export interface Workspace {
  id: string;
  name: string;
  /** Workspace kind. `'worktree'` (the default, and what every pre-existing
   * record is treated as when this field is absent) is a git worktree cut from
   * a repo's base branch — it has a branch, a diff against base, and can merge /
   * open PRs. `'scratch'` is a throwaway, non-git working directory under
   * `~/.orchestra/scratch`: Claude Code runs in it exactly the same way, but
   * there is no repo, branch, diff, merge, or PR. For a scratch workspace
   * `repoPath` and `baseBranch` are empty strings and `branch` is just a display
   * label.
   *
   * `'orchestrator'` is a scratch session with a purpose: it is non-git in
   * exactly the same way (empty `repoPath`/`baseBranch`, label-only `branch`,
   * lives under `~/.orchestra/scratch`), but its agent is seeded with an
   * opening brief telling it to delegate work by spawning child workspaces over
   * the `/spawn` socket. Children it spawns carry its id as their `parentId`
   * and nest beneath it in the sidebar's "Orchestrators" section. Treat
   * `'orchestrator'` exactly like `'scratch'` for every git/diff/merge/delete
   * decision — use the `isScratchLike` helper rather than `=== 'scratch'`. */
  kind?: 'worktree' | 'scratch' | 'orchestrator';
  /** Workspace id of the orchestrator this workspace nests under. Set at creation
   * by `/spawn` (the spawning orchestrator's `ORCHESTRA_WS_ID`), and afterwards
   * mutable via the `/attach` socket route, which re-parents an existing
   * workspace under an orchestrator (or clears this to detach it). The parent is
   * always an orchestrator. Drives the sidebar's orchestrator→children tree: a
   * workspace with
   * a `parentId` renders indented under its parent regardless of which repo it
   * lives in. Absent for workspaces created by hand from the UI, and on every
   * record predating this field. A dangling `parentId` (parent deleted) is
   * treated as no parent — the child falls back to its own repo section. */
  parentId?: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  createdAt: number;
  status: WorkspaceStatus;
  agent: 'claude';
  lastTask?: string;
  archived?: boolean;
  archivedAt?: number;
  hasInput?: boolean;
  /** Set at spawn when `claude --continue` is about to resume a session whose
   * most-recent transcript exceeds {@link HEAVY_RESUME_TOKEN_THRESHOLD} tokens.
   * Claude Code shows an interactive "resume from summary / full / don't ask"
   * menu for such sessions, but typing a normal task proceeds the FULL resume
   * (loading the whole huge context, draining the usage pool). While this is
   * true the `pty:write` handler suppresses submit keystrokes (Enter/newline)
   * so a typed task can't blow past CC's menu; the flag clears the instant the
   * user sends a navigation key (arrow/Esc) — i.e. they're consciously driving
   * CC's own menu — or after a safety timeout. Purely a guard around CC's
   * native gate; Orchestra never auto-answers the menu. */
  heavyResumePending?: boolean;
  /** True once the user has manually set the branch name. Auto-rename from
   * Claude's `.orchestra/branch-name` file is disabled when this is true. */
  branchManuallySet?: boolean;
  /** Id of the {@link Account} this workspace's agent logs in as, snapshotted
   * from its repo's `accountId` at creation. Pinned for the workspace's life:
   * Claude Code stores conversation history inside the account's
   * `CLAUDE_CONFIG_DIR`, so a workspace must keep using the account it started
   * under or `claude --continue` would find no session ("No conversation found
   * to continue"). Changing the repo's account therefore only affects NEW
   * workspaces. Absent on scratch/orchestrator sessions and on records created
   * before this field — those fall back to the repo's current account (or the
   * default login). */
  accountId?: string;
  /** Timestamp of the most recent merge of this branch into its base branch.
   * Updated on each successful merge cycle (a branch can be merged, diverge
   * again as work continues, and be merged again — `mergedAt` always holds
   * the latest stamp). Use together with `divergedFromBase` for the visual
   * "currently in sync since last merge" signal. */
  mergedAt?: number;
  /** True when the branch has commits not yet on the base branch — i.e.
   * unshipped work. Recomputed by the activity tracker after every agent
   * turn (Stop hook). When false AND `mergedAt` is set, the branch is
   * currently in sync with base after at least one merge → render the
   * "merged" pill. */
  divergedFromBase?: boolean;
  /** Count of local commits not yet on `origin/<branch>` (or, if the branch
   * has never been pushed, count of local commits ahead of `baseBranch`).
   * Drives the "↑N" badge in the sidebar so the user can see committed-but-
   * not-pushed work without leaving the workspace tab. Recomputed alongside
   * `divergedFromBase` on every Stop hook. */
  unpushedAhead?: number;
  /** Tag of the first published GitHub Release whose build contains this
   * branch's tip (e.g. `v0.1.11`). Drives the sidebar "released" pill. Tracks
   * the current tip: if the same workspace ships again with new commits, this
   * is recomputed to the release that first contains the newer tip. */
  releasedVersion?: string;
  /** All published-release tags whose build contains this branch's tip,
   * oldest-first (e.g. `['v0.2.0','v0.2.1','v0.2.2']`). The sidebar renders one
   * "released" pill per entry; `releasedVersion` remains the first/earliest of
   * these (the "shipped when" signal). Recomputed on the same cadence as
   * `releasedVersion`, and additionally whenever a newer release that also
   * contains the tip appears, so a workspace accrues badges as later versions
   * ship. Absent on pre-upgrade records → the UI falls back to the single
   * `releasedVersion` pill. */
  releasedVersions?: string[];
  /** Epoch ms the shipping release was published (GitHub `publishedAt`), or
   * detection time as a fallback. Presence is the "released" signal — strictly
   * stronger than `mergedAt`: merged-into-base isn't enough, a published
   * release must have actually shipped past this branch's tip. Never cleared
   * back to unset (a branch that shipped stays shipped), but the version it
   * points at is refreshed when the tip advances past the recorded release.
   * Only ever set on a branch that has also been merged — so a fresh branch
   * sitting on an already-shipped base commit doesn't false-fire. Recomputed
   * lazily on the same gh-based cadence as PR state, never on the hot stats
   * poll, and only pays for a gh call once the cheap local ancestry check sees
   * the recorded version no longer contains the tip. */
  releasedAt?: number;
  /** Auto-allocated dev-server port handed to setup/run scripts as
   * `$ORCHESTRA_PORT`. Lets multiple workspaces run dev servers in parallel
   * without colliding. Allocated at creation, freed on hard delete. */
  port?: number;
  /** Outcome of the most recent setup-script run. `pending` between creation
   * and the first run, `running` while bash is alive, `ok`/`failed` at exit.
   * Drives the sidebar setup-failed indicator and the retry button. Absent
   * on workspaces created before scripts existed (legacy = treated as `ok`). */
  setupStatus?: 'pending' | 'running' | 'ok' | 'failed';
  /** Last line of stderr (or the spawn error) when `setupStatus === 'failed'`.
   * Full output lives in `~/.orchestra/scripts/<id>-setup.log`. */
  setupError?: string;
  /** The agent session's context-window size in tokens at the end of its most
   * recent turn — the figure the TUI `/context` view shows as "used" (sum of the
   * three input components on the last main-chain assistant message). Persisted
   * ONLY at turn-end (`stop`/`notify`), piggybacking the store write that the
   * status→`waiting` transition already performs, so it adds no extra write and
   * avoids the per-posttool churn that keeps the live figure on the ephemeral
   * `agent:context` IPC channel instead. Used solely to seed the sidebar badge at
   * startup before any live event has fired; the live channel overwrites it the
   * moment the agent next runs in Orchestra. Absent until the first turn ends. */
  contextTokens?: number;
}

/** True for the non-git workspace kinds — `'scratch'` and `'orchestrator'`.
 * Both live under `~/.orchestra/scratch`, have no repo/branch/diff/merge/PR, and
 * are torn down by plain directory removal. Use this everywhere a code path
 * needs "is this a real git worktree?" instead of comparing `kind` to a single
 * literal, so a new non-git kind stays correctly handled in one place. */
export function isScratchLike(ws: Pick<Workspace, 'kind'>): boolean {
  return ws.kind === 'scratch' || ws.kind === 'orchestrator';
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
  baseBranch?: string;
  task?: string;
  agent?: 'claude';
  /** Orchestrator workspace id to record as this workspace's `parentId` (set
   * by `/spawn` from the caller's `ORCHESTRA_WS_ID`). Omitted for hand-created
   * workspaces. */
  parentId?: string;
}

export interface RepoScripts {
  /** One-shot script run after `git worktree add` and Orchestra's hook
   * install, with `$ORCHESTRA_*` env vars. Typical content: `pnpm install`,
   * `ln -sf $ORCHESTRA_ROOT_PATH/.env .env`. Failure does NOT block workspace
   * creation — the worktree stays put and the user can retry from the UI. */
  setup?: string;
  /** Long-lived script bound to a workspace's "Run" button. Typically a dev
   * server invoked with `--port $ORCHESTRA_PORT` so multiple workspaces can
   * run concurrently. Spawned in a separate PTY (`<wsId>:run`). */
  run?: string;
  /** Best-effort one-shot run before `git worktree remove` on hard delete.
   * Use to drop per-workspace external resources (DBs, caches). */
  archive?: string;
}

export interface RepoEntry {
  path: string;
  name: string;
  defaultBranch: string;
  scripts?: RepoScripts;
  /** Id of the {@link Account} this repo's workspaces log in as. Orchestra
   * injects that account's `CLAUDE_CONFIG_DIR` into the spawned `claude` PTY so
   * it authenticates as that account (Claude Code manages/refreshes the token
   * in that dir). Absent / dangling → the agent uses Orchestra's default login. */
  accountId?: string;
  /** Canonical web URL for the repo's `origin` remote (e.g.
   * `https://github.com/owner/repo`), normalized from whatever the remote
   * is set to (ssh, https, scp-style git@…). Undefined if no `origin` is
   * configured or the URL cannot be parsed. */
  remoteUrl?: string;
}

interface PRInfo {
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

/** A Linear issue confirmed to exist, resolved by querying Linear for the
 *  candidate key parsed from a branch name. The renderer only ever renders a
 *  Linear badge from one of these — a branch whose candidate key doesn't
 *  resolve to a real issue yields `null` and shows nothing. */
export interface LinearIssue {
  /** Canonical issue identifier as Linear returns it, e.g. `NMC-261`. */
  identifier: string;
  /** Canonical Linear URL for the issue (authoritative — not string-built). */
  url: string;
  /** Issue title, for the badge tooltip. */
  title: string;
}

/** One optional-setup check surfaced to the user — e.g. "Linear badges need an
 *  API key". The sidebar shows a small notice for any item whose `ok` is false.
 *  Kept generic so future checks (other integrations, missing tools) can be
 *  added to {@link import('../main/env-status').getEnvStatus} without touching
 *  the renderer. */
export interface EnvStatusItem {
  /** Stable id, also used as the per-item dismissal key in the renderer. */
  id: string;
  /** Short human label, e.g. `Linear`. */
  label: string;
  /** Whether the feature is configured and usable. */
  ok: boolean;
  /** One-line explanation shown when `ok` is false (what's missing + how to
   *  fix). Empty when `ok`. */
  detail: string;
  /** Optional docs/help URL opened from the notice. */
  docsUrl?: string;
}

/** Where the active Linear API key comes from: a key saved in Orchestra,
 *  the LINEAR_API_KEY env var, or none configured. */
export type LinearKeySource = 'stored' | 'env' | 'none';

/** Result of testing a candidate Linear API key against the API. */
export interface LinearKeyCheck {
  ok: boolean;
  /** Authenticated user's display name when ok. */
  name?: string;
  /** Human-readable reason when not ok. */
  error?: string;
}

/** Sync status of a repo's base branch (e.g. `develop`/`main`) against its
 *  `origin/<base>` remote-tracking ref. Produced by the main process on app
 *  focus and after manual sync, broadcast to the renderer for display in
 *  the sidebar repo-group row. */
export interface RepoSyncState {
  repoPath: string;
  baseBranch: string;
  /** Commits on `origin/<base>` that are missing from local `<base>`. */
  behind: number;
  /** Commits on local `<base>` that are missing from `origin/<base>` — rare
   *  for the base branch but possible if someone committed locally. */
  ahead: number;
  /** True once we've successfully fetched `origin/<base>` at least once.
   *  False means no upstream tracking ref exists or the fetch failed. */
  hasUpstream: boolean;
  /** Epoch ms of the last successful fetch. 0 before any fetch. */
  syncedAt: number;
  /** True while a fetch is in flight. */
  syncing: boolean;
  /** Last fetch error, if any. Cleared on next successful fetch. */
  error?: string;
}

/** A single rolling Claude usage limit window (the 5-hour session window or
 *  the 7-day weekly window). Mirrors the `five_hour` / `seven_day` objects
 *  returned by Anthropic's `/api/oauth/usage` endpoint, which is what Claude
 *  Code's own `/usage` view reads. */
export interface UsageWindow {
  /** Percent of the window's quota consumed, 0–100. */
  utilization: number;
  /** ISO-8601 timestamp at which this window's quota resets. */
  resetsAt: string;
}

/** Snapshot of the signed-in Claude account's rolling usage limits. Fetched by
 *  the main process from Anthropic's OAuth usage endpoint and broadcast to the
 *  renderer for the sidebar progress bars. */
export interface UsageSnapshot {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
}

// Re-export the account-usage types so the renderer and IPC can import them
// from the usual `shared/types` barrel alongside everything else. The shapes
// themselves live in `shared/accounts.ts` next to their pure logic so that
// module stays self-contained and unit-testable without electron.
export type {
  Account,
  AccountInherit,
  AccountUsageStatus,
  UsageData,
  UsageWindowDetail,
  UsageErrorKind,
} from './accounts';

/** A workspace's resolved account mapping, computed in the main process from
 *  its repo's assigned `accountId`. Carries only the account *identity* — never
 *  a token or path — so the renderer can show which account a workspace uses
 *  and look up that account's usage. `accountId` is the repo's account, or null
 *  when the workspace falls back to the default/stored login (repo has no
 *  account, the account was deleted, or it's a scratch/orchestrator session). */
export interface WorkspaceAccount {
  workspaceId: string;
  accountId: string | null;
  /** Label to show on the badge: the matched account's label, or a short
   *  fallback like 'default login' when `accountId` is null. */
  label: string;
}
