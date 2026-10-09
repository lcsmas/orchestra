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
  An AppImage build re-execs `APPIMAGE_PATH` itself rather than using
  `app.relaunch()`, whose relauncher execs only after we exit — by which point
  the FUSE mount is gone.
- **Strip process-local env** `:96` — `stripProcessLocalEnv(process.env)`
  (`src/shared/child-env.ts`) deletes `APPIMAGE`/`APPDIR`/`ARGV0`/`OWD`/
  `ORCHESTRA_OZONE_RELAUNCHED` once the ozone step (their last legitimate
  consumer) is done. Every child — agent PTYs, per-repo run/setup/archive
  scripts, the SDK subprocess — inherits `process.env` wholesale, and an
  inherited `APPIMAGE` tells a child Electron "you are the packaged app": a
  workspace running `pnpm dev` on Orchestra itself re-exec'd the INSTALLED
  AppImage and exited, so the Run tab silently launched the shipped binary
  instead of the worktree. One choke point covers every present and future
  spawn site. `ORCHESTRA_OZONE` is deliberately KEPT (the user's platform
  choice should apply to a dev build too); `src/main/app-image.ts` captures
  `APPIMAGE` at import time for the two places that still need it (the relaunch
  above, the CLI shim).
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
piggybacks release detection), scripts, linear, accounts, usage, deps).
index.ts wires the table to its historical channels in one loop over
`METHOD_IPC_CHANNELS` (every registration still goes through the logging
`handle` wrapper); `dialog:pickDir` stays an inline handler. Startup also
wires `startSandboxAutoBackup`, probes dependencies (deps.ts → warning
dialog), and closes all sandbox connections on quit. Main-side modules
broadcast via `platform.broadcast(channel, …)` (the seam) instead of
`webContents.send` — no module takes a `BrowserWindow` parameter anymore.

