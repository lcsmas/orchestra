# Workspaces subsystem

The core of Orchestra. `src/main/workspaces.ts` (~2650 lines) owns the full
workspace lifecycle, worktree mechanics, hook installation, agent spawning, and
inter-agent orchestration. Supporting files: `store.ts`, `scripts.ts`,
`secrets.ts`, `repo-sync.ts`, and `sandbox-import.ts` (import/eject/backup —
see [sandbox-transport.md](sandbox-transport.md)). Domain types:
`src/shared/types.ts`.

## What a workspace is

`Workspace` interface — `src/shared/types.ts:3-136` (read it; richly commented).
A workspace is an isolated execution environment for one Claude Code agent.
`kind` (`types.ts:23`) selects one of three:

- **`worktree`** (default / absent) — a real `git worktree` cut from a repo's
  base branch. Has `repoPath`, `worktreePath`, `branch`, `baseBranch`; supports
  diff/merge/PR/release tracking.
- **`scratch`** — throwaway non-git dir under `~/.orchestra/scratch/`.
  `repoPath`/`baseBranch` are `''`; `branch` is a display label only.
- **`orchestrator`** — a scratch session seeded with a coordinator brief
  (`ORCHESTRATOR_BRIEF`, ~`workspaces.ts:351`); children it spawns carry its id
  as `parentId` and nest under it in the sidebar. The brief is one-time
  onboarding only — durable role enforcement is the SessionStart-injected
  `orchestrator-instruction.sh` reminder (re-fired post-compaction) plus the
  `orchestrator-guard.sh` PreToolUse deny hook (see
  [hooks-cli-socket.md](hooks-cli-socket.md)), both gated on `ORCHESTRA_KIND`
  env or the `.orchestra/.orchestrator` sentinel (`markOrchestratorWorktree`,
  written at creation and by `/promote` so a mid-session promotion picks it up
  without a pty restart).

Use the helper **`isScratchLike(ws)`** (`types.ts:143`) instead of comparing
`kind` to a literal — it covers both non-git kinds in one place.

Key per-record fields: `accountId` (pinned at creation, never changes —
preserves `claude --continue` history), `parentId` (nesting), `port`
(auto-allocated dev-server port), `setupStatus`, `branchManuallySet` (rename
lock), `divergedFromBase`/`mergedAt`/`unpushedAhead`/`releasedVersions`
(sidebar pills), `contextTokens` (badge seed), `heavyResumePending` (suppresses
blind Enter during a heavy `claude --continue` resume), and **`host`**
(`WorkspaceHost`, `types.ts:69` — absent = local node-pty; `{kind:'sandbox',
endpoint}` = agent lives in an always-on container, see
[sandbox-transport.md](sandbox-transport.md)).

## Lifecycle

### Create
- **`createWorkspace(input, window)`** — `workspaces.ts:259`. Steps: ensure root →
  generate UUID + `randomBranchName()` (adjective-noun, ~`:236`) → `createWorktree`
  (git.ts) → `installOrchestraHooks` → `store.allocatePort()` → build record,
  **pin repo's `accountId`** (~`:297`), record `parentId` only if parent exists
  (~`:302`) → persist + broadcast `workspace:update` → fire setup script async
  (does NOT block) → does NOT spawn the PTY (renderer's `pty:start` does, once it
  has terminal dimensions).
- **`createScratchWorkspace`** / **`createOrchestratorWorkspace`** —
  `workspaces.ts:403` / `:407` (both wrap `createScratchLikeWorkspace`, `:361`).

### Setup (repo workspaces only)
- **`runSetupScript(id, window)`** — `workspaces.ts:583`. Sets `setupStatus`
  `pending→running→ok|failed`, runs via `runOneShot` (scripts.ts), captures last
  stderr line into `setupError`. Log: `~/.orchestra/scripts/<id>-setup.log`.
  Failure never blocks creation; UI offers retry.

### Start agent
- **`startAgentPty(ws, cols, rows, window)`** — `workspaces.ts:2299`. Heavy-resume
  gate (sets `heavyResumePending` when resuming a >100k-token session),
  orchestrator brief on first launch only, idempotent hook
  reinstall, account-config sync, env build (`ORCHESTRA_BRANCH`,
  `ORCHESTRA_BRANCH_AUTO`, `ORCHESTRA_KIND`, per-repo `CLAUDE_CONFIG_DIR`), then `startPty` with
  `claude --dangerously-skip-permissions` (or `--continue` if `hasInput`).
  **Sandbox-hosted** (`ws.host?.kind==='sandbox'`): skips the local hook
  install, uses cwd `SANDBOX_WORKSPACE_DIR` (`/workspace`), and **strips
  `CLAUDE_CONFIG_DIR`** (a host path would shadow the container's seeded
  login); `startPty` routes to the remote transport via `ws.host`.
