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
| Runner (one session per process) | `scripts/session-budget/session-runner.mjs` (SOURCE loader: guard + env pin, then imports) → `session-run.mjs` `runSession(cfg, mods)` (the run BODY, shared with the bundled runner of the CLI-version re-run) | Scratch HOME / `CLAUDE_CONFIG_DIR` / `ORCHESTRA_HOME` (guard first; **fails closed** if the parent's live-dir list is absent), dummy `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`=fake, the refusing `HTTPS_PROXY` (names hosts), every `TRAFFIC_KNOBS` env var DELETED (production parity; reported in `envParity`), installs the built keeper bundle, `sdkSend`s one turn (clock t0 stamped just before), taps `agent:event` on the platform seam. **First reply = first `text-delta`**; requests are split at that instant (same monotonic clock as the fake API). Census at first reply/end, teardown as a workspace delete does, survivors counted. Emits `{report, judgement}`. |
| Harness API | `scripts/session-budget/harness.mjs` | `ensureBuilt(repo)`, `detectContainment()`, `runSessionArm({repo, arm, mutant?, profile?, containment?})`, `findOnPath`, `reapScratchProcesses`. Containment = `bwrap --unshare-net --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp` (`netns+pidns`: no egress possible, every descendant dies with the run) and it is **mandatory**: `runSessionArm`/`runSelfTest` return `{void, error}` without spawning when it is unavailable (`netns`/`proxy-only` only with the explicit env opt-out, echoed in the report; reaped by scratch `HOME` in `/proc/*/environ`). NOT `unshare -r`: it maps uid 0 and the CLI then refuses `bypassPermissions`. |
| Driver | `scripts/session-budget/run.mjs` (`scripts/e2e-session-budget.sh`) | Session arms `normal` (must PASS), `slow-startup` (a slow MCP server delays the main request ~1.7 s and the CLI retries one refused call: must PASS — the C4 false-red case), `boot-context-read` (must FAIL naming `session.beforeFirstReply.countTokensRequests`, burst ≥ 50), `traffic-knob-in-env` (a `buildSdkEnv` edit hands the CLI `DISABLE_TELEMETRY`: must be VOID naming `instrument.productionEnv`) and `app-egress-new-host` (an `ensureSession` edit `fetch()`es a new host: must FAIL naming it in `startupEgressAttempts`); self-test arms `census-selftest` (pid-namespace census = exactly the runner's tree) and `smoke-flag-path` (the real-API smoke's flag path, real CLI vs fake API) — host-dependent checks live HERE, never in `pnpm run test`, which must not need `bwrap` or a real `claude`. A run whose report carries `error` is `RUN BROKE` (rc 1). Prints requests by type (before/after first reply/total, with main/side/egress), each tool-less side call with a preview of its prompt, time to first reply (from just before `sdkSend`; runner setup reported apart), child-process census (`cli/keeper/mcp/hook/other`, rss, survivors after teardown), CLI version, egress, routes. Exit 0 / 1 / 3 (VOID); last line `SESSION-BUDGET: PASS|PARTIAL|PASS-WEAK|FAIL|VOID` (`sessionBudgetTerminator`: `PASS` only for a FULL run under full containment; `PARTIAL` = `--arm` ≠ all; `PASS-WEAK` = weak-containment opt-out; the release gate accepts nothing but the exact `PASS`). `SESSION_BUDGET_SKIP_BUILD=1` uses the prebuilt keeper bundle (the unit test that drives the driver must not rebuild it while `keeper.test.ts` spawns it). `--json` for one JSON line per arm. |
| Must-FAIL mutant | `scripts/session-budget/mutants.mjs` | Node `load` hook that rewrites `src/main/agent-sdk.ts` **as it loads** (nothing on disk): re-adds `refreshContextUsage(wsId)` after `void consume(session)` (the pre-fix code, `git show 89ae8b4b^`). The anchor must match **exactly once** or the run throws `PATTERN-GONE` (unit-tested against the shipped file). |
| Process census | `scripts/session-budget/proc-census.mjs` | `/proc` walk: in a pid namespace every process except pid 1/self, else the runner's descendants; zombies listed apart. Reused by C3. |
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

## CLI-version re-run (#211) — the suite runs itself when `claude` updates

The CLI is not our code: a `claude update` can change its costs with no Orchestra commit. Orchestra therefore re-runs
this suite **once, in the background**, when the installed `claude` differs from the last BUDGETED version, and speaks
only if a budget broke (D5: one log line + one OS notice, no new UI element; D6: fake API, zero tokens).

**What runs it in a packaged build (the design answer).** Not the repo — an installed app has no checkout and its
Electron 33 Node 20 has no `--experimental-strip-types`. A **bundled runner**: `pnpm run build:session-budget` →
`dist-electron/session-budget.js` (~600 KB CJS: `bundle-entry.mjs` + `session-run.mjs` + the real `agent-sdk.ts` session
path + fake API + fixture generator + the judge; `electron` aliased to the headless stub; SDK/node-pty/better-sqlite3
external, resolved from `app.asar/node_modules`). The app runs it in place as
`ELECTRON_RUN_AS_NODE=1 <process.execPath> <app.asar>/dist-electron/session-budget.js` under the harness (bwrap net+pid
ns when available, scratch HOME/config, D7 guard). The runner is built from the SAME commit as the app, so it measures
what that Orchestra does with the new CLI. Absent bundle (a `pnpm dev` tree that never built it) ⇒ skip + one log line;
non-Linux ⇒ skip (the census reads `/proc`). The fixture's MCP servers are repointed at a copy of `fake-mcp-server.mjs`
written into the scratch root with `ELECTRON_RUN_AS_NODE=1` in the server `env` (the CLI does not forward that var).

| Piece | File | Role |
|---|---|---|
| Pure decider + record | `src/shared/cli-budget-rerun.ts` | `CLI_BUDGET_RERUN` bounds (90 s startup delay, 10 min poll, 150 s run bound, 60 s turn, ≤3 launches/version 6 h apart, ≥2048 MB avail RAM, load ≤20, nice 19), `RerunRecord`, `decideRerun`, `classifySuiteRun` (pass/broken/void/error/cancelled), `budgetNotice`. Numbers of the BUDGETS stay in `session-budget.ts`. |
| Controller (I/O) | `src/main/cli-budget-rerun.ts` | `checkCliBudgetOnce(deps)` (probe → decide → write-ahead record → run → record → notify), `startCliBudgetRerun`/`stopCliBudgetRerun`/`cancelCliBudgetRerun`, `makeVersionProbe` (stat realpath+mtime, `--version` only when moved), `sampleResources`. All platform bits injected ⇒ imports only node builtins + `shared/` ⇒ unit-testable under strip-types. |
| Production wiring | `src/main/cli-budget-runner.ts` | `cliBudgetDeps()`: `orchestraHome()`, `platform.notify({wsId:'', kind:'needsInput'})`, `scoped('cli-budget')` logger, `resolveClaudeBinary` (`claude-binary.ts`, extracted from agent-sdk so the session spawn and this watcher agree on which `claude` is installed), the harness with `launch` = the bundle. `startCliBudgetWatch()` is called from `index.ts` after the resource monitor; `stopCliBudgetRerun()` from `shutdownSubsystems()`. |
| Locks | `src/shared/budget-lock.ts` | `<ORCHESTRA_HOME>/session-budget/{suite,campaign}.lock` = `{pid, startTicks, kind, startedAt}`; live only while THAT process is (pid alive AND `/proc` start time equal — a recycled pid is stale; unreadable identity fails closed). `suite` is held during a run; **a load/soak campaign (C5/C6) takes `campaign` through `tryAcquire` and checks `suite`** — a re-run never starts while `campaign` is live. |
| Record | `<ORCHESTRA_HOME>/session-budget/cli-version-record.json` | ONE entry `{version, status: running\|pass\|broken\|void\|error, attempts, startedAt, finishedAt, broken[], note}`, atomic tmp+rename. Budgeted = pass or broken (both final: no re-run, no re-notify). |
| Bundle | `scripts/session-budget/{bundle-entry.mjs, bundle-env-guard.mjs, session-run.mjs}`, `vite.session-budget.config.ts` | `session-run.mjs` = `runSession(cfg, mods)` (ONE run body, modules passed in; the source runner and the bundle both call it; it adds `report.runtime {node, electron}`); `bundle-env-guard.mjs` is the bundle's FIRST import and refuses a non-scratch HOME/ORCHESTRA_HOME/CLAUDE_CONFIG_DIR, and a missing/empty `cfg.live`, before agent-sdk/store load. Harness seams added: `launch(root,cfg)`, `niceness` (`nice` OUTERMOST, so the bwrap supervisor and every descendant inherit it), `signal`, `killAfterMs` (+ `harness.d.mts`). |

**Flow.** 90 s after boot, then every 10 min: resolve `claude` on PATH → version (memoized on realpath+mtime; a poll is a
`stat`) → `decideRerun`. Deferrals consume nothing (`campaign`, `other-run-live`, `ram`, `load`, `in-flight`,
`runner-missing`, `no-containment`, `no-cli`); `same-version` always wins. `no-containment` = the host cannot give the run a
network + pid namespace (bwrap): an UNATTENDED run on a user's machine refuses to lean on the refusing proxy alone (D6)
— skip + one log line, never the harness's weak-containment opt-out. On `run`: take the `suite` lock, write `running` (write-ahead:
a crash leaves a counted, backed-off record instead of a re-run on every boot), run the bundle at nice 19 with a 150 s
hard kill (the controller races its own backstop 15 s later through the same signal), classify, record, and — only for
`broken` — `log.warn` + `platform.notify` (title `Claude Code <ver> broke a session budget`, body names the budget id +
`claude <ver>`). `void`/`error` measured nothing: never a notice, retried ≤3× per version, ≥6 h apart. The JUDGE is the single source for that: a run
that raised (`report.error`) or whose subject never mounted is VOID even when a budget also broke. Quit =
`cancelCliBudgetRerun()`: the tree is killed, the record and lock are restored SYNCHRONOUSLY (the attempt is not consumed).
The record's version is the one the RUN reported (`report.cli.version`), so an update landing mid-run is budgeted as
what it measured and the next poll runs the newer one. First launch of a release with this feature = no record = one
baseline run on the current CLI.

