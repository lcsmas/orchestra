# Resources page (live CPU / memory / disk / token monitor)

A full-page monitor of everything Orchestra consumes, opened from the sidebar
footer ("Resources", pulse icon). Files: `src/shared/resources.ts` (+ `.test.ts`,
pure logic), `src/main/resources.ts` (platform sampling),
`src/renderer/components/ResourcesView.tsx` (UI); wiring in `pty.ts`,
`index.ts`, `ipc.ts`, `preload/index.ts`, `store.ts`, `Sidebar.tsx`, `App.tsx`.

## Data model — pull, not push
There is **no standing poller in main**. The page polls the `resources:sample`
IPC every 2s while it is open and the document visible (same visible-poll
discipline as the git/du polls); a closed page costs nothing. Token usage adds
no IPC at all — it renders the store slices the existing account pollers keep
fresh (`accountUsage` / `globalUsage` / `workspaceAccounts`, see
[accounts-usage.md](accounts-usage.md)).

## Pure logic — shared/resources.ts
Dependency-free so `node --test` covers it without Electron:
- `parseProcStatLine` — one `/proc/<pid>/stat` line → `ProcSample`
  ({pid, ppid, comm, cpuTicks, memBytes}). Splits on the **last** `)` because
  comm may itself contain spaces/parens.
- `parsePsOutput` — the non-Linux fallback (`ps -axo pid,ppid,rss,pcpu,comm`);
  pcpu is used directly instead of tick deltas (`ProcSample.cpuPct`).
- `collectTree(rootPid, table)` — root + descendants via a ppid index; returns
  `[]` for a vanished root, cycle-safe.
- `computeCpuPcts(table, prevTicks, elapsedMs, hz)` — jiffy delta → percent of
  one core; unseen pids read 0 (never a bogus lifetime figure), pid-reuse
  clamps at 0.
- `aggregateSession(root, table, cpuPcts)` — rolls one PTY's process tree into
  a `SessionResourceStat` (cpu/mem/procCount + top-8-by-memory breakdown).
  `classifyPtyId` maps the pty id scheme (`<wsId>`, `:run`, `:nvim`,
  `account-login:`) to a session kind.

## Sampling — main/resources.ts
`sampleResources()` (handler `resources:sample`, `index.ts`):
- Process table: Linux reads `/proc/*/stat` directly (no child process per
  tick); elsewhere shells out to `ps`. Keeps a module-level `prevTicks` map so
  the first tick after open reads 0% CPU and the second is real.
- PTY roots come from `listPtySessions()` (`pty.ts`) — `{id, pid, remote}`.
  Sessions now carry a `remote` flag: a sandbox session's pid is
  **container-side** and must never be resolved against the local table.
- Electron's own processes via `app.getAppMetrics()` (CPU measured since its
  previous call, which matches the page's tick).
- Disk: `du -sk` over `~/.orchestra/{scratch,logs,backups}` + the events dir,
  cached 60s (`DISK_TTL_MS`), refreshed fire-and-forget off the tick. Worktree
  sizes are deliberately not resampled — the renderer already has them from
  `workspaces:sizes`.

## UI — ResourcesView.tsx
Rendered by `App.tsx` as an **overlay** on `.main` (`position:absolute`,
z-index 25) when `store.page === 'resources'` — never instead of the workspace
panes, so every mounted TerminalView keeps its xterm scrollback. `store.page`
(`'workspaces' | 'resources'`) is toggled by the sidebar footer button
(`Sidebar.tsx`, highlights while open); Esc or the ✕ closes.

Sections: stat tiles (agent CPU with a fleet-wide sparkline, agent memory, app
memory, worktrees on disk, live-agent count) → Agents table (per-workspace
rows: status dot, branch, session-kind chips, 3-minute CPU trace, cpu/mem/
procs/disk/ctx, and a per-row stop button; click a row to expand its process
list; remote rows show a "runs in sandbox" note; login PTYs listed after) →
App processes → Token usage by login (per-account cards: 5h/7d/Fable/extra
meters with reset countdowns, error/expired notes, pinned workspaces; hottest
account first) → Orchestra data on disk.

Per-row stop (`.res-stop-btn`): rows with a live agent session carry a stop
control that calls `agent:stop` on the agent PTY id — kill without respawn, so
the process's CPU/memory is actually freed (a confirm dialog guards a mid-turn
`running` agent). The row is a `div[role=button]`, not a `<button>`, because
the stop button nests inside it. The workspace terminal prints "[agent stopped
— press any key to relaunch]" and relaunches with `claude --continue` on the
next keystroke or activation (see
[activity-pty-terminal.md](activity-pty-terminal.md)).

CPU traces live in a component-local ref (`histRef`, 90 samples ≈ 3 min at the
2s cadence, keyed by workspace id + `__total__`); a workspace with no live
session decays to 0 so a stopped agent's trace flatlines instead of freezing.
Meters reuse the `.usage-bar-track/fill` primitives; **status colors
(yellow/red) are reserved for token limits** — CPU/memory stay on the accent
hue because high CPU isn't a problem state. Shares `formatResetsIn` /
`formatUpdatedAgo` (exported from `UsageBars.tsx`) and `loginColor`
(`AccountBadge.tsx`). Styles: the `.res-*` block at the end of `styles.css`.

## Native GTK4 port (M2-B5)

The GTK frontend reimplements this page as a full-pane overlay over the ui-rpc
socket (`native/orchestra-gtk/src/overlays/`, plan §5.5):

- `resources.rs` — `ResourcesOverlay`: polls `sampleResources` every 2s **only
  while shown** (`on_shown`/`on_hidden` start/stop a `glib::timeout`), rebuilds
  the tiles + agents table + app-processes table + token cards + disk section
  per tick. Slow data (`getWorktreeSizes`/`listAccounts`/`getUsage`/
  `getAllAccountUsage`/`getWorkspaceAccounts`) refreshes every 8th tick. `now`
  is taken from `snapshot.at`, not a wall clock. The agent row is a flat
  `gtk::Button` (disclosure → process list) with the stop button as a sibling.
  Sparklines are cairo (`draw_spark`: faint baseline, 0.14 area fill, accent
  polyline, endpoint dot, `max(100,peak)` scale).
- `support.rs` — pure ports of `formatBytes`/`formatCpu`/`formatTokens`/
  `Severity` (≥90 red, ≥75 yellow) / `loginColor` (UTF-16 `hash*31+c` → hsl) /
  `formatResetsIn`/`formatUpdatedAgo`, plus `TraceRing` (90-sample CPU history
  with `decay()` flatline). Unit-tested against the Electron values.
- Color discipline preserved: CPU/mem meters use `meter-accent`; yellow/red
  (`meter-warn`/`meter-critical`) are reserved for token limits. Styles: the
  `res-*` block in `native/orchestra-gtk/src/theme.css` (§7).
- Mock fixtures: `native/orchestra-gtk/src/backend_fixtures.rs`
  (`resource_snapshot(tick)` animates process trees, usage cards, disk).
