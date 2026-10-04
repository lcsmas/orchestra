# SOTA survey: hierarchical / multi-agent orchestration for LLM coding agents

Compiled 2026-09-30 to benchmark "verified-fanout" (human -> quiet LEAD -> per-wave OPS -> 2-8 implementers
in worktrees + 1-2 VERIFIERS (deps, typecheck/tests/build/E2E + mutation) + 1 fresh ADVERSARIAL REVIEWER per
merge candidate; ledger = GitHub issue; SQLite bus with total order, wakeups, liveness, fencing/capability tokens).

Method: every item below was fetched with WebFetch on 2026-09-30 unless marked **UNVERIFIED**. The fetch tool
summarizes pages through a small model, so quotes are near-verbatim; numbers were re-asked where they mattered.
Where two primary versions disagree (e.g. arXiv v1 vs v3), both are given.

---

## 1. Anthropic (engineering blog + Claude Code docs)

### 1.1 How we built our multi-agent research system
- URL: https://www.anthropic.com/engineering/multi-agent-research-system — 2025-06-13
- Orchestrator-worker: the lead (Opus 4) "spins up 3-5 subagents in parallel"; multi-agent beat single-agent Opus 4 by **90.2%** on their internal research eval.
- Cost: agents use **~4x** the tokens of chat; multi-agent **~15x** chat. On BrowseComp, token usage alone explains **80%** of performance variance (tokens + tool calls + model choice = 95%).
- When it does NOT fit: domains where agents must "share the same context or involve many dependencies between agents"; "most coding tasks involve fewer truly parallelizable tasks than research".
- "For economic viability, multi-agent systems require tasks where the value of the task is high enough to pay for the increased performance."
- Execution was **synchronous** ("lead agents execute subagents synchronously, waiting for each set of subagents to complete"); this creates bottlenecks, but async adds problems of "result coordination, state consistency, and error propagation".
- Artifacts: subagents should write outputs to a filesystem/artifact store instead of relaying everything through the lead (avoids "game of telephone" + token copying).
- Durable execution: agents are stateful, errors compound; resume from where the error happened instead of restarting.
- Effort scaling rule: 1 agent / 3-10 tool calls for simple; 2-4 subagents / 10-15 calls each for comparisons; 10+ subagents only for complex research.
- Evaluation: a single LLM-as-judge call (0.0-1.0 + pass/fail over 5 criteria).
- Relevance to LEAD->OPS->workers: validates orchestrator-worker + durable artifacts (your ledger), but Anthropic's own caveat says coding is the *weak* case; synchronous waves = their known bottleneck, same shape as your verifier queue.

### 1.2 Building effective agents
- URL: https://www.anthropic.com/engineering/building-effective-agents — 2024-12-19
- Orchestrator-workers: "A central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results"; fits coding changes across unpredictable files.
- Evaluator-optimizer: "One LLM call generates a response while another provides evaluation and feedback in a loop"; fits when there are clear evaluation criteria.
- "you should consider adding complexity *only* when it demonstrably improves outcomes."
- Relevance: your OPS = orchestrator, verifier+reviewer = evaluator. The principle asks for a measured win for each added layer (LEAD *and* OPS).

### 1.3 Effective context engineering for AI agents
- URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — 2025-09-29
- Context rot: recall degrades as tokens grow; context is a finite "attention budget".
- Sub-agents may use "tens of thousands of tokens or more" but return "a condensed, distilled summary ... (often 1,000-2,000 tokens)".
- System prompts at the "right altitude": avoid brittle hard-coded if-else logic and laundry lists of edge cases; give strong heuristics.
- Also: compaction, structured note-taking (NOTES.md), just-in-time retrieval by identifiers.
- Relevance: ~140 KB of rules is the "laundry list" anti-pattern; workers should return 1-2k-token verdicts to OPS, with detail in the ledger.

### 1.4 Effective harnesses for long-running agents
- URL: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — 2025-11-26
- Two roles: initializer agent + coding agent; state carried by `claude-progress.txt`, git commits, and a JSON feature list (~200+ items, initially all failing).
- Failure modes: declaring victory early; marking features done without testing -> fixed with end-to-end browser testing (Puppeteer MCP). "It is unacceptable to remove or edit tests".
- Future work: "specialized agents like a testing agent, a quality assurance agent, or a code cleanup agent, could do an even better job".
- Relevance: your ledger + verifier are the matured version of this; single writer per feature is the default there.

