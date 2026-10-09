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

## Always-on monitor + reaper — resource-monitor.ts (issue #198 T8)

Separate from the pull-only page above: an **always-on MAIN-process sampler**
that ticks every **60s regardless of whether any window is open** (the laptop
overheats the longer Orchestra runs — the page can't watch what a closed page
never polls). Files: `src/shared/resource-monitor.ts` (pure decision + line
shape, `.test.ts` beside it), `src/main/resource-monitor.ts` (I/O + timer),
started/stopped in `index.ts` (`startResourceMonitor` in the
`reconcileParkedCounts().finally` beside the watchdog — AFTER `store.load()`;
`stopResourceMonitor` in `shutdownSubsystems`). Driven gate:
`scripts/verify-resource-monitor.mjs`.

Each tick (`sampleTick`, dependency-injected so the rig drives the real path):
- reads the local process table from `/proc` — **NO child process spawned**, its
  own read never adds to the load it measures (a private copy of the same reader
  the page uses, kept off `./resources` so the always-on module doesn't drag in
  the PTY/transport stack);
- walks **every live keeper's process tree** (keeper → CLI → MCP children),
  keyed by workspace id, via `listKeeperRoots()` (`keeper-client.ts`) +
  `collectTree`. This is the tree the page's `listPtySessions()` roots MISS —
  keeper-hosted sessions are DETACHED daemons, not PTY children;
- appends ONE JSON line (`ResourceLogLine`) to
  `<ORCHESTRA_HOME>/logs/resources.jsonl` — totals (cores, mem total/used from
  `/proc/meminfo` MemAvailable), each Electron process (cpu+rss), each session
  tree (cpu+rss+procCount + `present`/`status`/`reaped`; an orphan the reaper
  WITHHELD reads `present:false, reaped:false`). Electron cpu comes from the
  monitor's OWN `/proc` jiffy deltas, not `app.getAppMetrics()` — that shares one
  process-wide cursor with the page's poll, so its percent is garbage when both
  run (review F3; residual: the monitor's call still resets the page's window).
  **Bounded by SAMPLE age and size, not mtime** (review F4,
  `appendResourceLogLine`): active + one `.1` backup ≤ 50 MB total
  (`MAX_FILE_BYTES` = 25 MB each); the active file rotates once its first sample
  is `ROTATE_AFTER_MS` (3.5 d) old and the `.1` is dropped once ITS first sample
  passes `RETENTION_MS` (7 d) — so nothing older than 7 d survives even after an
  idle gap. First-sample times are read from disk once, then cached in memory.

