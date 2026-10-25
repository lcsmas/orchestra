# Haiku 5.5 in our waves: which seats could take it, and what to measure first

Written 2026-10-25, in answer to « qu'est ce que tu en penses d'ajouter haiku 5.5 dans nos vagues ? ».
This is research only: no paid or real-API calls, no code changed.
Orchestra read at `e89f21d0` (0 commits behind `origin/master`, checked with `git rev-list --count HEAD..origin/master`).

Labels: **FACT** = read this session from the cited source. **JUDGMENT** = my assessment, not a fact.

---

## 1. Verdict

- **Haiku 5.5 is real and suited to narrow seats, not to implementing or judging our work.**
  → Anthropic's own launch post says: "Sonnet 5.5 and Opus 5.5 remain better choices for complex agentic coding tasks … Haiku 5.5 is best suited to more narrowly scoped tasks … like compaction, summarization, or subagent work" ([announcement](https://www.anthropic.com/claude-haiku-5-5)). On Terminal-Bench 4.0 it scores 39.2%, against 70.6% for Sonnet 5.5.
- **It can't be used today without first upgrading the CLI.**
  → Claude Code needs v2.1.293 or later for Haiku 5.5 ([model-config](https://code.claude.com/docs/en/model-config)), and this host runs `2.1.291`. On that version the `haiku` alias still resolves to Haiku 4.5, which is the only Haiku id in the binary.
- **No wave seat is read-only, so Haiku 5.5 has no seat to take (correction, 2026-10-25).** A wave is made of the LEAD/OPS, implementers, verifiers and reviewers (`verified-fanout` SKILL.md §0a/§3/§3b). Each of them decides, codes, or judges.
  → The only read-only work runs as in-process **subagents** inside a seat (Agent tool). The built-in Explore subagent uses `model:"inherit"` in CLI 2.1.291 (read from the binary), so today it runs on the parent's model. The one real lever is to call Explore with `model: "haiku"`. Voice dictation is already on Haiku. The table in §4 describes tasks, not seats.
- **The quota saving on our subscription accounts is real but unquantified.**
  → Anthropic only says it qualitatively: "Haiku is the lightest, Sonnet is moderate, Opus is heavy" ([Academy](https://academy.claude.com/tutorials/choosing-the-right-claude-model)). The 5-hour and weekly windows are shared across all models. API dollar prices don't apply to plan limits.
- **Recommended action:** upgrade the CLI on a scratch account. Then run the pilot in §5: the same scout and verifier-legwork tasks on Haiku 5.5 and Sonnet 5.5, scored against known answers and known mutants. Decide per seat from that data. Changing a default first is not recommended.

---

## 2. Facts about Haiku 5.5 (FACT unless marked)

The `claude-api` skill's model table (cached 2026-09-25) still lists Haiku 4.5 as the current Haiku. Haiku 5.5 came out after that, so every fact below comes from the live docs.

| Item | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 | Source |
|---|---|---|---|---|
| API id | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` | [models overview](https://platform.claude.com/docs/en/about-claude/models/overview) |
| Released | 2026-10-07 | — | — | [Haiku 5.5 page](https://platform.claude.com/docs/en/models/haiku-5-5/overview) |
| Context / max output | 1M / 128K | 1M / 128K | 1M / 128K | overview |
| Thinking | Adaptive, on by default; `disabled` allowed at effort ≤ `high` | Adaptive | Adaptive, always on | overview; [what's new](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5) |
| Effort levels / API default | low…max / `medium` | low…max / `high` | low…max / `medium` | overview; [model-config](https://code.claude.com/docs/en/model-config) |
| Knowledge cutoff | Jun 2026 | Jun 2026 | Jun 2026 | overview |
| Input $/MTok | $0.10 (prompt ≤ 100K) · $0.50 (> 100K) | $2 | $4 | [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Output $/MTok | $0.50 · $2.50 | $10 | $20 | pricing |
| Cache read $/MTok | $0.01 · $0.05 | $0.10 | $0.20 | pricing |
| Comparative latency | Fastest | Fast | Moderate | overview |

Other facts from the same pages:

- **Pricing depends on prompt length.** "A request's prompt length counts all of its input tokens, including cache reads and cache writes … a request over the threshold pays the higher prices even when part of its prompt is a cache hit" (pricing, Long context pricing).
  - JUDGMENT: an agent session carrying CLAUDE.md, about 92 tools and a growing transcript passes 100K quickly. Most turns of a long seat would therefore bill at the higher tier.
- **Tokens and thinking cost more than on Haiku 4.5.** The same text is about 30% more tokens. Thinking blocks from every earlier turn stay in context.
- **Thinking blocks are tied to the account.** "Thinking blocks from Claude Haiku 5.5 work only in the account that produced them, or in an account linked to it" (what's new).
  - JUDGMENT: Orchestra can migrate a workspace between accounts (`dispatchMigrateAccountRequest`, `src/main/workspaces.ts:2697`). That move could invalidate a Haiku 5.5 transcript's thinking blocks. The effect is not measured.
- **Refusals have no automatic fallback.** "Safety classifiers can decline a request … Server-side fallback isn't available" (what's new). Claude Code's automatic fallback list covers Fable, Opus 5.5, Sonnet 5.5 and Opus 5 only, not Haiku 5.5 ([model-config, Automatic model fallback](https://code.claude.com/docs/en/model-config)).
- **Breaking changes from Haiku 4.5:** `budget_tokens`, sampling params and assistant prefill now return errors, and the conversation must stay append-only (what's new). Claude Code handles these for us.
- **Benchmarks.** Anthropic's own page gives these scores for Haiku 5.5 / Haiku 4.5 / Sonnet 5.5:

  | Benchmark | Haiku 5.5 | Haiku 4.5 | Sonnet 5.5 |
  |---|---|---|---|
  | Terminal-Bench 4.0 | 39.2% | 0.0% | 70.6% |
  | FrontierCode 1.1 (Main) | 46.4% | — | 52.1% |
  | OSWorld 2.1 (offline subset) | 72.4% | 15.7% | 83.9% |
  | GDPval-AA v2.1 | 1620 | 735 | 1840 |
  | Humanity's Last Exam (no tools) | 45.9% | 10.2% | 56.9% |

  No SWE-bench number is published on that page ([announcement](https://www.anthropic.com/claude-haiku-5-5), HTML extracted locally).
- **Anthropic's stated fit:** it "pairs well with Opus 5.5 and Sonnet 5.5 as a subagent on coding work" (announcement). The docs describe it as "for high-volume, latency-sensitive tasks such as classification, extraction, and routing" (overview).
- **Claude Code support:**
  - The `haiku` alias resolves to Haiku 5.5 "on the Anthropic API" from v2.1.293 (model-config, Version history).
  - It can be selected with `claude --model claude-haiku-5-5`. It runs with the 1M window "on every plan".
  - The aliases `ANTHROPIC_DEFAULT_HAIKU_MODEL` ("the model to use for `haiku`, or background functionality") and `CLAUDE_CODE_SUBAGENT_MODEL` exist. `ANTHROPIC_SMALL_FAST_MODEL` is deprecated (model-config, env table).
- **This host's CLI:**
  - `claude --version` gives `2.1.291 (Claude Code)`, binary dated 2026-10-06, one day before Haiku 5.5 shipped.
  - `grep -a -o 'claude-haiku-[0-9a-z-]*'` on the binary finds only `claude-haiku-4-5[-20251001]` and `claude-haiku-3-5`.
- **Plan limits:**
  - "a seat-based usage window on a subscription plan, shared across all models, so the developer can't restore access by switching models" ([costs](https://code.claude.com/docs/en/costs)).
  - Max has "a weekly usage limit that applies across all models" and a separate Fable weekly limit ([Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan), [Pro/Max in Claude Code](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)).
  - The only statement on relative weight is the Academy line in §1. No figure is published.

---

## 3. How Orchestra selects models today (read in code at `e89f21d0`)

- **There are two defaults: "workspace" and "spawned".**
  - `ModelDefaults {workspace, spawned}` is defined in `src/shared/model-defaults.ts:16-21`.
  - The choice is made by who creates the workspace, not by the code path.
  - It is frozen onto `ws.model` at creation (`modelForNewWorkspace`, `:48-54`, called at `src/main/workspaces.ts:431`).
  - At launch it is resolved by `resolveLaunchModel` (`model-defaults.ts:60-66`, called at `src/main/agent-sdk.ts:1946`).
  - A model string is validated only by charset (`isValidModelArg`, `:27-33`), so `claude-haiku-5-5` would be accepted and passed verbatim to the CLI.
- **Effort works the same way.** `EffortDefaults` (`src/shared/effort-defaults.ts:27`) is frozen onto `ws.sdkEffort` by `effortForNewWorkspace` (`:45-51`, `workspaces.ts:399`).
  - The comment at `agent-sdk.ts:1948-1949` says an unset effort "falls back to the model's own default (`high`)". That is stale for the 5.5 models: Opus 5.5 and Haiku 5.5 default to `medium` (model-config).
- **The live user store (`~/.config/orchestra/orchestra/store.json`)** has `modelDefaults = {workspace: 'opus', spawned: 'sonnet'}` and `effortDefaults = {workspace: 'high', spawned: 'xhigh'}`. Of 71 workspaces, 58 are `opus`, 9 `sonnet`, 3 `opus[1m]`/`claude-opus-5-5[1m]`, and 1 unset. None is on Haiku.
- **A seat can be pinned per spawn.** `orchestra spawn --model <m> --effort <l>` is parsed in `src/cli/index.ts:1359-1360` and documented in `src/cli/help.ts:68-80`.
  - The spawn brief tells agents: "Do NOT downgrade implementation workers to save tokens — that trade is the user's call" (`workspaces.ts:530`, again at `:3848`).
  - So a Haiku seat must be the user's explicit policy. A coordinator would never choose one on its own.
- **No per-seat model policy exists.** The fleet bus, the ledger and the `verified-fanout` skill assign no models: `grep -n model ~/.claude-mc/skills/verified-fanout/SKILL.md` gives one unrelated hit. Every child takes the spawned default unless it is given `--model`.
- **Agent-tool subagents (Explore, etc.) inside a session are decided by the CLI, not Orchestra.**
  - Orchestra sets no `CLAUDE_CODE_SUBAGENT_MODEL` or `ANTHROPIC_DEFAULT_HAIKU_MODEL` (`git grep` in `src/`: 0 hits).
  - Built-in Explore "inherits" the main model ([sub-agents](https://code.claude.com/docs/en/sub-agents)), so our Explore scouts run on Opus or Sonnet today.
  - The session runs the `claude` binary found on PATH (`resolveClaudeBinary`, `agent-sdk.ts:649-661` → `pathToClaudeCodeExecutable`, `:1903`), not the SDK's bundled 2.1.241.
- **Where `haiku` already appears (113 `git grep -i haiku` hits):**
  - Voice dictation router/edit worker: `claude -p --model haiku` (`src/main/voice.ts:89`).
  - Usage probe: pinned `claude-haiku-4-5-20251001`, `max_tokens: 1` (`src/main/account-usage.ts:41`).
  - The CLI's own session-title side call, budgeted as **exactly `{'claude-haiku-4-5-20251001': 1}`** (`src/shared/session-budget.ts:152`).
  - Real-CLI rigs and probes use `--model haiku` (`scripts/e2e-hook-cost.mjs:290`, `scripts/e2e-liveness-failed-call.mjs:259`, `scripts/session-budget/smoke-real.mjs:30`, `scripts/probes/maxturns-probe*.mjs`).
  - The static picker fallback lists `Haiku 4.5` and no Sonnet 5.5 (`src/renderer/components/agent/model-util.ts:23-31`). The live `supportedModels()` list overrides it once a session starts.
- **Side effects of the CLI upgrade, whatever is decided (JUDGMENT, not measured):**
  - Once the CLI is ≥ 2.1.293, every `--model haiku` rig and the voice worker switch to Haiku 5.5. That is ~30% more tokens, and thinking is on by default.
  - If the title side call follows the `haiku` alias, `session-budget.ts:152` sees a side call on an unbudgeted model and the suite goes red.

---

## 4. Task-by-task fit (all JUDGMENT)

No Orchestra seat does only the "Candidate" rows below. Those rows are subagent calls made from inside a seat, not seats an OPS spawns.

| Seat | Haiku 5.5? | Why |
|---|---|---|
| Explore / scout ("where is X, list callers of Y") | **Candidate** | Read-only, and its output is checked by a stronger seat before anyone acts on it. This is the "subagent on coding work" use Anthropic names. Risk: a confident false negative ("no such route"), which our Debugging rules already forbid trusting without a second search surface. |
| Ledger / status / bus summarization, `/compact`-style digests | **Candidate** | "Summaries, compactions" are named use cases. Errors show up when the coordinator re-reads the ledger body. |
| Bulk log / CI-failure triage, grep-and-classify | **Candidate** | This is classification and extraction. The verdict stays with a stronger seat. |
| Voice dictation router/edit (`voice.ts`) | **Already Haiku** | It upgrades on its own with the CLI. Watch the latency: cold start was ~6 s and warm ~1.5 s on 4.5 (`voice.ts:16`). Default thinking may move these numbers. |
| Verifier *legwork* (rebase, run the canonical suite, paste PASS/SKIP counts) | **Maybe, pilot first** | The work is mechanical, but a missed `# skipped` or a misread exit code produces a believable false PASS, the failure mode our LESSONS call worst. |
| Verifier *verdict* (mutation proof, must-FAIL arms, gate PASS/FAIL) | **No** | This seat exists to catch plausible-but-wrong results. Terminal-Bench is 39% vs 71%, and the stakes are asymmetric. |
| Implementation of concurrency / keeper / bus / pause fixes | **No** | Anthropic itself steers complex agentic coding to Sonnet/Opus. The brief also forbids a coordinator from downgrading implementers. |
| Reviewers, customer-data work (NMC / Mobile Club DB) | **No** | Our LESSONS require "a second fresh reviewer" on customer data. A weaker reviewer gives the same count of reviews with less coverage. |
| LEAD / OPS coordinator | **No** | It holds long context (it would usually pay the > 100K tier anyway) and owns the decisions. |
| Security-adjacent seats (process kill, cgroups, egress proxy) | **Caution** | Haiku 5.5 runs safety classifiers with no Claude Code fallback, so a `cyber` false positive ends the turn. |

**Cost effect (JUDGMENT, from the FACT prices above):**

- **On API billing:**
  - On a long seat (> 100K prompt), Haiku 5.5 costs ¼ of Sonnet 5.5 per input/output token and ½ per cache read. Cache reads dominate agent sessions.
  - On short seats (≤ 100K), it costs about 1/20 of Sonnet on input/output and 1/10 on cache reads.
  - A Haiku seat that needs more turns or a redo loses that edge. Measure cost per *completed* task, not per request.
- **On our subscription accounts** (Orchestra polls `api/oauth/usage`, the plan endpoint, per `docs/codebase-map/accounts-usage.md`):
  - The saving shows up only as slower growth of the shared 5-hour and weekly bars, by a factor Anthropic doesn't publish.
  - The Max monthly API credit ($100 on 5x, $200 on 20x, per the announcement) is a separate Claude Platform budget, not plan quota.

---

## 5. What to measure before deciding (no run here; each pilot costs real quota)

1. **CLI prerequisite.**
   - Upgrade to ≥ 2.1.293 on a scratch account.
   - Confirm `claude --print --model claude-haiku-5-5` answers with `canonicalModel: claude-haiku-5-5`, and that `--model haiku` now resolves to it.
   - Re-run `pnpm run test` and the session-budget suite. Expect the `session-budget.ts:152` side-model pin to need a decision.
2. **Scout pilot.**
   - Take 20 "where/what" questions from past waves whose answers are known (file:line anchors in `docs/codebase-map/`).
   - Run them as Explore subagents on Haiku 5.5 and on Sonnet 5.5, interleaved and in alternating order.
   - Score correct anchors, **false "doesn't exist" answers**, tool calls, and wall time.
3. **Verifier-legwork pilot.**
   - Replay 5 past gates whose outcome is known, including at least 2 with a planted mutant that must FAIL and 1 with a skipped test.
   - Score the kill rate on known mutants, whether the `# skipped` line was caught, and any false PASS. A single false PASS rules the seat out.
4. **Summarization pilot.** Summarize 5 real ledger threads. A human (or the LEAD) checks the decisions, shas and open asks against the ledger body.
5. **Quota effect.**
   - Run the same scripted task on Haiku 5.5 and on Sonnet 5.5 under one account.
   - Read the `fiveHour` utilization delta from the per-account poller before and after each arm. This is the only way to learn the real plan-limit weight.
6. **Long-context price check (API only).** Record each seat's prompt-length distribution. If most turns are > 100K, use ¼ (not 1/20) as the price ratio.
7. **Account-migration check.** Migrate a Haiku 5.5 workspace between `perso` and `mc` on a scratch transcript, resume it, and check for a thinking-block error.

---

## 6. VERIFIED / NOT VERIFIED

**VERIFIED (this session)**

- Haiku 5.5 exists: id `claude-haiku-5-5`, released 2026-10-07, 1M / 128K, adaptive thinking, default effort `medium`, Jun 2026 cutoff. Source: WebFetch of the models overview and the Haiku 5.5 overview page.
- Prices, including the > 100K tier and cache-read counting. Source: WebFetch of the pricing page (rows 34-35, 222).
- Benchmarks and Anthropic's "Sonnet/Opus remain better for complex agentic coding" sentence. Source: `curl` of the announcement HTML, text extracted locally.
- Claude Code needs ≥ v2.1.293. The `haiku` alias changed at v2.1.293. Haiku 5.5 is not in the automatic fallback list. Source: `curl https://code.claude.com/docs/en/model-config.md`, lines 63, 518-530, 1054.
- The installed CLI is 2.1.291 and its binary contains only Haiku 4.5 / 3.5 ids. Source: `claude --version`; `grep -a -o` on `~/.local/share/claude/versions/2.1.291`.
- Plan windows are shared across models, and Anthropic gives only the qualitative "Haiku is the lightest". Source: WebFetch of the costs doc, two support articles and the Academy page.
- Orchestra's model and effort selection paths and every file:line in §3. Source: read at `e89f21d0`; live store values read from `store.json`.

**NOT VERIFIED**

- That CLI 2.1.291 rejects `--model claude-haiku-5-5`. The docs say to use ≥ 2.1.293, but I made no API call to test it.
- ~~That the CLI's title side call moves to Haiku 5.5 after the upgrade and turns the session-budget suite red.~~ **MEASURED 2026-10-25 on CLI 2.1.310:** the `haiku` alias resolves to `claude-haiku-5-5` (read from the binary, and `resolvedModel` in the smoke-flag arm). The title side call is `claude-haiku-5-5` in every arm. `pnpm run test:session-budget` exits 3, and every arm is VOID **before** the side-model check. The cause is a separate break: `instrument.modelRequestCarriesTools` needs at least 60 tools and the main request carries 13. The cause of the 13 has not been diagnosed. Explore is still `model:"inherit"` on 2.1.310.
- The real plan-limit weight of Haiku 5.5 vs Sonnet 5.5 on our accounts. Anthropic publishes no number.
- Which plan or seat tier the `perso` and `mc` accounts are on, so Haiku 5.5 availability per account is not confirmed. The docs say "on every plan" for the 1M window only.
- Whether migrating a workspace between accounts breaks a Haiku 5.5 transcript's thinking blocks on resume.
- Every quality claim in §4. These are judgment until the §5 pilots run. No Haiku 5.5 session was run.
- Haiku 5.5 latency and voice-worker behavior with default thinking on.
