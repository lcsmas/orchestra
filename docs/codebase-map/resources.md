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
  STAMPED on); each container is measured on the daemon it lives on. `listContainers({status:['running']})`, then **ONE stats pass — and NO stats call at all when no attributed container exists** (AC); ≤ 4 in flight
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
- **Gates**: `src/shared/container-accounting.test.ts` (C1–C19), `src/main/container-accounting.test.ts` (K1–K15, fake daemons), `container-window.test.ts` (CW1–CW4, real bus), `container-budget.test.ts` (B1, real `sampleTick`), `container-accounting-wiring.test.ts` (W1–W8), `scripts/e2e-container-memory.mjs`
  (**HEAVY — the heavy-rig token**; 4 arms on the host's REAL dockerd: a 200 MiB tmpfs container raises its workspace by ~205 MB and a 2nd SUMS to ~303 MB, through the real `sampleTick` AND the page's
  `groupSessionsByWorkspace`; no stats call without an attributed container; a stray container created on the real socket during a run + an orphan are unattributed, named, never touched — not even a stop/start
  attempt; Docker down ≠ zero; rig-unique prefix + `g9rig` label, removed by id, bystanders compared before/after; refuses below 9 GB; `pnpm run test:container-memory`),
  `scripts/container-memory-mutants.mjs` (~100 in-place mutants, `--check-anchors`, private backup dir).

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
- **Visibility**: `/busStatus` (`hooks-server.ts:489`) returns `memoryGuard: <snapshot>`; `orchestra bus-status` prints one
  `memory:` line (`cli/index.ts:2179`; absent from an older app → no line). Host-wide, not run-scoped.
- **Alert to the LEAD (#289, consumer of FI-2)**: ONE `escalation` bus row per memory EPISODE (the guard's `episode` = one downward crossing of the Admission threshold; oscillation inside the hysteresis band
  never opens another). Pure half `src/shared/memory-alert.ts` (`memoryAlertBody`: thresholds crossed + MemAvailable at the crossing, host actions — starts HELD, members put in Veille since the crossing, runs under the
  memory Pause, unattributed containers (#293: the count from the last monitor tick — `unattributedDocker` says WHY it was not measured: unreachable / query failed / not sampled yet / stale; `unattributedDaemonsDown` makes it « at least ») — the state now, what to expect; `ALERT_SETTLE_MS` = 20 s: the row waits two fast samples so the actions are real numbers, an episode that ends first is
  told when it ends); bus half `src/main/memory-alert.ts` (Electron-free: `createMemoryAlert` — `onEdge` / `reconcile` / `stop`; a critical crossing inside the episode is NOT a new alert, the row names every threshold crossed
  by the time it is written, and a critical crossing AFTER the row was sent writes NOTHING more — the row says so (ruling M2, ledger #295: spec-literal, one row per episode); the "Now" line and the closing are the EFFECTIVE state — `nowPause` = runs ARE under the memory Pause (bus), `nowAdmissionHeld` = `isAdmissionHolding(snap)`, "Admission OFF (toggle)" — and critical with nothing paused says ACT YOURSELF instead of "You need not act"; `alertRecipients` = the coordinator of the TOPMOST run, among the runs with a live
  local fleet, that CAN READ (frozen `delivery` ON, coordinator live) — readers are filtered BEFORE the topmost, so a deaf root does not silence the delivery-ON run below it; the episode is marked told BEFORE the writes, each
  recipient written in its own try; bus/store not ready or facts unreadable ⇒ the timer re-arms, bounded); host `src/main/memory-alert-host.ts` (`startMemoryAlert` in `index.ts` right after the memory Pause: SUBSCRIBE FIRST, then reconcile — a boot while already held tells the
  episode once; Admission queue length via `listHeldStarts()`, Veille by `hibernatedAt`). A paused coordinator reads the row after its Reprise. Gates: `memory-alert.test.ts` (real bus + REAL guard), `memory-alert-wiring.test.ts`,
  `scripts/memory-alert/mutate-unit.mjs`, `scripts/e2e-memory-alert.mjs` (fake source → real guard → real alert host → the LEAD reads the row through the real built CLI; `RIG_REPO=<master tree>` = must-FAIL).
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