**Detectors, each a log WARN with the stable prefix `resources:`**:
- **(a) reaper — DESTRUCTIVE (`decideReap` → `reapTargets`).** A session tree
  whose workspace is **provably absent from the store** → SIGTERM, grace, SIGKILL
  survivors + WARN. The SAFETY NET for the leak LEAD measured (2 trees, 1.6 GB,
  alive for workspaces deleted 14:21/14:23); the delete-leaves-session-alive
  **root cause is fixed in #201** (`teardownWorkspace` now stops the session +
  keeper — `workspaces.md`), so this sweep is a backstop for crashes/old builds.
  **#203 extends it to DUPLICATES:** `decideDuplicateReap` (`shared/resource-monitor.ts`)
  classifies every keeper of a workspace that is NOT the *tracked* (pid-file) one —
  found by a `/proc` argv scan (`deps.keeperProcs`, `parseKeeperArgv`, anchored on
  THIS home's `<wsId>.pid` arg so a dev-home keeper is never matched) because a
  duplicate's pid file was overwritten and `listKeeperRoots` cannot see it. Kinds:
  `duplicate` (live ws), `orphan-untracked` (absent ws). A live workspace's SOLE
  keeper is never a victim; no tracked keeper / tracked pid not in the scan → refused
  (cannot tell which to keep); a victim whose tree CONTAINS the tracked keeper (a fork-style `timeout … node keeper.js` wrapper — both argv match) → refused (`victim-tree-contains-tracked-keeper`); store not loaded → refused. At kill time
  `reapTargets` re-reads `deps.trackedKeeperPid(ws)` and re-verifies the tracked
  keeper (`/proc` stat + keeper argv): drift → ABORT, nothing signalled. The pass is
  `reapPass`, run by the 60 s tick AND by `reapKeepersNow` at boot
  (`reconcileKeepersAtStartup`, index.ts — replaced its bare `killKeeper` on an
  unverified store; NON-LINUX (no start-time ⇒ this pass refuses) keeps master's boot
  `killKeeper` of absent keepers via `bootFallbackKills`, store-loaded-guarded). Log = one WARN per tree (`reaping duplicate keeper tree for
  workspace <ws> (tracked keeper pid <T> kept …) — keeper pid <P>, …`) + one
  summary per tree. Gates, in order:
  1. `store.loadedFromDisk` — absence-from-store is only proof-of-deletion once
     store.json parsed (#187 lesson); the store is re-read AT KILL TIME too.
  2. **Identity (review F1 — pid reuse).** A `<wsId>.pid` from a crash-killed
     keeper lingers with a recycled pid and `isAlive` is `kill(pid,0)` (existence,
     not identity), so classification alone is NOT authorization. Identity =
     `(pid, /proc stat field 22 start-time)` captured at classification
     (`ProcSample.startTicks`; absent on the non-Linux `ps` path → **fail closed**,
     never reaped). At kill time `verifyReapIdentity` re-reads `/proc/<pid>/stat`
     per member: same start-time, same ppid, parent itself still verified (chain
     to the keeper); the ROOT must also be a real keeper — argv `…/keeper.js
     <wsId>` (`isKeeperCmdline`, clock-free; wall-clock `startedAt` is
     deliberately unused — `btime` shifts on clock steps, cf. the RTC +2h boot
     step). A failing root withholds the WHOLE tree; a failing child only itself.
  3. **SIGTERM → grace → SIGKILL.** All verified pids get SIGTERM leaf-first (the
     keeper's own handler kills its child and unlinks `.pid/.sock`); ONE
     `REAP_GRACE_MS` (5 s, the keeper's own SIGTERM→SIGKILL escalation); then
     SIGKILL only survivors whose `(pid, start-time)` still match
     (`classifySurvivors`) — a pid recycled DURING the grace is left alone.
  Members are keeper descendants only (never Electron/unrelated); what+why is
  logged BEFORE any signal. Residual, unclosable in Node (no pidfd): a reuse in
  the microseconds between the fresh read and `kill(2)`, vs ~60 s pre-fix.
- **(b) threshold advisory (`decideThresholdWarnings`).** A session tree or
  Electron process over a cpu/rss threshold → WARN only, **never kills**
  (`SESSION_RSS_WARN_BYTES` etc., all UNBASELINED named constants sized from the
  ~700 MB healthy-tree measurement). A reaped tree is excluded (its RSS is
  stale).

Gates: #203 arms `reap_*` in `scripts/e2e-keeper-lifecycle.mjs` (REAL keeper daemons + `sampleTick`/`reapKeepersNow`, wrapped by `src/main/keeper-lifecycle.test.ts`); unit arms in `resource-monitor.test.ts` (+ real-`/proc` start-time oracle in
`resources.test.ts`) and `scripts/verify-resource-monitor.mjs`, which drives the
REAL `sampleTick` over a fake `/proc` WORLD that can recycle a pid between the
sample and the kill (`afterSample`) or during the grace (`onSleep`), records the
OCCUPANT of every signalled pid, and writes a REAL `resources.jsonl`. It also runs
against the pre-fix build (deps carry an old-build `kill` alias) — there A3/A4
show an unrelated process actually SIGKILLed. `agent-sdk.ts` is untouched (the
#124 D3 seam is T3's).

## Browser Reliquats — the bridge until the member scope is ON (#331, wave H ledger #329 track H10)

On 2026-10-08 56 orphaned headless Chromium (~15 GB) of a rig's browser launcher survived for hours: reparented to init, so neither the tool-tree walk nor the memory Pause dure reached them. Until #320 + #325 are ON (`memory_cap` OFF = no scope, D-Q1) the host itself stops them; after that it stays as defence in depth. Files: `src/shared/browser-reliquats.ts` (pure decision, `.test.ts`), `src/main/browser-reliquats.ts` (I/O pass + tracker), wiring in `resource-monitor.ts` (`productionBrowserBridge`, `stopBrowserReliquatsOf`, `getBrowserReliquatView`) and `pause-trap.ts` / `pause-trap-host.ts` (the Pause dure step, `pause-trap.md` §5a').
- **A browser Reliquat** = ALL of: a Chromium-family browser MAIN process (`parseBrowserArgv`: argv[0] base name, no `--type=`; started from a SESSION env — `DBUS_SESSION_BUS_ADDRESS`, every uncapped member — Chromium rewrites its title and `/proc/<pid>/cmdline` is ONE string: `normalizeArgv` splits it on ` --`, folds `--flag value`, peels trailing URLs — verifier blocker on @fb351c39, rig arm `session_env`; WHAT runs is `/proc/<pid>/exe` when readable — an argv[0] saying chromium-browser is no evidence — re-read before every signal; rig arm `default_sandbox` measures the reviewer's no-`--no-sandbox` hypothesis) that is headless or remote-controlled (`--headless`, `--remote-debugging-port`, `--remote-debugging-pipe`); its launcher is dead (`launcherDead`: ppid ≤ 1, or the user manager `systemd --user` that adopts orphans); its `--user-data-dir` lies under `<HOME>/.orchestra/agent-tmp/<ws-id>/` (`profileOwner`, lexically normalised, an id a LOADED store knows — a default profile, the human's window and anything outside `agent-tmp/` are never even tracked).
- **Stopped**: PIPE mode at once (the pipe died with its launcher); PORT mode (and `--headless` alone, where no client can exist) after `BROWSER_IDLE_WINDOW_MS` = 10 min with no client connected to its debugging port — the clock starts when the monitor first sees the orphan and restarts at the last client sighting (`nextTrack`, in memory: an app restart resets it, conservative). A client = an ESTABLISHED socket whose local port is one the browser LISTENS on (`realClientState`: LISTEN rows of the BROWSER's own namespace tables `/proc/<pid>/net/tcp{,6}` — a browser under `unshare -n`/bwrap is invisible in the host's — matched to the pid's socket inodes; `--remote-debugging-port=0` works); an unreadable fd / table ⇒ `unknown` ⇒ kept, and time spent `unknown` counts as a client sighting (the idle window restarts when the client becomes readable and absent). A browser with BOTH `--remote-debugging-pipe` and `--remote-debugging-port` is port mode (it can still be driven through its port).
- **The pass** (`browserPass`): the 60 s `sampleTick` runs it right after the keeper reap, ONLY when `deps.browser` is installed (`productionDeps()` does; `defaultDeps` never — a rig calling `sampleTick()` cannot touch a browser). Every signal is preceded by a FRESH re-read: same pid + start-time, same argv, launcher still dead, no client appeared; the group = the browser + its ppid-descendants, each re-verified (same start-time, parent a verified member), SIGTERM children first, one 3 s grace, SIGKILL only same-identity survivors (a pid recycled during the grace is left alone). The module cannot modify a file: the profile directory is left in place (pinned by `browser-reliquats-wiring.test.ts`). A browser with no /proc start-time (the non-Linux `ps` table) is never signalled.
- **Told**: ONE bus status per owning member per pass (`browserStatusText`: how many, the common profile prefix, "profiles were left in place"; sender `host`, kind `status`, in the member's env run), none on a quiet pass. **Counted**: `BrowserTracker.counters` per workspace since the app started (monitor passes AND Pause dures share the one production tracker) → `ResourceSnapshot.browserReliquats` (`{total, byWorkspace:{stopped,lastAt,lastPrefix}}`, from `resources.ts`). **Shown** (D-Q4 A', ledger #329): `browserChipOf(snap.browserReliquats, row.key)` (`shared/browser-chip.ts` — a module with NO imports: the renderer bundles it, and importing `shared/browser-reliquats.ts` there would drag the Node path module into the bundle; pinned by `browser-reliquats-wiring.test.ts`, found by the headless-sway capture gate) → a grey « 🌐 N arrêtés » chip after the 🐳 one in `SessionChips` (`ResourcesView.tsx`, `data-res-browsers`, tooltip = count + last time + profile prefix), hidden at 0, asked only of rows that EXIST (`AgentsTable.browsersOf`; the grouping never creates or keeps a row for a counter — a finished member with nothing alive shows nothing), never on a remote row; `.res-chip.browsers` carries no status colour (a resolved count, history tone).
- **Pause dure**: `trapMember` step 5a' (`pause-trap.md`) calls the same pass for ONE member (`onlyWs`) with `ignoreWindow` — a frozen member drives nothing, so no 10 min wait (OPS ruling R7: nobody re-attaches the browser during a Pause), but a browser with a live client is ALWAYS spared; the exempt PAUSER keeps the window (its turn runs on) and a browser that STARTED inside a HUMAN turn's window is spared and listed (D9) — and lists what it stopped (and what it spared for a live client) in the Bilan's `activity.reliquats` (`scope: 'browser:pipe|port'`, profile in `cwd`), merged with the scope's own report (`combineReliquats`).
- **Known limits**: a helper that left the browser's ppid tree (a crashpad handler double-forks) is not signalled — the rig MEASURES whether it outlives the browser (`stopped_browsers_leave_no_crashpad_handler`); the idle clock lives in memory (an app restart restarts it) and a client is sampled once per pass (an agent driving its port browser through sub-minute `curl /json` calls looks idle); a pipe-mode browser whose pipe is still held open by some other process is stopped all the same (nobody drives it); browsers of a workspace the store no longer has (deleted) are not attributable and are never touched; `msedge`/`brave` are not matched (fail closed); the counter is since app start, not persisted; the per-browser `/proc/<pid>/net/tcp` read is ≈ 16 ms at 20k rows (≈ 1 s of main-thread time per tick at the incident's 56 orphans); the status row wakes its recipient like any bus row (the member's `wake` switch decides).
- **Gates**: `pnpm run test` — `shared/browser-reliquats.test.ts`, `main/browser-reliquats.test.ts` (fake OS races + REAL look-alike browsers with real sockets and a real client), `browser-reliquats-monitor.test.ts` (the real `sampleTick`, driven by `scripts/browser-reliquats/monitor-drive.mjs`), `browser-reliquats-wiring.test.ts` (incl. the chip), `pause-trap-reliquats.test.ts` (#331 arms); rig with REAL headless Chromium `pnpm run test:browser-reliquats` (`scripts/browser-reliquats/rig.mjs`; heavy-rig token, MemAvailable ≥ 6 GB; profiles under the rig's scratch `<HOME>/.orchestra/agent-tmp/`, every browser stopped by identity, `SURVIVORS arm=… procs=0` printed — it counts argv AND environment markers, a crashpad handler carries only the latter; arms `monitor` = pipe orphan stopped at once, idle port orphan stopped after N (6 s in the rig), live-client / launcher-alive / outside-agent-tmp / unknown-workspace / default-profile browsers kept, one status per member per pass, the counter; `pause_dure` = the real Pause dure stops a pipe + an idle port orphan, spares the client one, lists them in the Bilan, `run status` and the Consigne; `-- --unfixed` runs the SAME rig against the tree BEFORE #331 and exactly the named checks go RED); mutants `pnpm run test:browser-reliquats-mutants` (`br-*` in-place unit mutants + `scripts/browser-reliquats/mutate-rig.mjs`).

## Container memory — attributed per workspace, unattributed reported (#293, wave G ledger #295; epic #284; contract FI-3 v1.3; ADR 0004)
A member's Docker containers live outside its process tree (the daemon owns them), so the monitor never saw their memory. Since #291 the keeper's relay stamps every container a member
creates with `orchestra.ws=<id>` (`DOCKER_LABEL_WS`, `src/shared/docker-labels.ts`; `attributedWorkspaceId` = the EXACT non-blank, unpadded value — Pause matches by equality too); #293 reads it.
- **Pure half — `src/shared/container-accounting.ts`** (+ `.test.ts`, REAL stats captures in `fixtures/`): `classifyContainers(running, earliestLiveRunStartMs, workspaceKnown?(ws, run), runKnown?)` — **attributed** = a RUNNING
  container stamped for a workspace that EXISTS; **unattributed** = a RUNNING container that is nobody's: (a) WITHOUT the label, created at/after the earliest LIVE fleet run start (whole seconds, `>=`; the
  human's older stacks never count; no live run → none), or (b) an **orphan** — stamped for a workspace the store no longer has (deleting a workspace does not stop its containers), whatever its age, named
  `<name> (orphan of <id>)`. **FI-3 v1.3 "live fleet run"** (`src/main/container-window.ts`, Electron-free, tested CW1–CW4 on a REAL scratch bus.sqlite): the window starts at the earliest `created_at` among `liveFleetRuns` — the SAME
  definition as the memory alert's LEAD selection and the memory Pause (anchor workspace live, not archived, not sandbox-hosted, ≥ 1 live local workspace below it; NO keeper condition, so a hibernated LEAD still leads
  its run). Nothing writes `runs.closed_at`. Residual (accepted by OPS): a long-lived run widens the window by DAYS (live bus: 22 / 1.2 / 0.5 d) — a human's container created in that span counts as unattributed.
  `workspaceKnownIn` / `runKnownIn` are the production predicates: a loaded store is the authority on ids; an UNTRUSTED store (not parsed yet, or a fresh/corrupt store.json that never loads) trusts the container's
  `orchestra.run` stamp alone; an orphan needs a run THIS bus has (a dev build's containers on the shared daemon are not ours). `containerMemoryBytes(stats)` = the docker CLI's `calculateMemUsageUnixNoCache`: cgroup v1 `total_inactive_file` first, then v2 `inactive_file`, each subtracted only
  when below usage, else usage; a document without a usable usage is **unmeasured (null), never 0** (a real capture where page cache dominates: usage 106.6 MB → footprint 1.77 MB). `buildAccounting` (per-workspace
  `unmeasuredByWorkspace`), `accountingView` (JSON-safe), `viewBytesFor`, `measuredContainerBytes` (undefined = not measured: Docker down/failed or ALL the workspace's containers unmeasured), `formatContainersLine`.
- **Producer — `src/main/container-accounting.ts`**: `refreshContainerAccounting(deps)` once per resource-monitor tick, platform-free (the run-start clock, the member-pinned daemons and the store predicate are injected).
  Asks the app's REAL-socket daemon (`docker-api.ts`, never a relay) AND any daemon a live member's relay is PINNED to (`extraApis`, deduped by resolved socket — the #291 F2 lesson: ask the daemon the container was
  STAMPED on); each container is measured on the daemon it lives on. `listContainers({status:['running','paused']})` (a paused container still holds its memory — a human's `docker pause`; Orchestra never pauses, FI-1.4; exited / restarting stay out), then **ONE stats pass — and NO stats call at all when no attributed container exists** (AC); ≤ 4 in flight
  (`STATS_CONCURRENCY`), ≤ 64 measured per pass (the rest counted `unmeasured`); a failing stats call = that container `unmeasured` + WARN, a 404 = not counted. Single-flight; never throws. **No daemon answers =
  `docker:'unavailable'` (NOTHING measured, previous figures dropped — not "0 containers", not stale bytes)**; one of several down = measured from the others (WARN once); an unexpected failure = `docker:'error'`
  (nothing trusted); a partial outage is MARKED (`daemonsDown`: the figures are a lower bound — shown on the `bus-status` line, the Resources warning and the alert). `getContainerAccounting(now)` reports a good pass older than `ACCOUNTING_STALE_MS` (5 min) as `docker:'stale'`, never as current. Logged once per transition; an unattributed set change is a WARN once per distinct set (`… NEVER touched`). `getContainerAccounting()` (FI-3.2) is the synchronous read of the LAST tick.
- **Monitor — `resource-monitor.ts`**: `sampleTick` runs the pass after the reap, bounded by `CONTAINER_PASS_BUDGET_MS` (15 s: a hung daemon never delays the line; the tick then carries the last result).
  `ResourceMonitorDeps.refreshContainers/containerView/containerBudgetMs` are OPTIONAL and only `productionDeps()` (the timer) installs the first two — `defaultDeps` never touches the host's Docker; `startResourceMonitor` also runs the FIRST pass at start (an alert in the first minute must not read « not sampled »). The budget path is driven for real by `scripts/e2e-container-budget.mjs` (B1). The `resources.jsonl` line gets a host-wide
  `containers` block and, per keeper session, `containerBytes` (SEPARATE from `rssBytes`, so the RSS advisory is not tripped by a container; ABSENT when not measured — never a fake 0).
- **Resources page (D-pick4 = mockup A)**: `ResourceSnapshot.containers` (the last tick's view; the 2 s poll never calls Docker). **Keeper-hosted structured agents now have a row**: `sampleResources` adds
  one synthetic `<wsId>:sdk` session (`SessionKind` `sdk`, shown as an « agent » chip, no stop button — the page stops PTYs only) per LIVE keeper tree via `aggregateKeeperSessions(listKeeperRoots(), ptyRootPids, …)`
  (`shared/resources.ts`: the keeper is detached so its tree is disjoint from the PTY's — both show; only a keeper INSIDE a PTY root's tree is skipped; a keeper whose tree left the table yields no row). The « Live agents » tile counts `agent` and `sdk` rows. `groupSessionsByWorkspace(sessions, containers)` (pure, unit-tested G1–G5, also
  what the rig drives) folds `viewBytesFor` into the owning row's EXISTING memory figure, gives the row its **🐳 N chip** (`SessionGroup.containers`; tooltip `containersChipTitle`: « 2 containers · 700 MB »), and adds a
  **container-only row** for a workspace whose only footprint is a container (`containerOnly`: cpu / procs « — »); Docker down adds none of it. `AgentsTable` (exported, `ResourcesView.tsx`) renders the rows and the dim
  yellow **unattributed line** under the table (`unattributedWarning`: « ⚠ 2 unattributed containers (web-1, g9-old (orphan of ws-x)) — not attributed to any workspace · never touched », only when Docker answered).
  Remote rows get no local containers. Screenshot gate: `scripts/container-memory-screenshot.mjs` via `pnpm run test:container-memory-shot` (own marker-verified headless sway: real `AgentsTable` + real `styles.css`,
  3 captures — seeded / Docker down / pre-feature — each asserted on text, attributes, layout and PNG density).
- **`bus-status` `containers:` line** (`formatContainersLine`, from `/busStatus` `containers` + `containerLabels`): `containers: 3 attributed (feat-x ×1 · 612 MB, feat-y ×2 · 40 MB (+1 not measured)) · 1 unattributed (web-1,
  g9-web (orphan of ws-x)) — never touched`; `not sampled yet` / `Docker unavailable — not measured` / `accounting failed — not measured` / `last Docker pass is too old — not measured` are honest states, `N Docker daemon(s) did not answer — figures incomplete` marks a partial outage. Absent from an older app → no line.
- **Gates**: `src/shared/container-accounting.test.ts` (C1–C19), `src/main/container-accounting.test.ts` (K1–K15, fake daemons), `container-window.test.ts` (CW1–CW4, real bus), `container-budget.test.ts` (B1 the real `sampleTick` budget; B2 `memberPinnedApis` over the real keepers dir + `<ws>.docker.upstream` sidecars, and the pinned daemon reaching the accounting through a unix-socket fake daemon), `container-accounting-wiring.test.ts` (W1–W8), `scripts/e2e-container-memory.mjs`
  (**HEAVY — the heavy-rig token**; 5 arms on the host's REAL dockerd: a 200 MiB tmpfs container raises its workspace by ~205 MB and a 2nd SUMS to ~303 MB, through the real `sampleTick` AND the page's
  `groupSessionsByWorkspace`; no stats call without an attributed container; a stray container created on the real socket during a run + an orphan are unattributed, named, never touched — not even a stop/start
  attempt; Docker down ≠ zero; rig-unique prefix + `g9rig` label, removed by id, bystanders compared before/after; refuses below 9 GB; `pnpm run test:container-memory`),
  `scripts/container-memory-mutants.mjs` (~110 in-place mutants, `--check-anchors`, private backup dir).

## Member memory from the scope — Reliquats counted (#328, wave H ledger #329; epic #319; contract FI-1 v1.5 + v1.9; ADR 0005, `CONTEXT.md` §Memory)
A scope-tracked member's memory is read from ITS kernel scope (`src/main/memory-scope.ts`, `session-keeper.md` § Plafond mémoire), so a **Reliquat** — a process the member launched that left its tree (a detached rig browser, a double-forked daemon) —
counts for the member that launched it. The tree walk (`collectTree(keeperPid)`) cannot see one: it is reparented to the user manager. **`memberScopes(wsId) === []` = « not tracked »**: the member keeps today's process-tree figure and reads « Reliquats not tracked » (switch OFF —
D-Q1: OFF = no scope —, human/top-level workspace, sandbox, non-Linux, no `systemd-run`/user manager/delegated `memory`, session started before the switch). **The memory guard itself (`memory-guard.ts`) has no per-member reader** — it samples host-wide `MemAvailable` only;
the per-member figure is read by the monitor line, the page and `bus-status`.
- **Which number (OPS ruling R1, FI-1 v1.5): the kernel bill** = `readScopeMemory().currentBytes` (`memory.current`: what the Plafond compares to; page cache included; **summed over every scope generation** — a restart while Reliquats keep the old scope alive leaves two). It is NOT the RSS-sum of the tree:
  measured on this host, an idle keeper+CLI = **29 MB of bill vs 99 MB of RSS-sum** (shared mapped pages are charged to whoever cached them first, not to this scope) → a tracked member's MEM reads ~70 MB LOWER than before when it has no Reliquat, and ≈ + the Reliquat's anonymous size when it has one
  (a detached 100 MB process: **+120 MB bill, +0 MB tree walk**). `resources.jsonl` keeps `sessions[].rssBytes` (the tree) untouched; the scope reading is a SEPARATE `members` block. #323 shows usage vs plafond in the same unit.
- **Pure half — `src/shared/member-memory.ts`** (+ `.test.ts` M1–M18): structural inputs only (never imports H1's types — FI-1.3 stays one-way). `memberViewFrom` (`:59`) folds a member's generations: `bytes` = Σ readable meters (**null = none readable, never 0**; `unreadable` > 0 ⇒ lower bound), `reliquats` = members with `role === 'reliquat'`
  (`classifyScopeMembers`: chain reaches no live keeper of that scope, FI-1.4) over the listable generations (null = none listable; `unlisted`), `reliquatBytes` = their Σ **RSS** (NOT the bill: shared pages are counted per process here and once in `bytes`, so it can exceed the member's bill — the line and the tooltip say « RSS »). `buildMemberMemoryReport` (`:81`): `tracked` heaviest first (unmeasured last), `untracked` = live members (a keeper) WITHOUT a scope, `unsupported` = why this host can scope nothing, `strayScopes` = scopes that exist but belong to no workspace we asked about (a workspace gone from the store whose detached processes live on) — COUNTED via H1's `countMemberScopes`, never read (FI-1 cannot enumerate scopes without an id), said on the line.
  `rowProcessBytes` (`:117`): the Resources row's process memory = the scope meter + **what the keeper's tree holds OUTSIDE the scope** (`outsideBytes`, RSS — see the producer) + the PTY sessions OUTSIDE the scope (the keeper tree `<wsId>:sdk` is INSIDE it — never added twice); untracked / meter unreadable → the plain tree sum; a PARTIAL read is a lower bound (never below the keeper tree it replaces).
  `formatReliquatsLine` (`:160`), `reliquatsNote` (`:143`, the page's dim line), `reliquatChipTitle`, `reliquatTotals`, `viewFor`.
- **Producer — `src/main/member-memory.ts`**: `sampleMemberMemory(deps)` (`:58`; Electron-free, ids/clock/FI-1 calls injected; `realMemberMemoryDeps` `:41` wires FI-1: `memberScopes` / `readScopeMemory` / `listScopeProcs` / `scopeSupportCached`) — read-only: it never signals, stops or moves anything (the Pause/stop tracks own that), and a throw or null anywhere reads « unmeasured / not tracked », never an exception.
  **What escapes the scope (review F1, FI-1 v1.9).** Real Chromium moves its MAIN process into its own transient systemd scope (`app-org.chromium.Chromium-<pid>.scope`) while its helpers stay in the member's: the scope's bill cannot see the main, and a classifier that only walked the scope would call the helpers Reliquats on a healthy member. FI-1 v1.9 classifies by the HOST-WIDE ppid chain (a helper whose parent left the scope stays `session`) and `listKeeperTreeOutsideScope(scope)` lists the keeper-tree processes whose cgroup is not the scope's; the producer asks it for the scope that holds the keeper (`keeperAt`) and `memberViewFrom(…, outside)` keeps `outsideBytes` / `outsideCount` — **RSS, added to the row** (a mixed unit, honestly: the bill has no figure for what left the cgroup). One stat read per HOST pid per call (H1): memoized per (scope unit, keeper pid) for **10 s** for the pollers (`memoizeEscaped`, `ESCAPED_TTL_MS`), bypassed by the monitor's once-a-minute record (`fresh`); a failed walk is memoized too. A browser that escaped AND outlives its keeper is invisible to every scope reader (ledger Q5).
  A member's **keeper may be in none of its scopes** (it runs unscoped next to an older generation's leftovers): the view carries `keeperInScope`, the row then ADDS the live tree and the stale scope's bill (never the stale scope alone) and the member is also listed `untracked` for its live session. FI-1's `memberScopes` finds a keeper that has not written its pid file yet by its argv inside the scope (H1 took this from the #328 pre-review), so its `keeperPid` is the one identity read — this consumer never guesses a keeper itself. FI-1 answers `[]` from `listScopeProcs` for a vanished scope, so a member list is IGNORED when the meter of the same scope is unreadable (« gone », not « zero Reliquats »). A failing scope read logs ONCE per subject (the page polls every 2 s). Cost (measured here): ~1 ms with no scope, **~12 µs per process living in a scope** (70 ids + one 121-process scope = 2.7 ms; 60 members × 40 processes would be ~30 ms of main-thread time per poll — only while the page is open or `bus-status` runs, the 1.5 s cache shares it).
  **Host facade — `member-memory-host.ts`** `currentMemberMemory({now, fresh})` (`:15`): ids = the store's workspaces ∪ live keepers; a **1.5 s cache** shared by the page's 2 s poll and `bus-status`; the monitor line bypasses it (`fresh`) — a record, not a poll (a cached reading next to a fresh process table skewed the two in the rig).
- **Consumers.** (1) the 60 s monitor line (`resource-monitor.ts`): `ResourceMonitorDeps.memberMemory` is OPTIONAL like the container hooks — only `productionDeps()` installs it (`:450`), so a rig calling `sampleTick()` never reads the host cgroups; `readMembers` (`:467`) never fails the tick; `ResourceLogLine.members` (`shared/resource-monitor.ts`).
  (2) the Resources page (**D-Q3 = mockup A**): `ResourceSnapshot.members` (`main/resources.ts`, read AFTER the sampler's awaits — its cache stamp is its own); `groupSessionsByWorkspace(sessions, containers, members)` (`shared/resources.ts:355`; the page and the screenshot gates call it through `groupSnapshot` (`:410`), the ONE grouping call over a snapshot — sessions + container accounting + member report) replaces a tracked member's row memory (`rowProcessBytes`), composes it with the container fold (`scope + containers`), attaches `SessionGroup.reliquats` (`count`, RSS `bytes`, `partial`, the ≤ 8 heaviest `procs` — pid + comm), and gives a member whose
  SESSION is gone but whose scope still holds **Reliquats** a **scope-only row** (never a row without one — D-Q3: a scope with no Reliquat, e.g. the keeper's boot window, is not a row) (`scopeOnly`, its containers folded into the same row — never a second container-only row); a sandbox row never reads a local scope. **Renderer** (`ResourcesView.tsx`): a yellow **`⚠ N Reliquats` chip** (`SessionChips`, `.res-chip.reliquat`, `data-res-reliquats`, tooltip `reliquatChipTitle`: count · RSS · what a Reliquat is) on the row — hidden at 0 and for an untracked member; the scope-only row renders like the container-only one (cpu / procs « — », no stop button); opening a row lists its heaviest Reliquats after the tree's processes (`.res-proc.reliquat`, ⚠, RSS); a **dim** (not yellow — information, not alarm) `.res-reliquats-note` line under the table from `reliquatsNote` (« Reliquats not tracked for N members (no scope) », or the honest « no live member has a scope (e.g. memory_cap OFF …) », plus stray scopes; nothing on a healthy page).
  (3) `bus-status`: `/busStatus` returns `members` + `memberLabels` from ONE read (`hooks-server.ts:484/515`); the CLI prints `reliquats: 3 live — feat-x ×2 · 610 MB RSS, feat-y ×1 · 80 MB RSS · 14 members tracked · Reliquats not tracked for 5 members (no scope)` (`cli/index.ts:2226`; `0 live`, `(lower bound)` and « could not be fully read » are honest states; nothing tracked: `reliquats: Reliquats not tracked — <reason>`). Absent from an older app → no line.
  (4) the monitor's advisory: `decideReliquatWarnings` (`shared/resource-monitor.ts`) WARNs (`resources: reliquat-rss over threshold — workspace X: N live Reliquats hold … RSS outside its process tree`, advisory, never kills) when a member's Reliquats alone exceed `SESSION_RSS_WARN_BYTES` — the tree advisory cannot see a detached process.
  **Containers are unchanged** (counted by the Docker relay, ADR 0004; a container is not a Reliquat).
- **Not covered here**: reading scopes of workspaces ABSENT from the store (counted as `strayScopes`, not read); stopping/killing Reliquats (#325 / #327); the plafond's own `memory cap:` line (#320). **Known limits**: the `procs` column and the « Live agents / procs » tiles count the process TREE only (a Reliquat adds to MEM, not to procs); a deleted workspace's Reliquats have no row (the stray count says so); a KILL path (#325/#327) must still fail closed on `keeperPid === null` (unknown stays unknown — H1's rule).
- **Gates**: `src/shared/member-memory.test.ts` (M1–M18), `src/main/member-memory.test.ts` (P1–P12 + P14, no P11/P13: fake FI-1 host; the REAL FI-1 binding over a FAKE cgroup tree via `ORCHESTRA_CGROUP_ROOT` — scopes, meter, member list and host-wide count all from H1's functions (P7); the non-Linux fallback THROUGH H1's own code on a darwin env; keeper outside its scopes; the memoized walk (P14). The v1.9 walk itself needs a keeper that REALLY lives in the scope (H1 re-reads its cgroup), so its real chain is the rig arm `browser_escapes_scope`, not a fake tree), `member-memory-wiring.test.ts` (W1–W11: no hard-coded slice path, no signal, productionDeps-only, fresh read, snapshot, `/busStatus` + CLI, the advisory), `resources.test.ts` G6–G12 (incl. `groupSnapshot`, G12 = no Reliquat-less row), `resource-monitor.test.ts`; `pnpm run test:reliquats-shot` (`scripts/reliquats-screenshot.mjs`: the REAL `AgentsTable` + real `styles.css` in a marker-verified headless sway, 4 captures — seeded / expanded / untracked / pre-feature — asserted on text, attributes, computed colours, row layout and PNG density);
  `scripts/e2e-reliquats-memory.mjs` (`pnpm run test:reliquats-memory`; a REAL keeper daemon under FI-1's production `systemd-run` argv in a disposable `orchestra-rig-wh-h2-*` scope, MemoryMax 300M, stopped by name, survivors printed per arm — 8 arms: `known_magnitude` ★ a detached ~100 MB process raises the member by ~+120 MB (inert 0 MB and plain-child controls) while the tree walk moves 0,
  `keeper_gone_reliquat_stays` ★ the tree walk has NO row, the scope still counts the Reliquat, `two_generations`, `untracked_fallback`, `bus_status_line` ★ through the real built CLI, `page_snapshot` ★ the REAL `sampleResources()` (the page's sampler) carries the member report and the page's grouping reads the row from the scope, `browser_escapes_scope` ★ keeper ← CLI ← browser ← 2 helpers where the browser MAIN `exec`s `systemd-run --scope` into its own unit (the reviewer's p4 topology): the main is billed (`outsideBytes` ≈ its RSS, row ≥ bill + main), the helpers are NOT Reliquats (0 on a healthy member); on the nominated tip `ebe3c18e` it is red (`outsideMb` null, row = bill alone), `production_launch` ★ the PRODUCTION path — `memoryCapSpecFor` over a real scratch bus (run frozen memory_cap ON vs OFF) → `makeKeeperSpawn`: ON counts the detached process, OFF reads « not tracked »; `RIG_REPO=<master tree>` = the must-FAIL run) and `scripts/reliquats-memory-mutants.mjs` (84 in-place mutants, `--check-anchors`; a mutant that NAMES a `shot:` check counts as killed only when the screenshot gate itself goes red — W8's source pins alone do not).

## Plafond mémoire in the UI — usage vs cap on Resources + the levels in the Memory guard window (#323, wave H ledger #329; D-Q10 = A + A)
- **What the page shows (A):** a capped member's MEM cell keeps today's figure (the kernel bill, R1) and gains a thin bar under it (`CapBar.tsx`): fill = bill / the hard level the KERNEL holds for that scope (`memory.max` of the keeper's scope), darker inner part = the WORKING SET (`memory.current − inactive_file`, R5 — what the soft warning compares), tick = the soft level. Amber once the working set is at/over the soft level, red once the bill is within 90 % of the hard level (`capUsage`, `CAP_NEAR_FRACTION`, `src/shared/memory-cap-view.ts`; red wins). Tooltip (`capTooltip`) names both figures with what each is compared to, and says « settings now say hard N GB — they apply to sessions started from now on » when the window moved since the member started. A dim line under the table (`capSummaryLine`): « 3 capped members · closest: big-job 93 % of 6 GB » (ranked by the BILL, the cap named exactly — 0.25 GB stays 0.25). The printed percent is FLOORED, so « 90 % » always means red (89.6 % reads 89). A member with several scope generations: the bar is the session's scope only and the tooltip says so (`MemberCapView.scopes`; the MEM figure beside it adds them all). Uncapped members, human sessions, sandbox rows, scope-only (leftover) rows: byte-for-byte today's cell.
- **Data:** FI-1 v1.11 — `readScopeMemory` also returns `workingSetBytes` (null when `memory.stat` is unreadable OR has no `inactive_file`, never the raw figure); `ScopeReading` carries `maxBytes` / `workingSetBytes` / `peakBytes`; `memberViewFrom` → `MemberMemoryView.cap` (`capOf`: only the scope that HOLDS THE KEEPER — an older generation kept alive by Reliquats has its own limit but is not the session's; no limit / 0 / junk / unreadable meter ⇒ null); `groupSessionsByWorkspace` → `SessionGroup.cap` (live session rows only). `ResourceSnapshot.capLevels` = the Garde mémoire cap levels NOW (read hot in `sampleResources`), so the soft tick and the « settings now » note need no second IPC.
- **The soft level shown is the setting NOW** (the kernel does not store the soft level; the keeper holds the one it started with) — the tooltip says « settings now ». The hard level is always the kernel's own.
- **The window (A):** `MemoryGuardSettings.tsx` gains a « Plafond mémoire (per fleet member) » section under the thresholds and toggle: Soft / Hard level inputs (GB, same hot apply on blur / Enter, the PAIR planned by `planCapCommit` in `memory-guard-view.ts` through `patchMemoryGuardSettings`, the very function the write path runs — hard must stay above soft; the MemTotal bound judges only a CHANGED Admission pair, so a small host under the stored 6/3 can still commit its cap and its Reliquat wait; refused inline through the shared error line, nothing sent) and a READ-ONLY line for the activation (`busCapSummary()` → IPC `bus:capSummary` (a LIGHT read in `bus-pane.ts`, one of the pane's READ channels — not the whole `busSnapshot` every 2 s): « Cap is OFF for new runs · ON on 0 of 3 open runs »; a bus that is not open says « open runs unknown (the fleet bus is not open) », never « 0 of 0 »; a host that cannot hold a scope limit adds « no effect on this host: <reason> » — the switch is the frozen per-run `memory_cap`, D-Q1: the window never writes it). The write path is the existing `setMemoryGuard` → `setMemoryGuardSettings` (levels read at the NEXT session start by `memoryCapSpecFor`; the settings-changed log line now names the cap levels). The Reliquat wait (#326, H3's `reliquatWaitMin`, minutes, 1 … 1440, default 30) is the section's third field: committed ALONE through `planReliquatWaitCommit` (same hot apply, same inline refusal; only that key travels); its hint says it counts only above the normal Veille delay and that a fast Veille never waits (`effectiveVeilleWaitMs`). `parseGbInput` accepts plain decimals only (no hex / exponent; « 1,000 » is refused, not read as 1).
- **Proof:** unit (`memory-cap-view.test.ts`, `memory-guard-view.test.ts`, `member-memory*.test.ts`, `memory-scope.test.ts`, `resources.test.ts`), wiring pins (`memcap-settings-wiring.test.ts`), SSR smoke `scripts/memcap-settings-render-smoke.mjs` (in `pnpm run test:render`), mutants `scripts/memcap-settings-mutants.mjs` (`--check` = dry anchor check; an unknown option exits 2 and runs NOTHING — pinned for it and `reliquats-memory-mutants.mjs` by `mutant-dry-check-h2-323.test.ts`, PATH shims that log every launch); pixels: `pnpm run test:memcap-shot` (`scripts/memcap-screenshot.mjs`, own sway: the real `AgentsTable` fed through `groupSnapshot` + the real window, 3 captures asserted on geometry, colours and decoded pixels; heavy); the live commit/refusal on the built app: `scripts/memcap-settings/` (heavy).

## Memory guard — measured, decided, visible (#285, wave G ledger #295; epic #284)

The host's available memory (`MemAvailable`) drives two thresholds (Settings, GB = GiB): **Admission** below 6 (held until
back above 7 = threshold + 1 GB margin) and a **memory Pause** below 3 (lifts above the Admission threshold, 6 — not 7).
**This track holds nothing**: it measures, decides, logs and exposes; #286 (Admission: spawns/restarts) + #287 (Admission: wakes — `docs/codebase-map/workspaces.md` § Admission), #288 (fast Veille), #289 (alert), #290
(memory Pause) consume the API. Glossary: `CONTEXT.md` (Veille, Admission); decision record: `docs/adr/0004-…`.

- **Pure half — `src/shared/memory-guard.ts`** (+ `.test.ts`): `decideMemoryGuard(prev, availBytes, thresholds)` (`:156`) → next
  state + the edges crossed (`admission_held` / `admission_reopened` / `pause_due` / `pause_liftable`, each carrying the memory
  and the threshold that fired) + `pause: none|due|held|liftable` + `mayReleaseOneStart`. All comparisons STRICT (exactly at a
  threshold is not below/above it); unreadable memory (`null`/NaN/negative) = state unchanged, nothing fires, nothing released.
  `episode` increments only on a downward Admission crossing, so jitter inside the 6–7 GB band is ONE episode. Stateless level
  predicates `memoryPauseDue/Liftable` (`:144/:147`) and `mayReleaseOneStart` (`:151`) exist so #290 can re-evaluate against the
  PERSISTED run after an app restart (the in-memory state is gone then). `nextSampleDelayMs` (`:191`): 10 s strictly below the
  Admission threshold (or unreadable), 60 s otherwise — the spec literally, so the 6–7 GB band samples at 60 s even while held.
  `isAdmissionHolding(snapshot)` (`:228`) = `admissionEnabled && admission==='held'` is THE question #286/#288 ask — the global
  toggle OFF still measures/decides/logs. Settings: `normalizeMemoryGuardSettings` (always valid; an invalid PAIR falls back to
  6/3 as a pair), `validateMemoryGuardSettings` (critical < Admission, critical ≥ 0.5, Admission ≤ 256, and — when MemTotal is known and the PAIR is being
  changed — Admission + the 1 GB margin below MemTotal: Admission could otherwise never reopen), `patchMemoryGuardSettings`.
  `parseMemAvailableBytes`, `formatMemoryGuardLine` (the `bus-status` line).
- **Sampler — `src/main/memory-guard.ts`**: `createMemoryGuard(deps)` (`:100`); `deps.readAvailableBytes` is THE injectable
  MemAvailable source (default `readMemAvailableBytes()` in `src/main/mem-available.ts`: `/proc/meminfo`, **Linux only — other
  platforms read null = unmeasured**, never `os.freemem()`), `deps.schedule/cancel` the timer seam. A light chained `setTimeout`
  (re-armed after each sample because the delay changes; reads ONE small file, never the process table — it is NOT the 60 s
  `sampleTick` above, which keeps its cadence). `getSettings()` is read at EVERY sample, so a threshold change is hot.
  Every transition is logged WITH the memory (`[memory-guard] admission HELD (episode 1) — MemAvailable 5.50 GB < 6.00 GB`; WARN
  for held/pause-due, INFO for the upward edges), steady samples log nothing, an outage logs ONE WARN. Process-wide facade
  (frozen API): `getMemoryGuardSnapshot()`, `subscribeMemoryGuard(fn)`, `sampleMemoryGuardNow()` (`:326`, a FRESH read + decision =
  the re-measure between two releases), `startMemoryGuard/stopMemoryGuard`, `setMemoryGuardSettingsReader`;
  `__rebuildMemoryGuardForTests(deps, source)` is the rig seam.
  Snapshot fields consumers lean on (review m5): `mayReleaseOneStart` = the LATEST decision (false while the meter is unreadable, even though
  `availBytes` still shows the last good reading; false before the first sample) and `pauseCycle` (+ on every edge) numbering memory Pauses —
  a 2nd Pause inside ONE Admission `episode` is the next cycle. **No replay**: `subscribeMemoryGuard` delivers only edges AFTER it returns;
  a late subscriber SUBSCRIBES FIRST, then reconciles from `getMemoryGuardSnapshot()` (never snapshot-then-subscribe: an edge between the two is lost — FI-2 item 5 v1.1). Edge delivery is one FIFO drain and a listener is never re-entered
  (a listener may call `sampleMemoryGuardNow()`: its edges queue behind the batch being delivered). **Per-sample hook (FI-2 item 7, additive, #288 follow-up)**:
  `subscribeMemoryGuardSamples(fn(snapshot))` (guard `.onSample`) fires after EVERY sample — tick, `sampleNow`, even an unreadable one — with the state as it stands then
  (after that sample's own edges; delivered through one FIFO and never re-entered — a listener may call `sampleNow()`, that sample queues behind the one being delivered; a sample taken inside an EDGE listener reports itself first and the OUTER sample reports last with the freshest state); a throwing listener is
  ignored; no replay (subscribe first, then reconcile); survives `__rebuildMemoryGuardForTests`. For consumers that act on a LEVEL while it lasts (fast Veille). One WARN per (threshold, machine) when
  Admission + 1 GB can never be reached on this host (`thresholdUnreachable`; e.g. the default 6 GB on a 4 GB machine). Started in `index.ts` right after `startHooksServer()` (store already loaded — so the first `bus-status` has a reading; reader =
  `store.getMemoryGuardSettings()`), stopped in `shutdownSubsystems`.
- **Settings I/O — `src/main/memory-guard-settings.ts`**: `memoryGuardView(settings)` (settings + a FRESH snapshot — a read
  + decision now, so the chip and the live figure can never disagree — whose own reading is `liveAvailBytes`, + MemTotal) and `setMemoryGuardSettings(patch, store)` = validate → persist (`store.memoryGuard`,
  `store.getMemoryGuardSettings()`) → `sampleMemoryGuardNow()` (applies at once). Invalid ⇒ nothing written, `{ok:false,error}`.
  IPC `settings:memoryGuard` / `settings:setMemoryGuard` (`api-handlers.ts`, `preload/index.ts`, `OrchestraAPI.memoryGuard/setMemoryGuard`).
  The Settings dialog (mockup A, D-pick1): `src/renderer/components/MemoryGuardSettings.tsx` — its own modal behind a RAM-chip header icon
  in `Sidebar.tsx` (beside Model defaults), `.mg-*` block at the end of `styles.css`. Live reading + state chip + gauge (ticks at critical /
  Admission / reopen, one label row each — 1 GB is ~14 px on a 32 GB scale), two GB inputs committed on blur/Enter (both fields travel
  together: a pair is only valid as a pair), the toggle, an inline error row; polls `memoryGuard()` every 2 s while open. Pure view logic
  (`guardChip`, `gaugeModel`, `planThresholdCommit`, `parseGbInput`): `src/shared/memory-guard-view.ts`.
- **Visibility**: `/busStatus` (`hooks-server.ts`) returns `memoryGuard: <snapshot>`; `orchestra bus-status` prints one
  `memory:` line (`cli/index.ts`; absent from an older app → no line). Host-wide, not run-scoped. **D1 (ledger #329):** the snapshot's `pause` only
  means "due NOW" — it reads `none` once memory recovered above the critical level while the Pause stays in force until the Admission threshold, and after an app restart — so the line used to print
  `memory Pause none` under a Pause in force. `/busStatus` now also returns `memoryPausedRuns` (`memoryPausedRunViews`, `pause-memory.ts`: the runs paused RIGHT NOW with the epoch-matched memory motive, Reprise-under-way included) and
  `formatMemoryGuardLine(snapshot, paused)` prints `memory Pause IN EFFECT on N run(s) (…) since … (lifts above X GB)` from the BUS; with a list given but EMPTY and the guard held it prints `memory Pause WANTED by the guard since … (lifts above X GB) — no run is paused on the bus` (the fact, no guessed cause, never «IN EFFECT»); no list — an older app, or an UNREADABLE bus (`memoryPausedRunViews` → `null`, omitted from the payload) — = the guard's word.
- **Docker relay hold (#321, consumer of FI-2)**: `src/main/docker-hold-host.ts` subscribes to the per-sample hook and publishes `isAdmissionHolding` + thresholds in `<ORCHESTRA_HOME>/admission.state` (`admissionStateOf`, tmp + rename, removed at quit);
  each keeper's relay WAITS a container create/start while it says held and releases FIFO, one at a time, on a fresh reading (`session-keeper.md` §Docker HOLD). Visibility: `bus-status` `docker holds:` line (`dockerHolds` in `/busStatus`), one bus status per member per episode.
- **Reliquat wait (#326)**: `MemoryGuardSettings.reliquatWaitMin` (minutes, default 30, 1..1440; its OWN scalar — a bad value never resets the thresholds or the cap pair; validated by `validateMemoryGuardSettings`, merged by `patchMemoryGuardSettings`): how long an idle member with LIVE Reliquats waits before its Veille, which then stops + lists them (`activity-pty-terminal.md` §Veille and Reliquats). Read hot at every Veille pass. No UI here (#323).
- **Plafond mémoire levels (#320)**: `MemoryGuardSettings` gains `capSoftGb` / `capHardGb` (defaults 3 / 6 GB, hard > soft, hard ≥ 0.1 GB; normalized/validated as their OWN pair — a bad cap pair never resets the thresholds); read at each member's session start by `memory-cap-switch.ts`. No UI here (#323). `bus-status` prints the `memory cap:` line (`formatMemoryCapLine`).
- **Alert to the LEAD (#289, consumer of FI-2)**: ONE `escalation` bus row per memory EPISODE (the guard's `episode` = one downward crossing of the Admission threshold; oscillation inside the hysteresis band
  never opens another). Pure half `src/shared/memory-alert.ts` (`memoryAlertBody`: thresholds crossed + MemAvailable at the crossing, host actions — starts HELD, members put in Veille since the crossing, runs under the
  memory Pause, unattributed containers (#293: the count from the last monitor tick — `unattributedDocker` says WHY it was not measured: unreachable / query failed / not sampled yet / stale; `unattributedDaemonsDown` makes it « at least ») — the state now, what to expect; `ALERT_SETTLE_MS` = 20 s: the row waits two fast samples so the actions are real numbers, an episode that ends first is
  told when it ends); bus half `src/main/memory-alert.ts` (Electron-free: `createMemoryAlert` — `onEdge` / `reconcile` / `stop`; a critical crossing inside the episode is NOT a new alert, the row names every threshold crossed
  by the time it is written, and a critical crossing AFTER the row was sent writes NOTHING more — the row says so (ruling M2, ledger #295: spec-literal, one row per episode); the "Now" line and the closing are the EFFECTIVE state — `nowPause` = runs ARE under the memory Pause (bus), `nowAdmissionHeld` = `isAdmissionHolding(snap)`, "Admission OFF (toggle)" — and critical with nothing paused says ACT YOURSELF instead of "You need not act"; `alertRecipients` = the coordinator of the TOPMOST run, among the runs with a live
  local fleet, that CAN READ (frozen `delivery` ON, coordinator live) — readers are filtered BEFORE the topmost, so a deaf root does not silence the delivery-ON run below it; the episode is marked told BEFORE the writes, each
  recipient written in its own try; bus/store not ready or facts unreadable ⇒ the timer re-arms, bounded); host `src/main/memory-alert-host.ts` (`startMemoryAlert` in `index.ts` right after the memory Pause: SUBSCRIBE FIRST, then reconcile — a boot while already held tells the
  episode once; Admission queue length via `listHeldStarts()`, Veille by `hibernatedAt`). A paused coordinator reads the row after its Reprise. Gates: `memory-alert.test.ts` (real bus + REAL guard), `memory-alert-wiring.test.ts`,
  `scripts/memory-alert/mutate-unit.mjs`, `scripts/e2e-memory-alert.mjs` (fake source → real guard → real alert host → the LEAD reads the row through the real built CLI; `RIG_REPO=<master tree>` = must-FAIL).
- **Composed proof (#294, wave G ledger #295)**: the 2026-10-06 night replayed in miniature. `scripts/e2e-composed-night.mjs` (`pnpm run test:composed-night` — builds the CLI bundle first, the rig execs it —, ~52 s, 13 named arms n0…n10) drives the REAL modules in ONE sequential scenario on a
  falling FAKE MemAvailable source — real guard, Admission (spawn + restart chokepoints), bus-wake sweep, fast Veille, memory Pause host + Pause trap + Reprise, alert host, real hooks-server + the BUILT CLI — with agents stubbed at the SDK
  delivery seam and Docker on the daemon-faithful `src/main/fake-docker.ts`; `RIG_UPTO=<arm>` stops after an arm, `RIG_REPO=<tree>` is the must-FAIL run (a2951db9: all but the control arm red; 5cf8000e, before #293: exactly the 5 arms that carry container checks). `scripts/composed-night-mutants.mjs` (`pnpm run
  test:composed-night-mutants`, heavy) = 87 in-place clause mutants of #285–#293 (the sweep rebuilds `dist-electron/cli.js` before every run) (anchors copied from the tracks' harnesses or written here, `from` names the source row), each killed only by its NAMED arm + NAMED check. The packaged-app half:
  `scripts/e2e-composed-drive.sh --build` then `--app <bin>` (`e2e-composed-drive.mjs`, 43 checks: banner, members' containers created THROUGH the keeper relay, memory Pause stops them, Reprise restarts them with data intact, the
  many-container Reprise MEASURED, #287's `setWakeKeeperResident` in the real app) + `scripts/composed-drive-mutants.mjs` (build-level mutants: relay stamping, DOCKER_HOST, the keeper-resident wiring). Not in the night, by design: tool-tree
  kill (the pause-trap rig's `memory-arm.mjs`), wake-OFF hold (G7's rig arms), the flush / resume / message / recovery wake sites of #287 (its own wake rig), the relay's own ACs of #291 (`e2e-docker-relay.mjs`). #293 (FI-3) rides the night: the REAL `refreshContainerAccounting` + the production window predicates are ticked BY HAND on the fake daemon (`sampleTick` also reaps keepers; its container wiring is #293's own rig), and the alert row's unattributed count, `bus-status`'s `containers:` line and the "not measured" states are read from it (n0 n4 n6 n7 n10).
  The memory Pause's 15 s level tick is cleared in the rig on purpose: the night proves the EDGE path (impose / lift), the tick is the production safety net.
- **Gates**: `src/shared/memory-guard.test.ts` (boundary ± 1 byte per comparison, episodes, jump, the 2026-10-06 night in
  miniature), `src/main/memory-guard.test.ts` (cadence on the injected scheduler AND on real `setTimeout` via `mock.timers`,
  logging, hot thresholds, unreadable), `memory-guard-settings.test.ts`, `memory-guard-wiring.test.ts` (source guards + the
  "no start path imports the guard yet" tripwire — #286/#288/#289 add their importer there; #288 did: `hibernation.ts` (fast Veille, `activity-pty-terminal.md` §Session hibernation); #289 did: `memory-alert-host.ts`; #290 did: `pause-memory-host.ts`, see `pause-trap.md` §Memory Pause),
  `scripts/e2e-memory-guard.mjs` (fake source → REAL sampler → REAL `/busStatus` in a headless scratch home → REAL built CLI;
  `RIG_REPO=<master tree>` is the must-FAIL run) and `scripts/memory-guard-mutants.mjs` (56 in-place mutants across the pure module, sampler, settings I/O, the Settings view logic and the modal, byte-exact restore; `--check-anchors` is the dry check that every anchor still resolves once).
  `scripts/e2e-memory-guard-modal.mjs` (headless Chromium, no window: the REAL modal bundled with a stub IPC whose latency is the variable —
  a toggle pressed right after a pending edit must reach the backend, text typed during an in-flight commit survives its echo; `RIG_REPO=<tree>`
  = the must-FAIL run), `scripts/e2e-memory-guard-ui.sh <built app dir>` drives the modal in a BUILT app under its own headless sway (heavy: token): real
  /proc/meminfo, thresholds moved around the live reading through the real UI → HELD / memory Pause / inline error / toggle / restore,
  each cross-read from the DOM, the real CLI `bus-status`, the scratch store.json and orchestra.log, + screenshots; red on a pre-fix build.
  Unverified here: macOS (no signal), any consumer — nothing holds yet.

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
- **RSS units (#214 finding).** `/proc/<pid>/stat` field 24 is RSS in PAGES. `parseProcStatLine(text, pageSizeBytes)`
  multiplies by the page size it is GIVEN — the argument is REQUIRED; identity-only readers (`keeper-client`, the reap
  identity check) call `parseProcIdentity` (memBytes 0). The two memory readers (`sampleProcTable` here and in
  `resource-monitor.ts`) pass `hostPageSize()` (`src/main/host-page-size.ts`): `AT_PAGESZ` from `/proc/self/auxv` (the
  kernel's own answer), else `KernelPageSize` at the head of `/proc/self/smaps`; only a power of two in [4 KiB, 64 KiB] is
  accepted (a hugetlb first VMA is refused). Only a SUCCESSFUL read is cached; a failure returns 4096, warns once
  (`resources: cannot read the host page size …`) and retries on the next sample. The sources are injectable
  (`PageSizeSources`) so a test feeds 16 KB on any host. A hardcoded 4096 read RSS **4× low on 16 KB-page hosts**
  (Asahi/aarch64): the Resources page, `resources.jsonl` and the `SESSION_RSS_WARN_BYTES` advisory. **Every
  `resources.jsonl` line now carries `pageSize`** (regime marker); lines WITHOUT it predate the fix and on a 16 KB host are
  4× low — rescale by `pageSize/4096` (the #214 field replay does). Gates: `scripts/e2e-rss-page-size.mjs` — real
  `procTable`/`sampleTick` AND the real `sampleResources()` (`scripts/rss-page-size/`, only pty/events/statfs/platform
  stubbed) over a real tree vs `VmRSS`; the rig arms are non-discriminating on a 4 KB host (said loudly there) — the
  injected-source unit arms carry the proof anywhere.
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
  - **ASYNC + SINGLE-FLIGHT, off the hot path (issue #96):** `sampleVolumes()` /
    `statVolume()` / `statVolumeFor()` are `async` and go through
    `fs.promises.statfs`, not `fs.statfsSync`. The old sync call ran on the
    **main thread** every 2s tick; on a hung network mount (NFS/sshfs whose
    server has gone away) `statfsSync` blocks indefinitely and freezes the whole
    UI. The async call runs on libuv's threadpool and never blocks the event
    loop. Each probe is raced against `STATFS_TIMEOUT_MS` (1 s, exported) so the
    CALLER gets a `null` = **UNMEASURED** result promptly (the same "never
    silently plenty" contract) instead of awaiting a dead mount forever. The
    three probes run concurrently (`Promise.all`); de-dup/order is applied after
    they settle. **No cache** — still fresh every tick for LIVE mounts, so #87's
    anti-stale design is intact; the timeout is a per-tick abandon bound, not a
    TTL.
  - **The threadpool trap (review F1, MEASURED):** the timeout unblocks the main
    thread but does **not** free the libuv work-thread — `fs.promises.statfs` on
    a hard-hung mount holds its pool thread on `statfs(2)` uninterruptibly
    (libuv cannot cancel dispatched fs work). Dispatching a fresh statfs every
    tick during an outage would pile up hung threads and exhaust the default
    `UV_THREADPOOL_SIZE=4` (~6 s in), starving all other async fs I/O in main and
    cascading the healthy probes to UNMEASURED. So statfs/stat are **single-flight
    per path** (`statfsInFlight`/`statInFlight` maps in `disk-space.ts`): while a
    probe's syscall is still pending from a prior tick, later ticks reuse that one
    pending promise instead of dispatching another. The ceiling of stuck pool
    threads is then the number of distinct hung mounts (≤ 3), CONSTANT across an
    outage — no accumulation. It cannot be zero (one dispatch per hung mount is
    unavoidable), so a hard-hung mount can still *degrade* background fs I/O — the
    guarantee is **bounded, not free**, which is what the corrected `resources.ts`
    comment now says. Diagnostics: `inFlightStatfsCount()`; `__resetInFlightForTest()`
    is test-only.
  - `resources.ts` `awaits sampleVolumes()`. `nearestExisting()` stays sync on
    purpose (it's `lstat`/`existsSync` on local path components, not the `statfs`
    that blocks). `scripts/disk-guard.cjs` keeps its own **sync** statfs — it's a
    run-to-completion CLI, not on any 2s tick.

### Reading the PTY listing from a script (removal rig, #225)

`window.orchestra.sampleResources()` (preload `sampleResources` → `resources:sample`) is
callable from any CDP-driven page, so an E2E rig gets the live PTY sessions **by kind**
(`sessions[].{ptyId, kind, workspaceId, remote, procCount, processes[].pid}`) with NO extra
exposure — this is how `scripts/e2e-agent-view-removal.mjs` (`ptys()` in `appApi`) counts
agent/run/nvim/login PTYs. It lists the PTY sessions plus those `:sdk` rows: keeper-hosted SDK sessions are
detached daemons, not PTYs — they appear (since #293) only as synthetic `<wsId>:sdk` rows of kind `sdk`, never as `agent`. `kind === 'agent'` means "id is a bare
workspace id" (`classifyPtyId`), so it is the legacy agent-PTY path by construction. Prove the
instrument with a positive control (open Run → a `run`-kind PTY appears) before trusting an
"absent" reading — see [activity-pty-terminal.md](activity-pty-terminal.md) § Removal rig.

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
