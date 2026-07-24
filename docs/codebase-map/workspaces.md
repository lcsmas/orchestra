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
  `repoPath`/`baseBranch` are `''`; `branch` is a display label only. Creation
  pins `accountId` to the account flagged `scratchDefault` (if any —
  `scratchDefaultAccountId`, `accounts.ts`), since there's no repo to take an
  account from; the checkbox lives in the Accounts settings.
- **`orchestrator`** — a scratch session seeded with a coordinator brief
  (`ORCHESTRATOR_BRIEF`, ~`workspaces.ts:351`); children it spawns carry its id
  as `parentId` and nest under it in the sidebar. The brief is one-time
  onboarding only — durable role enforcement is the SessionStart-injected
  `orchestrator-instruction.sh` reminder (re-fired post-compaction) plus the
  `orchestrator-guard.sh` PreToolUse deny hook (see
  [hooks-cli-socket.md](hooks-cli-socket.md)), both gated on `ORCHESTRA_KIND`
  env or the `.orchestra/.orchestrator` sentinel (`markOrchestratorWorktree`,
  written at creation and by `/promote` so a mid-session promotion picks it up
  without a pty restart; `unmarkOrchestratorWorktree` removes it on `/demote`).
  The sentinel's **contents** select the reminder wording: `dual` (written when
  a *worktree* is promoted) yields a dual-role reminder — coordinate children
  *and* keep doing this branch's own work — while anything else (`1`, and every
  historic sentinel) yields the absolute "you do not implement" text. The
  PreToolUse guard needs no such split: it already allows writes inside the
  workspace's **own** worktree and blocks only edits to *other* workspaces'
  files, which is exactly the dual-role contract. Both the brief and both
  reminder variants carry the delegation loop's **close** as well as its open:
  every child must end LANDED (verified with `orchestra verify-landed`, see
  `dispatchVerifyLandedRequest` below) or **INTENTIONALLY UNMERGED** (a
  spike/experiment whose brief forbade merging, recorded as such) — only the
  silent third state is forbidden. They also carry the sanctioned
  **sub-orchestrator** move — spawn a child, `orchestra promote <child-id>`,
  at most one such level, checkable via `orchestra whoami` (the only in-band
  way an agent learns its own `parentId`) — so model-initiated recursion is a
  documented pattern, not an accident of the attach machinery.

Use the helper **`isScratchLike(ws)`** (`types.ts:246`) instead of comparing
`kind` to a literal — it covers both non-git kinds in one place.

### Orchestrator: a KIND *and* a capability

"Orchestrator" is two separable things — a **tree role** (children may nest
under me) and a **non-git nature** (no repo/branch/diff). The `'orchestrator'`
kind fuses both, which is right for a repo-less coordinator but wrong for an
integration branch that coordinates agents *while carrying its own commits*. So
a git worktree becomes a coordinator via the **`canOrchestrate?: boolean`**
capability (`types.ts:86`) instead: `kind` stays `'worktree'` and every git path
keeps working.

Two helpers, two questions — do not conflate them:

| Helper | Question | Promoted worktree |
|---|---|---|
| `isScratchLike(ws)` `types.ts:246` | is this **non-git**? (diff/merge/PR/delete/rename) | **false** |
| `canOrchestrate(ws)` `types.ts:261` | can children **nest under** this? (tree/parent) | **true** |

They diverge exactly on a promoted worktree, and that divergence *is* the
feature. Flipping such a worktree's `kind` instead would make `isScratchLike`
true and silently strip its git identity: `teardownWorkspace` (`:566`) returns
early and never calls `removeWorktree` (the git worktree **leaks**),
`renameWorkspaceBranch` (`:823`) stops running `git branch -m` (label desyncs
from the real branch), and both frontends hide Diff/Run/PR/merge/branch-picker.

