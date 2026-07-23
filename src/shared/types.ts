export type WorkspaceStatus = 'idle' | 'running' | 'waiting' | 'error' | 'stopped';

/** Where a workspace's agent actually runs. Absent (the default, and what every
 * pre-existing record is treated as) means `{ kind: 'local' }`: the agent, its
 * worktree, and its Claude session live on this machine, driven by the local
 * node-pty transport. `{ kind: 'sandbox' }` means the agent runs in an always-on
 * sandbox reached over the wire (the multi-machine path) — Orchestra is a thin
 * client streaming the terminal via the RemoteTransport. `endpoint` is the
 * WebSocket URL of that sandbox's shim (e.g. `ws://host:8787`); the outer
 * transport detail (Tailscale, direct TLS) is baked into the URL and invisible
 * above it. */
export type WorkspaceHost =
  | { kind: 'local' }
  | { kind: 'sandbox'; endpoint: string };

/** The fixed path a sandbox mounts the worktree at — the agent image's WORKDIR.
 * Claude Code keys its session/history by the absolute cwd, so this MUST be
 * stable across runs for `claude --continue` to resume the prior session, and it
 * must match the container's `/workspace` convention (sandbox/Dockerfile). */
export const SANDBOX_WORKSPACE_DIR = '/workspace';

/** Cross-machine ownership state for one sandbox endpoint, as last broadcast
 * by its shim: several machines may be attached, exactly one — the driver —
 * may type. `isDriver` is from THIS machine's perspective; the renderer shows
 * a read-only bar (with take-over) on sandbox terminals when it is false. */
export interface SandboxControlState {
  endpoint: string;
  driverId: string | null;
  driverName: string | null;
  isDriver: boolean;
}

/** One prompt parked while a workspace's account is over its usage limit,
 * waiting for the window to reset. See {@link Workspace.queuedPrompts}. */