- **`startWorkspaceAgentHeadless(id, window)`** — `workspaces.ts:807`. Used by
  spawn: starts the agent with no UI terminal (default 120×32), injects
  `lastTask` once the TUI is ready.
- **`submitTaskWhenReady(...)`** — `workspaces.ts:851`. Waits on the SessionStart
  readiness sentinel (`$ORCHESTRA_READY_FILE`, 15s timeout, 1.2s fallback), types
  the task, submits with `\r`, retries up to 4× confirming status left `idle`.

### Archive / unarchive / delete
- **`archiveWorkspace`** `:415` (soft: stop PTYs, keep worktree+logs),
  **`unarchiveWorkspace`** `:437`, **`deleteWorkspace`** `:450` (hard: runs the
  per-repo archive script best-effort, clears scrollback+inbox, `removeWorktree`,
  removes record, broadcasts `workspace:removed`). Directory removal is
  hard-confined to `ORCHESTRA_ROOT`/`SCRATCH_ROOT`. **Sandbox-hosted** records
  (`:491`) just detach — the container keeps its copy; nothing local to reap.
  The reap steps are factored into **`teardownWorkspace(ws)`** (everything
  except the store-remove + broadcast) so both `deleteWorkspace` and the bulk
  path share them.
- **`deleteWorkspaces(ids, window, onProgress?)`** — bulk hard-delete. Reaps
  every worktree sequentially (gentle disk I/O; archive scripts + `git worktree
  remove` per id), then **one** `store.removeWorkspaces(ids)` write + **one**
  `workspaces:removed` broadcast — versus the old renderer loop that paid a full
  serialized `store.json` rewrite and two re-renders *per* workspace, the source
  of the app-wide jam when clearing dozens of archived workspaces. Progress ticks
  stream via `workspaces:deleteProgress`. Wired from the archived-section bulk
  delete (`Sidebar.tsx` `onDeleteSelectedArchived`) through IPC
  `workspaces:deleteMany`; the renderer prunes all ids in a single `set()` in the
  `onWorkspacesRemoved` handler.
- **`pruneOrphanedWorkspaces(window)`** `:544` — startup reconcile: `git worktree
  list` per repo (parallel); a workspace whose path git no longer tracks is
  removed. Skips repos it can't verify (missing/unmounted) so it never nukes
  unverifiable records, and **skips sandbox-hosted records** (`:572` — their
  worktree was retired to trash at import by design).
- **Import / eject / backups** — a workspace moves INTO a container via
  `importWorkspaceToSandbox` (`sandbox-import.ts:188`; local worktree retired
  to `~/.orchestra/trash/`) and back via `ejectWorkspaceFromSandbox` (`:397`),
  with automatic snapshots in `~/.orchestra/backups/<id>/`. Full flow in
  [sandbox-transport.md](sandbox-transport.md).

### Resume on app start
- **`resumeRunningWorkspaces(window)`** `:2100` — drains
  `store.takeResumeCandidates()` (workspaces that were `running` at shutdown) and
  relaunches each with `claude --continue` concurrently.

## Worktree mechanics (git.ts)
- `createWorktree(repoPath, branch, baseBranch, worktreePath)` — `git worktree
  add -b`. Path is `~/.orchestra/worktrees/<repo>-<safeBranch>-<idShort>`.
- `removeWorktree`, `listWorktreePaths` (porcelain parse). See
  [git.md](git.md) for the full git surface.

## Spawn & orchestration (socket dispatch handlers)
All return `{ ok, ... }` envelopes; routed from `hooks-server.ts`. See
[hooks-cli-socket.md](hooks-cli-socket.md) for the HTTP routes.

| Handler | Line | Route | Purpose |
|---|---|---|---|
| `dispatchSpawnRequest` | `:932` | `/spawn` | Create child workspace + start headless. Inherits caller's repo (worktree callers) or requires explicit `repoPath` (scratch/orchestrator callers). Records `parentId` = caller, unless `detached:true` (parentless top-level workspace; repo inheritance from `from` still applies). |
| `dispatchPromoteRequest` | `:1089` | `/promote` | scratch → orchestrator (idempotent; rejects worktrees). |
| `dispatchAttachRequest` | `:1148` | `/attach` | Re-parent under an orchestrator, or clear `parentId` to detach. Cycle-checked. |
| `dispatchPeersRequest` | `:1239` | `/peers` | List other live workspaces (`PeerInfo[]`). |
| `dispatchReadRequest` | `:1266` | `/read` | Peer branch + last ~80 transcript lines, ANSI-stripped. |
| `dispatchMessageRequest` | `:1353` | `/message` | Deliver to peer: **live** (type into running TUI), **started** (wake with `--continue`), or **inbox** (park in `~/.orchestra/inbox/<id>.txt`). |
| `dispatchRenameRequest` | `:722` | `/rename` | see Branch management. |
| `dispatchAddRepoRequest` | `:1024` | `/addRepo` | Register repo. |
| `dispatchDeleteWorkspaceRequest` | `:1054` | `/deleteWorkspace` | Hard-delete. |

