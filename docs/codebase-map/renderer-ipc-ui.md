# Main bootstrap, IPC & renderer UI

The Electron main entrypoint, the IPC contract, and the React/Zustand UI.
Files: `src/main/index.ts` (~1077 lines), `src/preload/index.ts`,
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

IPC handlers (all via `handle`): repos `:542`, workspaces CRUD `:580`, PTY
`:619` (`pty:start` idempotent + heavy-resume gate; `pty:write` flips `hasInput`
and applies the heavy-resume keystroke suppression), git `:752`
(`git:diff`/`stats`/`findPR`/`merge`/`switchBranch` — stats poll piggybacks
merge+branch refresh; findPR piggybacks release detection), scripts `:863`,
linear `:395`, accounts `:422` (incl. `accounts:loginStart` `:463`), usage `:415`,
dependency checks `:923` (probes git/gh/claude, warns if missing).

## IPC contract — preload + ipc.ts
`src/shared/ipc.ts` defines the `OrchestraAPI` interface (the full renderer↔main
contract: repos, linear, accounts, workspaces, PTY, git/diff, scripts, and event
subscriptions). `preload/index.ts` implements it over `ipcRenderer.invoke`/`on`
and exposes it as `window.orchestra` via `contextBridge`. Event listeners return
an unsubscribe fn and adapt Electron's `(event, …args)` to `(…args)`. Push
channels include `workspace:update`, `agent:finished`, `agent:needsInput`,
`agent:tool`, `agent:context`, `repo:syncState`, `usage:update`,
`accounts:usageUpdate`, `accounts:workspaceAccounts`, `repos:update`.

## Renderer state — store.ts (Zustand, ~479 lines)
Single source of truth; **atomic selectors** so high-frequency events
(`agent:tool`, `repo:syncState`) don't re-render unrelated components. State:
`repos`, `workspaces`, `accounts`, `globalUsage`, and per-workspace derived maps
`stats`/`sizes`/`prs`/`linear`/`tools`/`contextTokens`/`repoSync`/`accountUsage`/
`workspaceAccounts`, plus UI (`activeId`, `view`, `loaded`). `load()` `:115`
hydrates in parallel and seeds context badges from persisted `contextTokens`.
Refreshers (`refreshAllStats`/`Sizes`/`AllPRs`/`AllLinear`, `:292+`) are driven
by **visibility-aware polls** and commit once. Live event subscriptions `:381+`
patch state (note `onWorkspaceUpdate` merges to avoid clobbering a local create).

## App.tsx (~606 lines)
Grid layout `[sidebar | resizer | main]` + `DialogHost`. Persists sidebar/nvim
widths to localStorage; resizes via rAF. `startVisiblePoll` runs a fn on an
interval but **stops when the document is hidden** (re-fires on visible) — this
is what pauses git/gh/du/Linear polling when minimized. Toolbar: base→feature
branch chip (with `BranchPicker`), Terminal/Diff/Run tabs, restart-agent, run
toggle, PR button, nvim toggle. Each `TerminalView` is kept mounted per workspace
(preserves xterm scrollback across switches); Diff/Run mount only when selected.

## Sidebar.tsx (~1746 lines — the big one)
Workspace list with orchestrator nesting, drag-reorder, archive, delete.
- **SpawnForest** `:393` models orchestrator→children (`childrenOf`, `roots`,
  `rootOf`); `TreeRow = {ws, depth}`.
- Sections: orchestrator trees (top) → scratch sessions → repo groups (git
  workspaces threaded as spawn trees) → archived (collapsible, multi-select
  delete). Collapse + dismissed env-notices persist to localStorage.
- Drag-reorder for workspaces and repos (`reorderWorkspaces`/`reorderRepos`).
- Row actions: rename branch (inline), archive/unarchive, delete (confirm +
  bulk progress), switch branch (`BranchPicker`), setup gear (`RepoScriptsModal`).
- Env notices come from `getEnvStatus` (`EnvStatusItem`, `types.ts:241`) —
  generic so new integration checks need no renderer change.

## Other components
- **DiffView.tsx** — Monaco `DiffEditor` (read-only, side-by-side), file list
  with +/- badges, 4s poll preserving selection, `guessLanguage` by extension.
- **BranchPicker.tsx** — dropdown, fetches `listBranches`, filter + arrow-key nav,
  current branch first.
- **NvimView.tsx** — same xterm pattern for a `<wsId>:nvim` PTY (`nvim .`),
  resizable pane.
- **Dialog.tsx** — Zustand-backed modal: `dialog.alert/confirm/error/success`
  (Promise<boolean>), tone info/success/warning/danger, Enter/Esc.
- **RepoScriptsModal.tsx** — edit setup/run/archive scripts + account assignment.
- **SetupBanner.tsx** — overlay while `setupStatus` running/failed, with log +
  retry.

## chime.ts (~517 lines) & debug.ts
**chime.ts** synthesizes ~20 notification sounds with the Web Audio API (no
shipped assets); `playFinishedChime()` plays the selected sound when
`agent:finished` fires and the workspace isn't focused (picker in
`SoundSettings.tsx`, selection in localStorage). **debug.ts** — `window.orchestraDebug(true)`
toggles renderer activity-pipeline logging (persisted, reloads).