### 1.5 Harness design for long-running application development
- URL: https://www.anthropic.com/engineering/harness-design-long-running-apps — 2026-03-24 (Prithvi Rajasekaran)
- Planner -> generator -> evaluator (GAN-inspired). Self-evaluation bias: agents "confidently prais[e] the work — even when ... the quality is obviously mediocre". "Separating the agent doing the work from the agent judging it proves to be a strong lever".
- "Sprint contracts": the generator proposes what it will build and **how success will be verified**; the evaluator approves before implementation.
- Evaluator drives the running app with Playwright. Tuning it took "several rounds" before grades were reasonable.
- Cost: solo harness **20 min / $9** vs full harness **6 h / $200**; a later V2 run **3 h 50 min / $124.70**.
- With Opus 4.6 the sprint construct was **removed**: "every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing".
- Relevance: strongest primary support for your separate verifier + reviewer. Also a caution: re-test each layer (OPS, per-candidate reviewer, mutation gate) against current models.

### 1.6 Building a C compiler with a team of parallel Claudes
- URL: https://www.anthropic.com/engineering/building-c-compiler — 2026-02-05 (Nicholas Carlini)
- **16** parallel agents, ~**2,000** sessions, **~$20,000**, **2B** input / **140M** output tokens, ~**100k**-line Rust compiler that builds Linux 6.9 (x86/ARM/RISC-V).
- **No orchestration agent**: agents claim work by writing a lock file in `current_tasks/`; git sync enforces mutual exclusion; merge conflicts were frequent and agents resolved them.
- "the task verifier is nearly perfect, otherwise Claude will solve the wrong problem." The test harness was the oracle. A GCC comparison oracle was added so agents could debug a single big failure (kernel build) in parallel.
- Specialized roles: dedup/coalescing, performance, code quality, docs, design critique.
- Failure mode: "New features and bugfixes frequently broke existing functionality."
- Context hygiene: the harness "should not print thousands of useless bytes"; a `--fast` sampling mode keeps regression checks cheap.
- Relevance: a flat (depth-1) swarm plus a near-perfect automated oracle reached 16-way parallelism with no coordinator or reviewer. The oracle, not the hierarchy, carried quality.

