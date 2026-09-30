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

## Load/soak campaign (#212) — N concurrent sessions for a long time, rates not a verdict

`pnpm run soak:campaign -- --sessions 3 --duration 5m` (`scripts/session-budget/soak-campaign.mjs`) runs **N real sessions at once** —
`sdkSend → ensureSession → keeper → real claude`, one heavy fixture repo each — against the same FAKE API (zero tokens, D6) inside the same
net+pid namespaces, for a while, and writes a dated report `<out-dir>/soak-<UTC>-<label>.{json,md}` (default `~/.cache/session-budget/soak-reports/`):
**the wedge rate** (wedged/turns, by session, by phase startup/steady, by third of the run), **each session's memory slope over time** (rss+swap of
its keeper→CLI→MCP tree, Theil–Sen MB/min after a warm-up, OLS + growth printed beside it, the whole series kept), the **app-process** slope, and
**processes left after deleting every workspace** (by kind and by session). Last line `SOAK-CAMPAIGN: PASS|FAIL|VOID|ABORTED|BROKE` (rc 0/1/3/4/1;
2 = refused). Numbers: `SOAK_BUDGETS` (appended block of `src/shared/session-budget.ts` — the ONE place); judge/report/formatters:
`src/shared/soak-campaign.ts`.

| Piece | File | Role |
|---|---|---|
| Runner (the "app process") | `scripts/session-budget/soak-runner.mjs` | ONE process hosts N sessions like Orchestra's main does. Emits `{"soak":"start\|sample\|turn\|event\|abort\|final"}` lines only (it collects, the parent analyses — a runner that dies still leaves its lines). Per session: sequential launch under its own fake key `…-soak-sN` (`buildSdkEnv` copies `process.env` inside `ensureSession`, which `sdkSend` awaits), a turn every ~interval ±25%, a **deadline** (no `turn-end`/`error` in time = **wedged**, sends to it stop). Samples per tick: per-session tree (keeper pid from `readTrackedKeeperPid`, descendants by ppid), app process, API process, strays outside every tree, `MemAvailable`, load. Teardown as a delete does, then the namespace census = survivors. |
| Fake API **process** | `soak-api-proc.mjs` (+ `fake-anthropic-api.mjs` additions) | The API runs in its OWN process (IPC `stats`/`stop`) so the runner's slope is the app's, not request bookkeeping; `retain` bounds its records (counters `stats()` are unbounded-safe: O(sessions)); `sessionTag` maps the `x-api-key` to `sN`. |
| **Fault-injection point** (C6 #213) | `fault-plan.mjs` | JSON plan `{rules:[{match:{session,main}, after:N, action:{kind}}]}` → `opts.fault(rec)` in the fake API. Only `hang` (held open, never answered) is implemented — the seeded wedge. `delay/status/reset/truncate/blackhole` are RESERVED: they throw at compile time so a fault plan never silently runs fault-free. C6 adds kinds HERE. |
| Seeded leaks | `fake-mcp-server.mjs --leak-mb-per-min` (fixture `mcpLeakMbPerMin`); runner `seedAppLeak` | One MCP child — or the app process itself — retains touched MB forever: a session / an app that never frees memory. |
| Driver | `soak-lib.mjs` `runCampaign` | D7 preflight (usage refusals rc 2; RAM/load/projected footprint ⇒ an **ABORTED report**, nothing spawned), single-flight lock `~/.cache/session-budget/campaign.lock` (pid + /proc start time) **plus** a `/proc` scan for a live `soak-runner.mjs`, keeper bundle build, the runner, the parent's own cap **watchdog** (second channel next to the runner's per-sample check), abort = `<root>/ABORT` file (see Traps), code identity, report files. |
| Pure half | `src/shared/soak-campaign.ts` | `decideAbort`/`preflight`/`tightenCaps`, `theilSenSlope`/`olsSlope`, `buildSoakReport`, `judgeSoak`, formatters. Unit: `soak-campaign.test.ts` (a synthetic campaign with a known leak/wedge/survivor per must-FAIL arm). |
| Must-FAIL / must-PASS arms | `soak-selftest.mjs` (`pnpm run test:soak-campaign`, ~20 min, run when calm) | `seeded` (s1's MCP child leaks 60 MB/min, the app process leaks 20 MB/min, s2's API hangs after 3 main requests; s0/s3 are in-run controls — MUST FAIL naming s1's slope, the runner's slope and s2's wedge, NOT s0/s3, 0 survivors), `healthy` (MUST PASS), `abort-runner` / `abort-watchdog` / `abort-yield` / `abort-parent-died` (MUST be ABORTED naming the right cap/caller/parent, 0 survivors, elapsed stamped). VOID (rc 3), never FAIL, when the machine was too busy to measure. |

**D7 caps** (hard, in `SOAK_BUDGETS`): ≤ 10 sessions (refused above, not clamped), abort when `MemAvailable` < 6 GB or load1 > 20 — before the start
(also when the PROJECTED footprint 400 MB + N × 600 MB would leave < 6 GB) and at every sample; a per-run override can only tighten (`tightenCaps`).
Everything runs in a scratch HOME/config/`ORCHESTRA_HOME` (scratch guard) and the namespace dies with the run.

### Automatic scheduling (no UI — D5)

`src/main/soak-scheduler.ts` (started from `index.ts` beside the self-tune scheduler, `stopSoakScheduler()` at quit) ticks every 60 s; the decision is
`decideSoakRun` (`src/shared/soak-schedule.ts`), the bookkeeping `soakTick` (`src/main/soak-tick.ts`, Electron-free so a test drives the REAL function).
A campaign starts only when **all** hold: enabled (a registered repo with `scripts/session-budget/soak-campaign.mjs` + `package.json` name `orchestra`,
or `<ORCHESTRA_HOME>/soak/config.json` `repo`; `ORCHESTRA_SOAK=0` disables) · app up ≥ 10 min · **the code or the `claude` CLI changed since the last
campaign that RAN** (`lastCompleted` = PASS/FAIL only; key = `codeIdentity`: git tree hashes of `src`, `scripts/session-budget`, `pnpm-lock.yaml` +
any uncommitted/untracked change; unreadable ⇒ skip) · ≥ 6 h since the last completed one, ≥ 1 h since the last attempt · **user idle**: window not
focused, no workspace `running`/`waiting`, OS idle ≥ 15 min (`platform.getSystemIdleSeconds?` — null ⇒ fall back to the window's last focus) and no
agent activity for 10 min · D7 caps hold, sessions = the largest N ≤ 10 that fits (≥ 3). A RUNNING campaign **yields** (SIGTERM → graceful ABORTED
report) when the window is focused, a workspace starts, or input arrives within 60 s; the campaign also exits if the app dies (`--parent-pid`). The
campaign parent gets an **allowlisted env** (`buildCampaignEnv`: no API key/token — zero tokens). Surfaced as `[soak]` log lines only: INFO on
start/finish, ONE WARN naming the broken budgets and the report on a breach. State: `<ORCHESTRA_HOME>/soak/state.json`; reports:
`<ORCHESTRA_HOME>/soak/reports/` (last 30 kept).

### Traps

- **Abort travels as a FILE, not a signal.** SIGTERM to the process group kills bwrap and with it the namespace at once — no teardown census, no report.
  `runContained({signal})` writes `<root>/ABORT` (`{reason, detail}`); the runner polls it each second, stops sending, tears down, emits `final`. Only
  `abortGraceMs` later is the group SIGKILLed.
- **The fake API must not live in the app process**: its request log alone grew ~100 MB/h and would read as an app leak. Separate process, bounded records.
- **rtk's `ps` output lies** about a running campaign (`ps | grep soak-runner` read "no process" while it ran): scan `/proc` (`otherRunnerAlive`).
- **Time is MONOTONIC in the runner** (`performance.now()`): a 40-min machine suspend once made a 10-min campaign read 2776 s and would have turned
  every in-flight turn into a "wedge". The wall clock is read only to DETECT a jump against the monotonic one (`clock-jump` event ⇒ `instrument.noClockStep`
  ⇒ VOID, never a pass and never advances the scheduler's gate).
- A fresh session's tree climbs ~25 MB in its first 3 minutes (measured 513 → 540 MB, then flat ±5 MB/sample): that is warm-up, so the judge skips
  `max(180 s, 25 %)` and refuses a window under 120 s / 8 samples (`instrument.memoryWindow` ⇒ VOID). The slope budget SHRINKS with the window —
  `floor 0.5 + 8 MB / window-minutes` MB/min (`soakSlopeBudget`) — because a short window's slope is sampling noise: 1 MB/min hides in 5 minutes and is
  caught over an hour.
- Tool turns (`--tool-every N`, default 3): the fake API answers every Nth user turn with a `Bash` call (a real short-lived subprocess) and then a fixture MCP
  call, so the process spawn/exit paths a text-only turn never reaches are inside the run — and inside the survivors census.
- A shared, busy machine trips the D7 load cap: a campaign that ABORTED says so in its report and never advances the change gate.
- Teardown here is C1's replica of `stopStructuredSession`; once C3 #210 merges, switch `teardown()` in `soak-runner.mjs` to its real-delete-route driver.
