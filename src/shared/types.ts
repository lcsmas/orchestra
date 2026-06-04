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
  /** True once the user has manually set the branch name. Auto-rename from
   * Claude's `.orchestra/branch-name` file is disabled when this is true. */
  branchManuallySet?: boolean;
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
   * branch's tip (e.g. `v0.1.11`). Drives the sidebar "released" pill. */
  releasedVersion?: string;
  /** Epoch ms the shipping release was published (GitHub `publishedAt`), or
   * detection time as a fallback. Presence is the "released" signal — strictly
   * stronger than `mergedAt`: merged-into-base isn't enough, a published
   * release must have actually shipped past this branch's tip. Set once and
   * never cleared (shipping is terminal), and only ever on a branch that has
   * also been merged — so a fresh branch sitting on an already-shipped base
   * commit doesn't false-fire. Recomputed lazily on the same gh-based cadence
   * as PR state, never on the hot stats poll. */
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
  agent?: 'claude' | 'codex';
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
