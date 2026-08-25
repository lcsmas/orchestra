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
- Disk USED: `du -sk` over `~/.orchestra/{scratch,logs,backups}` + the events
  dir, cached 60s (`DISK_TTL_MS`), refreshed fire-and-forget off the tick.
  Worktree sizes are deliberately not resampled — the renderer pulls them from
  `workspaces:sizes`, which since the sidebar dropped its size badge is polled
  only while this page is open.
- Disk FREE (issue #87): `sampleVolumes()` in `main/disk-space.ts` — `statfs(2)`
  over `~/.orchestra`, `os.tmpdir()` and `process.cwd()`, **de-duplicated by
  `st_dev`** so a machine where `/tmp` is not its own mount shows one row, not
  two identical ones. Lands on `ResourceSnapshot.volumes`, a sibling of `disk`
  and NOT part of `DiskStats` — they answer different questions (Orchestra's own
  footprint vs. the filesystem's headroom). Deliberately **not cached**: statfs
  is one syscall, and a mount filling fast is exactly when a 60s-stale reading
  is most dangerous. Uses `bavail`, not `bfree` (`bfree` counts root-reserved
  blocks an agent cannot write into).

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
account first) → **Free space** → Orchestra data on disk.

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
(yellow/red) are reserved for genuine problem states** — token limits, and
since issue #87 low free space. CPU/memory stay on the accent hue because high
CPU isn't a problem state; a full filesystem is. Shares `formatResetsIn` /
`formatUpdatedAgo` (exported from `UsageBars.tsx`) and `loginColor`
(`AccountBadge.tsx`). Styles: the `.res-*` block at the end of `styles.css`.

## Disk-space guard (issue #87)

Field evidence (closed ledger #70): `/tmp` — a **separate 16 GiB tmpfs** on the
dev machine — reached 100%, a verifier died on ENOSPC before writing a byte,
and the failure was indistinguishable from "the feature under test does not
trigger". Before this change there was **no free-space primitive anywhere** in
`src/` or `scripts/` (no `statfs`, no `df`, no threshold).

**Scope limit, permanent: the guard never deletes anything.** A "safe" cleanup
of `/tmp/e2e-*` destroys a sibling agent's live rig (the sleeping-owner rule).
It warns, names and refuses. The user-facing error text says so explicitly.

- `src/shared/disk-space.ts` — pure policy. `VolumeStat`, `classifyVolume` /
  `worstLevel` (level `ok|warn|critical`), the `DiskFullError` class and
  `formatDiskFullMessage`. **Threshold rule:** the more conservative of a byte
  floor and a percentage, warn if either breaches — a bare percentage is wrong
  at both ends (5% of 16 GiB is 800 MiB; 5% of 2 TiB is 100 GiB). Every
  constant carries its measurement (or an explicit UNBASELINED note) in a
  comment beside it.
- `src/main/disk-space.ts` — the platform I/O (`statVolumeFor`,
  `sampleVolumes`). `nearestExisting()` walks up to an existing ancestor, so a
  not-yet-created `release/` can still be checked.
- `scripts/disk-guard.cjs` — the shell-callable half, for helpers that run
  before any bundling step. Exit **17** = `ORCHESTRA_DISK_FULL` (distinct from
  1 so callers branch without parsing text); an UNMEASURABLE mount exits 1, it
  is never waved through. Its constants are duplicated from the TS module and
  **parity-tested** by `src/shared/disk-space.test.ts` — a duplicate nothing
  checks becomes two different thresholds silently. It only acts under
  `require.main === module`.
- **Each preset names a PROBE SET, not one path.** The build presets probe
  BOTH `cwd` and `os.tmpdir()`, because esbuild (`esbuild/lib/main.js:2096`)
  and electron-builder's `temp-file` (honouring `APP_BUILDER_TMP_DIR`) stage
  into the temp filesystem — a *different device* from the repo here (cwd dev
  45, tmpdir dev 46, measured 2026-08-25). Probing only the repo said "OK"
  while `/tmp` was at 0 bytes, i.e. it missed the exact reported incident.
  Every probed filesystem must satisfy the requirement, and the error names
  *which* mount failed. `--path` overrides the set for single-mount use.
- Call sites: `package.json` `prebuild:bundles` (preset `build-bundles`) and
  `build` (preset `build-package`); `scripts/e2e-contained-rig.sh` step 0
  (preset `e2e-rig`); and **`.github/workflows/release.yml` explicitly**, because
  CI invokes `electron-builder` directly (for `--publish never` argv reasons
  documented there) and so does NOT inherit the `build` script's guard — that
  left the largest-requirement step unguarded.
- `classifyVolume` applies the BYTE floor only to volumes at least
  `SMALL_VOLUME_FACTOR`x the floor. Without that, any filesystem smaller than
  the floor could never read `ok` — a 100 MiB tmpfs at 0% used classified
  `critical`, and since `worstLevel()` takes the max, one such mount pinned the
  page to a permanent warning. Below the cutoff the percentage arm decides
  alone.
- `FreeSpaceSection` in `ResourcesView.tsx` is exported separately from
  `ResourcesView` on purpose: `ResourcesView` takes no props and builds its
  world from the store plus an IPC sample, so a warning-state assertion against
  it could only be made against a stub. Taking `volumes` as a prop lets a rig
  render the real component with a real full-volume reading.

**Rigs.** `scripts/verify-disk-guard.mjs` mounts a 16 MiB **tmpfs** (the same
filesystem type that failed) inside a private user+mount namespace
(`unshare -rm`), fills it, and shows both arms on that one mount: unfixed →
`ENOSPC` with no mount and no numbers; fixed → the named error with mount, free
and required. It carries a CONTROL arm on a roomy mount that must PASS, so the
guard is a gate and not a constant. It never touches the host's `/tmp`.
`scripts/verify-disk-guard-ui.mjs` renders `FreeSpaceSection` in **both** the
warning and normal states and screenshots each inside its own headless sway —
one screenshot cannot distinguish "renders the warning" from "always renders
the warning".