### 1.7 Claude Code docs: agent teams, subagents, workflows, costs, best practices (live docs, read 2026-09-30)
- Agent teams — https://code.claude.com/docs/en/agent-teams (experimental, off by default)
  - Lead + teammates + shared task list (file-locked claims) + mailbox (JSON file per agent). **"No nested teams: teammates cannot spawn their own teammates."** "Lead is fixed."
  - "Start with **3-5 teammates**"; "Three focused teammates often outperform five scattered ones"; **5-6 tasks per teammate**.
  - "For sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective." Recommends starting with research/review, not parallel implementation.
  - Quality gates as deterministic hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted` (exit 2 blocks completion).
  - Known failure modes: task status lags, the lead ends before tasks are really complete, teammates stop on errors.
- Costs — https://code.claude.com/docs/en/costs: "Agent teams use approximately **7x** more tokens than standard sessions when teammates run in plan mode"; team tokens are "roughly proportional to team size"; use Sonnet for teammates; keep CLAUDE.md **under 200 lines**.
- Subagents — https://code.claude.com/docs/en/sub-agents: "By default, a subagent can spawn subagents of its own, up to **three layers** below the main conversation" (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); default **20** concurrent subagents; `isolation: worktree`.
- Dynamic workflows — https://code.claude.com/docs/en/workflows: orchestration moves into a **script** ("Who decides what runs next: The script"); intermediate results stay in script variables, not in a context; resumable; up to **16** concurrent agents by default (max 256), **1,000** agents per run, "Large workflow" warning at >25 agents or >1.5M tokens. Built-in quality pattern: "independent agents adversarially review each other's findings before they're reported".
- Best practices — https://code.claude.com/docs/en/best-practices:
  - Verification is the top lever; gates range from prompt -> `/goal` evaluator -> Stop hook -> verification subagent ("the agent doing the work isn't the one grading it").
  - Writer/Reviewer: "A fresh context improves code review since Claude won't be biased toward code it just wrote."
  - **"A reviewer prompted to find gaps will usually report some, even when the work is sound ... Chasing every finding leads to over-engineering ... Tell the reviewer to flag only gaps that affect correctness or the stated requirements, and treat the rest as optional."**
  - "Bloated CLAUDE.md files cause Claude to ignore your actual instructions"; "If Claude already does something correctly without the instruction, delete it or convert it to a hook."
  - `/batch` splits a change across **5-30** subagents, each in its own worktree.
- Relevance: the vendor's own product is at depth 1 for teams, while subagent nesting and scripted workflows allow more depth. Their stated guidance lines up with your MINOR-round pain (keep minors optional) and your 140 KB rule pain (prune, turn rules into hooks).

---

## 2. Cognition

### 2.1 Don't Build Multi-Agents
- URL: https://cognition.com/blog/dont-build-multi-agents — 2025-06-12 (Walden Yan)
- Principles: (1) "Share context, and share full agent traces, not just individual messages"; (2) "Actions carry implicit decisions, and conflicting decisions carry bad results".
- Flappy Bird example: two parallel subagents make inconsistent style choices and the merger can't reconcile them.
- Prefer single-threaded linear agents; use a dedicated compression model for long histories.
- Relevance: argues against parallel *writers* on coupled code. It doesn't reject independent verifiers or reviewers.

### 2.2 Devin can now Manage Devins
- URL: https://cognition.com/blog/devin-can-now-manage-devins — 2026-03-19
- Coordinator "scopes the work, assigns each piece to a managed Devin, monitors progress, resolves any conflicts, and compiles the results"; each child runs in its own VM and "verif[ies] its own changes before reporting back"; the parent can read the children's full trajectories.
- Depth: only one level is described. No numbers.
- Relevance: a commercial 2-level hierarchy (coordinator -> workers). The coordinator reads raw trajectories, not summaries.

### 2.3 Multi-Agents: What's Actually Working
- URL: https://cognition.com/blog/multi-agents-working — 2026-04-22 (Walden Yan)
- "Devin Review catches an average of **2 bugs per PR**, of which roughly **58%** are severe (logic errors, missing edge cases, security vulnerabilities)."
- Works best "when the coding and review agents do not share any context beforehand" (clean-context reviewer).
- The same model in two agents "does not quite make them self-biased/correlated in the same way you might imagine one human doing both tasks would be."
- "multi-agent systems work best today when **writes stay single-threaded** and the additional agents contribute intelligence rather than actions."
- "The practical shape is **map-reduce-and-manage**"; unstructured swarms are "mostly a distraction".
- Relevance: direct support for your ephemeral fresh reviewer. Parallel implementers are fine only when their write sets are disjoint.

---

## 3. Google Research / DeepMind + MIT et al.: Towards a science of scaling agent systems
- arXiv: https://arxiv.org/abs/2512.08296 — v1 2025-12-09, v3 2026-04-08; blog: https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ — 2026-01-28
- Scope: 5 architectures (single, independent, centralized, decentralized, hybrid) x 3 LLM families. The blog says **180** configs and R^2 = 0.513; arXiv v3 says **260** configs and cross-validated R^2 = 0.373. Picks the optimal architecture for **87%** of held-out configs.
- Range: **+80.8/80.9%** (centralized, decomposable financial reasoning) down to **-70%** (sequential planning).
- PlanCraft (sequential): "every multi-agent variant we tested degraded performance by **39-70%**" (centralized -50.3%, decentralized -41.5%, hybrid -39.1%, independent -70.0%).
- Error amplification vs single = 1.0: **independent 17.2x, decentralized 7.8x, hybrid 5.1x, centralized 4.4x**. A central orchestrator that cross-checks works as a validation bottleneck.
- Coordination overhead (turns): SAS 7.2, independent 11.4 (+58%), decentralized 26.1 (+263%), centralized 27.7 (+285%), hybrid 44.3 (+515%).
- Capability saturation: when the single-agent baseline already exceeds **~45%**, extra agents give negative returns (beta = -0.236, p = 0.004).
- Tool-coordination trade-off: tool-heavy tasks (e.g. 16-tool workflows) pay a compounding MAS overhead (beta = -0.096).
- Relevance: (a) centralized with verification is the least error-amplifying MAS, which supports OPS as the checkpoint. (b) Hybrid/multi-tier adds the most overhead (+515%). (c) Strong models on sequential or tool-heavy work lose from MAS, which is why waves should hold only truly independent tracks.

---

## 4. Why Do Multi-Agent LLM Systems Fail? (MAST)
- URL: https://arxiv.org/abs/2503.13657 (HTML: https://arxiv.org/html/2503.13657) — v1 2025-03-17, v3 2025-10-26 (Cemri, Pan, ..., Zaharia, Gonzalez, Stoica)
- 1,600+ annotated traces, 7 frameworks, **14** failure modes in 3 categories; inter-annotator kappa = 0.88.
- Shares: **FC1 system design ~43.9%**, **FC2 inter-agent misalignment ~31.6%**, **FC3 task verification ~23.5%**.
- Top modes: step repetition 15.7%, reasoning-action mismatch 13.2%, unaware of stopping conditions 12.4%, disobey task spec 11.8%, **incorrect verification 9.1%**, **no/incomplete verification 8.2%**, task derailment 7.4%, fail to ask for clarification 6.8%, premature termination 6.2%, loss of history 2.8%, conversation reset 2.2%, ignored other agent 1.9%, disobey role 1.5%, information withholding 0.85%.
- Interventions (ChatDev): better role spec **+9.4%** success; adding a high-level task-objective verification step **+15.6%** on ProgramDev. But "the presence of a verifier is not a silver bullet": many verifiers do "superficial checks" (e.g. it compiles). The authors call for **multi-level verification**.
- Relevance: your verifier + mutation + reviewer stack is the "multi-level verification" MAST asks for. The larger share (FC1 + FC2 ~75%) is spec and coordination, which is the lane of your ledger and bus.

---

## 5. Microsoft Magentic-One (Task Ledger + Progress Ledger)
- URL: https://arxiv.org/abs/2411.04468 (HTML v1) — 2024-11 (Fourney et al.)
- Orchestrator + 4 workers (WebSurfer, FileSurfer, Coder, ComputerTerminal).
- **Task Ledger** (outer loop): given/verified facts, facts to look up, facts to derive, educated guesses, plus the plan.
- **Progress Ledger** (inner loop, every step): Is the request fully satisfied? Are we looping or repeating? Is forward progress being made? Which agent speaks next? What instruction goes to it?
- **Stall counter**: re-plan (outer loop) when it passes a threshold (**<=2** in their experiments).
- Results: GAIA 38.0%, WebArena 32.8%, AssistantBench 27.7% accuracy. Ablation: removing the ledgers -> **-31%** performance.
- Top error codes: persistent-inefficient-actions, **insufficient-verification-steps**, underutilized-resource-options.
- Relevance: the closest academic analogue to your ledger. Its progress ledger is a *per-step structured self-check with a stall counter*, a cheap in-orchestrator version of your liveness escalation. The ledger ablation (-31%) is the best evidence that the ledger earns its cost.

---

## 6. Practitioner orchestrators

| System | Source (date) | Depth / shape | Merge + verification |
|---|---|---|---|
| **Gas Town** (Yegge) | https://github.com/steveyegge/gastown ; https://yegge.ai/gastown (open-sourced 2026-01-01; Beads Oct 2025) | Mayor (coordinator across rigs) -> per-rig Witness (monitor) + Refinery (merge queue) -> Polecats (ephemeral workers). Deacon = cross-rig patrol, Dogs = maintenance. So 2 levels of agent management plus supervisor daemons. | **Refinery = "Bors-style merge queue — polecats never push directly to main"**: batches MRs, "Runs verification gates on the merged stack. If green: all MRs in batch merge to main. If red: bisects to isolate the failing MR, merges the good ones." Witness detects stuck agents, then nudges or hands off; "GUPP Violation: Hooked work with no progress for an extended period". Beads = git-backed work ledger. README: "4-10 agents become chaotic" without it, "Scale comfortably to 20-30 agents". |
| **Cursor** "Scaling long-running autonomous coding" | https://cursor.com/blog/scaling-agents (2026-01-14, Wilson Lin) | Flat peers with a lock file failed: "Twenty agents would slow down to the effective throughput of two or three"; agents became "risk-averse". Final design: **planners (recursive sub-planners) -> workers -> judge** per cycle. | "We initially built an **integrator role** for quality control and conflict resolution, but found it **created more bottlenecks than it solved**. Workers were already capable of handling conflicts themselves." "Many of our improvements came from removing complexity." "The prompts matter more" than harness or model. |
| **Cursor** "Towards self-driving codebases" | https://cursor.com/blog/self-driving-codebases (2026-02-05) | Root planner -> sub-planners (full ownership of a slice) -> workers; no central integrator; several hundred agents; **~1,000 commits/hour**, 10M tool calls in a week. | **"When we required 100% correctness before every single commit, it caused major serialization and slowdowns"**; they accept a small constant error rate and fix forward, with "a final 'green' branch ... where an agent regularly takes snapshots and does a quick fixup pass before release." Freshness: rewrite (not append) `scratchpad.md`, auto-summarize, "Constraints are more effective than instructions." |
| **Cursor** long-running agents preview | https://cursor.com/blog/long-running-agents (2026-02-12) | Plan-then-approve, then "multiple different agents checking each other's work". | "substantially larger PRs with merge rates comparable to other agents" (no numbers in text). |
| **Cursor 2.0** | https://cursor.com/blog/2-0 (2025-10-29) | Parallel agents on git worktrees or remote machines; multiple models on the same task, pick the best. | Native browser tool so the agent tests its own work; faster diff review. "Up to eight agents" appears only in secondary sources (**UNVERIFIED** on the primary page). |
| **Devin managed Devins** | see 2.2 (2026-03-19) | Coordinator -> child Devins in VMs (1 level). | Children self-verify; the coordinator resolves conflicts. |
| **Claude Code agent teams / workflows / `/batch`** | see 1.7 | Teams: depth 1, no nesting. Subagents: up to 3 layers. Workflows: scripted fan-out. | Hooks as deterministic gates; adversarial cross-review is a built-in workflow pattern. |
| **OpenAI Codex cloud** | https://learn.chatgpt.com/docs/cloud (live); https://openai.com/index/introducing-codex/ (403, **UNVERIFIED**) | Each task has its own isolated workspace/container; parallel tasks. | Setup is validated by running the workflow; the user inspects changes/results and opens the PR. Best-of-N count and no-internet default are **UNVERIFIED** (secondary only). |
| **GitHub Agent HQ / Copilot coding agent** | https://github.blog/news-insights/company-news/welcome-home-agents/ (2025-10-28) | "Mission control" to assign/steer/track agents from several vendors; flat, with no agents-managing-agents. | A Copilot "code review step" before human review; branch controls; one-click conflict resolution. |
| **Google Jules** | https://blog.google/innovation-and-ai/models-and-research/google-labs/jules/ (2025-05-20) | One cloud VM per task, concurrent tasks; plan shown and steerable. | Diff shown; the PR goes through the normal GitHub review. |
| **Claude Squad** | https://github.com/smtg-ai/claude-squad | Flat TUI; tmux + worktree per agent. | Human reviews the diff and commits/pushes. |
| **Conductor** (Melty Labs) | conductor.build; secondary pages only (**UNVERIFIED** primary) | Flat; worktree per agent; Mac app. | Human diff review per workspace. |
| **Sculptor** (Imbue) | https://imbue.com/blog/sculptor-announce (2025-09-26) | Flat; one container per agent (avoids reinstalling deps per worktree). | "Pairing mode" syncs to the local repo; flags merge conflicts; a beta "Suggestions" reviewer, with a roadmap item to catch "tests passing without real validation". |

- Relevance: products are almost all **flat (human -> N agents)**. The deep ones are Gas Town (Mayor -> Witness/Refinery -> polecats), Cursor research (recursive planners) and Devin (coordinator -> children). Nobody puts a **separate LLM verifier queue** in front of merges. Gas Town uses a *mechanical* batch-and-bisect queue, and Cursor *removed* its quality-control integrator for throughput.
- **UNVERIFIED**: Yegge's Medium launch post (https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04) returned 403, so its cost claims and "stages of developer" framing were not checked.

---

## 7. LLM-as-reviewer / verifier evidence

- **Self-preference**: Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations", https://arxiv.org/abs/2404.13076 (2024-04-15, NeurIPS 2024). GPT-4 and Llama 2 have non-trivial self-recognition, and there is a **linear correlation** between self-recognition and self-preference strength. Relevance: supports a reviewer who isn't the author. It doesn't prove a *different model* is needed.
- **No intrinsic self-correction**: Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet", https://arxiv.org/abs/2310.01798 (ICLR 2024). Without external feedback, LLMs struggle to self-correct and performance sometimes *degrades*. Relevance: the verifier's value is **external signal** (tests, builds). An LLM re-reading its own diff adds little.
- **LLM judges**: Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", https://arxiv.org/abs/2306.05685 (2023). GPT-4 judges reach **>80%** agreement with humans (about human-human level), with **position, verbosity, self-enhancement** biases.
- **Critic models**: McAleese et al. (OpenAI), "LLM Critics Help Catch LLM Bugs", https://arxiv.org/abs/2407.00215 (2024-06-28). Model critiques were preferred over human critiques in **63%** of cases on naturally occurring bugs. Human+critic teams catch a similar number of bugs to LLM critics while "hallucinating less than LLMs alone". Relevance: reviewers find real bugs **and** produce false findings, so findings need triage (your "disposition" step).
- **Fresh-context reviewer in production**: Cognition (2.3), ~2 bugs/PR, 58% severe, best with no shared context. Anthropic (1.5, 1.7): separate the evaluator, and don't chase every finding.
- **Code-review benchmarks**:
  - SWR-Bench, https://arxiv.org/abs/2509.01494 (2025-09-01, rev. 2026-06-05): 1,000 verified PRs; current systems underperform, better at functional errors. **Multi-review aggregation raises F1 by up to 43.67%**.
  - c-CRAB, https://arxiv.org/abs/2603.23448 (2026-03-24): PR-agent plus Devin, Claude Code and Codex review agents **together solve ~40%** of tasks, and focus on different aspects than human reviewers.
  - CR-Bench (openreview, ICLR 2026 workshop): pressuring review agents to find more bugs raises noise, while too-relaxed agents miss bugs. Summary only, **UNVERIFIED** in detail.
- **Tests as verifier are imperfect**: Wang, Pradel, Liu, "Are 'Solved Issues' in SWE-bench Really Solved Correctly?", https://arxiv.org/abs/2503.15223 (v2 2025-09-09, ICSE 2026). **29.6%** of plausible (test-passing) patches behave differently from ground truth, **28.6%** of those are certainly incorrect, **7.8%** of patches count as correct while failing the developer test suite, and resolution rates are inflated by **~6.2 pp** (abstract v2; a secondary summary says 6.4). Relevance: a test-only gate lets roughly 1 in 12 plausible patches through wrong, which justifies stronger test-adequacy checks such as mutation.
- **Mutation testing as a quality gate**:
  - Meta ACH, Foster, Harman et al., "Mutation-Guided LLM-based Test Generation at Meta", https://arxiv.org/abs/2501.12862 (2025-01-22, FSE 2025). Few targeted mutants instead of exhaustive mutation. Over 10,795 Kotlin classes: 9,095 mutants, 571 tests; engineers **accepted 73%** and judged 36% privacy-relevant. LLM equivalent-mutant detector precision 0.79 / recall 0.47 (**0.95 / 0.96** with simple preprocessing). Relevance: industrial precedent for mutation as a gate, but **targeted and few**, not full sequential sweeps.
  - AdverTest, https://arxiv.org/abs/2602.08146 (2026-02-08): a test agent vs a mutant agent in an adversarial loop; fault detection +8.56% over the best LLM method and +63.30% over EvoSuite on Defects4J.
  - AgentCoder, https://arxiv.org/abs/2312.13010 (2023): programmer / test-designer / test-executor agents, where the test designer is independent of the code; HumanEval 96.3% / MBPP 91.8% with fewer tokens (56.9K/66.3K vs 138.2K/206.5K).
- **Instruction load**: Jaroslawicz et al., "How Many Instructions Can LLMs Follow at Once?" (IFScale), https://arxiv.org/abs/2507.11538 (2025-07-15). The best frontier models reach only **68%** at 500 simultaneous instructions, with a bias toward earlier instructions. Relevance: ~140 KB of rules sits far past the density where compliance collapses.

---

## 8. Merge queues / integration practice (human SWE)
- **GitHub merge queue** docs, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue. A `merge_group` = base + all PRs ahead in the queue, tested **speculatively in parallel**. Build concurrency 1-100; min/max group size 1-100 with a wait timeout (**batching**); on failure the PR is removed and the ones behind are rebuilt; a CI timeout counts as failure.
- **Bors / "not rocket science rule"** (Graydon Hoare): the primary blog page (https://graydon2.dreamwidth.org/1597.html) returned 403, **UNVERIFIED**. The rule is widely cited as "automatically maintain a repository of code that always passes all the tests". Gas Town's Refinery reimplements it as batch + bisect.
- **Google TAP**, Memon et al., "Taming Google-Scale Continuous Testing" (ICSE-SEIP 2017), https://research.google/pubs/taming-google-scale-continuous-testing/. Abstract (verified): Google cannot "regression test each code change individually"; "very few of our tests ever fail", failures are "closer" to the code they test, and code recently modified by >3 developers breaks more often. Daily figures (13K projects, 800K builds, 150M test runs/day) come from a secondary search summary, since the PDF did not parse: **UNVERIFIED**.
- **Uber SubmitQueue**, Ananthanarayanan & Saeida Ardekani, "Keeping Master Green at Scale" (EuroSys 2019). Speculative builds of likely outcomes + a conflict analyzer so independent changes build in parallel, keeping mainline always green at thousands of changes/month. The PDF was too large to fetch and Semantic Scholar returned 403, so the numbers are **UNVERIFIED**.
- Relevance: human practice never gates each change *sequentially* on a full slow pipeline. It uses (1) cheap presubmit on the change, (2) a **batched, speculative, parallel** merge queue on the combined state, (3) bisection on red, and (4) test selection keyed to change proximity. Your verifier queue (2h47 wait) plus sequential mutation (~18.7 agent-hours) is the pattern this practice was built to remove.

---

## 9. Hierarchy depth, topology, cost; simple-beats-complex counterpoints
- **Scaling paper (3)**: hybrid/multi-tier overhead is +515% turns vs +285% centralized; MAS turns negative above a ~45% single-agent baseline; sequential tasks lose 39-70%.
- **Gao et al., "Single-agent or Multi-agent Systems? Why Not Both?"**, https://arxiv.org/abs/2505.18286 (2025-05-23). "the benefits of MAS over SAS diminish as LLM capabilities improve". Hybrid request cascading gives +1.1-12% accuracy at up to 20% lower cost. (Secondary summaries add "10% -> 3%" gains and "4-220x more input tokens": **UNVERIFIED** from the abstract.)
- **Tran & Kiela, "Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal Thinking Token Budgets"**, https://arxiv.org/abs/2604.02460 (2026-04-02). Under matched reasoning-token budgets, single agents match or beat MAS. Earlier MAS gains mostly come from **more test-time compute**.
- **Jwalapuram et al., "The Illusion of Multi-Agent Advantage"**, https://arxiv.org/abs/2606.13003 (2026-06-11). Automatically generated MAS "consistently underperform CoT-SC despite being up to **10x** more expensive"; expert-designed MAS do better; "architectural bloat".
- **Yu et al., "When Do Multi-Agent Systems Help? An Information Bottleneck Perspective"**, https://arxiv.org/abs/2607.16133 (2026-07-17). With unlimited relay bandwidth a MAS can simulate any SAS. MAS wins only when context-reduction gains exceed relay information loss: most for weaker models, least for strong ones. Relevance: each LEAD->OPS->worker hop is a lossy relay. Keep the ledger as the shared full-bandwidth channel.
- **"Passes Alone, Fails Together"** (Xia, Wu, Park), https://arxiv.org/abs/2609.25396 (2026-09-21). Parallel agent patches that pass alone but fail combined: **1 of 834** runs on 417 mined Django PR pairs showed interference, versus **97%** on constructed interface-change tasks. A message describing the concurrent change **recovered 82%**. Relevance: semantic merge breakage is rare on real disjoint work but near-certain when tracks touch a shared interface, so a combined-tip gate plus a "what changed" broadcast is the cheap fix.
- **Agentless**, Xia et al., https://arxiv.org/abs/2407.01489 (2024). A fixed localize -> repair -> validate pipeline reached **32.00%** on SWE-bench Lite at **$0.70**/issue, beating the open-source agents of the time.
- **mini-swe-agent**, https://github.com/SWE-agent/mini-swe-agent. ~100 lines, bash-only, linear history, "scores **>74%** on SWE-bench verified" (README claim, not independently checked).
- **MetaGPT** (https://arxiv.org/abs/2308.00352), **ChatDev** (https://arxiv.org/abs/2307.07924), **MapCoder** (https://arxiv.org/abs/2405.11403: HumanEval 93.9%, MBPP 83.1%, APPS 22.0%): SOP / role-play pipelines from 2023-24, evaluated mostly on function-level benchmarks. MetaGPT motivates roles by "cascading hallucinations caused by naively chaining LLMs". Their numbers are pre-frontier and **not** evidence for deep hierarchies on repo-scale work.
- No primary source found that directly A/B-tests **2 vs 3 management levels for coding agents**. The closest evidence is the overhead table in (3), Cursor's recursive planners (depth by need, not fixed), and Claude Code's defaults (teams depth 1, subagents max 3 layers). **Treat "3 levels is right" as unmeasured.**

---

## Synthesis: what the SOTA says

### (a) Hierarchy depth
- Shipping products run depth 1 (human -> N agents, or lead -> teammates with **no nesting**). Research systems that go deeper (Cursor planners, Gas Town, Devin) use depth-by-scope: a sub-planner exists because a slice of *work* needs one, not as a fixed management tier.
- Every extra tier is a lossy relay (information-bottleneck paper, Cognition) and adds coordination turns (+285% centralized, +515% hybrid). Gains shrink as models get stronger and turn negative on sequential work and above a ~45% single-agent baseline.
- Your LEAD->OPS split is justified only if LEAD holds something OPS can't: the human channel, cross-wave memory. A per-wave OPS doing mostly *mechanical* coordination (dispatch, queue, gate, merge) is what Anthropic's dynamic workflows and Gas Town's Refinery/Witness put into **code/daemons**, not an LLM. Candidate: make OPS a script/daemon for the mechanical loop and keep an LLM only for re-planning (Magentic-One outer loop).
- Cursor's own data point: a central quality integrator "created more bottlenecks than it solved".

### (b) Verification / review staffing
- Strongly supported: **separating author and judge** (Anthropic harness design, Cognition clean-context review at ~2 bugs/PR with 58% severe, self-preference research, no intrinsic self-correction). The fresh ephemeral reviewer is SOTA-aligned.
- Strongly supported: **external executable oracles over LLM opinion** (C-compiler: "verifier nearly perfect"; MAST: many verifiers are superficial). Mutation testing is a legitimate adequacy gate (Meta ACH, AdverTest), but industrial practice is **targeted and few mutants** on the risky diff, not exhaustive sequential sweeps.
- Against your current cost profile:
  1. Humans and Cursor avoid serial full gating per change: batch + speculative parallel queue + bisect on red (GitHub merge queue, bors/Refinery, SubmitQueue). Cursor found "100% correctness before every commit" serialized throughput.
  2. Anthropic warns reviewers asked for gaps always find some. Make MINOR findings non-blocking: a disposition without a re-gate, or batch them into the next wave.
  3. Multi-review aggregation (SWR-Bench, +43.67% F1) and c-CRAB (~40% coverage even combined) say one reviewer misses a lot. Two cheap, differently focused reviewers can beat one long adversarial round.
- The verifier as the only env with deps is a throughput choke. Codex/Jules/Devin/Sculptor give every worker its own full environment, so workers self-verify (tests/typecheck) and the central gate re-runs only the combined tip.

### (c) Coordination channel
- Durable shared state beats messages: Magentic-One ledgers (-31% without them), Anthropic artifacts/filesystem, Beads, Claude Code task list with file-locked claims, Cursor scratchpad (rewrite, don't append). Your GitHub-issue ledger + SQLite bus with total order is above SOTA on rigor. Most products use a JSON mailbox or a lock file.
- Liveness: Magentic-One's stall counter (re-plan after <=2 stalls), Gas Town's Witness/Deacon ("no progress for an extended period" -> nudge/handoff), and Claude Code teams' idle/failure notifications to the lead all match your liveness escalation. Silent-coordinator death is a known failure: Claude Code teams list "the lead can stop early" as a limitation.
- Lock-based peer self-coordination failed at scale in Cursor's work (20 agents -> throughput of 1-3). Planners that own scopes plus optimistic concurrency worked better. Fencing tokens are the right primitive, but avoid lock-holding by LLMs.
- For semantic merge conflicts, a "what changed" broadcast when a track changes a shared interface recovered 82% in the stale benchmark.

### (d) Cost
- Tokens scale with agents: ~15x chat for Anthropic MAS; ~7x a single session for Claude Code teams in plan mode; up to 10x for auto-generated MAS with no gain. At matched token budgets single agents often match MAS, so much of the MAS gain *is* the extra compute.
- Harness price points: solo $9/20 min vs 3-agent harness $200/6 h (Anthropic); 16-agent compiler ~$20k over 2 weeks.
- Economic rule (Anthropic): multi-agent only where task value pays for it. Suggested levers from the sources: Sonnet-class workers, orchestration moved into code (workflows) so coordinator context stays small, 1-2k-token returns, CLAUDE.md-style rules under ~200 lines with the rest in on-demand skills/hooks (IFScale: 68% compliance at 500 instructions), and targeted rather than exhaustive mutation.

---

## VERIFIED (fetched this session)
Every URL above without an UNVERIFIED tag was fetched with WebFetch on 2026-09-30, and the numbers were taken from the fetched page/abstract.

## NOT VERIFIED
- Cursor 2.0 "up to eight agents" (secondary only; the primary page gives no count).
- OpenAI "Introducing Codex" page (403). Codex best-of-N count / no-internet default.
- Yegge's Medium launch post (403): cost claims, GUPP expansion.
- Graydon Hoare's "not rocket science rule" post (403).
- Google TAP daily volume numbers (PDF did not parse; figures from a search summary).
- Uber SubmitQueue numbers (PDF too large / 403).
- Gao et al. "10%->3%" and "4-220x tokens" (secondary summary, not in the abstract).
- CR-Bench details (search summary only).
- Conductor primary page (only secondary pages read).
- mini-swe-agent ">74%" is the README's own claim, not independently reproduced.
- The fetch tool paraphrases; quotes marked with quotation marks are as returned by it, not byte-checked against page HTML.
