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
| Driver | `scripts/session-budget/run.mjs` (`scripts/e2e-session-budget.sh`) | Session arms `normal` (must PASS) and `boot-context-read` (must FAIL naming `session.beforeFirstReply.countTokensRequests` with a burst ≥ 50); self-test arms `census-selftest` (pid-namespace census = exactly the runner's tree) and `smoke-flag-path` (the real-API smoke's flag path, real CLI vs fake API) — host-dependent checks live HERE, never in `pnpm run test`, which must not need `bwrap` or a real `claude`. A run whose report carries `error` is `RUN BROKE` (rc 1). Prints requests by type (before/after first reply/total, with main/side/egress), each tool-less side call with a preview of its prompt, time to first reply (from just before `sdkSend`; runner setup reported apart), child-process census (`cli/keeper/mcp/hook/other`, rss, survivors after teardown), CLI version, egress, routes. Exit 0 / 1 / 3 (VOID); last line `SESSION-BUDGET: PASS|FAIL|VOID`. `--json` for one JSON line per arm. |
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
| refused egress attempts | **5 × `api.anthropic.com:443`** | hard-coded host, ignores the base URL; 3 more after the reply. In production these reach the real API — what they are is NOT identified |

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
NOT covered: `workspaces.ts` (spawn/promote/wake/resume, hook install into `.claude/settings.local.json`, orchestra-* skills,
account env), UI-triggered calls, the built Electron app. A boot read added at a *caller* of `ensureSession` passes. **Accepted gap
(review F9, the spec says "first reply"):** a boot read deferred past the first reply is only printed (`afterFirstReply`) — the
legitimate turn-end refresh is itself 57.

## Traps

- One session per process (agent-sdk.ts module state is global). The fake API's `replyDelayMs` (500) models real model
  latency so a count_tokens burst lands before the first reply; a longer delay only strengthens the normal arm.
- A refused-CONNECT socket may RST — the proxy swallows socket errors (found by the first spike; unit-tested).
- Don't `pkill -f` a spike by a path token that also appears in your own command line (it kills the wrapper).