## Branch management
- `randomBranchName` ~`:249` (1024 adjective-noun combos).
- **`renameWorkspaceBranch(id, newBranch, {manual, bumpAutoCount}, window)`**
  `:664` — scratch: relabel only; worktree: `git branch -m` (via git.ts
  `renameWorktreeBranch`). `manual` (human UI edit / out-of-band) pins
  `branchManuallySet`; `bumpAutoCount` (agent auto-rename) instead increments
  `autoRenameCount`. `freeBranchName` dedupes collisions with `-2..-99`.
- **Progressive auto-rename** — the agent gets **two** staged auto-renames
  (`MAX_AUTO_RENAMES`, `:730`): an early provisional name, then a refined name
  once the work is well-defined. `autoRenameActive(ws)` (`:738`) — `!branch­ManuallySet && autoRenameCount < 2` — is the single gate for the
  `ORCHESTRA_BRANCH_AUTO` env flag and for whether `dispatchRenameRequest`
  (`:754`) counts a rename. After the budget is spent the nudge retires, but the
  agent can still rename on demand (no more hard "already set" refusal).
- **`branchManuallySet`** = human-pinned (UI edit, out-of-band `git branch -m`
  adopted by activity.ts, `switchWorkspaceBranch`); hard-stops the nudge for
  good. **`autoRenameCount`** tracks the agent's own progressive renames.
  `.orchestra/.branch-renamed` sentinel holds the live count so the hook advances
  stage / self-disables mid-session before a pty restart refreshes the env.
- **`switchWorkspaceBranch(id, branch, window)`** `:1454` — `git switch`, stop
  agent+nvim PTYs, clear scrollback, set `hasInput:false` + `branchManuallySet`,
  emit `pty:restart`.

## Hooks installed per worktree
`installOrchestraHooks(worktreePath)` — `workspaces.ts:2156`. Idempotent via a
`HOOKS_VERSION` stamp hashing every script body + command. Writes 4 shell
scripts to `<worktree>/.orchestra/` and 6 capability skills to
`<worktree>/.claude/skills/`, then merges hook commands into
`settings.local.json` and evicts deprecated ones. Full detail (events, scripts,
env-guarding) in [hooks-cli-socket.md](hooks-cli-socket.md).

## Persistence — store.ts (273 lines)
- Shape: `{ repos: RepoEntry[], workspaces: Workspace[], accounts?: Account[] }`
  at `~/.orchestra/store.json` (or `$ORCHESTRA_HOME/store.json`).
- **Atomic writes** via a serialized promise chain (`writeChain`) + temp-file
  rename (~`:89`). Load migrates stale `running+hasInput` → `idle` + resume queue.
- Methods: `upsertWorkspace`, `removeWorkspace`, `getWorkspace`,
  `reorderWorkspaces`, `takeResumeCandidates`; repo methods `addRepo`/`removeRepo`/
  `updateRepo`/`getRepoScripts`/`setRepoScripts`; `allocatePort` (~`:185`, range
  55100–55600, counts non-archived only); account methods with validation.

## Setup/run/archive scripts — scripts.ts (127 lines)
- `buildScriptEnv(ws)` injects `ORCHESTRA_WORKSPACE_PATH`, `ORCHESTRA_ROOT_PATH`,
  `ORCHESTRA_BRANCH`, `ORCHESTRA_PORT`.
- `runOneShot({script, cwd, env, logFile})` spawns `$SHELL -ilc '<script>'`
  (interactive login shell, so nvm/version-managers load), pipes to log, returns
  `{exitCode, lastStderrLine}`. `RepoScripts` = `{setup?, run?, archive?}`
  (`types.ts:173`). Run scripts get their own `<wsId>:run` PTY.

## Secrets — secrets.ts (107 lines)
Electron `safeStorage` (libsecret/Keychain/DPAPI) at `~/.orchestra/secrets.json`;
falls back to 0600 plaintext with a warning if no keyring. Currently stores the
Linear API key: `getLinearApiKey`/`setLinearApiKey`/`clearLinearApiKey`.

## Base-branch sync — repo-sync.ts (113 lines)
`syncAllRepos(window)` (parallel per repo) → `syncBaseBranch` (git.ts) +
`getBaseSyncState` (behind/ahead vs `origin/<base>`), broadcast as
`repo:syncState`. Fires on focus, startup, and the refresh button.

## Key invariants
One worktree per workspace · `accountId` pinned for life · `parentId` only
persisted if parent exists (dangling → child floats to repo section) · setup is
async/non-blocking · hooks idempotent (version stamp) · store writes atomic ·
scrollback ring-buffered at 2 MB · all cleanup best-effort.