export interface QueuedPrompt {
  /** Random id so the UI can remove one entry without index races. */
  id: string;
  /** The prompt text, verbatim (newlines allowed; carriage returns are
   * stripped at delivery so the TUI doesn't submit early). */
  text: string;
  /** Epoch ms when the prompt was queued. Auto-flush requires a usage snapshot
   * FETCHED AFTER this instant that shows the account un-limited — so a stale
   * pre-limit snapshot can't flush a prompt straight into the wall. */
  queuedAt: number;
}

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
  /** Orchestrator CAPABILITY on a workspace that is not the `'orchestrator'`
   * KIND — i.e. a real git worktree that also coordinates children. Set by
   * `/promote` on a worktree and cleared by `/demote`.
   *
   * This exists because "orchestrator" is two separable things: a *tree role*
   * (children may nest under me) and a *non-git nature* (no repo/branch/diff).
   * The `'orchestrator'` kind fuses both, which is right for a repo-less
   * coordinator but wrong for an integration branch that coordinates agents
   * while carrying real commits. Flipping such a worktree's `kind` would strip
   * its git identity everywhere — `isScratchLike` gates delete (the git
   * worktree would leak, `workspaces.ts` `teardownWorkspace`), rename (`git
   * branch -m` skipped, so the real branch desyncs from the label), and the
   * whole diff/run/PR/merge/branch-picker UI on both frontends. So the
   * capability is additive and orthogonal: `kind` stays `'worktree'` and every
   * git path keeps working.
   *
   * Never read this directly to answer "can children nest under this?" — use
   * {@link canOrchestrate}, which also covers the `'orchestrator'` kind. */
  canOrchestrate?: boolean;
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
  /** Where the agent runs — local machine (default when absent) or a sandbox
   * reached over the wire. See {@link WorkspaceHost}. The local node-pty path is
   * the default for every existing workspace; only an explicitly sandbox-hosted
   * workspace uses the RemoteTransport. */
  host?: WorkspaceHost;
  /** Model this workspace's agent runs on (a Claude Code model arg: an alias
   * like `haiku`/`sonnet`/`opus` or a full model id). Set at creation by
   * `/spawn`'s `model` param (`orchestra spawn --model`); absent = the login's
   * default model, the behaviour of every pre-existing workspace. The pty path
   * passes it as `claude --model` on every launch (fresh AND resume, so the
   * pin survives restarts); the SDK structured-session path must equally init
   * its `query()` `options.model` from this field. The economics lever: worker
   * agents consume most of a swarm's tokens, so orchestrators plan on a strong
   * model and spawn leaves on a cheaper one. */
  model?: string;
  /** Structured-view permission mode chosen for this workspace's SDK session.
   *  Persisted so the Permissions dropdown sticks and the mode applies even when
   *  picked BEFORE the first message starts the session (the session reads it in
   *  ensureSession). Defaults to 'bypassPermissions' when unset — Orchestra runs
   *  autonomous agents in isolated worktrees, matching the terminal path which
   *  runs claude with full permissions (see agent-sdk.ts ensureSession). */
  sdkPermissionMode?: AgentPermissionMode;
  /** Last Claude Agent SDK session id for this workspace's structured session.
   *  Captured from the SDK stream and persisted so re-opening the structured view
   *  RESUMES the prior conversation (query({ resume }) — the agent keeps its
   *  memory) instead of starting a blank session. */
  sdkSessionId?: string;
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
  /** True while the user has manually tagged this workspace "unread" — a
   * come-back-to-this-later bookmark. Purely user-driven, unlike the yellow
   * `waiting` status dot which the agent lifecycle sets: toggled from the
   * sidebar row's bookmark button, rendered by turning the row's leading
   * activity dot accent-blue (overriding the status color), and cleared
   * automatically the next time the user selects the
   * workspace (or by toggling the button again). Persisted so the reminder
   * survives an app restart. */
  markedUnread?: boolean;
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
  /** True once the branch has been pinned by a *human* action — the user typing
   * a name in the sidebar, an out-of-band `git branch -m`, or an explicit branch
   * switch. Hard-disables the agent-facing auto-rename nudge regardless of
   * {@link autoRenameCount}: once a person has chosen a name, orchestra never
   * nudges the agent to change it again. (An agent renaming itself via
   * `orchestra rename` does NOT set this — that flows through
   * {@link autoRenameCount} instead, so the agent can still progressively
   * refine its own branch name.) */
  branchManuallySet?: boolean;
  /** How many times the agent has auto-renamed its own branch via the
   * `orchestra rename` socket call. Drives a two-stage progressive rename:
   *   0 → fresh auto branch; nudge pushes for an early provisional name on the
   *       very first prompt.
   *   1 → provisional name landed; nudge pushes for a refined name once the
   *       work to implement is well-defined.
   *   ≥2 → done; the nudge stops firing. The agent can still rename on demand
   *       (e.g. when the user explicitly asks), it just isn't prompted to.
   * The env var `ORCHESTRA_BRANCH_AUTO` is `1` only while this is < 2 AND
   * `branchManuallySet` is false. Absent on pre-upgrade records → treated as 0. */
  autoRenameCount?: number;
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
  /** Tag of the published GitHub Release that first shipped this branch's own
   * (authored) work (e.g. `v0.1.11`). Drives the sidebar "released" pill.
   * Always the earliest entry of `releasedVersions`. */
  releasedVersion?: string;
  /** Published-release tags this workspace wears as pills, oldest-first: the
   * release that first shipped the branch's authored work, plus every release
   * the branch itself cut (it authored the version-bump tag commit) — so a
   * branch that ships in phases gets one pill per phase, while a stray
   * follow-up commit riding along in another branch's release earns none.
   * Recomputed each poll while merged, so the list tracks later ships. Absent
   * on pre-upgrade records → the UI falls back to the single `releasedVersion`
   * pill. */
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
  /** Prompts parked while the workspace's account is at its usage limit,
   * oldest-first. Queued from the workspace's limit banner (the terminal is
   * useless while Claude is rate-limited — a typed prompt would just error the
   * turn away). The main-process flusher (src/main/prompt-queue.ts) watches the
   * account's usage windows and auto-delivers the whole queue as one turn once
   * a post-queue usage snapshot shows the limit has reset — typing it into the
   * live TUI, or waking the agent (`claude --continue`) when it's stopped.
   * Persisted in store.json so a queue survives app restarts. Absent/empty on
   * every record predating this field. */
  queuedPrompts?: QueuedPrompt[];
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

/** True when children may nest under this workspace — the single answer to
 * "is this a tree root / a valid `/attach` parent?".
 *
 * Two disjoint routes reach it: the `'orchestrator'` KIND (a repo-less scratch
 * coordinator) and the {@link Workspace.canOrchestrate} CAPABILITY (a git
 * worktree that coordinates while doing its own work). Deliberately NOT the
 * same question as `isScratchLike` — that one asks "is this non-git?", and the
 * two answers diverge exactly on a promoted worktree, which orchestrates AND
 * keeps its repo/branch/diff. Use this for tree/parent decisions and
 * `isScratchLike` for git decisions; conflating them is what makes a promoted
 * worktree lose its diff tab or leak its worktree on delete. */
