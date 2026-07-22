# Main bootstrap, IPC & renderer UI

The Electron main entrypoint, the IPC contract, and the React/Zustand UI.
Files: `src/main/index.ts` (~1136 lines), `src/preload/index.ts`,
`src/shared/ipc.ts`, `src/renderer/` (`App.tsx`, `store.ts`, `chime.ts`,
`debug.ts`, and `components/`).

## Main process — index.ts
Bootstrap order matters; several steps run *before* the window:
- **CLI mode** `:17` — if `cli` is in argv, dynamically import the CLI module and
  exit (never touches GUI/store).
- **Ozone platform** `:36` — decide Wayland vs X11 from `WAYLAND_DISPLAY` vs
  `ELECTRON_OZONE_PLATFORM_HINT`; if mismatched, relaunch (guarded by
  `ORCHESTRA_OZONE_RELAUNCHED`). Fixes HiDPI blur / white-screen on Wayland.
- **Shell env merge** `:95` — `$SHELL -ilc env` (via `shell-env`) so PATH/MCP
  secrets reach agent PTYs and scripts even when launched from a desktop icon.
- **`ORCHESTRA_HOME`** `:128` — relocate userData + events spool (dev isolation);
  must run before `import {store}`.
- **Window** `:253` — 1400×900, `contextIsolation:true`, `nodeIntegration:false`,
  preload. Starts subsystems: hooks server `:292`, events spool `:294`, usage
  pollers `:296`/`:298`; background: orphan prune `:317`, agent resume `:338`,
  base-branch sync, Linear watchers.
- **Renderer/GPU crash recovery** (in `createMainWindow`) — handles two
  distinct "the content area went black" failure modes via a shared
  `guardedReload(why)` helper (log, wait 1s, `webContents.reload()`; main-side
  state — store, PTYs, spool — survives so the UI rehydrates in place):
  - `render-process-gone` — the renderer PROCESS died (OOM SIGKILL, segfault);
    Chromium otherwise leaves its white "sad tab" page until manual relaunch.
  - `child-process-gone` with `type === 'GPU'` (registered inside
    `createMainWindow`, torn down on `mainWindow 'closed'`) — the renderer
    survives but every WebGL context is lost at once and the compositor leaves a
    BLACK content surface (window chrome still painted). This is the reported
    "app turns black, must restart" and logs NOTHING under the old handler (no
    process died). Reloading re-establishes the GL contexts.
  - `unresponsive`/`responsive` — logged only (a wedged-but-live renderer also
    paints black; no safe auto-reload, but the log dates the occurrence).
  Shared crash-loop guard: >3 reloads in 60s stops auto-reloading. A SECOND,
  diagnostic-only `app.on('child-process-gone')` outside `createMainWindow`
  logs every helper death as a breadcrumb.
  The root stressor — one WebGL context per open workspace — is bounded on the
  renderer side by the mounted-pane LRU cap (see `computeMountedIds` /
  `MAX_MOUNTED_PANES` in App.tsx + `src/shared/mounted-panes.ts`): only the 12
  most-recently-used workspaces keep a `TerminalView`/`StructuredView` mounted;
  older ones unmount (releasing their WebGL context) and cold-boot on reopen.
- **Single-instance lock** `:1011` — second instance `app.exit(0)`; primary
  focuses. Dev `ORCHESTRA_HOME` gets a separate lock so dev+packaged coexist.
- **IPC wrapper** `handle()` `:228` — logs every handler failure with its channel
  name before re-throwing.

IPC handlers: the request/response BODIES live in the shared table
`src/main/api-handlers.ts` (keyed by `OrchestraAPI` member name — repos,
workspaces CRUD, sandbox, PTY (`ptyStart` idempotent + heavy-resume gate;
`ptyWrite` flips `hasInput` and applies the heavy-resume keystroke
suppression), git (stats poll piggybacks merge+branch refresh; findPR
piggybacks release detection), scripts, linear, accounts, usage, plus the
ui-rpc-added `deps:status`/`app:info`/`pty:scrollback`). index.ts wires the
table to its historical channels in one loop over `METHOD_IPC_CHANNELS`
(every registration still goes through the logging `handle` wrapper);
`dialog:pickDir` stays an inline Electron-only handler. The SAME table backs
the ui-rpc socket server for external frontends — see
[ui-rpc-backend.md](ui-rpc-backend.md). Startup also acquires the shared
backend lock (app↔daemon mutual exclusion), starts the ui-rpc server, wires
`startSandboxAutoBackup`, probes dependencies (deps.ts → warning dialog), and
closes all sandbox connections on quit. Main-side modules broadcast via
`platform.broadcast(channel, …)` (the seam) instead of `webContents.send` —
no module takes a `BrowserWindow` parameter anymore.

