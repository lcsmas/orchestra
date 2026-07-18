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
- **Single-instance lock** `:1011` — second instance `app.exit(0)`; primary
  focuses. Dev `ORCHESTRA_HOME` gets a separate lock so dev+packaged coexist.
- **IPC wrapper** `handle()` `:228` — logs every handler failure with its channel
  name before re-throwing.

IPC handlers (all via `handle`): repos, workspaces CRUD `:598+`, sandbox
(`workspaces:importToSandbox` `:643`, `workspaces:ejectFromSandbox` `:647`,
`sandbox:backup` `:651`, `sandbox:controlState`/`takeControl` `:655`/`:661` —
see [sandbox-transport.md](sandbox-transport.md)), PTY
(`pty:start` idempotent + heavy-resume gate; `pty:write` flips `hasInput`
and applies the heavy-resume keystroke suppression), git
(`git:diff`/`stats`/`findPR`/`merge`/`switchBranch` — stats poll piggybacks
merge+branch refresh; findPR piggybacks release detection), scripts,
linear, accounts (incl. `accounts:loginStart`), usage,
dependency checks (probes git/gh/claude, warns if missing). Startup also wires
`setSandboxWindow` + `startSandboxAutoBackup` (`:314`/`:318`) and closes all
sandbox connections on quit.

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
`workspaceAccounts`, plus UI (`activeId`, `view`, `loaded`). `load()` `:115`
hydrates in parallel and seeds context badges from persisted `contextTokens`.
Refreshers (`refreshAllStats`/`Sizes`/`AllPRs`/`AllLinear`, `:292+`) are driven
by **visibility-aware polls** and commit once. Live event subscriptions `:381+`
patch state (note `onWorkspaceUpdate` merges to avoid clobbering a local create).

## App.tsx (~606 lines)
Grid layout `[sidebar | resizer | main]` + `DialogHost`. Persists sidebar/nvim
widths to localStorage; resizes via rAF. `startVisiblePoll` runs a fn on an
interval but **stops when the document is hidden** (re-fires on visible) — this
is what pauses git/gh/du/Linear polling when minimized. Toolbar is grouped by
function: the base→feature branch chip (with `BranchPicker`) on the left, then
a **views group** (`.toolbar-views`: Terminal/Diff/Run tabs + the nvim
pane-toggle), a hairline `.toolbar-sep`, and an **actions group**
(`.toolbar-actions`: restart-agent, run play/stop, PR button as the rightmost
CTA). Each `TerminalView` is kept mounted per workspace (preserves xterm
scrollback across switches); Diff/Run mount only when selected.

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
- **DiffView.tsx** — Monaco `DiffEditor` (read-only, side-by-side), file list
  with +/- badges, 4s poll preserving selection, `guessLanguage` by extension.
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