export function canOrchestrate(ws: Pick<Workspace, 'kind' | 'canOrchestrate'>): boolean {
  return ws.kind === 'orchestrator' || ws.canOrchestrate === true;
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
  /** Branch to cut the worktree from. Omitted → the repo's configured
   * `defaultBranch`. */
  baseBranch?: string;
  task?: string;
  agent?: 'claude';
  /** Orchestrator workspace id to record as this workspace's `parentId` (set
   * by `/spawn` from the caller's `ORCHESTRA_WS_ID`). Omitted for hand-created
   * workspaces. */
  parentId?: string;
  /** Where the new workspace's agent should run. Omitted = local (the default).
   * A sandbox host makes it stream over the wire via the RemoteTransport. */
  host?: WorkspaceHost;
  /** Model for the new workspace's agent (see {@link Workspace.model}). */
  model?: string;
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
  /** Base branch new workspaces are cut from (and the branch the sidebar sync
   * pill tracks). Auto-detected when the repo is added; user-configurable from
   * the repo settings modal (`repos:setDefaultBranch`). A single workspace can
   * still be based elsewhere via {@link CreateWorkspaceInput.baseBranch}
   * (right-click the repo's "+", or `orchestra spawn --base`). */
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
  /** Set when the `gh` query itself FAILED (gh missing, bad/expired token, rate
   * limit, network) — carries the first stderr line for the badge tooltip.
   * Distinguishes "we could not ask" from "we asked and there are no PRs": both
   * yield empty `all`, and without this the PR badge silently vanishes on a
   * broken `gh`, which reads as "no PR exists". Absent on every successful
   * query, so a present `error` always means the other fields are unknown, not
   * empty. */
  error?: string;
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
  /** Pay-as-you-go extra-usage utilization (0–100), or null/absent when the
   *  pool is disabled. Lets the default login's usage-limit check honour extra
   *  credits the same way the per-account poller does — without it a maxed
   *  5h/7d default account would read as limited even with extra usage on. */
  extraUtilization?: number | null;
  /** The Fable-scoped weekly window, or null/absent when the plan has none.
   *  Display-only (see UsageData.fable in shared/accounts.ts). */
  fable?: UsageWindow | null;
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

// ─── Structured agent view (Claude Agent SDK) ────────────────────────────────
//
// The structured-agent-view feature runs a workspace's agent through the
// `@anthropic-ai/claude-agent-sdk` `query()` API instead of scraping the raw
// terminal, so the renderer can show first-class messages, streaming text,
// tool calls with diffs, permission prompts, and cost/usage — none of which are
// recoverable from PTY bytes. The types below are THE CONTRACT between the main
// process (which owns the SDK subprocess, src/main/agent-sdk.ts) and the
// renderer (which folds events into a view, via the `agent:event` channel).
//
// Two layers:
//   • {@link AgentEvent} — the flat, on-the-wire event stream. Every event is a
//     small immutable fact about the session, emitted in order. The main
//     process normalizes raw SDK messages into these (src/shared/agent-events.ts
//     `normalizeSdkMessage`) so the renderer never sees SDK-internal shapes.
//   • {@link AgentSession} / {@link RenderMessage} — the FOLDED view. Pure
//     `foldEvents` (same module) accumulates the event stream into coherent
//     messages: streaming `text-delta`s coalesce into one assistant message,
//     `tool-input-delta`s assemble a tool call's JSON, and `tool-use` ↔
//     `tool-result` are correlated by id so a file diff can be reconstructed.
//
// Phase 0 spike constraints baked into these types (docs/spikes/
// phase0-sdk-findings.md — VERIFIED, they override assumptions):
//   • Thinking text is REDACTED on Opus 4.8: `thinking_delta` events fire but
//     carry empty text. So thinking is modelled as a BOOLEAN indicator
//     ({@link AgentThinkingStartEvent} + {@link RenderMessage.thinking}), never
//     a text stream. Do not add a thinking-text field.
//   • Diffs are RECONSTRUCTED: a Write/Edit `tool_result` is plain success
//     text, so the content/old_string/new_string lives on the `tool_use` INPUT.
//     `toolUseId` correlates the two ({@link AgentToolUseEvent} ↔
//     {@link AgentToolResultEvent}).
//   • Interrupt surfaces as the SDK iterator THROWING (`error_during_execution`)
//     — the manager treats it as an expected terminal state and emits a normal
//     {@link AgentTurnEndEvent} with `stopReason: 'interrupted'`.
//   • Transient API 500s arrive as `result` messages with `is_error: true` and
//     `apiErrorStatus` set (NOT thrown) — see {@link AgentErrorEvent}.

/** Which permission gate the session runs under, mirroring Claude Code's own
 *  modes. `default` prompts per tool via the `canUseTool` round-trip;
 *  `acceptEdits` auto-allows file edits; `bypassPermissions` allows everything
 *  (no prompts); `plan` runs read-only planning. Settable live from the UI
 *  (`agent:sdkSetPermissionMode`). */
export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

/** Why a turn ended, normalized from the SDK result's `subtype`/`stop_reason`.
 *  `end_turn` is a clean finish; `interrupted` is a user interrupt (the SDK
 *  iterator threw `error_during_execution`); `max_turns` hit the turn cap;
 *  `error` is any other terminal failure carried on the result. */
export type AgentStopReason =
  | 'end_turn'
  | 'interrupted'
  | 'max_turns'
  | 'error';

/** Token accounting for one turn, lifted verbatim from the SDK result's
 *  `usage`. `cacheCreationInputTokens`/`cacheReadInputTokens` are the prompt-
 *  cache split; the renderer sums them for a context-size read the same way the
 *  PTY-scraping `agent:context` event does today. All counts are for the single
 *  turn the {@link AgentTurnEndEvent} closes, not cumulative. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Anthropic service tier the turn ran under (e.g. 'standard'), or null when
   *  the SDK did not report one. */
  serviceTier: string | null;
}