## IPC contract — preload + ipc.ts
`src/shared/ipc.ts` defines the `OrchestraAPI` interface (the full renderer↔main
contract: repos, linear, accounts, workspaces, PTY, git/diff, scripts, and event
subscriptions). `preload/index.ts` implements it over `ipcRenderer.invoke`/`on`
and exposes it as `window.orchestra` via `contextBridge`. Event listeners return
an unsubscribe fn and adapt Electron's `(event, …args)` to `(…args)`. Push
channels include `workspace:update`, `agent:finished`, `agent:needsInput`,
`agent:tool`, `agent:context`, `repo:syncState`, `usage:update`,
`accounts:usageUpdate`, `accounts:workspaceAccounts`, `repos:update`, and
`sandbox:control` (cross-machine ownership broadcasts).

## Renderer state — store.ts (Zustand, ~479 lines)
Single source of truth; **atomic selectors** so high-frequency events
(`agent:tool`, `repo:syncState`) don't re-render unrelated components. State:
`repos`, `workspaces`, `accounts`, `globalUsage`, and per-workspace derived maps
`stats`/`sizes` (+`sizesExclusive`: btrfs reclaimable-bytes vs apparent-`du`
flag, drives the size-badge tooltip; active rows hide the badge below
`SIZE_BADGE_MIN_BYTES` (50 MB) so the wrapping badge doesn't add a line of
noise per row)/`prs`/`linear`/`tools`/`contextTokens`/`repoSync`/`accountUsage`/
`workspaceAccounts`, plus UI (`activeId`, `openHistory`, `view`, `loaded`).
`openHistory` is a session-only most-recently-opened-first stack of workspace
ids (pushed in `setActive` via `pushHistory`); when the active workspace
disappears (archive/delete/`onWorkspace(s)Removed`), the fallback selection uses
`pickFallbackActive` (`active-fallback.ts`, pure + node-tested) to reopen the
*previous* workspace instead of snapping to the first sidebar row. `load()` `:115`
hydrates in parallel and seeds context badges from persisted `contextTokens`.
Refreshers (`refreshAllStats`/`Sizes`/`AllPRs`/`AllLinear`, `:292+`) are driven
by **visibility-aware polls** and commit once. Live event subscriptions `:381+`
patch state (note `onWorkspaceUpdate` merges to avoid clobbering a local create).

`agentSessions: Record<wsId, AgentSession>` holds the folded structured-agent-view
state (Claude Agent SDK). The `agent:event` channel is the app's **hottest** —
streaming token deltas — so the `onAgentEvent` subscription does **not** setState
per event: it pushes into a module-scope **RAF-batched queue**
(`agent-event-queue.ts`, pure + node-tested) that coalesces a frame's events and
folds them via pure `foldEvents` (`src/shared/agent-events.ts`) in one commit.
`__injectAgentEvent(wsId, event)` is a dev/verifier seam routing a synthetic event
through the same fold path. `view` union includes `'structured'`; sessions are
pruned in `onWorkspaceRemoved`/`onWorkspacesRemoved` alongside `contextTokens`.

## StructuredView.tsx — structured agent view (renderer skeleton)
Container for the SDK-driven agent view, kept **always-mounted per workspace**
(like `TerminalView`, hidden via `.av-view`/`.active`) so folded session + scroll
survive tab switches. A **virtualized** (windowed, measured-height + overscan)
message list reads `store.agentSessions[wsId]`; a composer calls
`agentSdkSend` (which **lazily starts** the session — no separate start IPC);
`agentSdkInterrupt` wires the Stop button. Message/tool/permission bodies are
**placeholder slots** (extension points): message+tool bubbles, permission
dialog, and the model/mode/turn-footer controls are filled by later swarm
agents. All classes are `av-*`-prefixed; structural defaults live in
`agent-view.css` (design system owned separately).