## IPC contract — preload + ipc.ts
`src/shared/ipc.ts` defines the `OrchestraAPI` interface (the full renderer↔main
contract: repos, linear, accounts, workspaces, PTY, git/diff, scripts, and event
subscriptions). `preload/index.ts` implements it over `ipcRenderer.invoke`/`on`
and exposes it as `window.orchestra` via `contextBridge`. Event listeners return
an unsubscribe fn and adapt Electron's `(event, …args)` to `(…args)`. Push
channels include `workspace:update`, `agent:finished`, `agent:needsInput`,
`agent:tool`, `agent:context`, `repo:syncState`, `usage:update`,
`accounts:usageUpdate`, `accounts:workspaceAccounts`, `repos:update`,
`sandbox:control` (cross-machine ownership broadcasts), and `human-gates:update`
(#161 — the open human-directed decision gates, rebuilt from the bus DB), and `pause:update` (#257 — the whole fleet-Pause overview, rebuilt from the bus; the `pause:*` write channels are registered by `src/main/pause-ui-host.ts`, NOT through the read-only bus-pane registrar).

## Renderer state — store.ts (Zustand, ~479 lines)
Single source of truth; **atomic selectors** so high-frequency events
(`agent:tool`, `repo:syncState`) don't re-render unrelated components. State:
`repos`, `workspaces`, `accounts`, `globalUsage`, and per-workspace derived maps
`stats`/`sizes` (+`sizesExclusive`: btrfs reclaimable-bytes vs apparent-`du`
flag — read only by the Resources page, which is also the only thing that
polls it; the sidebar has no size badge)/`prs`/`checks` (CI verdicts, 30s `refreshAllChecks` poll —
red `.ci-badge` on fail only, click hands the run to the agent via
`git:fixChecks`)/`linear`/`tools`/`contextTokens`/`repoSync`/`accountUsage`/
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

**Derived maps must be invalidated by the event that changes their source.**
`prs` is derived from `Workspace.linkedPrs` but cached separately on the 12s
poll, and `onWorkspaceUpdate` originally patched `workspaces` without touching
it — so `orchestra link` took a full poll interval to show its badge (measured
~9.0s to link, ~10.9s to clear), which reads as the command having failed. The
handler now calls `refreshPR(id)` when the linked-PR URLs differ, compared
BEFORE the state write (afterwards the previous value is gone). The gate
matters: the same channel carries status-dot transitions, which arrive
constantly, and each refresh costs a `gh` call per linked PR — firing
unconditionally would put the PR poll on the status-dot cadence. Note
`onWorkspaceRemoved` already prunes `prs`/`checks`/`linear`/`stats`; the update
path is the one that needed the equivalent. **Removed-id tombstone (#205):** both
removal handlers record ids in `removed-workspaces.ts`, and the update handler
drops any `workspace:update` for a recorded id — it UPSERTS unknown ids, so a
stale update after `workspace:removed` would otherwise paint a ghost row.

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

### The pane height chain is load-bearing — don't "tidy" it
`.app` → `.main` → `.pane-row` → `.pane` must each stay height-constrained, or
scroll containers inside a pane silently stop scrolling. Two declarations do the
work, and BOTH are guarded by `src/renderer/pane-scroll-chain.test.ts`:
`.app { grid-template-rows: minmax(0, 1fr) }` (styles.css:~534) and
`.main { min-height: 0 }` (styles.css:~2709, the same declaration `.sidebar`
carries — they are the two grid items, and it is redundant on neither).

Why: `.app` is a `height: 100vh` grid whose single row was implicit, i.e. `auto`,
i.e. **sized from its items' content**. A grid item without `min-height: 0` has
an automatic minimum size of its content's height, so a pane taller than the
window grew the ROW past 100vh — `.app` itself kept `height: 100vh` and merely
overflowed, invisibly, because `#root` is `overflow: hidden`. `.pane-row`/`.pane`
then faithfully divided up an already-oversized box and `.diff-scroll` ended with
`clientHeight === scrollHeight`. Measured in the real app: `.main` 3789px in a
971px viewport, diff unscrollable; with the fix, 971px and it scrolls.

This hid for a long time because **`.terminal-pane` and `.av-view` are
`position: absolute; inset: 0`** and contribute ZERO intrinsic height — DiffPane
(`.pane.diff-pane`, in normal flow) was the first pane whose content is
arbitrarily tall. Note `overflow: hidden` on `.pane` does NOT fix this: overflow
does not change a box's intrinsic contribution to grid track sizing.

Grid layout `[sidebar | resizer | main]` + `DialogHost`. Hosts the app's first
GLOBAL shortcut: **Ctrl/Cmd+J toggles the Jump Palette**
(`components/JumpPalette.tsx` — fuzzy jump across live workspaces, recents-first
on empty query via `openHistory`, ranking in the pure `shared/jump-rank.ts`).
The capture-phase window listener deliberately ignores plain Ctrl+J while focus
is inside an xterm (the terminal owns `^J` = LF); Ctrl+Shift+J works from
anywhere, terminals included. Persists sidebar/nvim
widths to localStorage; resizes via rAF. `startVisiblePoll` runs a fn on an
interval but **stops when the document is hidden** (re-fires on visible) — this
is what pauses git/gh/du/Linear polling when minimized. Toolbar is grouped by
function: the base→feature branch chip (with `BranchPicker`) on the left, then
a **views group** (`.toolbar-views`: Terminal/Structured/Run tabs + the nvim
pane-toggle), a hairline `.toolbar-sep`, and an **actions group**
(`.toolbar-actions`: restart-agent, run play/stop, and the `PR #N` link as the
rightmost button — rendered ONLY when the workspace has an open PR; there is no
"Open PR" create button and no unpushed-commits primed state, #229).
**Tab availability by kind** (`isScratch = isScratchLike(active)`, true for
BOTH scratch and orchestrator): Terminal and **Structured** show for EVERY kind —
the structured/SDK path is kind-agnostic (agent-sdk.ts appends the
`ORCHESTRATOR_BRIEF` for orchestrators), so scratch and orchestrator sessions get
the structured agent view too. Only the **git-only** surfaces are gated off for
scratch-like: the **Run** tab/button, the **Diff/PR** actions. The
force-view effect only redirects away from `view === 'run'` on a scratch-like
session (not from `structured`, which is always valid). Each `TerminalView`/
`StructuredView` for the **12 most-recently-used** workspaces is kept mounted
(preserves xterm scrollback / structured scroll offset across switches) — capped
by the LRU `computeMountedIds` / `MAX_MOUNTED_PANES` to bound live WebGL contexts
(see crash-recovery note above); older panes unmount and cold-boot on reopen. The
StructuredView panes mount for every mounted workspace regardless of kind; Run
mounts only when selected.

## Sidebar.tsx (~2100 lines — the big one)
Workspace list with orchestrator nesting, drag-reorder, archive, delete.
- **Header inbox** (`InboxBell.tsx`, first header action): Orca-style
  "Needs You" triage — badge counts workspaces with status waiting/error plus
  bookmarks (pure grouping in `shared/attention.ts`); the popover lists
  needs-you / bookmarked / working groups, click jumps (which itself clears
  the signals via markSeen/setActive — no read-state kept).
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
  overlay close ×'s).
- **Hover actions float, they don't reserve width.** A workspace row's actions
  (unread / sandbox import-eject / archive) live in `.ws-row-actions` and a repo
  header's gear+GitHub in `.repo-header-tools` — both `position:absolute`
  `z-index:3` pills (`border-radius:999px`, `--bg-4`, drop shadow) revealed by
  `:hover`/`:focus-within` on the row/header. They are OUT of flow on purpose:
  when these buttons sat in the flex row at `opacity:0` they still consumed
  ~66px (rows) / ~44px (headers) at rest, which read as a permanent dead gap to
  the right of every branch name and between a repo's count and its `+`.
  `.ws-item` is `position:relative` to anchor its pill. Archived rows
  deliberately render their buttons OUTSIDE the pill (inline, always visible) —
  that list is the delete-candidates view.
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
  children gets a **right-aligned** chevron (`.ws-chevron`, `ChevronIcon`) that
  folds its subtree — the depth-first rows are filtered at render time (skip
  rows deeper than a collapsed node until the walk climbs back). Persists as
  `orchestra.collapsedOrchestrators` (workspace ids). In the PINNED sections a
  collapsed row shows a `.ws-hidden-count` pill (hidden descendant count via
  `collectDescendants`) tinted by the most urgent hidden status
  (error > waiting > running). REPO rows carry no such pill: their
  `.orchestrator-pill` glyph count is itself recursive (`collectDescendants`,
  not `kids.length`), so a separate badge only repeated the same number on a
  flat tree — the glyph takes over the urgency tint when collapsed
  (`.orchestrator-pill.running/.waiting/.error`).
  The chevron is rendered ONLY on rows that have children and lives at the row's
  right edge, so no left gutter is reserved on leaf rows; `.ws-row-actions`
  shifts to `right: 26px` on such rows (`.ws-item:has(.ws-chevron)`) so the
  hover strip does not cover it.
- **Row actions float OUTSIDE the sidebar** (`components/RowActionsPopover.tsx`).
  Bookmark/archive/delete/sandbox buttons render in a PORTAL to `<body>`,
  `position: fixed`, anchored to the hovered row's measured rect and offset past
  the sidebar's right edge. They used to be an absolutely-positioned strip
  inside the row, sitting on top of the row's own clickable content (account
  badge, PR/Linear badges, chevron) — reaching for a badge could hit Delete. A
  portal is required, not stylistic: `.ws-list` scrolls (clips) and `.app` is a
  grid, so in-row layout cannot paint past the sidebar. `useRowActionsPopover`
  holds hover intent — a ~220ms close delay so the pointer can cross the gap,
  cancelled when it lands on the popover; `.ws-list`'s `onScroll` hides it
  immediately since the anchor rect goes stale. ARCHIVED rows keep the old
  inline `.ws-row-actions` strip (that list is the delete-candidates view).
- **Child rows hide a login that matches their parent's**
  (`WorkspaceRowAccountBadge` + `useInheritsParentAccount`, AccountBadge.tsx).
  A child inherits its parent's account unless migrated, so repeating it on
  every nested row is noise; it reappears the moment it DIFFERS. Both sides
  resolve `accountId ?? null` the same way the badge does — `null` means "the
  default login" and is a real comparable value, so comparing the raw store
  field would make an unpinned child look different from an unpinned parent.
- **`LinearIcon` is Linear's real mark** — the four-band sliced disc (path from
  simple-icons), NOT the rotated square it used to be. It is a FILLED path, so
  it deliberately does not spread `ICON_PROPS` (`fill: none` + stroke would
  outline each band or render nothing). The PR icons are genuine lucide
  `git-pull-request` / `git-merge` / `git-pull-request-closed` shapes.
- **`.ws-name` has a `min-width` floor** (7.5em, 5em under 1100px). With enough
  badges the branch name was shrinking to ~40px — a couple of characters, i.e.
  an unidentifiable row. The floor makes the BADGES yield space first; they are
  fixed-size marks that survive being pushed out of view better than a nameless
  row does.
- **Every badge in `.ws-pills` is a flat glyph + number** — no pill chrome. PR
  and Linear badges get this from `.ws-item .pr-badge` (border/background/padding
  stripped); `.released-pill` and `.unpushed-pill` are authored flat outright
  (`ReleaseTagIcon`/`UnpushedIcon`, both Lucide on the shared 24-viewBox
  `ICON_PROPS`). Colour alone carries state: green shipped, amber ready-to-push.
  A bordered chip beside a flat badge reads a size larger and pulls rank from
  the branch name, which is what the previous filled release/unpushed pills did.
  **Only the newest release renders**, with older ones collapsed into a dim
  `.released-more` `+N` (full list on the `title`), mirroring `.pr-badge.more`
  for extra PRs — `releasedVersions` is oldest-first, so newest is the LAST
  element. There is no standalone "merged" pill: `mergedAt` is conveyed by the
  merged PR badge, and the pill duplicated it.
- **PR/Linear badges are NOT gated on being a git row; CI is.** In
  `renderSpawnTreeRows` the `.ws-pills.mini` strip renders unconditionally, with
  only `<CiBadge>` still behind `childIsGit` (`isChild && !isScratchLike(w)`).
  The two badge families answer different questions: PR/Linear links are
  AGENT-REPORTED (`orchestra link --pr`, stored in `linkedPrs` with their own
  `owner/repo/number`), so `findPR` deliberately dropped every `kind`/`repoPath`
  guard — an orchestrator coordinating a metarepo milestone owns the submodule
  PRs while having no repo or branch itself. CI, by contrast, needs a branch to
  query, and `findChecks` hard-returns `{state:'none'}` for scratch/orchestrator
  rows. Gating the whole strip on `childIsGit` hid PR badges on exactly the rows
  that link cross-repo PRs — both orchestrator/scratch ROOTS (depth 0 fails
  `isChild`) and repo-less nested coordinators. Safe to render always because
  `PrLinearBadges` returns `null` when nothing is linked and `.ws-pills:empty`
  collapses the strip, so unlinked rows keep their exact previous layout.
- **Row layout is a single 24px line.** Name, badges, context and account all
  share one line, with metadata right-aligned. `.ws-pills` was previously
  `flex-basis: 100%`, which inside a `flex-wrap: wrap` row ALWAYS starts a new
  flex line — that one declaration made every git-backed child ~42px. Both the
  name row and the pills strip are now `nowrap`, so a long branch ellipsises
  rather than pushing badges to a second line. Rows carrying a
  `.ws-status-note` are the deliberate exception (two stacked lines,
  `.ws-item:has(.ws-status-note)` top-aligns the glyph).
- **Nesting is indent-only** — no `╰─` connector, no rail. `.ws-item.ws-child`
  uses `calc(12px + min(var(--ws-depth,1), 3) * 16px)`: the `min()` CLAMPS at
  depth 3 because `flattenSubtree` imposes no depth limit and an unclamped ramp
  runs the branch name off the edge on a deep sub-orchestrator chain.
- **Status glyphs** — `components/WorkspaceStatusGlyph.tsx`, its own module so
  the five surfaces can share it without importing 100KB of `Sidebar.tsx` (and
  so it renders in a test without dragging in xterm + the IPC bridge). Outlined
  lucide-style RING icons, not the old filled `.ws-dot`: `circle-check` (idle),
  `message-circle-question` (waiting), `circle-x` (error), a CSS
  `border-top-color: transparent` spinner (running, `.ws-glyph-spin`,
  compositor-only so dozens of rows cost no main-thread work), bare dot
  (stopped/hibernated). Shape + colour is two channels, so "done" vs "needs you"
  survives colour-blindness. A hibernated row NEVER spins even when its recorded
  status is `running`. `statusGlyphTitle()` ships alongside so no two surfaces
  describe the same state differently. Branch selection is pinned by
  `src/renderer/workspace-status-glyph.test.ts`; the CSS half needs a real drive.
  Used by: sidebar rows (both paths), `InboxBell`, `JumpPalette`,
  `ResourcesView` (agent rows + login sessions). An optional `size="sm"` prop
  drops it to 10px for denser lists.
- **`.ws-dot` survives for ARCHIVED sidebar rows only**, and that is semantic,
  not leftover: an archived workspace has no live agent, so its `status` is a
  frozen pre-archive value — a green check-ring would assert a successful finish
  the data cannot support, where a neutral dot correctly reads as "inert". Same
  reasoning as the hibernated branch inside the glyph. Do not "finish the
  migration" by converting it.
- **Host grouping**: within a repo, rows bucket per machine/sandbox node via
  `host-grouping.ts` `groupByHost` (returns null when all-local → flat list
  byte-identical to pre-sandbox); collapsible `.host-group-header` per node.
- Drag-reorder for workspaces and repos (`reorderWorkspaces`/`reorderRepos`).
- **DnD drop targets are a SHARED PURE MODULE — `src/shared/dnd-drop-target.ts`
  (issue #38).** `dropRepo?.path === repoPath` reads as null-safe and is not:
  `?.` on a null object yields `undefined`, so an `undefined` right-hand side
  makes the comparison TRUE and the ternary arm dereferences null, throwing
  `TypeError: Cannot read properties of null (reading 'pos')`. React's error
  boundary catches it, so the whole app renders "Something broke in the UI"
  instead of a sidebar. The right side reached `undefined` because `Workspace`
  is deserialized from `store.json` with **no runtime validation** — `repoPath:
  string` is a claim about writers, not a guarantee about readers.
  There were **four** sites of this shape, and guarding them individually was
  tried first and rejected in review: two were missed, and nothing in a `.tsx`
  render body is reachable from `pnpm run test` (it strips types but does not
  transform JSX; there is no jsdom/testing-library/vitest), so the first gate
  reconstructed the buggy expression as literals and passed on broken code.
  All four now route through the shared module:
  `matchesDropTarget` (`!== null` before any `.pos`, and an `undefined` key
  never matches), `dropTargetClass` (the class modifier), `nextDropTarget` (the
  `onDragOver` updater, preserving object identity so a dragover does not
  re-render the sidebar every pixel). Call sites: `Sidebar.tsx:1941` (repo
  class), `:2169` (workspace class), `:1956` and `:2269` (the two updaters);
  state is `DropTarget<string>` at `:930`/`:938`. Gates:
  `src/shared/dnd-drop-target.test.ts` binds to the real functions, and
  `scripts/sidebar-boot-render-smoke.mjs` asserts the **compiled bundle** still
  contains the guard shape and no `?.`-equality shorthand — so reverting the
  render site fails a gate (it did not before).
- **The repo-less bucket (`repoPath === ''`) is FIRST-CLASS, with only its
  REPO-SCOPED affordances removed.** No-repo workspaces are a real, common state
  (several live ones on this machine), not a corrupt edge case — so the section
  renders, and its workspace ROWS stay fully clickable/openable. Hiding the
  section was considered and REJECTED: a user must always be able to reach their
  workspace. Measured on the built app (trusted `Input.dispatchMouseEvent`, with
  selection first moved OFF the row so the click is a real transition and not a
  vacuous no-op): row `pointerEvents:auto`, `cursor:pointer`, click re-selects it
  and the pane opens; the row keeps its own workspace-scoped actions. What is
  removed is only what a repo-less section cannot honour —
  `repoSectionKeyOf` (`orchestrator-repo-grouping.ts:59`) returns `?? null` and
  `groupRootsByRepo` (`Sidebar.tsx:768`) collapses to `?? ''`, so a malformed
  record groups under the empty key; `repoLabel` (`:1448`) names it **"No
  repo"** rather than rendering a blank header — the row must stay visible,
  since silently dropping a workspace is the worse failure. Its `+` and gear
  buttons are **suppressed**: with `repoPath: ''` the `+` called
  `createWorkspace({repoPath:''})` → `createWorktree('')` → `simpleGit('')`,
  and simple-git does **not** reject an empty baseDir — it falls back to
  `process.cwd()` (measured), so the click could create a real branch and
  worktree in whatever repo the app was launched from. The gear was separately
  dead (its modal is gated on a truthy `repoPath`). The durable guard is in the
  main process: `createWorkspace` (`workspaces.ts:369`) throws on a falsy
  `repoPath`, covering every caller including IPC, not just this UI.
- **Status note**: the agent-authored one-liner (`orchestra status` →
  `Workspace.statusText`) renders as a muted single-line `.ws-status-note`
  under the branch name on both the scratch/orchestrator and repo row
  templates; the tooltip (`statusNoteTitle`) carries the full text plus
  freshness ("updated 3m ago"). Absent field → no extra line.
- Row actions: rename branch (inline), unread bookmark toggle (`UnreadToggle`
  → store `setUnread` → IPC `workspaces:setUnread`; sets `ws.markedUnread`,
  shown by turning the leading status glyph accent-blue (`.ws-glyph.unread`,
  overrides the status colour; name brightens but is NOT bolded — emphasis is
  carried by colour, since weight-700 rows made the whole list read as
  shouting), auto-cleared by the store's
  `setActive` when the user next selects the row), archive/unarchive, delete
  (confirm + bulk progress), switch branch (`BranchPicker`), setup gear
  (`RepoScriptsModal`), ☁↑ import-to-sandbox (`onImportToSandbox` `:800`,
  endpoint prompt) / ☁↓ eject (`onEjectFromSandbox` `:823`) — one or the other
  by `w.host`.
- Env notices come from `getEnvStatus` (`EnvStatusItem`) —
  generic so new integration checks need no renderer change.

## Other components
- **DiffPane.tsx — the Diff review pane.** Replaces the removed Monaco-based
  `DiffView.tsx` (Monaco was the heaviest thing the agent view mounted and drove
  the GPU-crash black screen). **Do not reintroduce Monaco here**: this renders
  plain DOM from raw patch text parsed by `src/shared/diff-hunks.ts`.
  - Tab lives in App.tsx's `toolbar-views`, gated `!isScratch` exactly like Run
    (scratch/orchestrator are repo-less); the same effect drops `view` back to
    `terminal` when switching to such a session. Mounted only while selected —
    unlike the terminals, it holds no scrollback and refetches on activation.
  - Two scopes toggled in the pane header: **Uncommitted** (`getRawDiff`) and
    **vs base** (`getBranchDiff`, three-dot). Fetches on activation/scope change
    only — never polled, since a diff reflowing under the reader mid-review is
    worse than a stale one; Refresh is the explicit resync.
  - **Selective staging** (uncommitted scope only): per-hunk + tri-state
    per-file checkboxes → `buildPatch` → `applyReviewPatch`. Hunk ids derive
    from header offsets, so a refetch prunes any selection that no longer
    resolves rather than carrying stale ids into a patch build.
  - **Line annotations**: gutter click opens a markdown box (Cmd/Ctrl+Enter
    saves, Esc cancels); one "Send to agent" composes them via
    `composeRevisionPrompt` into a single file:line-anchored revision prompt.
    State is component-local, so it resets on tab-away (V1 scope).
  - Virtualizes above 600 rows at a fixed 18px row height — `ROW_H` **must**
    match `.diff-line`'s CSS height. Word wrap makes rows variable-height, which
    fixed-height windowing cannot position, so wrap disables virtualization.
  - Change size also still shows as `+N −M` sidebar badges (separate
    `getDiffStats` poll). The older `getDiff` (content pairs, `git:diff`)
    remains an `ExtraApiMethods` entry with no renderer caller.
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
- **Bus / Insights / Help overlays vs the toolbar (#253)** — `BusPane` (`page === 'bus'`),
  `InsightsView` and `HelpView` are absolute `inset: 0` overlays in `<main class="main">`, and the
  workspace `.toolbar` (z-index 20, height `--toolbar-h`, declared on `.main`) paints OVER them, so
  each is offset with `.toolbar ~ .bus-pane, … { top: var(--toolbar-h) }` — a sibling rule, because
  with no active workspace there is no toolbar and the page must still fill `<main>`. The `.res-page`
  Resources overlay takes the other route (z-index 25, covers the toolbar with its own 48px header).
  Rig: `scripts/e2e-bus-page-header.sh <app-dir>` (DOM + hit-test + pixels; bus/insights/help ×
  min/typical/no-workspace).
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
- **MemoryBanner.tsx** (#289, D5 D-pick3 = option B, mockups `docs/mockups/289/`) — GLOBAL banner above the pane row (before SetupBanner) and on top of the Welcome screen when no workspace is active: two French
  lines, amber while the memory guard HOLDS Admission (`admissionEnabled` on) and red only while runs ARE under the host's memory Pause (the bus says so — never merely "guard below critical"); vanishes by itself on recovery. State = `memoryBanner` in the store (replaced WHOLESALE,
  revision-stamped: initial pull `memoryGuard:banner` + push `memoryGuard:bannerUpdate`; registered by `registerMemoryBannerIpc()` in `memory-banner-host.ts`, NOT the generic served table). « Masquer » stores
  `memoryBannerDismissed` = every `bannerKey` (episode + kind [+ Pause cycle]) hidden since the last recovery: it comes back on an escalation (held → Pause), a new Pause cycle, the next episode, and when the EPISODE ENDS while a Pause still stands (`episodeOver`: Admission reopened with the Reprise held — the key gains `:over`, ruling #289 b; its sub-line then reads « Reprise retenue — mémoire revenue, mais la Reprise attend (voir l'alerte) », never « Reprise automatique »), not on a de-escalation (« Masquer » on the RED banner also hides its episode's amber one; one unreadable sample keeps the banner, saying « mesure illisible », so no `none` push forgets the dismissals); a `kind:'none'` push forgets them. The component publishes its height as `--memory-banner-h` on `main.main`; the full-page Bus / Insights / Help overlays (`inset: 0`) start below it (`styles.css`; the Resources page covers the whole column by design). Words, kinds and the
  dismiss rule are pure (`src/shared/memory-banner.ts`); the publisher (`src/main/memory-banner.ts`, Electron-free) recomputes on every guard edge and every `BANNER_REFRESH_MS` (5 s) while a banner is up OR the guard still holds (the Admission toggle going OFF→ON blanks / restores it with no guard edge) and pushes only on
  a real change. Gates: `memory-banner.test.ts` (real bus + REAL guard), `shared/memory-banner.test.ts`, `memory-banner-wiring.test.ts`, `scripts/memory-banner/mutate-unit.mjs`, and `scripts/e2e-memory-banner.sh <built app>`
  (a BUILT app in a headless sway: thresholds moved around the live MemAvailable through the #285 modal → banner DOM + position + paint + `bus-status` + screenshots; heavy: token).

- **agent/InboxTray.tsx** — the inbox tray (issue #64): peer messages parked on
  disk in `~/.orchestra/inbox/<id>.txt` while this workspace was unreachable.
  Docked inside `.av-composer` above `QueueTray`. Collapsed to an amber
  `✉ N messages held` chip; expanded, one row per block with **Release ▶** /
  **Refuse ✕** and a header **Release all**. Channels: `inbox:list`,
  `inbox:release`, `inbox:refuse`, `inbox:releaseAll`, plus the `inbox:update`
  push (main watches the inbox DIRECTORY, so drains performed by the
  `inbox-instruction.sh` shell hook retract the chip even though the main
  process never initiated them). Renderer cache is
  `store.parkedInbox[workspaceId]`; the FILE is the source of truth. Blocks are
  addressed by exact TEXT, never index — the hook can drain the file between
  render and click. Backend `src/main/inbox-tray.ts`, parser
  `src/shared/inbox-blocks.ts`. NOT the SDK `crossSessionInbound: 'hold'`
  channel (issue #42, heap-only upstream).
- **Human-directed decision gates — the "Asks" surfaces (issue #161).** A bus
  `decision_gates` row with `recipient='human'` is a fleet question routed to the
  user. It renders in TWO places, both reading the ONE `store.humanGates` slice
  (a flat fleet-wide list, replaced wholesale on the `human-gates:update` push —
  a snapshot, never merged), so answering in either flips the other live:
  - **Surface A** — `AskRow.tsx` (`src/renderer/components/agent/`), an amber
    inline ask row docked above the composer in StructuredView (above InboxTray),
    filtered to the asking workspace by `askedBy === workspaceId`. Free-text
    ruling + Answer, visible aging badge, no modal.
  - **Surface B** — `AsksSection.tsx` (`src/renderer/components/`), a sidebar
    section aggregating EVERY open human gate, each row deep-linking to its
    asking workspace via `setActive`; vanishes when empty (Tickets-section idiom),
    slotted above Tickets in `Sidebar.tsx`.
  Channels: `bus:humanGates` (read, in `BUS_PANE_IPC_CHANNELS`), `bus:resolveHumanGate`
  (write, registered in `index.ts` beside `bus:setSwitches` — the pane registrar
  refuses writes), plus the `human-gates:update` push (`platform.broadcast`, from
  `src/main/human-gates.ts`'s bus-directory watcher + every resolve). Since #330 the
  app also pushes `watchers:update` (the degraded-watcher set, edge-triggered; pull
  `watchers:status`) — see `watchers.md`; the warning is the sidebar-footer `WatchersStrip` (D-Q8 A, `watchers.md`). The bus DB
  row is the source of truth (durable + backfill==live); per-workspace
  `Workspace.openHumanGateCount` is mirrored for the sidebar (#88 pattern). Pure
  helpers + wire shape in `src/shared/human-gates.ts`. Backend
  `src/main/human-gates.ts`; see `docs/codebase-map/bus.md` §"Human-directed
  gates". The gate LIFECYCLE (resolved_by=human, re-wake) is the #119/#158
  agent-gate machinery, unchanged.

- **Fleet Pause UI — option A (issue #257, wave F ledger #281; D-pick pending, A built as the reversible default).** The human pauses / resumes / releases a fleet from the app; data layer + wire shapes in `docs/codebase-map/pause-trap.md` §UI. Renderer: store slice `pauseOverview` (`store.ts`, filled at load and replaced wholesale on the `pause:update` push; actions `pausePause|pauseResume|pauseRelease` take the reply's overview). **The building blocks are separate from the layout** so another option swaps the composition only: `src/renderer/components/pause/PauseBlocks.tsx` (badge, glyph, bar, refusal block `PauseExplain` (a worker refusal carries ONE navigation LINK to its orchestrator — `gotoWorkspace`; the only button is the release follow-up), action button, `useNowTick` — a clock mounted ONLY while a douce waits), `pause-actions.ts` (click handlers over the store + the ONE floating-panel store; "Libérer tout" sends `'all'` — the acting row's own run; the second gesture « Libérer aussi ces N » sends explicit ids), `src/shared/pause-ui-view.ts` (pure words/tones/countdown/headline/Bilan texts/selectors) and `src/renderer/pause-ui.css` (own sheet). **Option A layout**: `PauseRow.tsx` (status-glyph swap — only while the agent is HELD, `pauseHoldsGlyph` = en pause / bloqué; finit… / libéré / repris keep the activity glyph, the badge carries the state, badge on the name line, the orchestrator's note line + thin bar, dim, the hover buttons ⏸ / ■ / ▶ — each renders nothing while the fleet is not under a pause), `PauseMenu.tsx` (`PauseMenuHost`, portalled beside the sidebar: the douce / dure choice or a refusal explained; Esc / outside click close; an explanation carrying « Libérer aussi ces N » closes when its Reprise epoch changes), `BusPauseSection.tsx` (header card + Bilan table + Libérer per member on the Bus page, injected by `App.tsx` as `BusPane`'s `pauseSlot` so `BusPane.tsx` stays store-free for the render smokes). `Sidebar.tsx`: BOTH row render paths (pinned spawn trees, repo sections) carry the same five parts (`pause-ui-wiring.test.ts` pins the pairing) + one `<PauseMenuHost />`. Every element has a `data-pause-*` hook (the G3 drive never reads text to find things). Gates: `node scripts/pause-ui-render-smoke.mjs` (SSR over a seeded store, 52 checks; in `test:render`), `node scripts/pause-ui/mutate-unit.mjs` (189 in-place clause mutants: data layer, explainers, view helpers, components, wiring, coalescer, rev stamping, unreadable strip, missing-Bilan), `scripts/pause-ui/e2e-pause-ui.sh <app-dir|--packaged bin> --arms ipc,ui` (built app, contained sway, trusted hover/click, decoded screenshots, `--expect-red` on a build without the feature; the in-flight douce is state-injected — an idle fleet is confirmed within a sweep, the F2 canary drives the waiting phase for real). Known limits: a nested OPS row covered by an outer Reprise has no release control of its own (its ▶ explains, the carrier's Bus card releases); the Bilan shows the trap's report, not a live view; the sidebar's remedy for a refused row is text (hover the named row's ⏸ yourself).

## chime.ts (~517 lines) & debug.ts
**chime.ts** synthesizes ~20 notification sounds with the Web Audio API (no
shipped assets); `playFinishedChime()` plays the selected sound when
`agent:finished` fires and the workspace isn't focused (picker in
`SoundSettings.tsx`, selection in localStorage — per userData, so a fresh
instance defaults to `knock`). Any instance with `ORCHESTRA_HOME` set (e2e rigs)
runs with Chromium `mute-audio` unless `ORCHESTRA_AUDIO=1` (`shouldMuteAudio`,
`src/shared/audio-mute.ts`; the `dev` script sets it). **debug.ts** — `window.orchestraDebug(true)`
toggles renderer activity-pipeline logging (persisted, reloads).