// ── AgentEvent — the flat, ordered event stream ──────────────────────────────
//
// A discriminated union on `type`. Each event is keyed to a workspace by the
// channel envelope (`agent:event` broadcasts `(wsId, event)`), so the wsId is
// NOT repeated on every event. `seq` is a per-session monotonic counter the
// manager stamps so the renderer can detect a dropped event and reconcile.

/** Fields every event carries. */
export interface AgentEventBase {
  /** Per-session monotonic sequence number, from the manager. Lets the renderer
   *  order events and notice a gap. */
  seq: number;
  /** Epoch ms the manager emitted the event. */
  at: number;
}

/** Session bootstrapped — the SDK `system`/`init` message. Carries the session
 *  identity and the environment the agent actually loaded (model, tools, cwd),
 *  so the UI can show which model/permission mode is live from the first frame.
 *  Fires once per `query()` (a new one after a stop+restart). */
export interface AgentInitEvent extends AgentEventBase {
  type: 'session/init';
  /** The SDK's `session_id` — stable across turns of one `query()` (spike h). */
  sessionId: string;
  /** Model the session resolved to (e.g. 'claude-opus-4-8'). */
  model: string;
  /** Absolute cwd the agent runs in (the worktree path). */
  cwd: string;
  /** Live permission mode at init. */
  permissionMode: AgentPermissionMode;
  /** Tool names the session loaded (proves user/project settings are active). */
  tools: string[];
}

/** One incremental chunk of assistant TEXT (`text_delta`). `index` is the SDK
 *  content-block index the delta belongs to, so `foldEvents` appends deltas of
 *  the same block into one contiguous text run even when tool blocks interleave
 *  at other indices. */
export interface AgentTextDeltaEvent extends AgentEventBase {
  type: 'text-delta';
  index: number;
  text: string;
}

/** An assistant `thinking` content block STARTED. Thinking text is redacted on
 *  Opus 4.8 (spike b), so this is a pure indicator — there is intentionally no
 *  text field. `foldEvents` flips {@link RenderMessage.thinking} true on this
 *  and leaves it (a block-stop or turn-end settles the spinner). */
export interface AgentThinkingStartEvent extends AgentEventBase {
  type: 'thinking-start';
  index: number;
}

/** One incremental chunk of a tool call's INPUT JSON (`input_json_delta`).
 *  Concatenated across all deltas at the same `index` this yields the full
 *  argument JSON string; `foldEvents` accumulates it against the matching
 *  {@link AgentToolUseEvent} at that block index so the UI can show arguments
 *  assembling live. */
export interface AgentToolInputDeltaEvent extends AgentEventBase {
  type: 'tool-input-delta';
  index: number;
  /** A raw JSON fragment (`partial_json`) — NOT valid JSON on its own. */
  partialJson: string;
}

/** A content block STARTED (`content_block_start`). `kind` distinguishes the
 *  block so the renderer can open the right UI slot at `index` before deltas
 *  arrive. `thinking` blocks also emit a {@link AgentThinkingStartEvent}; this
 *  event exists so text/tool blocks have an explicit start too. */
export interface AgentBlockStartEvent extends AgentEventBase {
  type: 'block-start';
  index: number;
  kind: 'text' | 'thinking' | 'tool_use';
}

/** A content block STOPPED (`content_block_stop`). Closes the block at `index`
 *  — the renderer finalizes that text run / tool-input buffer. */
export interface AgentBlockStopEvent extends AgentEventBase {
  type: 'block-stop';
  index: number;
}

/** A completed assistant `tool_use` — the tool call as the model finalized it.
 *  This carries the FULL parsed `input`, which for Write/Edit is the only place
 *  the file content/diff lives (spike g). Correlate with the matching
 *  {@link AgentToolResultEvent} by `toolUseId`. */
export interface AgentToolUseEvent extends AgentEventBase {
  type: 'tool-use';
  /** The SDK `tool_use.id` (e.g. 'toolu_01…') — the correlation key. */
  toolUseId: string;
  /** Tool name (Bash, Write, Edit, Read, …). */
  name: string;
  /** The finalized tool input. `content` (Write) / `old_string`+`new_string`
   *  (Edit) here are the source of the rendered diff. */
  input: Record<string, unknown>;
}

/** A `tool_result` for a prior {@link AgentToolUseEvent}. For Write/Edit this is
 *  just success/failure TEXT, not structured diff data (spike g) — the diff is
 *  built from the tool_use input plus the on-disk before. `isError` marks a
 *  failed or denied tool. */