## App.tsx (~606 lines)
Grid layout `[sidebar | resizer | main]` + `DialogHost`. Persists sidebar/nvim
widths to localStorage; resizes via rAF. `startVisiblePoll` runs a fn on an
interval but **stops when the document is hidden** (re-fires on visible) — this
is what pauses git/gh/du/Linear polling when minimized. Toolbar is grouped by
function: the base→feature branch chip (with `BranchPicker`) on the left, then
a **views group** (`.toolbar-views`: Terminal/Diff/Run tabs + the nvim
pane-toggle), a hairline `.toolbar-sep`, and an **actions group**
(`.toolbar-actions`: restart-agent, run play/stop, PR button as the rightmost
CTA). Each `TerminalView` for the **12 most-recently-used** workspaces is kept
mounted (preserves xterm scrollback across switches) — capped by the LRU
`computeMountedIds` / `MAX_MOUNTED_PANES` to bound live WebGL contexts (see
crash-recovery note above); older panes unmount and cold-boot on reopen.
Diff/Run mount only when selected.

## Sidebar.tsx (~2100 lines — the big one)
Workspace list with orchestrator nesting, drag-reorder, archive, delete.
- **Header**: title + three quiet icon buttons (help / sound / accounts) and a
  single accent-tinted **“+ New” menu** (`.new-menu`) holding the three session
  kinds (repo workspace / scratch / orchestrator) — replaces the old trio of
  labeled header buttons; closes on outside click or Escape. Section headers
  keep per-kind `+` shortcuts.
- **Footer strip** (bottom of the aside, in order): env notices →
  `InsightsSection` row → `UsageBars` (a single compact `.usage-strip` row —
  login label + 5h/7d/Fable cells, per-account breakdown on the hover panel) →
  an icon-only `.sidebar-footer` (Resources toggle, GitHub, Logs, Linear behind
  tooltips) + version.