**Gates.** Unit: `cli-budget-rerun.test.ts` (shared + main, 34 arms incl. cancel, bound, single-flight, campaign lock,
durability), `budget-lock.test.ts`. Rig `pnpm`-free: `bash scripts/e2e-cli-version-budget.sh [--arm chain|bounded|cancel]`
drives the PRODUCTION wiring (`cliBudgetDeps()` — real `claude` lookup + probe, real record/locks, the real bundle, the
real harness at nice 19, real logger file sink, `platform.notify` seam) against the real `claude` + fake API through a
`claude` wrapper on PATH that reports a version, counts session starts (the independent "runs" counter) and models a CLI
update that adds startup `count_tokens` (`inflate`), hangs, or is slow. It is NOT in `pnpm run test` (real CLI, ~1 min).

**Traps.** (1) A bundle imports agent-sdk/store/logger STATICALLY, so env read at import time is the launcher's:
`launch.env` must pin scratch `ORCHESTRA_HOME`/`CLAUDE_CONFIG_DIR` (HOME comes from the harness env) and the guard is the
first import. (2) The fixture's MCP command is `process.execPath` — Electron in a packaged run: without
`ELECTRON_RUN_AS_NODE` in the server `env` it would open a GUI window. (3) A `claude` wrapper whose version file changes
does not move realpath+mtime — model an update by re-pointing the symlink to a new file. (4) `unref`'d timers do not keep
a test's event loop alive — hold it with a ref'd interval when awaiting one.
(5) **The egress budget is timing-dependent** (measured, #211): `egressAttempts.api.anthropic.com:443 ≤ 5` read 5 in 13 runs and
6 in one run that took 12.8 s at load ≈15 (the CLI keeps retrying while it waits) — a healthy CLI can therefore read "broken".
Raised to OPS/C1; until the number is time-independent, the re-run's false-alarm floor is that rate (evidence: the nomination).