export interface AgentToolResultEvent extends AgentEventBase {
  type: 'tool-result';
  /** Matches {@link AgentToolUseEvent.toolUseId}. */
  toolUseId: string;
  /** The result payload — usually a string; the SDK may send a content-block
   *  array for richer results, passed through verbatim. */
  content: string | unknown[];
  /** True when the tool errored or was denied (`is_error` on the result). */
  isError: boolean;
}

/** The agent wants to run a tool and the session's permission mode requires a
 *  decision — the SDK `canUseTool` callback fired (spike c). The manager parks
 *  the callback and emits this; the renderer answers via
 *  `agent:sdkPermissionReply(wsId, requestId, result)`. Exactly one reply per
 *  `requestId` resolves the pending call. */
export interface AgentPermissionRequestEvent extends AgentEventBase {
  type: 'permission-request';
  /** The manager's key for the parked `canUseTool` call — echo it back in the
   *  reply. Distinct from `toolUseId`. */
  requestId: string;
  /** The SDK-provided tool-use id for this call, when known. */
  toolUseId: string | null;
  /** Tool the agent is asking to run. */
  name: string;
  /** The tool's proposed input, for the confirmation UI. */
  input: Record<string, unknown>;
  /** Optional human-readable title the SDK supplies for the prompt. */
  title?: string;
}

/** How the renderer answered a {@link AgentPermissionRequestEvent}. `allow`
 *  lets the call run (optionally with an edited `input`); `deny` blocks it with
 *  a message the model sees as the tool result. Mirrors the SDK `canUseTool`
 *  return shape. */
export type AgentPermissionReply =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** One installed skill (slash command) visible to a workspace's agent — the
 *  structured composer's autocomplete items. Listed by the manager from the
 *  worktree's `.claude/skills/*` and the account config dir's `skills/*`
 *  (agent-sdk.ts sdkListSkills). */
export interface AgentSkillInfo {
  /** Invocation name, without the leading slash. */
  name: string;
  /** First sentence of the SKILL.md frontmatter description ('' when absent). */
  description: string;
  /** Where it comes from — the worktree's .claude/skills or the user level. */
  source: 'project' | 'user';
}

/** A live change to the session's model or permission mode, emitted by the
 *  manager when the renderer's dropdowns switch one (agent-sdk.ts
 *  sdkSetModel/sdkSetPermissionMode). Without it the folded session keeps the
 *  values from `session/init` (which fires only once per query), so the
 *  dropdown trigger would snap back to the old value after a switch. Either
 *  field may be absent (only the changed one is sent). */
export interface AgentSessionUpdateEvent extends AgentEventBase {
  type: 'session/update';
  model?: string;
  permissionMode?: AgentPermissionMode;
}

/** The live Remote Control state of a structured session — Orchestra's parity
 *  with Claude Code's `/remote-control` feature. When ACTIVE, the SDK worker has
 *  opened a bridge to Anthropic's relay and the session can be driven from
 *  `claude.ai/code` or the Claude mobile app via `sessionUrl`. Enabling calls the
 *  SDK's `enableRemoteControl(true)` control request, which returns the
 *  `session_url`/`connect_url`/`environment_id` mirrored here (verified against
 *  the CLI 2.1.x worker handler + SDK 0.3.216 `Query.enableRemoteControl`). */
export interface RemoteControlState {
  /** True once the bridge is connected (the session is remotely controllable). */
  active: boolean;
  /** The shareable link to open on another device (claude.ai/code/<id>) — set
   *  only while `active`. This is what the CC app surfaces to "Control this
   *  session from claude.ai/code or the Claude mobile app". */
  sessionUrl?: string;
  /** The deep-link/connect URL the SDK returns alongside `session_url`. */
  connectUrl?: string;
  /** The bridge environment id, for display/debugging. */
  environmentId?: string;
  /** Set when enabling failed (org policy, rollout not enabled, network) so the
   *  UI can show why instead of silently staying off. Cleared on the next
   *  successful toggle. */
  error?: string;
  /** True while an enable/disable request is in flight, so the toggle can show a
   *  pending state and disable itself against double-clicks. */
  pending?: boolean;
}

/** Emitted by the manager (agent-sdk.ts `sdkSetRemoteControl`) whenever a
 *  session's Remote Control state changes — on enable (carries the URLs), on
 *  disable, on failure (carries `error`), and to reflect the in-flight `pending`
 *  transition. Folded into `AgentSession.remoteControl` so the toggle in the
 *  structured view reflects the live state and survives a view remount. */
export interface AgentRemoteControlEvent extends AgentEventBase {
  type: 'session/remote-control';
  state: RemoteControlState;
}

/** An image attached to a user turn (pasted into the composer). Carried to the
 *  SDK as an `image` content block and echoed into the transcript so the sent
 *  image renders in the user's bubble. */
export interface AgentImage {
  /** IANA media type, e.g. `image/png`, `image/jpeg`. */
  mediaType: string;
  /** Raw base64 of the image bytes (no `data:` prefix). */
  dataBase64: string;
}