- **Styling**: quiet glyph buttons all share one `.icon-btn` recipe in
  styles.css (header icons, `.ws-icon-btn` row actions, `.repo-scripts-btn`,
  overlay close ×'s); repo-header gear/GitHub icons are hover/focus-revealed.
- **SpawnForest** models orchestrator→children (`childrenOf`, `roots`,
  `rootOf`); `TreeRow = {ws, depth}`.
- Sections: orchestrator trees (top) → scratch trees → repo groups (git
  workspaces threaded as spawn trees) → archived (collapsible, multi-select
  delete). Collapse + dismissed env-notices persist to localStorage. The
  Orchestrators and Scratch sections are both spawn trees of their ROOTS
  (orchestrator-kind / scratch-kind forest roots + `flattenSubtree`), rendered
  by the shared `renderSpawnTreeRows` helper — so an agent spawned FROM a plain
  scratch session nests indented under it (it has a live parent, so it's not a
  forest root and repo sections never see it). Both section count badges show
  root count, not total rows.
- **Subtree collapse** (orchestrator + scratch sections): any row with spawned
  children gets a per-row caret (`.ws-collapse`) that folds its subtree — the
  depth-first rows are filtered at render time (skip rows deeper than a
  collapsed node until the walk climbs back). Persists as
  `orchestra.collapsedOrchestrators` (workspace ids). A collapsed row shows a
  `.ws-hidden-count` pill (hidden descendant count via `collectDescendants`)
  tinted by the most urgent hidden status (error > waiting > running).
- **Host grouping**: within a repo, rows bucket per machine/sandbox node via
  `host-grouping.ts` `groupByHost` (returns null when all-local → flat list
  byte-identical to pre-sandbox); collapsible `.host-group-header` per node.
- Drag-reorder for workspaces and repos (`reorderWorkspaces`/`reorderRepos`).
- Row actions: rename branch (inline), unread bookmark toggle (`UnreadToggle`
  → store `setUnread` → IPC `workspaces:setUnread`; sets `ws.markedUnread`,
  shown by turning the leading activity dot accent-blue (`.ws-dot.unread`,
  overrides the status color) + bold name, auto-cleared by the store's
  `setActive` when the user next selects the row), archive/unarchive, delete
  (confirm + bulk progress), switch branch (`BranchPicker`), setup gear
  (`RepoScriptsModal`), ☁↑ import-to-sandbox (`onImportToSandbox` `:800`,
  endpoint prompt) / ☁↓ eject (`onEjectFromSandbox` `:823`) — one or the other
  by `w.host`.
- Env notices come from `getEnvStatus` (`EnvStatusItem`) —
  generic so new integration checks need no renderer change.

## Other components
- **(removed) Diff tab / DiffView.tsx** — the Electron renderer's Monaco-based
  diff viewer was removed (Monaco was the heaviest thing the agent view mounted
  and drove the GPU-crash black screen). Change size still shows as `+N −M`
  badges on every sidebar row (from the separate `getDiffStats` poll, kept). The
  backend `getDiff` method survives as an `ExtraApiMethods` entry because the
  native GTK frontend still has its own diff view.
- **BranchPicker.tsx** — toolbar branch-switch dropdown, fetches `listBranches`,
  current branch first. Its searchable list is the exported
  `BranchPopoverPanel`, reused by every branch-choosing surface.
- **NewWorkspaceBranchPopover.tsx** — right-click on a repo's sidebar "+"
  opens this portal'd `BranchPopoverPanel` (fixed viewport coords — escapes the
  sidebar's overflow clip + backdrop-filter containing block) to create a
  workspace from a chosen base branch (`createWorkspace({repoPath, baseBranch})`;
  plain click keeps the repo's default). Branches come from
  `repos:listBranches` (by repo path, unlike `git:listBranches` by ws id).
- **NvimView.tsx** — same xterm pattern for a `<wsId>:nvim` PTY (`nvim .`),
  resizable pane.
- **Dialog.tsx** — Zustand-backed modal: `dialog.alert/confirm/error/success`
  (Promise<boolean>) plus `dialog.prompt` (single-line text input →
  Promise<string|null>; used for the sandbox endpoint), tone
  info/success/warning/danger, Enter/Esc.
- **SandboxControlBar.tsx** — amber read-only bar above the terminal when
  another machine drives the workspace's sandbox, with a Take-control button
  (mounted in App.tsx beside SetupBanner; see
  [sandbox-transport.md](sandbox-transport.md)).
- **Help.tsx** — `HelpView`, the in-app feature guide: a main-pane overlay
  (same absolute-overlay contract as `InsightsView`, so kept-alive terminals
  never unmount) with static per-feature-area content and an external link to
  `docs/guide/`. Opened via the sidebar header's `?` button or the welcome
  screen's "Everything Orchestra can do" button; state is the store's
  `helpOpen` flag — mutually exclusive with `insightsOpen` (opening one closes
  the other; `setActive` closes both). The welcome empty state in `App.tsx`
  also renders a `welcome-features` highlight grid.
- **RepoScriptsModal.tsx** — edit setup/run/archive scripts, account assignment,
  and the repo's default base branch (select fed by `repos:listBranches`, saved
  via `repos:setDefaultBranch` — main validates the branch exists, rebroadcasts
  `repos:update`, and re-syncs the repo's sync pill). Also hosts the repo's
  **danger zone**: “Remove from Orchestra” (enabled only when the repo has no
  workspaces; Sidebar passes `canRemove`/`onRemove`) — the destructive action
  moved here from the repo header's inline trash button.
- **SetupBanner.tsx** — overlay while `setupStatus` running/failed, with log +
  retry.
- **PromptQueueBanner.tsx** — shown above the pane row while the active
  workspace's account is over its usage limit (or prompts are still queued):
  composer parks prompts on `ws.queuedPrompts` via `queue:add`, list with
  per-item remove (`queue:remove`) and "Send now" (`queue:flush`). Limit state
  computed renderer-side with the shared `usageLimitedUntil`; delivery/auto-
  flush live in main (see
  [accounts-usage.md](accounts-usage.md) "Prompt queue").

## chime.ts (~517 lines) & debug.ts
**chime.ts** synthesizes ~20 notification sounds with the Web Audio API (no
shipped assets); `playFinishedChime()` plays the selected sound when
`agent:finished` fires and the workspace isn't focused (picker in
`SoundSettings.tsx`, selection in localStorage). **debug.ts** — `window.orchestraDebug(true)`
toggles renderer activity-pipeline logging (persisted, reloads).