Key per-record fields: `accountId` (pinned at creation, never changes —
preserves `claude --continue` history), `parentId` (nesting), `port`
(auto-allocated dev-server port), `setupStatus`, `branchManuallySet` (rename
lock), `divergedFromBase`/`mergedAt`/`unpushedAhead`/`releasedVersions`
(sidebar pills), `contextTokens` (badge seed), `heavyResumePending` (suppresses
blind Enter during a heavy `claude --continue` resume), `markedUnread`
(manual come-back-later bookmark, toggled from the sidebar via
`workspaces:setUnread`, auto-cleared on next selection), and **`host`**
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
- **`startWorkspaceAgentHeadless(id)`** — `workspaces.ts` (used by spawn).
  **STRUCTURED-FIRST**: starts the delegated agent as an SDK session via the
  `sdk-delivery.ts` seam (`sdkStartAndDeliver` → agent-sdk's `sdkWake`/`sdkSend`),
  enqueuing `lastTask` as the opening turn — so a spawned child runs in the
  structured view, and no TUI typing/readiness machinery is involved. Flips
  `hasInput` so a later Raw-tab open resumes (`--continue`) instead of
  re-injecting the task. The legacy headless raw-PTY spawn (below) survives only
  as a fallback when the SDK seam is unregistered or the session fails to start.
- **`submitTaskWhenReady(...)`** — PTY-fallback only. Waits on the SessionStart
  readiness sentinel (`$ORCHESTRA_READY_FILE`, 15s timeout, 1.2s fallback), types
  the task, submits with `\r`, retries up to 4× confirming status left `idle`.
- **`wakeAgentWithPrompt(id, prompt)`** — the live-or-wake delivery used by peer
  messages and the prompt-queue flusher. Order: live SDK session (`sdkDeliver`)
  → live PTY (typed) happens in the callers → **structured wake**
  (`sdkStartAndDeliver`: lazy SDK session resuming `ws.sdkSessionId`, or — for a
  terminal-only workspace — the newest on-disk transcript, adopted as the resume
  id by agent-sdk's `sdkWake`, the same session `--continue` picks) → raw-PTY
  wake with `--continue` as the last fallback. Post-wake "did it survive"
  insurance checks (`dispatchMessageRequest`'s inbox park, prompt-queue's
  re-queue) treat a live SDK session as "still up" (`sdkSessionLive`), since
  `isRunning` is PTY-only and always false for a structured wake.

### Archive / unarchive / delete
- **`archiveWorkspace`** `:534` (soft: stop PTYs, keep worktree+logs),
  **`unarchiveWorkspace`** `:559`, **`deleteWorkspace`** `:450` (hard: runs the
  per-repo archive script best-effort, clears scrollback+inbox, `removeWorktree`,
  removes record, broadcasts `workspace:removed`). Directory removal is
  hard-confined to `ORCHESTRA_ROOT`/`SCRATCH_ROOT`. **Sandbox-hosted** records
  (`:491`) just detach — the container keeps its copy; nothing local to reap.
  The reap steps are factored into **`teardownWorkspace(ws)`** (everything
  except the store-remove + broadcast) so both `deleteWorkspace` and the bulk
  path share them.
- **Cascade:** archive/unarchive an orchestrator and its whole subtree moves
  with it. **`collectWorkspaceTree(id)`** `:517` gathers the root plus every
  transitively `parentId`-nested descendant (BFS, cycle-guarded); both
  `archiveWorkspace`/`unarchiveWorkspace` iterate it, skipping records already in
  the target state, and broadcast a `workspace:update` per changed child so the
  renderer's tree updates live. A child archived on its own stays independent
  until its parent is unarchived.
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

### Resume across restarts (lazy, on first open)
- There is **no startup auto-resume** (an earlier `resumeRunningWorkspaces`
  relaunched every previously-running agent at boot — removed: a restart with
  many live workspaces immediately spawned that many `claude --continue`
  processes). `store.load()` resets persisted `running` → `idle`; the agent
  relaunches with `--continue` (via `pty:start` → `startAgentPty`) the first
  time the user opens the workspace — TerminalView only spawns once its tab is
  visible (fit-dimensions gate, `Terminal.tsx`). During the cold boot the pane
  shows a "Resuming previous session…" pill (see the cold-boot pill in
  [activity-pty-terminal.md](activity-pty-terminal.md)) — Claude paints only
  its splash header while the session reloads, so the pane would otherwise
  look blank for a couple of seconds.

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
| `dispatchSpawnRequest` | `:932` | `/spawn` | Create child workspace + start it as a **structured SDK session** (`startWorkspaceAgentHeadless`; raw-PTY only as fallback). Inherits caller's repo (worktree callers) or requires explicit `repoPath` (scratch/orchestrator callers). Records `parentId` = caller, unless `detached:true` (parentless top-level workspace; repo inheritance from `from` still applies). Optional `model` pins the agent's model on the record (`Workspace.model`, `types.ts`) — the pty passes `claude --model` on every launch, and the SDK structured-session path must mirror it via `options.model`. |
| `dispatchPromoteRequest` | `:1309` | `/promote` | Make a workspace a coordinator (idempotent). **Two routes**: a scratch session swaps `kind` → `'orchestrator'`; a **git worktree keeps its kind and gains `canOrchestrate`**, so it parents children while keeping repo/branch/diff/merge/PR. |
| `dispatchDemoteRequest` | `:1384` | `/demote` | Inverse of promote. Clears `canOrchestrate` and **detaches every child** (a `parentId` pointing at a non-orchestrator renders nowhere). Refuses the `'orchestrator'` KIND — it is repo-less by nature and has no worktree to fall back to. |
| `dispatchAttachRequest` | `:1456` | `/attach` | Re-parent under a coordinator (`canOrchestrate`), or clear `parentId` to detach. **Full-ancestry cycle check**: a promoted worktree can itself have a parent, so A→B→A is reachable and the old bare self-check was no longer sufficient. |
| `dispatchVerifyLandedRequest` | `~:1590` | `/verifyLanded` | **Coordinator close-out check** (read-only): are ALL commits on a child's branch **tip** reachable from the target? Target = explicit `into` ref (repo-less coordinators) or the caller's own branch (`from`, must share the child's repo — the integration-branch case). Backed by `listUnmergedCommits` (git.ts, ref-validates first so a deleted branch fails loudly instead of reading "0 unmerged"; tests in `git-verify-landed.test.ts`). Exists because a child's "done"/"merged" report decays — agents keep committing after they report. NOT LANDED is not always a defect: deliberately-unmerged work (spikes) closes as INTENTIONALLY UNMERGED — the contracts forbid only the *silent* strand. |
| `dispatchWhoamiRequest` | `~:1660` | `/whoami` | A workspace's own record (id/name/branch/kind, `orchestrator` via the `canOrchestrate` helper, `parentId`, repo/base). The only in-band way an agent learns its `parentId` — `/peers` excludes the caller, and a child promoted BY its parent never observes the promotion — which is what makes "at most one sub-orchestrator level" checkable by its addressee. |
| `dispatchPeersRequest` | `:1239` | `/peers` | List other live workspaces (`PeerInfo[]`). `stats: true` adds each git peer's committed three-dot diff vs base (`getBranchDiffShortstat`, git.ts) — opt-in because the comms-resurface hook hits `/peers` every prompt and N git spawns on that path is the per-workspace × per-poll trap. |
| `dispatchReadRequest` | `:1266` | `/read` | Peer branch + last ~80 transcript lines, ANSI-stripped. |
| `dispatchMessageRequest` | `:1353` | `/message` | Deliver to peer: **live** (next turn of a live SDK session, else typed into a running TUI), **started** (structured wake via `wakeAgentWithPrompt`, PTY `--continue` only as fallback), or **inbox** (park in `~/.orchestra/inbox/<id>.txt`; the 5s post-wake insurance counts a live SDK session as delivered). |
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
  rename (~`:89`). Load migrates stale `running`/`stalled` → `idle` (agents
  relaunch lazily on first open, not at startup).
- Methods: `upsertWorkspace`, `removeWorkspace`, `getWorkspace`,
  `reorderWorkspaces`; repo methods `addRepo`/`removeRepo`/
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

The tracked base is `RepoEntry.defaultBranch` — auto-detected at add
(`detectDefaultBranch`, git.ts) and user-configurable from the repo settings
modal via IPC `repos:setDefaultBranch` (index.ts; validates the branch exists,
rebroadcasts `repos:update`, kicks `syncOneRepo`). New workspaces are cut from
it unless `CreateWorkspaceInput.baseBranch` overrides per workspace
(right-click the repo's sidebar "+", or `orchestra spawn --base`).

## Worktree sizes — workspaces.ts `getWorktreeSizes`
Sidebar size badges come from one scan over `ORCHESTRA_ROOT`
(`src/main/workspaces.ts:~230`), returning `WorktreeSizes { sizes, exclusive }`
(`src/shared/worktree-sizes.ts`, which also holds the pure output parsers +
tests). Two scanners: `btrfs filesystem du -s --raw` reporting **exclusive
(reclaimable) bytes** — pnpm reflink-clones packages on btrfs, so a ~580 MB-
looking worktree is often ~2 MB exclusive — with a plain `du -k` apparent-size
fallback (non-btrfs/macOS; `exclusive: false` switches the renderer tooltip).
The btrfs pass gets no page-cache discount (~7 s of extent ioctls every time),
so results are TTL-cached 120 s in main, keyed on the worktree-path set so
add/delete invalidates; renderer polls every 30 s (`App.tsx`) and mostly hits
that cache. Scratch dirs live outside `ORCHESTRA_ROOT` and are never scanned.

## Key invariants
One worktree per workspace · `accountId` pinned for life · `parentId` only
persisted if parent exists (dangling → child floats to repo section) · setup is
async/non-blocking · hooks idempotent (version stamp) · store writes atomic ·
scrollback ring-buffered at 2 MB · all cleanup best-effort.