/** A user turn submitted to the session, echoed by the manager at enqueue time.
 *  The SDK stream does NOT echo plain user text back (its `user` messages only
 *  carry tool_result blocks), so without this event a sent prompt would never
 *  appear in the transcript. Emitting it through the same broadcast/fold path
 *  keeps the renderer a pure projection of the event stream and shows the echo
 *  to every attached UI (Electron + ui-rpc clients). */
export interface AgentUserMessageEvent extends AgentEventBase {
  type: 'user-message';
  /** The prompt text as submitted. */
  text: string;
  /** Images pasted into the composer alongside the text, if any. */
  images?: AgentImage[];
}

/** A local shell command run from the composer's **bash mode** (`!command`,
 *  parity with Claude Code). Unlike a normal turn, the command runs directly in
 *  the workspace's worktree — NOT the model — and its command+output are both
 *  shown inline in the transcript AND fed into the SDK session's context (so the
 *  agent sees them on its next turn, exactly like CC's `<local-command-stdout>`).
 *  The manager emits ONE of these per run: `running:true` when the command
 *  starts (so a spinner shows), then a final replace with the captured output +
 *  exit code. Folded into a single `local-command` RenderMessage keyed by
 *  `commandId` so the start event and the completion event update the same row. */
export interface AgentLocalCommandEvent extends AgentEventBase {
  type: 'local-command';
  /** Stable id correlating the `running` start event with its completion, so the
   *  fold updates one row rather than appending two. */
  commandId: string;
  /** The shell command as typed (without the leading `!`). */
  command: string;
  /** Whether the command is still running (start event) or finished (completion). */
  running: boolean;
  /** Combined stdout+stderr captured so far, present on the completion event. */
  output?: string;
  /** Process exit code on completion (null if the process was killed by a signal
   *  or never spawned). */
  exitCode?: number | null;
}

/** A turn finished — the SDK `result` message (spike f). Carries the cost/usage
 *  accounting the UI shows, plus the stop reason. A successful turn has
 *  `isError: false`; a graceful transient failure (500) has `isError: true` and
 *  an {@link AgentErrorEvent} is emitted alongside for the surfaced error. */
export interface AgentTurnEndEvent extends AgentEventBase {
  type: 'turn-end';
  /** Whether this result is an error result (`is_error`). */
  isError: boolean;
  /** Normalized stop reason. */
  stopReason: AgentStopReason;
  /** Turns the SDK ran to produce this result (`num_turns`). */
  numTurns: number;
  /** Full-turn cost in USD (`total_cost_usd`), or null when absent. */
  costUsd: number | null;
  /** Token usage for the turn, or null on an error result that lacks it. */
  usage: TokenUsage | null;
  /** The final assistant text (`result`), when the SDK provided it. */
  resultText: string | null;
  /** The session id this turn belongs to. */
  sessionId: string;
  /** Wall-clock duration of the turn in ms (`duration_ms`), when reported. */
  durationMs: number | null;
}

/** A surfaced error. Two sources: (1) an `is_error` RESULT message — a
 *  transient API failure (typically a 500) that arrives as a normal result, NOT
 *  a thrown exception, with `apiErrorStatus` set (spike, note 6); (2) a
 *  subprocess/transport failure the manager caught. The renderer shows it
 *  inline; the manager decides whether to retry (transient 500s) per its own
 *  backoff. */
export interface AgentErrorEvent extends AgentEventBase {
  type: 'error';
  /** Human-readable error message. */
  message: string;
  /** The HTTP status when this came from an API error result (e.g. 500), else
   *  null (a transport/subprocess error). */
  apiErrorStatus: number | null;
  /** Whether the manager considers this transient and will retry. */
  willRetry: boolean;
}

/** Live usage counters for a background task, mirrored from the SDK's
 *  `task_progress` / `task_notification` `usage` field. Drives the
 *  "60.3k tokens · 1 tool use" line on a task card. */
export interface AgentTaskUsage {
  /** Total tokens the subagent has consumed so far. */
  totalTokens: number;
  /** Number of tool calls the subagent has made. */
  toolUses: number;
  /** Wall-clock duration in ms. Only reported on the terminal
   *  `task_notification`; while running the card derives elapsed from
   *  `startedAt` instead. */
  durationMs?: number;
}

/** A terminal status for a background task, from `task_notification.status`.
 *  A `running` task has no terminal status yet. */
export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** A background task (Task-tool subagent, shell, monitor, or workflow) the
 *  session spawned. Emitted by the SDK's `task_started` / `task_progress` /
 *  `task_updated` / `task_notification` system messages and the
 *  `background_tasks_changed` level signal. The renderer's "Background tasks"
 *  panel (BackgroundTasksPanel.tsx) renders one card per task. */
