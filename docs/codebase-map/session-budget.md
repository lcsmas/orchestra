# Session budget suite (#208)

A session budget is a **number a fresh session must not exceed**, measured on the REAL path: `agent-sdk.ts`
`sdkSend` → `ensureSession` → SDK `query()` → the detached **keeper** → the real `claude` CLI, in a
generated heavy fixture repo, against a **local fake Anthropic API** — zero tokens, no login, no network
(ledger #237 D6). First budget: before the first reply, **exactly 1 model request, 0 `count_tokens`** — the check
that would have caught #176 (a boot-time `getContextUsage()` fanned out into one `count_tokens` per memory file).
Run: `pnpm run test:session-budget` (~13 s; rebuilds `dist-electron/keeper.js` first). Wired into the release gate as
step 3 (`build-release.md`).

## Pieces

| Piece | File | Role |
|---|---|---|
| **Budget numbers + judge (ONE source)** | `src/shared/session-budget.ts` | `SESSION_BUDGETS` (frozen), `SUBJECT_MARKERS`, `SessionBudgetReport`, `judgeSessionBudget(report)` → `{ok, void, verdicts[]}`. Two verdict kinds: `budget` (`BUDGET BROKEN <id>: allowed …, saw N — before the first reply the session sent model=… count_tokens=… other=…`) and `instrument` (`INSTRUMENT VOID …`: the subject did not mount — no first reply, MCP not connected / not real children, tools or a planted sentinel missing from the model request). A VOID run is never a pass. **C3 #210 / C4 #211 / C7 #214 add their number here + a rule + a report field; nothing else restates a budget.** Unit: `session-budget.test.ts` (numbers pinned as literals). |
| Fake API + egress proxy | `scripts/session-budget/fake-anthropic-api.mjs` | `startFakeApi({markers, replyDelayMs})`: records EVERY request by type (`model` = `POST /v1/messages`, `count_tokens`, `models`, `bootstrap`, `other`) with tMs/model/tools/planted-marker hits; canned wire-valid SSE reply; `count_tokens` → `{input_tokens}`; unknown route → recorded 404. A second listener is the `HTTPS_PROXY` target: every `CONNECT`/absolute-URI request is **recorded and refused** (`egress`). |
| Heavy fixture | `scripts/session-budget/fixture.mjs` (+ `fake-mcp-server.mjs`) | `generateHeavyFixture(dir, profile)` — deterministic (seeded), git repo: 60 skills, 48 KB CLAUDE.md, **50 `.claude/rules/*.md`** (the axis that multiplies `count_tokens`: one call per memory file, measured 47 for 40 files; skills and MCP tools are batched), 4 stdio MCP servers × 15 tools. Sentinels planted in CLAUDE.md, the last rule, last skill, last MCP tool. |
| Runner (one session per process) | `scripts/session-budget/session-runner.mjs` | Scratch HOME / `CLAUDE_CONFIG_DIR` / `ORCHESTRA_HOME` (guard first), dummy `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`=fake, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, installs the built keeper bundle, `sdkSend`s one turn, taps `agent:event` on the platform seam. **First reply = first `text-delta`**; requests are split at that instant (same monotonic clock as the fake API). Census at first reply/end, teardown as a workspace delete does, survivors counted. Emits `{report, judgement}`. |
| Harness API | `scripts/session-budget/harness.mjs` | `ensureBuilt(repo)`, `detectContainment()`, `runSessionArm({repo, arm, mutant?, profile?, containment?})`, `findOnPath`, `reapScratchProcesses`. Containment = `bwrap --unshare-net --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp` (`netns+pidns`: no egress possible, every descendant dies with the run), else `netns`, else `proxy-only` (+ reap by scratch `HOME` in `/proc/*/environ`). NOT `unshare -r`: it maps uid 0 and the CLI then refuses `bypassPermissions`. |
| Driver | `scripts/session-budget/run.mjs` (`scripts/e2e-session-budget.sh`) | Arms `normal` (must PASS) and `boot-context-read` (must FAIL naming `session.beforeFirstReply.countTokensRequests` with a burst ≥ 50). Prints requests by type (before/after first reply/total), time to first reply, child-process census (`cli/keeper/mcp/hook/other`, rss, survivors after teardown), CLI version, egress, routes. Exit 0 / 1 / 3 (VOID); last line `SESSION-BUDGET: PASS|FAIL|VOID`. `--json` for one JSON line per arm. |
| Must-FAIL mutant | `scripts/session-budget/mutants.mjs` | Node `load` hook that rewrites `src/main/agent-sdk.ts` **as it loads** (nothing on disk): re-adds `refreshContextUsage(wsId)` after `void consume(session)` (the pre-fix code, `git show 89ae8b4b^`). The anchor must match **exactly once** or the run throws `PATTERN-GONE` (unit-tested against the shipped file). |
| Process census | `scripts/session-budget/proc-census.mjs` | `/proc` walk: in a pid namespace every process except pid 1/self, else the runner's descendants; zombies listed apart. Reused by C3. |
| Scratch guard (D7) | `scripts/session-budget/scratch-guard.mjs` | `assertScratch` refuses any HOME/config/`ORCHESTRA_HOME` that is, resolves into, or contains `~/.claude*`, `~/.orchestra*`, or the invoker's `CLAUDE_CONFIG_DIR`/`ORCHESTRA_HOME` (symlinks resolved). |
| Optional real-API smoke | `scripts/session-budget/smoke-real.mjs` (`pnpm run smoke:session-budget-real`) | ONE tiny cheap-model turn (`--model haiku`, no tools/MCP, nothing persisted, `--max-budget-usd 0.05`). Refuses unless `--real-api` AND an explicit `--config-dir` (the account billed; never defaulted). `--api-base` redirects it (how tests prove the flag path against the fake API). The release gate runs it only when `RELEASE_REAL_API_SMOKE_CONFIG_DIR` is set. **Never run against the real API by tests or by the C1 author.** |

## Measured facts (CLI 2.1.284, SDK 0.3.241)

- Against the fake API the CLI calls only `POST /v1/messages?beta=true` (model) and, when a context read fires,
  `POST /v1/messages/count_tokens?beta=true`. No `/v1/models`, no bootstrap. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
  egress is 0; without it the CLI reaches for `api.anthropic.com:443` (hard-coded host, ignores the base URL; 5 CONNECTs).
  `DISABLE_TELEMETRY`/`DISABLE_AUTOUPDATER`/`DISABLE_ERROR_REPORTING` alone do NOT stop it.
- A non-first-party `ANTHROPIC_BASE_URL` makes the CLI treat the provider as third-party: GrowthBook off, and tool search
  disabled (all tools inline) — the fixture session is, if anything, heavier than production, never lighter.
- In SDK streaming mode `system/init` is emitted only after the first prompt; never gate the prompt on init.
- Normal arm: model=1 count_tokens=0 before the first reply; the turn-end gauge refresh then sends ~57 `count_tokens`
  AFTER it (legitimate; reported as `afterFirstReply`, not budgeted). Mutant arm: 57 BEFORE the first reply.

## Traps

- One session per process (agent-sdk.ts module state is global). The fake API's `replyDelayMs` (500) models real model
  latency so a count_tokens burst lands before the first reply; a longer delay only strengthens the normal arm.
- A refused-CONNECT socket may RST — the proxy swallows socket errors (found by the first spike; unit-tested).
- Don't `pkill -f` a spike by a path token that also appears in your own command line (it kills the wrapper).
