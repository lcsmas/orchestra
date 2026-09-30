# Session budget suite (#208)

A session budget is a **number a fresh session must not exceed**, measured on the REAL path: `agent-sdk.ts`
`sdkSend` → `ensureSession` → SDK `query()` → the detached **keeper** → the real `claude` CLI, in a
generated heavy fixture repo, against a **local fake Anthropic API** — zero tokens, no login, no network
(ledger #237 D6), with **production env** (none of the CLI's traffic-suppressing knobs) inside **mandatory** net+pid
namespaces. First budget: before the first reply, **exactly 1 main (tool-carrying) model request, 0 `count_tokens`**, plus
explicit ceilings on every tool-less side call and every refused egress attempt — the check that would have caught #176
(a boot-time `getContextUsage()` fanned out into one `count_tokens` per memory file).
Run: `pnpm run test:session-budget` (~13 s; rebuilds `dist-electron/keeper.js` first). Wired into the release gate as
step 3 (`build-release.md`).

## Pieces

| Piece | File | Role |
|---|---|---|
| **Budget numbers + judge (ONE source)** | `src/shared/session-budget.ts` | `SESSION_BUDGETS` (frozen), `SUBJECT_MARKERS`, `TRAFFIC_KNOBS`, `summarizeWindow` (main = tool-carrying model call, side = tool-less by model, count_tokens, other routes, refused egress by `host:port`), `SessionBudgetReport`, `judgeSessionBudget(report)` → `{ok, void, verdicts[]}`. Two verdict kinds: `budget` (`BUDGET BROKEN <id>: allowed …, saw N — before the first reply the session sent model=… count_tokens=… other=… \| main=… side={…} egress={…}`; ids `…modelRequests`, `…sideModelRequests.<model>`, `…countTokensRequests`, `…otherRequests`, `…egressAttempts.<host:port>`; a model/host not listed is budgeted at 0) and `instrument` (`INSTRUMENT VOID …`: nothing was measured — containment weaker than net+pid namespaces (unless `SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT=1`, printed), a traffic-suppressing env knob set, no outbound attempt seen, clock not started at send, the run raised, no first reply, no keeper/cli process, MCP not connected / not real children, tools or a planted sentinel missing from the main request). A VOID run is never a pass. **C3 #210 / C4 #211 / C7 #214 add their number here + a rule + a report field; nothing else restates a budget.** Unit: `session-budget.test.ts` (numbers pinned as literals). |
| Fake API + egress proxy | `scripts/session-budget/fake-anthropic-api.mjs` | `startFakeApi({markers, replyDelayMs})`: records EVERY request by type (`model` = `POST /v1/messages`, `count_tokens`, `models`, `bootstrap`, `other`) with tMs/model/tools/planted-marker hits; canned wire-valid SSE reply; `count_tokens` → `{input_tokens}`; unknown route → recorded 404. A second listener is the `HTTPS_PROXY` target: every `CONNECT`/absolute-URI request is **recorded and refused** (`egress`). |
| Heavy fixture | `scripts/session-budget/fixture.mjs` (+ `fake-mcp-server.mjs`) | `generateHeavyFixture(dir, profile)` — deterministic (seeded), git repo: 60 skills, 48 KB CLAUDE.md, **50 `.claude/rules/*.md`** (the axis that multiplies `count_tokens`: one call per memory file, measured 47 for 40 files; skills and MCP tools are batched), 4 stdio MCP servers × 15 tools. Sentinels planted in CLAUDE.md, the last rule, last skill, last MCP tool. |
| Runner (one session per process) | `scripts/session-budget/session-runner.mjs` | Scratch HOME / `CLAUDE_CONFIG_DIR` / `ORCHESTRA_HOME` (guard first; **fails closed** if the parent's live-dir list is absent), dummy `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`=fake, the refusing `HTTPS_PROXY` (names hosts), every `TRAFFIC_KNOBS` env var DELETED (production parity; reported in `envParity`), installs the built keeper bundle, `sdkSend`s one turn (clock t0 stamped just before), taps `agent:event` on the platform seam. **First reply = first `text-delta`**; requests are split at that instant (same monotonic clock as the fake API). Census at first reply/end, teardown as a workspace delete does, survivors counted. Emits `{report, judgement}`. |
| Harness API | `scripts/session-budget/harness.mjs` | `ensureBuilt(repo)`, `detectContainment()`, `runSessionArm({repo, arm, mutant?, profile?, containment?})`, `findOnPath`, `reapScratchProcesses`. Containment = `bwrap --unshare-net --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp` (`netns+pidns`: no egress possible, every descendant dies with the run) and it is **mandatory**: `runSessionArm`/`runSelfTest` return `{void, error}` without spawning when it is unavailable (`netns`/`proxy-only` only with the explicit env opt-out, echoed in the report; reaped by scratch `HOME` in `/proc/*/environ`). NOT `unshare -r`: it maps uid 0 and the CLI then refuses `bypassPermissions`. |
| Driver | `scripts/session-budget/run.mjs` (`scripts/e2e-session-budget.sh`) | Session arms `normal` (must PASS), `slow-startup` (a slow MCP server delays the main request ~1.7 s and the CLI retries one refused call: must PASS — the C4 false-red case), `boot-context-read` (must FAIL naming `session.beforeFirstReply.countTokensRequests`, burst ≥ 50), `traffic-knob-in-env` (a `buildSdkEnv` edit hands the CLI `DISABLE_TELEMETRY`: must be VOID naming `instrument.productionEnv`) and `app-egress-new-host` (an `ensureSession` edit `fetch()`es a new host: must FAIL naming it in `startupEgressAttempts`); self-test arms `census-selftest` (pid-namespace census = exactly the runner's tree) and `smoke-flag-path` (the real-API smoke's flag path, real CLI vs fake API) — host-dependent checks live HERE, never in `pnpm run test`, which must not need `bwrap` or a real `claude`. A run whose report carries `error` is `RUN BROKE` (rc 1). Prints requests by type (before/after first reply/total, with main/side/egress), each tool-less side call with a preview of its prompt, time to first reply (from just before `sdkSend`; runner setup reported apart), child-process census (`cli/keeper/mcp/hook/other`, rss, survivors after teardown), CLI version, egress, routes. Exit 0 / 1 / 3 (VOID); last line `SESSION-BUDGET: PASS|PARTIAL|PASS-WEAK|FAIL|VOID` (`sessionBudgetTerminator`: `PASS` only for a FULL run under full containment; `PARTIAL` = `--arm` ≠ all; `PASS-WEAK` = weak-containment opt-out; the release gate accepts nothing but the exact `PASS`). `SESSION_BUDGET_SKIP_BUILD=1` uses the prebuilt keeper bundle (the unit test that drives the driver must not rebuild it while `keeper.test.ts` spawns it). `--json` for one JSON line per arm. |
| Must-FAIL mutant | `scripts/session-budget/mutants.mjs` | Node `load` hook that rewrites `src/main/agent-sdk.ts` **as it loads** (nothing on disk): re-adds `refreshContextUsage(wsId)` after `void consume(session)` (the pre-fix code, `git show 89ae8b4b^`). The anchor must match **exactly once** or the run throws `PATTERN-GONE` (unit-tested against the shipped file). |
| Process census | `scripts/session-budget/proc-census.mjs` | `/proc` walk: in a pid namespace every process except pid 1/self, else the runner's descendants; zombies listed apart; per-process `rssKB`/`swapKB` from `/proc/<pid>/status` (never `statm`×4 — 16 KB pages) and `procs[]` (the named tree). |
| Real-delete teardown + #210 arms | `scripts/session-budget/delete-teardown.mjs`, `procs-arms.mjs`, `measure-procs.mjs` | `teardown: 'cli'\|'ui'` runs the REAL delete path and reports survivors; `PROCS_ARMS` + `judgeProcsArm` (must-FAIL shape checker); `measure-procs.mjs` prints the spread the budget numbers come from. See § Processes, memory, zero survivors after delete. |
| Scratch guard (D7) | `scripts/session-budget/scratch-guard.mjs` | `assertScratch` refuses any HOME/config/`ORCHESTRA_HOME` that is, resolves into, or contains `~/.claude*`, `~/.orchestra*`, or the invoker's `CLAUDE_CONFIG_DIR`/`ORCHESTRA_HOME` (symlinks resolved). |
| Optional real-API smoke | `scripts/session-budget/smoke-real.mjs` (`pnpm run smoke:session-budget-real`) | ONE tiny cheap-model turn (`--model haiku`, no tools/MCP, nothing persisted, `--max-budget-usd 0.05`). Refuses unless `--real-api` AND an explicit `--config-dir` (the account billed; never defaulted). `--api-base` redirects it (how tests prove the flag path against the fake API). The release gate runs it only when `RELEASE_REAL_API_SMOKE_CONFIG_DIR` is set. **Never run against the real API by tests or by the C1 author.** |

## Measured facts (CLI 2.1.284, SDK 0.3.241)

**Production numbers** (suite env = Orchestra's env: no traffic-suppressing knob — `git grep NONESSENTIAL src scripts` finds
none; fake non-first-party base URL; netns; 10/10 identical runs, 2026-09-30, load 9–11). Before the first reply:

| what | number | note |
|---|---|---|
| main model request (tools>0) | **1** | `claude-opus-4-8`, ~92 tools, carries CLAUDE.md + rules + skills + MCP tools |
| tool-less side model call | **1 × `claude-haiku-4-5-20251001`** | lands ~170 ms BEFORE the main request; its prompt is `<session>…</session> Write the title in …` = the CLI's **session-title generator** |
| `count_tokens` / other routes | **0 / 0** | |
| refused egress attempts BEFORE THE MAIN REQUEST STARTS | **3 × `api.anthropic.com:443`** | hard-coded host, ignores the base URL; 5 by the first reply, 8–9 by the end of the run (the rest are triggered by the request/reply or retried on a ~2 s backoff, so they grow with elapsed time and are printed, not budgeted). In production these reach the real API — what they are is NOT identified |

**Windows (review round 2 F3 + C4's false red).** Request budgets cover everything up to the first turn's **`turn-end`** event: the
legitimate gauge refresh is triggered BY that event, so it cannot fall inside the window whatever the reply latency or observation
lag (proven: reply delay 500/2000/5000 ms, and an order-preserving +250 ms lag on every observed event, all PASS). Egress is
budgeted on a separate **causal** cut — attempts up to `STARTUP_CUT_MARGIN_MS` (150) before the main request's *start* (headers in;
the attempts the CLI fires together with the request land at −4…+56 ms around it, a coin flip at the cut, so they are excluded).
That count is **not** time-invariant: a refused startup call is *retried* by the CLI ~1.1 s after the first burst, so a slow but
healthy startup shows 4 (a slow MCP server: 4 in 3/3 runs at span 1.4–1.7 s and in 3/3 at 2.2–2.7 s; C4 saw a healthy 12.8 s run
with 6 under the old reply-relative window). The judge therefore gives a **known** host `base 3 + floor(startup span / 1000 ms)`
attempts (`startupRetryAllowance`) — a slow-but-healthy run passes (arm `slow-startup`) — while an **unlisted host is always 0**,
however slow (a retry only goes to a host already attempted). Fast startups (span < 1 s) keep the exact ceiling of 3: 34 of 35 fast
runs, incl. 5 pinned to one core and 5 sharing that core with 3 busy-loops (span 1.1–1.4 s). A span over `STARTUP_SPAN_MAX_MS`
(8000) is VOID (`instrument.startupNotStalled`: beyond the CLI's own MCP timeout, something is broken). Egress after the main
request is printed, not budgeted (it grows with elapsed time).

The budgets in `session-budget.ts` are these numbers as ceilings; a NEW startup call (another side model, another route, another
host, one more attempt) breaks one by name. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the title call and the egress
disappear (main=1, egress 0) — which is why the suite does NOT set it, and why `instrument.productionEnv` /
`instrument.nonessentialTrafficVisible` VOID a run that looks suppressed (ceilings alone would pass it).

- Against the fake API the CLI calls only `POST /v1/messages?beta=true` and `POST /v1/messages/count_tokens?beta=true`.
  No `/v1/models`, no bootstrap on the base URL.
- A non-first-party `ANTHROPIC_BASE_URL` makes the CLI treat the provider as third-party: GrowthBook off, tool search off (all
  tools inline). First-party-only behaviour (what production's 5+3 attempts fetch, tool search) is NOT exercised.
- In SDK streaming mode `system/init` is emitted only after the first prompt; never gate the prompt on init.
- Normal arm: the turn-end gauge refresh then sends ~57 `count_tokens` AFTER the first reply (legitimate; reported as
  `afterFirstReply`, not budgeted). Mutant arm: 57 BEFORE it.

## Processes, memory, zero survivors after delete (#210)

**Numbers live ONLY in `SESSION_BUDGETS.processes` / `.afterDelete`
(`src/shared/session-budget.ts`)**, with the measured spread beside them; re-measure with
`node scripts/session-budget/measure-procs.mjs --runs 8` before moving one. Every arm judges the process/memory budgets
at the first reply AND settled: exactly 1 keeper, 1 CLI, 1 process per configured MCP server, 0 hook, 0 other, tree memory
≤ 400 MB + 65 MB/server (RSS+swap; measured 498–530 MB). A broken verdict carries `tree` (pid/kind/MB/argv) —
`formatProcessTree`. A census that saw no tree is VOID (a max-budget over nothing passes).
- **Census reads `/proc/<pid>/status` `VmRSS`+`VmSwap`, never `statm`×4** — this host runs 16 KB pages (Asahi), `statm` read 4× low.
- **Delete arms** (`delete-cli` = socket `/deleteWorkspace` → `dispatchDeleteWorkspaceRequest`; `delete-ui` = the renderer IPC
  handler `apiHandlers.deleteWorkspace` = `sdkStopMany` + `deleteWorkspace`) tear the session down through the REAL path
  (`scripts/session-budget/delete-teardown.mjs`). The delete call is RACED against the 10 s bound (a hung delete still gets its
  tree censused and named: `session.delete.returnsWithinMs`), the tree is polled to its first zero, and that zero is then
  WATCHED for `afterDelete.stableForMs` (2 s) — a relaunch after the sweep appears later, and `instrument.delete.dwelled` makes an
  unwatched zero VOID. Survivors = pre-delete tree members alive by (pid, start-time) **plus** anything left in the pid
  namespace (`alive()`'s two halves): a subtree census alone loses an orphaned CLI (ppid → 1; measured: proxy-only containment
  reads 0 with the identity clause mutated out, 1 with it), and a process that was never in the tree shows only in the
  namespace half.
- **Racing wake** (`deleteOpts.wakeDuringDelete`): `sdkSend` fired while the session is stopping and `killKeeper` is in flight.
  `delete-cli-wake-race` (must PASS) needs the launch tombstone (`forbidKeeperLaunch`) to REFUSE it — the session emits
  `keeper start refused`, recorded as `wake.refusals` and required by `mustSeeRefusal` (else 0 survivors proves nothing);
  `delete-cli-wake-race-no-tombstone` (mutant drops `forbidKeeperLaunch`) relaunches a whole NEW 6-process tree and fails naming it.
  `delete-cli-late-relaunch` (a process started 1.5 s after the sweep) is caught only by the census half + the dwell;
  `delete-cli-hangs` (the stop never returns) only by the race against the bound.
- **`--stubborn` MCP** (`profile.stubbornMcp`) ignores stdin EOF/SIGTERM like an `npx` grandchild: the CLI's abrupt death
  (keeper SIGTERM) leaves it; only `killKeeperTree` (snapshot taken BEFORE the stop) reaps it.
- **Masking to know:** the UI route also stops the session (`sdkStopMany` → graceful close), so a mutant skipping only
  `stopStructuredSession` leaves 0 survivors there (measured) — the CLI arm pins that clause; `delete-ui-skips-stop` removes
  both stoppers.
- Must-FAIL arms (`scripts/session-budget/procs-arms.mjs`, mutants in `mutants.mjs`): source mutants of `workspaces.ts` /
  `api-handlers.ts` (load-time, nothing on disk) and BUNDLE mutants of the scratch `keeper.js` copy (`keeper-extra-child`,
  `keeper-ballast`); each arm names the budget it must break, its literal actual, the text its tree must contain, and the
  budgets that must stay green.
- **Suite cost:** +11 session arms (`delete-cli`, `delete-ui`, `delete-cli-wake-race`, `procs-extra-child`, `mem-keeper-ballast`,
  `delete-cli-skips-stop`, `delete-cli-skips-tree-sweep`, `delete-cli-wake-race-no-tombstone`, `delete-cli-late-relaunch`,
  `delete-cli-hangs`, `delete-ui-skips-stop`) ≈ +4 min on `pnpm run test:session-budget` and on the release gate (each survivor arm
  burns the 10 s bound; every zero is watched 2 s more).
- **Boundaries, not modelled:** a DOUBLE-FORKED descendant (reparented to init before the snapshot) escapes the product's
  `snapshotKeeperTree` (it walks ppid) — the pid-ns census sees it but no arm creates one (`--stubborn` keeps its ppid chain);
  `hook: 0` is exercised by synthetic unit reports only (the fixture installs no Orchestra hooks) and `zombies` is censused but
  read by no verdict; `zeroWithinMs` (5 s) times a `kind:'scratch'` delete (no archive script / `git worktree remove`) and sits inside
  the product's own kill ladder (`killKeeperUnlocked`: ≤3 s socket + ≤5 s pid + 1 s + 1 s — healthy 33–633 ms); removing only
  `sdkStopIfLive` or only `killKeeper` from `stopStructuredSession` is caught with the wrong attribution (`agent error event`, no
  tree named) — only the whole-stop and tree-sweep removals name the tree.
- **NOT proven:** numbers are aarch64 / 16 KB pages / node 22 / CLI 2.1.284 against the fake API (a small context — the 275 MB CLI is
  not a production steady state; an x86 4 KB host reads lower, so the budget only gets less sensitive there); a real `npx`-wrapped MCP
  tree is modelled by `--stubborn`, not run; the renderer route is `apiHandlers.deleteWorkspace` called directly, not through Electron
  IPC; no arm runs without net+pid namespaces (the suite is VOID there by design — the identity clause was probed once by hand).

## Coverage — what a green suite does and does NOT prove

Covered: `sdkSend → ensureSession → buildSdkEnv → SDK query() → keeper → real CLI` on a fresh session with a heavy project.
**Egress visibility:** the CLI is behind `HTTPS_PROXY`; the *app process* (the runner, which hosts agent-sdk.ts) is started with
`NODE_USE_ENV_PROXY=1` + the same proxy (Node 22.22 reads it at bootstrap — the harness picks the ports in advance), so its
`fetch()`/`http(s)` startup calls to an unlisted host are counted and break the budget. NOT visible: raw `net`/`tls` sockets, `dns`
lookups, and any CLI connect that ignores the proxy env (not enumerated — no `strace` here; in the netns they fail unseen).
`instrument.productionEnv` reads the env the **CLI was handed** from `/proc/<cli pid>/environ` at the first reply (an app-code edit
that adds a suppressing knob is caught; the runner's own env is irrelevant).
NOT covered: `workspaces.ts` (spawn/promote/wake/resume, hook install into `.claude/settings.local.json`, orchestra-* skills,
account env), UI-triggered calls, the built Electron app. A boot read added at a *caller* of `ensureSession` passes. **Accepted gaps:** a boot read deferred past `turn-end` is only printed (`afterFirstReply`) — the legitimate turn-end refresh is itself
57; side calls are budgeted by *model*, not purpose (a CLI update replacing the title call with another tool-less haiku call keeps
the count — the prompt preview is printed; C4 re-runs on a CLI change); a single extra same-host startup call is only
detected when startup is fast (span < 1 s → exact 3): on a slow startup the retry allowance (+1 per second) can hide it.

## Traps

- One session per process (agent-sdk.ts module state is global). The fake API's `replyDelayMs` (500) models real model latency.
  A longer delay does NOT only strengthen the normal arm: it lengthens the session, so attempt counts that grow with elapsed time
  (post-request egress, retries) grow too — which is why egress is budgeted on the causal pre-main-request cut, not on a
  reply-relative window (a reply-relative egress ceiling failed at reply delay ≥ 2000 ms: 6–7 attempts). A SLOW startup inflates the pre-main count
  too (see Windows) — hence the span-scaled allowance for known hosts.
- Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` was set at process START; setting it later does nothing. A
  proxy that HOLDS refused connections open stalls the CLI's startup by ~5 s — refuse at once instead.
- A refused-CONNECT socket may RST — the proxy swallows socket errors (found by the first spike; unit-tested).
- Don't `pkill -f` a spike by a path token that also appears in your own command line (it kills the wrapper).