export interface AgentTaskEvent extends AgentEventBase {
  type: 'task';
  /** Which lifecycle message produced this event. `changed` carries the full
   *  live set (replace-semantics) rather than a single task. */
  kind: 'started' | 'progress' | 'updated' | 'notification' | 'changed';
  /** The SDK `task_id`. Absent only on `changed` (which carries `liveIds`). */
  taskId?: string;
  /** The parent Task tool_use id, when the SDK reports it, so the card can be
   *  correlated with the inline tool call. */
  toolUseId?: string;
  /** Task-type label — 'subagent' | 'shell' | 'monitor' | 'workflow' | … */
  taskType?: string;
  /** Subagent type name (e.g. 'general-purpose'), for 'subagent' tasks. */
  subagentType?: string;
  /** Free-text description shown as the card title. */
  description?: string;
  /** Terminal status, on `notification`. */
  status?: Exclude<AgentTaskStatus, 'running'>;
  /** Live usage counters, on `progress` / `notification`. */
  usage?: AgentTaskUsage;
  /** Name of the most recent tool the subagent invoked, on `progress`. */
  lastToolName?: string;
  /** A short AI-generated present-tense summary, when `agentProgressSummaries`
   *  is enabled (e.g. "Analyzing authentication module"). */
  summary?: string;
  /** Path to the finished task's transcript file, on `notification` — backs the
   *  "View transcript" link. */
  outputFile?: string;
  /** `background_tasks_changed`: every task id currently live. The fold uses
   *  this to reconcile the running set so a missed start/finish bookend can't
   *  wedge a stale "running" card. Only present on `kind: 'changed'`. */
  liveIds?: string[];
}

/** The full agent event stream — a discriminated union on `type`. The main
 *  process emits these in order over the `agent:event` channel; the renderer
 *  folds them via {@link foldEventsInto} (src/shared/agent-events.ts). */
export type AgentEvent =
  | AgentInitEvent
  | AgentTextDeltaEvent
  | AgentThinkingStartEvent
  | AgentToolInputDeltaEvent
  | AgentBlockStartEvent
  | AgentBlockStopEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentPermissionRequestEvent
  | AgentUserMessageEvent
  | AgentLocalCommandEvent
  | AgentSessionUpdateEvent
  | AgentRemoteControlEvent
  | AgentTaskEvent
  | AgentTurnEndEvent
  | AgentErrorEvent;

/** The `type` discriminants of {@link AgentEvent}, for exhaustive switches. */
export type AgentEventType = AgentEvent['type'];

// ── The folded view — AgentSession / RenderMessage ───────────────────────────

/** One rendered message in the folded transcript. `foldEvents` produces these
 *  from the event stream: an assistant text run becomes one message with
 *  `text` growing as deltas fold in; a tool call becomes one message whose
 *  `toolUse` fills from the tool-use event and whose `toolResult` fills when the
 *  correlated result arrives. */
export interface RenderMessage {
  /** Stable id for React keys — `${sessionId}:${index}` for block-derived
   *  messages, or the toolUseId for tool messages. */
  id: string;
  /** Who authored it. `assistant` text, `tool` a tool call+result pair, `user`
   *  a submitted prompt, `system` an init/notice, `error` a surfaced failure,
   *  `local-command` a `!command` bash-mode run (its command + captured output). */
  role: 'assistant' | 'tool' | 'user' | 'system' | 'error' | 'local-command';
  /** The content-block index this message came from, when block-derived. Lets
   *  deltas at the same index fold into the same message. */
  index?: number;
  /** Assistant/user/system/error text, accumulated from deltas. */
  text?: string;
  /** For a `user` message: images pasted into the composer with this turn. */
  images?: AgentImage[];
  /** True while a thinking block is open on this message — a spinner indicator,
   *  never rendered text (redacted on Opus 4.8). */
  thinking?: boolean;
  /** For a `tool` message: the tool call. `inputJson` is the raw streaming
   *  buffer (assembling); `input` is the finalized parsed input once the
   *  tool-use event lands. */
  toolUse?: {
    toolUseId: string;
    name: string;
    /** Streaming raw JSON fragments concatenated (may be partial). */
    inputJson: string;
    /** Finalized parsed input (present once the tool-use event arrives). */
    input?: Record<string, unknown>;
  };
  /** For a `tool` message: the correlated result, once it arrives. */
  toolResult?: {
    content: string | unknown[];
    isError: boolean;
  };
  /** For a `local-command` message (`!command` bash mode): the command, its
   *  captured stdout+stderr, exit code, and whether it's still running. */
  localCommand?: {
    command: string;
    running: boolean;
    output?: string;
    exitCode?: number | null;
  };
  /** True once the block that produced this message has stopped. */
  done?: boolean;
}

/** The whole folded session state the renderer holds per workspace. Rebuilt by
 *  replaying every {@link AgentEvent} through `foldEvents`, so it is a pure
 *  function of the event stream — no hidden state. */
export interface AgentSession {
  /** Owning workspace id. */
  workspaceId: string;
  /** SDK session id, set on the init event; '' until then. */
  sessionId: string;
  /** Resolved model, from init. */
  model: string;
  /** Live permission mode. */
  permissionMode: AgentPermissionMode;
  /** Whether a turn is currently in flight (between a prompt and its turn-end).
   *  Drives the interrupt button and input gating. */
  running: boolean;
  /** The folded transcript, in order. */
  messages: RenderMessage[];
  /** Pending permission requests awaiting a renderer reply, keyed by requestId
   *  so the UI can show one prompt per parked call. */
  pendingPermissions: AgentPermissionRequestEvent[];
  /** The most recent turn-end, for the cost/usage footer. */
  lastTurn?: AgentTurnEndEvent;
  /** Cumulative cost in USD across every turn this session, for a running
   *  total. */
  totalCostUsd: number;
  /** Epoch ms the current turn started (set when `running` flips true on a
   *  `user-message`/`session/init`), or undefined between turns. Backs the
   *  live-ticking elapsed timer in the TurnFooter's "working" state — the SDK
   *  stream carries no live duration, so the renderer derives elapsed from
   *  `Date.now() - turnStartedAt`. Cleared to `undefined` at `turn-end`. */
  turnStartedAt?: number;
  /** Count of assistant output characters streamed in the CURRENT turn (summed
   *  from `text-delta`s), reset to 0 when a turn starts. The SDK delivers exact
   *  token usage only at `turn-end`, so while a turn is in flight the footer
   *  shows an approximate live token count derived from this (~chars/4) that
   *  ticks up, then snaps to the exact `lastTurn.usage.outputTokens` at end. */
  liveOutputChars: number;
  /** Background tasks (Task-tool subagents, shells, monitors, workflows) the
   *  session has spawned, keyed by `task_id`, in first-seen (insertion) order.
   *  Folded from {@link AgentTaskEvent}. Backs the "Background tasks" panel. */
  tasks: Record<string, BackgroundTask>;
  /** Live Remote Control state (parity with Claude Code's `/remote-control`).
   *  Undefined until the first `session/remote-control` event; `active:false`
   *  once toggled off. Backs the Remote Control toggle in the structured view. */
  remoteControl?: RemoteControlState;
  /** The highest `seq` folded in, so a caller can detect a gap. */
  lastSeq: number;
}

/** The folded state of one background task — the projection the "Background
 *  tasks" panel renders. Built by `foldEvent` from the {@link AgentTaskEvent}
 *  stream: `started` creates it, `progress`/`updated` merge into it,
 *  `notification` finalizes it. */
export interface BackgroundTask {
  /** The SDK `task_id`. Stable key. */
  id: string;
  /** Parent Task tool_use id, when known. */
  toolUseId?: string;
  /** Task-type label ('subagent' | 'shell' | 'monitor' | 'workflow' | …). */
  taskType?: string;
  /** Subagent type name, for 'subagent' tasks. */
  subagentType?: string;
  /** Card title. */
  description: string;
  /** `running` until a terminal `notification` arrives. */
  status: AgentTaskStatus;
  /** Latest usage counters. */
  usage?: AgentTaskUsage;
  /** Most recent tool the subagent invoked. */
  lastToolName?: string;
  /** Latest AI-generated progress summary, if enabled. */
  summary?: string;
  /** Finished-transcript path (backs "View transcript"). */
  outputFile?: string;
  /** Epoch ms the task first appeared, for the live elapsed timer. */
  startedAt: number;
  /** Epoch ms the task reached a terminal state, for the frozen elapsed. */
  endedAt?: number;
}

// ---------------------------------------------------------------------------
// Embedded browser panel
// ---------------------------------------------------------------------------
//
// A per-workspace in-window browser (an Electron `WebContentsView` overlaid on
// the React renderer) that BOTH the user drives manually (URL bar / back /
// forward) AND the agent drives via native Electron `webContents.debugger`
// (in-process CDP) — no external Chrome, no debug port, no puppeteer. Modeled
// on the Claude Code desktop app's "Browser pane". One independent browser per
// workspace: the main-process registry keys every view by `wsId`, and the
// agent's browser tools close over their own session's `wsId`, so a workspace's
// agent can only ever drive that workspace's panel.

/** The live navigation state of one workspace's browser panel, pushed to the
 *  renderer over `browser:event` so the URL bar / title / nav buttons reflect
 *  BOTH manual and agent-driven navigation. */
export interface BrowserPanelState {
  /** Workspace the panel belongs to. */
  wsId: string;
  /** Current committed URL (empty before the first navigation). */
  url: string;
  /** Page title, for the tab label. */
  title: string;
  /** True while a navigation is in flight (spinner). */
  loading: boolean;
  /** Whether history back/forward are available (drives the nav buttons). */
  canGoBack: boolean;
  canGoForward: boolean;
  /** Last navigation error, if the load failed (e.g. DNS/connection). */
  error?: string;
}

/** Pixel bounds of the DOM placeholder the native `WebContentsView` must track.
 *  The renderer measures its `.browser-pane` rect and sends this to main so the
 *  native view is positioned/sized exactly over the placeholder. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
